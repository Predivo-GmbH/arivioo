import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

/**
 * ============================================================================
 * BOOKING.COM FIRECRAWL-FIRST GOLDEN PATH EXTRACTOR v2.0
 * ============================================================================
 * 
 * Based on successful Jan 10 extraction that used Firecrawl to extract
 * "$1,012 for 3 nights" from booking.com/hotel/us/tahquitz-rock-lodge.html
 * 
 * Strategy: Firecrawl (primary) → Zyte (fallback) → Browserless (last resort)
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

type TerminalStatus = 
  | 'success_total_stay'
  | 'success_partial'
  | 'dates_unavailable'
  | 'blocked_captcha_or_bot'
  | 'blocked_rate_limit'
  | 'quota_error'
  | 'page_not_reached'
  | 'price_not_found'
  | 'render_failed'
  | 'validation_error'
  | 'timeout';

type Provider = 'firecrawl' | 'zyte' | 'browserless';

interface ProviderAttemptTrace {
  provider: Provider;
  attempted: boolean;
  startedAt: string | null;
  endedAt: string | null;
  outcome: string;
  httpStatus: number | null;
  contentLength: number | null;
  errorMessage: string | null;
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
  providerUsed: Provider | null;
  providerAttemptTrace: ProviderAttemptTrace[];
  allPricesFound: string[];
  nightsMatched: boolean;
  durationMs: number;
  error: string | null;
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
  // Only flag actual bot blocks, not normal "sign in" text
  return (
    lowerContent.includes('captcha') ||
    lowerContent.includes('unusual traffic') ||
    lowerContent.includes('access denied') ||
    lowerContent.includes('please verify you are human') ||
    (lowerContent.includes('verifying') && lowerContent.includes('please wait'))
  );
}

// ============================================================================
// BOOKING.COM PRICE EXTRACTION - Based on successful Jan 10 pattern
// ============================================================================

interface BookingPriceResult {
  totalFound: boolean;
  totalPrice: number | null;
  currency: string | null;
  totalEvidence: string | null;
  allPrices: Array<{ amount: number; context: string }>;
  nightsMatched: boolean;
}

function extractBookingTotal(content: string, nights: number): BookingPriceResult {
  const result: BookingPriceResult = {
    totalFound: false,
    totalPrice: null,
    currency: null,
    totalEvidence: null,
    allPrices: [],
    nightsMatched: false,
  };

  // Pattern from successful extraction: "$1,012 for 3 nights"
  const patterns = [
    // Exact nights match - highest priority
    new RegExp(`(?:US\\$|\\$|USD\\s*)([\\d,]+(?:\\.\\d{2})?)\\s*(?:for|\\/)\\s*${nights}\\s*nights?`, 'gi'),
    new RegExp(`([\\d,]+(?:\\.\\d{2})?)\\s*(?:US\\$|USD|\\$)\\s*(?:for|\\/)\\s*${nights}\\s*nights?`, 'gi'),
    // Generic "for X nights" pattern
    /(?:US\$|\$|USD\s*)([\d,]+(?:\.\d{2})?)\s*(?:for|\/)\s*(\d+)\s*nights?/gi,
    // "Total" patterns
    /(?:total|price)[:\s]*(?:US\$|\$|USD\s*)([\d,]+(?:\.\d{2})?)/gi,
  ];

  const foundPrices: Array<{ amount: number; context: string; nightsMatch: boolean; priority: number }> = [];
  const seen = new Set<number>();

  // Pass 1: Exact nights match
  for (let i = 0; i < 2; i++) {
    let match;
    while ((match = patterns[i].exec(content)) !== null) {
      const amountStr = match[1].replace(/,/g, '');
      const amount = parseFloat(amountStr);
      
      if (amount > 50 && !seen.has(amount)) {
        seen.add(amount);
        const start = Math.max(0, match.index - 50);
        const end = Math.min(content.length, match.index + match[0].length + 50);
        const context = content.slice(start, end).replace(/\n/g, ' ').trim();
        foundPrices.push({ amount, context, nightsMatch: true, priority: 1 });
      }
    }
  }

  // Pass 2: Generic nights pattern
  let match;
  while ((match = patterns[2].exec(content)) !== null) {
    const amountStr = match[1].replace(/,/g, '');
    const amount = parseFloat(amountStr);
    const matchedNights = parseInt(match[2]);
    
    if (amount > 50 && !seen.has(amount)) {
      seen.add(amount);
      const start = Math.max(0, match.index - 50);
      const end = Math.min(content.length, match.index + match[0].length + 50);
      const context = content.slice(start, end).replace(/\n/g, ' ').trim();
      foundPrices.push({ 
        amount, 
        context, 
        nightsMatch: matchedNights === nights,
        priority: matchedNights === nights ? 1 : 2
      });
    }
  }

  // Pass 3: Total patterns
  while ((match = patterns[3].exec(content)) !== null) {
    const amountStr = match[1].replace(/,/g, '');
    const amount = parseFloat(amountStr);
    
    if (amount > 50 && !seen.has(amount)) {
      seen.add(amount);
      const start = Math.max(0, match.index - 50);
      const end = Math.min(content.length, match.index + match[0].length + 50);
      const context = content.slice(start, end).replace(/\n/g, ' ').trim();
      foundPrices.push({ amount, context, nightsMatch: false, priority: 3 });
    }
  }

  // Sort: prioritize exact nights match, then by lowest price
  foundPrices.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.amount - b.amount;
  });

  result.allPrices = foundPrices.map(p => ({ amount: p.amount, context: p.context }));

  console.log(`[BOOKING] Found ${foundPrices.length} prices: ${foundPrices.map(p => `$${p.amount}${p.nightsMatch ? '*' : ''}`).join(', ')}`);

  if (foundPrices.length > 0) {
    const best = foundPrices[0];
    result.totalFound = true;
    result.totalPrice = best.amount;
    result.currency = 'USD';
    result.totalEvidence = best.context.slice(0, 200);
    result.nightsMatched = best.nightsMatch;

    console.log(`[BOOKING] ACCEPTED: $${best.amount}, nights_matched=${best.nightsMatch}`);
  }

  return result;
}

// ============================================================================
// FIRECRAWL EXTRACTION (PRIMARY - from successful Jan 10 run)
// ============================================================================

async function extractWithFirecrawl(url: string): Promise<{
  success: boolean;
  content: string;
  httpStatus: number | null;
  error: string | null;
  durationMs: number;
}> {
  const start = Date.now();
  const result = {
    success: false,
    content: '',
    httpStatus: null as number | null,
    error: null as string | null,
    durationMs: 0,
  };

  try {
    const apiKey = Deno.env.get('FIRECRAWL_API_KEY');
    if (!apiKey) {
      result.error = 'FIRECRAWL_API_KEY not configured';
      result.durationMs = Date.now() - start;
      return result;
    }

    console.log(`[BOOKING] Firecrawl request: ${url}`);

    const response = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url,
        formats: ['markdown'],
        waitFor: 8000,
        timeout: 45000,
        onlyMainContent: false,
        // Use US location like successful run
        location: { country: 'US' },
      }),
    });

    result.httpStatus = response.status;

    if (!response.ok) {
      const errText = await response.text();
      result.error = `Firecrawl HTTP ${response.status}: ${errText.slice(0, 200)}`;
      result.durationMs = Date.now() - start;
      return result;
    }

    const data = await response.json();
    const markdown = data.data?.markdown || data.markdown || '';
    
    console.log(`[BOOKING] Firecrawl returned ${markdown.length} chars`);

    result.content = markdown;
    result.success = markdown.length > 3000;
    result.durationMs = Date.now() - start;

    return result;

  } catch (error) {
    result.error = error instanceof Error ? error.message : 'Unknown error';
    result.durationMs = Date.now() - start;
    return result;
  }
}

// ============================================================================
// ZYTE FALLBACK
// ============================================================================

async function extractWithZyte(url: string): Promise<{
  success: boolean;
  content: string;
  httpStatus: number | null;
  error: string | null;
  durationMs: number;
}> {
  const start = Date.now();
  const result = {
    success: false,
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

    console.log(`[BOOKING] Zyte request: ${url}`);

    const response = await fetch('https://api.zyte.com/v1/extract', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${btoa(apiKey + ':')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url,
        browserHtml: true,
        javascript: true,
        geolocation: 'US',
        actions: [
          { action: 'waitForTimeout', timeout: 8 },
        ],
      }),
    });

    result.httpStatus = response.status;

    if (!response.ok) {
      const errText = await response.text();
      result.error = `Zyte HTTP ${response.status}: ${errText.slice(0, 200)}`;
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
    result.success = text.length > 5000;
    result.durationMs = Date.now() - start;

    return result;

  } catch (error) {
    result.error = error instanceof Error ? error.message : 'Unknown error';
    result.durationMs = Date.now() - start;
    return result;
  }
}

// ============================================================================
// BROWSERLESS LAST RESORT
// ============================================================================

async function extractWithBrowserless(url: string): Promise<{
  success: boolean;
  content: string;
  httpStatus: number | null;
  error: string | null;
  durationMs: number;
}> {
  const start = Date.now();
  const result = {
    success: false,
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
        gotoOptions: { waitUntil: 'networkidle0', timeout: 45000 },
        waitForTimeout: 8000,
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
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    console.log(`[BOOKING] Browserless returned ${text.length} chars`);

    result.content = text;
    result.success = text.length > 5000;
    result.durationMs = Date.now() - start;

    return result;

  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    result.error = msg.includes('abort') ? 'Browserless timeout' : `Browserless error: ${msg}`;
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

  const result: ExtractionResult = {
    success: false,
    status: 'render_failed',
    extractedPrice: null,
    currency: null,
    includesTaxesFees: null,
    evidenceSnippet: null,
    providerUsed: null,
    providerAttemptTrace: [],
    allPricesFound: [],
    nightsMatched: false,
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
    console.log(`[BOOKING] Target: ${datedUrl}`);
    console.log(`[BOOKING] Dates: ${checkIn} to ${checkOut} (${nights} nights)`);

    let content = '';
    let providerUsed: Provider | null = null;

    // ========================================
    // TRY 1: FIRECRAWL (Primary - worked Jan 10)
    // ========================================
    const firecrawlTrace: ProviderAttemptTrace = {
      provider: 'firecrawl',
      attempted: true,
      startedAt: new Date().toISOString(),
      endedAt: null,
      outcome: 'pending',
      httpStatus: null,
      contentLength: null,
      errorMessage: null,
    };

    const firecrawlResult = await extractWithFirecrawl(datedUrl);
    firecrawlTrace.endedAt = new Date().toISOString();
    firecrawlTrace.httpStatus = firecrawlResult.httpStatus;
    firecrawlTrace.contentLength = firecrawlResult.content.length;

    if (firecrawlResult.success && firecrawlResult.content.length > 3000 && !detectBotBlock(firecrawlResult.content)) {
      firecrawlTrace.outcome = 'success';
      content = firecrawlResult.content;
      providerUsed = 'firecrawl';
      console.log(`[BOOKING] Firecrawl succeeded with ${content.length} chars`);
    } else {
      firecrawlTrace.outcome = firecrawlResult.error || 'insufficient_content';
      firecrawlTrace.errorMessage = firecrawlResult.error;
      console.log(`[BOOKING] Firecrawl failed: ${firecrawlResult.error || 'insufficient content'}`);
    }
    providerAttemptTrace.push(firecrawlTrace);

    // ========================================
    // TRY 2: ZYTE (Fallback)
    // ========================================
    if (!providerUsed) {
      console.log(`[BOOKING] Trying Zyte fallback...`);
      
      const zyteTrace: ProviderAttemptTrace = {
        provider: 'zyte',
        attempted: true,
        startedAt: new Date().toISOString(),
        endedAt: null,
        outcome: 'pending',
        httpStatus: null,
        contentLength: null,
        errorMessage: null,
      };

      const zyteResult = await extractWithZyte(datedUrl);
      zyteTrace.endedAt = new Date().toISOString();
      zyteTrace.httpStatus = zyteResult.httpStatus;
      zyteTrace.contentLength = zyteResult.content.length;

      if (zyteResult.success && zyteResult.content.length > 5000 && !detectBotBlock(zyteResult.content)) {
        zyteTrace.outcome = 'success';
        content = zyteResult.content;
        providerUsed = 'zyte';
        console.log(`[BOOKING] Zyte succeeded with ${content.length} chars`);
      } else {
        zyteTrace.outcome = zyteResult.error || 'insufficient_content';
        zyteTrace.errorMessage = zyteResult.error;
        console.log(`[BOOKING] Zyte failed: ${zyteResult.error || 'insufficient content'}`);
      }
      providerAttemptTrace.push(zyteTrace);
    }

    // ========================================
    // TRY 3: BROWSERLESS (Last resort)
    // ========================================
    if (!providerUsed) {
      console.log(`[BOOKING] Trying Browserless fallback...`);
      
      const browserlessTrace: ProviderAttemptTrace = {
        provider: 'browserless',
        attempted: true,
        startedAt: new Date().toISOString(),
        endedAt: null,
        outcome: 'pending',
        httpStatus: null,
        contentLength: null,
        errorMessage: null,
      };

      const browserlessResult = await extractWithBrowserless(datedUrl);
      browserlessTrace.endedAt = new Date().toISOString();
      browserlessTrace.httpStatus = browserlessResult.httpStatus;
      browserlessTrace.contentLength = browserlessResult.content.length;

      if (browserlessResult.success && browserlessResult.content.length > 5000 && !detectBotBlock(browserlessResult.content)) {
        browserlessTrace.outcome = 'success';
        content = browserlessResult.content;
        providerUsed = 'browserless';
        console.log(`[BOOKING] Browserless succeeded with ${content.length} chars`);
      } else {
        browserlessTrace.outcome = browserlessResult.error || 'insufficient_content';
        browserlessTrace.errorMessage = browserlessResult.error;
        console.log(`[BOOKING] Browserless failed: ${browserlessResult.error || 'insufficient content'}`);
      }
      providerAttemptTrace.push(browserlessTrace);
    }

    result.providerUsed = providerUsed;
    result.providerAttemptTrace = providerAttemptTrace;

    // Check for blocking
    if (content.length > 0 && detectBotBlock(content)) {
      result.status = 'blocked_captcha_or_bot';
      result.error = 'Bot detection triggered';
      result.durationMs = Date.now() - startTime;
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (content.length < 3000) {
      result.status = 'page_not_reached';
      result.error = `Insufficient content from all providers`;
      result.durationMs = Date.now() - startTime;
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Extract prices
    const priceResult = extractBookingTotal(content, nights);
    result.allPricesFound = priceResult.allPrices.map(p => `$${p.amount}`);
    result.nightsMatched = priceResult.nightsMatched;

    if (priceResult.totalFound && priceResult.totalPrice) {
      result.success = true;
      result.status = 'success_total_stay';
      result.extractedPrice = priceResult.totalPrice;
      result.currency = priceResult.currency;
      result.includesTaxesFees = true;
      result.evidenceSnippet = priceResult.totalEvidence;
      
      console.log(`[BOOKING] SUCCESS: $${priceResult.totalPrice} via ${providerUsed}`);
    } else {
      result.status = 'price_not_found';
      result.error = `No total price found for ${nights} nights`;
    }

    result.durationMs = Date.now() - startTime;

    // Update DB if extractionId provided
    if (extractionId && supabase && result.success) {
      await supabase
        .from('price_extractions')
        .update({
          extraction_status: result.status,
          extracted_price: result.extractedPrice,
          currency: result.currency,
          includes_taxes_fees: result.includesTaxesFees,
          provider_used: result.providerUsed,
          evidence_snippets: result.evidenceSnippet ? [result.evidenceSnippet] : null,
          extraction_metadata: {
            providerAttemptTrace: result.providerAttemptTrace,
            allPricesFound: result.allPricesFound,
            nightsMatched: result.nightsMatched,
            durationMs: result.durationMs,
          },
          extraction_error: result.error,
          price_type: 'TOTAL_STAY',
          updated_at: new Date().toISOString(),
        })
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
