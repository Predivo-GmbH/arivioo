const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * HOTELS.COM DIAGNOSTIC TEST - PRODUCTION GRADE WITH RETRY LOGIC
 * 
 * Retry strategy:
 * - Max attempts: 3
 * - Backoff: 1.5s, 3s
 * - Attempt 1-2: Firecrawl only
 * - Attempt 3: Zyte escalation
 * 
 * Retry triggers (transient):
 * - priceEligible=false due to "enter dates" state
 * - 0 prices found (but no bot detection)
 * - minimal content (<1000 chars)
 * - 5xx errors
 * 
 * Hard stop triggers (no retry):
 * - blocked_captcha_or_bot
 * - 403/401/429 blocking
 * - explicit "property unavailable"
 * - explicit "no availability for dates"
 */

interface AttemptDiagnostic {
  attemptNumber: number;
  provider: 'FIRECRAWL' | 'ZYTE';
  requestUrl: string;
  contentLength: number;
  contentHash: string;
  enterDatesFound: boolean;
  priceMatchCount: number;
  outcome: 'success' | 'retry' | 'hard_failure';
  retryReason?: string;
  hardFailureReason?: string;
  durationMs: number;
}

interface DiagnosticResult {
  platform: string;
  timestamp: string;
  durationMs: number;
  classification: 'A' | 'B' | 'C' | 'D';
  classificationDescription: string;
  
  // Retry tracking
  attemptsUsed: number;
  attemptDiagnostics: AttemptDiagnostic[];
  retryExhausted: boolean;
  
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

const RETRY_CONFIG = {
  maxAttempts: 3,
  backoffMs: [1500, 3000], // delays before attempt 2 and 3
  minContentLength: 1000,
  zyteEscalationAttempt: 3,
};

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

function detectHardFailure(markdown: string, statusCode?: number): { failed: boolean; reason: string | null } {
  const lowerMarkdown = markdown.toLowerCase();
  
  // HTTP hard blocks
  if (statusCode && [401, 403, 429].includes(statusCode)) {
    return { failed: true, reason: `HTTP ${statusCode} blocking` };
  }
  
  // Content-based hard failures
  const hardFailures = [
    { pattern: 'property unavailable', reason: 'Property unavailable' },
    { pattern: 'no availability for', reason: 'No availability for dates' },
    { pattern: 'sold out', reason: 'Sold out' },
    { pattern: 'not available for your dates', reason: 'Not available for dates' },
  ];
  
  for (const hf of hardFailures) {
    if (lowerMarkdown.includes(hf.pattern)) {
      return { failed: true, reason: hf.reason };
    }
  }
  
  return { failed: false, reason: null };
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
  
  // Priority 1: "$X total" pattern
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
  
  prices.sort((a, b) => a.amount - b.amount);
  const totals = prices.filter(p => p.priceType === 'total');
  const lowestTotal = totals.length > 0 ? { amount: totals[0].amount, context: totals[0].context } : null;
  
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
): Promise<{ success: boolean; markdown: string; error?: string; statusCode?: number }> {
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
      return { success: false, markdown: '', error: `Firecrawl ${response.status}: ${err.slice(0, 150)}`, statusCode: response.status };
    }
    
    const data = await response.json();
    return { success: true, markdown: data.data?.markdown || data.markdown || '', statusCode: 200 };
  } catch (e) {
    return { success: false, markdown: '', error: e instanceof Error ? e.message : 'Unknown' };
  }
}

