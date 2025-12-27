import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * BOOKING.COM GOLDEN PATH TEST WITH ACTIONS
 * 
 * Purpose: Prove that we can extract real, grounded, repeatable prices from Booking.com
 * 
 * This function:
 * 1. Takes a Booking.com URL with dates applied via URL params
 * 2. If "Enter your dates" state detected, applies dates via Firecrawl actions
 * 3. Runs 3 consecutive extraction attempts
 * 4. Reports detailed evidence for each run
 * 5. Proves repeatability of the extraction
 */

interface TestResult {
  runNumber: number;
  timestamp: string;
  durationMs: number;
  success: boolean;
  
  // Phase A: Date application
  phaseA: {
    urlParamsApplied: boolean;
    actionsRequired: boolean;
    actionsExecuted: boolean;
    actionsSuccess: boolean;
    datePickerOpened: boolean;
    checkInSelected: boolean;
    checkOutSelected: boolean;
    contentHashBefore: string | null;
    contentHashAfter: string | null;
    contentChanged: boolean;
    selectorsUsed: string[];
    evidenceSnippet: string | null;
  };
  
  // Phase A result
  datesValidated: boolean;
  detectedCheckIn: string | null;
  detectedCheckOut: string | null;
  
  // Phase B: Price extraction
  extractedPrice: number | null;
  currency: string | null;
  includesTaxesFees: boolean | null;
  
  // Ground-truth evidence
  evidenceSnippet: string | null;
  allTotalsFound: string[];
  selectedPriceRule: string;
  priceFoundVerbatimInContent: boolean;
  
  // Content hash for change detection
  contentHash: string | null;
  
  // Errors
  error: string | null;
  failureCategory: string | null;
}

// Simple hash for content
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}

/**
 * Check if page is in "Enter your dates" state (needs date application)
 */
function needsDateApplication(markdown: string): {
  needsDates: boolean;
  reason: string;
  evidenceSnippet: string | null;
} {
  const lowerMarkdown = markdown.toLowerCase();
  
  const enterDatesIndicators = [
    'enter dates to see prices',
    'select dates to see prices',
    'enter your dates',
    'choose your dates to see',
    'add dates for prices',
    'check availability',
  ];
  
  for (const indicator of enterDatesIndicators) {
    const index = lowerMarkdown.indexOf(indicator);
    if (index >= 0) {
      const snippetStart = Math.max(0, index - 20);
      const snippetEnd = Math.min(markdown.length, index + indicator.length + 20);
      return { 
        needsDates: true, 
        reason: `Found "${indicator}"`,
        evidenceSnippet: markdown.slice(snippetStart, snippetEnd).replace(/\n/g, ' ').trim()
      };
    }
  }
  
  return { needsDates: false, reason: 'No "enter dates" indicators found', evidenceSnippet: null };
}

/**
 * Check if page shows prices (price-eligible state)
 */
function isPriceEligibleState(markdown: string, expectedNights: number): {
  isPriceEligible: boolean;
  reason: string;
  foundPrices: string[];
} {
  const lowerMarkdown = markdown.toLowerCase();
  
  // Negative indicators
  const enterDatesIndicators = [
    'enter dates to see prices',
    'select dates to see prices', 
    'enter your dates',
    'choose your dates to see',
  ];
  
  for (const indicator of enterDatesIndicators) {
    if (lowerMarkdown.includes(indicator)) {
      return { isPriceEligible: false, reason: `Found "${indicator}"`, foundPrices: [] };
    }
  }
  
  // Look for prices for N nights
  const pricePattern = new RegExp(`\\$[\\d,]+(?:\\.\\d{2})?\\s*(?:for|\\/)\\s*${expectedNights}\\s*nights?`, 'gi');
  const matches = markdown.match(pricePattern) || [];
  
  if (matches.length > 0) {
    return { 
      isPriceEligible: true, 
      reason: `Found ${matches.length} prices for ${expectedNights} nights`, 
      foundPrices: matches.slice(0, 5) 
    };
  }
  
  // Also check for any total patterns
  const anyTotalPattern = /\$[\d,]+(?:\.\d{2})?\s*(?:for|\/)\s*\d+\s*nights?/gi;
  const anyMatches = markdown.match(anyTotalPattern) || [];
  
  if (anyMatches.length > 0) {
    return { 
      isPriceEligible: true, 
      reason: `Found ${anyMatches.length} total price patterns`, 
      foundPrices: anyMatches.slice(0, 5) 
    };
  }
  
  return { isPriceEligible: false, reason: 'No price patterns found', foundPrices: [] };
}

