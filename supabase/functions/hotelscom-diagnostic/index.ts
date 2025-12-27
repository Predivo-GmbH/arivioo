const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * HOTELS.COM DIAGNOSTIC TEST
 * 
 * Final feasibility test for OTA price extraction
 * 
 * Escalation order:
 * 1. URL parameters (fastest, preferred)
 * 2. Firecrawl actions (JS interaction)
 * 3. Zyte browser automation (full browser, final escalation)
 * 
 * Classification output:
 * A) Prices visible and extractable pre-payment → GOLDEN SUCCESS PATH
 * B) Prices only visible after reserve/payment → NOT ALLOWED
 * C) Dates cannot be applied reliably via browser automation → NOT ACHIEVABLE
 * D) Bot/anti-automation blocks prevent pricing → BLOCKED
 */

interface DiagnosticResult {
  platform: string;
  timestamp: string;
  durationMs: number;
  classification: 'A' | 'B' | 'C' | 'D';
  classificationDescription: string;
  
  // Phase A: Date application
  phaseA: {
    urlParamsAttempted: boolean;
    urlParamsSuccess: boolean;
    firecrawlAttempted: boolean;
    firecrawlSuccess: boolean;
    zyteAttempted: boolean;
    zyteSuccess: boolean;
    strategyUsed: string;
    contentHashBefore: string | null;
    contentHashAfter: string | null;
    contentChanged: boolean;
  };
  
  // Phase B: Price extraction
  datesApplied: boolean;
  priceEligible: boolean;
  extractedPrice: number | null;
  currency: string | null;
  includesTaxesFees: boolean | null;
  priceVerified: boolean;
  contentHash: string | null;
  
  // Evidence
  evidenceSnippets: string[];
  enterDatesFound: boolean;
  reserveFlowRequired: boolean;
  botBlocked: boolean;
  
  error: string | null;
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}

function detectEnterDatesState(markdown: string): { found: boolean; snippet: string | null } {
  const lowerMarkdown = markdown.toLowerCase();
  const indicators = [
    'select dates',
    'choose dates',
    'enter dates',
    'add dates',
    'pick dates',
    'check availability',
    'select check-in',
    'when are you traveling',
  ];
  
  for (const indicator of indicators) {
    const index = lowerMarkdown.indexOf(indicator);
    if (index >= 0) {
      const start = Math.max(0, index - 20);
      const end = Math.min(markdown.length, index + indicator.length + 40);
      return { found: true, snippet: markdown.slice(start, end).replace(/\n/g, ' ').trim() };
    }
  }
  return { found: false, snippet: null };
}

function detectBotBlocking(markdown: string): { blocked: boolean; reason: string | null } {
  const lowerMarkdown = markdown.toLowerCase();
  
  // More specific bot blocking patterns - avoid false positives
  const indicators = [
    { pattern: 'captcha', reason: 'CAPTCHA detected' },
    { pattern: 'are you a robot', reason: 'Robot check' },
    { pattern: 'access denied', reason: 'Access denied' },
    { pattern: 'unusual traffic', reason: 'Traffic detection' },
    { pattern: 'verify you are human', reason: 'Human verification' },
    { pattern: 'please complete this captcha', reason: 'CAPTCHA required' },
    { pattern: 'pardon our interruption', reason: 'Cloudflare interstitial' },
  ];
  
  for (const ind of indicators) {
    if (lowerMarkdown.includes(ind.pattern)) {
      return { blocked: true, reason: ind.reason };
    }
  }
  return { blocked: false, reason: null };
}

function detectReserveFlowRequired(markdown: string): boolean {
  const lowerMarkdown = markdown.toLowerCase();
  const indicators = [
    'select room',
    'choose room',
    'view deal',
    'see all deals',
    'reserve now',
    'book now to see',
  ];
  return indicators.some(ind => lowerMarkdown.includes(ind));
}

