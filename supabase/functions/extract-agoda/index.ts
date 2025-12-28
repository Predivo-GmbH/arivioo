import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * Agoda Production Extraction Function
 * 
 * Agoda is a PROMOTION CANDIDATE from Tier B → Tier A.
 * Follows the same contract as the Hotels.com/Expedia reference implementations.
 * 
 * EXTRACTION CONTRACT:
 * - Phase A: Validate dates are applied and page is price-eligible
 * - Phase B: Extract total price only (not nightly, not per-room ambiguity)
 * - Never fall back to AI inference if no price is present
 * - Always require verbatim evidence from captured content
 * 
 * PROMOTION CRITERIA:
 * - 3 consecutive runs on same listing/dates
 * - Identical total price across runs
 * - Identical content hash across runs
 * - No retries or at most one retry
 * - Evidence snippets match page content
 * - No reserve/payment flow required
 */

// Terminal status values
type TerminalStatus = 
  | 'success'
  | 'dates_not_applied'
  | 'no_availability_for_dates'
  | 'blocked_captcha_or_bot'
  | 'sold_out'
  | 'price_not_found'
  | 'render_failed'
  | 'validation_error';

interface ExtractionRequest {
  extractionId?: string;
  url?: string;
  checkIn: string;
  checkOut: string;
  adults?: number;
  children?: number;
  rooms?: number;
}

interface ExtractionResult {
  success: boolean;
  status: TerminalStatus;
  phaseA: {
    ran: boolean;
    priceEligible: boolean;
    enterDatesFound: boolean;
    soldOut: boolean;
    contentHash: string | null;
    contentLength: number;
  };
  phaseB: {
    ran: boolean;
    extractedPrice: number | null;
    currency: string | null;
    includesTaxesFees: boolean | null;
    priceVerified: boolean;
    evidenceSnippet: string | null;
  };
  durationMs: number;
  error: string | null;
  strategyUsed: 'url_params' | 'firecrawl_actions' | 'zyte';
  attempts: AttemptResult[];
}

interface AttemptResult {
  attemptNumber: number;
  provider: 'firecrawl' | 'zyte';
  strategy: 'url_params' | 'firecrawl_actions' | 'zyte_javascript';
  contentLength: number;
  contentHash: string;
  success: boolean;
  error?: string;
}

// Simple hash for content verification
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

/**
 * Build Agoda URL with date parameters
 * Agoda uses: checkIn=YYYY-MM-DD, checkOut=YYYY-MM-DD, adults=N
 */
function buildAgodaUrl(baseUrl: string, checkIn: string, checkOut: string, adults: number = 2): string {
  const url = new URL(baseUrl);
  
  // Agoda uses los (length of stay) and some use check-in/check-out directly
  // Primary format: checkIn and checkOut params
  url.searchParams.set('checkIn', checkIn);
  url.searchParams.set('checkOut', checkOut);
  url.searchParams.set('adults', String(adults));
  url.searchParams.set('children', '0');
  url.searchParams.set('rooms', '1');
  
  return url.toString();
}