async function scrapeWithZyte(
  url: string,
  checkIn: string,
  checkOut: string
): Promise<{ success: boolean; markdown: string; actionsExecuted: string[]; error?: string; statusCode?: number }> {
  const apiKey = Deno.env.get('ZYTE_API_KEY');
  if (!apiKey) return { success: false, markdown: '', actionsExecuted: [], error: 'No Zyte API key' };
  
  const checkInDate = new Date(checkIn);
  const checkOutDate = new Date(checkOut);
  const checkInDay = checkInDate.getDate();
  const checkOutDay = checkOutDate.getDate();
  
  const actionsExecuted: string[] = [];
  
  try {
    console.log(`[HOTELS] Zyte: Starting browser automation (escalation)`);
    
    const zyteActions: any[] = [
      { "action": "waitForTimeout", "timeout": 4, "onError": "continue" }
    ];
    actionsExecuted.push('wait(4s)');
    
    // Click date picker
    zyteActions.push({
      "action": "click",
      "selector": { "type": "css", "value": "button[data-stid='open-date-picker'], [data-testid='date-picker-trigger'], .uitk-date-picker-input-container" },
      "onError": "continue"
    });
    actionsExecuted.push('click(datePicker)');
    
    zyteActions.push({ "action": "waitForTimeout", "timeout": 2, "onError": "continue" });
    
    // Navigate to January 2026
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
    
    // Click dates
    zyteActions.push({
      "action": "click",
      "selector": { "type": "css", "value": `button[data-day='${checkInDay}'][data-month='0'][data-year='2026'], td[data-date='${checkIn}'], button[aria-label*='January ${checkInDay}']` },
      "onError": "continue"
    });
    actionsExecuted.push(`click(checkIn=${checkIn})`);
    
    zyteActions.push({ "action": "waitForTimeout", "timeout": 1, "onError": "continue" });
    
    zyteActions.push({
      "action": "click",
      "selector": { "type": "css", "value": `button[data-day='${checkOutDay}'][data-month='0'][data-year='2026'], td[data-date='${checkOut}'], button[aria-label*='January ${checkOutDay}']` },
      "onError": "continue"
    });
    actionsExecuted.push(`click(checkOut=${checkOut})`);
    
    zyteActions.push({ "action": "waitForTimeout", "timeout": 2, "onError": "continue" });
    
    // Apply
    zyteActions.push({
      "action": "click",
      "selector": { "type": "css", "value": "button[data-stid='apply-date-picker'], button[data-testid='date-picker-apply'], button:contains('Done')" },
      "onError": "continue"
    });
    actionsExecuted.push('click(apply)');
    
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
      return { success: false, markdown: '', actionsExecuted, error: `Zyte ${response.status}: ${err.slice(0, 150)}`, statusCode: response.status };
    }
    
    const data = await response.json();
    const html = data.browserHtml || '';
    
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    
    console.log(`[HOTELS] Zyte: Got ${html.length} chars HTML, ${text.length} chars text`);
    
    return { success: true, markdown: text, actionsExecuted, statusCode: 200 };
  } catch (e) {
    return { success: false, markdown: '', actionsExecuted, error: e instanceof Error ? e.message : 'Unknown' };
  }
}

async function runSingleAttempt(
  url: string,
  checkIn: string,
  checkOut: string,
  attemptNumber: number,
  expectedNights: number
): Promise<{ 
  markdown: string; 
  diagnostic: AttemptDiagnostic;
  priceEligible: boolean;
  enterDates: { found: boolean; snippet: string | null };
  priceCount: number;
  botBlocked: { blocked: boolean; reason: string | null };
  hardFailure: { failed: boolean; reason: string | null };
}> {
  const startTime = Date.now();
  const useZyte = attemptNumber >= RETRY_CONFIG.zyteEscalationAttempt;
  const provider = useZyte ? 'ZYTE' : 'FIRECRAWL';
  
  console.log(`[HOTELS] Attempt ${attemptNumber}: Using ${provider}`);
  
  let markdown = '';
  let statusCode: number | undefined;
  
  if (useZyte) {
    const result = await scrapeWithZyte(url, checkIn, checkOut);
    markdown = result.markdown;
    statusCode = result.statusCode;
    if (!result.success) {
      console.log(`[HOTELS] Attempt ${attemptNumber}: ${provider} failed - ${result.error}`);
    }
  } else {
    const result = await scrapeWithFirecrawl(url);
    markdown = result.markdown;
    statusCode = result.statusCode;
    if (!result.success) {
      console.log(`[HOTELS] Attempt ${attemptNumber}: ${provider} failed - ${result.error}`);
    }
  }
  
  const contentLength = markdown.length;
  const contentHash = simpleHash(markdown.slice(0, 5000));
  const botBlocked = detectBotBlocking(markdown);
  const hardFailure = detectHardFailure(markdown, statusCode);
  const enterDates = detectEnterDatesState(markdown);
  const extraction = extractHotelsComPrices(markdown, expectedNights);
  const priceCount = extraction.prices.length;
  const priceEligible = !enterDates.found && priceCount > 0;
  
  let outcome: 'success' | 'retry' | 'hard_failure' = 'retry';
  let retryReason: string | undefined;
  let hardFailureReason: string | undefined;
  
  // Check for hard failures first
  if (botBlocked.blocked) {
    outcome = 'hard_failure';
    hardFailureReason = `Bot blocked: ${botBlocked.reason}`;
  } else if (hardFailure.failed) {
    outcome = 'hard_failure';
    hardFailureReason = hardFailure.reason || 'Hard failure detected';
  } else if (priceEligible) {
    outcome = 'success';
  } else {
    // Determine retry reason
    if (contentLength < RETRY_CONFIG.minContentLength) {
      retryReason = `Minimal content (${contentLength} chars)`;
    } else if (enterDates.found) {
      retryReason = 'Enter dates state persists';
    } else if (priceCount === 0) {
      retryReason = '0 prices found';
    } else {
      retryReason = 'Unknown retry condition';
    }
  }
  
  const diagnostic: AttemptDiagnostic = {
    attemptNumber,
    provider,
    requestUrl: url,
    contentLength,
    contentHash,
    enterDatesFound: enterDates.found,
    priceMatchCount: priceCount,
    outcome,
    retryReason,
    hardFailureReason,
    durationMs: Date.now() - startTime,
  };
  
  console.log(`[HOTELS] Attempt ${attemptNumber}: outcome=${outcome}, content=${contentLength}, prices=${priceCount}, enterDates=${enterDates.found}`);
  
  return { markdown, diagnostic, priceEligible, enterDates, priceCount, botBlocked, hardFailure };
}