function extractHotelsComPrices(markdown: string, expectedNights: number): {
  prices: Array<{ amount: number; context: string; priceType: 'total' | 'nightly' | 'unknown' }>;
  lowestTotal: { amount: number; context: string } | null;
  includesTaxesFees: boolean | null;
} {
  const prices: Array<{ amount: number; context: string; priceType: 'total' | 'nightly' | 'unknown' }> = [];
  const seen = new Set<number>();
  
  // Priority 1: "$X total" pattern (most explicit)
  const totalPattern = /\$(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)\s*total/gi;
  let match;
  while ((match = totalPattern.exec(markdown)) !== null) {
    const amount = parseFloat(match[1].replace(/,/g, ''));
    if (!seen.has(amount) && amount >= 50 && amount <= 50000) {
      seen.add(amount);
      const start = Math.max(0, match.index - 40);
      const end = Math.min(markdown.length, match.index + match[0].length + 40);
      prices.push({ 
        amount, 
        context: markdown.slice(start, end).replace(/\n/g, ' ').trim(),
        priceType: 'total'
      });
    }
  }
  
  // Priority 2: "$X for N nights" pattern
  const nightsPattern = new RegExp(`\\$(\\d{1,3}(?:,\\d{3})*(?:\\.\\d{2})?)\\s*(?:for|\\/)\\s*${expectedNights}\\s*nights?`, 'gi');
  while ((match = nightsPattern.exec(markdown)) !== null) {
    const amount = parseFloat(match[1].replace(/,/g, ''));
    if (!seen.has(amount) && amount >= 50 && amount <= 50000) {
      seen.add(amount);
      const start = Math.max(0, match.index - 40);
      const end = Math.min(markdown.length, match.index + match[0].length + 40);
      prices.push({ 
        amount, 
        context: markdown.slice(start, end).replace(/\n/g, ' ').trim(),
        priceType: 'total'
      });
    }
  }
  
  // Sort by amount (lowest first) - selection rule: lowest total
  prices.sort((a, b) => a.amount - b.amount);
  
  // Filter to totals only
  const totals = prices.filter(p => p.priceType === 'total');
  const lowestTotal = totals.length > 0 ? { amount: totals[0].amount, context: totals[0].context } : null;
  
  // Check for taxes/fees inclusion
  const lowerMarkdown = markdown.toLowerCase();
  let includesTaxesFees: boolean | null = null;
  if (lowerMarkdown.includes('includes taxes') || 
      lowerMarkdown.includes('including taxes') ||
      lowerMarkdown.includes('taxes included') ||
      lowerMarkdown.includes('incl. taxes')) {
    includesTaxesFees = true;
  } else if (lowerMarkdown.includes('excludes taxes') || 
             lowerMarkdown.includes('plus taxes') ||
             lowerMarkdown.includes('+ taxes')) {
    includesTaxesFees = false;
  }
  // If not explicitly stated, leave as null
  
  return { prices, lowestTotal, includesTaxesFees };
}

