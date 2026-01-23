import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

/**
 * ============================================================================
 * VRBO ZYTE-FIRST GOLDEN PATH EXTRACTOR v1.0
 * ============================================================================
 * 
 * GOLDEN PATH: Zyte-first extraction for VRBO
 * 
 * Based on VRBO_LIVE_ACCESS_CHECK diagnostic results:
 * - Zyte: accessible, booking DOM = true (1.5MB content)
 * - Browserless: blocked by captcha
 * - Firecrawl: failed due to quota/credits
 * 
 * FLOW:
 * 1. Build VRBO URL with date/occupancy params
 * 2. Fetch via Zyte (primary) - NO Browserless fallback (captcha blocked)
 * 3. Extract TOTAL stay price from booking DOM
 * 4. Currency detection and USD conversion
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
  | 'total_price_not_found'
  | 'nightly_only_rejected'
  | 'render_failed'
  | 'validation_error'
  | 'timeout';

type FailureCategory = 
  | 'blocked'
  | 'captcha'
  | 'quota_error'
  | 'params_missing'
  | 'selector_not_found'
  | 'no_price'
  | 'nightly_only'
  | 'unavailable'
  | 'render_error'
  | 'timeout'
  | 'success';

type Provider = 'zyte' | 'browserless' | 'firecrawl';

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
  total_price_label_found: boolean;
  nightly_rate_only: boolean;
  cleaning_fee_found: boolean;
  service_fee_found: boolean;
  taxes_visible: boolean;
  directly_comparable: boolean;
  proof_version: string;
  currency_detected: string | null;
  nights_detected: number | null;
  entry_url_used: string | null;
  content_hash: string | null;
  failure_category: FailureCategory;
  extraction_method: string | null;
}

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
  failureCategory: FailureCategory;
  extractedPrice: number | null;
  currency: string | null;
  originalAmount: number | null;
  originalCurrency: string | null;
  conversionRate: number | null;
  includesTaxesFees: boolean | null;
  directlyComparable: boolean;
  evidenceSnippet: string | null;
  structuralProof: StructuralProof;
  durationMs: number;
  error: string | null;
  providerAttempts: ProviderAttemptTrace[];
  goldenPath: boolean;
}

// ============================================================================
// CURRENCY HANDLING
// ============================================================================

interface CurrencyInfo {
  code: string;
  symbol: string;
  rate_to_usd: number;
}

const FX_RATES: Record<string, CurrencyInfo> = {
  'USD': { code: 'USD', symbol: '$', rate_to_usd: 1.0 },
  'EUR': { code: 'EUR', symbol: '€', rate_to_usd: 1.08 },
  'GBP': { code: 'GBP', symbol: '£', rate_to_usd: 1.27 },
  'JPY': { code: 'JPY', symbol: '¥', rate_to_usd: 0.0067 },
  'CAD': { code: 'CAD', symbol: 'CA$', rate_to_usd: 0.74 },
  'AUD': { code: 'AUD', symbol: 'A$', rate_to_usd: 0.66 },
  'MXN': { code: 'MXN', symbol: 'MX$', rate_to_usd: 0.059 },
};

function detectCurrency(priceText: string): { code: string; amount: number } | null {
  const patterns: Array<{ pattern: RegExp; code: string }> = [
    { pattern: /USD\s*\$?([\d,]+(?:\.\d{2})?)/i, code: 'USD' },
    { pattern: /\$?([\d,]+(?:\.\d{2})?)\s*USD/i, code: 'USD' },
    { pattern: /€\s*([\d,]+(?:\.\d{2})?)/i, code: 'EUR' },
    { pattern: /£\s*([\d,]+(?:\.\d{2})?)/i, code: 'GBP' },
    { pattern: /CA\$\s*([\d,]+(?:\.\d{2})?)/i, code: 'CAD' },
    { pattern: /A\$\s*([\d,]+(?:\.\d{2})?)/i, code: 'AUD' },
    { pattern: /MX\$\s*([\d,]+(?:\.\d{2})?)/i, code: 'MXN' },
    { pattern: /\$\s*([\d,]+(?:\.\d{2})?)/i, code: 'USD' }, // Default $ to USD
  ];

  for (const { pattern, code } of patterns) {
    const match = priceText.match(pattern);
    if (match && match[1]) {
      const amount = parseFloat(match[1].replace(/,/g, ''));
      if (!isNaN(amount) && amount > 0) {
        return { code, amount };
      }
    }
  }
  return null;
}

function convertToUsd(amount: number, currencyCode: string): number | null {
  const info = FX_RATES[currencyCode];
  if (!info) return null;
  return Math.round(amount * info.rate_to_usd * 100) / 100;
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

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
  const diffTime = end.getTime() - start.getTime();
  return Math.max(1, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));
}

function buildVrboUrl(baseUrl: string, checkIn: string, checkOut: string, adults: number = 2, children: number = 0): string {
  try {
    const url = new URL(baseUrl);
    
    // VRBO uses different date param formats
    // Format: arrival/departure or startDate/endDate
    url.searchParams.set('startDate', checkIn);
    url.searchParams.set('endDate', checkOut);
    url.searchParams.set('arrival', checkIn);
    url.searchParams.set('departure', checkOut);
    url.searchParams.set('adults', String(adults));
    if (children > 0) {
      url.searchParams.set('children', String(children));
    }
    
    return url.toString();
  } catch (e) {
    // If URL parsing fails, append params manually
    const separator = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${separator}startDate=${checkIn}&endDate=${checkOut}&adults=${adults}`;
  }
}

function detectBlockSignals(content: string): string | null {
  const lowerContent = content.toLowerCase();
  
  if (/captcha|recaptcha|hcaptcha/i.test(content)) return 'captcha';
  if (/verify you are human|verify you're human/i.test(content)) return 'human_verification';
  if (/checking your browser/i.test(content)) return 'browser_check';
  if (/just a moment/i.test(content)) return 'cloudflare_wait';
  if (/access denied|access to this page has been denied/i.test(content)) return 'access_denied';
  if (/unusual traffic/i.test(content)) return 'unusual_traffic';
  if (/too many requests/i.test(content)) return 'too_many_requests';
  
  return null;
}

// ============================================================================
// VRBO PRICE EXTRACTION
// ============================================================================

interface VrboPriceResult {
  found: boolean;
  totalPrice: number | null;
  nightlyPrice: number | null;
  currency: string | null;
  includesTaxes: boolean;
  isNightlyOnly: boolean;
  evidenceSnippet: string | null;
  cleaningFeeFound: boolean;
  serviceFeeFound: boolean;
  taxesFound: boolean;
}

function extractVrboPrice(content: string, nights: number): VrboPriceResult {
  const result: VrboPriceResult = {
    found: false,
    totalPrice: null,
    nightlyPrice: null,
    currency: null,
    includesTaxes: false,
    isNightlyOnly: false,
    evidenceSnippet: null,
    cleaningFeeFound: false,
    serviceFeeFound: false,
    taxesFound: false,
  };

  // Detect fee components
  result.cleaningFeeFound = /cleaning\s*fee/i.test(content);
  result.serviceFeeFound = /service\s*fee/i.test(content);
  result.taxesFound = /taxes?|tax\s*&\s*fees?/i.test(content);

  // PRIORITY 1: Look for explicit total patterns
  const totalPatterns = [
    // VRBO total patterns
    /total[:\s]+\$?([\d,]+(?:\.\d{2})?)/i,
    /total\s*price[:\s]+\$?([\d,]+(?:\.\d{2})?)/i,
    /\$?([\d,]+(?:\.\d{2})?)\s*total/i,
    /grand\s*total[:\s]+\$?([\d,]+(?:\.\d{2})?)/i,
    /your\s*total[:\s]+\$?([\d,]+(?:\.\d{2})?)/i,
    /trip\s*total[:\s]+\$?([\d,]+(?:\.\d{2})?)/i,
    // Amount due patterns
    /amount\s*due[:\s]+\$?([\d,]+(?:\.\d{2})?)/i,
    /you\s*pay[:\s]+\$?([\d,]+(?:\.\d{2})?)/i,
    // With taxes patterns
    /\$?([\d,]+(?:\.\d{2})?)\s*(?:includes?\s*)?(?:taxes?|fees?)/i,
  ];

  for (const pattern of totalPatterns) {
    const match = content.match(pattern);
    if (match && match[1]) {
      const amount = parseFloat(match[1].replace(/,/g, ''));
      // Total should be reasonably high (at least $50 for any stay)
      if (!isNaN(amount) && amount > 50) {
        result.found = true;
        result.totalPrice = amount;
        result.currency = 'USD'; // VRBO is US-focused
        result.includesTaxes = /taxes?|fees?/i.test(match[0]);
        result.evidenceSnippet = match[0].slice(0, 150);
        result.isNightlyOnly = false;
        
        console.log(`[VRBO] Found total price: $${amount} from pattern: ${pattern}`);
        return result;
      }
    }
  }

  // PRIORITY 2: Look for "X nights" total patterns
  const nightsPatterns = [
    new RegExp(`\\$([\\\d,]+(?:\\.\\d{2})?)\\s*(?:for\\s*)?${nights}\\s*nights?`, 'i'),
    new RegExp(`${nights}\\s*nights?[:\\s]+\\$([\\\d,]+(?:\\.\\d{2})?)`, 'i'),
    /\$?([\d,]+(?:\.\d{2})?)\s*for\s*\d+\s*nights?/i,
  ];

  for (const pattern of nightsPatterns) {
    const match = content.match(pattern);
    if (match && match[1]) {
      const amount = parseFloat(match[1].replace(/,/g, ''));
      if (!isNaN(amount) && amount > 50) {
        result.found = true;
        result.totalPrice = amount;
        result.currency = 'USD';
        result.includesTaxes = result.taxesFound;
        result.evidenceSnippet = match[0].slice(0, 150);
        result.isNightlyOnly = false;
        
        console.log(`[VRBO] Found nights-based total: $${amount}`);
        return result;
      }
    }
  }

  // PRIORITY 3: Look for nightly rate (NOT directly comparable)
  const nightlyPatterns = [
    /\$?([\d,]+(?:\.\d{2})?)\s*\/?\s*(?:per\s*)?night/i,
    /nightly\s*rate[:\s]+\$?([\d,]+(?:\.\d{2})?)/i,
    /avg\.?\s*\/?\s*night[:\s]+\$?([\d,]+(?:\.\d{2})?)/i,
    /\$?([\d,]+(?:\.\d{2})?)\s*avg\.?\s*\/?\s*night/i,
  ];

  for (const pattern of nightlyPatterns) {
    const match = content.match(pattern);
    if (match && match[1]) {
      const amount = parseFloat(match[1].replace(/,/g, ''));
      if (!isNaN(amount) && amount > 10 && amount < 10000) {
        result.found = true;
        result.nightlyPrice = amount;
        result.currency = 'USD';
        result.isNightlyOnly = true;
        result.includesTaxes = false;
        result.evidenceSnippet = match[0].slice(0, 150);
        
        console.log(`[VRBO] Found nightly rate only: $${amount}/night (NOT directly comparable)`);
        return result;
      }
    }
  }

  console.log('[VRBO] No price found in content');
  return result;
}

// ============================================================================
// ZYTE EXTRACTION (PRIMARY)
// ============================================================================

async function extractWithZyte(url: string, nights: number): Promise<{
  success: boolean;
  content: string;
  html: string;
  httpStatus: number | null;
  error: string | null;
  finalUrl: string | null;
  durationMs: number;
}> {
  const start = Date.now();
  const result = {
    success: false,
    content: '',
    html: '',
    httpStatus: null as number | null,
    error: null as string | null,
    finalUrl: null as string | null,
    durationMs: 0,
  };

  try {
    const apiKey = Deno.env.get('ZYTE_API_KEY');
    if (!apiKey) {
      result.error = 'ZYTE_API_KEY not configured';
      result.durationMs = Date.now() - start;
      return result;
    }

    console.log(`[VRBO] Zyte extraction starting: ${url}`);

    const zyteAuth = btoa(apiKey + ':');
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 90000); // 90s timeout

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
        actions: [
          { action: 'waitForTimeout', timeout: 8 }, // Wait for JS to render
        ],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    result.httpStatus = response.status;
    result.durationMs = Date.now() - start;

    if (!response.ok) {
      const errText = await response.text();
      result.error = `HTTP ${response.status}: ${errText.slice(0, 200)}`;
      console.log(`[VRBO] Zyte failed: ${result.error}`);
      return result;
    }

    const data = await response.json();
    result.html = data.browserHtml || '';
    result.content = result.html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    result.finalUrl = data.url || url;
    result.success = true;

    console.log(`[VRBO] Zyte success: ${result.html.length} bytes, ${result.durationMs}ms`);

  } catch (e) {
    result.durationMs = Date.now() - start;
    if (e instanceof Error && e.name === 'AbortError') {
      result.error = 'Timeout after 90s';
    } else {
      result.error = e instanceof Error ? e.message : String(e);
    }
    console.log(`[VRBO] Zyte error: ${result.error}`);
  }

  return result;
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();
  const providerAttempts: ProviderAttemptTrace[] = [];

  // Initialize result
  const result: ExtractionResult = {
    success: false,
    status: 'validation_error',
    failureCategory: 'params_missing',
    extractedPrice: null,
    currency: null,
    originalAmount: null,
    originalCurrency: null,
    conversionRate: null,
    includesTaxesFees: null,
    directlyComparable: false,
    evidenceSnippet: null,
    structuralProof: {
      page_reached: false,
      dates_injected: false,
      dates_visible_on_page: false,
      total_price_label_found: false,
      nightly_rate_only: false,
      cleaning_fee_found: false,
      service_fee_found: false,
      taxes_visible: false,
      directly_comparable: false,
      proof_version: 'vrbo-zyte-v1.0',
      currency_detected: null,
      nights_detected: null,
      entry_url_used: null,
      content_hash: null,
      failure_category: 'params_missing',
      extraction_method: null,
    },
    durationMs: 0,
    error: null,
    providerAttempts: [],
    goldenPath: false,
  };

  try {
    const body: ExtractionRequest = await req.json();
    const { extractionId, url, checkIn, checkOut, adults = 2, children = 0 } = body;

    console.log(`[VRBO] Extraction request: ${url}`);
    console.log(`[VRBO] Dates: ${checkIn} to ${checkOut}, adults: ${adults}`);

    // Validate inputs
    if (!url || !checkIn || !checkOut) {
      result.error = 'Missing required parameters: url, checkIn, checkOut';
      result.durationMs = Date.now() - startTime;
      return new Response(JSON.stringify(result), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const nights = calculateNights(checkIn, checkOut);
    result.structuralProof.nights_detected = nights;

    // Build URL with dates
    const vrboUrl = buildVrboUrl(url, checkIn, checkOut, adults, children);
    result.structuralProof.entry_url_used = vrboUrl;
    result.structuralProof.dates_injected = true;

    console.log(`[VRBO] URL with dates: ${vrboUrl}`);

    // ========================================================================
    // ZYTE-FIRST GOLDEN PATH
    // ========================================================================
    
    const zyteAttempt: ProviderAttemptTrace = {
      provider: 'zyte',
      attempted: true,
      attemptIndex: 0,
      startedAt: new Date().toISOString(),
      endedAt: null,
      outcome: 'skipped',
      httpStatus: null,
      contentLength: null,
      errorMessage: null,
      urlUsed: vrboUrl,
    };

    const zyteResult = await extractWithZyte(vrboUrl, nights);
    
    zyteAttempt.endedAt = new Date().toISOString();
    zyteAttempt.httpStatus = zyteResult.httpStatus;
    zyteAttempt.contentLength = zyteResult.html.length;

    if (zyteResult.success) {
      zyteAttempt.outcome = 'success';
      result.structuralProof.page_reached = true;
      result.structuralProof.content_hash = simpleHash(zyteResult.html);

      // Check for block signals
      const blockSignal = detectBlockSignals(zyteResult.content);
      if (blockSignal) {
        zyteAttempt.outcome = 'bot_blocked';
        zyteAttempt.errorMessage = blockSignal;
        result.status = 'blocked_captcha_or_bot';
        result.failureCategory = blockSignal === 'captcha' ? 'captcha' : 'blocked';
        result.error = `Blocked: ${blockSignal}`;
      } else {
        // Extract price
        const priceResult = extractVrboPrice(zyteResult.content, nights);
        
        result.structuralProof.total_price_label_found = priceResult.found && !priceResult.isNightlyOnly;
        result.structuralProof.nightly_rate_only = priceResult.isNightlyOnly;
        result.structuralProof.cleaning_fee_found = priceResult.cleaningFeeFound;
        result.structuralProof.service_fee_found = priceResult.serviceFeeFound;
        result.structuralProof.taxes_visible = priceResult.taxesFound;

        if (priceResult.found && priceResult.totalPrice && !priceResult.isNightlyOnly) {
          // SUCCESS - Total price found
          result.success = true;
          result.status = 'success_total_stay';
          result.failureCategory = 'success';
          result.extractedPrice = priceResult.totalPrice;
          result.currency = priceResult.currency;
          result.originalAmount = priceResult.totalPrice;
          result.originalCurrency = priceResult.currency;
          result.conversionRate = 1.0;
          result.includesTaxesFees = priceResult.includesTaxes;
          result.directlyComparable = true;
          result.evidenceSnippet = priceResult.evidenceSnippet;
          result.structuralProof.directly_comparable = true;
          result.structuralProof.extraction_method = 'zyte_total_pattern';
          result.goldenPath = true;

          console.log(`[VRBO] SUCCESS: $${priceResult.totalPrice} (total stay)`);

        } else if (priceResult.found && priceResult.isNightlyOnly) {
          // Nightly rate only - NOT directly comparable
          result.success = false;
          result.status = 'nightly_only_rejected';
          result.failureCategory = 'nightly_only';
          result.error = 'Only nightly rate found, not directly comparable';
          result.evidenceSnippet = priceResult.evidenceSnippet;
          result.structuralProof.extraction_method = 'zyte_nightly_only';

          console.log(`[VRBO] Nightly rate only: $${priceResult.nightlyPrice}/night - REJECTED`);

        } else {
          // No price found
          result.success = false;
          result.status = 'total_price_not_found';
          result.failureCategory = 'no_price';
          result.error = 'Total price not found in booking DOM';
          result.structuralProof.extraction_method = 'zyte_no_match';

          console.log('[VRBO] No total price found');
        }
      }
    } else {
      zyteAttempt.outcome = 'navigation_failed';
      zyteAttempt.errorMessage = zyteResult.error;

      if (zyteResult.error?.includes('Timeout')) {
        result.status = 'timeout';
        result.failureCategory = 'timeout';
      } else {
        result.status = 'render_failed';
        result.failureCategory = 'render_error';
      }
      result.error = zyteResult.error;
    }

    providerAttempts.push(zyteAttempt);

    // ========================================================================
    // BROWSERLESS FALLBACK - DISABLED (captcha blocked)
    // ========================================================================
    
    // NOTE: Browserless is NOT attempted for VRBO per VRBO_LIVE_ACCESS_CHECK results
    // Browserless returns captcha wall (116KB content, bookingDom=false)
    const browserlessAttempt: ProviderAttemptTrace = {
      provider: 'browserless',
      attempted: false,
      attemptIndex: 1,
      startedAt: null,
      endedAt: null,
      outcome: 'skipped',
      httpStatus: null,
      contentLength: null,
      errorMessage: 'Skipped: VRBO_LIVE_ACCESS_CHECK shows Browserless is captcha-blocked',
      urlUsed: null,
    };
    providerAttempts.push(browserlessAttempt);

    // ========================================================================
    // FIRECRAWL FALLBACK - DISABLED (quota error)
    // ========================================================================
    
    // NOTE: Firecrawl is NOT attempted for VRBO per VRBO_LIVE_ACCESS_CHECK results
    // Firecrawl returns 402 quota error (not a technical block)
    const firecrawlAttempt: ProviderAttemptTrace = {
      provider: 'firecrawl',
      attempted: false,
      attemptIndex: 2,
      startedAt: null,
      endedAt: null,
      outcome: 'skipped',
      httpStatus: null,
      contentLength: null,
      errorMessage: 'Skipped: VRBO_LIVE_ACCESS_CHECK shows Firecrawl quota error (402)',
      urlUsed: null,
    };
    providerAttempts.push(firecrawlAttempt);

    result.providerAttempts = providerAttempts;
    result.structuralProof.failure_category = result.failureCategory;
    result.durationMs = Date.now() - startTime;

    console.log(`[VRBO] Extraction complete: ${result.status}, ${result.durationMs}ms`);

    // ========================================================================
    // DATABASE UPDATE (if extractionId provided)
    // ========================================================================
    
    if (extractionId) {
      try {
        const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
        const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
        const supabase = createClient(supabaseUrl, supabaseKey);

        await supabase
          .from('price_extractions')
          .update({
            extraction_status: result.status,
            extracted_price: result.extractedPrice,
            currency: result.currency,
            includes_taxes_fees: result.includesTaxesFees,
            evidence_snippets: result.evidenceSnippet ? [result.evidenceSnippet] : null,
            extraction_metadata: {
              structuralProof: result.structuralProof,
              providerAttempts: result.providerAttempts,
              goldenPath: result.goldenPath,
              durationMs: result.durationMs,
            },
            provider_used: 'zyte',
            updated_at: new Date().toISOString(),
          })
          .eq('id', extractionId);

        console.log(`[VRBO] Updated extraction ${extractionId}`);
      } catch (dbError) {
        console.error(`[VRBO] Database update failed:`, dbError);
      }
    }

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    result.status = 'validation_error';
    result.failureCategory = 'render_error';
    result.durationMs = Date.now() - startTime;
    result.providerAttempts = providerAttempts;

    console.error(`[VRBO] Fatal error:`, error);

    return new Response(JSON.stringify(result), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