// Phase A: Validate page is price-eligible
function validatePhaseA(markdown: string): {
  priceEligible: boolean;
  enterDatesFound: boolean;
  soldOut: boolean;
  priceCount: number;
  dateRangeDetected: boolean;
} {
  const lowerMarkdown = markdown.toLowerCase();
  
  // Check for "enter dates" state (indicates dates not applied)
  const enterDatesIndicators = [
    'enter your dates',
    'select dates',
    'choose your dates',
    'add dates',
    'enter dates to see',
    'select check-in',
    'pick dates',
    'select your travel dates',
    'choose dates to see',
  ];
  const enterDatesFound = enterDatesIndicators.some(ind => lowerMarkdown.includes(ind));
  
  // Check for sold out / unavailable
  const soldOutIndicators = [
    'sold out',
    'not available',
    'no rooms available',
    'fully booked',
    'no availability',
    'currently unavailable',
    'property is not available',
  ];
  const soldOut = soldOutIndicators.some(ind => lowerMarkdown.includes(ind));
  
  // Count price patterns - Agoda typically shows prices with $ or currency symbols
  // Look for total prices, not nightly rates
  const totalPricePattern = /(?:\$|USD|US\$)[\s]*[\d,]+(?:\.\d{2})?\s*(?:total|for\s+\d+\s*nights?)?/gi;
  const matches = markdown.match(totalPricePattern) || [];
  
  // Also check for more specific Agoda patterns
  const agodaPricePattern = /(?:total|grand total|final price)[:\s]*(?:\$|USD)[\s]*[\d,]+/gi;
  const agodaMatches = markdown.match(agodaPricePattern) || [];
  
  const allPriceMatches = matches.length + agodaMatches.length;
  
  // Check if date range is visible (indicates dates were applied)
  const dateRangePattern = /(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}/gi;
  const dateMatches = markdown.match(dateRangePattern) || [];
  const dateRangeDetected = dateMatches.length >= 2;
  
  // Price-eligible if we find prices and not in "enter dates" state
  const priceEligible = allPriceMatches > 0 && !enterDatesFound && !soldOut;
  
  return {
    priceEligible,
    enterDatesFound,
    soldOut,
    priceCount: allPriceMatches,
    dateRangeDetected,
  };
}

// Phase B: Extract total price with verification (GROUNDED EXTRACTION ONLY)
function extractPrice(markdown: string): {
  extractedPrice: number | null;
  currency: string | null;
  includesTaxesFees: boolean | null;
  priceVerified: boolean;
  evidenceSnippet: string | null;
} {
  // Pattern 1: "Total: $XXX" or "Grand Total: $XXX"
  const totalLabelPattern = /(?:total|grand total|final price)[:\s]*\$?([\d,]+(?:\.\d{2})?)/i;
  const totalLabelMatch = markdown.match(totalLabelPattern);
  
  // Pattern 2: "$XXX total" or "$XXX for X nights"
  const suffixPattern = /\$([\d,]+(?:\.\d{2})?)\s*(?:total|for\s+\d+\s*nights?)/gi;
  const suffixMatches = [...markdown.matchAll(suffixPattern)];
  
  // Pattern 3: "Price: $XXX" or explicit price declarations
  const pricePattern = /price[:\s]*\$?([\d,]+(?:\.\d{2})?)/gi;
  const priceMatches = [...markdown.matchAll(pricePattern)];
  
  let extractedPrice: number | null = null;
  let evidenceSnippet: string | null = null;
  let includesTaxesFees: boolean | null = null;
  
  // Priority 1: Explicit "Total: $XXX" pattern
  if (totalLabelMatch) {
    const priceStr = totalLabelMatch[1].replace(/,/g, '');
    extractedPrice = parseFloat(priceStr);
    
    // Get surrounding context for evidence
    const matchIndex = markdown.indexOf(totalLabelMatch[0]);
    const start = Math.max(0, matchIndex - 40);
    const end = Math.min(markdown.length, matchIndex + totalLabelMatch[0].length + 60);
    evidenceSnippet = markdown.slice(start, end).replace(/\s+/g, ' ').trim();
    
    // Check for taxes/fees mention
    const context = markdown.slice(matchIndex, matchIndex + 150).toLowerCase();
    if (context.includes('taxes') && context.includes('fees')) {
      includesTaxesFees = true;
    } else if (context.includes('incl') || context.includes('including')) {
      includesTaxesFees = true;
    }
  }
  // Priority 2: "$XXX total" suffix pattern
  else if (suffixMatches.length > 0) {
    const firstMatch = suffixMatches[0];
    const priceStr = firstMatch[1].replace(/,/g, '');
    extractedPrice = parseFloat(priceStr);
    
    const matchIndex = markdown.indexOf(firstMatch[0]);
    const start = Math.max(0, matchIndex - 40);
    const end = Math.min(markdown.length, matchIndex + firstMatch[0].length + 60);
    evidenceSnippet = markdown.slice(start, end).replace(/\s+/g, ' ').trim();
    
    const context = markdown.slice(matchIndex, matchIndex + 150).toLowerCase();
    if (context.includes('taxes') && context.includes('fees')) {
      includesTaxesFees = true;
    }
  }
  // Priority 3: General price pattern (least reliable, only if explicit total context)
  else if (priceMatches.length > 0) {
    // Only use if "total" appears nearby
    for (const match of priceMatches) {
      const matchIndex = markdown.indexOf(match[0]);
      const context = markdown.slice(Math.max(0, matchIndex - 50), matchIndex + 100).toLowerCase();
      
      if (context.includes('total')) {
        const priceStr = match[1].replace(/,/g, '');
        extractedPrice = parseFloat(priceStr);
        
        const start = Math.max(0, matchIndex - 40);
        const end = Math.min(markdown.length, matchIndex + match[0].length + 60);
        evidenceSnippet = markdown.slice(start, end).replace(/\s+/g, ' ').trim();
        break;
      }
    }
  }
  
  // HALLUCINATION GUARD: Price MUST appear verbatim in evidence
  const priceVerified = extractedPrice !== null && 
    evidenceSnippet !== null && 
    (evidenceSnippet.includes(String(Math.round(extractedPrice))) || 
     evidenceSnippet.includes(extractedPrice.toLocaleString()) ||
     evidenceSnippet.includes(String(extractedPrice)));
  
  return {
    extractedPrice,
    currency: extractedPrice ? 'USD' : null, // Agoda may use various currencies, default USD
    includesTaxesFees,
    priceVerified,
    evidenceSnippet,
  };
}

