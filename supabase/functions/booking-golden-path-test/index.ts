import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * BOOKING.COM GOLDEN PATH TEST WITH ZYTE ESCALATION
 * 
 * Purpose: Conclusively prove whether OTA price extraction is technically achievable
 * 
 * Escalation order:
 * 1. URL parameters (fastest, preferred)
 * 2. Firecrawl actions (JS interaction)
 * 3. Zyte browser automation (full browser, final escalation)
 * 
 * This function will classify Booking.com into:
 * A) Prices visible and extractable pre-payment → GOLDEN SUCCESS PATH
 * B) Prices only visible after reserve/payment → NOT ALLOWED
 * C) Dates cannot be applied reliably via browser automation → REQUIREMENT NOT ACHIEVABLE
 * D) Bot/anti-automation blocks prevent pricing → EXPLICIT BLOCKED
 */

interface PhaseAResult {
  strategyUsed: 'URL_PARAMS' | 'FIRECRAWL_ACTIONS' | 'ZYTE_BROWSER' | 'NONE';
  urlParamsAttempted: boolean;
  urlParamsSuccess: boolean;
  firecrawlActionsAttempted: boolean;
  firecrawlActionsSuccess: boolean;
  zyteAttempted: boolean;
  zyteSuccess: boolean;
  contentHashBefore: string | null;
  contentHashAfterFirecrawl: string | null;
  contentHashAfterZyte: string | null;
  contentChanged: boolean;
  selectorsUsed: string[];
  zyteActionsExecuted: string[];
  evidenceSnippet: string | null;
}

interface TestResult {
  runNumber: number;
  timestamp: string;
  durationMs: number;
  success: boolean;
  