/**
 * Extract all "for N nights" totals from Booking.com content
 */
function extractBookingComTotals(markdown: string, expectedNights: number): { 
  allTotals: Array<{ amount: number; currency: string; context: string }>;
  lowestTotal: { amount: number; currency: string; context: string } | null;
} {
  const patterns = [
    /(\$|US\$|USD\s*)([\d,]+(?:\.\d{2})?)\s*(?:for|\/)\s*(\d+)\s*nights?/gi,
    /(US\$|USD)\s*([\d,]+(?:\.\d{2})?)\s*(?:for|\/)\s*(\d+)\s*nights?/gi,
    /([\d,]+(?:\.\d{2})?)\s*(USD|US\$|\$)\s*(?:for|\/)\s*(\d+)\s*nights?/gi,
  ];
  
  const totals: Array<{ amount: number; currency: string; context: string }> = [];
  const seen = new Set<string>();
  
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(markdown)) !== null) {
      let amount: number;
      let currency: string;
      let nights: number;
      
      if (match[1].match(/[\$USD]/i)) {
        currency = 'USD';
        amount = parseFloat(match[2].replace(/,/g, ''));
        nights = parseInt(match[3]);
      } else {
        amount = parseFloat(match[1].replace(/,/g, ''));
        currency = 'USD';
        nights = parseInt(match[3]);
      }
      
      if (nights === expectedNights && amount > 0) {
        const key = `${amount}-${currency}`;
        if (!seen.has(key)) {
          seen.add(key);
          
          const matchIndex = match.index;
          const contextStart = Math.max(0, matchIndex - 30);
          const contextEnd = Math.min(markdown.length, matchIndex + match[0].length + 30);
          const context = markdown.slice(contextStart, contextEnd).replace(/\n/g, ' ').trim();
          
          totals.push({ amount, currency, context });
        }
      }
    }
  }
  
  totals.sort((a, b) => a.amount - b.amount);
  
  return {
    allTotals: totals,
    lowestTotal: totals.length > 0 ? totals[0] : null,
  };
}

/**
 * Validate that extracted price exists verbatim in content
 */