// Check for bot blocking
function detectBotBlocking(markdown: string): boolean {
  const lowerMarkdown = markdown.toLowerCase();
  
  const explicitBlockingIndicators = [
    'access denied',
    'please verify you are human',
    'prove you are human',
    'complete the captcha',
    'security check required',
    'unusual traffic',
    'automated access',
    'bot detected',
    'verify you are not a robot',
  ];
  
  return explicitBlockingIndicators.some(ind => lowerMarkdown.includes(ind));
}

// Check for login/reserve/payment requirements (blocking for promotion)
function detectBlockingFlows(markdown: string): {
  loginRequired: boolean;
  reserveRequired: boolean;
  paymentRequired: boolean;
} {
  const lowerMarkdown = markdown.toLowerCase();
  
  const loginIndicators = [
    'sign in to see price',
    'log in to see',
    'member price',
    'members only',
    'sign in required',
  ];
  
  const reserveIndicators = [
    'request to book',
    'inquiry only',
    'contact host',
    'submit request',
  ];
  
  const paymentIndicators = [
    'total at checkout',
    'see total at payment',
    'price shown at checkout',
    'continue to payment to see',
  ];
  
  return {
    loginRequired: loginIndicators.some(ind => lowerMarkdown.includes(ind)),
    reserveRequired: reserveIndicators.some(ind => lowerMarkdown.includes(ind)),
    paymentRequired: paymentIndicators.some(ind => lowerMarkdown.includes(ind)),
  };
}

// Retry configuration - strict for promotion quality
const MAX_ATTEMPTS = 2; // At most one retry for promotion criteria
const BACKOFF_DELAYS = [0, 2000]; // ms delays before each attempt
const MINIMAL_CONTENT_THRESHOLD = 3000; // chars