async function runDiagnosticWithRetries(
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
    attemptsUsed: 0,
    attemptDiagnostics: [],
    retryExhausted: false,
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
  
  console.log(`[HOTELS] Starting diagnostic with retries for ${url}`);
  console.log(`[HOTELS] Dates: ${checkIn} to ${checkOut} (${expectedNights} nights)`);
  console.log(`[HOTELS] Max attempts: ${RETRY_CONFIG.maxAttempts}, Zyte escalation at attempt ${RETRY_CONFIG.zyteEscalationAttempt}`);
  
  let finalMarkdown = '';
  let successfulAttempt: AttemptDiagnostic | null = null;
  
  for (let attempt = 1; attempt <= RETRY_CONFIG.maxAttempts; attempt++) {
    result.attemptsUsed = attempt;
    
    // Apply backoff before retries
    if (attempt > 1) {
      const backoffMs = RETRY_CONFIG.backoffMs[attempt - 2] || 3000;
      console.log(`[HOTELS] Waiting ${backoffMs}ms before attempt ${attempt}`);
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }
    
    const attemptResult = await runSingleAttempt(url, checkIn, checkOut, attempt, expectedNights);
    result.attemptDiagnostics.push(attemptResult.diagnostic);
    
    // Track which tools were used
    if (attemptResult.diagnostic.provider === 'FIRECRAWL') {
      result.phaseA.firecrawlAttempted = true;
    } else {
      result.phaseA.zyteAttempted = true;
    }
    
    // Handle hard failure - stop immediately
    if (attemptResult.diagnostic.outcome === 'hard_failure') {
      result.botBlocked = attemptResult.botBlocked.blocked;
      if (attemptResult.botBlocked.blocked) {
        result.classification = 'D';
        result.classificationDescription = `Bot blocked: ${attemptResult.botBlocked.reason}`;
      } else if (attemptResult.hardFailure.failed) {
        result.classification = 'C';
        result.classificationDescription = attemptResult.hardFailure.reason || 'Hard failure';
      }
      result.evidenceSnippets.push(attemptResult.diagnostic.hardFailureReason || 'Hard failure');
      break;
    }
    
    // Handle success
    if (attemptResult.diagnostic.outcome === 'success') {
      successfulAttempt = attemptResult.diagnostic;
      finalMarkdown = attemptResult.markdown;
      
      if (attemptResult.diagnostic.provider === 'FIRECRAWL') {
        result.phaseA.firecrawlSuccess = true;
        result.phaseA.strategyUsed = 'FIRECRAWL';
      } else {
        result.phaseA.zyteSuccess = true;
        result.phaseA.strategyUsed = 'ZYTE';
      }
      
      console.log(`[HOTELS] SUCCESS on attempt ${attempt} via ${attemptResult.diagnostic.provider}`);
      break;
    }
    
    // Log retry
    console.log(`[HOTELS] Attempt ${attempt} needs retry: ${attemptResult.diagnostic.retryReason}`);
    
    // Store evidence from failed attempts
    if (attemptResult.enterDates.snippet) {
      result.evidenceSnippets.push(`Attempt ${attempt}: ${attemptResult.enterDates.snippet}`);
    }
    
    // Check reserve flow on content we have
    if (detectReserveFlowRequired(attemptResult.markdown)) {
      result.reserveFlowRequired = true;
    }
  }
  
  // Check if retries exhausted
  if (!successfulAttempt && result.attemptDiagnostics.every(d => d.outcome !== 'hard_failure')) {
    result.retryExhausted = true;
    console.log(`[HOTELS] All ${RETRY_CONFIG.maxAttempts} attempts exhausted without success`);
  }
  
  // ===== FINAL CLASSIFICATION =====
  if (successfulAttempt) {
    result.datesApplied = true;
    result.priceEligible = true;
    result.contentHash = successfulAttempt.contentHash;
    result.phaseA.contentHashAfter = successfulAttempt.contentHash;
    
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
      result.classificationDescription = 'Dates applied but no extractable total price patterns';
    }
  } else if (!result.botBlocked) {
    // Classify based on what we observed
    if (result.reserveFlowRequired) {
      result.classification = 'B';
      result.classificationDescription = 'Prices only visible after room selection/reserve - NOT ALLOWED';
    } else if (result.retryExhausted) {
      const lastAttempt = result.attemptDiagnostics[result.attemptDiagnostics.length - 1];
      result.classification = 'C';
      result.classificationDescription = `All ${RETRY_CONFIG.maxAttempts} attempts exhausted. Last: ${lastAttempt?.retryReason || 'unknown'}`;
      result.enterDatesFound = lastAttempt?.enterDatesFound || false;
    }
  }
  
  result.durationMs = Date.now() - startTime;
  
  console.log(`[HOTELS] === FINAL CLASSIFICATION ===`);
  console.log(`[HOTELS] Category: ${result.classification}`);
  console.log(`[HOTELS] Description: ${result.classificationDescription}`);
  console.log(`[HOTELS] Attempts used: ${result.attemptsUsed}`);
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

    console.log(`[HOTELS] === HOTELS.COM GOLDEN PATH TEST (WITH RETRIES) ===`);
    console.log(`[HOTELS] URL: ${url}`);
    console.log(`[HOTELS] Dates: ${checkIn} to ${checkOut}`);
    console.log(`[HOTELS] Runs: ${runs}`);

    const results: DiagnosticResult[] = [];
    
    for (let i = 1; i <= runs; i++) {
      console.log(`[HOTELS] === Run ${i} of ${runs} ===`);
      const result = await runDiagnosticWithRetries(url, checkIn, checkOut);
      results.push(result);
      
      // Wait between runs
      if (i < runs) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    
    // Generate stability summary
    const successfulRuns = results.filter(r => r.classification === 'A');
    const prices = successfulRuns.map(r => r.extractedPrice).filter(p => p !== null) as number[];
    const contentHashes = results.map(r => r.contentHash).filter(h => h !== null);
    const uniqueHashes = [...new Set(contentHashes)];
    const uniquePrices = [...new Set(prices)];
    
    const totalAttempts = results.reduce((sum, r) => sum + r.attemptsUsed, 0);
    const avgAttempts = totalAttempts / results.length;
    
    const stabilitySummary = {
      totalRuns: runs,
      successfulRuns: successfulRuns.length,
      failedRuns: results.filter(r => r.classification !== 'A').length,
      totalAttemptsAcrossRuns: totalAttempts,
      avgAttemptsPerRun: avgAttempts.toFixed(1),
      pricesExtracted: prices,
      pricesIdentical: uniquePrices.length <= 1,
      priceRange: prices.length > 0 ? { min: Math.min(...prices), max: Math.max(...prices) } : null,
      contentHashesChanged: uniqueHashes.length > 1,
      uniqueContentHashes: uniqueHashes,
      allHallucinationGuardsPassed: results.every(r => r.priceVerified || r.extractedPrice === null),
      deterministic: uniquePrices.length <= 1 && results.every(r => r.classification === 'A'),
      retryStats: {
        runsRequiringRetries: results.filter(r => r.attemptsUsed > 1).length,
        runsExhausted: results.filter(r => r.retryExhausted).length,
        zyteEscalationsUsed: results.filter(r => r.phaseA.zyteAttempted).length,
      },
    };
    
    const goldenPathProven = successfulRuns.length >= Math.ceil(runs * 0.67) && stabilitySummary.allHallucinationGuardsPassed;
    const isStable = successfulRuns.length === runs;
    
    console.log(`[HOTELS] === STABILITY SUMMARY ===`);
    console.log(`[HOTELS] Successful: ${stabilitySummary.successfulRuns}/${stabilitySummary.totalRuns}`);
    console.log(`[HOTELS] Avg attempts: ${stabilitySummary.avgAttemptsPerRun}`);
    console.log(`[HOTELS] Prices identical: ${stabilitySummary.pricesIdentical}`);
    console.log(`[HOTELS] Golden path proven: ${goldenPathProven}`);
    console.log(`[HOTELS] Stable (all runs succeeded): ${isStable}`);

    let conclusion: string;
    if (isStable) {
      conclusion = 'GOLDEN PATH PROVEN: Hotels.com extraction is reliable, grounded, and repeatable';
    } else if (goldenPathProven) {
      conclusion = `RELIABLE: ${successfulRuns.length}/${runs} runs succeeded (≥67% threshold met)`;
    } else if (successfulRuns.length > 0) {
      conclusion = `UNSTABLE: Only ${successfulRuns.length}/${runs} runs succeeded, below reliability threshold`;
    } else {
      conclusion = `FAILED: All runs failed - ${results[0]?.classificationDescription || 'Unknown error'}`;
    }

    return new Response(
      JSON.stringify({
        success: true,
        results: runs === 1 ? results[0] : results,
        stabilitySummary: runs > 1 ? stabilitySummary : undefined,
        goldenPathProven,
        isStable,
        conclusion,
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