  // Phase A: Date application with escalation
  phaseA: PhaseAResult;
  
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
  failureCategory: 'A' | 'B' | 'C' | 'D' | null;
  failureReason: string | null;
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
 * Check for bot/captcha blocking
 */
function detectBotBlocking(markdown: string): { blocked: boolean; reason: string | null } {
  const lowerMarkdown = markdown.toLowerCase();
  const blockIndicators = [
    { pattern: 'captcha', reason: 'CAPTCHA detected' },
    { pattern: 'are you a robot', reason: 'Robot check detected' },
    { pattern: 'access denied', reason: 'Access denied' },
    { pattern: 'blocked', reason: 'Request blocked' },
    { pattern: 'please verify', reason: 'Verification required' },
    { pattern: 'unusual traffic', reason: 'Unusual traffic detection' },
  ];
  
  for (const indicator of blockIndicators) {
    if (lowerMarkdown.includes(indicator.pattern)) {
      return { blocked: true, reason: indicator.reason };
    }
  }
  
  return { blocked: false, reason: null };
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
 * Build Firecrawl actions for Booking.com date picker interaction
 */
function buildFirecrawlActions(checkIn: string, checkOut: string): any[] {
  const checkInDate = new Date(checkIn);
  const checkOutDate = new Date(checkOut);
  
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                      'July', 'August', 'September', 'October', 'November', 'December'];
  
  const checkInDay = checkInDate.getDate();
  const checkInMonth = monthNames[checkInDate.getMonth()];
  const checkOutDay = checkOutDate.getDate();
  const checkOutMonth = monthNames[checkOutDate.getMonth()];
  
  const actions: any[] = [
    { type: 'wait', milliseconds: 2000 },
    { type: 'click', selector: '[data-testid="date-display-field-start"], [data-testid="searchbox-dates-container"], .xp__dates' },
    { type: 'wait', milliseconds: 1500 },
  ];
  
  // Navigate to January 2026 (12 next clicks)
  for (let i = 0; i < 12; i++) {
    actions.push({ 
      type: 'click', 
      selector: '[data-testid="searchbox-datepicker-calendar"] button[aria-label*="Next"], .bui-calendar__control--next' 
    });
    actions.push({ type: 'wait', milliseconds: 400 });
  }
  
  // Select dates
  actions.push({ type: 'click', selector: `[data-date="${checkIn}"], [aria-label*="${checkInMonth} ${checkInDay}"]` });
  actions.push({ type: 'wait', milliseconds: 800 });
  actions.push({ type: 'click', selector: `[data-date="${checkOut}"], [aria-label*="${checkOutMonth} ${checkOutDay}"]` });
  actions.push({ type: 'wait', milliseconds: 1000 });
  actions.push({ type: 'click', selector: '[data-testid="searchbox-dates-container"] button, button[type="submit"]' });
  actions.push({ type: 'wait', milliseconds: 3000 });
  
  return actions;
}

/**
 * ZYTE BROWSER AUTOMATION - Final escalation for date application
 * 
 * Uses Zyte's browser automation to:
 * 1. Open the listing URL
 * 2. Interact with the date picker
 * 3. Select check-in/check-out dates
 * 4. Wait for pricing to appear
 * 5. Capture the rendered content
 */
async function scrapeWithZyte(
  url: string,
  checkIn: string,
  checkOut: string
): Promise<{ 
  success: boolean; 
  markdown: string; 
  html: string;
  actionsExecuted: string[];
  error?: string 
}> {
  const zyteApiKey = Deno.env.get('ZYTE_API_KEY');
  
  if (!zyteApiKey) {
    return { 
      success: false, 
      markdown: '', 
      html: '',
      actionsExecuted: [],
      error: 'Zyte API key not configured' 
    };
  }
  
  const checkInDate = new Date(checkIn);
  const checkOutDate = new Date(checkOut);
  const checkInDay = checkInDate.getDate();
  const checkOutDay = checkOutDate.getDate();
  
  // Calculate months to navigate from December 2025 to January 2026
  // Use fixed calculation - we know current date is late December 2025
  // and target is January 2026, so we need ~13 months of clicks
  // But Booking.com shows 2 months at a time, so divide by 2
  const monthsToNavigate = 13; // Fixed: Dec 2025 -> Jan 2026
  
  const actionsExecuted: string[] = [];
  
  try {
    console.log(`[GOLDEN-PATH] Zyte: Starting browser automation for ${url}`);
    console.log(`[GOLDEN-PATH] Zyte: Will navigate ${monthsToNavigate} months to reach January 2026`);
    
    // Zyte browser actions for Booking.com
    // Strategy: Click date field, navigate to correct month, select dates, apply
    // Note: Zyte timeout must be <= 15 seconds per action
    const zyteActions: any[] = [
      // Wait for page to fully load
      {
        "action": "waitForTimeout",
        "timeout": 4,
        "onError": "continue"
      }
    ];
    actionsExecuted.push('waitForPage(4s)');
    
    // Click on date field to open calendar - use multiple selectors
    zyteActions.push({
      "action": "click",
      "selector": {
        "type": "css",
        "value": "[data-testid='date-display-field-start']"
      },
      "onError": "continue"
    });
    actionsExecuted.push('click(dateField)');
    
    // Wait for calendar to open
    zyteActions.push({
      "action": "waitForTimeout",
      "timeout": 2,
      "onError": "continue"
    });
    
    // Navigate months - Booking.com shows 2 months at once
    // Need 7 "next" clicks to go from Dec 2025 to Jan 2026 (13 months / 2)
    const clicksNeeded = 7;
    for (let i = 0; i < clicksNeeded; i++) {
      zyteActions.push({
        "action": "click",
        "selector": {
          "type": "css",
          "value": "[data-testid='searchbox-datepicker-calendar'] button[aria-label*='Next month'], button[aria-label*='Next month']"
        },
        "onError": "continue"
      });
      // Short wait between clicks
      if (i < clicksNeeded - 1) {
        zyteActions.push({
          "action": "waitForTimeout",
          "timeout": 0.5,
          "onError": "continue"
        });
      }
    }
    actionsExecuted.push(`navigateMonths(${clicksNeeded})`);
    
    // Wait for calendar to settle on January 2026
    zyteActions.push({
      "action": "waitForTimeout",
      "timeout": 1,
      "onError": "continue"
    });
    
    // Click check-in date (4th of January 2026)
    // Use data-date attribute which Booking.com uses
    zyteActions.push({
      "action": "click",
      "selector": {
        "type": "css",
        "value": `td[data-date='${checkIn}'], [data-date='${checkIn}']`
      },
      "onError": "continue"
    });
    actionsExecuted.push(`click(checkIn=${checkIn})`);
    
    // Wait for check-in selection to register
    zyteActions.push({
      "action": "waitForTimeout",
      "timeout": 1,
      "onError": "continue"
    });
    
    // Click check-out date (8th of January 2026)
    zyteActions.push({
      "action": "click",
      "selector": {
        "type": "css",
        "value": `td[data-date='${checkOut}'], [data-date='${checkOut}']`
      },
      "onError": "continue"
    });
    actionsExecuted.push(`click(checkOut=${checkOut})`);
    
    // Wait for dates to be confirmed
    zyteActions.push({
      "action": "waitForTimeout",
      "timeout": 2,
      "onError": "continue"
    });
    
    // Click search/apply button to apply dates and show prices
    zyteActions.push({
      "action": "click",
      "selector": {
        "type": "css",
        "value": "button[type='submit'], button.e57ffa4eb5"
      },
      "onError": "continue"
    });
    actionsExecuted.push('click(submit)');
    
    // Wait for prices to load after submitting
    zyteActions.push({
      "action": "waitForTimeout",
      "timeout": 5,
      "onError": "continue"
    });
    actionsExecuted.push('waitForPrices(5s)');
    
    console.log(`[GOLDEN-PATH] Zyte: Executing ${zyteActions.length} actions`);
    
    // Make Zyte API request with browser automation
    const response = await fetch('https://api.zyte.com/v1/extract', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${btoa(zyteApiKey + ':')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url,
        browserHtml: true,
        actions: zyteActions,
        javascript: true,
        // Additional Zyte options for better rendering
        viewport: { width: 1920, height: 1080 },
        device: "desktop",
      }),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[GOLDEN-PATH] Zyte error: ${response.status} ${errorText.slice(0, 300)}`);
      return { 
        success: false, 
        markdown: '', 
        html: '',
        actionsExecuted,
        error: `Zyte ${response.status}: ${errorText.slice(0, 200)}` 
      };
    }
    
    const data = await response.json();
    const html = data.browserHtml || '';
    
    // Convert HTML to simplified text for price extraction
    // Remove script and style tags, then extract text
    let textContent = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    
    console.log(`[GOLDEN-PATH] Zyte: Got ${html.length} chars HTML, ${textContent.length} chars text`);
    
    return { 
      success: true, 
      markdown: textContent,
      html,
      actionsExecuted,
    };
    
  } catch (error) {
    console.error(`[GOLDEN-PATH] Zyte exception:`, error);
    return { 
      success: false, 
      markdown: '', 
      html: '',
      actionsExecuted,
      error: error instanceof Error ? error.message : 'Unknown Zyte error' 
    };
  }
}

/**
 * Run a single extraction test with full escalation path
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
      strategyUsed: 'NONE',
      urlParamsAttempted: false,
      urlParamsSuccess: false,
      firecrawlActionsAttempted: false,
      firecrawlActionsSuccess: false,
      zyteAttempted: false,
      zyteSuccess: false,
      contentHashBefore: null,
      contentHashAfterFirecrawl: null,
      contentHashAfterZyte: null,
      contentChanged: false,
      selectorsUsed: [],
      zyteActionsExecuted: [],
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
    failureReason: null,
  };
  
  // Calculate expected nights
  const checkInDate = new Date(checkIn);
  const checkOutDate = new Date(checkOut);
  const expectedNights = Math.round((checkOutDate.getTime() - checkInDate.getTime()) / (1000 * 60 * 60 * 24));
  
  console.log(`[GOLDEN-PATH] Run ${runNumber}: Testing ${url}`);
  console.log(`[GOLDEN-PATH] Run ${runNumber}: Dates ${checkIn} to ${checkOut} (${expectedNights} nights)`);
  
  let finalMarkdown = '';
  let priceEligible = false;
  
  // ============= PHASE A: Date Application with Escalation =============
  
  // ----- STEP 1: Try URL Parameters -----
  console.log(`[GOLDEN-PATH] Run ${runNumber}: Phase A Step 1 - Testing URL parameters`);
  result.phaseA.urlParamsAttempted = true;
  
  const initialScrape = await scrapeWithFirecrawl(url, false);
  
  if (!initialScrape.success) {
    result.error = initialScrape.error || 'Initial scrape failed';
    result.failureCategory = 'D';
    result.failureReason = 'Initial page load failed';
    result.durationMs = Date.now() - startTime;
    return result;
  }
  
  result.phaseA.contentHashBefore = simpleHash(initialScrape.markdown.slice(0, 5000));
  
  // Check for bot blocking
  const botCheck = detectBotBlocking(initialScrape.markdown);
  if (botCheck.blocked) {
    result.error = botCheck.reason || 'Bot blocked';
    result.failureCategory = 'D';
    result.failureReason = `Bot/anti-automation: ${botCheck.reason}`;
    result.durationMs = Date.now() - startTime;
    return result;
  }
  
  // Check if URL params worked
  const initialDateCheck = needsDateApplication(initialScrape.markdown);
  const initialPriceCheck = isPriceEligibleState(initialScrape.markdown, expectedNights);
  
  console.log(`[GOLDEN-PATH] Run ${runNumber}: URL params - needsDates=${initialDateCheck.needsDates}, priceEligible=${initialPriceCheck.isPriceEligible}`);
  
  if (!initialDateCheck.needsDates && initialPriceCheck.isPriceEligible) {
    // URL params worked!
    result.phaseA.urlParamsSuccess = true;
    result.phaseA.strategyUsed = 'URL_PARAMS';
    finalMarkdown = initialScrape.markdown;
    priceEligible = true;
    console.log(`[GOLDEN-PATH] Run ${runNumber}: URL PARAMS SUCCESS`);
  }
  
  // ----- STEP 2: Try Firecrawl Actions -----
  if (!priceEligible) {
    console.log(`[GOLDEN-PATH] Run ${runNumber}: Phase A Step 2 - Trying Firecrawl actions`);
    result.phaseA.firecrawlActionsAttempted = true;
    result.phaseA.evidenceSnippet = initialDateCheck.evidenceSnippet || initialPriceCheck.reason;
    
    const actions = buildFirecrawlActions(checkIn, checkOut);
    result.phaseA.selectorsUsed = [
      '[data-testid="date-display-field-start"]',
      'button[aria-label*="Next"]',
      `[data-date="${checkIn}"]`,
      `[data-date="${checkOut}"]`,
    ];
    
    const firecrawlResult = await scrapeWithFirecrawl(url, true, actions);
    
    if (firecrawlResult.success) {
      result.phaseA.contentHashAfterFirecrawl = simpleHash(firecrawlResult.markdown.slice(0, 5000));
      result.phaseA.contentChanged = result.phaseA.contentHashBefore !== result.phaseA.contentHashAfterFirecrawl;
      
      const firecrawlPriceCheck = isPriceEligibleState(firecrawlResult.markdown, expectedNights);
      console.log(`[GOLDEN-PATH] Run ${runNumber}: Firecrawl actions - contentChanged=${result.phaseA.contentChanged}, priceEligible=${firecrawlPriceCheck.isPriceEligible}`);
      
      if (firecrawlPriceCheck.isPriceEligible) {
        result.phaseA.firecrawlActionsSuccess = true;
        result.phaseA.strategyUsed = 'FIRECRAWL_ACTIONS';
        finalMarkdown = firecrawlResult.markdown;
        priceEligible = true;
        console.log(`[GOLDEN-PATH] Run ${runNumber}: FIRECRAWL ACTIONS SUCCESS`);
      }
    } else {
      console.log(`[GOLDEN-PATH] Run ${runNumber}: Firecrawl actions failed: ${firecrawlResult.error}`);
    }
  }
  
  // ----- STEP 3: Try Zyte Browser Automation (Final Escalation) -----
  if (!priceEligible) {
    console.log(`[GOLDEN-PATH] Run ${runNumber}: Phase A Step 3 - FINAL ESCALATION: Zyte browser automation`);
    result.phaseA.zyteAttempted = true;
    
    const zyteResult = await scrapeWithZyte(url, checkIn, checkOut);
    result.phaseA.zyteActionsExecuted = zyteResult.actionsExecuted;
    
    if (zyteResult.success) {
      result.phaseA.contentHashAfterZyte = simpleHash(zyteResult.markdown.slice(0, 5000));
      result.phaseA.contentChanged = result.phaseA.contentHashBefore !== result.phaseA.contentHashAfterZyte;
      
      const zytePriceCheck = isPriceEligibleState(zyteResult.markdown, expectedNights);
      const zyteNeedsDates = needsDateApplication(zyteResult.markdown);
      
      console.log(`[GOLDEN-PATH] Run ${runNumber}: Zyte - contentChanged=${result.phaseA.contentChanged}, priceEligible=${zytePriceCheck.isPriceEligible}, stillNeedsDates=${zyteNeedsDates.needsDates}`);
      
      if (zytePriceCheck.isPriceEligible && !zyteNeedsDates.needsDates) {
        result.phaseA.zyteSuccess = true;
        result.phaseA.strategyUsed = 'ZYTE_BROWSER';
        finalMarkdown = zyteResult.markdown;
        priceEligible = true;
        console.log(`[GOLDEN-PATH] Run ${runNumber}: ZYTE BROWSER SUCCESS`);
      } else {
        // Zyte executed but still no prices
        result.phaseA.evidenceSnippet = zyteNeedsDates.evidenceSnippet || zytePriceCheck.reason;
        
        // Check if it's a "reserve to see price" situation
        const reserveIndicators = ['reserve', 'select room', 'choose room', 'see prices after'];
        const lowerContent = zyteResult.markdown.toLowerCase();
        const isReserveRequired = reserveIndicators.some(ind => lowerContent.includes(ind));
        
        if (isReserveRequired && !zytePriceCheck.isPriceEligible) {
          result.failureCategory = 'B';
          result.failureReason = 'Prices only visible after room selection/reserve - NOT ALLOWED';
        } else {
          result.failureCategory = 'C';
          result.failureReason = 'Dates cannot be applied reliably via browser automation';
        }
      }
    } else {
      console.log(`[GOLDEN-PATH] Run ${runNumber}: Zyte failed: ${zyteResult.error}`);
      
      // Check if it's a bot block
      if (zyteResult.error?.toLowerCase().includes('blocked') || 
          zyteResult.error?.toLowerCase().includes('captcha')) {
        result.failureCategory = 'D';
        result.failureReason = `Zyte blocked: ${zyteResult.error}`;
      } else {
        result.failureCategory = 'C';
        result.failureReason = `Zyte automation failed: ${zyteResult.error}`;
      }
    }
  }
  
  // If still not price-eligible, we've exhausted all options
  if (!priceEligible) {
    result.error = result.failureReason || 'All date application strategies failed';
    result.durationMs = Date.now() - startTime;
    return result;
  }
  
  // Phase A validated
  result.datesValidated = true;
  result.detectedCheckIn = checkIn;
  result.detectedCheckOut = checkOut;
  result.contentHash = simpleHash(finalMarkdown.slice(0, 5000));
  
  // ============= PHASE B: Price Extraction =============
  
  console.log(`[GOLDEN-PATH] Run ${runNumber}: Phase B - Extracting prices (strategy: ${result.phaseA.strategyUsed})`);
  
  const { allTotals, lowestTotal } = extractBookingComTotals(finalMarkdown, expectedNights);
  
  result.allTotalsFound = allTotals.map(t => `${t.currency} ${t.amount} (${t.context.slice(0, 50)}...)`);
  
  if (!lowestTotal) {
    result.error = `No "for ${expectedNights} nights" totals found in content`;
    result.failureCategory = 'C';
    result.failureReason = 'Content captured but no extractable price patterns';
    result.durationMs = Date.now() - startTime;
    return result;
  }
  
  console.log(`[GOLDEN-PATH] Run ${runNumber}: Found ${allTotals.length} totals, lowest: ${lowestTotal.currency} ${lowestTotal.amount}`);
  
  // Hallucination guard: verify price exists verbatim
  const validation = validatePriceInContent(finalMarkdown, lowestTotal.amount, lowestTotal.currency);
  result.priceFoundVerbatimInContent = validation.found;
  
  if (!validation.found) {
    result.error = `HALLUCINATION GUARD: Price ${lowestTotal.amount} not found verbatim in content`;
    result.failureCategory = 'C';
    result.failureReason = 'Extracted price failed hallucination guard - not found verbatim';
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
  
  console.log(`[GOLDEN-PATH] Run ${runNumber}: SUCCESS - ${lowestTotal.currency} ${lowestTotal.amount} (verified, strategy: ${result.phaseA.strategyUsed})`);
  
  result.durationMs = Date.now() - startTime;
  return result;
}

/**
 * Classify Booking.com based on test results
 */
function classifyPlatform(results: TestResult[]): {
  classification: 'A' | 'B' | 'C' | 'D';
  description: string;
  evidence: string;
  recommendation: string;
} {
  const successfulRuns = results.filter(r => r.success);
  const failedRuns = results.filter(r => !r.success);
  
  // If any run succeeded, we have a golden path
  if (successfulRuns.length > 0) {
    const strategies = successfulRuns.map(r => r.phaseA.strategyUsed);
    const primaryStrategy = strategies[0];
    
    return {
      classification: 'A',
      description: 'Prices visible and extractable pre-payment',
      evidence: `${successfulRuns.length}/${results.length} runs succeeded using ${primaryStrategy}. ` +
                `Extracted prices: ${successfulRuns.map(r => `$${r.extractedPrice}`).join(', ')}`,
      recommendation: 'GOLDEN SUCCESS PATH EXISTS - proceed with implementation',
    };
  }
  
  // All runs failed - determine category
  const categories = failedRuns.map(r => r.failureCategory).filter(Boolean);
  const reasons = failedRuns.map(r => r.failureReason).filter(Boolean);
  
  // Check for Category D (bot blocking)
  if (categories.includes('D')) {
    const dReasons = reasons.filter((r, i) => categories[i] === 'D');
    return {
      classification: 'D',
      description: 'Bot/anti-automation blocks prevent pricing',
      evidence: `Bot blocking detected: ${dReasons.join('; ')}`,
      recommendation: 'Platform blocks automated access - consider API partnership or manual verification',
    };
  }
  
  // Check for Category B (reserve required)
  if (categories.includes('B')) {
    const bReasons = reasons.filter((r, i) => categories[i] === 'B');
    return {
      classification: 'B',
      description: 'Prices only visible after room selection/payment flow',
      evidence: `Reserve flow required: ${bReasons.join('; ')}`,
      recommendation: 'NOT ALLOWED per requirements - prices require proceeding toward payment',
    };
  }
  
  // Default to Category C
  const cReasons = reasons.filter((r, i) => categories[i] === 'C' || !categories[i]);
  return {
    classification: 'C',
    description: 'Dates cannot be applied reliably via browser automation',
    evidence: cReasons.length > 0 ? cReasons.join('; ') : 'All automation strategies failed',
    recommendation: 'REQUIREMENT NOT ACHIEVABLE for this platform with current automation capabilities',
  };
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
      runs = 1  // Default to 1 for faster initial test
    } = await req.json();

    if (!url) {
      return new Response(
        JSON.stringify({ success: false, error: 'URL is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[GOLDEN-PATH] Starting ${runs} test(s) for Booking.com with Zyte escalation`);
    console.log(`[GOLDEN-PATH] URL: ${url}`);
    console.log(`[GOLDEN-PATH] Dates: ${checkIn} to ${checkOut}`);

    const results: TestResult[] = [];
    
    // Run tests consecutively
    for (let i = 1; i <= runs; i++) {
      console.log(`[GOLDEN-PATH] === Starting Run ${i} of ${runs} ===`);
      
      const result = await runSingleTest(url, checkIn, checkOut, i);
      results.push(result);
      
      // Wait between runs
      if (i < runs) {
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }

    // Generate classification
    const classification = classifyPlatform(results);
    
    // Generate stability summary
    const successfulRuns = results.filter(r => r.success);
    const prices = successfulRuns.map(r => r.extractedPrice).filter(p => p !== null) as number[];
    const contentHashes = results.map(r => r.contentHash).filter(h => h !== null);
    const uniqueHashes = [...new Set(contentHashes)];
    
    // Strategy diagnostics
    const strategyDiagnostics = {
      urlParamsAttempted: results.filter(r => r.phaseA.urlParamsAttempted).length,
      urlParamsSuccess: results.filter(r => r.phaseA.urlParamsSuccess).length,
      firecrawlAttempted: results.filter(r => r.phaseA.firecrawlActionsAttempted).length,
      firecrawlSuccess: results.filter(r => r.phaseA.firecrawlActionsSuccess).length,
      zyteAttempted: results.filter(r => r.phaseA.zyteAttempted).length,
      zyteSuccess: results.filter(r => r.phaseA.zyteSuccess).length,
    };
    
    const summary = {
      totalRuns: runs,
      successfulRuns: successfulRuns.length,
      failedRuns: results.filter(r => !r.success).length,
      allDatesValidated: results.every(r => r.datesValidated),
      pricesConsistent: prices.length > 0 && prices.every(p => p === prices[0]),
      priceRange: prices.length > 0 ? { min: Math.min(...prices), max: Math.max(...prices) } : null,
      contentHashesChanged: uniqueHashes.length > 1,
      hallucinations: results.filter(r => r.priceFoundVerbatimInContent === false && r.extractedPrice !== null).length,
      isGoldenPathProven: successfulRuns.length >= 1 && results.every(r => r.priceFoundVerbatimInContent || !r.extractedPrice),
      strategyDiagnostics,
      classification,
    };

    console.log(`[GOLDEN-PATH] === FINAL CLASSIFICATION ===`);
    console.log(`[GOLDEN-PATH] Category: ${classification.classification}`);
    console.log(`[GOLDEN-PATH] Description: ${classification.description}`);
    console.log(`[GOLDEN-PATH] Evidence: ${classification.evidence}`);
    console.log(`[GOLDEN-PATH] Recommendation: ${classification.recommendation}`);

    return new Response(
      JSON.stringify({
        success: true,
        results,
        summary,
        classification,
        conclusion: classification.classification === 'A' 
          ? 'GOLDEN PATH PROVEN: Booking.com extraction is technically achievable'
          : `CLASSIFICATION ${classification.classification}: ${classification.description}`,
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