async function fetchWithFirecrawl(url: string, waitFor: number = 3000): Promise<{ markdown: string; error?: string }> {
  const firecrawlApiKey = Deno.env.get('FIRECRAWL_API_KEY_1') || Deno.env.get('FIRECRAWL_API_KEY');
  
  if (!firecrawlApiKey) {
    return { markdown: '', error: 'Firecrawl API key not configured' };
  }
  
  try {
    const response = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${firecrawlApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url,
        formats: ['markdown'],
        onlyMainContent: true,
        waitFor,
      }),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[AGODA] Firecrawl error: ${errorText}`);
      return { markdown: '', error: `Firecrawl error: ${response.status}` };
    }
    
    const data = await response.json();
    return { markdown: data.data?.markdown || data.markdown || '' };
  } catch (error) {
    return { markdown: '', error: error instanceof Error ? error.message : 'Firecrawl fetch failed' };
  }
}

async function fetchWithZyte(url: string): Promise<{ markdown: string; error?: string }> {
  const zyteApiKey = Deno.env.get('ZYTE_API_KEY');
  
  if (!zyteApiKey) {
    return { markdown: '', error: 'Zyte API key not configured' };
  }
  
  try {
    const response = await fetch('https://api.zyte.com/v1/extract', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${btoa(zyteApiKey + ':')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url,
        browserHtml: true,
        javascript: true,
        actions: [
          { action: 'waitForTimeout', timeout: 5000 }
        ],
      }),
    });
    
    if (!response.ok) {
      return { markdown: '', error: `Zyte error: ${response.status}` };
    }
    
    const data = await response.json();
    const html = data.browserHtml || '';
    // Simple HTML to text conversion
    const text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                     .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                     .replace(/<[^>]+>/g, ' ')
                     .replace(/\s+/g, ' ')
                     .trim();
    return { markdown: text };
  } catch (error) {
    return { markdown: '', error: error instanceof Error ? error.message : 'Zyte fetch failed' };
  }
}

async function extractFromAgoda(
  url: string,
  checkIn: string,
  checkOut: string,
  adults: number = 2
): Promise<ExtractionResult> {
  const startTime = Date.now();
  const attempts: AttemptResult[] = [];
  
  const result: ExtractionResult = {
    success: false,
    status: 'validation_error',
    phaseA: {
      ran: false,
      priceEligible: false,
      enterDatesFound: false,
      soldOut: false,
      contentHash: null,
      contentLength: 0,
    },
    phaseB: {
      ran: false,
      extractedPrice: null,
      currency: null,
      includesTaxesFees: null,
      priceVerified: false,
      evidenceSnippet: null,
    },
    durationMs: 0,
    error: null,
    strategyUsed: 'url_params',
    attempts: [],
  };
  
  try {
    // Strategy 1: Build URL with date parameters
    const fullUrl = buildAgodaUrl(url, checkIn, checkOut, adults);
    console.log(`[AGODA] Extracting from: ${fullUrl}`);
    
    let markdown = '';
    let lastError = '';
    let successfulStrategy: 'url_params' | 'firecrawl_actions' | 'zyte' = 'url_params';
    
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // Apply backoff delay
      if (BACKOFF_DELAYS[attempt - 1] > 0) {
        console.log(`[AGODA] Waiting ${BACKOFF_DELAYS[attempt - 1]}ms before attempt ${attempt}`);
        await new Promise(resolve => setTimeout(resolve, BACKOFF_DELAYS[attempt - 1]));
      }
      
      // Strategy selection: Firecrawl for attempt 1, Zyte for attempt 2
      const provider = attempt === 1 ? 'firecrawl' : 'zyte';
      const strategy = attempt === 1 ? 'url_params' : 'zyte_javascript';
      const waitFor = 4000; // Agoda may need more time
      
      console.log(`[AGODA] Attempt ${attempt}/${MAX_ATTEMPTS} with ${provider}`);
      
      let fetchResult: { markdown: string; error?: string };
      
      if (provider === 'firecrawl') {
        fetchResult = await fetchWithFirecrawl(fullUrl, waitFor);
      } else {
        fetchResult = await fetchWithZyte(fullUrl);
        successfulStrategy = 'zyte';
      }
      
      const attemptResult: AttemptResult = {
        attemptNumber: attempt,
        provider,
        strategy: strategy as 'url_params' | 'firecrawl_actions' | 'zyte_javascript',
        contentLength: fetchResult.markdown.length,
        contentHash: simpleHash(fetchResult.markdown),
        success: false,
        error: fetchResult.error,
      };
      
      // Check fetch errors
      if (fetchResult.error) {
        attemptResult.error = fetchResult.error;
        attempts.push(attemptResult);
        lastError = fetchResult.error;
        console.log(`[AGODA] Attempt ${attempt} fetch failed: ${fetchResult.error}`);
        continue;
      }
      
      // Check content size
      if (fetchResult.markdown.length < MINIMAL_CONTENT_THRESHOLD) {
        attemptResult.error = `Minimal content (${fetchResult.markdown.length} chars)`;
        attempts.push(attemptResult);
        lastError = attemptResult.error;
        console.log(`[AGODA] Attempt ${attempt}: ${attemptResult.error}`);
        continue;
      }
      
      // Check for bot blocking
      if (detectBotBlocking(fetchResult.markdown)) {
        attemptResult.error = 'Bot blocking detected';
        attempts.push(attemptResult);
        result.status = 'blocked_captcha_or_bot';
        result.error = 'Bot blocking detected';
        result.attempts = attempts;
        result.durationMs = Date.now() - startTime;
        console.log('[AGODA] Bot blocking detected');
        return result;
      }
      
      // Check for blocking flows (login/reserve/payment)
      const blockingFlows = detectBlockingFlows(fetchResult.markdown);
      if (blockingFlows.loginRequired || blockingFlows.reserveRequired || blockingFlows.paymentRequired) {
        const flowType = blockingFlows.loginRequired ? 'Login required' :
                        blockingFlows.reserveRequired ? 'Reserve/inquiry required' : 'Payment flow required';
        attemptResult.error = flowType;
        attempts.push(attemptResult);
        result.status = 'price_not_found';
        result.error = `Blocking flow detected: ${flowType}`;
        result.attempts = attempts;
        result.durationMs = Date.now() - startTime;
        console.log(`[AGODA] ${flowType}`);
        return result;
      }
      
      // Validate Phase A
      const phaseAResult = validatePhaseA(fetchResult.markdown);
      
      if (phaseAResult.soldOut) {
        attemptResult.error = 'Sold out';
        attemptResult.success = false;
        attempts.push(attemptResult);
        result.status = 'sold_out';
        result.error = 'Property sold out for these dates';
        result.phaseA.ran = true;
        result.phaseA.soldOut = true;
        result.phaseA.contentHash = attemptResult.contentHash;
        result.phaseA.contentLength = attemptResult.contentLength;
        result.attempts = attempts;
        result.durationMs = Date.now() - startTime;
        console.log('[AGODA] Sold out');
        return result;
      }
      
      if (phaseAResult.priceEligible) {
        // Success - we have prices visible
        markdown = fetchResult.markdown;
        attemptResult.success = true;
        attempts.push(attemptResult);
        result.strategyUsed = successfulStrategy;
        console.log(`[AGODA] Attempt ${attempt} succeeded: ${fetchResult.markdown.length} chars, ${phaseAResult.priceCount} prices`);
        break;
      } else {
        // Not price-eligible, may retry
        attemptResult.error = phaseAResult.enterDatesFound 
          ? 'Enter dates state - dates not applied' 
          : `No prices found (${phaseAResult.priceCount} matches)`;
        attempts.push(attemptResult);
        lastError = attemptResult.error;
        console.log(`[AGODA] Attempt ${attempt}: ${attemptResult.error}`);
      }
    }
    
    result.attempts = attempts;
    
    // If no successful attempt, return failure
    if (!markdown) {
      result.status = attempts.some(a => a.error?.includes('Enter dates')) ? 'dates_not_applied' : 'price_not_found';
      result.error = `All ${MAX_ATTEMPTS} attempts failed. Last error: ${lastError}`;
      result.durationMs = Date.now() - startTime;
      console.log(`[AGODA] All attempts exhausted`);
      return result;
    }
    
    // ============= PHASE A: Validate price-eligible state =============
    result.phaseA.ran = true;
    result.phaseA.contentLength = markdown.length;
    result.phaseA.contentHash = simpleHash(markdown);
    
    const phaseAResult = validatePhaseA(markdown);
    result.phaseA.priceEligible = phaseAResult.priceEligible;
    result.phaseA.enterDatesFound = phaseAResult.enterDatesFound;
    result.phaseA.soldOut = phaseAResult.soldOut;
    
    // ============= PHASE B: Extract price (only if Phase A passed) =============
    result.phaseB.ran = true;
    
    const phaseBResult = extractPrice(markdown);
    result.phaseB.extractedPrice = phaseBResult.extractedPrice;
    result.phaseB.currency = phaseBResult.currency;
    result.phaseB.includesTaxesFees = phaseBResult.includesTaxesFees;
    result.phaseB.priceVerified = phaseBResult.priceVerified;
    result.phaseB.evidenceSnippet = phaseBResult.evidenceSnippet;
    
    // HALLUCINATION GUARD: Price must be verified against content
    if (!phaseBResult.priceVerified) {
      result.status = 'price_not_found';
      result.error = 'Price extraction failed hallucination guard (not verbatim in content)';
      result.durationMs = Date.now() - startTime;
      console.log('[AGODA] Price failed hallucination guard');
      return result;
    }
    
    // SUCCESS
    result.success = true;
    result.status = 'success';
    result.durationMs = Date.now() - startTime;
    console.log(`[AGODA] Success: $${phaseBResult.extractedPrice} (verified)`);
    
    return result;
    
  } catch (error) {
    result.error = error instanceof Error ? error.message : 'Unknown error';
    result.status = 'validation_error';
    result.durationMs = Date.now() - startTime;
    result.attempts = attempts;
    console.error('[AGODA] Error:', error);
    return result;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json() as ExtractionRequest;
    const { url, extractionId, checkIn, checkOut, adults = 2 } = body;
    
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabaseClient = createClient(supabaseUrl, supabaseKey);
    
    let targetUrl = url;
    let dbExtractionId = extractionId;
    
    // If extractionId provided, fetch URL from DB
    if (extractionId && !url) {
      const { data: extraction, error } = await supabaseClient
        .from('price_extractions')
        .select('deep_link, platform_name')
        .eq('id', extractionId)
        .single();
      
      if (error || !extraction) {
        console.error('[AGODA] Extraction not found:', extractionId);
        return new Response(
          JSON.stringify({ success: false, error: 'Extraction not found' }),
          { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      
      // Verify platform is Agoda
      if (!extraction.platform_name.toLowerCase().includes('agoda')) {
        return new Response(
          JSON.stringify({ success: false, error: 'This function only handles Agoda extractions' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      
      targetUrl = extraction.deep_link;
    }
    
    if (!targetUrl) {
      return new Response(
        JSON.stringify({ success: false, error: 'URL or extractionId required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    if (!checkIn || !checkOut) {
      return new Response(
        JSON.stringify({ success: false, error: 'checkIn and checkOut dates required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    console.log(`[AGODA] Starting extraction for ${targetUrl}`);
    console.log(`[AGODA] Dates: ${checkIn} to ${checkOut}, Adults: ${adults}`);
    
    // Run extraction
    const result = await extractFromAgoda(targetUrl, checkIn, checkOut, adults);
    
    // Update DB if extractionId provided
    if (dbExtractionId) {
      await supabaseClient
        .from('price_extractions')
        .update({
          extraction_status: result.status,
          extracted_price: result.phaseB.extractedPrice,
          currency: result.phaseB.currency,
          includes_taxes_fees: result.phaseB.includesTaxesFees,
          extraction_error: result.error,
          page_content_hash: result.phaseA.contentHash,
          evidence_snippets: result.phaseB.evidenceSnippet ? [result.phaseB.evidenceSnippet] : null,
          dates_validated: result.phaseA.priceEligible && !result.phaseA.enterDatesFound,
          extraction_metadata: {
            goldenPath: true,
            platform: 'agoda',
            phaseA: result.phaseA,
            phaseB: result.phaseB,
            durationMs: result.durationMs,
            strategyUsed: result.strategyUsed,
            attempts: result.attempts,
          },
          updated_at: new Date().toISOString(),
        })
        .eq('id', dbExtractionId);
      
      console.log(`[AGODA] Updated extraction ${dbExtractionId} with status: ${result.status}`);
    }
    
    return new Response(
      JSON.stringify({
        success: result.success,
        result,
        goldenPath: true,
        promotionCandidate: true,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
    
  } catch (error) {
    console.error('[AGODA] Fatal error:', error);
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
