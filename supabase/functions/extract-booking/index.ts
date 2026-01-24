import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

/**
 * ============================================================================
 * BOOKING.COM ZYTE-FIRST GOLDEN PATH EXTRACTOR v1.0
 * ============================================================================
 * 
 * Booking.com requires browser automation due to aggressive bot detection.
 * Uses Zyte's browser actions to:
 * 1. Load property page with dates in URL params
 * 2. Wait for prices to render
 * 3. Extract "for N nights" total prices
 * 
 * URL PATTERN: booking.com URLs accept ?checkin=YYYY-MM-DD&checkout=YYYY-MM-DD
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Terminal status values
type TerminalStatus = 
  | 'success_total_stay'
  | 'success_partial'
  | 'dates_unavailable'
  | 'blocked_captcha_or_bot'
  | 'blocked_rate_limit'
  | 'quota_error'
  | 'page_not_reached'
  | 'price_not_found'
  | 'nightly_only_rejected'
  | 'render_failed'
  | 'validation_error'
  | 'timeout';

type FailureCategory = 
  | 'blocked'
  | 'captcha'
  | 'quota_error'
  | 'params_missing'
  | 'no_price_content'
  | 'no_total_label'
  | 'nightly_only'
  | 'unavailable'
  | 'render_error'
  | 'timeout'
  | 'success';

type Provider = 'zyte' | 'browserless';

interface ProviderAttemptTrace {
  provider: Provider;
  attempted: boolean;
  attemptIndex: number;
  startedAt: string | null;
  endedAt: string | null;
  outcome: string;
  httpStatus: number | null;
  contentLength: number | null;
  errorMessage: string | null;
  urlUsed: string | null;
}

interface StructuralProof {
  page_reached: boolean;
  dates_injected: boolean;
  dates_visible_on_page: boolean;
  total_label_found: boolean;
  nights_matched: boolean;
  price_verified_in_content: boolean;
  directly_comparable: boolean;
  proof_version: string;
  currency_detected: string | null;
  nights_detected: number | null;
  entry_url_used: string | null;
  final_url: string | null;
  content_hash: string | null;
  failure_category: FailureCategory;
  extraction_method: string | null;
  all_prices_found: string[];
}

interface ExtractionRequest {
  extractionId?: string;
  url?: string;
  checkIn: string;
  checkOut: string;
  adults?: number;
}

interface ExtractionResult {
  success: boolean;
  status: TerminalStatus;
  extractedPrice: number | null;
  currency: string | null;
  includesTaxesFees: boolean | null;
  evidenceSnippet: string | null;
  structuralProof: StructuralProof;
  providerUsed: Provider | null;
  providerAttemptTrace: ProviderAttemptTrace[];
  durationMs: number;
  error: string | null;
}

// Utility functions
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

function calculateNights(checkIn: string, checkOut: string): number {
  const start = new Date(checkIn);
  const end = new Date(checkOut);
  return Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
}

function buildBookingUrl(baseUrl: string, checkIn: string, checkOut: string, adults: number = 2): string {
  const url = new URL(baseUrl);
  url.searchParams.set('checkin', checkIn);
  url.searchParams.set('checkout', checkOut);
  url.searchParams.set('group_adults', String(adults));
  url.searchParams.set('no_rooms', '1');
  url.searchParams.set('selected_currency', 'USD');
  return url.toString();
}

function detectBotBlock(content: string): boolean {
  const lowerContent = content.toLowerCase();
  const indicators = [
    'captcha',
    'unusual traffic',
    'access denied',
    'please verify',
    'are you a robot',
  ];
  return indicators.some(i => lowerContent.includes(i));
}

function detectVerifyingPage(content: string): boolean {
  const lowerContent = content.toLowerCase();
  return lowerContent.includes('verifying') && 
         (lowerContent.includes('booking.com') || lowerContent.includes('signing in'));
}

// ============================================================================
// BOOKING.COM PRICE EXTRACTION
// ============================================================================

interface BookingPriceResult {
  totalFound: boolean;
  totalPrice: number | null;
  currency: string | null;
  totalEvidence: string | null;
  directlyComparable: boolean;
  allPrices: Array<{ amount: number; context: string }>;
  nightsMatched: boolean;
}

function extractBookingTotal(content: string, nights: number): BookingPriceResult {
  const result: BookingPriceResult = {
    totalFound: false,
    totalPrice: null,
    currency: null,
    totalEvidence: null,
    directlyComparable: false,
    allPrices: [],
    nightsMatched: false,
  };

  // Booking.com pattern: "$XXX for N nights" or "US$XXX for N nights"
  const patterns = [
    // Exact nights match - priority
    new RegExp(`(?:US\\$|\\$|USD\\s*)([\\d,]+(?:\\.\\d{2})?)\\s*(?:for|\\/)\\s*${nights}\\s*nights?`, 'gi'),
    // Amount followed by nights
    new RegExp(`([\\d,]+(?:\\.\\d{2})?)\\s*(?:US\\$|USD|\\$)\\s*(?:for|\\/)\\s*${nights}\\s*nights?`, 'gi'),
    // Generic "for X nights" pattern
    /(?:US\$|\$|USD\s*)([\d,]+(?:\.\d{2})?)\s*(?:for|\/)\s*(\d+)\s*nights?/gi,
  ];

  const foundPrices: Array<{ amount: number; context: string; nightsMatch: boolean }> = [];
  const seen = new Set<number>();

  // First pass: look for exact nights match
  for (let i = 0; i < 2; i++) {
    const pattern = patterns[i];
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const amountStr = match[1].replace(/,/g, '');
      const amount = parseFloat(amountStr);
      
      if (amount > 50 && !seen.has(amount)) {
        seen.add(amount);
        const start = Math.max(0, match.index - 40);
        const end = Math.min(content.length, match.index + match[0].length + 40);
        const context = content.slice(start, end).replace(/\n/g, ' ').trim();
        foundPrices.push({ amount, context, nightsMatch: true });
      }
    }
  }

  // Second pass: any nights pattern
  const genericPattern = patterns[2];
  let match;
  while ((match = genericPattern.exec(content)) !== null) {
    const amountStr = match[1].replace(/,/g, '');
    const amount = parseFloat(amountStr);
    const matchedNights = parseInt(match[2]);
    
    if (amount > 50 && !seen.has(amount)) {
      seen.add(amount);
      const start = Math.max(0, match.index - 40);
      const end = Math.min(content.length, match.index + match[0].length + 40);
      const context = content.slice(start, end).replace(/\n/g, ' ').trim();
      foundPrices.push({ amount, context, nightsMatch: matchedNights === nights });
    }
  }

  // Sort: prioritize exact nights match, then by lowest price
  foundPrices.sort((a, b) => {
    if (a.nightsMatch && !b.nightsMatch) return -1;
    if (!a.nightsMatch && b.nightsMatch) return 1;
    return a.amount - b.amount;
  });

  result.allPrices = foundPrices.map(p => ({ amount: p.amount, context: p.context }));

  console.log(`[BOOKING] Found ${foundPrices.length} prices: ${foundPrices.map(p => `$${p.amount}${p.nightsMatch ? '*' : ''}`).join(', ')}`);

  if (foundPrices.length > 0) {
    const best = foundPrices[0];
    result.totalFound = true;
    result.totalPrice = best.amount;
    result.currency = 'USD';
    result.totalEvidence = best.context.slice(0, 150);
    result.directlyComparable = best.nightsMatch;
    result.nightsMatched = best.nightsMatch;

    console.log(`[BOOKING] ACCEPTED total=$${best.amount} nightsMatch=${best.nightsMatch}`);
  }

  return result;
}

// ============================================================================
// ZYTE EXTRACTION WITH BROWSER AUTOMATION
// ============================================================================

async function extractWithZyte(url: string, nights: number): Promise<{
  success: boolean;
  pageReached: boolean;
  content: string;
  httpStatus: number | null;
  error: string | null;
  durationMs: number;
}> {
  const start = Date.now();
  const result = {
    success: false,
    pageReached: false,
    content: '',
    httpStatus: null as number | null,
    error: null as string | null,
    durationMs: 0,
  };

  try {
    const apiKey = Deno.env.get('ZYTE_API_KEY');
    if (!apiKey) {
      result.error = 'ZYTE_API_KEY not configured';
      result.durationMs = Date.now() - start;
      return result;
    }

    const zyteAuth = btoa(apiKey + ':');

    console.log(`[BOOKING] Zyte request: ${url}`);

    const response = await fetch('https://api.zyte.com/v1/extract', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${zyteAuth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url,
        browserHtml: true,
        javascript: true,
        // Use geolocation to appear as a real user
        geolocation: 'US',
        // Session context for better anti-detection
        sessionContext: [
          { name: 'accept_cookies', value: 'true' }
        ],
        sessionContextParameters: {
          actions: [
            // Accept cookies if cookie banner appears
            {
              action: 'click',
              selector: { type: 'css', value: '#onetrust-accept-btn-handler, [data-testid="accept-btn"], button[id*="accept"]' },
               // Zyte expects onError to be a supported enum (e.g. "continue").
               onError: 'continue'
            }
          ]
        },
        actions: [
          // Wait for page to load
          { action: 'waitForTimeout', timeout: 6 },
        ],
      }),
    });

    result.httpStatus = response.status;

    if (!response.ok) {
      const errText = await response.text();
      if (response.status === 429) {
        result.error = 'Rate limited (HTTP 429)';
      } else if (response.status === 402) {
        result.error = 'Quota exceeded (HTTP 402)';
      } else {
        result.error = `Zyte HTTP ${response.status}: ${errText.slice(0, 200)}`;
      }
      result.durationMs = Date.now() - start;
      return result;
    }

    const data = await response.json();
    const html = data.browserHtml || '';
    
    // Convert HTML to text
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    console.log(`[BOOKING] Zyte returned ${text.length} chars`);

    result.content = text;
    result.pageReached = text.length > 5000;
    result.success = result.pageReached;
    result.durationMs = Date.now() - start;

    return result;

  } catch (error) {
    result.error = error instanceof Error ? error.message : 'Unknown error';
    result.durationMs = Date.now() - start;
    return result;
  }
}

// ============================================================================
// BROWSERLESS FALLBACK
// ============================================================================

async function extractWithBrowserless(url: string): Promise<{
  success: boolean;
  pageReached: boolean;
  content: string;
  httpStatus: number | null;
  error: string | null;
  durationMs: number;
}> {
  const start = Date.now();
  const result = {
    success: false,
    pageReached: false,
    content: '',
    httpStatus: null as number | null,
    error: null as string | null,
    durationMs: 0,
  };

  try {
    const apiKey = Deno.env.get('BROWSERLESS_API_KEY');
    if (!apiKey) {
      result.error = 'BROWSERLESS_API_KEY not configured';
      result.durationMs = Date.now() - start;
      return result;
    }

    console.log(`[BOOKING] Browserless request: ${url}`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    const response = await fetch(`https://chrome.browserless.io/content?token=${apiKey}&stealth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        gotoOptions: { 
          waitUntil: 'networkidle0', 
          timeout: 45000 
        },
        waitForSelector: {
          selector: 'body',
          timeout: 20000
        },
        waitForTimeout: 5000,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    result.httpStatus = response.status;

    if (!response.ok) {
      const errText = await response.text();
      result.error = `Browserless HTTP ${response.status}: ${errText.slice(0, 200)}`;
      result.durationMs = Date.now() - start;
      return result;
    }

    const html = await response.text();
    
    // Convert HTML to text
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    console.log(`[BOOKING] Browserless returned ${text.length} chars`);

    result.content = text;
    result.pageReached = text.length > 5000;
    result.success = result.pageReached;
    result.durationMs = Date.now() - start;

    return result;

  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    if (msg.includes('abort')) {
      result.error = 'Browserless timeout';
    } else {
      result.error = `Browserless error: ${msg}`;
    }
    result.durationMs = Date.now() - start;
    return result;
  }
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();
  const providerAttemptTrace: ProviderAttemptTrace[] = [];

  // Initialize result
  const result: ExtractionResult = {
    success: false,
    status: 'render_failed',
    extractedPrice: null,
    currency: null,
    includesTaxesFees: null,
    evidenceSnippet: null,
    structuralProof: {
      page_reached: false,
      dates_injected: false,
      dates_visible_on_page: false,
      total_label_found: false,
      nights_matched: false,
      price_verified_in_content: false,
      directly_comparable: false,
      proof_version: '1.0-booking',
      currency_detected: null,
      nights_detected: null,
      entry_url_used: null,
      final_url: null,
      content_hash: null,
      failure_category: 'render_error',
      extraction_method: null,
      all_prices_found: [],
    },
    providerUsed: null,
    providerAttemptTrace: [],
    durationMs: 0,
    error: null,
  };

  try {
    const body: ExtractionRequest = await req.json();
    const { extractionId, url, checkIn, checkOut, adults = 2 } = body;

    if (!checkIn || !checkOut) {
      result.status = 'validation_error';
      result.error = 'checkIn and checkOut are required';
      result.durationMs = Date.now() - startTime;
      return new Response(JSON.stringify(result), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const nights = calculateNights(checkIn, checkOut);
    result.structuralProof.nights_detected = nights;

    // Get URL from DB or request
    let targetUrl = url;
    let supabase: any = null;

    if (extractionId) {
      const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
      const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
      supabase = createClient(supabaseUrl, supabaseKey);

      const { data: extraction } = await supabase
        .from('price_extractions')
        .select('deep_link')
        .eq('id', extractionId)
        .single();

      if (extraction?.deep_link) {
        targetUrl = extraction.deep_link;
      }
    }

    if (!targetUrl) {
      result.status = 'validation_error';
      result.error = 'No URL provided';
      result.durationMs = Date.now() - startTime;
      return new Response(JSON.stringify(result), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Build URL with dates
    const datedUrl = buildBookingUrl(targetUrl, checkIn, checkOut, adults);
    result.structuralProof.entry_url_used = datedUrl;
    result.structuralProof.dates_injected = true;

    console.log(`[BOOKING] Target: ${datedUrl}`);
    console.log(`[BOOKING] Dates: ${checkIn} to ${checkOut} (${nights} nights)`);

    // Try Zyte first
    const zyteTrace: ProviderAttemptTrace = {
      provider: 'zyte',
      attempted: true,
      attemptIndex: 0,
      startedAt: new Date().toISOString(),
      endedAt: null,
      outcome: 'pending',
      httpStatus: null,
      contentLength: null,
      errorMessage: null,
      urlUsed: datedUrl,
    };

    const zyteResult = await extractWithZyte(datedUrl, nights);
    zyteTrace.endedAt = new Date().toISOString();
    zyteTrace.httpStatus = zyteResult.httpStatus;
    zyteTrace.contentLength = zyteResult.content.length;

    let content = zyteResult.content;
    let providerUsed: Provider = 'zyte';

    if (zyteResult.success && zyteResult.content.length > 5000) {
      zyteTrace.outcome = 'success';
      result.structuralProof.page_reached = true;
    } else {
      zyteTrace.outcome = zyteResult.error || 'insufficient_content';
      zyteTrace.errorMessage = zyteResult.error;
      
      // Try Browserless as fallback
      console.log(`[BOOKING] Zyte failed, trying Browserless...`);
      
      const browserlessTrace: ProviderAttemptTrace = {
        provider: 'browserless',
        attempted: true,
        attemptIndex: 1,
        startedAt: new Date().toISOString(),
        endedAt: null,
        outcome: 'pending',
        httpStatus: null,
        contentLength: null,
        errorMessage: null,
        urlUsed: datedUrl,
      };

      const browserlessResult = await extractWithBrowserless(datedUrl);
      browserlessTrace.endedAt = new Date().toISOString();
      browserlessTrace.httpStatus = browserlessResult.httpStatus;
      browserlessTrace.contentLength = browserlessResult.content.length;

      if (browserlessResult.success && browserlessResult.content.length > 5000) {
        browserlessTrace.outcome = 'success';
        content = browserlessResult.content;
        providerUsed = 'browserless';
        result.structuralProof.page_reached = true;
      } else {
        browserlessTrace.outcome = browserlessResult.error || 'insufficient_content';
        browserlessTrace.errorMessage = browserlessResult.error;
      }

      providerAttemptTrace.push(browserlessTrace);
    }

    providerAttemptTrace.push(zyteTrace);
    result.providerUsed = providerUsed;
    result.providerAttemptTrace = providerAttemptTrace;

    // Check for blocking
    if (detectVerifyingPage(content)) {
      result.status = 'blocked_captcha_or_bot';
      result.error = 'Booking.com verification page detected';
      result.structuralProof.failure_category = 'captcha';
      result.durationMs = Date.now() - startTime;
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (detectBotBlock(content)) {
      result.status = 'blocked_captcha_or_bot';
      result.error = 'Bot detection triggered';
      result.structuralProof.failure_category = 'blocked';
      result.durationMs = Date.now() - startTime;
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (content.length < 5000) {
      result.status = 'page_not_reached';
      result.error = `Insufficient content: ${content.length} chars`;
      result.structuralProof.failure_category = 'render_error';
      result.durationMs = Date.now() - startTime;
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    result.structuralProof.content_hash = simpleHash(content);

    // Extract prices
    const priceResult = extractBookingTotal(content, nights);
    result.structuralProof.all_prices_found = priceResult.allPrices.map(p => `$${p.amount}`);

    if (priceResult.totalFound && priceResult.totalPrice) {
      result.success = true;
      result.status = 'success_total_stay';
      result.extractedPrice = priceResult.totalPrice;
      result.currency = priceResult.currency;
      result.includesTaxesFees = true; // Booking.com "for N nights" includes taxes
      result.evidenceSnippet = priceResult.totalEvidence;
      
      result.structuralProof.total_label_found = true;
      result.structuralProof.nights_matched = priceResult.nightsMatched;
      result.structuralProof.price_verified_in_content = true;
      result.structuralProof.directly_comparable = priceResult.directlyComparable;
      result.structuralProof.currency_detected = priceResult.currency;
      result.structuralProof.extraction_method = 'regex_for_n_nights';
      result.structuralProof.failure_category = 'success';
    } else {
      result.status = 'price_not_found';
      result.error = 'No total price found for requested nights';
      result.structuralProof.failure_category = 'no_total_label';
    }

    result.durationMs = Date.now() - startTime;

    // Update DB if extractionId provided
    if (extractionId && supabase) {
      const updateData: any = {
        extraction_status: result.status,
        extracted_price: result.extractedPrice,
        currency: result.currency,
        includes_taxes_fees: result.includesTaxesFees,
        provider_used: result.providerUsed,
        evidence_snippets: result.evidenceSnippet ? [result.evidenceSnippet] : null,
        extraction_metadata: {
          structuralProof: result.structuralProof,
          providerAttemptTrace: result.providerAttemptTrace,
          durationMs: result.durationMs,
        },
        extraction_error: result.error,
        updated_at: new Date().toISOString(),
      };

      await supabase
        .from('price_extractions')
        .update(updateData)
        .eq('id', extractionId);
    }

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    result.error = error instanceof Error ? error.message : 'Unknown error';
    result.durationMs = Date.now() - startTime;
    return new Response(JSON.stringify(result), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