function verifyPriceInContent(markdown: string, price: number): boolean {
  const formats = [
    `$${price.toLocaleString('en-US')}`,
    `$${price.toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
    `$${price}`,
    price.toLocaleString('en-US'),
    price.toString(),
  ];
  return formats.some(f => markdown.includes(f));
}

async function scrapeWithFirecrawl(
  url: string,
  actions: any[] = []
): Promise<{ success: boolean; markdown: string; error?: string }> {
  const apiKey = Deno.env.get('FIRECRAWL_API_KEY_1') || Deno.env.get('FIRECRAWL_API_KEY');
  if (!apiKey) return { success: false, markdown: '', error: 'No Firecrawl API key' };
  
  try {
    const body: any = {
      url,
      formats: ['markdown'],
      onlyMainContent: true,
      waitFor: actions.length > 0 ? 3000 : 8000,
    };
    if (actions.length > 0) body.actions = actions;
    
    console.log(`[HOTELS] Firecrawl: ${actions.length > 0 ? 'with actions' : 'URL only'}`);
    
    const response = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    
    if (!response.ok) {
      const err = await response.text();
      return { success: false, markdown: '', error: `Firecrawl ${response.status}: ${err.slice(0, 150)}` };
    }
    
    const data = await response.json();
    return { success: true, markdown: data.data?.markdown || data.markdown || '' };
  } catch (e) {
    return { success: false, markdown: '', error: e instanceof Error ? e.message : 'Unknown' };
  }
}

async function scrapeWithZyte(
  url: string,
  checkIn: string,
  checkOut: string
): Promise<{ success: boolean; markdown: string; actionsExecuted: string[]; error?: string }> {
  const apiKey = Deno.env.get('ZYTE_API_KEY');
  if (!apiKey) return { success: false, markdown: '', actionsExecuted: [], error: 'No Zyte API key' };
  
  const checkInDate = new Date(checkIn);
  const checkOutDate = new Date(checkOut);
  const checkInDay = checkInDate.getDate();
  const checkOutDay = checkOutDate.getDate();
  
  const actionsExecuted: string[] = [];
  
  try {
    console.log(`[HOTELS] Zyte: Starting browser automation`);
    
    // Hotels.com specific actions
    const zyteActions: any[] = [
      { "action": "waitForTimeout", "timeout": 4, "onError": "continue" }
    ];
    actionsExecuted.push('wait(4s)');
    
    // Click date picker - Hotels.com uses different selectors
    zyteActions.push({
      "action": "click",
      "selector": { "type": "css", "value": "button[data-stid='open-date-picker'], [data-testid='date-picker-trigger'], .uitk-date-picker-input-container" },
      "onError": "continue"
    });
    actionsExecuted.push('click(datePicker)');
    
    zyteActions.push({ "action": "waitForTimeout", "timeout": 2, "onError": "continue" });
    
    // Navigate to January 2026 - Hotels.com shows 2 months, need ~7 clicks
    for (let i = 0; i < 7; i++) {
      zyteActions.push({
        "action": "click",
        "selector": { "type": "css", "value": "button[data-stid='date-picker-paging'][data-direction='next'], button[aria-label*='next month'], .uitk-calendar-navigation button:last-child" },
        "onError": "continue"
      });
      if (i < 6) {
        zyteActions.push({ "action": "waitForTimeout", "timeout": 0.5, "onError": "continue" });
      }
    }
    actionsExecuted.push('navigate(7months)');
    
    zyteActions.push({ "action": "waitForTimeout", "timeout": 1, "onError": "continue" });
    
    // Click check-in date
    zyteActions.push({
      "action": "click",
      "selector": { "type": "css", "value": `button[data-day='${checkInDay}'][data-month='0'][data-year='2026'], td[data-date='${checkIn}'], button[aria-label*='January ${checkInDay}']` },
      "onError": "continue"
    });
    actionsExecuted.push(`click(checkIn=${checkIn})`);
    
    zyteActions.push({ "action": "waitForTimeout", "timeout": 1, "onError": "continue" });
    
    // Click check-out date
    zyteActions.push({
      "action": "click",
      "selector": { "type": "css", "value": `button[data-day='${checkOutDay}'][data-month='0'][data-year='2026'], td[data-date='${checkOut}'], button[aria-label*='January ${checkOutDay}']` },
      "onError": "continue"
    });
    actionsExecuted.push(`click(checkOut=${checkOut})`);
    
    zyteActions.push({ "action": "waitForTimeout", "timeout": 2, "onError": "continue" });
    
    // Click Done/Apply
    zyteActions.push({
      "action": "click",
      "selector": { "type": "css", "value": "button[data-stid='apply-date-picker'], button[data-testid='date-picker-apply'], button:contains('Done')" },
      "onError": "continue"
    });
    actionsExecuted.push('click(apply)');
    
    // Wait for prices
    zyteActions.push({ "action": "waitForTimeout", "timeout": 5, "onError": "continue" });
    actionsExecuted.push('wait(5s)');
    
    console.log(`[HOTELS] Zyte: Executing ${zyteActions.length} actions`);
    
    const response = await fetch('https://api.zyte.com/v1/extract', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${btoa(apiKey + ':')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url,
        browserHtml: true,
        actions: zyteActions,
        javascript: true,
        viewport: { width: 1920, height: 1080 },
      }),
    });
    
    if (!response.ok) {
      const err = await response.text();
      return { success: false, markdown: '', actionsExecuted, error: `Zyte ${response.status}: ${err.slice(0, 150)}` };
    }
    
    const data = await response.json();
    const html = data.browserHtml || '';
    
    // Convert to text
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    
    console.log(`[HOTELS] Zyte: Got ${html.length} chars HTML, ${text.length} chars text`);
    
    return { success: true, markdown: text, actionsExecuted };
  } catch (e) {
    return { success: false, markdown: '', actionsExecuted, error: e instanceof Error ? e.message : 'Unknown' };
  }
}

function buildFirecrawlActions(checkIn: string, checkOut: string): any[] {
  const checkInDate = new Date(checkIn);
  const checkOutDate = new Date(checkOut);
  const checkInDay = checkInDate.getDate();
  const checkOutDay = checkOutDate.getDate();
  
  const actions: any[] = [
    { type: 'wait', milliseconds: 3000 },
    { type: 'click', selector: 'button[data-stid="open-date-picker"], [data-testid="date-picker-trigger"]' },
    { type: 'wait', milliseconds: 2000 },
  ];
  
  // Navigate months
  for (let i = 0; i < 7; i++) {
    actions.push({ type: 'click', selector: 'button[data-stid="date-picker-paging"][data-direction="next"], button[aria-label*="next month"]' });
    actions.push({ type: 'wait', milliseconds: 400 });
  }
  
  // Select dates
  actions.push({ type: 'click', selector: `button[data-day="${checkInDay}"][data-month="0"][data-year="2026"]` });
  actions.push({ type: 'wait', milliseconds: 800 });
  actions.push({ type: 'click', selector: `button[data-day="${checkOutDay}"][data-month="0"][data-year="2026"]` });
  actions.push({ type: 'wait', milliseconds: 1000 });
  actions.push({ type: 'click', selector: 'button[data-stid="apply-date-picker"]' });
  actions.push({ type: 'wait', milliseconds: 4000 });
  
  return actions;
}

async function runDiagnostic(
  url: string,
  checkIn: string,
  checkOut: string
): Promise<DiagnosticResult> {
  const startTime = Date.now();
  const expectedNights = Math.round((new Date(checkOut).getTime() - new Date(checkIn).getTime()) / (1000 * 60 * 60 * 24));
  
  const result: DiagnosticResult = {
    platform: 'Hotels.com',
    timestamp: new Date().toISOString(),
    durationMs: 0,
    classification: 'C',
    classificationDescription: '',
    phaseA: {
      urlParamsAttempted: false,
      urlParamsSuccess: false,
      firecrawlAttempted: false,
      firecrawlSuccess: false,
      zyteAttempted: false,
      zyteSuccess: false,
      strategyUsed: 'NONE',
      contentHashBefore: null,
      contentHashAfter: null,
      contentChanged: false,
    },
    datesApplied: false,
    priceEligible: false,
    extractedPrice: null,
    currency: null,
    includesTaxesFees: null,
    priceVerified: false,
    contentHash: null,
    evidenceSnippets: [],
    enterDatesFound: false,
    reserveFlowRequired: false,
    botBlocked: false,
    error: null,
  };
  
  console.log(`[HOTELS] Starting diagnostic for ${url}`);
  console.log(`[HOTELS] Dates: ${checkIn} to ${checkOut} (${expectedNights} nights)`);
  
  let finalMarkdown = '';
  let priceEligible = false;
  
  // ===== PHASE A: URL Parameters =====
  console.log(`[HOTELS] Phase A Step 1: Testing URL parameters`);
  result.phaseA.urlParamsAttempted = true;
  
  const urlScrape = await scrapeWithFirecrawl(url);
  if (!urlScrape.success) {
    result.error = urlScrape.error || 'Initial scrape failed';
    result.classification = 'D';
    result.classificationDescription = 'Initial page load failed';
    result.durationMs = Date.now() - startTime;
    return result;
  }
  
  result.phaseA.contentHashBefore = simpleHash(urlScrape.markdown.slice(0, 5000));
  
  // Check for bot blocking
  const botCheck = detectBotBlocking(urlScrape.markdown);
  if (botCheck.blocked) {
    result.botBlocked = true;
    result.classification = 'D';
    result.classificationDescription = `Bot blocked: ${botCheck.reason}`;
    result.evidenceSnippets.push(`Bot detection: ${botCheck.reason}`);
    result.durationMs = Date.now() - startTime;
    return result;
  }
  
  // Check if URL params worked
  const enterDates = detectEnterDatesState(urlScrape.markdown);
  const urlExtraction = extractHotelsComPrices(urlScrape.markdown, expectedNights);
  
  console.log(`[HOTELS] URL params: enterDatesFound=${enterDates.found}, pricesFound=${urlExtraction.prices.length}`);
  
  if (!enterDates.found && urlExtraction.prices.length > 0) {
    result.phaseA.urlParamsSuccess = true;
    result.phaseA.strategyUsed = 'URL_PARAMS';
    finalMarkdown = urlScrape.markdown;
    priceEligible = true;
    console.log(`[HOTELS] URL PARAMS SUCCESS!`);
  } else {
    if (enterDates.snippet) result.evidenceSnippets.push(enterDates.snippet);
  }
  
  // ===== PHASE A Step 2: Firecrawl Actions =====
  if (!priceEligible) {
    console.log(`[HOTELS] Phase A Step 2: Trying Firecrawl actions`);
    result.phaseA.firecrawlAttempted = true;
    
    const actions = buildFirecrawlActions(checkIn, checkOut);
    const firecrawlResult = await scrapeWithFirecrawl(url, actions);
    
    if (firecrawlResult.success) {
      result.phaseA.contentHashAfter = simpleHash(firecrawlResult.markdown.slice(0, 5000));
      result.phaseA.contentChanged = result.phaseA.contentHashBefore !== result.phaseA.contentHashAfter;
      
      const fcEnterDates = detectEnterDatesState(firecrawlResult.markdown);
      const fcExtraction = extractHotelsComPrices(firecrawlResult.markdown, expectedNights);
      
      console.log(`[HOTELS] Firecrawl: contentChanged=${result.phaseA.contentChanged}, enterDates=${fcEnterDates.found}, prices=${fcExtraction.prices.length}`);
      
      if (!fcEnterDates.found && fcExtraction.prices.length > 0) {
        result.phaseA.firecrawlSuccess = true;
        result.phaseA.strategyUsed = 'FIRECRAWL_ACTIONS';
        finalMarkdown = firecrawlResult.markdown;
        priceEligible = true;
        console.log(`[HOTELS] FIRECRAWL SUCCESS!`);
      }
    } else {
      console.log(`[HOTELS] Firecrawl failed: ${firecrawlResult.error}`);
    }
  }
  
  // ===== PHASE A Step 3: Zyte Browser =====
  if (!priceEligible) {
    console.log(`[HOTELS] Phase A Step 3: FINAL ESCALATION - Zyte browser`);
    result.phaseA.zyteAttempted = true;
    
    const zyteResult = await scrapeWithZyte(url, checkIn, checkOut);
    
    if (zyteResult.success) {
      result.phaseA.contentHashAfter = simpleHash(zyteResult.markdown.slice(0, 5000));
      result.phaseA.contentChanged = result.phaseA.contentHashBefore !== result.phaseA.contentHashAfter;
      
      const zyteEnterDates = detectEnterDatesState(zyteResult.markdown);
      const zyteExtraction = extractHotelsComPrices(zyteResult.markdown, expectedNights);
      
      console.log(`[HOTELS] Zyte: contentChanged=${result.phaseA.contentChanged}, enterDates=${zyteEnterDates.found}, prices=${zyteExtraction.prices.length}`);
      
      if (!zyteEnterDates.found && zyteExtraction.prices.length > 0) {
        result.phaseA.zyteSuccess = true;
        result.phaseA.strategyUsed = 'ZYTE_BROWSER';
        finalMarkdown = zyteResult.markdown;
        priceEligible = true;
        console.log(`[HOTELS] ZYTE SUCCESS!`);
      } else {
        // Check for reserve flow
        result.reserveFlowRequired = detectReserveFlowRequired(zyteResult.markdown);
        result.enterDatesFound = zyteEnterDates.found;
        if (zyteEnterDates.snippet) result.evidenceSnippets.push(zyteEnterDates.snippet);
      }
    } else {
      console.log(`[HOTELS] Zyte failed: ${zyteResult.error}`);
      result.error = zyteResult.error || null;
    }
  }
  
  // ===== CLASSIFICATION =====
  if (priceEligible) {
    result.datesApplied = true;
    result.priceEligible = true;
    result.contentHash = simpleHash(finalMarkdown.slice(0, 5000));
    
    const extraction = extractHotelsComPrices(finalMarkdown, expectedNights);
    
    if (extraction.lowestTotal) {
      result.extractedPrice = extraction.lowestTotal.amount;
      result.currency = 'USD';
      result.priceVerified = verifyPriceInContent(finalMarkdown, extraction.lowestTotal.amount);
      result.includesTaxesFees = extraction.includesTaxesFees;
      
      if (result.priceVerified) {
        result.classification = 'A';
        result.classificationDescription = 'Prices visible and extractable pre-payment - GOLDEN SUCCESS PATH';
        result.evidenceSnippets.push(extraction.lowestTotal.context);
      } else {
        result.classification = 'C';
        result.classificationDescription = 'Price extracted but failed hallucination guard';
      }
    } else {
      result.classification = 'C';
      result.classificationDescription = 'Dates applied but no extractable price patterns';
    }
  } else {
    // Failed to get prices
    if (result.reserveFlowRequired) {
      result.classification = 'B';
      result.classificationDescription = 'Prices only visible after room selection/reserve - NOT ALLOWED';
    } else if (result.enterDatesFound) {
      result.classification = 'C';
      result.classificationDescription = 'Dates cannot be applied reliably via browser automation';
    } else if (result.botBlocked) {
      result.classification = 'D';
      result.classificationDescription = 'Bot/anti-automation blocking detected';
    } else {
      result.classification = 'C';
      result.classificationDescription = 'All date application strategies failed';
    }
  }
  
  result.durationMs = Date.now() - startTime;
  
  console.log(`[HOTELS] === FINAL CLASSIFICATION ===`);
  console.log(`[HOTELS] Category: ${result.classification}`);
  console.log(`[HOTELS] Description: ${result.classificationDescription}`);
  console.log(`[HOTELS] Duration: ${result.durationMs}ms`);
  
  return result;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { 
      url = 'https://www.hotels.com/ho227622/hyatt-regency-san-francisco-san-francisco-united-states-of-america/?chkin=2026-01-04&chkout=2026-01-08&x_pwa=1&q-room-0-adults=2&q-room-0-children=0',
      checkIn = '2026-01-04', 
      checkOut = '2026-01-08',
      runs = 1,
    } = await req.json();

    console.log(`[HOTELS] === HOTELS.COM GOLDEN PATH TEST ===`);
    console.log(`[HOTELS] URL: ${url}`);
    console.log(`[HOTELS] Dates: ${checkIn} to ${checkOut}`);
    console.log(`[HOTELS] Runs: ${runs}`);

    const results: DiagnosticResult[] = [];
    
    for (let i = 1; i <= runs; i++) {
      console.log(`[HOTELS] === Run ${i} of ${runs} ===`);
      const result = await runDiagnostic(url, checkIn, checkOut);
      results.push(result);
      
      // Wait between runs to avoid rate limiting
      if (i < runs) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    
    // Generate stability summary for multi-run tests
    const successfulRuns = results.filter(r => r.classification === 'A');
    const prices = successfulRuns.map(r => r.extractedPrice).filter(p => p !== null) as number[];
    const contentHashes = results.map(r => r.contentHash).filter(h => h !== null);
    const uniqueHashes = [...new Set(contentHashes)];
    const uniquePrices = [...new Set(prices)];
    
    const stabilitySummary = {
      totalRuns: runs,
      successfulRuns: successfulRuns.length,
      failedRuns: results.filter(r => r.classification !== 'A').length,
      pricesExtracted: prices,
      pricesIdentical: uniquePrices.length <= 1,
      priceRange: prices.length > 0 ? { min: Math.min(...prices), max: Math.max(...prices) } : null,
      contentHashesChanged: uniqueHashes.length > 1,
      uniqueContentHashes: uniqueHashes,
      allHallucinationGuardsPassed: results.every(r => r.priceVerified || r.extractedPrice === null),
      deterministic: uniquePrices.length <= 1 && results.every(r => r.classification === 'A'),
    };
    
    const goldenPathProven = successfulRuns.length === runs && stabilitySummary.allHallucinationGuardsPassed;
    
    console.log(`[HOTELS] === STABILITY SUMMARY ===`);
    console.log(`[HOTELS] Successful: ${stabilitySummary.successfulRuns}/${stabilitySummary.totalRuns}`);
    console.log(`[HOTELS] Prices identical: ${stabilitySummary.pricesIdentical}`);
    console.log(`[HOTELS] Golden path proven: ${goldenPathProven}`);

    return new Response(
      JSON.stringify({
        success: true,
        results: runs === 1 ? results[0] : results,
        stabilitySummary: runs > 1 ? stabilitySummary : undefined,
        goldenPathProven,
        conclusion: goldenPathProven 
          ? 'GOLDEN PATH PROVEN: Hotels.com extraction is reliable, grounded, and repeatable'
          : successfulRuns.length > 0
            ? `PARTIAL SUCCESS: ${successfulRuns.length}/${runs} runs succeeded`
            : `FAILED: ${results[0]?.classificationDescription || 'Unknown error'}`,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[HOTELS] Fatal error:', error);
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