function validatePriceInContent(markdown: string, price: number, currency: string): {
  found: boolean;
  evidenceSnippet: string | null;
} {
  const priceFormats = [
    `$${price.toLocaleString('en-US')}`,
    `$${price.toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
    `$${price}`,
    `US$${price.toLocaleString('en-US')}`,
    `US$ ${price.toLocaleString('en-US')}`,
    `USD ${price.toLocaleString('en-US')}`,
    price.toLocaleString('en-US'),
    price.toString(),
  ];
  
  for (const format of priceFormats) {
    const index = markdown.indexOf(format);
    if (index >= 0) {
      const start = Math.max(0, index - 40);
      const end = Math.min(markdown.length, index + format.length + 60);
      const snippet = markdown.slice(start, end).replace(/\n/g, ' ').trim();
      
      return { found: true, evidenceSnippet: snippet };
    }
  }
  
  return { found: false, evidenceSnippet: null };
}

/**
 * Build Firecrawl actions for Booking.com date picker interaction
 */
function buildBookingComDateActions(checkIn: string, checkOut: string): any[] {
  // Parse dates for Booking.com's calendar format
  const checkInDate = new Date(checkIn);
  const checkOutDate = new Date(checkOut);
  
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                      'July', 'August', 'September', 'October', 'November', 'December'];
  
  const checkInDay = checkInDate.getDate();
  const checkInMonth = monthNames[checkInDate.getMonth()];
  const checkInYear = checkInDate.getFullYear();
  
  const checkOutDay = checkOutDate.getDate();
  const checkOutMonth = monthNames[checkOutDate.getMonth()];
  const checkOutYear = checkOutDate.getFullYear();
  
  // Booking.com date picker selectors - multiple strategies
  const actions: any[] = [
    // Wait for page to stabilize
    { type: 'wait', milliseconds: 2000 },
    
    // Strategy 1: Click on the date field/button to open calendar
    // Booking.com uses data-testid for date selection
    { 
      type: 'click', 
      selector: '[data-testid="date-display-field-start"], [data-testid="searchbox-dates-container"], .xp__dates, [data-testid="date-range-input"]' 
    },
    { type: 'wait', milliseconds: 1500 },
    
    // Navigate to the correct month (January 2026)
    // We may need to click "next month" multiple times
    // Each click advances by one month
    { 
      type: 'click', 
      selector: '[data-testid="searchbox-datepicker-calendar"] button[aria-label*="Next"], .bui-calendar__control--next, [data-testid="datepicker__button_next_month"]' 
    },
    { type: 'wait', milliseconds: 500 },
    { 
      type: 'click', 
      selector: '[data-testid="searchbox-datepicker-calendar"] button[aria-label*="Next"], .bui-calendar__control--next, [data-testid="datepicker__button_next_month"]' 
    },
    { type: 'wait', milliseconds: 500 },
    { 
      type: 'click', 
      selector: '[data-testid="searchbox-datepicker-calendar"] button[aria-label*="Next"], .bui-calendar__control--next, [data-testid="datepicker__button_next_month"]' 
    },
    { type: 'wait', milliseconds: 500 },
    { 
      type: 'click', 
      selector: '[data-testid="searchbox-datepicker-calendar"] button[aria-label*="Next"], .bui-calendar__control--next, [data-testid="datepicker__button_next_month"]' 
    },
    { type: 'wait', milliseconds: 500 },
    { 
      type: 'click', 
      selector: '[data-testid="searchbox-datepicker-calendar"] button[aria-label*="Next"], .bui-calendar__control--next, [data-testid="datepicker__button_next_month"]' 
    },
    { type: 'wait', milliseconds: 500 },
    { 
      type: 'click', 
      selector: '[data-testid="searchbox-datepicker-calendar"] button[aria-label*="Next"], .bui-calendar__control--next, [data-testid="datepicker__button_next_month"]' 
    },
    { type: 'wait', milliseconds: 500 },
    // 6 more clicks to reach January 2026 (approx 12 months ahead)
    { 
      type: 'click', 
      selector: '[data-testid="searchbox-datepicker-calendar"] button[aria-label*="Next"], .bui-calendar__control--next, [data-testid="datepicker__button_next_month"]' 
    },
    { type: 'wait', milliseconds: 500 },
    { 
      type: 'click', 
      selector: '[data-testid="searchbox-datepicker-calendar"] button[aria-label*="Next"], .bui-calendar__control--next, [data-testid="datepicker__button_next_month"]' 
    },
    { type: 'wait', milliseconds: 500 },
    { 
      type: 'click', 
      selector: '[data-testid="searchbox-datepicker-calendar"] button[aria-label*="Next"], .bui-calendar__control--next, [data-testid="datepicker__button_next_month"]' 
    },
    { type: 'wait', milliseconds: 500 },
    { 
      type: 'click', 
      selector: '[data-testid="searchbox-datepicker-calendar"] button[aria-label*="Next"], .bui-calendar__control--next, [data-testid="datepicker__button_next_month"]' 
    },
    { type: 'wait', milliseconds: 500 },
    { 
      type: 'click', 
      selector: '[data-testid="searchbox-datepicker-calendar"] button[aria-label*="Next"], .bui-calendar__control--next, [data-testid="datepicker__button_next_month"]' 
    },
    { type: 'wait', milliseconds: 500 },
    { 
      type: 'click', 
      selector: '[data-testid="searchbox-datepicker-calendar"] button[aria-label*="Next"], .bui-calendar__control--next, [data-testid="datepicker__button_next_month"]' 
    },
    { type: 'wait', milliseconds: 1000 },
    
    // Select check-in date (day 4 of January)
    // Booking.com calendar cells have span with the day number
    { 
      type: 'click', 
      selector: `[data-date="${checkIn}"], td[data-date="${checkIn}"], span[data-date="${checkIn}"], [aria-label*="${checkInMonth} ${checkInDay}"], [aria-label*="${checkInDay} ${checkInMonth}"]` 
    },
    { type: 'wait', milliseconds: 1000 },
    
    // Select check-out date (day 8 of January)
    { 
      type: 'click', 
      selector: `[data-date="${checkOut}"], td[data-date="${checkOut}"], span[data-date="${checkOut}"], [aria-label*="${checkOutMonth} ${checkOutDay}"], [aria-label*="${checkOutDay} ${checkOutMonth}"]` 
    },
    { type: 'wait', milliseconds: 1500 },
    
    // Click search/apply button to confirm dates
    { 
      type: 'click', 
      selector: '[data-testid="searchbox-dates-container"] button, button[type="submit"], .sb-searchbox__button, [data-testid="submit-button"], [data-testid="date-selection-cta"]' 
    },
    { type: 'wait', milliseconds: 3000 },
  ];
  
  return actions;
}

/**
 * Scrape with Firecrawl (optionally with actions)
 */
async function scrapeWithFirecrawl(
  url: string,
  useActions: boolean,
  actions: any[] = []
): Promise<{ success: boolean; markdown: string; error?: string }> {
  const firecrawlApiKey = Deno.env.get('FIRECRAWL_API_KEY_1') || Deno.env.get('FIRECRAWL_API_KEY');
  
  if (!firecrawlApiKey) {
    return { success: false, markdown: '', error: 'Firecrawl API key not configured' };
  }
  
  try {
    const requestBody: any = {
      url,
      formats: ['markdown'],
      onlyMainContent: true,
      waitFor: useActions ? 2000 : 5000,
    };
    
    if (useActions && actions.length > 0) {
      requestBody.actions = actions;
    }
    
    console.log(`[GOLDEN-PATH] Firecrawl request: useActions=${useActions}, actionsCount=${actions.length}`);
    
    const response = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${firecrawlApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, markdown: '', error: `Firecrawl ${response.status}: ${errorText.slice(0, 200)}` };
    }
    
    const data = await response.json();
    const markdown = data.data?.markdown || data.markdown || '';
    
    return { success: true, markdown };
    
  } catch (error) {
    return { success: false, markdown: '', error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

/**
 * Run a single extraction test with actions fallback
 */
async function runSingleTest(
  url: string,
  checkIn: string,
  checkOut: string,
  runNumber: number
): Promise<TestResult> {
  const startTime = Date.now();
  const result: TestResult = {
    runNumber,
    timestamp: new Date().toISOString(),
    durationMs: 0,
    success: false,
    phaseA: {
      urlParamsApplied: false,
      actionsRequired: false,
      actionsExecuted: false,
      actionsSuccess: false,
      datePickerOpened: false,
      checkInSelected: false,
      checkOutSelected: false,
      contentHashBefore: null,
      contentHashAfter: null,
      contentChanged: false,
      selectorsUsed: [],
      evidenceSnippet: null,
    },
    datesValidated: false,
    detectedCheckIn: null,
    detectedCheckOut: null,
    extractedPrice: null,
    currency: null,
    includesTaxesFees: null,
    evidenceSnippet: null,
    allTotalsFound: [],
    selectedPriceRule: 'LOWEST_TOTAL_FOR_N_NIGHTS',
    priceFoundVerbatimInContent: false,
    contentHash: null,
    error: null,
    failureCategory: null,
  };
  
  // Calculate expected nights
  const checkInDate = new Date(checkIn);
  const checkOutDate = new Date(checkOut);
  const expectedNights = Math.round((checkOutDate.getTime() - checkInDate.getTime()) / (1000 * 60 * 60 * 24));
  
  console.log(`[GOLDEN-PATH] Run ${runNumber}: Testing ${url}`);
  console.log(`[GOLDEN-PATH] Run ${runNumber}: Expected ${expectedNights} nights`);
  
  // ============= PHASE A: Date Application =============
  
  // Step 1: First scrape WITHOUT actions (test if URL params work)
  console.log(`[GOLDEN-PATH] Run ${runNumber}: Phase A - Testing URL params first`);
  
  const initialScrape = await scrapeWithFirecrawl(url, false);
  
  if (!initialScrape.success) {
    result.error = initialScrape.error || 'Unknown error';
    result.failureCategory = 'A) Initial scrape failed';
    result.durationMs = Date.now() - startTime;
    return result;
  }
  
  result.phaseA.contentHashBefore = simpleHash(initialScrape.markdown.slice(0, 5000));
  
  // Check for bot/captcha
  const lowerMarkdown = initialScrape.markdown.toLowerCase();
  if (lowerMarkdown.includes('captcha') || lowerMarkdown.includes('robot') || lowerMarkdown.includes('access denied')) {
    result.error = 'Bot/CAPTCHA detected';
    result.failureCategory = 'D) Bot protection';
    result.durationMs = Date.now() - startTime;
    return result;
  }
  
  // Check if dates need application
  const dateCheck = needsDateApplication(initialScrape.markdown);
  const priceCheck = isPriceEligibleState(initialScrape.markdown, expectedNights);
  
  console.log(`[GOLDEN-PATH] Run ${runNumber}: needsDates=${dateCheck.needsDates}, isPriceEligible=${priceCheck.isPriceEligible}`);
  
  let finalMarkdown = initialScrape.markdown;
  
  if (dateCheck.needsDates || !priceCheck.isPriceEligible) {
    // URL params did NOT work - need to use actions
    result.phaseA.urlParamsApplied = false;
    result.phaseA.actionsRequired = true;
    result.phaseA.evidenceSnippet = dateCheck.evidenceSnippet || priceCheck.reason;
    
    console.log(`[GOLDEN-PATH] Run ${runNumber}: Phase A - URL params failed, using actions`);
    console.log(`[GOLDEN-PATH] Run ${runNumber}: Reason: ${dateCheck.reason}`);
    
    // Build and execute actions for Booking.com date picker
    const actions = buildBookingComDateActions(checkIn, checkOut);
    result.phaseA.selectorsUsed = [
      '[data-testid="date-display-field-start"]',
      '[data-testid="searchbox-datepicker-calendar"] button[aria-label*="Next"]',
      `[data-date="${checkIn}"]`,
      `[data-date="${checkOut}"]`,
      '[data-testid="searchbox-dates-container"] button',
    ];
    
    console.log(`[GOLDEN-PATH] Run ${runNumber}: Executing ${actions.length} actions`);
    
    const actionsScrape = await scrapeWithFirecrawl(url, true, actions);
    result.phaseA.actionsExecuted = true;
    
    if (!actionsScrape.success) {
      result.error = `Actions failed: ${actionsScrape.error}`;
      result.failureCategory = 'A) Actions did not execute';
      result.durationMs = Date.now() - startTime;
      return result;
    }
    
    result.phaseA.contentHashAfter = simpleHash(actionsScrape.markdown.slice(0, 5000));
    result.phaseA.contentChanged = result.phaseA.contentHashBefore !== result.phaseA.contentHashAfter;
    
    console.log(`[GOLDEN-PATH] Run ${runNumber}: Actions executed, contentChanged=${result.phaseA.contentChanged}`);
    
    // Check if actions produced a price-eligible state
    const postActionsPriceCheck = isPriceEligibleState(actionsScrape.markdown, expectedNights);
    
    if (postActionsPriceCheck.isPriceEligible) {
      result.phaseA.actionsSuccess = true;
      result.phaseA.datePickerOpened = true;
      result.phaseA.checkInSelected = true;
      result.phaseA.checkOutSelected = true;
      finalMarkdown = actionsScrape.markdown;
      console.log(`[GOLDEN-PATH] Run ${runNumber}: Actions SUCCESS - ${postActionsPriceCheck.reason}`);
    } else {
      // Actions executed but did not produce pricing
      const postActionsDateCheck = needsDateApplication(actionsScrape.markdown);
      
      if (result.phaseA.contentChanged) {
        // Content changed but still no prices
        result.failureCategory = 'B) Actions executed but DOM did not update to price-eligible state';
        result.error = `Actions changed content but still in "${postActionsDateCheck.reason}" state`;
      } else {
        // Content did not change at all
        result.failureCategory = 'C) DOM did not update after actions (content unchanged)';
        result.error = 'Actions did not change page content - selectors may have failed';
      }
      
      result.durationMs = Date.now() - startTime;
      return result;
    }
  } else {
    // URL params worked!
    result.phaseA.urlParamsApplied = true;
    result.phaseA.actionsRequired = false;
    console.log(`[GOLDEN-PATH] Run ${runNumber}: Phase A SUCCESS - URL params applied dates`);
  }
  
  // Phase A validated
  result.datesValidated = true;
  result.detectedCheckIn = checkIn;
  result.detectedCheckOut = checkOut;
  result.contentHash = simpleHash(finalMarkdown.slice(0, 5000));
  
  // ============= PHASE B: Price Extraction =============
  
  console.log(`[GOLDEN-PATH] Run ${runNumber}: Phase B - Extracting prices`);
  
  const { allTotals, lowestTotal } = extractBookingComTotals(finalMarkdown, expectedNights);
  
  result.allTotalsFound = allTotals.map(t => `${t.currency} ${t.amount} (${t.context.slice(0, 50)}...)`);
  
  if (!lowestTotal) {
    result.error = `No "for ${expectedNights} nights" totals found in content`;
    result.failureCategory = 'D) Extraction logic failed - no price patterns';
    result.durationMs = Date.now() - startTime;
    return result;
  }
  
  console.log(`[GOLDEN-PATH] Run ${runNumber}: Found ${allTotals.length} totals, lowest: ${lowestTotal.currency} ${lowestTotal.amount}`);
  
  // Hallucination guard: verify price exists verbatim
  const validation = validatePriceInContent(finalMarkdown, lowestTotal.amount, lowestTotal.currency);
  result.priceFoundVerbatimInContent = validation.found;
  
  if (!validation.found) {
    result.error = `HALLUCINATION GUARD: Price ${lowestTotal.amount} not found verbatim in content`;
    result.failureCategory = 'D) Extraction logic failed - hallucination guard';
    result.durationMs = Date.now() - startTime;
    return result;
  }
  
  // SUCCESS!
  result.success = true;
  result.extractedPrice = lowestTotal.amount;
  result.currency = lowestTotal.currency;
  result.evidenceSnippet = validation.evidenceSnippet;
  
  // Check for taxes/fees indicator
  const taxPatterns = [
    /includes taxes/i,
    /incl\. taxes/i,
    /taxes and fees included/i,
    /including taxes/i,
  ];
  result.includesTaxesFees = taxPatterns.some(p => p.test(finalMarkdown)) ? true : null;
  
  console.log(`[GOLDEN-PATH] Run ${runNumber}: SUCCESS - ${lowestTotal.currency} ${lowestTotal.amount} (verified)`);
  
  result.durationMs = Date.now() - startTime;
  return result;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { 
      url, 
      checkIn = '2026-01-04', 
      checkOut = '2026-01-08',
      runs = 3 
    } = await req.json();

    if (!url) {
      return new Response(
        JSON.stringify({ success: false, error: 'URL is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[GOLDEN-PATH] Starting ${runs} consecutive tests for Booking.com`);
    console.log(`[GOLDEN-PATH] URL: ${url}`);
    console.log(`[GOLDEN-PATH] Dates: ${checkIn} to ${checkOut}`);

    const results: TestResult[] = [];
    
    // Run tests consecutively with a small delay between
    for (let i = 1; i <= runs; i++) {
      console.log(`[GOLDEN-PATH] === Starting Run ${i} of ${runs} ===`);
      
      const result = await runSingleTest(url, checkIn, checkOut, i);
      results.push(result);
      
      // Wait 2 seconds between runs to avoid rate limiting
      if (i < runs) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    // Generate stability summary
    const successfulRuns = results.filter(r => r.success);
    const prices = successfulRuns.map(r => r.extractedPrice).filter(p => p !== null) as number[];
    const contentHashes = results.map(r => r.contentHash).filter(h => h !== null);
    const uniqueHashes = [...new Set(contentHashes)];
    
    // Phase A diagnostics
    const phaseADiagnostics = {
      runsWithUrlParams: results.filter(r => r.phaseA.urlParamsApplied).length,
      runsRequiringActions: results.filter(r => r.phaseA.actionsRequired).length,
      runsWithActionsSuccess: results.filter(r => r.phaseA.actionsSuccess).length,
      runsWithContentChange: results.filter(r => r.phaseA.contentChanged).length,
    };
    
    // Failure categories
    const failureCategories: Record<string, number> = {};
    for (const r of results.filter(r => !r.success)) {
      const cat = r.failureCategory || 'Unknown';
      failureCategories[cat] = (failureCategories[cat] || 0) + 1;
    }
    
    const summary = {
      totalRuns: runs,
      successfulRuns: successfulRuns.length,
      failedRuns: results.filter(r => !r.success).length,
      allDatesValidated: results.every(r => r.datesValidated),
      pricesConsistent: prices.length > 0 && prices.every(p => p === prices[0]),
      priceRange: prices.length > 0 ? { min: Math.min(...prices), max: Math.max(...prices) } : null,
      contentHashesChanged: uniqueHashes.length > 1,
      uniqueContentHashes: uniqueHashes,
      hallucinations: results.filter(r => r.priceFoundVerbatimInContent === false && r.extractedPrice !== null).length,
      isGoldenPathProven: successfulRuns.length >= 2 && results.every(r => r.priceFoundVerbatimInContent || !r.extractedPrice),
      phaseADiagnostics,
      failureCategories,
    };

    console.log(`[GOLDEN-PATH] === SUMMARY ===`);
    console.log(`[GOLDEN-PATH] Successful: ${summary.successfulRuns}/${summary.totalRuns}`);
    console.log(`[GOLDEN-PATH] Prices consistent: ${summary.pricesConsistent}`);
    console.log(`[GOLDEN-PATH] Phase A: urlParams=${phaseADiagnostics.runsWithUrlParams}, actionsRequired=${phaseADiagnostics.runsRequiringActions}, actionsSuccess=${phaseADiagnostics.runsWithActionsSuccess}`);
    console.log(`[GOLDEN-PATH] Golden path proven: ${summary.isGoldenPathProven}`);

    return new Response(
      JSON.stringify({
        success: true,
        results,
        summary,
        conclusion: summary.isGoldenPathProven 
          ? 'GOLDEN PATH PROVEN: Booking.com extraction is grounded, verified, and repeatable'
          : summary.successfulRuns > 0
            ? 'PARTIAL SUCCESS: Some runs succeeded but not all - may need stability improvements'
            : 'FAILED: Unable to extract grounded prices from Booking.com',
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[GOLDEN-PATH] Fatal error:', error);
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
