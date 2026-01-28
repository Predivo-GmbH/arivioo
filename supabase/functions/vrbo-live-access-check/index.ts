import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { gatedBrowserlessFetch, isFetchRateLimited } from '../_shared/browserlessGate.ts';

/**
 * ============================================================================
 * VRBO LIVE ACCESS CHECK - Diagnostic Mode
 * ============================================================================
 * 
 * Purpose: Test real, side-by-side live access to VRBO using ALL three providers.
 * This is a diagnostics-only function. No price extraction, no selector logic.
 * 
 * Test case (fixed):
 *   URL: https://www.vrbo.com/9836046ha
 *   Dates: Jun 23, 2026 – Jun 28, 2026
 * 
 * Providers tested:
 *   - Firecrawl
 *   - Zyte  
 *   - Browserless
 * 
 * Toggle: VRBO_LIVE_ACCESS_CHECK_MODE (default: false)
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ============================================================================
// CONFIGURATION - Toggle for live access check mode
// ============================================================================

const VRBO_LIVE_ACCESS_CHECK_MODE = false; // Set to true to enable diagnostic mode

// Fixed test case
const TEST_URL = 'https://www.vrbo.com/9836046ha';
const TEST_CHECK_IN = '2026-06-23';
const TEST_CHECK_OUT = '2026-06-28';

// ============================================================================
// TYPES
// ============================================================================

type ProviderName = 'firecrawl' | 'zyte' | 'browserless';

type FailureReason = 'blocked' | 'empty_dom' | 'timeout' | 'redirected' | 'error' | 'none';

interface ProviderResult {
  provider: ProviderName;
  httpStatus: number | null;
  blockSignal: string | null;
  finalUrl: string | null;
  contentLength: number;
  bookingDomPresent: boolean;
  timeMs: number;
  failureReason: FailureReason;
  error: string | null;
  evidence: string | null;
}

interface DiagnosticSummary {
  testUrl: string;
  checkIn: string;
  checkOut: string;
  timestamp: string;
  mode: 'VRBO_LIVE_ACCESS_CHECK';
  results: ProviderResult[];
  summary: {
    firecrawl: 'accessible' | 'blocked' | 'failed';
    zyte: 'accessible' | 'blocked' | 'failed';
    browserless: 'accessible' | 'blocked' | 'failed';
  };
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function buildVrboUrlWithDates(baseUrl: string, checkIn: string, checkOut: string): string {
  // VRBO uses startDate/endDate query params
  const url = new URL(baseUrl);
  url.searchParams.set('startDate', checkIn);
  url.searchParams.set('endDate', checkOut);
  url.searchParams.set('adults', '2');
  return url.toString();
}

function detectBlockSignal(content: string, httpStatus: number | null): string | null {
  if (httpStatus === 403) return '403_forbidden';
  if (httpStatus === 429) return '429_rate_limit';
  
  const lowerContent = content.toLowerCase();
  
  // Captcha detection
  if (/captcha|recaptcha|hcaptcha/i.test(content)) return 'captcha';
  if (/verify you are human|verify you're human/i.test(content)) return 'human_verification';
  if (/checking your browser/i.test(content)) return 'browser_check';
  if (/just a moment/i.test(content)) return 'cloudflare_wait';
  if (/access denied|access to this page has been denied/i.test(content)) return 'access_denied';
  if (/unusual traffic/i.test(content)) return 'unusual_traffic';
  if (/too many requests/i.test(content)) return 'too_many_requests';
  
  // VRBO/Expedia specific
  if (/we couldn't find that page/i.test(content)) return 'page_not_found';
  if (/something went wrong/i.test(content)) return 'error_page';
  
  return null;
}

function detectBookingDom(content: string): boolean {
  // Look for VRBO-specific booking elements
  const bookingIndicators = [
    /book\s*now/i,
    /reserve/i,
    /price\s*details/i,
    /total\s*price/i,
    /per\s*night/i,
    /check-in|checkin/i,
    /check-out|checkout/i,
    /\$[\d,]+(?:\.\d{2})?/,
    /nightly\s*rate/i,
    /cleaning\s*fee/i,
    /service\s*fee/i,
    /property\s*id/i,
    /amenities/i,
    /bedrooms?/i,
    /bathrooms?/i,
    /sleeps/i,
  ];
  
  let matchCount = 0;
  for (const pattern of bookingIndicators) {
    if (pattern.test(content)) matchCount++;
  }
  
  // Require at least 4 indicators to consider booking DOM present
  return matchCount >= 4;
}

function extractEvidence(content: string): string | null {
  if (!content) return null;
  
  // Try to find price-related content
  const priceMatch = content.match(/(\$[\d,]+(?:\.\d{2})?[^<\n]{0,100})/i);
  if (priceMatch) return priceMatch[1].slice(0, 200);
  
  // Try to find booking-related content
  const bookingMatch = content.match(/(book\s*now|reserve|total\s*price)[^<\n]{0,100}/i);
  if (bookingMatch) return bookingMatch[1].slice(0, 200);
  
  // Just return first 200 chars of visible text
  return content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) || null;
}

function classifyResult(result: ProviderResult): 'accessible' | 'blocked' | 'failed' {
  if (result.failureReason === 'none' && result.bookingDomPresent && result.contentLength > 10000) {
    return 'accessible';
  }
  if (result.blockSignal || result.failureReason === 'blocked') {
    return 'blocked';
  }
  return 'failed';
}

// ============================================================================
// PROVIDER TEST FUNCTIONS
// ============================================================================

async function testFirecrawl(url: string): Promise<ProviderResult> {
  const start = Date.now();
  const result: ProviderResult = {
    provider: 'firecrawl',
    httpStatus: null,
    blockSignal: null,
    finalUrl: null,
    contentLength: 0,
    bookingDomPresent: false,
    timeMs: 0,
    failureReason: 'none',
    error: null,
    evidence: null,
  };
  
  try {
    const apiKey = Deno.env.get('FIRECRAWL_API_KEY_1') || Deno.env.get('FIRECRAWL_API_KEY');
    if (!apiKey) {
      result.error = 'FIRECRAWL_API_KEY not configured';
      result.failureReason = 'error';
      result.timeMs = Date.now() - start;
      return result;
    }
    
    console.log(`[VRBO_LIVE_CHECK] provider=firecrawl starting url=${url}`);
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 45000);
    
    const response = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url,
        formats: ['markdown', 'html'],
        onlyMainContent: false,
        waitFor: 8000,
        timeout: 40000,
      }),
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    
    result.httpStatus = response.status;
    result.timeMs = Date.now() - start;
    
    const data = await response.json();
    
    if (!response.ok) {
      result.error = data.error || `HTTP ${response.status}`;
      result.failureReason = 'error';
      console.log(`[VRBO_LIVE_CHECK] provider=firecrawl status=${response.status} error="${result.error}" timeMs=${result.timeMs}`);
      return result;
    }
    
    const markdown = data.data?.markdown || '';
    const html = data.data?.html || '';
    const content = markdown + html;
    
    result.contentLength = content.length;
    result.finalUrl = data.data?.metadata?.sourceURL || url;
    result.blockSignal = detectBlockSignal(content, response.status);
    result.bookingDomPresent = detectBookingDom(content);
    result.evidence = extractEvidence(content);
    
    if (result.blockSignal) {
      result.failureReason = 'blocked';
    } else if (result.contentLength < 1000) {
      result.failureReason = 'empty_dom';
    } else if (result.finalUrl && !result.finalUrl.includes('vrbo.com')) {
      result.failureReason = 'redirected';
    }
    
    console.log(`[VRBO_LIVE_CHECK] provider=firecrawl status=${result.httpStatus} contentLength=${result.contentLength} bookingDom=${result.bookingDomPresent} blockSignal=${result.blockSignal} timeMs=${result.timeMs}`);
    
  } catch (e) {
    result.timeMs = Date.now() - start;
    if (e instanceof Error && e.name === 'AbortError') {
      result.error = 'Timeout after 45s';
      result.failureReason = 'timeout';
    } else {
      result.error = e instanceof Error ? e.message : String(e);
      result.failureReason = 'error';
    }
    console.log(`[VRBO_LIVE_CHECK] provider=firecrawl status=error error="${result.error}" timeMs=${result.timeMs}`);
  }
  
  return result;
}

async function testZyte(url: string): Promise<ProviderResult> {
  const start = Date.now();
  const result: ProviderResult = {
    provider: 'zyte',
    httpStatus: null,
    blockSignal: null,
    finalUrl: null,
    contentLength: 0,
    bookingDomPresent: false,
    timeMs: 0,
    failureReason: 'none',
    error: null,
    evidence: null,
  };
  
  try {
    const apiKey = Deno.env.get('ZYTE_API_KEY');
    if (!apiKey) {
      result.error = 'ZYTE_API_KEY not configured';
      result.failureReason = 'error';
      result.timeMs = Date.now() - start;
      return result;
    }
    
    console.log(`[VRBO_LIVE_CHECK] provider=zyte starting url=${url}`);
    
    const zyteAuth = btoa(apiKey + ':');
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);
    
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
          { action: 'waitForTimeout', timeout: 5 },
        ],
      }),
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    
    result.httpStatus = response.status;
    result.timeMs = Date.now() - start;
    
    if (!response.ok) {
      const errText = await response.text();
      result.error = `HTTP ${response.status}: ${errText.slice(0, 200)}`;
      result.failureReason = 'error';
      console.log(`[VRBO_LIVE_CHECK] provider=zyte status=${response.status} error="${result.error}" timeMs=${result.timeMs}`);
      return result;
    }
    
    const data = await response.json();
    const html = data.browserHtml || '';
    
    result.contentLength = html.length;
    result.finalUrl = data.url || url;
    result.blockSignal = detectBlockSignal(html, response.status);
    result.bookingDomPresent = detectBookingDom(html);
    result.evidence = extractEvidence(html);
    
    if (result.blockSignal) {
      result.failureReason = 'blocked';
    } else if (result.contentLength < 1000) {
      result.failureReason = 'empty_dom';
    } else if (result.finalUrl && !result.finalUrl.includes('vrbo.com')) {
      result.failureReason = 'redirected';
    }
    
    console.log(`[VRBO_LIVE_CHECK] provider=zyte status=${result.httpStatus} contentLength=${result.contentLength} bookingDom=${result.bookingDomPresent} blockSignal=${result.blockSignal} timeMs=${result.timeMs}`);
    
  } catch (e) {
    result.timeMs = Date.now() - start;
    if (e instanceof Error && e.name === 'AbortError') {
      result.error = 'Timeout after 60s';
      result.failureReason = 'timeout';
    } else {
      result.error = e instanceof Error ? e.message : String(e);
      result.failureReason = 'error';
    }
    console.log(`[VRBO_LIVE_CHECK] provider=zyte status=error error="${result.error}" timeMs=${result.timeMs}`);
  }
  
  return result;
}

async function testBrowserless(url: string): Promise<ProviderResult> {
  const start = Date.now();
  const result: ProviderResult = {
    provider: 'browserless',
    httpStatus: null,
    blockSignal: null,
    finalUrl: null,
    contentLength: 0,
    bookingDomPresent: false,
    timeMs: 0,
    failureReason: 'none',
    error: null,
    evidence: null,
  };
  
  try {
    const apiKey = Deno.env.get('BROWSERLESS_API_KEY');
    if (!apiKey) {
      result.error = 'BROWSERLESS_API_KEY not configured';
      result.failureReason = 'error';
      result.timeMs = Date.now() - start;
      return result;
    }
    
    console.log(`[VRBO_LIVE_CHECK] provider=browserless via gate starting url=${url}`);
    
    const gateResult = await gatedBrowserlessFetch(
      `https://chrome.browserless.io/content?token=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          gotoOptions: { waitUntil: 'networkidle2', timeout: 45000 },
          waitForTimeout: 5000,
        }),
        timeout: 60000,
      },
      { platform: 'vrbo', operation: 'liveAccessCheck' }
    );
    
    result.httpStatus = gateResult.status;
    result.timeMs = Date.now() - start;
    
    if (isFetchRateLimited(gateResult)) {
      result.error = 'Rate limited (HTTP 429)';
      result.failureReason = 'error';
      console.log(`[VRBO_LIVE_CHECK] provider=browserless status=429 rate_limited timeMs=${result.timeMs}`);
      return result;
    }
    
    if (!gateResult.success) {
      result.error = gateResult.error || `HTTP ${gateResult.status}`;
      result.failureReason = 'error';
      console.log(`[VRBO_LIVE_CHECK] provider=browserless status=${gateResult.status} error="${result.error}" timeMs=${result.timeMs}`);
      return result;
    }
    
    const html = gateResult.body;
    
    result.contentLength = html.length;
    result.finalUrl = url;
    result.blockSignal = detectBlockSignal(html, gateResult.status);
    result.bookingDomPresent = detectBookingDom(html);
    result.evidence = extractEvidence(html);
    
    if (result.blockSignal) {
      result.failureReason = 'blocked';
    } else if (result.contentLength < 1000) {
      result.failureReason = 'empty_dom';
    }
    
    console.log(`[VRBO_LIVE_CHECK] provider=browserless status=${result.httpStatus} contentLength=${result.contentLength} bookingDom=${result.bookingDomPresent} blockSignal=${result.blockSignal} timeMs=${result.timeMs}`);
    
  } catch (e) {
    result.timeMs = Date.now() - start;
    result.error = e instanceof Error ? e.message : String(e);
    result.failureReason = 'error';
    console.log(`[VRBO_LIVE_CHECK] provider=browserless status=error error="${result.error}" timeMs=${result.timeMs}`);
  }
  
  return result;
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  
  try {
    // Check if mode is enabled
    if (!VRBO_LIVE_ACCESS_CHECK_MODE) {
      return new Response(
        JSON.stringify({
          error: 'VRBO_LIVE_ACCESS_CHECK_MODE is disabled',
          message: 'Set VRBO_LIVE_ACCESS_CHECK_MODE = true to enable diagnostics',
        }),
        { 
          status: 400, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      );
    }
    
    console.log('[VRBO_LIVE_CHECK] Starting diagnostic run...');
    console.log(`[VRBO_LIVE_CHECK] Test URL: ${TEST_URL}`);
    console.log(`[VRBO_LIVE_CHECK] Dates: ${TEST_CHECK_IN} to ${TEST_CHECK_OUT}`);
    
    // Build URL with dates
    const urlWithDates = buildVrboUrlWithDates(TEST_URL, TEST_CHECK_IN, TEST_CHECK_OUT);
    console.log(`[VRBO_LIVE_CHECK] URL with dates: ${urlWithDates}`);
    
    // Run ALL three providers in parallel - no early exit
    console.log('[VRBO_LIVE_CHECK] Running all providers in parallel...');
    
    const [firecrawlResult, zyteResult, browserlessResult] = await Promise.all([
      testFirecrawl(urlWithDates),
      testZyte(urlWithDates),
      testBrowserless(urlWithDates),
    ]);
    
    // Build diagnostic summary
    const summary: DiagnosticSummary = {
      testUrl: TEST_URL,
      checkIn: TEST_CHECK_IN,
      checkOut: TEST_CHECK_OUT,
      timestamp: new Date().toISOString(),
      mode: 'VRBO_LIVE_ACCESS_CHECK',
      results: [firecrawlResult, zyteResult, browserlessResult],
      summary: {
        firecrawl: classifyResult(firecrawlResult),
        zyte: classifyResult(zyteResult),
        browserless: classifyResult(browserlessResult),
      },
    };
    
    console.log('[VRBO_LIVE_CHECK] === DIAGNOSTIC SUMMARY ===');
    console.log(`[VRBO_LIVE_CHECK] firecrawl: ${summary.summary.firecrawl} (${firecrawlResult.contentLength} bytes, ${firecrawlResult.timeMs}ms)`);
    console.log(`[VRBO_LIVE_CHECK] zyte: ${summary.summary.zyte} (${zyteResult.contentLength} bytes, ${zyteResult.timeMs}ms)`);
    console.log(`[VRBO_LIVE_CHECK] browserless: ${summary.summary.browserless} (${browserlessResult.contentLength} bytes, ${browserlessResult.timeMs}ms)`);
    console.log('[VRBO_LIVE_CHECK] Diagnostic run complete.');
    
    return new Response(
      JSON.stringify(summary, null, 2),
      { 
        status: 200, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    );
    
  } catch (error) {
    console.error('[VRBO_LIVE_CHECK] Fatal error:', error);
    
    return new Response(
      JSON.stringify({
        error: 'Diagnostic failed',
        message: error instanceof Error ? error.message : String(error),
      }),
      { 
        status: 500, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    );
  }
});
