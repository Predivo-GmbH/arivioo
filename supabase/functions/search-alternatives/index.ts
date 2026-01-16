import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { finalizeAndCompleteSearch } from "../_shared/buildFinalSnapshot.ts";

// ============================================================================
// SECURE CORS - Domain allowlist for production security
// ============================================================================
const ALLOWED_ORIGINS = [
  'https://lovable.dev',
  'https://www.lovable.dev',
  /^https:\/\/[a-zA-Z0-9-]+\.lovable\.app$/,
  /^https:\/\/[a-zA-Z0-9-]+\.lovableproject\.com$/,
  /^https:\/\/id-preview--[a-zA-Z0-9-]+\.lovable\.app$/,
  'https://arivioo.lovable.app',
  'https://arivioo.com',
  'https://www.arivioo.com',
];

function isOriginAllowed(origin: string | null): boolean {
  if (!origin) return false;
  return ALLOWED_ORIGINS.some(allowed => {
    if (typeof allowed === 'string') return origin === allowed;
    return allowed.test(origin);
  });
}

function getCorsHeaders(request: Request): Record<string, string> {
  const requestOrigin = request.headers.get('origin');
  const origin = requestOrigin ?? '*';
  const requestedHeaders = request.headers.get('access-control-request-headers');
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': requestedHeaders || 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Vary': 'Origin, Access-Control-Request-Headers',
  };
}

// Legacy corsHeaders for backwards compatibility in some response paths
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// SSE helper to send streaming events
type SSEController = ReadableStreamDefaultController<Uint8Array>;
const encoder = new TextEncoder();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = 12_000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

// Generic timeout wrapper for any async operation - prevents stuck processes
async function withTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  fallback: T,
  operationName: string
): Promise<T> {
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      console.log(`TIMEOUT: ${operationName} exceeded ${timeoutMs}ms - skipping`);
      resolve(fallback);
    }, timeoutMs);

    operation()
      .then((result) => {
        clearTimeout(timeoutId);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timeoutId);
        console.log(`ERROR in ${operationName}:`, error.message || error);
        resolve(fallback);
      });
  });
}

// ============================================================================
// Provider Request Logging - Track every API call for quota management
// ============================================================================

type ProviderLogName = 'firecrawl' | 'zyte' | 'browserless' | 'serpapi';

interface ProviderLogParams {
  supabase: any;
  provider: ProviderLogName;
  endpointType: string;
  searchId?: string;
  extractionId?: string;
  url?: string;
  success: boolean;
  httpStatus?: number;
  durationMs?: number;
  errorMessage?: string;
  correlationId?: string;
}

async function logProviderRequest(params: ProviderLogParams): Promise<void> {
  try {
    await params.supabase.from('api_request_logs').insert({
      provider_name: params.provider,
      endpoint_type: params.endpointType,
      search_id: params.searchId || null,
      extraction_id: params.extractionId || null,
      request_url: params.url?.slice(0, 500) || null,
      success: params.success,
      response_status: params.httpStatus || null,
      duration_ms: params.durationMs || null,
      error_message: params.errorMessage?.slice(0, 500) || null,
      correlation_id: params.correlationId || null,
      cost_units: 1, // Each provider call = 1 request unit
    });
    console.log(`[ProviderLog] ${params.provider}/${params.endpointType} - success:${params.success} ${params.durationMs ? `(${params.durationMs}ms)` : ''}`);
  } catch (e) {
    // Don't let logging failures break the main flow
    console.error('[ProviderLog] Failed to log request:', e);
  }
}

// ============================================================================
// Airbnb Fallback Chain Types and Helpers
// ============================================================================

// Provider identifiers for the 5-tier fallback chain
type AirbnbProvider = 'firecrawl' | 'zyte' | 'browserless';

interface AirbnbScrapeResult {
  ok: boolean;
  markdown: string;
  html: string;
  roomsHtml?: string; // HTML from rooms page (for title/images)
  roomsTitle?: string; // Title from rooms page
  screenshot: string | null;
  providerUsed: AirbnbProvider;
  botIndicators: string[];
  error: string | null;
  statusCode?: number;
  evidenceSnippet?: string;
  isRateLimited?: boolean; // True if 429 rate limit detected
  isDatesUnavailable?: boolean; // True if Airbnb shows "dates unavailable" interstitial
  // OCR reference data (captured via screenshot + AI OCR)
  ocrReference?: OcrVisualReference | null;
  
  /**
   * BROWSERLESS CANONICAL BASELINE - payNowExtraction
   * 
   * Reference: docs/BROWSERLESS_CANONICAL_BASELINE.md
   * 
   * This field is the PRIMARY source of truth for Airbnb checkout totals.
   * It is extracted via direct text search in Browserless page.evaluate().
   * 
   * PROTECTED INVARIANTS (any change must compare against baseline):
   * 1. payNowAmount is extracted from "Pay $X now" or "Total (USD) $X" patterns
   * 2. This field MUST be assigned from fnJson.payNowExtraction in both success paths
   * 3. If payNowAmount is present and > 0, status is 'total_price_including_taxes_and_fees'
   * 4. subtotalAmount alone (without payNowAmount) → 'needs_user_confirmation'
   * 
   * DO NOT MODIFY extraction logic without comparing to the canonical baseline first.
   */
  payNowExtraction?: {
    payNowAmount: number | null;
    payNowSnippet: string | null;
    payNowCurrencySymbol: string | null;
    subtotalAmount: number | null;
    subtotalNights: number | null;
    subtotalSnippet: string | null;
    subtotalCurrencySymbol: string | null;
    regexCompilationErrors: string[] | null;
  } | null;
}

// OCR Visual Reference - ground truth from what's visually displayed
interface OcrVisualReference {
  // Booking card OCR (always captured if screenshot available)
  bookingCardAmountRaw: string | null; // e.g. "$2,214"
  bookingCardAmountValue: number | null;
  bookingCardNights: number | null;
  bookingCardSnippet: string | null; // e.g. "$2,214 for 4 nights"
  // Breakdown OCR (only if breakdown modal opened)
  breakdownTotalAmountRaw: string | null; // e.g. "Total USD $2,213.34"
  breakdownTotalAmountValue: number | null;
  breakdownTotalSnippet: string | null;
  breakdownTaxesAmountValue: number | null;
  breakdownOpened: boolean;
}

// Consolidated trace record for a single Airbnb extraction run
interface AirbnbExtractionTrace {
  attemptOrder: AirbnbProvider[];
  outcomes: Record<AirbnbProvider, {
    attempted: boolean;
    success: boolean;
    error?: string;
    botIndicators?: string[];
    contentLength?: number;
    contentHash?: string;
    evidenceSnippet?: string;
    durationMs?: number;
  }>;
  finalProvider?: AirbnbProvider;
  finalPrice?: number;
  finalOutcome: 'success' | 'bot_wall' | 'price_not_found' | 'all_failed';
  totalDurationMs: number;
}

// Create a simple content hash for deduplication/logging
function hashContent(content: string): string {
  let hash = 0;
  for (let i = 0; i < Math.min(content.length, 1000); i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

// Extract evidence snippet around a price match
function extractEvidenceSnippet(content: string, priceValue?: number): string {
  if (!content) return '';
  
  // If we have a price, try to find it in content
  if (priceValue) {
    const priceStr = priceValue.toString();
    const idx = content.indexOf(priceStr);
    if (idx !== -1) {
      const start = Math.max(0, idx - 100);
      const end = Math.min(content.length, idx + priceStr.length + 100);
      return content.slice(start, end).replace(/\s+/g, ' ').trim();
    }
  }
  
  // Otherwise return first 200 chars of meaningful content
  const cleaned = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, 200);
}

// NOTE: Known Property Matches Cache has been removed.
// Search results are now based ONLY on matches discovered and verified in the current run.
// This ensures strict adherence to the visual verification contract and prevents
// cached matches (which may lack photos) from appearing in results.

// ============================================================================
// Bot/Captcha Detection - Shared across all providers
// ============================================================================

// Detect bot/captcha indicators in content
// IMPORTANT: Only detect real bot walls, not CSS class names or script content
function detectBotIndicators(content: string): string[] {
  const indicators: string[] = [];
  
  // Strip out CSS, scripts, and style blocks to avoid false positives from class names
  const visibleContent = content
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/\{[^}]*\}/g, ' ') // Remove CSS rule blocks
    .replace(/class\s*=\s*["'][^"']*["']/gi, ' ') // Remove class attributes
    .replace(/id\s*=\s*["'][^"']*["']/gi, ' '); // Remove id attributes
  
  // These patterns must appear in visible text context, not CSS/class names
  const patterns = [
    { pattern: /please\s+complete\s+the\s+captcha/i, label: "captcha" },
    { pattern: /solve\s+the\s+captcha/i, label: "captcha" },
    { pattern: /verify\s+you['']?re\s+human/i, label: "human_verification" },
    { pattern: /verify\s+you\s+are\s+human/i, label: "human_verification" },
    { pattern: /i['']?m\s+not\s+a\s+robot/i, label: "captcha" },
    { pattern: /checking\s+your\s+browser/i, label: "browser_check" },
    { pattern: /just\s+a\s+moment[\.\!\s]/i, label: "cloudflare_wait" },
    { pattern: /please\s+wait\s+while\s+we\s+verify/i, label: "verification_wait" },
    { pattern: /unusual\s+traffic\s+from\s+your/i, label: "unusual_traffic" },
    { pattern: /too\s+many\s+requests/i, label: "too_many_requests" },
    { pattern: /access\s+to\s+this\s+page\s+has\s+been\s+denied/i, label: "access_denied" },
    { pattern: /ray\s+id[:\s]+[a-f0-9]+/i, label: "cloudflare" },
    { pattern: /performance\s+&\s+security\s+by\s+cloudflare/i, label: "cloudflare" },
  ];
  
  for (const { pattern, label } of patterns) {
    if (pattern.test(visibleContent)) {
      indicators.push(label);
    }
  }
  
  return indicators;
}

// ============================================================================
// Tier 2: Zyte Scraper for Airbnb
// ============================================================================

// Scrape Airbnb using Zyte API with browser rendering
async function scrapeAirbnbWithZyte(url: string, zyteApiKey: string): Promise<AirbnbScrapeResult> {
  const startTime = Date.now();
  const result: AirbnbScrapeResult = {
    ok: false,
    markdown: '',
    html: '',
    screenshot: null,
    providerUsed: 'zyte',
    botIndicators: [],
    error: null,
  };
  
  try {
    const zyteAuth = btoa(zyteApiKey + ":");
    
    console.log("Scraping Airbnb with Zyte:", url.slice(0, 100));
    
    const response = await fetchWithTimeout(
      "https://api.zyte.com/v1/extract",
      {
        method: "POST",
        headers: {
          "Authorization": `Basic ${zyteAuth}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url,
          browserHtml: true,
          javascript: true,
          screenshot: true,
          screenshotOptions: { fullPage: false },
          // Wait for page to fully load and prices to hydrate
          actions: [
            { action: "waitForTimeout", timeout: 8 }, // Wait for initial render and dynamic pricing
          ],
        }),
      },
      60_000 // 60 second timeout for Zyte
    );
    
    result.statusCode = response.status;
    
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      result.error = `Zyte HTTP ${response.status}: ${errText.slice(0, 200)}`;
      console.error("Zyte scrape failed:", result.error);
      return result;
    }
    
    const data = await response.json();
    const html = data.browserHtml || "";
    const screenshot = data.screenshot || null;
    
    if (!html || html.length < 500) {
      result.error = "Zyte returned insufficient content";
      return result;
    }
    
    // Check for bot indicators
    result.botIndicators = detectBotIndicators(html);
    
    if (result.botIndicators.length > 0) {
      console.log("Zyte: Bot indicators detected:", result.botIndicators.join(', '));
      result.error = `Bot detection: ${result.botIndicators.join(', ')}`;
      result.html = html;
      result.evidenceSnippet = extractEvidenceSnippet(html);
      return result;
    }
    
    result.ok = true;
    result.html = html;
    result.screenshot = screenshot;
    
    // Generate simple markdown from HTML (strip tags)
    result.markdown = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    
    console.log("Zyte scrape successful. HTML length:", html.length, "Has screenshot:", !!screenshot, "Duration:", Date.now() - startTime, "ms");
    
    return result;
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    console.error("Zyte scrape error:", result.error);
    return result;
  }
}

// ============================================================================
// Tier 3: Browserless Scraper for Airbnb
// ============================================================================

// ============================================================================
// CANONICAL URL NORMALIZER - Shared Logic (Golden Path)
// This is the SINGLE SOURCE OF TRUTH for Airbnb URL normalization.
// Keep in sync with supabase/functions/airbnb-url-normalizer/index.ts
// ============================================================================

interface NormalizedAirbnbUrls {
  book_stays_url: string;
  rooms_url: string;
  room_id: string;
  check_in: string;
  check_out: string;
  nights_count: number;
  adults: number;
  children: number;
  infants: number;
  pets: number;
}

function buildBookStaysUrl(inputUrl: string, guestCurrency = 'USD'): NormalizedAirbnbUrls | null {
  try {
    const parsed = new URL(inputUrl);
    
    // Extract room ID from /rooms/<id> or /book/stays/<id>
    let roomId: string | null = null;
    const roomsMatch = parsed.pathname.match(/\/rooms\/(\d+)/);
    if (roomsMatch) roomId = roomsMatch[1];
    const bookStaysMatch = parsed.pathname.match(/\/book\/stays\/(\d+)/);
    if (bookStaysMatch) roomId = bookStaysMatch[1];
    if (!roomId) return null;
    
    // Extract dates (handle both formats)
    const checkIn = parsed.searchParams.get('checkin') || parsed.searchParams.get('check_in') || '';
    const checkOut = parsed.searchParams.get('checkout') || parsed.searchParams.get('check_out') || '';
    if (!checkIn || !checkOut) return null;
    
    // Validate dates
    const checkInDate = new Date(checkIn + 'T00:00:00Z');
    const checkOutDate = new Date(checkOut + 'T00:00:00Z');
    if (isNaN(checkInDate.getTime()) || isNaN(checkOutDate.getTime())) return null;
    if (checkOutDate <= checkInDate) return null;
    
    const nightsCount = Math.round((checkOutDate.getTime() - checkInDate.getTime()) / (1000 * 60 * 60 * 24));
    
    // Extract guest parameters
    const adults = parseInt(
      parsed.searchParams.get('numberOfAdults') || 
      parsed.searchParams.get('adults') || 
      '1', 
      10
    ) || 1;
    
    const children = parseInt(
      parsed.searchParams.get('numberOfChildren') || 
      parsed.searchParams.get('children') || 
      '0', 
      10
    ) || 0;
    
    const infants = parseInt(
      parsed.searchParams.get('numberOfInfants') || 
      parsed.searchParams.get('infants') || 
      '0', 
      10
    ) || 0;
    
    const pets = parseInt(
      parsed.searchParams.get('numberOfPets') || 
      parsed.searchParams.get('pets') || 
      '0', 
      10
    ) || 0;
    
    // Calculate numberOfGuests (pets don't count)
    const existingGuests = parsed.searchParams.get('numberOfGuests') || parsed.searchParams.get('guests');
    const numberOfGuests = existingGuests 
      ? parseInt(existingGuests, 10) || (adults + children + infants)
      : adults + children + infants;
    
    // Build canonical book/stays URL with FIXED PARAMETER ORDER
    const bookStaysUrl = new URL(`https://www.airbnb.com/book/stays/${roomId}`);
    bookStaysUrl.searchParams.set('numberOfGuests', String(numberOfGuests));
    bookStaysUrl.searchParams.set('numberOfAdults', String(adults));
    bookStaysUrl.searchParams.set('checkin', checkIn);
    bookStaysUrl.searchParams.set('checkout', checkOut);
    bookStaysUrl.searchParams.set('guestCurrency', guestCurrency);
    bookStaysUrl.searchParams.set('productId', roomId);
    bookStaysUrl.searchParams.set('isWorkTrip', 'false');
    bookStaysUrl.searchParams.set('numberOfChildren', String(children));
    bookStaysUrl.searchParams.set('numberOfInfants', String(infants));
    bookStaysUrl.searchParams.set('numberOfPets', String(pets));
    
    // Build canonical rooms URL
    const roomsUrl = new URL(`https://www.airbnb.com/rooms/${roomId}`);
    roomsUrl.searchParams.set('check_in', checkIn);
    roomsUrl.searchParams.set('check_out', checkOut);
    roomsUrl.searchParams.set('adults', String(adults));
    if (children > 0) roomsUrl.searchParams.set('children', String(children));
    if (infants > 0) roomsUrl.searchParams.set('infants', String(infants));
    if (pets > 0) roomsUrl.searchParams.set('pets', String(pets));
    
    return {
      book_stays_url: bookStaysUrl.toString(),
      rooms_url: roomsUrl.toString(),
      room_id: roomId,
      check_in: checkIn,
      check_out: checkOut,
      nights_count: nightsCount,
      adults,
      children,
      infants,
      pets,
    };
  } catch {
    return null;
  }
}

async function scrapeAirbnbWithBrowserlessAttempt(url: string, browserlessApiKey: string, nights: number = 1, attemptNum: number = 1): Promise<AirbnbScrapeResult> {
  const startTime = Date.now();
  const result: AirbnbScrapeResult = {
    ok: false,
    markdown: '',
    html: '',
    screenshot: null,
    providerUsed: 'browserless',
    botIndicators: [],
    error: null,
    ocrReference: null,
    isRateLimited: false,
    isDatesUnavailable: false,
  };
  
  try {
    // Build book/stays URL from rooms URL
    const bookStaysParams = buildBookStaysUrl(url);
    const bookStaysUrl = bookStaysParams?.book_stays_url || null;
    const roomId = bookStaysParams?.room_id || '';
    
    console.log(`Browserless attempt ${attemptNum}: Scraping Airbnb (book/stays primary):`, url.slice(0, 100));
    console.log("Generated book/stays URL:", bookStaysUrl?.slice(0, 120) || 'none');

    // Use Browserless /function endpoint - PRIMARY: book/stays page for price, but capture title/images from rooms first
    const browserlessFnUrl = `https://chrome.browserless.io/function?token=${browserlessApiKey}`;

    const functionPayload = {
      code: `
        export default async function({ page, context }) {
          const bookStaysUrl = context.bookStaysUrl;
          const roomsUrl = context.roomsUrl;
          const roomId = context.roomId;
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

          // Session setup
          await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
          await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
          await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
          
          try {
            const client = await page.target().createCDPSession();
            await client.send('Emulation.setTimezoneOverride', { timezoneId: 'America/New_York' });
            await client.send('Network.enable');
            await client.send('Network.clearBrowserCookies');
            await client.send('Network.clearBrowserCache');
          } catch (e) {}

          // Clear storage
          await page.goto('https://www.airbnb.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
          await sleep(500);
          try { await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }); } catch {}

          let usedFallback = false;
          let breakdownOpened = false;
          let roomsTitle = '';
          let roomsHtml = '';

           // ========== STEP 1: Visit rooms page first to get title and images ==========
           const MAX_HTML_CHARS = 350000;
           const truncateHtml = (s) => (typeof s === 'string' ? s.slice(0, MAX_HTML_CHARS) : '');

           const safeContent = async () => {
             // page.content() can intermittently throw on Browserless; fall back to DOM serialization.
             try {
               const c = await page.content();
               if (c && c.length > 0) return c;
             } catch {}
             try {
               return await page.evaluate(() => document.documentElement?.outerHTML || '');
             } catch {}
             return '';
           };

            const safeGoto = async (targetUrl, timeoutMs) => {
              try {
                await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: timeoutMs });
                return true;
              } catch (e) {
                return false;
              }
            };

            const waitForMeaningfulText = async (timeoutMs) => {
              const start = Date.now();
              let lastLen = 0;
              while (Date.now() - start < timeoutMs) {
                try {
                  lastLen = await page.evaluate(() => {
                    const bodyLen = (document.body?.innerText || '').length;
                    const docLen = (document.documentElement?.innerText || '').length;
                    return Math.max(bodyLen, docLen);
                  });
                  if (lastLen > 400) return { ok: true, textLen: lastLen };
                } catch {}
                await sleep(750);
              }
              return { ok: false, textLen: lastLen };
            };

            let roomsTextLen = 0;
            let checkoutTextLen = 0;

            const roomsOk = await safeGoto(roomsUrl, 60000);
            await sleep(1500);
            if (roomsOk) {
              const w = await waitForMeaningfulText(25000);
              roomsTextLen = w.textLen || 0;
              roomsTitle = await page.title();
              roomsHtml = truncateHtml(await safeContent());
            }

            // ========== STEP 2: Navigate to book/stays for price ==========
            let checkoutHtml = '';
            let checkoutFinalUrl = '';
            if (bookStaysUrl) {
              const checkoutOk = await safeGoto(bookStaysUrl, 75000);
              await sleep(1500);

              checkoutFinalUrl = page.url();
              const isBookStaysPage = checkoutFinalUrl.includes('/book/stays/' + roomId);
              const isLoginRedirect = checkoutFinalUrl.includes('/login') || checkoutFinalUrl.includes('/signin');

              if (!checkoutOk || !isBookStaysPage || isLoginRedirect) {
                usedFallback = true;

                // Go back to rooms page for price fallback
                await safeGoto(roomsUrl, 60000);
                await sleep(2500);

                // Try to open price breakdown
                try {
                   await page.evaluate(() => {
                     const candidates = Array.from(document.querySelectorAll('button,a,[role="button"]'));
                     const target = candidates.find((el) => (el.textContent || '').toLowerCase().includes('price breakdown'));
                     if (target) {
                       target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                     }
                   });
                  breakdownOpened = true;
                  await sleep(2000);
                } catch {}

                const w = await waitForMeaningfulText(25000);
                checkoutTextLen = w.textLen || 0;
                checkoutHtml = truncateHtml(await safeContent());
              } else {
                // book/stays page already shows full breakdown
                breakdownOpened = true;
                const w = await waitForMeaningfulText(30000);
                checkoutTextLen = w.textLen || 0;
                checkoutHtml = truncateHtml(await safeContent());
              }
            } else {
              usedFallback = true;
              // Stay on rooms page, try to open breakdown
              try {
                 await page.evaluate(() => {
                   const candidates = Array.from(document.querySelectorAll('button,a,[role="button"]'));
                   const target = candidates.find((el) => (el.textContent || '').toLowerCase().includes('price breakdown'));
                   if (target) {
                     target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                   }
                 });
                breakdownOpened = true;
                await sleep(2000);
              } catch {}

              const w = await waitForMeaningfulText(25000);
              checkoutTextLen = w.textLen || 0;
              checkoutHtml = truncateHtml(await safeContent());
            }

           // CRITICAL FIX: Capture screenshot from checkout/price page with FULL PAGE to get the total
           // The "Pay $X now" button is often near the bottom of the page
           await page.evaluate(() => window.scrollTo(0, 0));
           await sleep(500);
           // Use fullPage: true to capture the entire page including the payment total at the bottom
           const screenshot = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 75, fullPage: true });

           const html = (checkoutHtml && checkoutHtml.length > 200) ? checkoutHtml : roomsHtml;

           // CRITICAL FIX: Extract "Pay $X now" pattern directly from visible text
           // This is more reliable than OCR for the total
           // NOTE: Regex patterns use double-escaped backslashes (\\s, \\d, etc.) because
           // this code is a string that gets sent to Browserless and parsed - single backslashes
           // would be stripped during JSON serialization, causing "Invalid regex" errors.
            const payNowExtraction = await page.evaluate(() => {
              const text = document.body?.innerText || '';
              const html = document.documentElement?.innerHTML || '';
              
              // Define patterns with compile-time validation
              // Each pattern is wrapped in try/catch to prevent crashes
              const safeRegex = (pattern, flags) => {
                try {
                  return new RegExp(pattern, flags);
                } catch (e) {
                  console.error('REGEX COMPILE ERROR:', pattern, e.message);
                  return null;
                }
              };
              
              // Currency helpers
              const currencyPrefix = '(?:US\\s*)?';
              const currencySymbol = '([\\$€£])';
              const amount = '([\\d,]+(?:\\.\\d{2})?)';
              
              // Patterns for total extraction
              // NOTE: patterns are string literals with double-escaped backslashes to survive JSON transport
              const payNowPattern = 'Pay\\s*' + currencyPrefix + currencySymbol + '\\s*' + amount + '\\s*now';
              const totalPattern = 'Total\\s*(?:\\(?\\s*[A-Z]{3}\\s*\\)?\\s*)?' + currencyPrefix + currencySymbol + '\\s*' + amount;
              const dueTodayPattern = 'Due\\s+today\\s*' + currencyPrefix + currencySymbol + '\\s*' + amount;
              const subtotalPattern = currencyPrefix + currencySymbol + '\\s*' + amount + '\\s+for\\s+(\\d+)\\s+nights?';

              const payNowRe = safeRegex(payNowPattern, 'i');
              const totalRe = safeRegex(totalPattern, 'i');
              const dueTodayRe = safeRegex(dueTodayPattern, 'i');
              const subtotalRe = safeRegex(subtotalPattern, 'i');
              
              // Check for compilation errors
              const compilationErrors = [];
              if (!payNowRe) compilationErrors.push('payNowRe');
              if (!totalRe) compilationErrors.push('totalRe');
              if (!dueTodayRe) compilationErrors.push('dueTodayRe');
              if (!subtotalRe) compilationErrors.push('subtotalRe');
              
              if (compilationErrors.length > 0) {
                return {
                  payNowAmount: null,
                  payNowSnippet: null,
                  payNowCurrencySymbol: null,
                  subtotalAmount: null,
                  subtotalNights: null,
                  subtotalSnippet: null,
                  subtotalCurrencySymbol: null,
                  regexCompilationErrors: compilationErrors,
                };
              }
              
              // Try against visible text first, then against raw HTML
              const findMatch = (re) => text.match(re) || html.match(re);
              
              const payNowMatch = findMatch(payNowRe);
              const totalMatch = findMatch(totalRe);
              const dueTodayMatch = findMatch(dueTodayRe);
              const subtotalMatch = findMatch(subtotalRe);
              
              let payNowAmount = null;
              let payNowSnippet = null;
              let payNowCurrencySymbol = null;
              if (payNowMatch) {
                payNowCurrencySymbol = payNowMatch[1];
                payNowAmount = parseFloat(payNowMatch[2].replace(/,/g, ''));
                payNowSnippet = payNowMatch[0];
              } else if (totalMatch) {
                payNowCurrencySymbol = totalMatch[1];
                payNowAmount = parseFloat(totalMatch[2].replace(/,/g, ''));
                payNowSnippet = totalMatch[0];
              } else if (dueTodayMatch) {
                payNowCurrencySymbol = dueTodayMatch[1];
                payNowAmount = parseFloat(dueTodayMatch[2].replace(/,/g, ''));
                payNowSnippet = dueTodayMatch[0];
              }
              
              let subtotalAmount = null;
              let subtotalNights = null;
              let subtotalSnippet = null;
              let subtotalCurrencySymbol = null;
              if (subtotalMatch) {
                // subtotalMatch: [0]=full, [1]=symbol, [2]=amount, [3]=nights
                subtotalCurrencySymbol = subtotalMatch[1];
                subtotalAmount = parseFloat(subtotalMatch[2].replace(/,/g, ''));
                subtotalNights = parseInt(subtotalMatch[3], 10);
                subtotalSnippet = subtotalMatch[0];
              }
              
              return {
                payNowAmount,
                payNowSnippet,
                payNowCurrencySymbol,
                subtotalAmount,
                subtotalNights,
                subtotalSnippet,
                subtotalCurrencySymbol,
                regexCompilationErrors: null,
              };
            });

           // Debug: return a snippet around "total" or "Pay"
           const totalSnippet = await page.evaluate(() => {
             const text = document.body?.innerText || '';
             const lower = text.toLowerCase();
             let idx = lower.indexOf('pay ');
             if (idx === -1) idx = lower.indexOf('total');
             if (idx === -1) return text.slice(0, 800);
             const start = Math.max(0, idx - 200);
             const end = Math.min(text.length, idx + 600);
             return text.slice(start, end);
           });

           return {
             html,
             roomsHtml,
             roomsTitle,
             breakdownOpened,
             usedFallback,
             checkoutFinalUrl,
             roomsTextLen,
             checkoutTextLen,
             totalSnippet: (totalSnippet || '').slice(0, 1200),
             bookingCardScreenshot: screenshot,
             breakdownScreenshot: breakdownOpened ? screenshot : null,
             // CRITICAL: Include direct text extraction for Pay Now total
             payNowExtraction: payNowExtraction || null,
           };
        }
      `,
      context: { bookStaysUrl, roomsUrl: url, roomId },
    };

    const response = await fetchWithTimeout(
      browserlessFnUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(functionPayload),
      },
      90_000
    );

    result.statusCode = response.status;

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      
      // Detect HTTP 429 rate limiting
      const isRateLimited = response.status === 429 || 
        errText.includes('429 Too Many Requests') || 
        (errText.includes('openresty') && errText.includes('Too Many Requests'));
      
      if (isRateLimited) {
        console.log(`Browserless attempt ${attemptNum} RATE LIMITED (429)`);
        result.error = `rate_limited: ${errText.slice(0, 200)}`;
        result.isRateLimited = true;
        return result;
      }
      
      result.error = `Browserless HTTP ${response.status}: ${errText.slice(0, 200)}`;
      console.error(`Browserless attempt ${attemptNum} failed:`, result.error);
      return result;
    }

    const fnJson = await response.json().catch(() => null);
    
    // Debug: log all returned lengths
    console.log(`Browserless attempt ${attemptNum} response:`, {
      htmlLen: fnJson?.html?.length || 0,
      roomsHtmlLen: fnJson?.roomsHtml?.length || 0,
      roomsTextLen: fnJson?.roomsTextLen || 0,
      checkoutTextLen: fnJson?.checkoutTextLen || 0,
      checkoutFinalUrl: fnJson?.checkoutFinalUrl?.slice(0, 100) || 'none',
      usedFallback: fnJson?.usedFallback,
      breakdownOpened: fnJson?.breakdownOpened,
      hasScreenshot: !!fnJson?.bookingCardScreenshot,
    });
    
    const html = (fnJson?.html || fnJson?.roomsHtml || "");
    const roomsHtml = fnJson?.roomsHtml || '';
    const screenshotForOcr = fnJson?.breakdownScreenshot || fnJson?.bookingCardScreenshot || null;

    if (!html || html.length < 500) {
      // Browserless sometimes returns a tiny checkout HTML (JS shell) even though the screenshot is valid.
      // In that case, still proceed using roomsHtml for parsing and run OCR on the screenshot.
      const serverMsg =
        (typeof fnJson?.error === "string" && fnJson.error) ||
        (typeof fnJson?.message === "string" && fnJson.message) ||
        (typeof fnJson?.name === "string" && fnJson.name) ||
        null;

      const hasRoomsHtml = roomsHtml && roomsHtml.length >= 500;
      const hasScreenshot = !!screenshotForOcr;

      if (hasRoomsHtml || hasScreenshot) {
        console.log(`Browserless attempt ${attemptNum}: checkout HTML too small (len=${html?.length || 0}); continuing with roomsHtml=${roomsHtml.length} and screenshot=${hasScreenshot}`);

        result.ok = true;
        result.html = hasRoomsHtml ? roomsHtml : (html || "");
        result.roomsHtml = roomsHtml;
        result.roomsTitle = fnJson?.roomsTitle || '';
        result.screenshot = screenshotForOcr;
        
        // CRITICAL: Store payNowExtraction even when HTML is insufficient
        if (fnJson?.payNowExtraction) {
          result.payNowExtraction = fnJson.payNowExtraction;
          console.log(`Browserless attempt ${attemptNum} (html_insufficient): payNowExtraction captured:`, JSON.stringify({
            payNowAmount: fnJson.payNowExtraction.payNowAmount,
            payNowSnippet: fnJson.payNowExtraction.payNowSnippet?.slice(0, 50),
          }));
        }

        // Run OCR even when HTML is insufficient (often the only way to get the checkout total)
        const breakdownOpened = typeof fnJson?.breakdownOpened === 'boolean' ? fnJson.breakdownOpened : false;
        if (screenshotForOcr) {
          console.log(`Browserless attempt ${attemptNum}: Running OCR extraction (html_insufficient)...`);
          result.ocrReference = await extractOcrVisualReference(screenshotForOcr, nights, breakdownOpened);
        }

        // Bot/dates_unavailable detection uses HTML; if we only have a shell, this may be weak but still safe.
        result.botIndicators = detectBotIndicators(result.html || '');
        result.evidenceSnippet = extractEvidenceSnippet(result.html || '');

        result.markdown = (result.html || '')
          .replace(/<script[\s\S]*?<\/script>/gi, " ")
          .replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();

        return result;
      }

      result.error = serverMsg
        ? `Browserless returned insufficient content: ${serverMsg}`
        : "Browserless returned insufficient content";

      console.error(`Browserless attempt ${attemptNum} insufficient content. Keys:`, fnJson ? Object.keys(fnJson) : null);
      return result;
    }

    // Debug preview
    if (fnJson?.totalSnippet) {
      console.log(`Browserless attempt ${attemptNum} total snippet:`, String(fnJson.totalSnippet).replace(/\s+/g, ' ').slice(0, 300));
    }
    const breakdownOpened = typeof fnJson?.breakdownOpened === 'boolean' ? fnJson.breakdownOpened : false;
    const usedFallback = typeof fnJson?.usedFallback === 'boolean' ? fnJson.usedFallback : false;
    console.log(`Browserless attempt ${attemptNum}: usedFallback:`, usedFallback, "breakdownOpened:", breakdownOpened);

    // Check for bot indicators
    result.botIndicators = detectBotIndicators(html);

    if (result.botIndicators.length > 0) {
      console.log(`Browserless attempt ${attemptNum}: Bot indicators detected:`, result.botIndicators.join(', '));
      result.error = `Bot detection: ${result.botIndicators.join(', ')}`;
      result.html = html;
      result.evidenceSnippet = extractEvidenceSnippet(html);
      return result;
    }

    // Check for dates unavailable patterns - terminal state, not retryable
    const htmlLower = html.toLowerCase();
    const totalSnippetLower = (fnJson?.totalSnippet || '').toLowerCase();
    const datesUnavailablePatterns = [
      'no longer available',
      'dates are no longer available',
      'unavailable for your dates',
      'not available for these dates',
      'someone else just requested',
      'this listing is no longer',
      'this home isn\'t available',
      'these dates are no longer available',
    ];
    
    const isDatesUnavailable = datesUnavailablePatterns.some(p => 
      htmlLower.includes(p) || totalSnippetLower.includes(p)
    );
    
    if (isDatesUnavailable) {
      console.log(`Browserless attempt ${attemptNum}: DATES_UNAVAILABLE detected in content`);
      result.ok = true; // Mark as successful scrape, but dates unavailable
      result.isDatesUnavailable = true;
      result.html = html;
      result.error = 'dates_unavailable';
      result.evidenceSnippet = (fnJson?.totalSnippet || '').slice(0, 300);
      // Still capture rooms data for display
      result.roomsHtml = fnJson?.roomsHtml || '';
      result.roomsTitle = fnJson?.roomsTitle || '';
      return result;
    }

    result.ok = true;
    result.html = html;
    
    // Store rooms page data for title/images extraction
    result.roomsHtml = fnJson?.roomsHtml || '';
    result.roomsTitle = fnJson?.roomsTitle || '';

    // Store screenshot for OCR
    result.screenshot = screenshotForOcr;
    
    // CRITICAL: Store payNowExtraction from Browserless response for direct text extraction
    // This is the PRIMARY source of truth for the checkout total
    if (fnJson?.payNowExtraction) {
      result.payNowExtraction = fnJson.payNowExtraction;
      console.log(`Browserless attempt ${attemptNum}: payNowExtraction captured:`, JSON.stringify({
        payNowAmount: fnJson.payNowExtraction.payNowAmount,
        payNowSnippet: fnJson.payNowExtraction.payNowSnippet?.slice(0, 50),
        subtotalAmount: fnJson.payNowExtraction.subtotalAmount,
        regexCompilationErrors: fnJson.payNowExtraction.regexCompilationErrors,
      }));
    } else {
      console.log(`Browserless attempt ${attemptNum}: payNowExtraction is null/undefined`);
    }

    // Run OCR extraction on the screenshot
    if (screenshotForOcr) {
      console.log(`Browserless attempt ${attemptNum}: Running OCR extraction...`);
      result.ocrReference = await extractOcrVisualReference(screenshotForOcr, nights, breakdownOpened);
    }

    // Generate markdown from HTML
    result.markdown = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    console.log(`Browserless attempt ${attemptNum} successful. HTML length:`, html.length, "roomsHtml length:", result.roomsHtml?.length || 0, "Duration:", Date.now() - startTime, "ms", "Has OCR:", !!result.ocrReference, "Has payNowExtraction:", !!result.payNowExtraction);

    return result;
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    console.error(`Browserless attempt ${attemptNum} error:`, result.error);
    return result;
  }
}

// Wrapper with single controlled retry and telemetry
async function scrapeAirbnbWithBrowserless(url: string, browserlessApiKey: string, nights: number = 1, searchId?: string, supabase?: any): Promise<AirbnbScrapeResult> {
  const MAX_ATTEMPTS = 2;
  const BACKOFF_MS = 2000;
  
  let lastResult: AirbnbScrapeResult | null = null;
  
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const attemptStart = Date.now();
    
    const result = await scrapeAirbnbWithBrowserlessAttempt(url, browserlessApiKey, nights, attempt);
    const attemptDurationMs = Date.now() - attemptStart;
    
    // Record telemetry for each attempt
    if (supabase && searchId) {
      try {
        await supabase.from('search_stage_runs').insert({
          search_id: searchId,
          stage_name: 'browserless_baseline_attempt',
          started_at: new Date(attemptStart).toISOString(),
          finished_at: new Date().toISOString(),
          duration_ms: attemptDurationMs,
          outcome_status: result.ok ? 'success' : 'failed',
          error_message: result.ok ? null : (result.error || 'Unknown error').slice(0, 500),
          metadata: {
            attempt_number: attempt,
            max_attempts: MAX_ATTEMPTS,
            html_length: result.html?.length || 0,
            has_ocr: !!result.ocrReference,
            bot_indicators: result.botIndicators || [],
            status_code: result.statusCode,
            retry_triggered: !result.ok && attempt < MAX_ATTEMPTS,
          },
        });
      } catch (telemetryErr) {
        console.error('Failed to record browserless attempt telemetry:', telemetryErr);
      }
    }
    
    lastResult = result;
    
    // Success - return immediately
    if (result.ok) {
      console.log(`Browserless succeeded on attempt ${attempt}/${MAX_ATTEMPTS}`);
      return result;
    }
    
    // Check if error is retryable (insufficient content without bot detection)
    // Note: Browserless can return 200 with empty HTML, so we don't check status code for insufficient content
    const isInsufficientContent = result.error?.includes('insufficient content');
    const isRetryable = isInsufficientContent && result.botIndicators.length === 0;
    
    if (!isRetryable || attempt >= MAX_ATTEMPTS) {
      console.log(`Browserless not retrying: retryable=${isRetryable}, attempt=${attempt}/${MAX_ATTEMPTS}`);
      break;
    }
    
    // Backoff before retry
    const backoffTime = BACKOFF_MS * attempt;
    console.log(`Browserless retry ${attempt + 1}/${MAX_ATTEMPTS} after ${backoffTime}ms backoff...`);
    await sleep(backoffTime);
  }
  
  return lastResult!;
}

// ScrapingBee removed - using Browserless only

// Track if controller is still valid
const controllerValid = new WeakSet<SSEController>();

function sendSSE(controller: SSEController, event: string, data: any): boolean {
  try {
    if (!controllerValid.has(controller)) return false;
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    controller.enqueue(encoder.encode(message));
    return true;
  } catch (e) {
    console.log("SSE send failed (stream closed):", event);
    controllerValid.delete(controller);
    return false;
  }
}

function sendProgress(controller: SSEController, step: string, detail?: string, meta?: Record<string, any>): boolean {
  return sendSSE(controller, "progress", { step, detail, timestamp: Date.now(), ...meta });
}

// Send a dedicated status update event to sync frontend stage tracking
function sendStatusUpdate(controller: SSEController, status: string): boolean {
  return sendSSE(controller, "status_update", { status, timestamp: Date.now() });
}

function markControllerValid(controller: SSEController) {
  controllerValid.add(controller);
}

function markControllerInvalid(controller: SSEController) {
  controllerValid.delete(controller);
}

// ============================================================================
// Stage Telemetry - Records timing for each pipeline stage
// ============================================================================

type PipelineStageId = 
  | 'analyze_listing'
  | 'collect_photos'
  | 'find_matches'
  | 'validate_dates'
  | 'collect_prices'
  | 'finalize_results';

type StageOutcome = 'running' | 'success' | 'partial' | 'failed' | 'skipped' | 'cancelled';

interface StageRun {
  id: string;
  stageId: PipelineStageId;
  startedAt: number; // timestamp ms
}

// Track active stage runs per search
const activeStageRuns = new Map<string, StageRun>();

async function startStageRun(
  supabase: any,
  searchId: string,
  stageId: PipelineStageId,
  metadata?: Record<string, any>
): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('search_stage_runs')
      .insert({
        search_id: searchId,
        stage_name: stageId,
        started_at: new Date().toISOString(),
        outcome_status: 'running',
        metadata: metadata || {},
      })
      .select('id')
      .single();

    if (error) {
      console.error(`Failed to start stage ${stageId}:`, error.message);
      return null;
    }

    const runId = data.id;
    activeStageRuns.set(`${searchId}:${stageId}`, {
      id: runId,
      stageId,
      startedAt: Date.now(),
    });

    console.log(`STAGE START: ${stageId} for search ${searchId.slice(0, 8)}...`);
    return runId;
  } catch (e) {
    console.error(`Failed to start stage ${stageId}:`, e);
    return null;
  }
}

async function finishStageRun(
  supabase: any,
  searchId: string,
  stageId: PipelineStageId,
  outcome: StageOutcome,
  errorMessage?: string
): Promise<void> {
  try {
    const key = `${searchId}:${stageId}`;
    const activeRun = activeStageRuns.get(key);
    
    if (!activeRun) {
      console.warn(`No active stage run found for ${stageId}`);
      return;
    }

    const durationMs = Date.now() - activeRun.startedAt;
    
    await supabase
      .from('search_stage_runs')
      .update({
        finished_at: new Date().toISOString(),
        outcome_status: outcome,
        error_message: errorMessage || null,
      })
      .eq('id', activeRun.id);

    activeStageRuns.delete(key);
    console.log(`STAGE END: ${stageId} (${outcome}) - ${durationMs}ms`);
  } catch (e) {
    console.error(`Failed to finish stage ${stageId}:`, e);
  }
}

// Convenience wrapper for running a stage with automatic timing
async function withStageTelemetry<T>(
  supabase: any,
  searchId: string,
  stageId: PipelineStageId,
  operation: () => Promise<T>,
  options?: { metadata?: Record<string, any> }
): Promise<{ result: T | null; outcome: StageOutcome; error?: string }> {
  await startStageRun(supabase, searchId, stageId, options?.metadata);
  
  try {
    const result = await operation();
    await finishStageRun(supabase, searchId, stageId, 'success');
    return { result, outcome: 'success' };
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : 'Unknown error';
    await finishStageRun(supabase, searchId, stageId, 'failed', errorMsg);
    return { result: null, outcome: 'failed', error: errorMsg };
  }
}

// ============================================================================


// SerpAPI error types for proper error handling
type SerpApiErrorType = 
  | 'invalid_key'      // 401 - Invalid API key
  | 'quota_exceeded'   // 402 - Account quota exhausted
  | 'rate_limited'     // 429 - Too many requests
  | 'server_error'     // 5xx - SerpAPI server error
  | 'timeout'          // Request timeout
  | 'network_error'    // Network/fetch error
  | 'unknown';         // Unknown error

interface SerpApiResult<T> {
  success: boolean;
  data?: T;
  error?: {
    type: SerpApiErrorType;
    message: string;
    statusCode?: number;
  };
}

// Helper function to make SerpAPI requests with proper error handling
async function fetchSerpApi<T = any>(
  endpoint: string,
  apiKey: string,
  timeoutMs = 30000
): Promise<SerpApiResult<T>> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    
    const response = await fetch(`https://serpapi.com/search.json?${endpoint}&api_key=${apiKey}`, {
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    
    // Handle specific HTTP error codes
    if (!response.ok) {
      const statusCode = response.status;
      let errorType: SerpApiErrorType = 'unknown';
      let message = `SerpAPI request failed with status ${statusCode}`;
      
      switch (statusCode) {
        case 401:
          errorType = 'invalid_key';
          message = 'SerpAPI key is invalid or expired';
          break;
        case 402:
          errorType = 'quota_exceeded';
          message = 'SerpAPI account quota has been exhausted';
          break;
        case 429:
          errorType = 'rate_limited';
          message = 'SerpAPI rate limit exceeded - too many requests';
          break;
        default:
          if (statusCode >= 500) {
            errorType = 'server_error';
            message = `SerpAPI server error (${statusCode})`;
          }
      }
      
      console.error(`SERPAPI_ERROR [${errorType}]: ${message}`);
      return { success: false, error: { type: errorType, message, statusCode } };
    }
    
    const data = await response.json();
    
    // Check for error in response body (SerpAPI sometimes returns 200 with error)
    if (data.error) {
      console.error(`SERPAPI_RESPONSE_ERROR: ${data.error}`);
      return { 
        success: false, 
        error: { 
          type: 'unknown', 
          message: typeof data.error === 'string' ? data.error : JSON.stringify(data.error) 
        } 
      };
    }
    
    return { success: true, data: data as T };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    let errorType: SerpApiErrorType = 'network_error';
    
    if (errorMessage.includes('aborted') || errorMessage.includes('timeout')) {
      errorType = 'timeout';
    }
    
    console.error(`SERPAPI_FETCH_ERROR [${errorType}]: ${errorMessage}`);
    return { success: false, error: { type: errorType, message: errorMessage } };
  }
}

// Track SerpAPI errors during a search session
interface ApiErrorTracker {
  serpApiErrors: Array<{ type: SerpApiErrorType; message: string; timestamp: number }>;
  hasQuotaError: boolean;
  hasRateLimitError: boolean;
  consecutiveErrors: number;
}

function createApiErrorTracker(): ApiErrorTracker {
  return {
    serpApiErrors: [],
    hasQuotaError: false,
    hasRateLimitError: false,
    consecutiveErrors: 0,
  };
}

function recordApiError(tracker: ApiErrorTracker, error: { type: SerpApiErrorType; message: string }): void {
  tracker.serpApiErrors.push({ ...error, timestamp: Date.now() });
  tracker.consecutiveErrors++;
  
  if (error.type === 'quota_exceeded') {
    tracker.hasQuotaError = true;
  }
  if (error.type === 'rate_limited') {
    tracker.hasRateLimitError = true;
  }
}

function resetConsecutiveErrors(tracker: ApiErrorTracker): void {
  tracker.consecutiveErrors = 0;
}

function shouldAbortDueToApiErrors(tracker: ApiErrorTracker): boolean {
  // Abort if we hit quota or have too many consecutive errors
  return tracker.hasQuotaError || tracker.consecutiveErrors >= 5;
}

function getApiErrorSummary(tracker: ApiErrorTracker): string | null {
  if (tracker.serpApiErrors.length === 0) return null;
  
  if (tracker.hasQuotaError) {
    return 'Search service quota exceeded - please try again later';
  }
  if (tracker.hasRateLimitError) {
    return 'Search service temporarily rate limited';
  }
  if (tracker.consecutiveErrors >= 5) {
    return 'Search service experiencing connectivity issues';
  }
  
  return `Search API errors: ${tracker.serpApiErrors.length}`;
}

interface SearchResult {
  platform_name: string;
  listing_url: string;
  listing_title: string | null;
  price: number | null;
  confidence_score: number | null; // null for text-only matches (no visual confirmation)
  image_url: string | null;
  images: string[];
  match_type: 'visual' | 'text'; // Track how match was found
  total_price?: number | null;
  per_night_rate?: number | null;
  source_airbnb_image?: string | null; // The Airbnb image that was used for this match
  price_check_in?: string | null; // Actual dates used for price (may differ from original)
  price_check_out?: string | null;
  dates_differ?: boolean; // True if different dates were used due to unavailability
}

// Use Lovable AI to compare two images and return similarity score (0-100)
// STRICT COMPARISON: Prefers false negatives over false positives
async function compareImagesWithAI(
  airbnbImageUrl: string, 
  alternativeImageUrl: string
): Promise<{ score: number; isMatch: boolean; explanation: string }> {
  const lovableApiKey = Deno.env.get("LOVABLE_API_KEY");
  if (!lovableApiKey) {
    console.log("LOVABLE_API_KEY not available for AI image comparison");
    return { score: 0, isMatch: false, explanation: "AI comparison unavailable" };
  }
  
  try {
    // Enhanced prompt with strict, evidence-driven comparison
    const prompt = `You are a strict forensic image analyst. Your task is to determine whether these two property photos show the EXACT SAME real-world property (same apartment, room, house, building).

CRITICAL RULES - BE CONSERVATIVE:
1. High trust scores (90%+) are RARE and require STRONG evidence
2. It is BETTER to rate a match too LOW than to incorrectly confirm different properties as the same
3. If you have ANY doubt, reduce the score significantly
4. Similar-looking properties are NOT the same property

FOCUS ON FIXED/PERMANENT FEATURES (these rarely change):
- Room geometry: exact wall angles, ceiling height, room shape
- Window placement: exact position, size, shape, number
- Door placement and type
- Architectural details: columns, beams, moldings, built-in shelving
- Kitchen layout: counter shape, cabinet arrangement, appliance positions
- Bathroom fixtures: exact toilet/sink/tub positions
- Flooring pattern and type
- View from windows (if visible)

DO NOT rely heavily on:
- Colors (can be edited, lighting changes)
- Lighting conditions (photos at different times)
- Movable furniture (beds, chairs, tables, decorations)
- Plants, artwork, curtains, rugs (easily changed)
- Photo angle alone (similar angles don't prove same property)

STRUCTURAL DIFFERENCES = NOT THE SAME:
If you see ANY structural difference (different window positions, different room shape, different ceiling, different floor plan), the score MUST be below 70%.

SCORING GUIDELINES:
- 95-100%: Absolutely certain - identical structural features, unmistakable match
- 90-94%: Very confident - same structure, minor angle/lighting differences
- 70-89%: Uncertain - similar but not confirmed (DO NOT mark as match)
- 40-69%: Unlikely - some similarities but notable differences
- 0-39%: Different properties

Compare these images:
Image 1 (Source/Airbnb): ${airbnbImageUrl}
Image 2 (Alternative): ${alternativeImageUrl}

Analyze the STRUCTURAL features carefully. List specific evidence for or against a match.

Return ONLY valid JSON in this format:
{"score": NUMBER_0_TO_100, "isMatch": BOOLEAN, "explanation": "Evidence-based reason citing specific structural features"}

isMatch must be true ONLY if score >= 90 AND you have strong structural evidence.`;

    const response = await fetchWithTimeout(
      "https://ai.gateway.lovable.dev/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${lovableApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                { type: "image_url", image_url: { url: airbnbImageUrl } },
                { type: "image_url", image_url: { url: alternativeImageUrl } },
              ],
            },
          ],
          max_tokens: 300,
        }),
      },
      15_000
    );
    
    if (!response.ok) {
      console.error("Lovable AI image comparison failed:", response.status);
      return { score: 0, isMatch: false, explanation: "AI comparison request failed" };
    }
    
    const data = await response.json();
    const resultText = data.choices?.[0]?.message?.content?.trim();
    
    if (!resultText) {
      console.log("AI returned empty response for image comparison");
      return { score: 0, isMatch: false, explanation: "Empty AI response" };
    }
    
    // Parse JSON response
    try {
      // Extract JSON from response (may have markdown formatting)
      const jsonMatch = resultText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        let score = Number(parsed.score) || 0;
        score = Math.min(100, Math.max(0, score));
        
        // Extra conservative check: only mark as match if BOTH score >= 90 AND AI explicitly said isMatch
        const aiSaidMatch = parsed.isMatch === true;
        const scoreIsHigh = score >= 90;
        const isMatch = aiSaidMatch && scoreIsHigh;
        
        // Log comparison result for debugging
        console.log(`AI comparison: score=${score}, aiSaidMatch=${aiSaidMatch}, final isMatch=${isMatch}`);
        
        return {
          score,
          isMatch,
          explanation: parsed.explanation || "No explanation provided"
        };
      }
    } catch (parseError) {
      console.error("Failed to parse AI comparison response:", resultText);
    }
    
    return { score: 0, isMatch: false, explanation: "Failed to parse AI response" };
  } catch (error) {
    console.error("AI image comparison error:", error);
    return { score: 0, isMatch: false, explanation: "Comparison error" };
  }
}

// Try to extract price from JSON-LD structured data (most reliable for Airbnb)
function extractPriceFromJsonLD(content: string): number | null {
  try {
    // Look for JSON-LD script tags
    const jsonLdMatches = content.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
    if (jsonLdMatches) {
      for (const match of jsonLdMatches) {
        const jsonContent = match.replace(/<script[^>]*>|<\/script>/gi, '');
        try {
          const data = JSON.parse(jsonContent);
          // Check for offers/price in structured data
          if (data.offers?.price) {
            const price = parseFloat(data.offers.price);
            if (price >= 15 && price <= 5000) {
              console.log("JSON-LD extracted price:", price);
              return price;
            }
          }
          if (data.priceRange) {
            const priceMatch = data.priceRange.match(/\$?(\d+)/);
            if (priceMatch) {
              const price = parseFloat(priceMatch[1]);
              if (price >= 15 && price <= 5000) {
                console.log("JSON-LD priceRange extracted:", price);
                return price;
              }
            }
          }
        } catch (e) {
          // Continue to next JSON-LD block
        }
      }
    }
  } catch (e) {
    console.error("JSON-LD extraction error:", e);
  }
  return null;
}

// Try to extract TOTAL STAY PRICE with regex patterns first (faster, more reliable for common formats)
// Returns TOTAL price for the entire stay and detected currency, NOT per-night
function extractTotalPriceWithRegex(content: string, nights: number): { price: number | null; currency: string } {
  console.log("Attempting regex TOTAL price extraction, content length:", content.length, "nights:", nights);
  
  // Collect all potential totals with their currencies and priority (higher = more trusted)
  let potentialTotals: { price: number; currency: string; priority: number; source: string }[] = [];
  
  // Priority 4 (HIGHEST): Final guest-facing totals (includes taxes) when visible
  // Examples: "Total USD $2,213.34" or "Total $2,213.34" at bottom of breakdown
  const finalTotalPatterns: { pattern: RegExp; currency: string }[] = [
    // "Total USD $2,213.34" (allow weird spacing / NBSP / optional $)
    { pattern: /\btotal\s*USD\s*\$?\s*([\d,.]+)\b/gi, currency: 'USD' },
    { pattern: /\btotal\s*EUR\s*€?\s*([\d,.]+)\b/gi, currency: 'EUR' },
    { pattern: /\btotal\s*GBP\s*£?\s*([\d,.]+)\b/gi, currency: 'GBP' },
    { pattern: /\btotal\s*CHF\s*CHF\s*([\d,.]+)\b/gi, currency: 'CHF' },

    // Sometimes: "$2,213.34 Total USD"
    { pattern: /\$\s*([\d,.]+)\s*\btotal\s*USD\b/gi, currency: 'USD' },
    { pattern: /€\s*([\d,.]+)\s*\btotal\s*EUR\b/gi, currency: 'EUR' },
    { pattern: /£\s*([\d,.]+)\s*\btotal\s*GBP\b/gi, currency: 'GBP' },

    // US$2,213.34 Total
    { pattern: /US\$\s*([\d,.]+)\s*\btotal\b/gi, currency: 'USD' },

    // Generic "Total: $X" style (lowest within this tier)
    { pattern: /\btotal\b\s*[:\s]+\$\s*([\d,.]+)\b/gi, currency: 'USD' },
    { pattern: /\btotal\b\s*[:\s]+€\s*([\d,.]+)\b/gi, currency: 'EUR' },
    { pattern: /\btotal\b\s*[:\s]+£\s*([\d,.]+)\b/gi, currency: 'GBP' },
  ];

  for (const { pattern, currency } of finalTotalPatterns) {
    const matches = [...content.matchAll(pattern)];
    for (const match of matches) {
      const raw = (match[1] || "").trim();
      const normalized = raw
        .replace(/\s/g, '')
        .replace(/,/g, '')
        .replace(/(\d)\.(\d)\.(\d)/g, '$1$2.$3'); // ultra-rare: double dots
      const totalPrice = parseFloat(normalized);
      if (Number.isFinite(totalPrice) && totalPrice >= 30 && totalPrice <= 500000) {
        console.log(`[P4-FINAL] Found: ${currency} ${totalPrice} from "${match[0].slice(0, 80)}"`);
        potentialTotals.push({ price: totalPrice, currency, priority: 4, source: 'final_total' });
      }
    }
  }

  // Priority 3: Look for EXPLICIT TOTAL labels (often excludes taxes)
  // "Total before taxes" is Airbnb's label that includes cleaning fee + service fee
  const explicitTotalPatterns: { pattern: RegExp; currency: string }[] = [
    // "$2,214 Total before taxes" or "Total before taxes $2,214" (with flexible spacing)
    { pattern: /\$\s*([\d,]+(?:\.\d{2})?)\s*total\s*before\s*taxes/gi, currency: 'USD' },
    { pattern: /total\s*before\s*taxes\s*\$\s*([\d,]+(?:\.\d{2})?)/gi, currency: 'USD' },
    { pattern: /€\s*([\d,]+(?:\.\d{2})?)\s*total\s*before\s*taxes/gi, currency: 'EUR' },
    { pattern: /total\s*before\s*taxes\s*€\s*([\d,]+(?:\.\d{2})?)/gi, currency: 'EUR' },
    { pattern: /£\s*([\d,]+(?:\.\d{2})?)\s*total\s*before\s*taxes/gi, currency: 'GBP' },
    { pattern: /total\s*before\s*taxes\s*£\s*([\d,]+(?:\.\d{2})?)/gi, currency: 'GBP' },

    // "Trip total" / "Grand total" patterns
    { pattern: /trip\s+total\s*[:\s]*\$\s*([\d,]+(?:\.\d{2})?)/gi, currency: 'USD' },
    { pattern: /grand\s+total\s*[:\s]*\$\s*([\d,]+(?:\.\d{2})?)/gi, currency: 'USD' },
    { pattern: /trip\s+total\s*[:\s]*€\s*([\d,]+(?:\.\d{2})?)/gi, currency: 'EUR' },
    { pattern: /grand\s+total\s*[:\s]*€\s*([\d,]+(?:\.\d{2})?)/gi, currency: 'EUR' },

    // "You pay $X" / "You will pay $X"
    { pattern: /you\s+(?:will\s+)?pay\s*[:\s]*\$\s*([\d,]+(?:\.\d{2})?)/gi, currency: 'USD' },
    { pattern: /you\s+(?:will\s+)?pay\s*[:\s]*€\s*([\d,]+(?:\.\d{2})?)/gi, currency: 'EUR' },
  ];

  for (const { pattern, currency } of explicitTotalPatterns) {
    const matches = [...content.matchAll(pattern)];
    for (const match of matches) {
      const totalPrice = parseFloat((match[1] || "").replace(/,/g, ''));
      if (totalPrice >= 30 && totalPrice <= 500000) {
        console.log(`[P3-EXPLICIT] Found: ${currency} ${totalPrice} from "${match[0].slice(0, 80)}"`);
        potentialTotals.push({ price: totalPrice, currency, priority: 3, source: 'explicit_total' });
      }
    }
  }

  // Priority 2: "$X for Y nights" headline is treated as SUBTOTAL ONLY.
  // It is not a proven trip total (taxes/fees may be missing or revealed only in the breakdown).
  // We intentionally do NOT accept it here; the caller will fall back to needs_user_confirmation.
  // (Subtotal extraction is handled separately.)
  // Priority 1: General "Total" patterns (may include subtotals, less reliable)
  const generalTotalPatterns: { pattern: RegExp; currency: string }[] = [
    // "Total $2,214" or "Total: $2,214" (word boundary to avoid "Subtotal")
    { pattern: /\btotal\b[:\s]+\$\s*([\d,]+(?:\.\d{2})?)/gi, currency: 'USD' },
    { pattern: /\btotal\b[:\s]+€\s*([\d,]+(?:\.\d{2})?)/gi, currency: 'EUR' },
    { pattern: /\btotal\b[:\s]+£\s*([\d,]+(?:\.\d{2})?)/gi, currency: 'GBP' },
    
    // "Total (USD) $2,214"
    { pattern: /total\s*\(USD\)[:\s]*\$\s*([\d,]+(?:\.\d{2})?)/gi, currency: 'USD' },
    { pattern: /total\s*\(EUR\)[:\s]*€\s*([\d,]+(?:\.\d{2})?)/gi, currency: 'EUR' },
  ];
  
  for (const { pattern, currency } of generalTotalPatterns) {
    const matches = [...content.matchAll(pattern)];
    for (const match of matches) {
      const totalPrice = parseFloat((match[1] || "").replace(/,/g, ''));
      if (totalPrice >= 30 && totalPrice <= 500000) {
        console.log(`[P1-GENERAL] Found: ${currency} ${totalPrice} from "${match[0].slice(0, 80)}"`);
        potentialTotals.push({ price: totalPrice, currency, priority: 1, source: 'general_total' });
      }
    }
  }
  
  // Priority 0 (LOWEST): Currency prefix patterns as last resort (e.g., "US$2,214")
  const currencyPrefixPatterns: { pattern: RegExp; currency: string }[] = [
    { pattern: /US\$\s*([\d,]+(?:\.\d{2})?)/gi, currency: 'USD' },
    { pattern: /"totalPrice"[:\s]*"?\$?\s*([\d,]+(?:\.\d{2})?)"?/gi, currency: 'USD' },
  ];
  
  for (const { pattern, currency } of currencyPrefixPatterns) {
    const matches = [...content.matchAll(pattern)];
    for (const match of matches) {
      const totalPrice = parseFloat((match[1] || "").replace(/,/g, ''));
      if (totalPrice >= 30 && totalPrice <= 500000) {
        console.log(`[P0-FALLBACK] Found: ${currency} ${totalPrice} from "${match[0].slice(0, 80)}"`);
        potentialTotals.push({ price: totalPrice, currency, priority: 0, source: 'fallback' });
      }
    }
  }
  
  if (potentialTotals.length > 0) {
    // First sort by priority (highest first), then by price (highest first within same priority)
    // This ensures "Total before taxes" beats "X for Y nights" which beats general totals
    potentialTotals.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return b.price - a.price;
    });
    
    const best = potentialTotals[0];
    const allCandidates = potentialTotals.map(t => `${t.source}:${t.currency}${t.price}(p${t.priority})`).join(', ');
    console.log(`Regex extraction: Using ${best.source} ${best.currency} ${best.price} (p${best.priority}) from ${potentialTotals.length} candidates: [${allCandidates}]`);
    
    // CRITICAL: If we found both "for X nights" and explicit total, prefer explicit total
    // But if only "for X nights" found, use the HIGHEST price from that pattern
    // (Airbnb may show base in one place and total in another)
    const forNightsPrices = potentialTotals.filter(t => t.source === 'for_nights');
    const explicitTotals = potentialTotals.filter(t => t.priority >= 3);
    
    if (explicitTotals.length > 0) {
      // Use explicit total - most reliable
      return { price: explicitTotals[0].price, currency: explicitTotals[0].currency };
    }
    
    if (forNightsPrices.length > 0) {
      // Use highest "for X nights" price - may have base and total from same pattern
      const highest = forNightsPrices.reduce((max, t) => t.price > max.price ? t : max);
      console.log(`Using highest 'for X nights' price: ${highest.currency} ${highest.price}`);
      return { price: highest.price, currency: highest.currency };
    }
    
    return { price: best.price, currency: best.currency };
  }
  
  // DO NOT derive totals from nightly rates
  // We must show the total Airbnb actually displays
  console.log("Regex extraction: No total price pattern found");
  return { price: null, currency: 'USD' };
}


// ============================================================================
// Grounded Airbnb price extraction (no guessing, always evidence + debug)
// ============================================================================

type AirbnbBaselineStatus =
  | 'total_price_including_taxes_and_fees'
  | 'total_price_excluding_taxes_and_fees'
  | 'needs_user_confirmation'
  | 'price_not_available_in_content'
  | 'dates_unavailable'
  | 'rate_limited';

type PriceCandidate = {
  rawMatch: string; // verbatim matched string (includes currency symbol/label when possible)
  amountRaw: string;
  amount: number;
  currency: string;
  index: number;
  context: string; // +/- context window
  labelHint: string; // extracted label-ish context
  kind: AirbnbBaselineStatus;
  includesTaxesFees: boolean;
  score: number;
  rejectedReason?: string;
};

type AirbnbBaselineExtraction = {
  status: AirbnbBaselineStatus;
  price: number | null;
  currency: string | null;
  includes_taxes_fees: boolean;
  evidence_snippet: string;
  // Subtotal info when only a subtotal (e.g., "$X for N nights") is found
  subtotal_nights_only?: number | null;
  subtotal_nights_count?: number | null;
  debug: {
    provider: string;
    content_hash: string;
    candidates: Array<{
      amount: number;
      currency: string;
      kind: AirbnbBaselineStatus;
      includes_taxes_fees: boolean;
      score: number;
      labelHint: string;
      context: string;
      rejectedReason?: string;
    }>;
    selected?: {
      amount: number;
      currency: string;
      kind: AirbnbBaselineStatus;
      includes_taxes_fees: boolean;
      score: number;
      labelHint: string;
      context: string;
      selection_reason: string;
    };
  };
};

function normalizeAmount(raw: string): number | null {
  const cleaned = raw
    .replace(/\s/g, '')
    .replace(/,(?=\d{3}(?:\D|$))/g, '') // remove thousand separators
    .replace(/(\d)\.(\d)\.(\d)/g, '$1$2.$3');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function safeSnippet(s: string, max = 260): string {
  return (s || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function extractAirbnbPriceCandidates(content: string, nights: number): PriceCandidate[] {
  const lower = content.toLowerCase();

  // Broad money patterns; we will classify using nearby label context.
  const moneyPatterns: Array<{ currency: string; re: RegExp }> = [
    { currency: 'USD', re: /(\$\s*[\d,.]+(?:\.\d{2})?)/g },
    { currency: 'EUR', re: /(€\s*[\d,.]+(?:\.\d{2})?)/g },
    { currency: 'GBP', re: /(£\s*[\d,.]+(?:\.\d{2})?)/g },
    { currency: 'CHF', re: /(CHF\s*[\d,.]+(?:\.\d{2})?)/gi },
    { currency: 'AUD', re: /(A\$\s*[\d,.]+(?:\.\d{2})?)/gi },
    { currency: 'CAD', re: /(C\$\s*[\d,.]+(?:\.\d{2})?)/gi },
    { currency: 'USD', re: /(US\$\s*[\d,.]+(?:\.\d{2})?)/gi },
  ];

  const candidates: PriceCandidate[] = [];

  for (const { currency, re } of moneyPatterns) {
    let match: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((match = re.exec(content)) !== null) {
      const rawMatch = match[1];
      const index = match.index;
      const amountRaw = rawMatch.replace(/[^0-9.,]/g, '');
      const amount = normalizeAmount(amountRaw);
      if (!amount || amount < 10 || amount > 500000) continue;

      const start = Math.max(0, index - 120);
      const end = Math.min(content.length, index + rawMatch.length + 120);
      const context = content.slice(start, end);
      const ctxLower = context.toLowerCase();

      // Hard ignore contexts (non-total signals)
      const ignoreTerms = [
        'per night',
        '/night',
        'nightly',
        'from ',
        'starting at',
        'save ',
        'discount',
        'was ',
        'original',
        'crossed',
        'strikethrough',
        'before discount',
        'coupon',
      ];

      const ignoreHit = ignoreTerms.find((t) => ctxLower.includes(t));
      if (ignoreHit) {
        candidates.push({
          rawMatch,
          amountRaw,
          amount,
          currency,
          index,
          context: safeSnippet(context, 240),
          labelHint: safeSnippet(context, 120),
          kind: 'price_not_available_in_content',
          includesTaxesFees: false,
          score: -10,
          rejectedReason: `ignored_due_to_term:${ignoreHit}`,
        });
        continue;
      }

      // Fee/deposit lines are NEVER trip totals (even if the word "total" appears nearby in the UI)
      const feeTerms = ['pet', 'pets', 'deposit', 'damage', 'security'];
      const feeHit = feeTerms.find((t) => ctxLower.includes(t));
      if (feeHit) {
        candidates.push({
          rawMatch,
          amountRaw,
          amount,
          currency,
          index,
          context: safeSnippet(context, 240),
          labelHint: safeSnippet(context, 120),
          kind: 'price_not_available_in_content',
          includesTaxesFees: false,
          score: -10,
          rejectedReason: `fee_context:${feeHit}`,
        });
        continue;
      }

      // Classify using label context (must be *explicit* total labels; plain "total" is too error-prone).
      const hasTotalLabel = /\b(trip total|grand total|total before taxes|total\s*USD|you pay|you will pay)\b/i.test(context);
      const hasTaxesFeesLabel = /\b(includes\s+taxes|incl\.?\s+taxes|taxes\s+and\s+fees|including\s+taxes|includes\s+fees|incl\.?\s+fees)\b/i.test(context);
      const hasBeforeTaxesLabel = /\btotal\s+before\s+taxes\b/i.test(context);
      const hasForNights = new RegExp(`\\bfor\\s+${nights}\\s+nights?\\b`, 'i').test(context) || /\bfor\s+\d+\s+nights?\b/i.test(context);
      const hasNightOnly = /\bper\s+night\b|\/night|\bnightly\b/i.test(context);
      
      // CRITICAL: Check for book/stays checkout page payment patterns (HIGHEST PRIORITY)
      // These are the all-in totals including taxes and fees
      // IMPORTANT: We must verify the CURRENT matched amount is the one in the total pattern,
      // not just that the pattern exists in the context window (which could include nearby totals)
      
      // Check if this specific amount appears directly after "Pay $X now" or "Total USD $X"
      const payNowMatch = context.match(/\bpay\s*\$([\d,]+(?:\.\d{2})?)\s*now\b/i);
      const payNowAmount = payNowMatch ? normalizeAmount(payNowMatch[1] || '') : null;
      const hasPayNowPattern = payNowAmount !== null && Math.abs(payNowAmount - amount) < 0.01;
      
      const totalUsdMatch = context.match(/\btotal\s*\(?\s*USD\s*\)?\s*\$([\d,]+(?:\.\d{2})?)/i);
      const totalUsdAmount = totalUsdMatch ? normalizeAmount(totalUsdMatch[1] || '') : null;
      const hasTotalUsdPattern = totalUsdAmount !== null && Math.abs(totalUsdAmount - amount) < 0.01;
      
      const hasDueToday = /\bdue\s+today\b/i.test(context);
      const hasAmountDue = /\bamount\s+due\b/i.test(context);
      const hasCheckoutTotal = hasPayNowPattern || hasTotalUsdPattern || hasDueToday || hasAmountDue;

      let kind: AirbnbBaselineStatus = 'price_not_available_in_content';
      let includesTaxesFees = false;
      let score = 0;

      // Nightly-only prices are NOT acceptable - treat as failure
      if (hasNightOnly) {
        candidates.push({
          rawMatch,
          amountRaw,
          amount,
          currency,
          index,
          context: safeSnippet(context, 240),
          labelHint: safeSnippet(context, 120),
          kind: 'price_not_available_in_content',
          includesTaxesFees: false,
          score: -10,
          rejectedReason: `nightly_price_only:${safeSnippet(context, 60)}`,
        });
        continue;
      }

      // CRITICAL FIX: "$X for N nights" is a SUBTOTAL, NOT a total - ALWAYS REJECT
      // This was the root cause of the regression - these should trigger needs_user_confirmation
      if (hasForNights && !hasCheckoutTotal && !hasTotalLabel) {
        candidates.push({
          rawMatch,
          amountRaw,
          amount,
          currency,
          index,
          context: safeSnippet(context, 240),
          labelHint: safeSnippet(context, 120),
          kind: 'price_not_available_in_content',
          includesTaxesFees: false,
          score: -5,
          rejectedReason: 'subtotal_for_nights_only',
        });
        continue;
      }

      // HIGHEST PRIORITY: Checkout page payment totals (all-in with taxes/fees)
      if (hasCheckoutTotal) {
        includesTaxesFees = true;
        kind = 'total_price_including_taxes_and_fees';
        score = 20; // Higher than any other pattern
        console.log(`Found checkout total: ${rawMatch} in context: ${safeSnippet(context, 80)}`);
      } else if (hasTotalLabel) {
        kind = hasBeforeTaxesLabel ? 'total_price_excluding_taxes_and_fees' : 'total_price_excluding_taxes_and_fees';
        score = 10;
      }

      // REMOVED: hasForNights scoring - "$X for N nights" is a subtotal, already rejected above

      if (hasTaxesFeesLabel) {
        includesTaxesFees = true;
        kind = 'total_price_including_taxes_and_fees';
        score = Math.max(score, 14);
      }

      // Prefer candidates near booking summary language
      const containerBoostTerms = ['price breakdown', 'booking', 'summary', 'total', 'trip total'];
      if (containerBoostTerms.some((t) => ctxLower.includes(t))) score += 2;

      // Penalize very small or suspiciously round values slightly
      if (amount < 30) score -= 1;

      candidates.push({
        rawMatch,
        amountRaw,
        amount,
        currency,
        index,
        context: safeSnippet(context, 240),
        labelHint: safeSnippet(context, 120),
        kind,
        includesTaxesFees,
        score,
      });
    }
  }

  // De-dupe exact same match+index
  const seen = new Set<string>();
  return candidates.filter((c) => {
    const k = `${c.index}:${c.rawMatch}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function validatePriceExtraction(
  content: string,
  selected: PriceCandidate
): { ok: boolean; reason?: string; evidence: string } {
  // Deterministic grounding checks:
  // 1) amount appears exactly as rawMatch in content
  // 2) currency is present in the same snippet (rawMatch includes it)
  // 3) label context exists in same section: total/trip total/for nights/taxes label
  const idx = content.indexOf(selected.rawMatch);
  const start = Math.max(0, (idx === -1 ? selected.index : idx) - 140);
  const end = Math.min(content.length, (idx === -1 ? selected.index : idx) + selected.rawMatch.length + 160);
  const snippet = safeSnippet(content.slice(start, end), 340);

  if (idx === -1) {
    return { ok: false, reason: 'raw_match_not_found_verbatim', evidence: snippet };
  }

  // Accept prices with explicit total labels, taxes/fees labels, OR checkout patterns
  // CRITICAL: "$X for N nights" is a SUBTOTAL, NOT a total - it must NOT pass validation as a total
  const hasExplicitTotalLabel =
    /\b(trip total|grand total|total before taxes|total\s*USD|you pay|you will pay)\b/i.test(snippet);
  const hasTaxesFeesLabel =
    /\b(includes\s+taxes|incl\.?\s+taxes|taxes\s+and\s+fees|including\s+taxes|includes\s+fees|incl\.?\s+fees)\b/i.test(snippet);
  
  // Book/stays checkout page patterns - these are the ONLY all-in totals we accept
  const hasCheckoutPayNow = /\bpay\s*\$[\d,]+(?:\.\d{2})?\s*now\b/i.test(snippet);
  const hasCheckoutTotalUsd = /\btotal\s*\(?\s*USD\s*\)?\s*\$/i.test(snippet);
  const hasDueToday = /\bdue\s+today\b/i.test(snippet);
  const hasAmountDue = /\bamount\s+due\b/i.test(snippet);
  const hasCheckoutPattern = hasCheckoutPayNow || hasCheckoutTotalUsd || hasDueToday || hasAmountDue;

  // REMOVED: hasForNightsAriaLabel - "$X for N nights" is a SUBTOTAL, not a total
  // This was the root cause of the regression - accepting subtotals as totals

  if (!hasExplicitTotalLabel && !hasTaxesFeesLabel && !hasCheckoutPattern) {
    return { ok: false, reason: 'missing_explicit_total_or_taxes_context', evidence: snippet };
  }

  // Currency is "present" if rawMatch includes the symbol/prefix already.
  const hasCurrency = /\$|€|£|\bCHF\b|\bUS\$\b|\bA\$\b|\bC\$\b/i.test(selected.rawMatch);
  if (!hasCurrency) {
    return { ok: false, reason: 'currency_missing_in_raw_match', evidence: snippet };
  }

  return { ok: true, evidence: snippet };
}

function extractAirbnbBaselineGrounded(
  content: string,
  nights: number,
  provider: string
): AirbnbBaselineExtraction {
  const contentHash = hashContent(content);
  const candidates = extractAirbnbPriceCandidates(content, nights);

  // Choose by score, then prefer taxes+fees proven, then prefer "total"-kind, then highest score.
  const usable = candidates
    .map((c) => {
      if (c.rejectedReason) return c;

      // Reject generic prices with no classification
      if (c.kind === 'price_not_available_in_content') {
        return { ...c, rejectedReason: 'unclassified_no_total_or_nights_context' };
      }

      const v = validatePriceExtraction(content, c);
      if (!v.ok) {
        return { ...c, rejectedReason: `validation_failed:${v.reason}` };
      }

      return c;
    });

  const accepted = usable.filter((c) => !c.rejectedReason);

  const sorted = [...accepted].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (Number(b.includesTaxesFees) !== Number(a.includesTaxesFees)) return Number(b.includesTaxesFees) - Number(a.includesTaxesFees);
    // Only total prices are valid; price_not_available_in_content should never be in accepted list
    const kindRank = (k: AirbnbBaselineStatus) =>
      k === 'total_price_including_taxes_and_fees' ? 3 : k === 'total_price_excluding_taxes_and_fees' ? 2 : 0;
    if (kindRank(b.kind) !== kindRank(a.kind)) return kindRank(b.kind) - kindRank(a.kind);
    return b.amount - a.amount;
  });

  const debugCandidates = usable.slice(0, 24).map((c) => ({
    amount: c.amount,
    currency: c.currency,
    kind: c.kind,
    includes_taxes_fees: c.includesTaxesFees,
    score: c.score,
    labelHint: safeSnippet(c.labelHint, 120),
    context: safeSnippet(c.context, 220),
    rejectedReason: c.rejectedReason,
  }));

  // Extract subtotal from "$X for N nights" patterns if no proven total is found
  function extractSubtotalFromContent(): { amount: number; currency: string; nights: number | null } | null {
    // Look for "$X for N nights" pattern specifically
    const subtotalPatterns: Array<{ re: RegExp; currency: string }> = [
      { re: /\$\s*([\d,]+(?:\.\d{2})?)\s+for\s+(\d+)\s*nights?/gi, currency: 'USD' },
      { re: /€\s*([\d,]+(?:\.\d{2})?)\s+for\s+(\d+)\s*nights?/gi, currency: 'EUR' },
      { re: /£\s*([\d,]+(?:\.\d{2})?)\s+for\s+(\d+)\s*nights?/gi, currency: 'GBP' },
    ];
    
    for (const { re, currency } of subtotalPatterns) {
      re.lastIndex = 0;
      const m = re.exec(content);
      if (m) {
        const amount = parseFloat((m[1] || '').replace(/,/g, ''));
        const nightsFound = parseInt(m[2], 10);
        if (amount >= 30 && amount <= 500000 && nightsFound > 0) {
          return { amount, currency, nights: nightsFound };
        }
      }
    }
    return null;
  }

  if (!sorted.length) {
    // No proven total found - check if we have a subtotal
    const subtotal = extractSubtotalFromContent();
    const fallbackEvidence = safeSnippet(content.replace(/<[^>]+>/g, ' '), 340);
    
    if (subtotal) {
      // We have a subtotal but no proven total - needs user confirmation
      return {
        status: 'needs_user_confirmation',
        price: null, // Don't return subtotal as the price
        currency: subtotal.currency,
        includes_taxes_fees: false,
        evidence_snippet: `$${subtotal.amount} for ${subtotal.nights} nights (subtotal only - taxes/fees not included)`,
        subtotal_nights_only: subtotal.amount,
        subtotal_nights_count: subtotal.nights,
        debug: {
          provider,
          content_hash: contentHash,
          candidates: debugCandidates,
        },
      };
    }
    
    return {
      status: 'price_not_available_in_content',
      price: null,
      currency: null,
      includes_taxes_fees: false,
      evidence_snippet: fallbackEvidence,
      debug: {
        provider,
        content_hash: contentHash,
        candidates: debugCandidates,
      },
    };
  }

  const selected = sorted[0];
  const validation = validatePriceExtraction(content, selected);

  // This should always be ok for selected, but keep deterministic guard.
  if (!validation.ok) {
    return {
      status: 'price_not_available_in_content',
      price: null,
      currency: null,
      includes_taxes_fees: false,
      evidence_snippet: validation.evidence,
      debug: {
        provider,
        content_hash: contentHash,
        candidates: debugCandidates,
      },
    };
  }

  // CRITICAL: We do NOT proceed with an Airbnb baseline unless we have an all-in total.
  // If we only found a "$X for N nights" / subtotal-style total (no taxes+fees proof), require user confirmation.
  if (!selected.includesTaxesFees) {
    return {
      status: 'needs_user_confirmation',
      price: null,
      currency: selected.currency,
      includes_taxes_fees: false,
      evidence_snippet: `${selected.rawMatch} (subtotal only - confirm total incl. taxes/fees)`,
      subtotal_nights_only: selected.amount,
      subtotal_nights_count: nights,
      debug: {
        provider,
        content_hash: contentHash,
        candidates: debugCandidates,
        selected: {
          amount: selected.amount,
          currency: selected.currency,
          kind: selected.kind,
          includes_taxes_fees: selected.includesTaxesFees,
          score: selected.score,
          labelHint: safeSnippet(selected.labelHint, 120),
          context: safeSnippet(selected.context, 220),
          selection_reason: 'best_candidate_was_not_taxes_inclusive',
        },
      },
    };
  }

  const selection_reason = `selected_highest_score_candidate(score=${selected.score}, kind=${selected.kind}, includes_taxes_fees=${selected.includesTaxesFees})`;

  return {
    status: selected.kind,
    price: selected.amount,
    currency: selected.currency,
    includes_taxes_fees: selected.includesTaxesFees,
    evidence_snippet: validation.evidence,
    debug: {
      provider,
      content_hash: contentHash,
      candidates: debugCandidates,
      selected: {
        amount: selected.amount,
        currency: selected.currency,
        kind: selected.kind,
        includes_taxes_fees: selected.includesTaxesFees,
        score: selected.score,
        labelHint: safeSnippet(selected.labelHint, 120),
        context: safeSnippet(selected.context, 220),
        selection_reason,
      },
    },
  };
}

// Use Lovable AI to extract Airbnb TOTAL STAY PRICE (including mandatory fees) from scraped content.
// Returns the TOTAL price for the entire stay and currency, NOT per-night.
// NOTE: This function is legacy; Airbnb baseline selection must be grounded by extractAirbnbBaselineGrounded().
async function extractAirbnbTotalPriceWithAI(content: string, nights: number): Promise<{ price: number | null; currency: string }> {

  const regexResult = extractTotalPriceWithRegex(content, nights);
  if (regexResult.price) {
    console.log("Using regex-extracted TOTAL price:", regexResult.price, regexResult.currency);
    return regexResult;
  }

  const lovableApiKey = Deno.env.get("LOVABLE_API_KEY");
  if (!lovableApiKey) {
    console.log("LOVABLE_API_KEY not available for AI price extraction");
    return { price: null, currency: 'USD' };
  }

  try {
    const prompt = `You are analyzing text scraped from an Airbnb listing page.
The stay is for exactly ${nights} night(s).

Goal: Extract the TOTAL price for the ENTIRE stay as shown by Airbnb (including mandatory fees/taxes if included in the displayed total).

Rules:
- Return the TOTAL price for the whole stay, NOT per-night.
- Prioritize the booking-widget headline like "$X for Y nights" (aria-label often contains it).
- If a price breakdown is present, prioritize "Total before taxes" or "Trip total".
- Do NOT return "Subtotal" / "x nights" line items if a higher total exists.
- IMPORTANT: If the page only shows a per-night rate and no total, return "null" (do NOT multiply).
- Also identify the currency symbol used: $=USD, €=EUR, £=GBP, CHF=CHF, A$=AUD, C$=CAD

Content:
${content.slice(0, 12000)}

Return ONLY JSON: {"price": <number|null>, "currency": "<USD|EUR|GBP|CHF|AUD|CAD>"}
If you cannot find a reliable total, return {"price": null, "currency": "USD"}.`;

    const response = await fetchWithTimeout(
      "https://ai.gateway.lovable.dev/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${lovableApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [{ role: "user", content: prompt }],
          max_tokens: 80,
        }),
      },
      15_000
    );

    if (!response.ok) {
      console.error("Lovable AI request failed:", response.status);
      return { price: null, currency: 'USD' };
    }

    const data = await response.json();
    const responseText = data.choices?.[0]?.message?.content?.trim();

    if (!responseText) {
      console.log("AI returned empty response");
      return { price: null, currency: 'USD' };
    }

    // Try to parse as JSON
    try {
      // Clean up markdown code blocks if present
      const cleanJson = responseText.replace(/```json\n?/gi, '').replace(/```\n?/gi, '').trim();
      const parsed = JSON.parse(cleanJson);
      const price = typeof parsed.price === 'number' && parsed.price >= 20 && parsed.price <= 500000 ? parsed.price : null;
      const currency = ['USD', 'EUR', 'GBP', 'CHF', 'AUD', 'CAD'].includes(parsed.currency) ? parsed.currency : 'USD';
      console.log("AI extracted TOTAL price:", price, currency, "for", nights, "nights");
      return { price, currency };
    } catch {
      // Fallback: try to extract just a number (legacy behavior)
      const total = parseFloat(responseText.replace(/[^0-9.]/g, ""));
      if (!isNaN(total) && total >= 20 && total <= 500000) {
        console.log("AI extracted TOTAL price (legacy):", total, "for", nights, "nights");
        return { price: total, currency: 'USD' };
      }
      console.log("AI returned invalid response:", responseText);
      return { price: null, currency: 'USD' };
    }
  } catch (error) {
    console.error("AI price extraction error:", error);
    return { price: null, currency: 'USD' };
  }
}

// Helper type for price extraction result
type PriceExtractionResult = { price: number | null; currency: string };

// Helper function to update price and currency from extraction result
function updatePriceFromResult(
  result: PriceExtractionResult,
  currentPrice: number | null,
  currentCurrency: string
): { price: number | null; currency: string } {
  if (result.price !== null) {
    return { price: result.price, currency: result.currency };
  }
  return { price: currentPrice, currency: currentCurrency };
}

// Wrapper to extract price from regex and return just the price (for backward compat during migration)
function extractPriceOnly(content: string, nights: number): number | null {
  return extractTotalPriceWithRegex(content, nights).price;
}

async function extractAlternativePlatformPriceWithAI(
  content: string,
  platformName: string,
  checkIn: string,
  checkOut: string,
  nights: number,
): Promise<{
  perNight: number | null;
  total: number | null;
  currency: string | null;
  confidence: "high" | "medium" | "low";
  datesConfirmed: boolean;
  reasoning?: string;
}> {
  const lovableApiKey = Deno.env.get("LOVABLE_API_KEY");
  if (!lovableApiKey) {
    console.log("LOVABLE_API_KEY not available for AI price extraction");
    return { perNight: null, total: null, currency: null, confidence: "low", datesConfirmed: false };
  }

  try {
    const prompt = `You are analyzing text scraped from a ${platformName} booking page.
The dates being checked are: ${checkIn} to ${checkOut} (${nights} night(s)).

Goal: Extract the booking price for THESE specific dates.

CRITICAL REQUIREMENT:
- You must first decide if the page content indicates the property is available AND the page is showing pricing for the requested dates.
- If you cannot CONFIRM the dates in the content, set datesConfirmed=false and do not guess a price.

Rules:
1) Look for prices clearly associated with booking this property.
2) Prefer TOTAL price for the stay (incl. mandatory fees/taxes if shown).
3) If only per-night is shown, return perNight.
4) Ignore prices that are review counts, distances, guest counts, or prices for other properties.
5) Be conservative: if you are not sure the price is for ${checkIn} to ${checkOut}, return nulls.

Scraped content (first 10000 chars):
${content.slice(0, 10000)}

Return ONLY JSON in this exact format:
{"total": <number|null>, "perNight": <number|null>, "currency": <string|null>, "confidence": "high"|"medium"|"low", "datesConfirmed": <true|false>, "reasoning": <string>}`;

    const response = await fetchWithTimeout(
      "https://ai.gateway.lovable.dev/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${lovableApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [{ role: "user", content: prompt }],
          max_tokens: 240,
        }),
      },
      20_000,
    );

    if (!response.ok) {
      console.error("AI price extraction failed:", response.status);
      return { perNight: null, total: null, currency: null, confidence: "low", datesConfirmed: false };
    }

    const data = await response.json();
    const responseText = data.choices?.[0]?.message?.content?.trim() || "";

    // Parse JSON from response (handle markdown code blocks)
    let jsonStr = responseText;
    const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    } else if (responseText.startsWith("{")) {
      jsonStr = responseText;
    }

    try {
      const parsed = JSON.parse(jsonStr);
      console.log(`AI price extraction for ${platformName}:`, parsed);

      const confidenceRaw = String(parsed.confidence || "low").toLowerCase();
      const confidence = (confidenceRaw === "high" || confidenceRaw === "medium" || confidenceRaw === "low")
        ? (confidenceRaw as "high" | "medium" | "low")
        : "low";

      const datesConfirmed = Boolean(parsed.datesConfirmed);

      // If dates are not confirmed, do not accept any price.
      if (!datesConfirmed) {
        return {
          perNight: null,
          total: null,
          currency: parsed.currency || null,
          confidence,
          datesConfirmed: false,
          reasoning: parsed.reasoning || undefined,
        };
      }

      // Validate the extracted prices
      let total = typeof parsed.total === "number" ? parsed.total : null;
      let perNight = typeof parsed.perNight === "number" ? parsed.perNight : null;

      // If only total is provided, calculate per-night
      if (total && !perNight && nights > 0) {
        perNight = Math.round(total / nights);
      }

      // If only per-night is provided, calculate total
      if (perNight && !total && nights > 0) {
        total = perNight * nights;
      }

      // Validate reasonable price ranges
      if (perNight && (perNight < 5 || perNight > 10000)) {
        console.log(`AI extracted unreasonable per-night price: ${perNight}`);
        return { perNight: null, total: null, currency: null, confidence: "low", datesConfirmed: false };
      }

      if (confidence === "low" && !perNight && !total) {
        return { perNight: null, total: null, currency: null, confidence: "low", datesConfirmed: false };
      }

      return {
        perNight: perNight || null,
        total: total || null,
        currency: parsed.currency || null,
        confidence,
        datesConfirmed,
        reasoning: parsed.reasoning || undefined,
      };
    } catch (parseErr) {
      console.error("Failed to parse AI response:", responseText.slice(0, 200));
      return { perNight: null, total: null, currency: null, confidence: "low", datesConfirmed: false };
    }
  } catch (error) {
    console.error("AI price extraction error:", error);
    return { perNight: null, total: null, currency: null, confidence: "low", datesConfirmed: false };
  }
}

// ============================================================================
// OCR Visual Reference Extraction - Ground truth from screenshots
// ============================================================================

// Extract OCR reference from screenshot using AI vision
async function extractOcrVisualReference(
  screenshotBase64: string,
  nights: number,
  breakdownOpened: boolean
): Promise<OcrVisualReference> {
  const lovableApiKey = Deno.env.get("LOVABLE_API_KEY");
  const emptyResult: OcrVisualReference = {
    bookingCardAmountRaw: null,
    bookingCardAmountValue: null,
    bookingCardNights: null,
    bookingCardSnippet: null,
    breakdownTotalAmountRaw: null,
    breakdownTotalAmountValue: null,
    breakdownTotalSnippet: null,
    breakdownTaxesAmountValue: null,
    breakdownOpened,
  };

  if (!lovableApiKey || !screenshotBase64) {
    console.log("OCR: No API key or screenshot available");
    return emptyResult;
  }

  try {
    // Enhanced prompt with explicit patterns and fallback logic for book/stays checkout pages
    // CRITICAL FIX: The OCR must reliably extract "Pay $X now" or "Total (USD) $X" patterns
    // v2.2: More explicit about scanning ENTIRE page, especially bottom sections for totals
    const prompt = `You are analyzing a screenshot of an Airbnb checkout page ("/book/stays/").

CRITICAL: This is a CHECKOUT page with "Confirm and pay" title. The FINAL TOTAL is what we need.

STEP 1 - SCAN THE ENTIRE PAGE for these patterns (especially bottom half):
- "Pay $X.XX now" (MOST IMPORTANT - this is the all-in total including taxes/fees)
- "Total (USD) $X.XX" or "Total USD $X.XX" 
- "Total $X.XX" near payment/checkout sections
- "Due today $X.XX"
- "Amount due $X.XX"

STEP 2 - ALSO find the subtotal:
- "$X.XX for N nights" (this is the SUBTOTAL, not including taxes/fees)

EXAMPLE:
If you see "$1,482 for 3 nights" and "Pay $1,658.94 now":
- bookingCardAmountValue = 1482 (the subtotal)
- breakdownTotalAmountValue = 1658.94 (the PAY NOW total - THIS IS WHAT WE NEED)

CRITICAL RULES:
1. The "Pay $X now" amount is ALWAYS larger than "$X for N nights" because it includes taxes
2. If you see ANY "Pay $X now" pattern, that X MUST go in breakdownTotalAmountValue
3. Look at the ENTIRE screenshot - the total is often near the bottom
4. The difference between subtotal and total = taxes and fees

Return ONLY valid JSON (no markdown):
{
  "bookingCardAmountRaw": "<exact subtotal text like '$1,482' or null>",
  "bookingCardAmountValue": <subtotal number or null>,
  "bookingCardNights": <nights number or null>,
  "bookingCardSnippet": "<full text like '$1,482 for 3 nights' or null>",
  "breakdownTotalAmountRaw": "<exact PAY NOW text like 'Pay $1,658.94 now' or 'Total (USD) $1,658.94' or null>",
  "breakdownTotalAmountValue": <the PAY NOW / TOTAL number including taxes - THIS IS CRITICAL>,
  "breakdownTotalSnippet": "<the full line containing the total>",
  "breakdownTaxesAmountValue": <taxes amount if shown separately, or null>
}

REMEMBER: breakdownTotalAmountValue should be LARGER than bookingCardAmountValue because it includes taxes.
If you only find "$X for N nights" without a "Pay now" or "Total" line, set breakdownTotalAmountValue to null.`;

    const imageUrl = `data:image/png;base64,${screenshotBase64}`;

    const response = await fetchWithTimeout(
      "https://ai.gateway.lovable.dev/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${lovableApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                { type: "image_url", image_url: { url: imageUrl } },
              ],
            },
          ],
          max_tokens: 300,
        }),
      },
      25_000
    );

    if (!response.ok) {
      console.error("OCR AI request failed:", response.status);
      return emptyResult;
    }

    const data = await response.json();
    const responseText = data.choices?.[0]?.message?.content?.trim() || "";

    // Parse JSON from response
    let jsonStr = responseText;
    const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    } else if (responseText.startsWith("{")) {
      jsonStr = responseText;
    }

    try {
      const parsed = JSON.parse(jsonStr);
      
      const result: OcrVisualReference = {
        bookingCardAmountRaw: typeof parsed.bookingCardAmountRaw === 'string' ? parsed.bookingCardAmountRaw : null,
        bookingCardAmountValue: typeof parsed.bookingCardAmountValue === 'number' ? parsed.bookingCardAmountValue : null,
        bookingCardNights: typeof parsed.bookingCardNights === 'number' ? parsed.bookingCardNights : null,
        bookingCardSnippet: typeof parsed.bookingCardSnippet === 'string' ? parsed.bookingCardSnippet : null,
        breakdownTotalAmountRaw: typeof parsed.breakdownTotalAmountRaw === 'string' ? parsed.breakdownTotalAmountRaw : null,
        breakdownTotalAmountValue: typeof parsed.breakdownTotalAmountValue === 'number' ? parsed.breakdownTotalAmountValue : null,
        breakdownTotalSnippet: typeof parsed.breakdownTotalSnippet === 'string' ? parsed.breakdownTotalSnippet : null,
        breakdownTaxesAmountValue: typeof parsed.breakdownTaxesAmountValue === 'number' ? parsed.breakdownTaxesAmountValue : null,
        breakdownOpened,
      };

      console.log("OCR extraction result:", JSON.stringify(result, null, 2));
      return result;
    } catch (parseErr) {
      console.error("OCR: Failed to parse AI response:", responseText.slice(0, 200));
      return emptyResult;
    }
  } catch (error) {
    console.error("OCR extraction error:", error);
    return emptyResult;
  }
}

// ============================================================================
// OCR-Based Validation Rules - Validate provider prices against OCR reference
// ============================================================================

type OcrValidationResult = {
  accepted: boolean;
  status: AirbnbBaselineStatus;
  includesTaxesFees: boolean;
  acceptedVia: 'breakdown_match' | 'equal_baseline' | 'higher_than_baseline' | null;
  mismatchReason: string | null;
  evidenceSnippet: string;
  validatedPrice: number | null;
};

function validateProviderPriceWithOcr(
  providerPrice: number | null,
  providerCurrency: string | null,
  providerEvidence: string,
  ocrRef: OcrVisualReference | null
): OcrValidationResult {
  const noOcrResult: OcrValidationResult = {
    accepted: providerPrice !== null,
    status: providerPrice !== null ? 'total_price_excluding_taxes_and_fees' : 'price_not_available_in_content',
    includesTaxesFees: false,
    acceptedVia: null,
    mismatchReason: providerPrice !== null ? null : 'no_provider_price',
    evidenceSnippet: providerEvidence,
    validatedPrice: providerPrice,
  };

  if (!ocrRef) {
    console.log("OCR validation: No OCR reference available - passing through provider price");
    return noOcrResult;
  }

  // Rule A: Breakdown Total has absolute priority
  if (ocrRef.breakdownTotalAmountValue !== null && ocrRef.breakdownTotalAmountValue > 0) {
    const B_total = ocrRef.breakdownTotalAmountValue;
    const tolerance = 2; // Allow $2 rounding tolerance

    if (providerPrice === null) {
      return {
        accepted: false,
        status: 'price_not_available_in_content',
        includesTaxesFees: false,
        acceptedVia: null,
        mismatchReason: 'provider_returned_null_but_breakdown_visible',
        evidenceSnippet: ocrRef.breakdownTotalSnippet || providerEvidence,
        validatedPrice: null,
      };
    }

    if (Math.abs(providerPrice - B_total) <= tolerance) {
      console.log(`OCR validation [Rule A]: Provider price ${providerPrice} matches breakdown total ${B_total}`);
      return {
        accepted: true,
        status: 'total_price_including_taxes_and_fees',
        includesTaxesFees: true,
        acceptedVia: 'breakdown_match',
        mismatchReason: null,
        evidenceSnippet: ocrRef.breakdownTotalSnippet || providerEvidence,
        validatedPrice: providerPrice,
      };
    }

    // Breakdown visible but provider price doesn't match - REJECT
    console.log(`OCR validation [Rule A REJECT]: Provider ${providerPrice} != breakdown ${B_total}`);
    return {
      accepted: false,
      status: 'price_not_available_in_content',
      includesTaxesFees: false,
      acceptedVia: null,
      mismatchReason: `provider_price_mismatch_with_breakdown:${providerPrice}_vs_${B_total}`,
      evidenceSnippet: `Provider: ${providerPrice}, OCR breakdown: ${ocrRef.breakdownTotalSnippet}`,
      validatedPrice: null,
    };
  }

  // Rule B: No breakdown, booking card only (baseline case)
  if (ocrRef.bookingCardAmountValue !== null && ocrRef.bookingCardAmountValue > 0) {
    const B = ocrRef.bookingCardAmountValue;
    const P = providerPrice;

    if (P === null) {
      return {
        accepted: false,
        status: 'price_not_available_in_content',
        includesTaxesFees: false,
        acceptedVia: null,
        mismatchReason: 'provider_returned_null',
        evidenceSnippet: ocrRef.bookingCardSnippet || providerEvidence,
        validatedPrice: null,
      };
    }

    // Rule B1: Provider price lower than OCR baseline → REJECT
    if (P < B) {
      console.log(`OCR validation [Rule B1 REJECT]: Provider ${P} < OCR baseline ${B}`);
      return {
        accepted: false,
        status: 'price_not_available_in_content',
        includesTaxesFees: false,
        acceptedVia: null,
        mismatchReason: 'provider_price_lower_than_visible_price',
        evidenceSnippet: `Provider: ${P}, OCR baseline: ${ocrRef.bookingCardSnippet}`,
        validatedPrice: null,
      };
    }

    // Rule B2: Provider price equal to OCR baseline → ACCEPT (but not taxes proven)
    const tolerance = 2;
    if (Math.abs(P - B) <= tolerance) {
      console.log(`OCR validation [Rule B2]: Provider ${P} ≈ OCR baseline ${B}`);
      return {
        accepted: true,
        status: 'total_price_excluding_taxes_and_fees',
        includesTaxesFees: false,
        acceptedVia: 'equal_baseline',
        mismatchReason: null,
        evidenceSnippet: ocrRef.bookingCardSnippet || providerEvidence,
        validatedPrice: P,
      };
    }

    // Rule B3: Provider price higher than OCR baseline → ACCEPT AS TOTAL
    if (P > B) {
      console.log(`OCR validation [Rule B3]: Provider ${P} > OCR baseline ${B} - accepting as total incl. fees`);
      return {
        accepted: true,
        status: 'total_price_including_taxes_and_fees',
        includesTaxesFees: true,
        acceptedVia: 'higher_than_baseline',
        mismatchReason: null,
        evidenceSnippet: providerEvidence,
        validatedPrice: P,
      };
    }
  }

  // No OCR data to validate against - pass through
  console.log("OCR validation: No usable OCR amounts - passing through provider price");
  return noOcrResult;
}

// Screenshot-based fallback: ask the multimodal model to read the total from the rendered page.
async function extractAirbnbTotalFromScreenshotBase64(screenshotBase64: string, nights: number): Promise<number | null> {
  const lovableApiKey = Deno.env.get("LOVABLE_API_KEY");
  if (!lovableApiKey) return null;

  try {
    const prompt = `This is a screenshot of an Airbnb listing page with dates already selected.

Task:
1) Read the TOTAL price for the stay shown on the page (prefer the final total a guest pays; if only "Total before taxes" is visible, return that).
2) Return ONLY the total number (no currency symbols).
If you cannot find a total price in the screenshot, return "null".`;

    const imageUrl = `data:image/png;base64,${screenshotBase64}`;

    const response = await fetchWithTimeout(
      "https://ai.gateway.lovable.dev/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${lovableApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                { type: "image_url", image_url: { url: imageUrl } },
              ],
            },
          ],
          max_tokens: 50,
        }),
      },
      20_000
    );

    if (!response.ok) {
      console.error("Screenshot AI request failed:", response.status);
      return null;
    }

    const data = await response.json();
    const totalText = data.choices?.[0]?.message?.content?.trim();
    if (!totalText || totalText.toLowerCase() === "null") return null;

    const total = parseFloat(totalText.replace(/[^0-9.]/g, ""));
    if (isNaN(total) || total < 20 || total > 200000) return null;

    console.log("Screenshot extracted total:", total);
    return total;
  } catch (e) {
    console.error("Screenshot price extraction error:", e);
    return null;
  }
}

// ===============================================
// PLATFORM ADAPTER SYSTEM - Deep Link Generation
// ===============================================

// Platform capability classification
type PlatformCapability = "url_driven" | "api_driven" | "session_driven";
type LinkReliability = "high" | "medium" | "low";

interface PlatformAdapter {
  name: string;
  capability: PlatformCapability;
  reliability: LinkReliability;
  domains: string[];
  // Generate the best deep link for a property with dates
  generateDeepLink: (
    baseUrl: string,
    checkIn: string,
    checkOut: string,
    adults?: number,
    children?: number,
    rooms?: number
  ) => string;
  // Platform-specific wait time for JS rendering
  scrapeWaitTime: number;
  // Whether to use screenshot fallback for pricing
  useScreenshotFallback: boolean;
  // Platform-specific price extraction hints
  pricePatterns?: RegExp[];
}

// Booking.com Adapter - IMPROVED with better URL handling
const bookingComAdapter: PlatformAdapter = {
  name: "Booking.com",
  capability: "session_driven",
  reliability: "medium",
  domains: ["booking.com"],
  scrapeWaitTime: 15000, // Increased wait time for dynamic content
  useScreenshotFallback: true,
  generateDeepLink: (baseUrl, checkIn, checkOut, adults = 2, children = 0, rooms = 1) => {
    try {
      const url = new URL(baseUrl);
      
      // Remove ALL existing date/session params to avoid conflicts
      const paramsToRemove = [
        "checkin", "checkout", "checkin_month", "checkin_monthday", "checkin_year",
        "checkout_month", "checkout_monthday", "checkout_year",
        "all_sr_blocks", "sr_pri_blocks", "matching_block_id", "srpvid", "srepoch",
        "dist", "type", "ucfs", "highlighted_blocks"
      ];
      paramsToRemove.forEach(p => url.searchParams.delete(p));
      
      // Booking.com uses YYYY-MM-DD format
      url.searchParams.set("checkin", checkIn);
      url.searchParams.set("checkout", checkOut);
      url.searchParams.set("group_adults", adults.toString());
      url.searchParams.set("group_children", children.toString());
      url.searchParams.set("no_rooms", rooms.toString());
      url.searchParams.set("selected_currency", "EUR");
      
      // Force fresh search without cached session data
      url.searchParams.set("req_adults", adults.toString());
      url.searchParams.set("req_children", children.toString());
      
      console.log(`[BOOKING.COM] Generated deep link: ${url.toString().slice(0, 200)}`);
      return url.toString();
    } catch (e) {
      console.error(`[BOOKING.COM] Deep link generation failed:`, e);
      return baseUrl;
    }
  },
  pricePatterns: [
    /€\s*(\d{1,3}(?:[,.']\d{3})*(?:[.,]\d{2})?)/gi,
    /(\d{1,3}(?:[,.']\d{3})*(?:[.,]\d{2})?)\s*€/gi,
    /EUR\s*(\d{1,3}(?:[,.']\d{3})*)/gi,
    /price["\s:]+(\d{2,6})/gi,
  ],
};

// Vrbo/HomeAway Adapter (Expedia Group) - IMPROVED
const vrboAdapter: PlatformAdapter = {
  name: "Vrbo",
  capability: "url_driven",
  reliability: "high",
  domains: ["vrbo.com", "homeaway.com", "homeaway.de", "homeaway.fr", "homeaway.es", "homeaway.it", "homeaway.co.uk"],
  scrapeWaitTime: 10000,
  useScreenshotFallback: true,
  generateDeepLink: (baseUrl, checkIn, checkOut, adults = 2, children = 0) => {
    try {
      const url = new URL(baseUrl);
      // Clear existing date params
      ["arrival", "departure", "startDate", "endDate", "adults", "children"].forEach(p => url.searchParams.delete(p));
      
      // Vrbo uses arrival/departure format (YYYY-MM-DD)
      url.searchParams.set("arrival", checkIn);
      url.searchParams.set("departure", checkOut);
      url.searchParams.set("adults", adults.toString());
      if (children > 0) {
        url.searchParams.set("children", children.toString());
      }
      
      console.log(`[VRBO] Generated deep link: ${url.toString().slice(0, 200)}`);
      return url.toString();
    } catch (e) {
      console.error(`[VRBO] Deep link generation failed:`, e);
      return baseUrl;
    }
  },
};

// Expedia Adapter - IMPROVED (with .co.jp for USD fallback path)
const expediaAdapter: PlatformAdapter = {
  name: "Expedia",
  capability: "url_driven",
  reliability: "high",
  // Include all regional TLDs - extract-expedia will build proper offers URL
  domains: ["expedia.com", "expedia.de", "expedia.fr", "expedia.co.uk", "expedia.es", "expedia.it", "expedia.nl", "expedia.be", "expedia.co.jp", "expedia.ca", "expedia.com.au"],
  scrapeWaitTime: 10000,
  useScreenshotFallback: true,
  generateDeepLink: (baseUrl, checkIn, checkOut, adults = 2, children = 0, rooms = 1) => {
    try {
      const url = new URL(baseUrl);
      // Clear existing params
      ["chkin", "chkout", "rm1", "startDate", "endDate"].forEach(p => url.searchParams.delete(p));
      
      // Expedia uses chkin/chkout format (YYYY-MM-DD)
      url.searchParams.set("chkin", checkIn);
      url.searchParams.set("chkout", checkOut);
      url.searchParams.set("rm1", `a${adults}${children > 0 ? `c${children}` : ""}`);
      
      console.log(`[EXPEDIA] Generated deep link: ${url.toString().slice(0, 200)}`);
      return url.toString();
    } catch (e) {
      console.error(`[EXPEDIA] Deep link generation failed:`, e);
      return baseUrl;
    }
  },
};

// Hotels.com Adapter (Expedia Group) - IMPROVED
const hotelsComAdapter: PlatformAdapter = {
  name: "Hotels.com",
  capability: "url_driven",
  reliability: "high",
  domains: ["hotels.com", "hotels.de", "hotels.fr", "hotels.co.uk"],
  scrapeWaitTime: 10000,
  useScreenshotFallback: true,
  generateDeepLink: (baseUrl, checkIn, checkOut, adults = 2, children = 0, rooms = 1) => {
    try {
      const url = new URL(baseUrl);
      ["checkIn", "checkOut", "adults", "children", "rooms"].forEach(p => url.searchParams.delete(p));
      
      url.searchParams.set("checkIn", checkIn);
      url.searchParams.set("checkOut", checkOut);
      url.searchParams.set("adults", adults.toString());
      url.searchParams.set("children", children.toString());
      url.searchParams.set("rooms", rooms.toString());
      
      console.log(`[HOTELS.COM] Generated deep link: ${url.toString().slice(0, 200)}`);
      return url.toString();
    } catch (e) {
      console.error(`[HOTELS.COM] Deep link generation failed:`, e);
      return baseUrl;
    }
  },
};

// Agoda Adapter - IMPROVED with better date handling
const agodaAdapter: PlatformAdapter = {
  name: "Agoda",
  capability: "url_driven",
  reliability: "medium",
  domains: ["agoda.com", "agoda.de", "agoda.fr", "agoda.co.uk"],
  scrapeWaitTime: 12000,
  useScreenshotFallback: true,
  generateDeepLink: (baseUrl, checkIn, checkOut, adults = 2, children = 0, rooms = 1) => {
    try {
      const url = new URL(baseUrl);
      ["checkIn", "checkOut", "los", "rooms", "adults", "children"].forEach(p => url.searchParams.delete(p));
      
      // Agoda prefers checkIn/checkOut (YYYY-MM-DD)
      url.searchParams.set("checkIn", checkIn);
      url.searchParams.set("checkOut", checkOut);
      url.searchParams.set("rooms", rooms.toString());
      url.searchParams.set("adults", adults.toString());
      url.searchParams.set("children", children.toString());
      url.searchParams.set("cid", "1844104"); // Affiliate tracking (generic)
      
      console.log(`[AGODA] Generated deep link: ${url.toString().slice(0, 200)}`);
      return url.toString();
    } catch (e) {
      console.error(`[AGODA] Deep link generation failed:`, e);
      return baseUrl;
    }
  },
};

// TripAdvisor Adapter - IMPROVED with better URL pattern handling
const tripAdvisorAdapter: PlatformAdapter = {
  name: "TripAdvisor",
  capability: "session_driven",
  reliability: "medium", // Upgraded from low - better handling now
  domains: ["tripadvisor.com", "tripadvisor.de", "tripadvisor.fr", "tripadvisor.co.uk", "tripadvisor.ch", "tripadvisor.co.za", "tripadvisor.it", "tripadvisor.es"],
  scrapeWaitTime: 15000, // Increased for dynamic content
  useScreenshotFallback: true,
  generateDeepLink: (baseUrl, checkIn, checkOut, adults = 2, children = 0, rooms = 1) => {
    try {
      const url = new URL(baseUrl);
      
      // TripAdvisor has multiple URL formats - handle the common ones
      // Clear existing params
      ["checkin", "checkout", "adults", "rooms", "checkIn", "checkOut"].forEach(p => url.searchParams.delete(p));
      
      // TripAdvisor uses YYYY-MM-DD format
      url.searchParams.set("checkin", checkIn);
      url.searchParams.set("checkout", checkOut);
      url.searchParams.set("adults", adults.toString());
      url.searchParams.set("rooms", rooms.toString());
      
      // Add currency parameter for consistent pricing
      url.searchParams.set("currency", "EUR");
      
      console.log(`[TRIPADVISOR] Generated deep link: ${url.toString().slice(0, 200)}`);
      return url.toString();
    } catch (e) {
      console.error(`[TRIPADVISOR] Deep link generation failed:`, e);
      return baseUrl;
    }
  },
};

// HolidayCheck Adapter - IMPROVED
const holidayCheckAdapter: PlatformAdapter = {
  name: "HolidayCheck",
  capability: "session_driven",
  reliability: "medium", // Upgraded from low
  domains: ["holidaycheck.de", "holidaycheck.at", "holidaycheck.ch"],
  scrapeWaitTime: 15000,
  useScreenshotFallback: true,
  generateDeepLink: (baseUrl, checkIn, checkOut, adults = 2, children = 0, rooms = 1) => {
    try {
      const url = new URL(baseUrl);
      ["checkin", "checkout", "adults", "rooms", "departureDate", "returnDate"].forEach(p => url.searchParams.delete(p));
      
      url.searchParams.set("departureDate", checkIn);
      url.searchParams.set("returnDate", checkOut);
      url.searchParams.set("adults", adults.toString());
      url.searchParams.set("rooms", rooms.toString());
      
      console.log(`[HOLIDAYCHECK] Generated deep link: ${url.toString().slice(0, 200)}`);
      return url.toString();
    } catch (e) {
      console.error(`[HOLIDAYCHECK] Deep link generation failed:`, e);
      return baseUrl;
    }
  },
};

// NEW: Hostelworld Adapter
const hostelworldAdapter: PlatformAdapter = {
  name: "Hostelworld",
  capability: "url_driven",
  reliability: "medium",
  domains: ["hostelworld.com"],
  scrapeWaitTime: 10000,
  useScreenshotFallback: true,
  generateDeepLink: (baseUrl, checkIn, checkOut, adults = 2) => {
    try {
      const url = new URL(baseUrl);
      ["from", "to", "guests"].forEach(p => url.searchParams.delete(p));
      
      // Hostelworld uses from/to with YYYY-MM-DD
      url.searchParams.set("from", checkIn);
      url.searchParams.set("to", checkOut);
      url.searchParams.set("guests", adults.toString());
      
      console.log(`[HOSTELWORLD] Generated deep link: ${url.toString().slice(0, 200)}`);
      return url.toString();
    } catch (e) {
      console.error(`[HOSTELWORLD] Deep link generation failed:`, e);
      return baseUrl;
    }
  },
};

// NEW: Rentbyowner Adapter (common in visual search results)
const rentbyownerAdapter: PlatformAdapter = {
  name: "Rentbyowner",
  capability: "url_driven",
  reliability: "medium",
  domains: ["rentbyowner.com", "rentbyowner.net"],
  scrapeWaitTime: 10000,
  useScreenshotFallback: true,
  generateDeepLink: (baseUrl, checkIn, checkOut, adults = 2) => {
    try {
      const url = new URL(baseUrl);
      ["checkin", "checkout", "arrival", "departure"].forEach(p => url.searchParams.delete(p));
      
      url.searchParams.set("arrival", checkIn);
      url.searchParams.set("departure", checkOut);
      url.searchParams.set("guests", adults.toString());
      
      console.log(`[RENTBYOWNER] Generated deep link: ${url.toString().slice(0, 200)}`);
      return url.toString();
    } catch (e) {
      console.error(`[RENTBYOWNER] Deep link generation failed:`, e);
      return baseUrl;
    }
  },
};

// NEW: HRS Adapter
const hrsAdapter: PlatformAdapter = {
  name: "HRS",
  capability: "url_driven",
  reliability: "medium",
  domains: ["hrs.de", "hrs.com"],
  scrapeWaitTime: 10000,
  useScreenshotFallback: true,
  generateDeepLink: (baseUrl, checkIn, checkOut, adults = 2, children = 0, rooms = 1) => {
    try {
      const url = new URL(baseUrl);
      ["arrivalDate", "departureDate", "adults", "children", "rooms"].forEach(p => url.searchParams.delete(p));
      
      url.searchParams.set("arrivalDate", checkIn);
      url.searchParams.set("departureDate", checkOut);
      url.searchParams.set("adults", adults.toString());
      url.searchParams.set("rooms", rooms.toString());
      
      console.log(`[HRS] Generated deep link: ${url.toString().slice(0, 200)}`);
      return url.toString();
    } catch (e) {
      console.error(`[HRS] Deep link generation failed:`, e);
      return baseUrl;
    }
  },
};

// Generic/Direct Booking Adapter - IMPROVED with multiple param attempts
const genericAdapter: PlatformAdapter = {
  name: "Direct Booking",
  capability: "url_driven",
  reliability: "low",
  domains: [],
  scrapeWaitTime: 10000,
  useScreenshotFallback: true,
  generateDeepLink: (baseUrl, checkIn, checkOut, adults = 2) => {
    try {
      const url = new URL(baseUrl);
      
      // Try to add dates with common parameter names (most sites use at least one)
      // Don't add ALL params - pick the most common ones
      if (!url.searchParams.has("checkin") && !url.searchParams.has("check_in") && !url.searchParams.has("arrival")) {
        url.searchParams.set("checkin", checkIn);
        url.searchParams.set("checkout", checkOut);
      }
      
      console.log(`[GENERIC] Generated deep link: ${url.toString().slice(0, 200)}`);
      return url.toString();
    } catch (e) {
      console.error(`[GENERIC] Deep link generation failed:`, e);
      return baseUrl;
    }
  },
};

// Platform adapter registry - EXPANDED
const platformAdapters: PlatformAdapter[] = [
  bookingComAdapter,
  vrboAdapter,
  expediaAdapter,
  hotelsComAdapter,
  agodaAdapter,
  tripAdvisorAdapter,
  holidayCheckAdapter,
  hostelworldAdapter,
  rentbyownerAdapter,
  hrsAdapter,
];

// Get the appropriate adapter for a URL
function getPlatformAdapter(url: string): PlatformAdapter {
  const lowercaseUrl = url.toLowerCase();
  for (const adapter of platformAdapters) {
    if (adapter.domains.some(domain => lowercaseUrl.includes(domain))) {
      return adapter;
    }
  }
  return genericAdapter;
}

// Generate optimized deep link using platform adapter
function generatePricedDeepLink(
  url: string,
  checkIn: string,
  checkOut: string,
  adults: number = 2,
  children: number = 0,
  rooms: number = 1
): { deepLink: string; adapter: PlatformAdapter; reliability: LinkReliability } {
  const adapter = getPlatformAdapter(url);
  const deepLink = adapter.generateDeepLink(url, checkIn, checkOut, adults, children, rooms);
  return { deepLink, adapter, reliability: adapter.reliability };
}

// Expanded platform list for better coverage - including international variants
function getPlatformName(url: string): string {
  const lowercaseUrl = url.toLowerCase();
  if (lowercaseUrl.includes("vrbo.com")) return "Vrbo";
  if (lowercaseUrl.includes("booking.com")) return "Booking.com";
  if (lowercaseUrl.includes("expedia.")) return "Expedia";
  if (lowercaseUrl.includes("hotels.com")) return "Hotels.com";
  if (lowercaseUrl.includes("tripadvisor.")) return "TripAdvisor";
  if (lowercaseUrl.includes("homeaway.")) return "HomeAway";
  if (lowercaseUrl.includes("vacasa.com")) return "Vacasa";
  if (lowercaseUrl.includes("agoda.")) return "Agoda";
  if (lowercaseUrl.includes("hometogo.")) return "HomeToGo";
  if (lowercaseUrl.includes("holidu.")) return "Holidu";
  if (lowercaseUrl.includes("holidaycheck.")) return "HolidayCheck";
  if (lowercaseUrl.includes("hrs.")) return "HRS";
  if (lowercaseUrl.includes("hostelworld.")) return "Hostelworld";
  if (lowercaseUrl.includes("rentbyowner.")) return "Rentbyowner";
  if (lowercaseUrl.includes("interhome.")) return "Interhome";
  if (lowercaseUrl.includes("flipkey.")) return "FlipKey";
  if (lowercaseUrl.includes("atraveo.")) return "Atraveo";
  if (lowercaseUrl.includes("fewo-direkt.")) return "FeWo-direkt";
  if (lowercaseUrl.includes("traum-ferienwohnungen.")) return "Traum-Ferienwohnungen";
  if (lowercaseUrl.includes("casamundo.")) return "Casamundo";
  if (lowercaseUrl.includes("kayak.")) return "Kayak";
  if (lowercaseUrl.includes("trivago.")) return "Trivago";
  if (lowercaseUrl.includes("trip.com")) return "Trip.com";
  if (lowercaseUrl.includes("makemytrip.")) return "MakeMyTrip";
  if (lowercaseUrl.includes("hostel.com")) return "Hostel.com";
  if (lowercaseUrl.includes("priceline.")) return "Priceline";
  if (lowercaseUrl.includes("travelocity.")) return "Travelocity";
  if (lowercaseUrl.includes("orbitz.")) return "Orbitz";
  if (lowercaseUrl.includes("hotwire.")) return "Hotwire";
  if (lowercaseUrl.includes("cheaptickets.")) return "CheapTickets";
  if (lowercaseUrl.includes("hotelstonight.")) return "Hotels Tonight";
  if (lowercaseUrl.includes("getaroom.")) return "GetARoom";
  if (lowercaseUrl.includes("hotel.")) return "Hotel.com";
  
  try {
    const domain = new URL(url).hostname.replace("www.", "");
    const name = domain.split(".")[0];
    return name.charAt(0).toUpperCase() + name.slice(1);
  } catch {
    return "Other Platform";
  }
}

// Expanded booking platform check with all international TLDs - comprehensive list
function isBookingPlatform(url: string): boolean {
  const lowercaseUrl = url.toLowerCase();
  const platforms = [
    // Major global platforms
    "vrbo.com", "booking.com", "expedia.", "hotels.com", 
    "tripadvisor.", // covers .com, .ch, .de, .fr, .it, .co.za, etc.
    "homeaway.", "vacasa.com", "agoda.", "hometogo.", "holidu.",
    "rentbyowner.", // Common in visual search results
    // European platforms
    "interhome.", "flipkey.", "atraveo.", "holidaycheck.", 
    "hrs.", "hrs.com", "hrs.de", // HRS variations
    "hostelworld.", "fewo-direkt.", "traum-ferienwohnungen.",
    "casamundo.", "kayak.", "trivago.", "trip.com", "makemytrip.",
    "priceline.", "travelocity.", "orbitz.", "hotwire.", "cheaptickets.",
    "hotelstonight.", "getaroom.",
    // Additional international platforms
    "hotel.de", "hotel.info", "hotel-mix.",
    "easyjet.com/en/hotels", "lastminute.",
    "laterooms.", "opodo.", "edreams.", "destinia.",
    "centraldereservas.", "logitravel.",
    // Regional South Africa platforms
    "safarinow.", "lekkeslaap.", "nightsbridge.",
    "sa-venues.", "wheretostay.", "travelground.",
    // Metasearch that show direct links
    "skyscanner.", "momondo.", "cheapflights.",
    // Direct hotel booking aggregators
    "-hotels-", "hotels-", // Pattern for regional hotel sites like "capetown-hotels-za.com"
  ];
  return platforms.some(p => lowercaseUrl.includes(p));
}

// Additional check for regional hotel booking domains (like maison-b.capetown-hotels-za.com)
function isRegionalHotelSite(url: string): boolean {
  const lowercaseUrl = url.toLowerCase();
  // Pattern: property-name.location-hotels-countrycode.com
  const hotelDomainPattern = /[a-z0-9-]+\.[a-z]+-hotels-[a-z]{2}\.com/;
  if (hotelDomainPattern.test(lowercaseUrl)) return true;
  
  // Other regional booking patterns
  const regionalPatterns = [
    /[a-z]+\.hotels-[a-z]+\.com/,
    /book[a-z]*\.[a-z]+\.com/,
    /reserve\.[a-z]+\.com/,
  ];
  return regionalPatterns.some(p => p.test(lowercaseUrl));
}

// Enhanced direct property site detection - more permissive for hotel/guesthouse sites
function isDirectPropertySite(url: string): boolean {
  const lowercaseUrl = url.toLowerCase();
  
  // Exclude major platforms, social media, generic sites, and search engines
  const excludePatterns = [
    "airbnb.", "google.", "facebook.", "instagram.", "twitter.", "pinterest.",
    "youtube.", "wikipedia.", "yelp.", "maps.", "cloudflare.",
    ".gov", ".edu", "amazon.", "ebay.", "craigslist.", "tiktok.",
    "linkedin.", "reddit.", "quora.", "medium.", "tumblr.",
    "serpapi.", "bing.", "yahoo.", "duckduckgo."
  ];
  
  if (excludePatterns.some(p => lowercaseUrl.includes(p))) return false;
  
  // Look for property-related keywords in URL - expanded list
  const propertyKeywords = [
    "villa", "cottage", "cabin", "chalet", "apartment", "flat", "house",
    "rental", "holiday", "vacation", "stay", "lodge", "guest", "bnb",
    "ferienwohnung", "ferienhaus", "gite", "chambre", "pension",
    "hotel", "hostel", "inn", "resort", "maison", "casa", "haus",
    "suite", "room", "accommodation", "zimmer", "unterkunft",
    "guesthouse", "bed-and-breakfast", "b-and-b", "bandb",
    "african", "home", "place", "retreat", "escape", "haven",
    "-hotels-", "hotels-"
  ];
  
  // Check if URL contains property keywords
  if (propertyKeywords.some(k => lowercaseUrl.includes(k))) return true;
  
  // Also accept URLs that look like direct booking sites (short domain with specific path)
  try {
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split('/').filter(Boolean);
    // If it has a short path and the domain doesn't look like a major site
    if (pathParts.length <= 3 && urlObj.hostname.split('.').length <= 3) {
      // Check for booking-related paths
      const bookingPaths = ["book", "reserve", "rates", "availability", "rooms", "contact"];
      if (pathParts.some(p => bookingPaths.some(bp => p.toLowerCase().includes(bp)))) {
        return true;
      }
    }
  } catch {
    // Ignore URL parsing errors
  }
  
  return false;
}

// Blocklist of non-booking platforms (stock photo sites, social media, etc.)
function isBlockedNonBookingPlatform(url: string): boolean {
  const lowercaseUrl = url.toLowerCase();
  const blockedDomains = [
    // Stock photo and image sites
    "shutterstock.", "istockphoto.", "gettyimages.", "dreamstime.", "123rf.",
    "depositphotos.", "adobestock.", "stock.adobe.", "canstockphoto.", "bigstockphoto.",
    "alamy.", "stocksy.", "pond5.", "vecteezy.", "freepik.", "pexels.", "unsplash.",
    "pixabay.", "flickr.", "500px.", "smugmug.", "photobucket.",
    // Social media
    "facebook.", "instagram.", "twitter.", "x.com", "pinterest.", "tiktok.",
    "linkedin.", "reddit.", "tumblr.", "snapchat.",
    // Search engines and maps
    "google.", "bing.", "yahoo.", "duckduckgo.", "maps.", "serpapi.",
    // Video platforms
    "youtube.", "vimeo.", "dailymotion.",
    // News and encyclopedias
    "wikipedia.", "wikimedia.", "news.", "cnn.", "bbc.",
    // E-commerce (non-travel)
    "amazon.", "ebay.", "etsy.", "alibaba.", "aliexpress.",
    // Other non-booking sites
    "cloudflare.", "archive.org", "quora.", "medium.", "yelp.",
    ".gov", ".edu", "craigslist.",
    // Travel magazines, blogs and editorial sites (can't book here)
    "cntraveller.", "cntraveler.", "condenast.", "travelandleisure.", "afar.",
    "lonelyplanet.", "fodors.", "frommers.", "roughguides.", "timeout.",
    "theinfatuation.", "eater.", "departures.", "traveler.", "nationalgeographic.",
    "culturetrip.", "atlasobscura.", "roadtrippers.", "matadornetwork.",
    "nomadicmatt.", "theblondeabroad.", "handluggageonly.", "travelingmom.",
    "travelweekly.", "skift.", "phocuswire.", "tnooz.", "webintravel.",
    // Real estate and property info sites (listings, not bookable)
    "zillow.", "trulia.", "realtor.", "redfin.", "rightmove.", "zoopla.",
    "idealista.", "immobilienscout24.", "seloger.", "funda.", "daft.",
    // Price comparison / aggregators without direct booking
    "trivago.", "kayak.", "skyscanner.", "momondo.", "hipmunk.",
    "hotelscombined.", "hotwire.", "priceline.",
  ];
  return blockedDomains.some(d => lowercaseUrl.includes(d));
}

// UUID v4 validation regex
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Maximum URL length to prevent DoS
const MAX_URL_LENGTH = 2048;

// Strict allowlist of valid Airbnb domains (prevents SSRF via subdomain tricks)
const AIRBNB_DOMAINS = [
  "airbnb.com", "airbnb.co.uk", "airbnb.de", "airbnb.fr", "airbnb.es",
  "airbnb.it", "airbnb.nl", "airbnb.pt", "airbnb.at", "airbnb.ch",
  "airbnb.be", "airbnb.ie", "airbnb.se", "airbnb.no", "airbnb.dk",
  "airbnb.fi", "airbnb.pl", "airbnb.cz", "airbnb.hu", "airbnb.gr",
  "airbnb.ca", "airbnb.com.au", "airbnb.co.nz", "airbnb.co.za",
  "airbnb.jp", "airbnb.kr", "airbnb.cn", "airbnb.com.hk", "airbnb.com.sg",
  "airbnb.co.in", "airbnb.com.br", "airbnb.mx", "airbnb.com.ar",
  "airbnb.ru", "airbnb.com.tr", "airbnb.ae", "airbnb.co.il"
];

// Check if hostname is a private/internal IP (SSRF protection)
function isPrivateOrInternalIP(hostname: string): boolean {
  // Block localhost variants
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    return true;
  }
  
  // Block private IP ranges (RFC 1918)
  const privateIPPatterns = [
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,           // 10.0.0.0/8
    /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/, // 172.16.0.0/12
    /^192\.168\.\d{1,3}\.\d{1,3}$/,              // 192.168.0.0/16
    /^169\.254\.\d{1,3}\.\d{1,3}$/,              // Link-local
    /^0\.0\.0\.0$/,                               // Any address
  ];
  
  return privateIPPatterns.some(pattern => pattern.test(hostname));
}

// Validate Airbnb URL format with strict domain allowlist (prevents SSRF)
function isValidAirbnbUrl(url: string): boolean {
  // Check URL length limit
  if (!url || url.length > MAX_URL_LENGTH) {
    return false;
  }
  
  try {
    const parsed = new URL(url);
    
    // Only allow http/https protocols
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    
    // Block userinfo in URL (prevents SSRF like airbnb.com@evil.com)
    if (parsed.username || parsed.password) {
      return false;
    }
    
    // Block private/internal IPs
    if (isPrivateOrInternalIP(parsed.hostname)) {
      return false;
    }
    
    // Extract the base domain (handles www. prefix)
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
    
    // Check against strict allowlist
    const isAllowedDomain = AIRBNB_DOMAINS.some(domain => 
      hostname === domain || hostname.endsWith('.' + domain)
    );
    
    if (!isAllowedDomain) {
      return false;
    }
    
    // Must have /rooms/ path
    return parsed.pathname.includes("/rooms/");
  } catch {
    return false;
  }
}

// Check if an image URL is a valid property photo (not logo/favicon)
function isValidPropertyImage(url: string): boolean {
  const lowercaseUrl = url.toLowerCase();

  // Exclude favicons, logos, and platform assets
  const excludePatterns = [
    "favicon",
    "logo",
    "icon",
    "brand",
    "platform-assets",
    "airbnbplatformassets",
    "airbnb-platform-assets",
    "sprite",
    "button",
    "arrow",
    "avatar",
    "profile",
    "social",
    "badge",
    "marker",
    "pin",
    "placeholder",
  ];

  if (excludePatterns.some((p) => lowercaseUrl.includes(p))) return false;

  // Airbnb listing photos are hosted on muscache; accept any pictures URL.
  if (!lowercaseUrl.includes("muscache.com")) return false;
  if (!lowercaseUrl.includes("/im/pictures/")) return false;

  // Accept common image types OR long CDN URLs with query params.
  return /\.(jpg|jpeg|png|webp)(\?|$)/i.test(lowercaseUrl) || lowercaseUrl.length > 80;
}


// Extract dates from Airbnb URL
function extractDatesFromUrl(url: string): { checkIn: string | null; checkOut: string | null } {
  try {
    const urlObj = new URL(url);
    return {
      checkIn: urlObj.searchParams.get('check_in'),
      checkOut: urlObj.searchParams.get('check_out')
    };
  } catch {
    return { checkIn: null, checkOut: null };
  }
}

// Generate default dates (2 weeks from now, 3 nights)
function generateDefaultDates(): { checkIn: string; checkOut: string } {
  const today = new Date();
  const checkIn = new Date(today);
  checkIn.setDate(today.getDate() + 14);
  
  const checkOut = new Date(checkIn);
  checkOut.setDate(checkIn.getDate() + 3);
  
  return {
    checkIn: checkIn.toISOString().split('T')[0],
    checkOut: checkOut.toISOString().split('T')[0]
  };
}

// Calculate nights between dates
function calculateNights(checkIn: string, checkOut: string): number {
  const start = new Date(checkIn);
  const end = new Date(checkOut);
  const diffTime = Math.abs(end.getTime() - start.getTime());
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

// Format dates for different platforms
function formatDateForPlatform(date: string, platform: string): string {
  const d = new Date(date);
  // Most platforms use YYYY-MM-DD
  return d.toISOString().split('T')[0];
}

// Validate if a URL is an actual bookable property page (not category/search/info page)
function isValidBookablePropertyUrl(url: string): { valid: boolean; reason?: string } {
  const lowercaseUrl = url.toLowerCase();
  
  // Booking.com: must be /hotel/ path with specific property
  if (lowercaseUrl.includes("booking.com")) {
    // Valid: booking.com/hotel/xx/property-name.html
    // Invalid: booking.com/searchresults.html, booking.com/city/xx/hotels/
    if (lowercaseUrl.includes("/searchresults.")) {
      return { valid: false, reason: "Booking.com search results page" };
    }
    if (lowercaseUrl.includes("/hotels/") && !lowercaseUrl.includes("/hotel/")) {
      return { valid: false, reason: "Booking.com category page" };
    }
    if (!lowercaseUrl.includes("/hotel/") && !lowercaseUrl.includes(".html")) {
      return { valid: false, reason: "Booking.com non-property page" };
    }
    return { valid: true };
  }
  
  // TripAdvisor: must be Hotel_Review or VacationRentalReview
  if (lowercaseUrl.includes("tripadvisor.")) {
    // Valid: tripadvisor.com/Hotel_Review-xxx or VacationRentalReview-xxx
    // Invalid: tripadvisor.com/Hotels-xxx (category), Tourism-xxx, Attractions-xxx
    if (lowercaseUrl.includes("/hotel_review-") || lowercaseUrl.includes("/vacationrentalreview-")) {
      return { valid: true };
    }
    if (lowercaseUrl.includes("/hotels-") || lowercaseUrl.includes("/tourism-")) {
      return { valid: false, reason: "TripAdvisor category/search page" };
    }
    if (lowercaseUrl.includes("/attraction") || lowercaseUrl.includes("/restaurant")) {
      return { valid: false, reason: "TripAdvisor non-accommodation page" };
    }
    // Generic TripAdvisor pages without review marker are likely not bookable
    return { valid: false, reason: "TripAdvisor non-property page" };
  }
  
  // HolidayCheck: must be hotel detail page
  if (lowercaseUrl.includes("holidaycheck.")) {
    // Valid: holidaycheck.de/hi/hotel-name/xxx
    // Invalid: holidaycheck.de/hri/ (search), /dh/ (destination)
    if (lowercaseUrl.includes("/hi/") || lowercaseUrl.includes("/hotel/")) {
      return { valid: true };
    }
    if (lowercaseUrl.includes("/hri/") || lowercaseUrl.includes("/dh/") || lowercaseUrl.includes("/search")) {
      return { valid: false, reason: "HolidayCheck search/category page" };
    }
    return { valid: false, reason: "HolidayCheck non-property page" };
  }
  
  // Vrbo/HomeAway: must have property ID
  if (lowercaseUrl.includes("vrbo.") || lowercaseUrl.includes("homeaway.")) {
    // Valid: vrbo.com/123456 or vrbo.com/property-name/123456
    // Invalid: vrbo.com/search/ or category pages
    if (lowercaseUrl.includes("/search") || lowercaseUrl.includes("/results")) {
      return { valid: false, reason: "Vrbo search results page" };
    }
    // Must have numeric property ID in path
    if (/\/\d{4,}/.test(lowercaseUrl)) {
      return { valid: true };
    }
    return { valid: false, reason: "Vrbo non-property page" };
  }
  
  // Expedia: must be hotel detail page
  if (lowercaseUrl.includes("expedia.")) {
    if (lowercaseUrl.includes("/hotel-search") || lowercaseUrl.includes("/hotel-reviews")) {
      return { valid: false, reason: "Expedia search/review page" };
    }
    // Valid pattern: /h12345.hotel-information or /Hotel-Name.h12345
    if (/\.h\d+\./.test(lowercaseUrl) || /\.h\d+$/.test(lowercaseUrl)) {
      return { valid: true };
    }
    return { valid: false, reason: "Expedia non-property page" };
  }
  
  // Hotels.com: similar to Expedia
  if (lowercaseUrl.includes("hotels.com")) {
    if (lowercaseUrl.includes("/search.") || lowercaseUrl.includes("/hotel-search")) {
      return { valid: false, reason: "Hotels.com search page" };
    }
    // Valid: hotels.com/ho123456/ 
    if (/\/ho\d+/.test(lowercaseUrl)) {
      return { valid: true };
    }
    return { valid: false, reason: "Hotels.com non-property page" };
  }
  
  // Agoda: must have property path
  if (lowercaseUrl.includes("agoda.")) {
    if (lowercaseUrl.includes("/searchresults") || lowercaseUrl.includes("/search/")) {
      return { valid: false, reason: "Agoda search results page" };
    }
    // Valid if has specific property path
    if (lowercaseUrl.includes("/hotel/") || /\/[\w-]+-[\w-]+\//.test(lowercaseUrl)) {
      return { valid: true };
    }
    return { valid: false, reason: "Agoda non-property page" };
  }
  
  // For unknown platforms, be lenient but reject obvious non-property patterns
  const invalidPatterns = [
    "/search", "/results", "/list", "/category", "/browse", 
    "/hotels/", "/properties/", "/listings/", "/destination/",
    "?q=", "?query=", "?search="
  ];
  
  if (invalidPatterns.some(p => lowercaseUrl.includes(p))) {
    return { valid: false, reason: "Appears to be search/category page" };
  }
  
  return { valid: true };
}

// Add date parameters to a URL using platform adapter system
function addDatesToUrl(url: string, checkIn: string, checkOut: string): string {
  // Only attach dates to sites that are likely to actually use them
  const shouldAttach =
    isBookingPlatform(url) ||
    isRegionalHotelSite(url) ||
    isDirectPropertySite(url) ||
    /booking\.com|vrbo\.com|homeaway\.|expedia\.|hotels\.com|agoda\.|tripadvisor\.|holidaycheck\./i.test(url);

  if (!shouldAttach) return url;

  // Use the platform adapter system for consistent deep link generation
  const { deepLink } = generatePricedDeepLink(url, checkIn, checkOut);
  return deepLink;
}

// Detect if content indicates dates are unavailable
function detectUnavailability(content: string): boolean {
  const unavailablePatterns = [
    /not available/i,
    /unavailable/i,
    /sold out/i,
    /no (rooms?|availability|vacancies)/i,
    /fully booked/i,
    /keine verfügbarkeit/i, // German
    /non disponible/i, // French
    /no disponible/i, // Spanish
    /ausgebucht/i, // German "sold out"
    /complet/i, // French "full"
    /select (different|other|new) dates/i,
    /try different dates/i,
    /change your dates/i,
    /sorry.*dates/i,
    /dates.*not available/i,
  ];
  return unavailablePatterns.some(p => p.test(content));
}

// Generate alternative date ranges to try
function generateAlternativeDates(checkIn: string, checkOut: string): Array<{ checkIn: string; checkOut: string; offset: number }> {
  const nights = calculateNights(checkIn, checkOut);
  const baseCheckIn = new Date(checkIn);
  const alternatives: Array<{ checkIn: string; checkOut: string; offset: number }> = [];
  
  // Try offsets: +1, -1, +2, -2, +3, -3, +7 days
  const offsets = [1, -1, 2, -2, 3, -3, 7];
  
  for (const offset of offsets) {
    const newCheckIn = new Date(baseCheckIn);
    newCheckIn.setDate(baseCheckIn.getDate() + offset);
    
    const newCheckOut = new Date(newCheckIn);
    newCheckOut.setDate(newCheckIn.getDate() + nights);
    
    // Don't try dates in the past
    if (newCheckIn > new Date()) {
      alternatives.push({
        checkIn: newCheckIn.toISOString().split('T')[0],
        checkOut: newCheckOut.toISOString().split('T')[0],
        offset,
      });
    }
  }
  
  return alternatives;
}

// Screenshot-based price extraction for any platform (multimodal AI)
async function extractPriceFromScreenshot(
  screenshotBase64: string,
  platformName: string,
  checkIn: string,
  checkOut: string,
  nights: number
): Promise<{
  perNight: number | null;
  total: number | null;
  currency: string | null;
  confidence: "high" | "medium" | "low";
  datesConfirmed: boolean;
}> {
  const lovableApiKey = Deno.env.get("LOVABLE_API_KEY");
  if (!lovableApiKey) return { perNight: null, total: null, currency: null, confidence: "low", datesConfirmed: false };

  try {
    const prompt = `This is a screenshot of a ${platformName} property booking page.
The dates being searched are: ${checkIn} to ${checkOut} (${nights} night(s)).

Task:
1) Look for the TOTAL price or per-night price displayed for booking this property.
2) Verify if the displayed dates match or are close to ${checkIn} - ${checkOut}.
3) Extract the most prominent/final price shown (prefer total price if available).

Return ONLY JSON:
{"total": <number|null>, "perNight": <number|null>, "currency": "<EUR|USD|GBP|CHF|etc>", "confidence": "high"|"medium"|"low", "datesConfirmed": <true|false>}

Rules:
- If you see a clear price with dates matching ${checkIn}-${checkOut}, set datesConfirmed=true.
- If dates are different but close (within 3 days), still extract the price but set datesConfirmed=false.
- Ignore prices for other properties, recommendations, or ads.
- "high" confidence = clear price displayed, dates match.
- "medium" confidence = price visible but dates unclear.
- "low" confidence = no clear price found.`;

    const imageUrl = `data:image/png;base64,${screenshotBase64}`;

    const response = await fetchWithTimeout(
      "https://ai.gateway.lovable.dev/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${lovableApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                { type: "image_url", image_url: { url: imageUrl } },
              ],
            },
          ],
          max_tokens: 150,
        }),
      },
      25_000
    );

    if (!response.ok) {
      console.error("Screenshot AI request failed:", response.status);
      return { perNight: null, total: null, currency: null, confidence: "low", datesConfirmed: false };
    }

    const data = await response.json();
    const responseText = data.choices?.[0]?.message?.content?.trim() || "";

    // Parse JSON from response
    let jsonStr = responseText;
    const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    } else if (responseText.startsWith("{")) {
      jsonStr = responseText;
    }

    const parsed = JSON.parse(jsonStr);
    console.log(`Screenshot price extraction for ${platformName}:`, parsed);

    const confidence = (["high", "medium", "low"].includes(parsed.confidence)) 
      ? parsed.confidence as "high" | "medium" | "low" 
      : "low";

    let total = typeof parsed.total === "number" ? parsed.total : null;
    let perNight = typeof parsed.perNight === "number" ? parsed.perNight : null;

    // Calculate missing value
    if (total && !perNight && nights > 0) perNight = Math.round(total / nights);
    if (perNight && !total && nights > 0) total = perNight * nights;

    // Validate ranges
    if (perNight && (perNight < 5 || perNight > 10000)) {
      return { perNight: null, total: null, currency: null, confidence: "low", datesConfirmed: false };
    }

    return {
      perNight,
      total,
      currency: parsed.currency || null,
      confidence,
      datesConfirmed: Boolean(parsed.datesConfirmed),
    };
  } catch (e) {
    console.error("Screenshot price extraction error:", e);
    return { perNight: null, total: null, currency: null, confidence: "low", datesConfirmed: false };
  }
}

// Enhanced scrape price from a listing page using Platform Adapters + Firecrawl + Screenshot fallback
async function scrapePriceFromListing(
  url: string,
  checkIn: string,
  checkOut: string,
  firecrawlApiKey: string,
  platformName: string = "Unknown Platform",
  shouldSkip?: () => Promise<boolean>,
): Promise<{ 
  price: number | null; 
  totalPrice: number | null; 
  perNightRate: number | null;
  usedCheckIn: string;
  usedCheckOut: string;
  datesDiffer: boolean;
  extractionMethod?: string;
  reliability?: LinkReliability;
  skipped?: boolean;
}> {
  const nights = calculateNights(checkIn, checkOut);
  
  // Get platform adapter for optimized deep link generation
  const adapter = getPlatformAdapter(url);
  console.log(`Using ${adapter.name} adapter (capability: ${adapter.capability}, reliability: ${adapter.reliability})`);

  const normalizeNumber = (raw: string): number | null => {
    let s = raw.replace(/\u00a0/g, " ").replace(/[\s'']/g, "").trim();
    const lastComma = s.lastIndexOf(",");
    const lastDot = s.lastIndexOf(".");

    if (lastComma !== -1 && lastDot !== -1) {
      if (lastComma > lastDot) {
        s = s.replace(/\./g, "").replace(/,/g, ".");
      } else {
        s = s.replace(/,/g, "");
      }
    } else if (lastComma !== -1 && lastDot === -1) {
      const decimals = s.slice(lastComma + 1);
      if (decimals.length === 2) s = s.replace(/,/g, ".");
      else s = s.replace(/,/g, "");
    } else {
      const dotParts = s.split(".");
      if (dotParts.length === 2 && dotParts[1].length === 3) {
        s = s.replace(/\./g, "");
      }
    }

    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    return n;
  };

  const tryExtract = (content: string): { extracted: number | null; isPerNight: boolean } => {
    const currency = String.raw`(?:\$|€|£|CHF|USD|EUR|GBP|ZAR|AUD|CAD|NZD|SEK|NOK|DKK|PLN|CZK|HUF|R\$|R)`;
    const amount = String.raw`(\d{1,3}(?:[\s,.']\d{3})*(?:[\.,]\d{2})?|\d{2,6})`;
    const reAll = new RegExp(String.raw`${currency}\s*${amount}|${amount}\s*${currency}`, "gi");
    const candidates: Array<{ value: number; perNightHint: boolean }> = [];

    let match: RegExpExecArray | null;
    while ((match = reAll.exec(content)) !== null) {
      const raw = match[1] || match[2];
      const parsed = raw ? normalizeNumber(raw) : null;
      if (!parsed || parsed <= 0 || parsed >= 50000) continue;

      const windowStart = Math.max(0, match.index - 25);
      const windowEnd = Math.min(content.length, match.index + match[0].length + 25);
      const windowText = content.slice(windowStart, windowEnd).toLowerCase();
      const perNightHint = /per\s*night|\/night|night/.test(windowText);

      candidates.push({ value: parsed, perNightHint });
    }

    if (candidates.length === 0) return { extracted: null, isPerNight: false };

    const perNightCandidates = candidates.filter((c) => c.perNightHint);
    if (perNightCandidates.length > 0) {
      const best = perNightCandidates.map((c) => c.value).filter((v) => v >= 10 && v <= 5000).sort((a, b) => b - a)[0];
      return best ? { extracted: best, isPerNight: true } : { extracted: null, isPerNight: false };
    }

    const bestTotal = candidates.map((c) => c.value).filter((v) => v >= 20 && v <= 50000).sort((a, b) => b - a)[0];
    return bestTotal ? { extracted: bestTotal, isPerNight: false } : { extracted: null, isPerNight: false };
  };

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // Enhanced Firecrawl fetch with screenshot support
  const fetchFirecrawlWithScreenshot = async (
    targetUrl: string,
    opts: { formats: string[]; onlyMainContent: boolean; waitFor: number },
  ): Promise<{ markdown: string; html: string; screenshot: string | null }> => {
    console.log("Scraping price from:", targetUrl.slice(0, 160));

    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // NOTE: Firecrawl requires waitFor <= timeout/2. Calculate timeout as 2.5x waitFor.
      const timeout = Math.max(30000, Math.ceil(opts.waitFor * 2.5));
      const resp = await fetch("https://api.firecrawl.dev/v1/scrape", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${firecrawlApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url: targetUrl,
          formats: opts.formats,
          onlyMainContent: opts.onlyMainContent,
          waitFor: opts.waitFor,
          timeout, // Required: waitFor must be <= timeout/2
        }),
      });

      if (!resp.ok) {
        console.log("Firecrawl request failed:", resp.status);
        if ((resp.status === 429 || resp.status === 503 || resp.status === 504) && attempt < MAX_ATTEMPTS) {
          const backoff = 800 * attempt * attempt + Math.floor(Math.random() * 250);
          console.log(`Retrying Firecrawl in ${backoff}ms (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
          await sleep(backoff);
          continue;
        }
        return { markdown: "", html: "", screenshot: null };
      }

      const data = await resp.json();
      const markdown: string = data.data?.markdown || data.markdown || "";
      const html: string = data.data?.html || data.html || "";
      const screenshot: string | null = data.data?.screenshot || data.screenshot || null;

      await sleep(150);
      return { markdown, html, screenshot };
    }

    return { markdown: "", html: "", screenshot: null };
  };

  const tryScrapeDates = async (tryCheckIn: string, tryCheckOut: string): Promise<{
    extracted: number | null;
    isPerNight: boolean;
    isUnavailable: boolean;
    extractionMethod: string;
  }> => {
    // Use platform adapter to generate optimized deep link
    const { deepLink } = generatePricedDeepLink(url, tryCheckIn, tryCheckOut);
    const tryNights = calculateNights(tryCheckIn, tryCheckOut);

    console.log(`Scraping ${platformName} with adapter-generated deep link: ${deepLink.slice(0, 180)}`);

    // Use adapter's recommended wait time and include screenshot for session-driven platforms
    const includeScreenshot = adapter.useScreenshotFallback || adapter.capability === "session_driven";
    const formats = includeScreenshot ? ["markdown", "html", "screenshot"] : ["markdown", "html"];
    
    const scrapeResult = await fetchFirecrawlWithScreenshot(deepLink, {
      formats,
      onlyMainContent: false,
      waitFor: adapter.scrapeWaitTime,
    });

    let content = scrapeResult.markdown || "";
    const htmlText = (scrapeResult.html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");
    content = [content, htmlText].join("\n");

    // Check for unavailability first
    if (detectUnavailability(content)) {
      console.log(`Dates ${tryCheckIn} - ${tryCheckOut} appear unavailable on ${platformName}`);
      return { extracted: null, isPerNight: false, isUnavailable: true, extractionMethod: "unavailable" };
    }

    // Strategy 1: AI text extraction
    console.log(`Using AI to extract price from ${platformName} content (${content.length} chars)`);
    const aiResult = await extractAlternativePlatformPriceWithAI(content, platformName, tryCheckIn, tryCheckOut, tryNights);

    const aiAcceptable =
      aiResult.datesConfirmed &&
      (aiResult.confidence === "high" || aiResult.confidence === "medium") &&
      !!aiResult.perNight &&
      aiResult.perNight >= 5;

    if (aiAcceptable) {
      console.log(`AI text extracted ${platformName} price: ${aiResult.perNight}/night (confidence: ${aiResult.confidence})`);
      return { extracted: aiResult.perNight!, isPerNight: true, isUnavailable: false, extractionMethod: "ai_text" };
    }

    // Strategy 2: Screenshot-based extraction (for session-driven platforms)
    if (scrapeResult.screenshot && adapter.useScreenshotFallback) {
      console.log(`Attempting screenshot-based price extraction for ${platformName}`);
      const screenshotResult = await extractPriceFromScreenshot(
        scrapeResult.screenshot,
        platformName,
        tryCheckIn,
        tryCheckOut,
        tryNights
      );

      if (screenshotResult.perNight && screenshotResult.confidence !== "low") {
        console.log(`Screenshot extracted ${platformName} price: ${screenshotResult.perNight}/night (confidence: ${screenshotResult.confidence})`);
        return { 
          extracted: screenshotResult.perNight, 
          isPerNight: true, 
          isUnavailable: false, 
          extractionMethod: "screenshot" 
        };
      }
    }

    // Strategy 3: Regex fallback (only if content mentions dates)
    const mentionsDates = content.includes(tryCheckIn) || content.includes(tryCheckOut);
    if (mentionsDates) {
      const { extracted, isPerNight } = tryExtract(content);
      if (extracted) {
        console.log(`Regex extracted ${platformName} price: ${extracted} (isPerNight: ${isPerNight})`);
        return { extracted, isPerNight, isUnavailable: false, extractionMethod: "regex" };
      }
    }

    console.log(`No price extracted for ${platformName} (AI datesConfirmed=${aiResult.datesConfirmed}, confidence=${aiResult.confidence})`);
    return { extracted: null, isPerNight: false, isUnavailable: false, extractionMethod: "none" };
  };

  try {
    // First try with exact dates
    let result = await tryScrapeDates(checkIn, checkOut);
    let extractionMethod = result.extractionMethod;
    
    // If unavailable or no price found, try alternative dates
    if (result.isUnavailable || !result.extracted) {
      const alternatives = generateAlternativeDates(checkIn, checkOut);
      
      for (const alt of alternatives) {
        // Check for skip request BEFORE each alternative date attempt
        if (shouldSkip && await shouldSkip()) {
          console.log(`SKIP requested during ${platformName} alternative date loop - aborting`);
          return {
            price: null,
            totalPrice: null,
            perNightRate: null,
            usedCheckIn: checkIn,
            usedCheckOut: checkOut,
            datesDiffer: false,
            extractionMethod: "skipped",
            reliability: adapter.reliability,
            skipped: true,
          };
        }
        
        console.log(`Trying alternative dates: ${alt.checkIn} - ${alt.checkOut} (offset ${alt.offset > 0 ? '+' : ''}${alt.offset} days)`);
        result = await tryScrapeDates(alt.checkIn, alt.checkOut);
        extractionMethod = result.extractionMethod;
        
        if (result.extracted && !result.isUnavailable) {
          console.log(`Found price with alternative dates: ${alt.checkIn} - ${alt.checkOut}`);
          const altNights = calculateNights(alt.checkIn, alt.checkOut);
          
          if (result.isPerNight) {
            return { 
              price: result.extracted, 
              totalPrice: result.extracted * altNights, 
              perNightRate: result.extracted,
              usedCheckIn: alt.checkIn,
              usedCheckOut: alt.checkOut,
              datesDiffer: true,
              extractionMethod,
              reliability: adapter.reliability,
            };
          }
          
          const perNight = Math.round(result.extracted / altNights);
          return { 
            price: perNight, 
            totalPrice: result.extracted, 
            perNightRate: perNight,
            usedCheckIn: alt.checkIn,
            usedCheckOut: alt.checkOut,
            datesDiffer: true,
            extractionMethod,
            reliability: adapter.reliability,
          };
        }
      }
    }
    
    // Original dates worked (or no alternatives worked either)
    if (!result.extracted) {
      return { 
        price: null, 
        totalPrice: null, 
        perNightRate: null,
        usedCheckIn: checkIn,
        usedCheckOut: checkOut,
        datesDiffer: false,
        extractionMethod: "none",
        reliability: adapter.reliability,
      };
    }

    if (result.isPerNight) {
      return { 
        price: result.extracted, 
        totalPrice: result.extracted * nights, 
        perNightRate: result.extracted,
        usedCheckIn: checkIn,
        usedCheckOut: checkOut,
        datesDiffer: false,
        extractionMethod,
        reliability: adapter.reliability,
      };
    }

    const perNight = Math.round(result.extracted / nights);
    return { 
      price: perNight, 
      totalPrice: result.extracted, 
      perNightRate: perNight,
      usedCheckIn: checkIn,
      usedCheckOut: checkOut,
      datesDiffer: false,
      extractionMethod,
      reliability: adapter.reliability,
    };
  } catch (error) {
    console.error("Price scraping error:", error);
    return { 
      price: null, 
      totalPrice: null, 
      perNightRate: null,
      usedCheckIn: checkIn,
      usedCheckOut: checkOut,
      datesDiffer: false,
      extractionMethod: "error",
      reliability: adapter.reliability,
    };
  }
}

function isLikelyPropertyImage(url: string): boolean {
  const u = url.toLowerCase();
  if (!u.startsWith("http")) return false;
  if (!/\.(jpg|jpeg|png|webp)(\?|$)/i.test(u)) return false;
  const exclude = ["logo", "favicon", "sprite", "icon", "avatar", "profile", "brand", "placeholder", "analytics", "doubleclick"]; 
  if (exclude.some((k) => u.includes(k))) return false;
  return true;
}

// For some platforms (Booking/TripAdvisor), Lens thumbnails can be too small/cropped and cause false negatives.
// This scrapes the page to pull a higher-quality image for AI verification.
async function scrapeBestImageFromListing(url: string, firecrawlApiKey: string): Promise<string | null> {
  try {
    // NOTE: Firecrawl requires waitFor <= timeout/2. Use timeout=15000, waitFor=2500.
    const response = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${firecrawlApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        formats: ["html"],
        onlyMainContent: false,
        waitFor: 2500,
        timeout: 15000, // Required: waitFor must be <= timeout/2
      }),
    });

    if (!response.ok) return null;
    const data = await response.json();
    const html: string = data.data?.html || data.html || "";
    if (!html) return null;

    // Prefer OG images
    const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/i)
      || html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["'][^>]*>/i);
    if (ogMatch?.[1] && isLikelyPropertyImage(ogMatch[1])) return ogMatch[1];

    // Fallback: first few img src candidates
    const imgMatches = [...html.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi)].slice(0, 40);
    for (const m of imgMatches) {
      const src = m[1];
      if (src && isLikelyPropertyImage(src)) return src;
    }

    return null;
  } catch (e) {
    console.error("scrapeBestImageFromListing error:", e);
    return null;
  }
}

// Extract location info from title/URL
function extractLocationFromTitle(title: string): { city: string | null; country: string | null } {
  // Common location patterns in Airbnb titles
  const locationPatterns = [
    /in\s+([A-Za-z\s]+),\s*([A-Za-z\s]+)$/i,
    /([A-Za-z\s]+),\s*([A-Za-z\s]+)$/,
    /·\s*([A-Za-z\s]+)$/i,
  ];
  
  for (const pattern of locationPatterns) {
    const match = title.match(pattern);
    if (match) {
      return { city: match[1]?.trim() || null, country: match[2]?.trim() || null };
    }
  }
  
  // Try to find city names in the title
  const knownCities = [
    "Cape Town", "Johannesburg", "Durban", "Paris", "London", "Berlin", "Rome",
    "Barcelona", "Madrid", "Amsterdam", "Vienna", "Prague", "Budapest", "Lisbon",
    "Zurich", "Geneva", "Munich", "Frankfurt", "Milan", "Venice", "Florence",
    "Nice", "Marseille", "Lyon", "Hamburg", "Cologne", "Stuttgart", "Salzburg"
  ];
  
  const lowerTitle = title.toLowerCase();
  for (const city of knownCities) {
    if (lowerTitle.includes(city.toLowerCase())) {
      return { city, country: null };
    }
  }
  
  return { city: null, country: null };
}

// ============================================================================
// DEPRECATED: Text search fallback - NO LONGER SURFACES RESULTS TO USERS
// ============================================================================
// Text search may still be called for logging/analytics purposes, but NEVER
// populates the alternatives array. Only image-verified matches are valid.
//
// Core Product Principle (Non-Negotiable):
// The platform exists to identify the same property using reverse image search.
// If images do not clearly match with high probability, the candidate is NOT
// a valid alternative, regardless of text similarity, naming, or location.
// ============================================================================
async function addTargetedTextMatches(opts: {
  serpApiKey: string;
  title: string;
  cityHint?: string | null;
  imageUrlForVerification?: string | null;
  alternatives: SearchResult[];
  foundUrls: Set<string>;
  controller?: SSEController;
  errorTracker?: ApiErrorTracker;
  checkSkip?: () => Promise<boolean>;
}) {
  const { serpApiKey, title, cityHint, imageUrlForVerification, foundUrls, controller, errorTracker, checkSkip } = opts;
  // NOTE: `alternatives` parameter is intentionally NOT used - text matches must never be surfaced

  const cleanTitle = title.replace(/\s+/g, " ").trim();
  const queries = [
    `${cleanTitle} ${cityHint ?? ""} site:rentbyowner.com`,
    `${cleanTitle} ${cityHint ?? ""} site:booking.com`,
    `${cleanTitle} ${cityHint ?? ""} site:tripadvisor.`,
  ].map(q => q.replace(/\s+/g, " ").trim());

  // Track text matches found for logging purposes only (never surfaced to users)
  let textMatchesFound = 0;
  let visuallyVerifiedFromText = 0;

  for (const q of queries) {
    // Check if skip was requested
    if (checkSkip && await checkSkip()) {
      console.log("Text search: Skip requested, aborting");
      controller && sendProgress(controller, "Skipped text search", "Moving to results");
      break;
    }
    
    // Check if we should abort due to API errors
    if (errorTracker && shouldAbortDueToApiErrors(errorTracker)) {
      console.log("Aborting text search due to API errors");
      controller && sendProgress(controller, "Search paused", getApiErrorSummary(errorTracker) || "API error");
      break;
    }

    // Log that text search is running (for internal analytics only)
    console.log(`[TextSearch] Running query for analytics: ${q.slice(0, 100)}`);

    const result = await fetchSerpApi(`engine=google&q=${encodeURIComponent(q)}&num=10`, serpApiKey);
    
    if (!result.success) {
      if (errorTracker && result.error) {
        recordApiError(errorTracker, result.error);
      }
      continue;
    }
    
    // Reset consecutive errors on success
    if (errorTracker) resetConsecutiveErrors(errorTracker);

    const data = result.data;
    const organic = (data?.organic_results || []) as Array<any>;

    for (const r of organic) {
      const url: string | undefined = r.link;
      if (!url) continue;
      if (url.toLowerCase().includes("airbnb.")) continue;
      if (foundUrls.has(url)) continue;

      // Only accept URLs that match our platform heuristics and aren't blocked
      if (isBlockedNonBookingPlatform(url)) continue;
      if (!isBookingPlatform(url) && !isRegionalHotelSite(url) && !isDirectPropertySite(url)) continue;
      
      // Validate URL is an actual bookable property page (not category/search page)
      const urlValidation = isValidBookablePropertyUrl(url);
      if (!urlValidation.valid) continue;

      textMatchesFound++;

      // ============================================================================
      // TEXT MATCHES ARE LOGGED BUT NEVER ADDED TO ALTERNATIVES
      // Only if AI visual verification passes with high confidence would we add it
      // ============================================================================
      const thumb: string | null = r.thumbnail || null;
      
      // If we have both reference image and thumbnail, attempt visual verification
      // ONLY visually verified matches from text search may be added
      if (imageUrlForVerification && thumb) {
        if (checkSkip && await checkSkip()) {
          console.log("Text search: Skip requested during AI verification, aborting");
          return;
        }
        
        const ai = await compareImagesWithAI(imageUrlForVerification, thumb);
        
        // STRICT: Only high-confidence visual matches (90%+) are valid
        if (ai.isMatch && ai.score >= 90) {
          visuallyVerifiedFromText++;
          foundUrls.add(url);
          
          // This is the ONLY path where text search can produce a result:
          // when AI visual verification confirms it's the same property
          opts.alternatives.push({
            platform_name: getPlatformName(url),
            listing_url: url,
            listing_title: r.title || r.snippet || null,
            price: null,
            confidence_score: ai.score,
            image_url: thumb,
            images: thumb ? [thumb] : [],
            match_type: 'visual', // CRITICAL: Must be 'visual' since AI verified it
            source_airbnb_image: imageUrlForVerification || null,
          });
          
          controller && sendProgress(controller, "Visual match from text search", `${getPlatformName(url)} · ${ai.score}% verified`);
        } else {
          // Log but do NOT add to alternatives - text-only matches are never surfaced
          console.log(`[TextSearch] Rejected text match (no visual verification): ${getPlatformName(url)} - ${url.slice(0, 80)}`);
        }
      } else {
        // No thumbnail or no reference image - cannot visually verify, do NOT add
        console.log(`[TextSearch] Skipped text match (no images for verification): ${getPlatformName(url)} - ${url.slice(0, 80)}`);
      }
    }
  }

  // Log summary for analytics/debugging
  console.log(`[TextSearch] Summary: ${textMatchesFound} text matches found, ${visuallyVerifiedFromText} visually verified and added`);
  if (textMatchesFound > 0 && visuallyVerifiedFromText === 0) {
    controller && sendProgress(controller, "No visual matches from text search", 
      `Found ${textMatchesFound} text candidates but none passed image verification`);
  }
}

// Streaming search implementation
async function runSearchWithStreaming(
  controller: SSEController,
  opts: {
    search: any;
    searchId: string;
    supabase: any; // Use any to avoid complex type inference
    serpApiKey: string;
    firecrawlApiKey?: string;
    simulateBrowserlessFail?: boolean; // For testing fallback chain
  }
) {
  const { search, searchId, supabase, serpApiKey, firecrawlApiKey, simulateBrowserlessFail = false } = opts;

  sendProgress(controller, "Starting search", `Analyzing ${search.airbnb_url.slice(0, 60)}...`);

  const roomIdMatch = search.airbnb_url.match(/rooms\/(\d+)/);
  const roomId = roomIdMatch ? roomIdMatch[1] : null;

  // Extract dates - REQUIRED in URL
  const { checkIn, checkOut } = extractDatesFromUrl(search.airbnb_url);
  if (!checkIn || !checkOut) {
    console.log("Missing dates in URL - dates are required for price comparison");
    await supabase.from("searches").update({ 
      status: "dates_required" 
    }).eq("id", searchId);
    sendProgress(controller, "Dates required", "Please include check-in and check-out dates in your Airbnb URL to compare prices");
    sendSSE(controller, "error", { 
      message: "Dates are required for price comparison. Please copy a full Airbnb URL that includes your check-in and check-out dates (e.g., airbnb.com/rooms/123?check_in=2025-01-15&check_out=2025-01-18)." 
    });
    sendSSE(controller, "complete", { searchId, status: "dates_required" });
    return;
  }

  const nights = calculateNights(checkIn, checkOut);
  const alternatives: SearchResult[] = [];
  const foundUrls = new Set<string>();
  let airbnbTitle = "Vacation Rental";
  let airbnbPrice: number | null = null;
  let airbnbCurrency: string = 'USD'; // Track currency from extraction
  let imageUrls: string[] = [];
  let skipAirbnbPrice = false;
  // Track scraped content for failure diagnosis
  let lastScrapedContent: { markdown: string; html: string; hasScreenshot: boolean } = { 
    markdown: '', html: '', hasScreenshot: false 
  };
  
  // Helper to check if a title is valid (not a generic/checkout page title)
  const isValidTitle = (title: string | null | undefined): boolean => {
    if (!title || typeof title !== 'string') return false;
    const normalized = title.trim().toLowerCase();
    const invalidTitles = [
      'vacation rental',
      'confirm and pay',
      'airbnb',
      'confirm & pay',
      'request to book',
      'book your stay',
    ];
    return !invalidTitles.some(invalid => normalized === invalid || normalized.startsWith(invalid + ' -'));
  };

  // IMPORTANT: Save dates immediately after extraction so they're available even if search stalls
  // CRITICAL: Reset skip_requested to false at start of pipeline to prevent stale flags from previous runs
  console.log(`Extracted dates from URL: checkIn=${checkIn}, checkOut=${checkOut}, nights=${nights}`);
  await supabase.from("searches").update({ 
    check_in_date: checkIn, 
    check_out_date: checkOut, 
    nights_count: nights,
    skip_requested: false, // Reset any stale skip flag from previous run/reconnect
    last_progress_at: new Date().toISOString() 
  }).eq("id", searchId);
  console.log(`[Pipeline] Reset skip_requested=false for fresh search run`);

  // If user already confirmed the Airbnb total, reuse it and continue.
  try {
    const { data: confirmed } = await supabase
      .from('airbnb_confirmed_totals')
      .select('confirmed_total_amount, confirmed_currency, confirmation_source')
      .eq('search_id', searchId)
      .maybeSingle();

    if (confirmed?.confirmed_total_amount && confirmed.confirmation_source === 'user') {
      airbnbPrice = confirmed.confirmed_total_amount;
      airbnbCurrency = confirmed.confirmed_currency || airbnbCurrency;
      // Reuse any previously stored images/title to avoid re-scraping when possible
      const existingImages = Array.isArray(search.airbnb_images)
        ? (search.airbnb_images as unknown[]).filter((u): u is string => typeof u === 'string')
        : [];
      if (existingImages.length > 0) {
        imageUrls = existingImages;
      }
      // Only use existing title if it's a valid property title (not "Confirm and pay")
      if (isValidTitle(search.airbnb_title)) {
        airbnbTitle = search.airbnb_title!;
      }

      const confirmedAmount = confirmed.confirmed_total_amount;
      sendProgress(
        controller,
        'Airbnb total confirmed',
        `Using your confirmed total: ${airbnbCurrency} ${confirmedAmount.toLocaleString()}`
      );

      await supabase.from('searches').update({
        airbnb_price: airbnbPrice,
        airbnb_currency: airbnbCurrency,
        api_error: null,
        api_error_code: null,
        last_progress_at: new Date().toISOString(),
      }).eq('id', searchId);
    }
  } catch (e) {
    console.log('Confirmed total lookup failed:', (e as Error)?.message || e);
  }

  // Heartbeat helper - updates last_progress_at so UI can detect stalls
  const heartbeat = async () => {
    await supabase.from("searches").update({ last_progress_at: new Date().toISOString() }).eq("id", searchId);
  };

  // Allow UI to request skipping a stuck step (via skip_requested column)
  // IMPORTANT: This must only skip ONE upcoming check, not the entire remainder of the run.
  // We implement this as an atomic "claim" operation: if skip_requested=true, flip it to false.
  //
  // Compatibility: some helpers expect `checkSkip?: () => Promise<boolean>`.
  // We keep `claimSkipNow(): Promise<boolean>` for those call sites and provide
  // `claimSkipNowDetailed()` for evidence payloads.
  type SkipClaimResult = {
    skip_requested_before_claim: boolean;
    skip_claim_succeeded: boolean;
  };

  const claimSkipNowDetailed = async (): Promise<SkipClaimResult> => {
    const { data: beforeRow, error: beforeErr } = await supabase
      .from("searches")
      .select("skip_requested")
      .eq("id", searchId)
      .maybeSingle();

    if (beforeErr) {
      console.log("claimSkipNow read error:", beforeErr.message || beforeErr);
    }

    const skipRequestedBefore = beforeRow?.skip_requested === true;

    const { data, error } = await supabase
      .from("searches")
      .update({ skip_requested: false })
      .eq("id", searchId)
      .eq("skip_requested", true)
      .select("id");

    if (error) {
      console.log("claimSkipNow update error:", error.message || error);
      return { skip_requested_before_claim: skipRequestedBefore, skip_claim_succeeded: false };
    }

    const succeeded = Array.isArray(data) && data.length > 0;
    return { skip_requested_before_claim: skipRequestedBefore, skip_claim_succeeded: succeeded };
  };

  const claimSkipNow = async (): Promise<boolean> => {
    const claim = await claimSkipNowDetailed();
    return claim.skip_claim_succeeded;
  };

  // Heartbeat on start
  await heartbeat();

  // Stage 1 telemetry + hard timeout guard
  const AIRBNB_STAGE_TIMEOUT_MS = 30_000;
  const stage1StartedAt = Date.now();
  const checkStage1Timeout = () => {
    if (Date.now() - stage1StartedAt > AIRBNB_STAGE_TIMEOUT_MS) {
      throw new Error("AIRBNB_PARSING_TIMEOUT");
    }
  };

  let stage1Outcome: StageOutcome = 'success';
  let stage1Error: string | undefined;
  await startStageRun(supabase, searchId, 'analyze_listing', {
    airbnb_url: search.airbnb_url,
    check_in: checkIn,
    check_out: checkOut,
  });

  // =====================================================================
  // MULTI-PROVIDER DEBUGGING MODE: Run providers and compare prices
  // NOTE: Airbnb baseline must be GROUNDED: never return a number without
  // verbatim evidence + explicit classification.
  // =====================================================================
  interface ProviderPriceResult {
    provider: AirbnbProvider | 'firecrawl';
    baseline: AirbnbBaselineExtraction;
    error?: string;
    contentLength?: number;
    durationMs?: number;
    isRateLimited?: boolean; // True if 429 rate limit detected
    isDatesUnavailable?: boolean; // True if Airbnb shows "dates unavailable" interstitial
    // OCR validation fields
    ocrReference?: OcrVisualReference | null;
    ocrValidation?: OcrValidationResult | null;
  }

  // Shared OCR reference - captured from Browserless (first provider with screenshots)
  let sharedOcrReference: OcrVisualReference | null = null;
  
  // Generate a unique run ID for debug persistence
  const debugRunId = crypto.randomUUID();

  const providerResults: ProviderPriceResult[] = [];

  // Helper to extract GROUNDED Airbnb baseline from content (HTML preferred, then markdown)
  const extractBaselineFromContent = (html: string, markdown: string, provider: string): AirbnbBaselineExtraction => {
    const htmlExtraction = html && html.length > 200
      ? extractAirbnbBaselineGrounded(html, nights, provider)
      : null;

    // If HTML produced a usable classification (including a clear per-night-only), keep it.
    if (htmlExtraction && htmlExtraction.status !== 'price_not_available_in_content') {
      return htmlExtraction;
    }

    const mdExtraction = markdown && markdown.length > 200
      ? extractAirbnbBaselineGrounded(markdown, nights, provider)
      : null;

    if (mdExtraction && mdExtraction.status !== 'price_not_available_in_content') {
      return mdExtraction;
    }

    // Fall back to whichever had the richer debug bundle.
    return htmlExtraction || mdExtraction || {
      status: 'price_not_available_in_content',
      price: null,
      currency: null,
      includes_taxes_fees: false,
      evidence_snippet: '',
      debug: { provider, content_hash: hashContent(html || markdown || ''), candidates: [] },
    };
  };

  try {
    // ========================================================================
    // BROWSERLESS-ONLY DEBUG MODE (disabled by default)
    // When BROWSERLESS_ONLY_BASELINE=true, run only Browserless and stop
    // immediately if it fails. No Zyte fallback, no platform discovery.
    // For normal runs, this is OFF and the full fallback chain is used.
    // ========================================================================
    const browserlessOnlyEnvValue = Deno.env.get("BROWSERLESS_ONLY_BASELINE");
    const browserlessOnlyMode = browserlessOnlyEnvValue === "true";
    
    // Only log debug mode status when explicitly enabled (avoid log spam in normal runs)
    if (browserlessOnlyMode) {
      console.log("==========================================");
      console.log("⚠️ BROWSERLESS ONLY DEBUG MODE ACTIVE");
      console.log(`  Env value: "${browserlessOnlyEnvValue}"`);
      console.log("Will stop run if Browserless fails with ANY non-success state:");
      console.log("  - needs_user_confirmation");
      console.log("  - price_not_available_in_content");
      console.log("  - total_price_excluding_taxes_and_fees");
      console.log("  - any error");
      console.log("No Zyte fallback, no platform discovery");
      console.log("==========================================");
      sendProgress(controller, "DEBUG MODE", "Browserless-only baseline mode enabled — stopping on ANY non-success", {
        browserless_only_mode: true,
        env_value: browserlessOnlyEnvValue,
      });
    }

    // Step 1: Extract Airbnb baseline using classic fallback order (Firecrawl -> Zyte -> Browserless)
    sendProgress(controller, "Analyzing listing", "Extracting property details and Airbnb price");
    sendStatusUpdate(controller, "scraping_airbnb_page");
    await supabase.from("searches").update({ status: "scraping_airbnb_page", last_progress_at: new Date().toISOString() }).eq("id", searchId);

    const zyteApiKey = Deno.env.get("ZYTE_API_KEY");
    const browserlessApiKey = Deno.env.get("BROWSERLESS_API_KEY");

    // Define extraction tasks (re-used by fallback chain)
    const emptyBaseline = (provider: string): AirbnbBaselineExtraction => ({
      status: 'price_not_available_in_content',
      price: null,
      currency: null,
      includes_taxes_fees: false,
      evidence_snippet: '',
      debug: { provider, content_hash: hashContent(''), candidates: [] },
    });

    const firecrawlTask = async (): Promise<ProviderPriceResult> => {
      const start = Date.now();
      const provider = 'firecrawl' as const;
      try {
        if (!firecrawlApiKey) {
          return { provider, baseline: emptyBaseline('Firecrawl'), error: 'No API key', durationMs: Date.now() - start };
        }

        const resp = await fetchWithTimeout(
          "https://api.firecrawl.dev/v1/scrape",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${firecrawlApiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              url: search.airbnb_url,
              formats: ["markdown", "html", "rawHtml", "screenshot"],
              onlyMainContent: false,
              waitFor: 10000,
              timeout: 30000,
            }),
          },
          35_000
        );

        const durationMs = Date.now() - start;
        const httpStatus = resp.status;

        if (!resp.ok) {
          const errText = await resp.text().catch(() => "");
          const errorMsg = `HTTP ${resp.status}: ${errText.slice(0, 100)}`;
          
          // Log failed request
          await logProviderRequest({
            supabase,
            provider: 'firecrawl',
            endpointType: 'airbnb_scrape',
            searchId,
            url: search.airbnb_url,
            success: false,
            httpStatus,
            durationMs,
            errorMessage: errorMsg,
          });
          
          return {
            provider,
            baseline: emptyBaseline('Firecrawl'),
            error: errorMsg,
            durationMs,
          };
        }

        // Log successful request
        await logProviderRequest({
          supabase,
          provider: 'firecrawl',
          endpointType: 'airbnb_scrape',
          searchId,
          url: search.airbnb_url,
          success: true,
          httpStatus,
          durationMs,
        });

        const data = await resp.json();
        const html = data?.data?.rawHtml || data?.data?.html || "";
        const markdown = data?.data?.markdown || "";

        // Track for failure diagnosis downstream
        lastScrapedContent = { markdown, html, hasScreenshot: Boolean(data?.data?.screenshot) };

        // Extract images for later use
        if (imageUrls.length === 0) {
          const imagePatterns = [
            /https:\/\/a\d+\.muscache\.com\/im\/pictures\/[^"'\s\)]+/gi,
            /https:\/\/.*?\.muscache\.com\/im\/pictures\/[^"'\s\)]+/gi,
          ];
          const canonicalize = (url: string) => url.replace(/\\u002F/g, "/").split("?")[0];
          let allImages: string[] = [];
          for (const pattern of imagePatterns) {
            allImages.push(...(html.match(pattern) || []));
          }
          const unique = [...new Set(allImages.map(canonicalize))];
          imageUrls = unique.filter(isValidPropertyImage).map((u) => `${u}?im_w=1200`).slice(0, 5);
        }

        // Extract title (only if current title is invalid)
        const metaTitle = data?.data?.metadata?.title;
        if (metaTitle && !isValidTitle(airbnbTitle)) {
          const cleanedTitle = metaTitle.replace(" - Airbnb", "").replace(" · Airbnb", "").trim();
          if (isValidTitle(cleanedTitle)) {
            airbnbTitle = cleanedTitle;
          }
        }

        const baseline = extractBaselineFromContent(html, markdown, 'Firecrawl');
        
        // Apply OCR validation using shared reference (if available from Browserless)
        const ocrValidation = validateProviderPriceWithOcr(
          baseline.price,
          baseline.currency,
          baseline.evidence_snippet,
          sharedOcrReference
        );
        
        console.log(`Firecrawl OCR validation: accepted=${ocrValidation.accepted}, status=${ocrValidation.status}, acceptedVia=${ocrValidation.acceptedVia}`);
        
        // If OCR validation rejects the price, update baseline
        let finalBaseline = baseline;
        if (!ocrValidation.accepted && baseline.price !== null) {
          console.log(`OCR rejected Firecrawl price ${baseline.price}: ${ocrValidation.mismatchReason}`);
          finalBaseline = {
            ...baseline,
            status: ocrValidation.status,
            price: ocrValidation.validatedPrice,
            includes_taxes_fees: ocrValidation.includesTaxesFees,
            evidence_snippet: ocrValidation.evidenceSnippet,
          };
        } else if (ocrValidation.accepted && ocrValidation.acceptedVia) {
          finalBaseline = {
            ...baseline,
            status: ocrValidation.status,
            includes_taxes_fees: ocrValidation.includesTaxesFees,
            evidence_snippet: ocrValidation.evidenceSnippet,
          };
        }
        
        return { 
          provider, 
          baseline: finalBaseline, 
          contentLength: html.length, 
          durationMs,
          ocrReference: sharedOcrReference,
          ocrValidation,
        };
      } catch (e) {
        const durationMs = Date.now() - start;
        const errorMsg = String(e);
        
        // Log exception as failed request
        await logProviderRequest({
          supabase,
          provider: 'firecrawl',
          endpointType: 'airbnb_scrape',
          searchId,
          url: search.airbnb_url,
          success: false,
          durationMs,
          errorMessage: errorMsg,
        });
        
        return { provider, baseline: emptyBaseline('Firecrawl'), error: errorMsg, durationMs };
      }
    };

    const zyteTask = async (): Promise<ProviderPriceResult> => {
      const start = Date.now();
      const provider = 'zyte' as const;
      try {
        if (!zyteApiKey) {
          return { provider, baseline: emptyBaseline('Zyte'), error: 'No API key', durationMs: Date.now() - start };
        }

        // CRITICAL: Use book/stays checkout URL to get all-in total (same as Browserless)
        const bookStaysParams = buildBookStaysUrl(search.airbnb_url);
        const targetUrl = bookStaysParams?.book_stays_url || search.airbnb_url;
        console.log(`Zyte: Using ${bookStaysParams?.book_stays_url ? 'book/stays' : 'rooms'} URL:`, targetUrl.slice(0, 120));

        const zyteResult = await scrapeAirbnbWithZyte(targetUrl, zyteApiKey);
        const durationMs = Date.now() - start;

        // Log every Zyte request (success or failure)
        await logProviderRequest({
          supabase,
          provider: 'zyte',
          endpointType: 'airbnb_scrape',
          searchId,
          url: targetUrl,
          success: zyteResult.ok,
          httpStatus: zyteResult.statusCode,
          durationMs,
          errorMessage: zyteResult.ok ? undefined : zyteResult.error || 'Failed',
        });

        if (!zyteResult.ok) {
          return {
            provider,
            baseline: emptyBaseline('Zyte'),
            error: zyteResult.error || 'Failed',
            durationMs,
          };
        }

        lastScrapedContent = { markdown: zyteResult.markdown, html: zyteResult.html, hasScreenshot: Boolean(zyteResult.screenshot) };

        // Extract images from ROOMS page (not checkout page) - fetch separately if needed
        if (imageUrls.length === 0 && bookStaysParams?.rooms_url) {
          // Try to fetch rooms page for images since checkout page has limited images
          console.log('Zyte: Fetching rooms page for images:', bookStaysParams.rooms_url.slice(0, 80));
          try {
            const roomsResp = await fetchWithTimeout(bookStaysParams.rooms_url, {
              headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0" }
            }, 15_000);
            if (roomsResp.ok) {
              const roomsHtml = await roomsResp.text();
              const imagePatterns = [
                /https:\/\/a\d+\.muscache\.com\/im\/pictures\/[^"'\s\)]+/gi,
                /https:\/\/.*?\.muscache\.com\/im\/pictures\/[^"'\s\)]+/gi,
              ];
              const canonicalize = (url: string) => url.replace(/\\u002F/g, "/").split("?")[0];
              let allImages: string[] = [];
              for (const pattern of imagePatterns) {
                allImages.push(...(roomsHtml.match(pattern) || []));
              }
              const unique = [...new Set(allImages.map(canonicalize))];
              imageUrls = unique.filter(isValidPropertyImage).map((u) => `${u}?im_w=1200`).slice(0, 5);
              console.log(`Zyte: Extracted ${imageUrls.length} images from rooms page`);
              
              // Also extract title from rooms page if needed
              const titleMatch = roomsHtml.match(/<title>([^<]+)<\/title>/i);
              if (titleMatch && !isValidTitle(airbnbTitle)) {
                const cleanedTitle = titleMatch[1].replace(" - Airbnb", "").replace(" · Airbnb", "").trim();
                if (isValidTitle(cleanedTitle)) {
                  airbnbTitle = cleanedTitle;
                  console.log('Zyte: Extracted title from rooms page:', airbnbTitle);
                }
              }
            }
          } catch (roomsFetchErr) {
            console.log('Zyte: Failed to fetch rooms page for images:', roomsFetchErr);
          }
        }
        
        // Fallback: extract images from checkout page if rooms fetch failed
        if (imageUrls.length === 0) {
          const imagePatterns = [
            /https:\/\/a\d+\.muscache\.com\/im\/pictures\/[^"'\s\)]+/gi,
            /https:\/\/.*?\.muscache\.com\/im\/pictures\/[^"'\s\)]+/gi,
          ];
          const canonicalize = (url: string) => url.replace(/\\u002F/g, "/").split("?")[0];
          let allImages: string[] = [];
          for (const pattern of imagePatterns) {
            allImages.push(...(zyteResult.html.match(pattern) || []));
          }
          const unique = [...new Set(allImages.map(canonicalize))];
          imageUrls = unique.filter(isValidPropertyImage).map((u) => `${u}?im_w=1200`).slice(0, 5);
        }

        // Extract title from checkout page only if still invalid
        if (!isValidTitle(airbnbTitle)) {
          const titleMatch = zyteResult.html.match(/<title>([^<]+)<\/title>/i);
          if (titleMatch) {
            const cleanedTitle = titleMatch[1].replace(" - Airbnb", "").replace(" · Airbnb", "").trim();
            if (isValidTitle(cleanedTitle)) {
              airbnbTitle = cleanedTitle;
            }
          }
        }

        const baseline = extractBaselineFromContent(zyteResult.html, zyteResult.markdown, 'Zyte');
        
        // Apply OCR validation using shared reference (if available from Browserless)
        let ocrValidation = validateProviderPriceWithOcr(
          baseline.price,
          baseline.currency,
          baseline.evidence_snippet,
          sharedOcrReference
        );
        
        console.log(`Zyte OCR validation: accepted=${ocrValidation.accepted}, status=${ocrValidation.status}, acceptedVia=${ocrValidation.acceptedVia}`);
        
        // If OCR validation rejects the price, update baseline
        let finalBaseline = baseline;
        if (!ocrValidation.accepted && baseline.price !== null) {
          console.log(`OCR rejected Zyte price ${baseline.price}: ${ocrValidation.mismatchReason}`);
          finalBaseline = {
            ...baseline,
            status: ocrValidation.status,
            price: ocrValidation.validatedPrice,
            includes_taxes_fees: ocrValidation.includesTaxesFees,
            evidence_snippet: ocrValidation.evidenceSnippet,
          };
        } else if (ocrValidation.accepted && ocrValidation.acceptedVia) {
          finalBaseline = {
            ...baseline,
            status: ocrValidation.status,
            includes_taxes_fees: ocrValidation.includesTaxesFees,
            evidence_snippet: ocrValidation.evidenceSnippet,
          };
        }
        
        // ============ CRITICAL FIX: Subtotal is NEVER the final total ============
        // The book/stays page shows BOTH "$X for N nights" (subtotal) AND "Total (USD) $Y" (actual total)
        // The subtotal does NOT include taxes - we must find the actual Total line or require user confirmation
        // DO NOT promote subtotals to totals - this was the root cause of the regression
        
        // If we only found a subtotal, keep status as needs_user_confirmation - do NOT override
        
        return { 
          provider, 
          baseline: finalBaseline, 
          contentLength: zyteResult.html.length, 
          durationMs,
          ocrReference: sharedOcrReference,
          ocrValidation,
        };
      } catch (e) {
        const durationMs = Date.now() - start;
        const errorMsg = String(e);
        
        // Log exception as failed request
        await logProviderRequest({
          supabase,
          provider: 'zyte',
          endpointType: 'airbnb_scrape',
          searchId,
          url: search.airbnb_url,
          success: false,
          durationMs,
          errorMessage: errorMsg,
        });
        
        return { provider, baseline: emptyBaseline('Zyte'), error: errorMsg, durationMs };
      }
    };

    const browserlessTask = async (): Promise<ProviderPriceResult> => {
      const start = Date.now();
      const provider = 'browserless' as const;
      try {
        if (!browserlessApiKey) {
          return { provider, baseline: emptyBaseline('Browserless'), error: 'No API key', durationMs: Date.now() - start };
        }

        const browserlessResult = await scrapeAirbnbWithBrowserless(search.airbnb_url, browserlessApiKey, nights, searchId, supabase);
        const durationMs = Date.now() - start;

        // Log every Browserless request (success or failure)
        await logProviderRequest({
          supabase,
          provider: 'browserless',
          endpointType: 'airbnb_scrape',
          searchId,
          url: search.airbnb_url,
          success: browserlessResult.ok,
          httpStatus: browserlessResult.statusCode,
          durationMs,
          errorMessage: browserlessResult.ok ? undefined : browserlessResult.error || 'Failed',
        });

        if (!browserlessResult.ok) {
          return {
            provider,
            baseline: emptyBaseline('Browserless'),
            error: browserlessResult.error || 'Failed',
            durationMs,
            isRateLimited: browserlessResult.isRateLimited || false,
            isDatesUnavailable: browserlessResult.isDatesUnavailable || false,
          };
        }

        // Check for dates unavailable (terminal state - don't continue pipeline)
        if (browserlessResult.isDatesUnavailable) {
          console.log('Browserless detected dates unavailable - returning terminal state');
          const datesUnavailableBaseline = emptyBaseline('Browserless');
          datesUnavailableBaseline.status = 'dates_unavailable';
          datesUnavailableBaseline.evidence_snippet = browserlessResult.evidenceSnippet || 'Dates not available for this property';
          return {
            provider,
            baseline: datesUnavailableBaseline,
            error: 'dates_unavailable',
            durationMs,
            isRateLimited: false,
            isDatesUnavailable: true,
          };
        }

        lastScrapedContent = { markdown: browserlessResult.markdown, html: browserlessResult.html, hasScreenshot: Boolean(browserlessResult.screenshot) };

        // Extract images from ROOMS page HTML (not checkout page)
        if (imageUrls.length === 0) {
          const roomsHtmlContent = browserlessResult.roomsHtml || browserlessResult.html;
          const imagePatterns = [
            /https:\/\/a\d+\.muscache\.com\/im\/pictures\/[^"'\s\)]+/gi,
            /https:\/\/.*?\.muscache\.com\/im\/pictures\/[^"'\s\)]+/gi,
          ];
          const canonicalize = (url: string) => url.replace(/\\u002F/g, "/").split("?")[0];
          let allImages: string[] = [];
          for (const pattern of imagePatterns) {
            allImages.push(...(roomsHtmlContent.match(pattern) || []));
          }
          const unique = [...new Set(allImages.map(canonicalize))];
          imageUrls = unique.filter(isValidPropertyImage).map((u) => `${u}?im_w=1200`).slice(0, 5);
          console.log(`Extracted ${imageUrls.length} images from rooms page HTML`);
        }

        // Extract title from ROOMS page (not checkout page which says "Confirm and pay")
        if (browserlessResult.roomsTitle && !isValidTitle(airbnbTitle)) {
          const cleanedTitle = browserlessResult.roomsTitle
            .replace(" - Airbnb", "")
            .replace(" · Airbnb", "")
            .replace(/\s*-\s*(Houses|Apartments|Homes|Villas|Cabins|Cottages|Condos)?\s*(for Rent|to Rent|zur Miete|in)?\s*.*$/i, "")
            .trim();
          if (isValidTitle(cleanedTitle)) {
            airbnbTitle = cleanedTitle;
            console.log(`Extracted title from rooms page: ${airbnbTitle}`);
          }
        }

        // Capture OCR reference for validation (store for other providers too)
        const ocrRef = browserlessResult.ocrReference || null;
        if (ocrRef && !sharedOcrReference) {
          sharedOcrReference = ocrRef;
          console.log('Captured shared OCR reference from Browserless:', JSON.stringify({
            bookingCardAmountValue: ocrRef.bookingCardAmountValue,
            breakdownTotalAmountValue: ocrRef.breakdownTotalAmountValue,
            breakdownOpened: ocrRef.breakdownOpened,
          }));
        }

        // ============ CRITICAL FIX v2: Use direct text extraction as PRIMARY source ============
        // The book/stays page has "Pay $X now" visible. Direct text extraction is more reliable than OCR.
        // Priority: 1) Direct text extraction, 2) OCR, 3) Regex fallback
        
        let finalBaseline: AirbnbBaselineExtraction;
        let ocrValidation: OcrValidationResult | null = null;
        
        // Extract payNowExtraction from browserless result (now properly typed in interface)
        const payNowData = browserlessResult.payNowExtraction || null;
        
        // DEBUG: Log what we received from Browserless
        console.log('Browserless payNowData received:', JSON.stringify({
          hasPayNowData: !!payNowData,
          payNowAmount: payNowData?.payNowAmount,
          payNowSnippet: payNowData?.payNowSnippet?.slice(0, 50),
          subtotalAmount: payNowData?.subtotalAmount,
          regexCompilationErrors: payNowData?.regexCompilationErrors,
        }));
        
        const currencyFromSymbol = (symbol?: string | null): string => {
          if (symbol === '€') return 'EUR';
          if (symbol === '£') return 'GBP';
          if (symbol === '$') return 'USD';
          return 'USD';
        };
        
        // PRIORITY 1: Use direct text extraction if "Pay $X now" was found
        if (payNowData?.payNowAmount && payNowData.payNowAmount > 0) {
          const currency = currencyFromSymbol(payNowData.payNowCurrencySymbol ?? '$');
          console.log(`Browserless: Using direct text extraction total: ${currency} ${payNowData.payNowAmount} (snippet: ${payNowData.payNowSnippet})`);
          finalBaseline = {
            status: 'total_price_including_taxes_and_fees',
            price: payNowData.payNowAmount,
            currency,
            includes_taxes_fees: true,
            evidence_snippet: payNowData.payNowSnippet || `Total ${currency} ${payNowData.payNowAmount}`,
            subtotal_nights_only: payNowData.subtotalAmount || undefined,
            subtotal_nights_count: payNowData.subtotalNights || undefined,
            debug: {
              provider: 'Browserless',
              content_hash: hashContent(browserlessResult.html),
              candidates: [],
            },
          };
          ocrValidation = {
            accepted: true,
            status: 'total_price_including_taxes_and_fees',
            includesTaxesFees: true,
            acceptedVia: 'breakdown_match',
            mismatchReason: null,
            evidenceSnippet: payNowData.payNowSnippet || `Total ${currency} ${payNowData.payNowAmount}`,
            validatedPrice: payNowData.payNowAmount,
          };
          console.log(`Browserless: Direct text extraction succeeded (treated as breakdown_match)`);
        }
        // PRIORITY 2: Use OCR breakdown total if available
        else if (ocrRef?.breakdownTotalAmountValue && ocrRef.breakdownTotalAmountValue > 0) {
          console.log(`Browserless: Using OCR breakdown total: $${ocrRef.breakdownTotalAmountValue}`);
          finalBaseline = {
            status: 'total_price_including_taxes_and_fees',
            price: ocrRef.breakdownTotalAmountValue,
            currency: 'USD',
            includes_taxes_fees: true,
            evidence_snippet: ocrRef.breakdownTotalSnippet || ocrRef.breakdownTotalAmountRaw || `OCR: $${ocrRef.breakdownTotalAmountValue}`,
            debug: {
              provider: 'Browserless',
              content_hash: hashContent(browserlessResult.html),
              candidates: [],
            },
          };
          ocrValidation = {
            accepted: true,
            status: 'total_price_including_taxes_and_fees',
            includesTaxesFees: true,
            acceptedVia: 'breakdown_match', // OCR breakdown treated as breakdown match
            mismatchReason: null,
            evidenceSnippet: ocrRef.breakdownTotalSnippet || `OCR: $${ocrRef.breakdownTotalAmountValue}`,
            validatedPrice: ocrRef.breakdownTotalAmountValue,
          };
        }
        // PRIORITY 3: Fallback to regex extraction + OCR validation
        else {
          // Fallback to regex extraction + OCR validation
          const baseline = extractBaselineFromContent(browserlessResult.html, browserlessResult.markdown, 'Browserless');
          
          // Apply OCR validation to provider price
          ocrValidation = validateProviderPriceWithOcr(
            baseline.price,
            baseline.currency,
            baseline.evidence_snippet,
            ocrRef
          );
          
          console.log(`Browserless OCR validation: accepted=${ocrValidation.accepted}, status=${ocrValidation.status}, acceptedVia=${ocrValidation.acceptedVia}`);
          
          // If OCR validation rejects the price, update baseline
          finalBaseline = baseline;
          if (!ocrValidation.accepted && baseline.price !== null) {
            console.log(`OCR rejected Browserless price ${baseline.price}: ${ocrValidation.mismatchReason}`);
            finalBaseline = {
              ...baseline,
              status: ocrValidation.status,
              price: ocrValidation.validatedPrice,
              includes_taxes_fees: ocrValidation.includesTaxesFees,
              evidence_snippet: ocrValidation.evidenceSnippet,
            };
          } else if (ocrValidation.accepted && ocrValidation.acceptedVia) {
            // OCR accepted - update status based on acceptance reason
            finalBaseline = {
              ...baseline,
              status: ocrValidation.status,
              includes_taxes_fees: ocrValidation.includesTaxesFees,
              evidence_snippet: ocrValidation.evidenceSnippet,
            };
          }
          
          // ============ CRITICAL FIX: Subtotal is NEVER the final total ============
          // The book/stays page shows BOTH "$X for N nights" (subtotal) AND "Total (USD) $Y" (actual total)
          // The subtotal does NOT include taxes - we must find the actual Total line or require user confirmation
          // DO NOT promote subtotals to totals - this was the root cause of the regression
          
          // If we only found a subtotal, keep status as needs_user_confirmation - do NOT override
        }
        
        return { 
          provider, 
          baseline: finalBaseline, 
          contentLength: browserlessResult.html.length, 
          durationMs,
          ocrReference: ocrRef,
          ocrValidation,
        };
      } catch (e) {
        const durationMs = Date.now() - start;
        const errorMsg = String(e);
        
        // Log exception as failed request
        await logProviderRequest({
          supabase,
          provider: 'browserless',
          endpointType: 'airbnb_scrape',
          searchId,
          url: search.airbnb_url,
          success: false,
          durationMs,
          errorMessage: errorMsg,
        });
        
        return { provider, baseline: emptyBaseline('Browserless'), error: errorMsg, durationMs };
      }
    };

    // Check for simulation mode to test fallback chain
    if (simulateBrowserlessFail) {
      console.log('[SIMULATION] Browserless failure simulation enabled - will skip Browserless and test fallback');
    }
    
    // Fallback chain: Browserless -> Zyte -> Firecrawl
    // All providers should try to get the all-in total from book/stays checkout page
    // BROWSERLESS_ONLY_BASELINE mode: Only run Browserless, no fallbacks
    const fallbackChain: { provider: AirbnbProvider; run: () => Promise<ProviderPriceResult> }[] = browserlessOnlyMode
      ? [
          // Browserless-only debug mode: no fallbacks
          { provider: 'browserless', run: browserlessTask },
        ]
      : simulateBrowserlessFail
        ? [
            // Simulation mode: skip Browserless to test Zyte fallback
            { provider: 'zyte', run: zyteTask },
            { provider: 'firecrawl', run: firecrawlTask },
          ]
        : [
            { provider: 'browserless', run: browserlessTask },
            { provider: 'zyte', run: zyteTask },
            { provider: 'firecrawl', run: firecrawlTask },
          ];

    // ========================================================================
    // ACCESS FAILURE CLASSIFICATION - Handle rate limiting and bot blocking
    // RATE_LIMITED: Log and continue to fallback providers (each has separate quotas)
    // BOT_BLOCKED: Hard stop - likely affects all providers for same target domain
    // ========================================================================
    let accessLayerAbort: { failureClass: 'RATE_LIMITED' | 'BOT_BLOCKED'; provider: string; evidence: string[] } | null = null;
    
    for (const step of fallbackChain) {
      const label = step.provider.toUpperCase();
      sendProgress(controller, `${label} attempt`, `Trying ${label}…`);

      const r = await step.run();
      providerResults.push(r);
      
      // ============ RATE LIMIT CHECK - Continue to fallbacks ============
      // Rate limits are provider-specific (each has separate quotas)
      // Log for telemetry but continue trying other providers
      if (r.isRateLimited) {
        console.log(`[RATE LIMITED] ${r.provider} hit rate limit - trying fallback providers`);
        
        // Persist rate limit record for diagnostics
        try {
          await supabase.from('airbnb_baseline_debug').insert({
            run_id: debugRunId,
            search_id: searchId,
            run_number: 1,
            provider: r.provider,
            provider_order: fallbackChain.findIndex(s => s.provider === r.provider) + 1,
            status: 'rate_limited',
            duration_ms: r.durationMs || 0,
            extracted_price: null,
            currency: null,
            includes_taxes_fees: null,
            evidence_snippet: 'RATE LIMITED: Continuing to fallback providers',
            rejected_reason: 'rate_limited',
            airbnb_url: search.airbnb_url,
            check_in_date: checkIn,
            check_out_date: checkOut,
            nights_count: nights,
          });
        } catch (e) {
          console.error('Failed to persist rate limit record:', e);
        }
        
        // Telemetry for rate limit
        await logProviderRequest({
          supabase,
          provider: r.provider as ProviderLogName,
          endpointType: 'rate_limited',
          searchId,
          success: false,
          httpStatus: 429,
          durationMs: r.durationMs || 0,
          errorMessage: `RATE_LIMITED - trying fallbacks`,
        });
        
        sendProgress(controller, `${label} RATE LIMITED`, 'Trying next provider...', {
          provider: r.provider,
          failureClass: 'RATE_LIMITED',
          continuing_fallbacks: true,
        });
        
        continue; // TRY NEXT PROVIDER
      }
      
      // Check for bot blocking indicators
      const hasBotBlock = r.error && (
        r.error.toLowerCase().includes('captcha') ||
        r.error.toLowerCase().includes('bot detected') ||
        r.error.toLowerCase().includes('access denied') ||
        r.error.toLowerCase().includes('cloudflare') ||
        r.error.toLowerCase().includes('verify you are human')
      );
      
      if (hasBotBlock) {
        accessLayerAbort = {
          failureClass: 'BOT_BLOCKED',
          provider: r.provider,
          evidence: [r.error || 'Bot blocking detected'],
        };
        console.log(`[ACCESS ABORT] ${r.provider} hit bot block - aborting fallback chain`);
        
        // Persist abort record for diagnostics
        try {
          await supabase.from('airbnb_baseline_debug').insert({
            run_id: debugRunId,
            search_id: searchId,
            run_number: 1,
            provider: r.provider,
            provider_order: fallbackChain.findIndex(s => s.provider === r.provider) + 1,
            status: 'bot_blocked_abort',
            duration_ms: r.durationMs || 0,
            extracted_price: null,
            currency: null,
            includes_taxes_fees: null,
            evidence_snippet: `ACCESS LAYER ABORT: Bot blocked - ${r.error}`,
            rejected_reason: 'bot_blocked',
            airbnb_url: search.airbnb_url,
            check_in_date: checkIn,
            check_out_date: checkOut,
            nights_count: nights,
          });
        } catch (e) {
          console.error('Failed to persist bot block abort record:', e);
        }
        
        // Telemetry for access-layer abort
        await logProviderRequest({
          supabase,
          provider: r.provider as ProviderLogName,
          endpointType: 'access_layer_abort',
          searchId,
          success: false,
          httpStatus: 403,
          durationMs: r.durationMs || 0,
          errorMessage: `ACCESS_ABORT:BOT_BLOCKED - ${r.error || 'blocked'} - aborted_before_fallbacks=true`,
        });
        
        sendProgress(controller, `${label} BOT BLOCKED`, 'Access layer hard stop - no fallbacks', {
          provider: r.provider,
          failureClass: 'BOT_BLOCKED',
          aborted_before_fallbacks: true,
        });
        
        break; // HARD STOP - do not try other providers
      }

      // Persist debug bundle with OCR fields to airbnb_baseline_debug table
      try {
        const ocrRef = r.ocrReference || sharedOcrReference;
        const ocrVal = r.ocrValidation;
        
        await supabase.from('airbnb_baseline_debug').insert({
          run_id: debugRunId,
          search_id: searchId,
          run_number: 1,
          provider: r.provider,
          provider_order: fallbackChain.findIndex(s => s.provider === r.provider) + 1,
          status: r.baseline.status,
          duration_ms: r.durationMs || 0,
          extracted_price: r.baseline.price,
          currency: r.baseline.currency,
          includes_taxes_fees: r.baseline.includes_taxes_fees,
          evidence_snippet: r.baseline.evidence_snippet?.slice(0, 2000),
          candidates_summary: r.baseline.debug?.candidates || [],
          rejected_reason: ocrVal?.mismatchReason || r.baseline.debug?.candidates?.find(c => c.rejectedReason)?.rejectedReason || null,
          content_hash: r.baseline.debug?.content_hash || null,
          airbnb_url: search.airbnb_url,
          check_in_date: checkIn,
          check_out_date: checkOut,
          nights_count: nights,
          // OCR fields
          ocr_booking_card_amount_raw: ocrRef?.bookingCardAmountRaw || null,
          ocr_booking_card_amount_value: ocrRef?.bookingCardAmountValue || null,
          ocr_booking_card_nights: ocrRef?.bookingCardNights || null,
          ocr_booking_card_snippet: ocrRef?.bookingCardSnippet?.slice(0, 500) || null,
          ocr_breakdown_total_amount_raw: ocrRef?.breakdownTotalAmountRaw || null,
          ocr_breakdown_total_amount_value: ocrRef?.breakdownTotalAmountValue || null,
          ocr_breakdown_total_snippet: ocrRef?.breakdownTotalSnippet?.slice(0, 500) || null,
          ocr_breakdown_taxes_amount_value: ocrRef?.breakdownTaxesAmountValue || null,
          breakdown_opened: ocrRef?.breakdownOpened || false,
          ocr_validation_status: ocrVal?.accepted ? 'accepted' : (ocrVal?.mismatchReason ? 'rejected' : 'not_validated'),
          ocr_accepted_via: ocrVal?.acceptedVia || null,
          ocr_mismatch_reason: ocrVal?.mismatchReason || null,
        });
        console.log(`Persisted debug bundle for ${r.provider} with OCR fields`);
      } catch (persistErr) {
        console.error(`Failed to persist debug bundle for ${r.provider}:`, persistErr);
      }

      // Always emit grounded debug bundle for this provider attempt
      sendProgress(controller, `${label} debug`, `Baseline status: ${r.baseline.status}`, {
        provider: r.provider,
        baseline: {
          status: r.baseline.status,
          price: r.baseline.price,
          currency: r.baseline.currency,
          includes_taxes_fees: r.baseline.includes_taxes_fees,
          evidence_snippet: r.baseline.evidence_snippet,
          debug: r.baseline.debug,
        },
        ocrValidation: r.ocrValidation ? {
          accepted: r.ocrValidation.accepted,
          acceptedVia: r.ocrValidation.acceptedVia,
          mismatchReason: r.ocrValidation.mismatchReason,
        } : null,
      });

      // Log detailed selection check
      console.log(`[Selection Check] Provider=${r.provider}, status=${r.baseline.status}, price=${r.baseline.price}, currency=${r.baseline.currency}, currencyTruthy=${!!r.baseline.currency}`);

      // Only accept a baseline price when it is a *final* total INCLUDING taxes/fees.
      // If we only have a total-excluding-taxes (or a subtotal-for-nights), we require user confirmation.
      if (
        r.baseline.status === 'total_price_including_taxes_and_fees' &&
        typeof r.baseline.price === 'number' &&
        r.baseline.currency
      ) {
        const currencySymbol = r.baseline.currency === 'EUR'
          ? '€'
          : r.baseline.currency === 'GBP'
            ? '£'
            : r.baseline.currency === 'CHF'
              ? 'CHF '
              : '$';

        airbnbPrice = r.baseline.price;
        airbnbCurrency = r.baseline.currency;

        sendProgress(controller, "Selected Airbnb baseline", `${label}: ${currencySymbol}${airbnbPrice}`, {
          provider: r.provider,
          airbnbPrice,
          airbnbCurrency,
          baseline_status: r.baseline.status,
          includes_taxes_fees: r.baseline.includes_taxes_fees,
          evidence_snippet: r.baseline.evidence_snippet,
        });

        break;
      }

      // Nightly-only prices are now classified as price_not_available_in_content
      // with rejectedReason containing "nightly_price_only" - no special handling needed

      if (r.error) {
        sendProgress(controller, `${label} failed`, r.error, { provider: r.provider, error: r.error });
      } else {
        sendProgress(controller, `${label} no total`, `No grounded total found (${r.baseline.status})`, {
          provider: r.provider,
          baseline_status: r.baseline.status,
        });
      }
    }
    
    // Log access layer abort summary if triggered
    if (accessLayerAbort) {
      console.log(`[ACCESS ABORT SUMMARY] failureClass=${accessLayerAbort.failureClass}, provider=${accessLayerAbort.provider}, evidence=${accessLayerAbort.evidence.join(', ')}`);
    }

    // ========================================================================
    // BROWSERLESS-ONLY MODE: Early termination on ANY non-success state
    // If Browserless-only mode is enabled and we didn't get a VERIFIED total,
    // stop the entire run immediately with a clear terminal state.
    // 
    // Non-success states that trigger hard stop:
    // - needs_user_confirmation (subtotal only, no verified total)
    // - price_not_available_in_content (no price found)
    // - total_price_excluding_taxes_and_fees (not the final total)
    // - any error
    // ========================================================================
    if (browserlessOnlyMode) {
      const browserlessResult = providerResults.find(r => r.provider === 'browserless');
      const baselineStatus = browserlessResult?.baseline.status || 'unknown';
      const hasVerifiedTotal = airbnbPrice && airbnbCurrency && 
        baselineStatus === 'total_price_including_taxes_and_fees';
      
      console.log("==========================================");
      console.log("BROWSERLESS ONLY MODE: Checking for hard stop");
      console.log(`  airbnbPrice: ${airbnbPrice}`);
      console.log(`  airbnbCurrency: ${airbnbCurrency}`);
      console.log(`  baselineStatus: ${baselineStatus}`);
      console.log(`  hasVerifiedTotal: ${hasVerifiedTotal}`);
      console.log("==========================================");
      
      if (!hasVerifiedTotal) {
        // Determine failure reason with explicit state mapping
        let failureReason: string;
        if (browserlessResult?.error) {
          failureReason = browserlessResult.error;
        } else if (baselineStatus === 'needs_user_confirmation') {
          failureReason = 'needs_user_confirmation (subtotal only, no verified total)';
        } else if (baselineStatus === 'price_not_available_in_content') {
          failureReason = 'price_not_available_in_content (no price found)';
        } else if (baselineStatus === 'total_price_excluding_taxes_and_fees') {
          failureReason = 'total_price_excluding_taxes_and_fees (not final total)';
        } else {
          failureReason = `${baselineStatus} (non-success state)`;
        }
        
        console.log("==========================================");
        console.log("⛔ BROWSERLESS ONLY MODE: STOPPING RUN");
        console.log(`Failure reason: ${failureReason}`);
        console.log("No Zyte fallback, no platform discovery");
        console.log("==========================================");
        
        // Update search status to terminal failure
        await supabase.from("searches").update({
          status: "error",
          api_error: `baseline_browserless_failed: ${failureReason}`,
          api_error_code: "baseline_browserless_failed",
          last_progress_at: new Date().toISOString(),
        }).eq("id", searchId);
        
        // Persist failure record to debug table
        try {
          await supabase.from('airbnb_baseline_debug').insert({
            run_id: debugRunId,
            search_id: searchId,
            run_number: 1,
            provider: 'browserless',
            provider_order: 1,
            status: 'baseline_browserless_failed',
            duration_ms: browserlessResult?.durationMs || 0,
            extracted_price: browserlessResult?.baseline.price || null,
            currency: browserlessResult?.baseline.currency || null,
            includes_taxes_fees: browserlessResult?.baseline.includes_taxes_fees || null,
            evidence_snippet: `BROWSERLESS ONLY MODE FAILURE: ${failureReason}`,
            rejected_reason: failureReason,
            airbnb_url: search.airbnb_url,
            check_in_date: checkIn,
            check_out_date: checkOut,
            nights_count: nights,
          });
        } catch (e) {
          console.error('Failed to persist browserless-only failure record:', e);
        }
        
        // Send terminal progress event
        sendProgress(controller, "BROWSERLESS ONLY MODE FAILED", failureReason, {
          browserless_only_mode: true,
          failure_reason: failureReason,
          baseline_status: baselineStatus,
          provider_results: providerResults.map(r => ({
            provider: r.provider,
            status: r.baseline.status,
            price: r.baseline.price,
            error: r.error,
          })),
        });
        
        // Send stream end event and close
        sendSSE(controller, "stream_end", {
          searchId,
          airbnbPrice: null,
          airbnbCurrency: null,
          airbnbTitle,
          nights,
          checkIn,
          checkOut,
          resultsCount: 0,
          imageUrls,
          error: `baseline_browserless_failed: ${failureReason}`,
          apiErrorCode: "baseline_browserless_failed",
        });
        
        controller.close();
        return; // HARD STOP - orchestration ends here
      } else {
        console.log("✅ BROWSERLESS ONLY MODE: Verified total found, continuing");
        console.log(`  Price: ${airbnbCurrency} ${airbnbPrice}`);
      }
    }

    // Track subtotal info from any provider that found needs_user_confirmation
    // OR a total that excludes taxes/fees (still requires user confirmation).
    // ONLY populate subtotalInfo if we DON'T have a valid airbnbPrice
    let subtotalInfo: { amount: number; nights: number | null; currency: string } | null = null;
    if (!airbnbPrice) {
      for (const r of providerResults) {
        if (r.baseline.status === 'needs_user_confirmation' && r.baseline.subtotal_nights_only) {
          subtotalInfo = {
            amount: r.baseline.subtotal_nights_only,
            nights: r.baseline.subtotal_nights_count ?? null,
            currency: r.baseline.currency || 'USD',
          };
          break;
        }

        if (r.baseline.status === 'total_price_excluding_taxes_and_fees' && typeof r.baseline.price === 'number') {
          subtotalInfo = {
            amount: r.baseline.price,
            nights: nights,
            currency: r.baseline.currency || 'USD',
          };
          break;
        }
      }

      if (subtotalInfo) {
        sendProgress(controller, "Subtotal found", `$${subtotalInfo.amount} for ${subtotalInfo.nights || '?'} nights (needs user confirmation for total)`, {
          subtotal_nights_only: subtotalInfo.amount,
          subtotal_nights_count: subtotalInfo.nights,
          subtotal_currency: subtotalInfo.currency,
        });
      } else {
        sendProgress(controller, "Airbnb baseline failed", "No Airbnb total price extracted from any provider");
      }
    }

    // Emit quick comparison summary for debugging (even though we stop early on success)
    if (providerResults.length > 0) {
      const summary = providerResults
        .map((r) => `${r.provider}: ${r.baseline.price ?? 'N/A'} (${r.baseline.status})`)
        .join(' | ');
      sendProgress(controller, "Price comparison", summary, { comparison: providerResults });
    }

    // Get OCR validation data from the accepted provider result
    const acceptedProviderResult = providerResults.find(r => 
      r.baseline.status === 'total_price_including_taxes_and_fees' && r.baseline.price === airbnbPrice
    );
    const finalOcrRef = acceptedProviderResult?.ocrReference || sharedOcrReference;
    const finalOcrVal = acceptedProviderResult?.ocrValidation;

    // Update the database including OCR fields
    // CRITICAL: This update MUST persist the airbnb_price - if this fails, savings comparisons break
    const { error: airbnbUpdateError } = await supabase
      .from("searches")
      .update({
        status: "searching_platforms",
        last_progress_at: new Date().toISOString(),
        airbnb_title: airbnbTitle,
        airbnb_price: airbnbPrice,
        airbnb_currency: airbnbCurrency,
        airbnb_image_url: imageUrls[0] || null,
        airbnb_images: imageUrls.slice(0, 5),
        check_in_date: checkIn,
        check_out_date: checkOut,
        nights_count: nights,
        // OCR validation fields
        ocr_booking_card_amount: finalOcrRef?.bookingCardAmountValue || null,
        ocr_booking_card_nights: finalOcrRef?.bookingCardNights || null,
        ocr_breakdown_total_amount: finalOcrRef?.breakdownTotalAmountValue || null,
        ocr_validation_status: finalOcrVal?.accepted ? 'accepted' : (finalOcrVal?.mismatchReason ? 'rejected' : null),
        ocr_accepted_via: finalOcrVal?.acceptedVia || null,
        ocr_mismatch_reason: finalOcrVal?.mismatchReason || null,
      })
      .eq("id", searchId);
    
    if (airbnbUpdateError) {
      console.error(`[CRITICAL] Failed to persist airbnb_price for search ${searchId}:`, airbnbUpdateError);
      // Log to activity
      const activityLog = search.activity_log || [];
      activityLog.push({
        ts: Date.now(),
        message: "Database update failed",
        detail: `Failed to save Airbnb price: ${airbnbUpdateError.message}`,
      });
      // Retry once
      const { error: retryError } = await supabase.from("searches").update({
        status: "searching_platforms",
        airbnb_price: airbnbPrice,
        airbnb_currency: airbnbCurrency,
        activity_log: activityLog,
      }).eq("id", searchId);
      if (retryError) {
        console.error(`[CRITICAL] Retry also failed for search ${searchId}:`, retryError);
      }
    }
    
    // Old fallback chain code removed - now using parallel multi-provider extraction above

    // Fallback direct fetch if needed
    if (imageUrls.length === 0 || !airbnbPrice) {
      checkStage1Timeout();
      sendProgress(controller, "Fallback extraction", "Trying direct page fetch");
      try {
        const resp = await fetchWithTimeout(
          search.airbnb_url,
          {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0" },
          },
          20_000
        );
        if (resp.ok) {
          const html = await resp.text();
          const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
          if (titleMatch && !isValidTitle(airbnbTitle)) {
            const cleanedTitle = titleMatch[1].replace(" - Airbnb", "").trim();
            if (isValidTitle(cleanedTitle)) {
              airbnbTitle = cleanedTitle;
            }
          }

          if (imageUrls.length === 0) {
            const patterns = [
              /https:\/\/a\d+\.muscache\.com\/im\/pictures\/[^"'\s\)]+/gi,
              /https:\/\/.*?\.muscache\.com\/im\/pictures\/[^"'\s\)]+/gi,
            ];
            let found: string[] = [];
            for (const p of patterns) found.push(...(html.match(p) || []));
            imageUrls = [...new Set(found.map((u) => u.split("?")[0]))]
              .filter(isValidPropertyImage)
              .map((u) => `${u}?im_w=1200`)
              .slice(0, 5);
          }

          if (!airbnbPrice) {
            checkStage1Timeout();
            sendProgress(controller, "Extracting Airbnb price", "Using AI to find the exact price");
            const aiResult = await extractAirbnbTotalPriceWithAI(html.slice(0, 15000), nights);
            airbnbPrice = aiResult.price;
            if (aiResult.price) {
              airbnbCurrency = aiResult.currency;
              const currencySymbol = airbnbCurrency === 'EUR' ? '€' : airbnbCurrency === 'GBP' ? '£' : '$';
              sendProgress(controller, "Price extracted", `Found TOTAL: ${currencySymbol}${airbnbPrice}`);
            }
          }
        }
      } catch (e) {
        console.error("Direct fetch error:", e);
      }
    }

    // Abort if no price (unless the user explicitly skipped this step)
    if (!airbnbPrice) {
      if (skipAirbnbPrice) {
        sendProgress(controller, "Continuing without Airbnb price", "Proceeding to find alternatives (savings may be unavailable)", { skipped: true });
        await supabase
          .from("searches")
          .update({
            status: "searching_platforms",
            airbnb_title: airbnbTitle,
            airbnb_price: null,
            airbnb_image_url: imageUrls[0] || null,
            airbnb_images: imageUrls.slice(0, 5),
            check_in_date: checkIn,
            check_out_date: checkOut,
            nights_count: nights,
            last_progress_at: new Date().toISOString(),
          })
          .eq("id", searchId);
        // Continue the pipeline.
      } else if (subtotalInfo) {
        // We have a subtotal but no proven total - continue pipeline but show confirmation modal
        const subtotalMessage = `Found subtotal $${subtotalInfo.amount} for ${subtotalInfo.nights || '?'} nights. Please confirm the final total.`;
        
        // Update search - but keep status as searching_platforms so pipeline continues
        await supabase.from("searches").update({ 
          airbnb_title: airbnbTitle || null,
          airbnb_price: null, // Will be set when user confirms
          airbnb_currency: subtotalInfo.currency,
          airbnb_image_url: imageUrls[0] || null,
          airbnb_images: imageUrls.slice(0, 5),
          check_in_date: checkIn,
          check_out_date: checkOut,
          nights_count: nights,
          last_progress_at: new Date().toISOString(),
        }).eq("id", searchId);
        
        sendProgress(controller, "Needs confirmation", subtotalMessage, {
          subtotal_nights_only: subtotalInfo.amount,
          subtotal_nights_count: subtotalInfo.nights,
          subtotal_currency: subtotalInfo.currency,
        });
        
        // Send event so frontend shows the modal (but DON'T return - continue the pipeline)
        sendSSE(controller, "needs_confirmation", {
          subtotal_nights_only: subtotalInfo.amount,
          subtotal_nights_count: subtotalInfo.nights,
          subtotal_currency: subtotalInfo.currency,
          message: "Please confirm the Airbnb total price",
        });
        
        // Set skipAirbnbPrice to true so pipeline continues without price
        // Savings will be calculated once user confirms the price
        skipAirbnbPrice = true;
        // Continue to visual search (don't return)
      } else {
        // Determine specific failure reason based on what we observed
        let failureCode = 'airbnb_price_element_missing';
        let failureMessage = "We couldn't find the total price on the Airbnb listing.";
        let userMessage = "Airbnb didn't show a total price for your selected dates. This can happen when dates are unavailable or the listing requires interaction to show pricing.";
        
        // Check if any provider detected dates unavailable (highest priority - terminal state)
        const wasDatesUnavailable = providerResults.some(r => r.isDatesUnavailable);
        if (wasDatesUnavailable) {
          failureCode = 'dates_unavailable';
          failureMessage = "This property is no longer available for your selected dates.";
          userMessage = "The dates you selected are not available for this property. Please try different dates or a different listing.";
        }
        // Check if ALL providers were rate limited (none succeeded)
        else {
          const allRateLimited = providerResults.length > 0 && providerResults.every(r => r.isRateLimited);
          if (allRateLimited) {
            failureCode = 'rate_limited';
            failureMessage = "All extraction providers were temporarily rate limited (HTTP 429).";
            userMessage = "We can't retrieve the price from Airbnb right now due to temporary rate limiting on all providers. Please try again in a few minutes.";
          } else {
            // Check what content we got to determine failure reason
            const hasContent = lastScrapedContent.markdown.length > 100 || lastScrapedContent.html.length > 100;
            const hasScreenshot = lastScrapedContent.hasScreenshot;
            
            if (!hasContent && !hasScreenshot) {
              failureCode = 'airbnb_blocked_or_captcha';
              failureMessage = "Airbnb blocked the page request (captcha or bot detection).";
              userMessage = "Airbnb is blocking automated requests. Please try again in a few minutes.";
            } else if (hasContent) {
              // Content available - analyze for specific issues
              const content = lastScrapedContent.markdown || lastScrapedContent.html;
              const contentLower = content.toLowerCase();
              
              // Check for dates unavailable FIRST - this is a valid terminal state, not an error
              if (contentLower.includes('no longer available') || 
                  contentLower.includes('dates are no longer available') || 
                  contentLower.includes('unavailable for your dates') || 
                  contentLower.includes('not available for these dates') ||
                  contentLower.includes('someone else just requested') ||
                  contentLower.includes('this listing is no longer') ||
                  contentLower.includes('this home isn\'t available')) {
                failureCode = 'dates_unavailable';
                failureMessage = "This property is no longer available for your selected dates.";
                userMessage = "The dates you selected are not available for this property. Please try different dates or a different listing.";
              } else if (contentLower.includes('captcha') || contentLower.includes('robot') || contentLower.includes('verify you')) {
                failureCode = 'airbnb_blocked_or_captcha';
                failureMessage = "Airbnb requested human verification.";
                userMessage = "Airbnb is requiring verification. Please try again in a few minutes.";
              } else if (content.includes('Enter dates') || content.includes('Add dates') || content.includes('Check availability')) {
                failureCode = 'airbnb_dates_not_applied';
                failureMessage = "The dates from your URL weren't applied to the listing.";
                userMessage = "The dates in your Airbnb link weren't applied. Make sure check_in and check_out parameters are in the URL.";
              } else if ((content.includes('night') || content.includes('/night')) && !contentLower.includes('total')) {
                failureCode = 'airbnb_total_not_visible';
                failureMessage = "Airbnb shows per-night pricing but no total for your dates.";
                userMessage = "Airbnb isn't showing the total price for your dates. The property may require interaction to reveal pricing.";
              }
            }
          }
        }
        
        stage1Outcome = 'failed';
        stage1Error = failureCode.toUpperCase();
        
        // Update search with explicit failure info
        await supabase.from("searches").update({ 
          status: "error",
          api_error: failureMessage,
          api_error_code: failureCode,
          airbnb_title: airbnbTitle || null,
          airbnb_image_url: imageUrls[0] || null,
          airbnb_images: imageUrls.slice(0, 5),
          check_in_date: checkIn,
          check_out_date: checkOut,
          nights_count: nights,
          last_progress_at: new Date().toISOString(),
        }).eq("id", searchId);
        
        sendProgress(controller, "Price unavailable", failureMessage);
        sendSSE(controller, "error", {
          message: userMessage,
          code: failureCode,
          canRetry: failureCode === 'airbnb_blocked_or_captcha' || failureCode === 'airbnb_timeout',
        });
        sendSSE(controller, "complete", { success: false, error: failureCode });
        return;
      }
    }

    // Abort if no images
    if (imageUrls.length === 0) {
      sendProgress(controller, "No images found", "Could not extract property images");
      await supabase
        .from("searches")
        .update({
          status: "completed",
          airbnb_title: airbnbTitle,
          airbnb_price: airbnbPrice,
          airbnb_image_url: null,
          airbnb_images: [],
          check_in_date: checkIn,
          check_out_date: checkOut,
          nights_count: nights,
        })
        .eq("id", searchId);
      sendSSE(controller, "complete", {
        success: true,
        results: [],
        airbnb: { title: airbnbTitle, price: airbnbPrice, url: search.airbnb_url, images: [] },
        dates: { checkIn, checkOut, nights },
      });
      return;
    }

    // Step 2: Google Lens visual search
    sendProgress(controller, "Finding matches", `Searching ${imageUrls.length} images across booking platforms`);
    sendStatusUpdate(controller, "searching_platforms");
    await supabase.from("searches").update({ status: "searching_platforms", last_progress_at: new Date().toISOString() }).eq("id", searchId);
  } catch (e) {
    stage1Outcome = 'failed';
    stage1Error = e instanceof Error ? e.message : 'Unknown error';

    const message = stage1Error === 'AIRBNB_PARSING_TIMEOUT'
      ? 'Could not automatically extract the Airbnb price. Continuing search...'
      : `Could not retrieve Airbnb listing details. Continuing search...`;

    console.error('Stage 1 error (continuing anyway):', stage1Error);

    // CRITICAL FIX: Update search status to searching_platforms so the flow continues properly
    // Without this, the status stays at "searching" even if visual search completes
    await supabase.from('searches').update({
      status: 'searching_platforms', // <-- KEY: Ensure status transitions properly
      airbnb_title: airbnbTitle || null,
      last_progress_at: new Date().toISOString(),
    }).eq('id', searchId);

    // ONLY send needs_confirmation if we don't already have a valid price
    // This prevents the modal from appearing when price was successfully extracted
    // but something else in the pipeline threw an error
    if (!airbnbPrice) {
      sendSSE(controller, 'needs_confirmation', {
        subtotal_nights_only: null,
        subtotal_nights_count: nights,
        subtotal_currency: 'USD',
        reason: message,
      });
      // Set skipAirbnbPrice so pipeline continues
      skipAirbnbPrice = true;
    }
    // DON'T return - continue to visual search
  } finally {
    await finishStageRun(supabase, searchId, 'analyze_listing', stage1Outcome, stage1Error);
  }

  const searchStartTime = Date.now();
  
  // ============================================================================
  // DISCOVERY CAPS AND BUDGETS
  // 
  // NON-NEGOTIABLE INVARIANT: Discovery MUST attempt all 5 images.
  // Caps and budgets NEVER stop the outer loop. They only reduce DEPTH (work per image).
  // 
  // Global budgets become "soft caps" that trigger degraded modes:
  // - AI budget exhausted → continue with NO_AI mode (collect + dedupe only)
  // - Time budget low → continue with fast path (fewer candidates per image)
  // ============================================================================
  const MAX_TIME = 120000; // 2 minutes total
  const MAX_AI = 30; // Global AI verification budget
  const MAX_AI_PER_IMAGE = 8; // Per-image AI verification cap (depth control)
  const MAX_CANDIDATES_PER_IMAGE = 40; // Max reverse search results to process per image
  const TIME_DEGRADED_THRESHOLD = 90000; // After 90s, enter time-degraded mode
  
  let aiCount = 0;
  let degradedMode: 'normal' | 'no_ai' | 'fast_path' = 'normal';
  let degradedModeReason: string | null = null;

  // Track proof of an explicit skip request in THIS run.
  // This is required to truthfully label a stop as "User skipped".
  let requestSkipEndpointCalledInThisRun = false;
  let requestSkipEventId: string | null = null;
  let requestSkipTimestamp: number | null = null;

  const getSkipRequestEvidenceForThisRun = async (): Promise<{
    request_skip_endpoint_called_in_this_run: boolean;
    request_skip_event_id: string | null;
    request_skip_timestamp: number | null;
    skip_setter_source: 'frontend' | 'api' | 'backend' | 'unknown';
    skip_setter_evidence: string;
  }> => {
    try {
      const sinceIso = new Date(searchStartTime).toISOString();
      const { data, error } = await supabase
        .from('api_request_logs')
        .select('endpoint_type, request_timestamp, metadata')
        .eq('search_id', searchId)
        .in('endpoint_type', ['request-skip-step', 'skip_requested_set_true'])
        .gte('request_timestamp', sinceIso)
        .order('request_timestamp', { ascending: false })
        .limit(1);

      if (error) {
        console.log('[SkipEvidence] query error:', error.message || error);
        return {
          request_skip_endpoint_called_in_this_run: false,
          request_skip_event_id: null,
          request_skip_timestamp: null,
          skip_setter_source: 'unknown',
          skip_setter_evidence: 'no evidence',
        };
      }

      const row = Array.isArray(data) ? data[0] : null;
      const meta = (row?.metadata && typeof row.metadata === 'object') ? (row.metadata as Record<string, any>) : null;

      const eventId = typeof meta?.event_id === 'string' ? meta.event_id : null;
      const tsMs = typeof meta?.timestamp_ms === 'number' ? meta.timestamp_ms : null;
      const called = !!row;

      return {
        request_skip_endpoint_called_in_this_run: called,
        request_skip_event_id: eventId,
        request_skip_timestamp: tsMs,
        skip_setter_source: called ? 'api' : 'unknown',
        skip_setter_evidence: called
          ? (row?.endpoint_type === 'request-skip-step' ? 'request-skip-step called' : 'skip_requested_set_true logged')
          : 'no evidence',
      };
    } catch (e) {
      console.log('[SkipEvidence] unexpected error:', (e as Error)?.message || e);
      return {
        request_skip_endpoint_called_in_this_run: false,
        request_skip_event_id: null,
        request_skip_timestamp: null,
        skip_setter_source: 'unknown',
        skip_setter_evidence: 'no evidence',
      };
    }
  };

  // Initialize API error tracker
  const apiErrorTracker = createApiErrorTracker();

  // Track the best match per platform (by confidence score)
  // Key: normalized platform name, Value: best alternative found so far
  const bestMatchPerPlatform = new Map<string, typeof alternatives[number]>();

  // ============================================================================
  // PARALLEL PIPELINE OPTIMIZATION
  // Track platforms already sent to price extraction to avoid redundant work.
  // Price extraction is triggered IMMEDIATELY when a platform reaches VERIFIED.
  // ============================================================================
  const platformsInPriceExtraction = new Set<string>();
  const PRICE_EXTRACTION_CONCURRENCY = 3; // Max concurrent extractions
  let activeExtractionCount = 0;
  const extractionPromises: Promise<void>[] = [];

  /**
   * Immediately trigger price extraction for a verified platform.
   * This runs as a background task, allowing discovery to continue.
   */
  async function triggerImmediatePriceExtraction(
    platformMatch: typeof alternatives[number]
  ): Promise<void> {
    const platformKey = platformMatch.platform_name.toLowerCase().replace(/[^a-z0-9]/g, '');
    
    // Skip if already in extraction
    if (platformsInPriceExtraction.has(platformKey)) {
      console.log(`[ImmediateExtraction] Skipping ${platformMatch.platform_name} - already in extraction`);
      return;
    }
    
    // Wait for concurrency slot
    while (activeExtractionCount >= PRICE_EXTRACTION_CONCURRENCY) {
      await new Promise((r) => setTimeout(r, 500));
    }
    
    platformsInPriceExtraction.add(platformKey);
    activeExtractionCount++;
    
    try {
      console.log(`[ImmediateExtraction] Starting extraction for ${platformMatch.platform_name}`);
      
      // First, persist to search_results and search_platforms so extraction can find it
      const insertData = {
        search_id: searchId,
        platform_name: platformMatch.platform_name,
        listing_url: platformMatch.listing_url,
        listing_title: platformMatch.listing_title,
        price: null,
        original_price: airbnbPrice,
        savings_amount: null,
        savings_percentage: null,
        confidence_score: platformMatch.confidence_score,
        image_url: platformMatch.image_url,
        images: platformMatch.images,
        match_type: platformMatch.match_type,
        source_airbnb_image: platformMatch.source_airbnb_image || null,
        price_check_in: checkIn,
        price_check_out: checkOut,
        dates_differ: false,
      };
      
      const { data: insertedData, error: insertError } = await supabase
        .from("search_results")
        .upsert(insertData, { onConflict: 'search_id,listing_url' })
        .select()
        .single();
      
      if (insertError) {
        console.error(`[ImmediateExtraction] Failed to persist ${platformMatch.platform_name}:`, insertError);
        return;
      }
      
      // Also insert into search_platforms (authoritative set)
      await supabase
        .from("search_platforms")
        .upsert({
          search_id: searchId,
          platform_name: platformMatch.platform_name,
          listing_url: platformMatch.listing_url,
          listing_title: platformMatch.listing_title,
          image_url: platformMatch.image_url,
          images: platformMatch.images || [],
          match_type: platformMatch.match_type,
          source_airbnb_image: platformMatch.source_airbnb_image || null,
        }, { onConflict: 'search_id,listing_url' });
      
      // Create price extraction record
      const { data: extractionData, error: extractionError } = await supabase
        .from("price_extractions")
        .upsert({
          search_result_id: insertedData.id,
          search_id: searchId,
          platform_name: platformMatch.platform_name,
          deep_link: platformMatch.listing_url, // Will be updated by worker
          assumed_adults: 2,
          assumed_children: 0,
          assumed_rooms: 1,
          occupancy_assumed: true,
          extraction_status: 'pending',
          dates_validated: false,
        }, { onConflict: 'search_result_id' })
        .select('id')
        .single();
      
      if (extractionError) {
        console.error(`[ImmediateExtraction] Failed to create extraction for ${platformMatch.platform_name}:`, extractionError);
        return;
      }
      
      // Trigger worker immediately
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      
      const workerResponse = await fetch(`${supabaseUrl}/functions/v1/process-platform-extraction`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${supabaseServiceKey}`,
        },
        body: JSON.stringify({
          extractionId: extractionData.id,
          requestedCheckIn: checkIn,
          requestedCheckOut: checkOut,
        }),
      });
      
      if (!workerResponse.ok) {
        const errorText = await workerResponse.text().catch(() => 'Unknown error');
        console.error(`[ImmediateExtraction] Worker failed for ${platformMatch.platform_name}: ${workerResponse.status} - ${errorText.slice(0, 200)}`);
      } else {
        const result = await workerResponse.json();
        console.log(`[ImmediateExtraction] ${platformMatch.platform_name}: ${result.result?.finalStatus || result.status || 'unknown'}`);
      }
    } catch (err) {
      console.error(`[ImmediateExtraction] Error for ${platformMatch.platform_name}:`, err);
    } finally {
      activeExtractionCount--;
    }
  }

  // ============================================================================
  // DISCOVERY LOOP: Process ALL images via reverse image search
  // 
  // NON-NEGOTIABLE INVARIANT: Discovery MUST attempt all 5 images.
  // 
  // The ONLY valid early stops are:
  // 1. Fatal technical error (crash, unrecoverable exception)
  // 2. User explicitly skips (with same-run proof)
  // 
  // Caps, budgets, and heuristics NEVER abort the outer loop.
  // They only reduce DEPTH (work per image) via degraded modes.
  // ============================================================================
  let discoveryAttempted = false;
  let discoveryStopReason: 'complete' | 'user_action' | 'fatal_error' = 'complete';
  let discoveryStopDetail: string | null = null;
  let imagesProcessed = 0;
  
  // Track degraded mode transitions for logging
  let enteredDegradedModeAt: number | null = null;
  
  for (let idx = 0; idx < imageUrls.length; idx++) {
    // ============================================================================
    // TIME BUDGET CHECK: Degrade, don't stop
    // After TIME_DEGRADED_THRESHOLD, enter fast_path mode (fewer candidates, no AI)
    // Only hard stop if we exceed MAX_TIME (fatal timeout)
    // ============================================================================
    const elapsed = Date.now() - searchStartTime;
    
    if (elapsed >= MAX_TIME) {
      // HARD TIMEOUT: This is a fatal error condition - system cannot complete
      // Log it but DON'T break - continue with remaining images in minimal mode
      console.log(`[DiscoveryDegraded] HARD TIMEOUT at image ${idx + 1}/${imageUrls.length} (${Math.round(elapsed / 1000)}s elapsed)`);
      if (degradedMode !== 'fast_path') {
        degradedMode = 'fast_path';
        degradedModeReason = `Timeout exceeded at ${Math.round(elapsed / 1000)}s`;
        enteredDegradedModeAt = idx;
        sendProgress(controller, "Degraded mode: fast path", `Time limit exceeded — continuing with reduced depth for remaining images`, {
          degraded_mode: 'fast_path',
          reason: degradedModeReason,
          images_remaining: imageUrls.length - idx,
        });
      }
    } else if (elapsed >= TIME_DEGRADED_THRESHOLD && degradedMode === 'normal') {
      // SOFT TIMEOUT: Enter degraded mode but continue all images
      degradedMode = 'fast_path';
      degradedModeReason = `Time budget low at ${Math.round(elapsed / 1000)}s`;
      enteredDegradedModeAt = idx;
      console.log(`[DiscoveryDegraded] Entering fast_path mode at image ${idx + 1}: ${degradedModeReason}`);
      sendProgress(controller, "Degraded mode: fast path", `${degradedModeReason} — reducing work per image`, {
        degraded_mode: 'fast_path',
        reason: degradedModeReason,
        images_remaining: imageUrls.length - idx,
      });
    }
    
    // ============================================================================
    // API ERROR CHECK: Apply cooldown, don't abort discovery
    // If a provider is having issues, reduce reliance but continue
    // ============================================================================
    if (shouldAbortDueToApiErrors(apiErrorTracker)) {
      // Instead of aborting, log the issue and continue in degraded mode
      const errorSummary = getApiErrorSummary(apiErrorTracker) || 'API error';
      console.log(`[DiscoveryDegraded] API errors detected at image ${idx + 1}: ${errorSummary}`);
      
      if (degradedMode === 'normal') {
        degradedMode = 'no_ai';
        degradedModeReason = `API errors: ${errorSummary}`;
        enteredDegradedModeAt = idx;
        sendProgress(controller, "Degraded mode: no AI verification", `${errorSummary} — continuing with reduced verification depth`, {
          degraded_mode: 'no_ai',
          reason: degradedModeReason,
          images_remaining: imageUrls.length - idx,
        });
      }
      
      // Store the error but DON'T break - continue discovery
      await supabase.from("searches").update({ 
        api_error: errorSummary,
        api_error_code: apiErrorTracker.hasQuotaError ? 'quota_exceeded' : 'api_error',
        last_progress_at: new Date().toISOString() 
      }).eq("id", searchId);
      // DON'T break - continue with remaining images in degraded mode
    }

    // ============================================================================
    // DISCOVERY SKIP POLICY: Truth-gated "User skipped" messaging
    //
    // The ONLY valid user-initiated early stop is an explicit skip request.
    // We may ONLY say "User skipped ..." if we have explicit evidence that the
    // request-skip endpoint was called in THIS run.
    // ============================================================================
    if (discoveryAttempted) {
      const claim = await claimSkipNowDetailed();
      if (claim.skip_claim_succeeded) {
        const evidence = await getSkipRequestEvidenceForThisRun();
        requestSkipEndpointCalledInThisRun = evidence.request_skip_endpoint_called_in_this_run;
        requestSkipEventId = evidence.request_skip_event_id;
        requestSkipTimestamp = evidence.request_skip_timestamp;

        // Required payload: skip claim evidence (always attached)
        const skipClaimEvidencePayload = {
          skip_requested_before_claim: claim.skip_requested_before_claim,
          skip_claim_succeeded: claim.skip_claim_succeeded,
          skip_claim_iteration_index: idx,
          images_completed: idx,
          total_images: imageUrls.length,
          discovery_stop_reason: evidence.request_skip_endpoint_called_in_this_run ? 'user_action' : 'unknown',
          request_skip_endpoint_called_in_this_run: evidence.request_skip_endpoint_called_in_this_run,
          request_skip_event_id: evidence.request_skip_event_id,
          request_skip_timestamp: evidence.request_skip_timestamp,
          skip_setter_source: evidence.skip_setter_source,
          skip_setter_evidence: evidence.skip_setter_evidence,
        };

        // TRUTH GATE: Only user action can stop discovery
        if (evidence.request_skip_endpoint_called_in_this_run === true) {
          discoveryStopReason = 'user_action';
          discoveryStopDetail = 'User clicked skip button';
          console.log(`[DiscoveryStop] User-requested skip after image ${idx}: ${discoveryStopDetail}`);
          sendProgress(controller, "User skipped remaining discovery", `Completed ${idx} of ${imageUrls.length} images`, {
            discovery_stop_reason: 'user_action',
            skipped: true,
            imagesCompleted: idx,
            totalImages: imageUrls.length,
            skip_claim_evidence: skipClaimEvidencePayload,
          });
          break; // Only valid early stop: explicit user skip
        } else {
          // Skip was claimed but no evidence of user action - log but DON'T stop
          console.log(`[DiscoveryWarning] Skip claimed without user evidence at image ${idx} — continuing discovery`);
          // Reset skip_requested so we don't keep hitting this
          await supabase.from("searches").update({ skip_requested: false }).eq("id", searchId);
          // DON'T break - continue with remaining images
        }
      }
    }

    await heartbeat();
    discoveryAttempted = true; // Mark that we've started at least one discovery attempt
    const imageUrl = imageUrls[idx];
    sendProgress(controller, `Searching image ${idx + 1} of ${imageUrls.length}`, "Running AI reverse image search on Booking.com, Vrbo, TripAdvisor...", { imageIndex: idx + 1, totalImages: imageUrls.length });
    await supabase.from("searches").update({ status: `searching_platforms_lens_${idx + 1}_of_${imageUrls.length}`, last_progress_at: new Date().toISOString() }).eq("id", searchId);
    
    // Use the new SerpAPI helper with proper error handling
    const lensResult = await fetchSerpApi(
      `engine=google_lens&url=${encodeURIComponent(imageUrl)}`,
      serpApiKey
    );

    if (!lensResult.success) {
      if (lensResult.error) {
        recordApiError(apiErrorTracker, lensResult.error);
        console.error(`Google Lens API error for image ${idx + 1}:`, lensResult.error.message);
        sendProgress(controller, "Search API issue", lensResult.error.message, { 
          errorType: lensResult.error.type,
          isQuotaError: lensResult.error.type === 'quota_exceeded'
        });
      }
      continue;
    }
    
    // Reset consecutive errors on success
    resetConsecutiveErrors(apiErrorTracker);
    
    const lensData = lensResult.data;
    const visualMatches = lensData?.visual_matches || [];
    sendProgress(controller, `Found ${visualMatches.length} potential matches`, "Verifying with AI comparison", { matchCount: visualMatches.length });

    // ============================================================================
    // PER-IMAGE VERIFICATION SUMMARY TRACKING
    // Track filtering reasons for transparent logging
    // ============================================================================
    let matchesThisImage = 0;
    const filterStats = {
      total_candidates: visualMatches.length,
      filtered_no_url: 0,
      filtered_airbnb: 0,
      filtered_deduped: 0,
      filtered_blocked_platform: 0,
      filtered_non_booking_domain: 0,
      filtered_already_high_confidence: 0,
      filtered_cap_reached: 0,
      filtered_time_exceeded: 0,
      sent_to_verification: 0,
    };
    
    for (const match of visualMatches) {
      // ============================================================================
      // VERIFICATION CAP POLICY (Depth Control)
      // 
      // Caps reduce DEPTH (work per image), never stopping the outer discovery loop.
      // 
      // Per-image caps:
      // - matchesThisImage >= MAX_AI_PER_IMAGE → stop verifying this image, continue next
      // 
      // Global budget exhaustion:
      // - aiCount >= MAX_AI → enter 'no_ai' degraded mode, skip AI verification
      // - Time exceeded → enter 'fast_path' mode, skip verification
      // ============================================================================

      // Per-image cap: stop verifying more candidates for THIS image only
      if (matchesThisImage >= MAX_AI_PER_IMAGE) {
        console.log(`[PerImageCap] Reached per-image limit: matchesThisImage=${matchesThisImage}/${MAX_AI_PER_IMAGE} — continuing to next image`);
        filterStats.filtered_cap_reached++;
        break; // Exit candidates loop for this image only, outer loop continues
      }
      
      // Global AI budget: degrade to no_ai mode, don't stop
      if (aiCount >= MAX_AI && degradedMode === 'normal') {
        degradedMode = 'no_ai';
        degradedModeReason = `AI budget exhausted (${aiCount}/${MAX_AI} calls)`;
        console.log(`[DiscoveryDegraded] Entering no_ai mode: ${degradedModeReason}`);
        sendProgress(controller, "Degraded mode: no AI verification", `${degradedModeReason} — continuing with reduced verification depth`, {
          degraded_mode: 'no_ai',
          reason: degradedModeReason,
          images_remaining: imageUrls.length - idx,
          ai_count: aiCount,
          ai_limit: MAX_AI,
        });
      }
      
      // Time check: enter fast_path mode if exceeded (check before degraded mode)
      if (Date.now() - searchStartTime > MAX_TIME && degradedMode === 'normal') {
        degradedMode = 'fast_path';
        degradedModeReason = `Time budget exceeded at ${Math.round((Date.now() - searchStartTime) / 1000)}s`;
        console.log(`[DiscoveryDegraded] Entering fast_path mode: ${degradedModeReason}`);
        sendProgress(controller, "Degraded mode: fast path", degradedModeReason, {
          degraded_mode: 'fast_path',
          reason: degradedModeReason,
        });
      }
      
      // In degraded mode, skip AI verification but continue collecting candidates
      if (degradedMode === 'no_ai' || degradedMode === 'fast_path') {
        filterStats.filtered_cap_reached++;
        // Don't break - continue to next candidate, just skip AI verification
        continue;
      }

      const matchUrl = match.link;
      if (!matchUrl) {
        filterStats.filtered_no_url++;
        continue;
      }
      if (matchUrl.toLowerCase().includes("airbnb.")) {
        filterStats.filtered_airbnb++;
        continue;
      }
      if (foundUrls.has(matchUrl)) {
        filterStats.filtered_deduped++;
        continue;
      }
      if (isBlockedNonBookingPlatform(matchUrl)) {
        filterStats.filtered_blocked_platform++;
        continue;
      }
      if (!isBookingPlatform(matchUrl) && !isRegionalHotelSite(matchUrl) && !isDirectPropertySite(matchUrl)) {
        filterStats.filtered_non_booking_domain++;
        continue;
      }
      
      const platformName = getPlatformName(matchUrl);
      const platformKey = platformName.toLowerCase().replace(/[^a-z0-9]/g, '');
      
      // Check if we already have a match for this platform with high confidence
      const existingMatch = bestMatchPerPlatform.get(platformKey);
      if (
        existingMatch &&
        typeof existingMatch.confidence_score === "number" &&
        existingMatch.confidence_score >= 98
      ) {
        // Already have an excellent match for this platform, skip
        console.log(`Skipping ${platformName} verification - already have 98%+ match`);
        filterStats.filtered_already_high_confidence++;
        continue;
      }

      filterStats.sent_to_verification++;
      sendProgress(controller, `Verifying match on ${platformName}`, "AI comparing property photos to confirm it's the same place", { platform: platformName });
      sendStatusUpdate(controller, `ai_verifying_${platformName.toLowerCase().replace(/[^a-z0-9]/g, "_")}`);
      await supabase
        .from("searches")
        .update({ status: `ai_verifying_${platformName.toLowerCase().replace(/[^a-z0-9]/g, "_")}`, last_progress_at: new Date().toISOString() })
        .eq("id", searchId);
      await heartbeat();

      aiCount++;
      matchesThisImage++;
      foundUrls.add(matchUrl);

      const aiResult = await compareImagesWithAI(imageUrl, match.thumbnail || matchUrl);

      // IMPORTANT: aiResult.score is expressed in 0-100 "percent" units.
      // We persist confidence_score in the SAME 0-100 scale everywhere.
      // (Previously some code stored 0-1 which caused ImageGate to reject 95% as 0.95.)
      if (aiResult.isMatch && aiResult.score >= 90) {
        const newConfidence = aiResult.score;

        // Only keep this match if it's better than what we have for this platform
        if (!existingMatch || newConfidence > (existingMatch.confidence_score || 0)) {
          const newMatch = {
            platform_name: platformName,
            listing_url: matchUrl,
            listing_title: match.title || null,
            price: null,
            confidence_score: newConfidence,
            image_url: match.thumbnail || null,
            images: match.thumbnail ? [match.thumbnail] : [],
            match_type: "visual" as const,
            source_airbnb_image: imageUrl,
          };

          bestMatchPerPlatform.set(platformKey, newMatch);

          if (existingMatch) {
            sendProgress(
              controller,
              `Better match on ${platformName}`,
              `${aiResult.score}% confidence (was ${Math.round(existingMatch.confidence_score || 0)}%)`,
              { platform: platformName, confidence: aiResult.score },
            );
          } else {
            sendProgress(controller, `Verified match on ${platformName}`, `${aiResult.score}% confidence - same property confirmed`, {
              platform: platformName,
              confidence: aiResult.score,
            });
            
            // ============================================================================
            // PARALLEL PIPELINE OPTIMIZATION: Trigger price extraction IMMEDIATELY
            // Don't wait for all images - start extraction as soon as platform is VERIFIED
            // ============================================================================
            if (newConfidence >= 75) { // Above IMAGE_VERIFICATION_THRESHOLD
              const extractionPromise = triggerImmediatePriceExtraction(newMatch);
              extractionPromises.push(extractionPromise);
              sendProgress(controller, `Starting price extraction for ${platformName}`, "Running in parallel with continued discovery", {
                platform: platformName,
                parallelExtraction: true,
              });
            }
          }
        }
      }
    }
    
    // ============================================================================
    // PER-IMAGE VERIFICATION SUMMARY LOG (explicit counts + reasons)
    // This log makes verification behaviour unambiguous and self-explanatory
    // ============================================================================
    const filteredTotal = filterStats.total_candidates - filterStats.sent_to_verification;
    const filterBreakdown = [
      filterStats.filtered_no_url > 0 ? `no_url: ${filterStats.filtered_no_url}` : null,
      filterStats.filtered_airbnb > 0 ? `airbnb: ${filterStats.filtered_airbnb}` : null,
      filterStats.filtered_deduped > 0 ? `deduped: ${filterStats.filtered_deduped}` : null,
      filterStats.filtered_blocked_platform > 0 ? `blocked: ${filterStats.filtered_blocked_platform}` : null,
      filterStats.filtered_non_booking_domain > 0 ? `non_booking: ${filterStats.filtered_non_booking_domain}` : null,
      filterStats.filtered_already_high_confidence > 0 ? `already_verified: ${filterStats.filtered_already_high_confidence}` : null,
      filterStats.filtered_cap_reached > 0 ? `cap_reached: ${filterStats.filtered_cap_reached}` : null,
      filterStats.filtered_time_exceeded > 0 ? `time_exceeded: ${filterStats.filtered_time_exceeded}` : null,
    ].filter(Boolean).join(', ');
    
    console.log(`[Image ${idx + 1}/${imageUrls.length}] Verification summary: ${filterStats.total_candidates} candidates → ${filterStats.sent_to_verification} verified, ${filteredTotal} filtered [${filterBreakdown || 'none'}]`);
    
    // Build human-readable detail for the activity log
    let summaryDetail: string;
    if (filterStats.sent_to_verification === 0 && filterStats.total_candidates > 0) {
      // No verification ran - explain why
      summaryDetail = `All ${filterStats.total_candidates} filtered: ${filterBreakdown}`;
    } else if (filterStats.sent_to_verification > 0) {
      summaryDetail = `Verified ${filterStats.sent_to_verification}, filtered ${filteredTotal}${filterBreakdown ? ` (${filterBreakdown})` : ''}`;
    } else {
      summaryDetail = "No candidates found";
    }
    
    sendProgress(controller, `Finished verification for image ${idx + 1}`, summaryDetail, { 
      imageIndex: idx + 1, 
      totalImages: imageUrls.length,
      verificationSummary: filterStats,
      totalPlatformsDiscovered: bestMatchPerPlatform.size,
    });
    
    imagesProcessed = idx + 1;
    
    // NOTE: No global cap check here - we ALWAYS continue to next image
    // The outer loop is NEVER broken by caps, only by user skip or fatal error
  }
  
  // ============================================================================
  // DISCOVERY COMPLETION: All images processed
  // We should ALWAYS reach this point unless user skipped
  // ============================================================================
  if (imagesProcessed === imageUrls.length) {
    console.log(`[DiscoveryComplete] All ${imageUrls.length} images processed successfully`);
    
    // Build completion message with degraded mode info if applicable
    let completionDetail = `Completed ${imageUrls.length} of ${imageUrls.length} images`;
    if (degradedMode !== 'normal') {
      completionDetail += ` (degraded: ${degradedMode})`;
    }
    
    sendProgress(controller, "Discovery complete", completionDetail, {
      discovery_stop_reason: 'complete',
      imagesCompleted: imageUrls.length,
      totalImages: imageUrls.length,
      degraded_mode: degradedMode,
      degraded_reason: degradedModeReason,
      ai_count: aiCount,
      ai_limit: MAX_AI,
    });
  }

  // After all verification, collect best matches into alternatives array
  // This is the CURRENT RUN discovered matches ONLY
  alternatives.push(...bestMatchPerPlatform.values());
  
  const discoveredCount = bestMatchPerPlatform.size;
  console.log(`[Discovery Complete] Verification complete: ${discoveredCount} platforms found via image search`);
  sendProgress(controller, "Verification complete", `Found ${discoveredCount} platforms from image search`);


  // ============================================================================
  // FINAL CANDIDATE SET LOGGING (current-run matches only, no cache merge)
  // ============================================================================
  const totalPlatforms = discoveredCount;
  console.log(`[Pipeline] Proceeding with ${totalPlatforms} candidate listings (current-run verified only)`);
  sendProgress(controller, `Proceeding with ${totalPlatforms} candidate listings`, `${totalPlatforms} verified from current run`);

  // If we got no visual matches, run a targeted text search across likely platforms
  if (totalPlatforms === 0) {
    const location = extractLocationFromTitle(airbnbTitle);
    await addTargetedTextMatches({
      serpApiKey,
      title: airbnbTitle,
      cityHint: location.city,
      imageUrlForVerification: imageUrls[0] || null,
      alternatives,
      foundUrls,
      controller,
      errorTracker: apiErrorTracker,
      checkSkip: claimSkipNow, // Pass skip checker to abort text search on skip request
    });
  }

  // Store any API errors that occurred during the search
  if (apiErrorTracker.serpApiErrors.length > 0) {
    const errorSummary = getApiErrorSummary(apiErrorTracker);
    await supabase.from("searches").update({ 
      api_error: errorSummary,
      api_error_code: apiErrorTracker.hasQuotaError ? 'quota_exceeded' : 
                      apiErrorTracker.hasRateLimitError ? 'rate_limited' : 'api_error',
    }).eq("id", searchId);
  }

  const visualCountAfterFallback = alternatives.filter(a => a.match_type === 'visual').length;
  const totalCandidates = alternatives.length;

  if (totalCandidates === 0) {
    await supabase.from("searches").update({ status: "completed", airbnb_title: airbnbTitle, airbnb_price: airbnbPrice }).eq("id", searchId);
    sendSSE(controller, "complete", { success: true, results: [], airbnb: { title: airbnbTitle, price: airbnbPrice, images: imageUrls } });
    return;
  }

  sendProgress(controller, `Proceeding with ${totalCandidates} candidate listings`, visualCountAfterFallback > 0 ? "Includes visually verified matches" : "Text-only candidates (no photo verification)");

  // Step 3: Scrape prices
  sendProgress(controller, "Collecting prices", `Getting prices from ${alternatives.length} platforms for dates ${checkIn} to ${checkOut}`);
  sendStatusUpdate(controller, "comparing_prices");
  await supabase.from("searches").update({ status: "comparing_prices", last_progress_at: new Date().toISOString() }).eq("id", searchId);

  // Keep it bounded: price scraping is the slowest + most rate-limited step.
  // Scrape more candidates (and prioritize major booking platforms) so we don't miss cheaper listings.
  const prioritizedForPricing = [...alternatives].sort((a, b) => {
    const score = (x: typeof alternatives[number]) => {
      const u = x.listing_url.toLowerCase();
      if (u.includes("booking.com")) return 5;
      if (u.includes("tripadvisor.")) return 5;
      if (u.includes("vrbo.com") || u.includes("homeaway.")) return 4;
      if (u.includes("holidaycheck.")) return 4;
      if (isRegionalHotelSite(x.listing_url) || isDirectPropertySite(x.listing_url)) return 3;
      return 0;
    };
    return score(b) - score(a);
  });

  // Fetch platform adapters to check coverage tier
  interface PlatformAdapterInfo {
    platform_domain: string;
    coverage_tier: string | null;
    coverage_status: string | null;
    coverage_reason: string | null;
  }
  const { data: platformAdapters } = await supabase
    .from("platform_adapters")
    .select("platform_domain, coverage_tier, coverage_status, coverage_reason") as { data: PlatformAdapterInfo[] | null };
  
  const tierCDomains = new Set<string>();
  platformAdapters?.forEach((adapter: PlatformAdapterInfo) => {
    if (adapter.coverage_tier === 'C' || adapter.coverage_status === 'blocked') {
      tierCDomains.add(adapter.platform_domain.toLowerCase());
    }
  });

  // Helper to check if a URL belongs to a Tier C platform
  const isTierCPlatform = (url: string): { isTierC: boolean; reason?: string } => {
    const urlLower = url.toLowerCase();
    for (const domain of tierCDomains) {
      if (urlLower.includes(domain)) {
        const adapter = platformAdapters?.find((a: PlatformAdapterInfo) => a.platform_domain.toLowerCase() === domain);
        return { 
          isTierC: true, 
          reason: adapter?.coverage_reason || 'Platform not supported (Tier C)' 
        };
      }
    }
    return { isTierC: false };
  };

  const toScrape = prioritizedForPricing.slice(0, 20);
  
  // ============================================================================
  // PARALLEL PIPELINE OPTIMIZATION: Wait for parallel extractions to complete
  // Platforms already in extraction don't need to be processed again
  // ============================================================================
  console.log(`[ParallelPipeline] ${platformsInPriceExtraction.size} platforms already in extraction, ${extractionPromises.length} promises pending`);
  
  // Wait briefly for immediate extractions to be dispatched (not complete, just started)
  await Promise.race([
    Promise.all(extractionPromises),
    new Promise((r) => setTimeout(r, 1000)), // Only wait 1s max, don't block discovery
  ]);
  
  for (let i = 0; i < toScrape.length; i++) {
    // Check for skip request before each price scrape
    if (await claimSkipNow()) {
      console.log("SKIP requested - stopping price scraping");
      sendProgress(controller, "Skipped price collection", "Moving to results with data collected so far", { skipped: true });
      break;
    }
    await heartbeat();

    const alt = toScrape[i];
    const platformKey = alt.platform_name.toLowerCase().replace(/[^a-z0-9]/g, '');
    
    // ============================================================================
    // PARALLEL PIPELINE OPTIMIZATION: Skip if already being extracted
    // ============================================================================
    if (platformsInPriceExtraction.has(platformKey)) {
      console.log(`[ParallelPipeline] Skipping ${alt.platform_name} - already in parallel extraction`);
      sendProgress(
        controller,
        `Price extraction running for ${alt.platform_name}`,
        "Already processing in parallel pipeline",
        { platform: alt.platform_name, parallelExtraction: true, skipped: true }
      );
      continue;
    }
    
    // SHORT-CIRCUIT: Check if platform is Tier C (blocked/unsupported) BEFORE any extraction attempt
    const tierCCheck = isTierCPlatform(alt.listing_url);
    if (tierCCheck.isTierC) {
      console.log(`Skipping extraction for ${alt.platform_name}: Tier C - ${tierCCheck.reason}`);
      sendProgress(
        controller,
        `Skipped ${alt.platform_name}`,
        `Platform unsupported (Tier C): ${tierCCheck.reason}`,
        { platform: alt.platform_name, skipped: true, tier: 'C', reason: tierCCheck.reason }
      );
      // Mark in alternatives so it's saved with explicit unsupported status
      (alt as any)._tierCSkipped = true;
      (alt as any)._tierCReason = tierCCheck.reason;
      continue;
    }
    
    // Validate URL is an actual bookable property page before scraping
    const urlValidation = isValidBookablePropertyUrl(alt.listing_url);
    if (!urlValidation.valid) {
      console.log(`Skipping price scrape for ${alt.platform_name}: ${urlValidation.reason} - ${alt.listing_url.slice(0, 100)}`);
      sendProgress(
        controller,
        `Skipped ${alt.platform_name}`,
        urlValidation.reason || "Not a bookable property page",
        { platform: alt.platform_name, skipped: true }
      );
      continue;
    }
    
    sendProgress(
      controller,
      `Getting price from ${alt.platform_name}`,
      `Checking availability for ${checkIn} to ${checkOut} (${i + 1}/${toScrape.length})`,
      { platform: alt.platform_name, index: i + 1, total: toScrape.length }
    );
    await supabase
      .from("searches")
      .update({ status: `scraping_price_${alt.platform_name.toLowerCase().replace(/[^a-z0-9]/g, "_")}_${i + 1}_of_${toScrape.length}`, last_progress_at: new Date().toISOString() })
      .eq("id", searchId);

    // ============================================================================
    // EXPEDIA GOLDEN PATH: Route Expedia URLs to dedicated extract-expedia function
    // This uses the same logic as the Admin Dashboard extraction test
    // ============================================================================
    const isExpediaUrl = alt.listing_url.toLowerCase().includes('expedia.');
    
    if (isExpediaUrl) {
      console.log(`[EXPEDIA GOLDEN PATH] Routing ${alt.platform_name} to dedicated extract-expedia function`);
      sendProgress(
        controller,
        `Extracting Expedia price (Golden Path)`,
        `Using verified extraction with target card anchoring`,
        { platform: alt.platform_name }
      );
      
      try {
        const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
        const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
        
        // Extract adults from Airbnb URL or default to 2
        const adultsParam = (() => {
          try {
            const airbnbUrlObj = new URL(search.airbnb_url);
            const adults = parseInt(airbnbUrlObj.searchParams.get('adults') || airbnbUrlObj.searchParams.get('numberOfAdults') || '2', 10);
            return Math.max(2, adults); // Expedia requires minimum 2 adults
          } catch {
            return 2;
          }
        })();
        
        // Call extract-expedia with the same parameters as admin test harness
        const expediaResponse = await fetch(`${supabaseUrl}/functions/v1/extract-expedia`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${supabaseServiceKey}`,
          },
          body: JSON.stringify({
            url: alt.listing_url,
            checkIn: checkIn,
            checkOut: checkOut,
            adults: adultsParam,
            requireValidation: true,
            searchId: searchId,
            // Note: extractionId will be created by the function if not provided
          }),
        });
        
        if (!expediaResponse.ok) {
          const errorText = await expediaResponse.text();
          console.error(`[EXPEDIA GOLDEN PATH] extract-expedia HTTP error: ${expediaResponse.status}`, errorText);
          sendProgress(controller, `Expedia extraction failed`, `HTTP ${expediaResponse.status}`, {
            platform: alt.platform_name,
            error: true,
          });
          // Mark with terminal status for UI
          (alt as any)._expediaTerminalStatus = 'render_failed';
          (alt as any)._expediaError = `HTTP ${expediaResponse.status}`;
          continue;
        }
        
        const expediaResult = await expediaResponse.json();
        console.log(`[EXPEDIA GOLDEN PATH] Result:`, JSON.stringify({
          success: expediaResult.success,
          status: expediaResult.status,
          price: expediaResult.price,
          structuralProof: expediaResult.structuralProof ? {
            offers_page_gate_passed: expediaResult.structuralProof.offers_page_gate_passed,
            target_card_found: expediaResult.structuralProof.target_card_found,
            extracted_from_target_card: expediaResult.structuralProof.extracted_from_target_card,
          } : null,
        }));
        
        // Store Expedia-specific metadata on the alternative for later DB persistence
        (alt as any)._expediaResult = expediaResult;
        (alt as any)._expediaTerminalStatus = expediaResult.status;
        (alt as any)._expediaStructuralProof = expediaResult.structuralProof;
        (alt as any)._expediaTrace = expediaResult.expedia_trace;
        
        // Map Expedia result to standard price format
        if (expediaResult.success && expediaResult.price) {
          // Calculate per-night rate from total
          const expediaNights = calculateNights(checkIn, checkOut);
          const perNightRate = Math.round(expediaResult.price / expediaNights);
          
          alt.price = perNightRate;
          alt.price_check_in = checkIn;
          alt.price_check_out = checkOut;
          alt.dates_differ = false;
          
          // Mark as verified if structural proof passes
          const isVerified = expediaResult.structuralProof?.extracted_from_target_card === true;
          (alt as any)._expediaVerified = isVerified;
          
          sendProgress(
            controller,
            `Found Expedia price${isVerified ? ' (Verified)' : ''}`,
            `$${expediaResult.price} total ($${perNightRate}/night) - includes taxes & fees`,
            { platform: alt.platform_name, price: perNightRate, verified: isVerified, totalPrice: expediaResult.price }
          );
        } else {
          // No price found - report the terminal status
          const statusMessage = (() => {
            switch (expediaResult.status) {
              case 'expedia_target_offer_not_found':
                return 'Property not found on Expedia';
              case 'expedia_dates_unavailable_for_target':
                return 'Not available for these dates on Expedia';
              case 'expedia_target_offer_mismatch':
                return 'Property mismatch on Expedia';
              case 'expedia_target_total_not_found':
                return 'Total price not visible on Expedia';
              case 'expedia_access_blocked':
              case 'blocked_captcha_or_bot':
                return 'Blocked by Expedia';
              case 'dates_unavailable':
                return 'Dates unavailable on Expedia';
              default:
                return expediaResult.error || 'Extraction failed';
            }
          })();
          
          sendProgress(controller, `No Expedia price`, statusMessage, {
            platform: alt.platform_name,
            status: expediaResult.status,
          });
        }
        
      } catch (expediaError) {
        console.error(`[EXPEDIA GOLDEN PATH] Exception:`, expediaError);
        sendProgress(controller, `Expedia extraction error`, String(expediaError), {
          platform: alt.platform_name,
          error: true,
        });
        (alt as any)._expediaTerminalStatus = 'extraction_error';
        (alt as any)._expediaError = String(expediaError);
      }
      
      continue; // Skip generic extraction for Expedia
    }
    
    // ============================================================================
    // GENERIC PATH: Use Firecrawl-based extraction for non-Expedia platforms
    // ============================================================================
    if (!firecrawlApiKey) continue;

    const priceData = await scrapePriceFromListing(alt.listing_url, checkIn, checkOut, firecrawlApiKey, alt.platform_name, claimSkipNow);
    
    // If price scraping was skipped, break out of the loop
    if (priceData.skipped) {
      console.log(`Price scraping skipped for ${alt.platform_name} - breaking out of loop`);
      sendProgress(controller, "Skipped price collection", "Moving to results with data collected so far", { skipped: true });
      break;
    }
    
    alt.price = priceData.perNightRate;
    alt.price_check_in = priceData.usedCheckIn;
    alt.price_check_out = priceData.usedCheckOut;
    alt.dates_differ = priceData.datesDiffer;

    if (priceData.perNightRate && priceData.perNightRate >= 10) {
      if (priceData.datesDiffer) {
        sendProgress(
          controller,
          `Found price on ${alt.platform_name}`,
          `€${priceData.perNightRate}/night (dates ${priceData.usedCheckIn} - ${priceData.usedCheckOut}, original dates unavailable)`,
          { platform: alt.platform_name, price: priceData.perNightRate, datesDiffer: true }
        );
      } else {
        sendProgress(controller, `Found price on ${alt.platform_name}`, `€${priceData.perNightRate}/night`, {
          platform: alt.platform_name,
          price: priceData.perNightRate,
        });
      }
    } else {
      sendProgress(controller, `No price on ${alt.platform_name}`, "No valid price found for the selected dates", {
        platform: alt.platform_name,
      });
    }
  }

  // ============================================================================
  // IMAGE VERIFICATION GATE - CORE PRODUCT INVARIANT
  // ============================================================================
  // Only image-verified matches (match_type='visual') may be saved as results.
  // Text-only matches are NEVER valid alternatives regardless of quantity.
  // This is the platform's primary KPI: reverse image verification is the
  // mandatory source of truth for identifying valid alternative listings.
  // ============================================================================
  const IMAGE_VERIFICATION_THRESHOLD = 75; // Minimum confidence score for visual matches
  
  const imageVerifiedAlternatives = alternatives.filter((alt) => {
    // STRICT: Only 'visual' match types are valid
    if (alt.match_type !== 'visual') {
      console.log(`[ImageGate] REJECTED text-only match: ${alt.platform_name} - ${alt.listing_url.slice(0, 80)}`);
      return false;
    }
    
    // STRICT: Must have confidence score above threshold
    if (typeof alt.confidence_score !== 'number' || alt.confidence_score < IMAGE_VERIFICATION_THRESHOLD) {
      console.log(`[ImageGate] REJECTED low-confidence match: ${alt.platform_name} (${alt.confidence_score ?? 'null'}%) - ${alt.listing_url.slice(0, 80)}`);
      return false;
    }
    
    return true;
  });
  
  const rejectedCount = alternatives.length - imageVerifiedAlternatives.length;
  console.log(`[ImageGate] Passed: ${imageVerifiedAlternatives.length}, Rejected: ${rejectedCount} (text-only or low-confidence)`);
  
  if (rejectedCount > 0 && imageVerifiedAlternatives.length === 0) {
    sendProgress(controller, "No verified alternatives found", 
      `Found ${rejectedCount} candidate${rejectedCount > 1 ? 's' : ''} but none passed image verification`);
  }

  // Calculate savings for VERIFIED alternatives only
  const allResultsWithMeta = imageVerifiedAlternatives.map((alt) => ({
    ...alt,
    original_price: airbnbPrice,
    savings_amount: airbnbPrice && alt.price && alt.price < airbnbPrice ? airbnbPrice - alt.price : null,
    savings_percentage: airbnbPrice && alt.price && alt.price < airbnbPrice ? Math.round(((airbnbPrice - alt.price) / airbnbPrice) * 100) : null,
  }));

  // Separate results with and without prices for sorting
  const resultsWithPrices = allResultsWithMeta.filter((a) => !!a.price && a.price >= 10);
  const resultsWithoutPrices = allResultsWithMeta.filter((a) => !a.price || a.price < 10);

  // Sort priced results by savings
  resultsWithPrices.sort((a, b) => (b.savings_percentage ?? 0) - (a.savings_percentage ?? 0));

  // Combine: priced results first, then priceless results (still valuable photo matches)
  const allResultsSorted = [...resultsWithPrices, ...resultsWithoutPrices];

  // Save only IMAGE-VERIFIED results to DB
  // PARALLEL PIPELINE OPTIMIZATION: Use upsert since some may already be persisted via immediate extraction
  console.log(`[ImageGate] Saving ${allResultsSorted.length} image-verified results to DB (${resultsWithPrices.length} with prices, ${resultsWithoutPrices.length} without) for search ${searchId}`);
  if (allResultsSorted.length > 0) {
    // BACKEND GUARD: Tier C platforms must NEVER have prices persisted
    // This is defense-in-depth - even if upstream logic fails, prices cannot leak
    const insertData = allResultsSorted
      .filter((r) => {
        // Skip platforms already handled by immediate extraction (they're already persisted)
        const platformKey = r.platform_name.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (platformsInPriceExtraction.has(platformKey)) {
          console.log(`[ParallelPipeline] Skipping insert for ${r.platform_name} - already persisted via immediate extraction`);
          return false;
        }
        return true;
      })
      .map((r) => {
        const tierCCheck = isTierCPlatform(r.listing_url);
        const isTierC = tierCCheck.isTierC || (r as any)._tierCSkipped;
        
        if (isTierC && r.price) {
          console.log(`GUARD: Nulling price for Tier C platform ${r.platform_name} (was ${r.price})`);
        }
        
        return {
          search_id: searchId,
          platform_name: r.platform_name,
          listing_url: r.listing_url,
          listing_title: r.listing_title,
          // CRITICAL: Null price for Tier C platforms
          price: isTierC ? null : r.price,
          original_price: r.original_price,
          savings_amount: isTierC ? null : r.savings_amount,
          savings_percentage: isTierC ? null : r.savings_percentage,
          confidence_score: r.confidence_score,
          image_url: r.image_url,
          images: r.images,
          match_type: r.match_type,
          source_airbnb_image: r.source_airbnb_image || null,
          price_check_in: r.price_check_in || checkIn,
          price_check_out: r.price_check_out || checkOut,
          dates_differ: r.dates_differ || false,
        };
      });
    
    if (insertData.length > 0) {
      console.log(
        "Insert data:",
        JSON.stringify(insertData.map((d) => ({ platform: d.platform_name, url: d.listing_url.slice(0, 50), price: d.price, datesDiffer: d.dates_differ })))
      );
      const { data: insertedData, error: insertError } = await supabase
        .from("search_results")
        .upsert(insertData, { onConflict: 'search_id,listing_url' })
        .select();
      if (insertError) {
        console.error("CRITICAL: Failed to insert search results:", insertError.message, insertError.details);
      } else {
        console.log(`SUCCESS: Upserted ${insertedData?.length || 0} results to search_results table`);
        
        // ============================================================================
        // AUTHORITATIVE PLATFORM SET: Insert into search_platforms
        // This is the canonical set - all matched platforms MUST appear here
        // The final snapshot is built from this set, ensuring no platforms are dropped
        // ============================================================================
        if (insertedData && insertedData.length > 0) {
          const platformInserts = insertedData.map((r: any) => ({
            search_id: searchId,
            platform_name: r.platform_name,
            listing_url: r.listing_url,
            listing_title: r.listing_title,
            image_url: r.image_url,
            images: r.images || [],
            match_type: r.match_type,
            source_airbnb_image: r.source_airbnb_image || null,
          }));
          
          const { error: platformError } = await supabase
            .from("search_platforms")
            .upsert(platformInserts, { onConflict: 'search_id,listing_url' });
          
          if (platformError) {
            console.error("[search_platforms] Upsert failed:", platformError.message);
          } else {
            console.log(`[search_platforms] Upserted ${platformInserts.length} platforms to authoritative set`);
          }
        }
      }
    } else {
      console.log(`[ParallelPipeline] All ${allResultsSorted.length} platforms already persisted via immediate extraction`);
    }
    
    // ============================================================================
    // PARALLEL PIPELINE OPTIMIZATION: Trigger deep links for remaining platforms
    // Platforms already in extraction skip this step (they already have workers running)
    // ============================================================================
    const remainingPlatformsCount = allResultsSorted.filter((r) => {
      const platformKey = r.platform_name.toLowerCase().replace(/[^a-z0-9]/g, '');
      return !platformsInPriceExtraction.has(platformKey);
    }).length;
    
    if (remainingPlatformsCount > 0) {
      sendProgress(controller, "Generating booking links", `Creating deep links for ${remainingPlatformsCount} remaining platforms`);
      
      try {
        // Call generate-deep-links function to create proper booking links
        const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
        const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
        
        const deepLinkResponse = await fetch(`${supabaseUrl}/functions/v1/generate-deep-links`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${supabaseServiceKey}`,
          },
          body: JSON.stringify({
            searchId,
            checkIn,
            checkOut,
            adults: 2, // Default occupancy
            children: 0,
            rooms: 1,
          }),
        });
        
        if (deepLinkResponse.ok) {
          const deepLinkData = await deepLinkResponse.json();
          console.log(`Generated ${deepLinkData.deepLinks?.length || 0} deep links`);
          sendProgress(controller, "Booking links ready", `Created ${deepLinkData.deepLinks?.length || 0} platform-specific links`);
        } else {
          console.error("Failed to generate deep links:", await deepLinkResponse.text());
        }
      } catch (deepLinkError) {
        console.error("Error generating deep links:", deepLinkError);
        // Don't fail the search if deep link generation fails
      }
    } else {
      console.log(`[ParallelPipeline] All platforms already have price extraction running`);
    }
    
    // NOTE: Caching of matches to known_property_matches has been removed.
    // Search results are now based ONLY on current-run verified matches.
  }

  // Step 4: ATOMIC FINALIZATION
  // Use finalizeAndCompleteSearch to ensure invariant: completed = snapshot exists
  // CRITICAL: finalization must NOT run until every matched platform has a terminal extraction status.
  sendProgress(controller, "Finalizing results", "Waiting for all platforms to finish pricing");
  sendStatusUpdate(controller, "finalizing");

  const FINALIZE_MAX_WAIT_MS = 60_000;
  const FINALIZE_POLL_MS = 2_000;
  const EXTRACTION_TIMEOUT_MS = 45_000; // Per-platform extraction timeout guard
  const finalizeStart = Date.now();

  // ============================================================================
  // TIMEOUT GUARD: Mark any extraction stuck in pending/running as FAILED after timeout
  // This ensures deterministic terminal convergence even when workers fail silently.
  // ============================================================================
  async function enforceExtractionTimeouts(): Promise<number> {
    const cutoffTime = new Date(Date.now() - EXTRACTION_TIMEOUT_MS).toISOString();
    
    const { data: stuckExtractions, error: fetchError } = await supabase
      .from('price_extractions')
      .select('id, platform_name, extraction_status, created_at')
      .eq('search_id', searchId)
      .in('extraction_status', ['pending', 'queued', 'running', 'in_progress', 'started'])
      .lt('created_at', cutoffTime);
    
    if (fetchError || !stuckExtractions || stuckExtractions.length === 0) {
      return 0;
    }
    
    console.log(`[TimeoutGuard] Found ${stuckExtractions.length} stuck extractions to mark as failed`);
    
    for (const extraction of stuckExtractions) {
      const { error: updateError } = await supabase
        .from('price_extractions')
        .update({
          extraction_status: 'timeout',
          extraction_error: `Extraction timed out after ${EXTRACTION_TIMEOUT_MS / 1000}s`,
          updated_at: new Date().toISOString(),
        })
        .eq('id', extraction.id);
      
      if (!updateError) {
        console.log(`[TimeoutGuard] Marked ${extraction.platform_name} (${extraction.id}) as timeout`);
        
        // Also update search_platforms terminal status
        await supabase
          .from('search_platforms')
          .update({
            extraction_status_terminal: 'timeout',
            last_error: `Extraction timed out after ${EXTRACTION_TIMEOUT_MS / 1000}s`,
            updated_at: new Date().toISOString(),
          })
          .eq('search_id', searchId)
          .eq('extraction_id_latest', extraction.id);
      }
    }
    
    return stuckExtractions.length;
  }

  // Track last progress message to avoid duplicates in UI
  let lastProgressMsg = '';

  let finalizationResult = await finalizeAndCompleteSearch({
    supabase,
    searchId,
    airbnbTitle,
    airbnbPrice,
    airbnbCurrency: search.airbnb_currency || 'USD',
    airbnbImageUrl: imageUrls[0] || null,
    airbnbImages: imageUrls.slice(0, 5),
    checkIn,
    checkOut,
    nights,
  });

  while (!finalizationResult.success && !finalizationResult.alreadyFinalized) {
    const elapsed = Date.now() - finalizeStart;
    if (elapsed > FINALIZE_MAX_WAIT_MS) {
      // Final timeout reached - force stuck extractions to terminal state
      const forcedCount = await enforceExtractionTimeouts();
      if (forcedCount > 0) {
        console.log(`[Finalization] Forced ${forcedCount} stuck extractions to timeout, retrying finalization`);
        finalizationResult = await finalizeAndCompleteSearch({
          supabase,
          searchId,
          airbnbTitle,
          airbnbPrice,
          airbnbCurrency: search.airbnb_currency || 'USD',
          airbnbImageUrl: imageUrls[0] || null,
          airbnbImages: imageUrls.slice(0, 5),
          checkIn,
          checkOut,
          nights,
        });
      }
      break;
    }

    // The shared helper returns "Not ready to finalize" while extractions are still running.
    if (finalizationResult.error?.includes('Not ready to finalize')) {
      // DE-DUPLICATION: Only send progress if message changed
      if (finalizationResult.error !== lastProgressMsg) {
        sendProgress(controller, "Finalizing results", finalizationResult.error);
        lastProgressMsg = finalizationResult.error;
      }
      
      // Check for and fix stuck extractions mid-loop
      await enforceExtractionTimeouts();
      
      await new Promise((r) => setTimeout(r, FINALIZE_POLL_MS));
      finalizationResult = await finalizeAndCompleteSearch({
        supabase,
        searchId,
        airbnbTitle,
        airbnbPrice,
        airbnbCurrency: search.airbnb_currency || 'USD',
        airbnbImageUrl: imageUrls[0] || null,
        airbnbImages: imageUrls.slice(0, 5),
        checkIn,
        checkOut,
        nights,
      });
      continue;
    }

    // Any other error is fatal
    break;
  }

  if (!finalizationResult.success && !finalizationResult.alreadyFinalized) {
    console.error(`[search-alternatives/SSE] Finalization failed: ${finalizationResult.error}`);
    sendSSE(controller, "error", { 
      message: `Finalization failed: ${finalizationResult.error}`,
      finalization_failed: true,
    });
    return;
  }

  // ============================================================================
  // FIX: Compute "with prices" from DB (price_extractions) instead of in-memory
  // Parallel extraction writes to DB asynchronously, so in-memory alt.price
  // may be stale. Query the authoritative source for the final summary.
  // ============================================================================
  let dbPriceCount = 0;
  try {
    const { data: pricedExtractions, error: priceCountError } = await supabase
      .from('price_extractions')
      .select('id, extracted_price, extraction_status')
      .eq('search_id', searchId)
      .not('extracted_price', 'is', null)
      .gte('extracted_price', 10);
    
    if (!priceCountError && pricedExtractions) {
      dbPriceCount = pricedExtractions.length;
    }
    
    // Debug log: compare in-memory vs DB counts for validation
    console.log(`[PriceCountDebug] search=${searchId} inMemory=${resultsWithPrices.length} db=${dbPriceCount}`);
  } catch (err) {
    console.error(`[PriceCountDebug] Failed to query DB price count:`, err);
    // Fall back to in-memory count if DB query fails
    dbPriceCount = resultsWithPrices.length;
  }
  
  // Use DB count for final summary (authoritative source)
  const finalPriceCount = dbPriceCount;
  
  console.log(`[search-alternatives/SSE] Finalized search ${searchId} with ${finalizationResult.resultCount} results`);
  sendProgress(controller, "Search complete", allResultsSorted.length > 0 ? `Found ${allResultsSorted.length} alternatives (${finalPriceCount} with prices)` : "No alternatives found");
  sendSSE(controller, "complete", {
    success: true,
    results: allResultsSorted,
    airbnb: { title: airbnbTitle, price: airbnbPrice, url: search.airbnb_url, imageUrl: imageUrls[0], images: imageUrls },
    dates: { checkIn, checkOut, nights },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Extract and verify JWT token
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Authentication required" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const serpApiKey = Deno.env.get("SERPAPI_API_KEY");
    const firecrawlApiKey = Deno.env.get("FIRECRAWL_API_KEY_1") || Deno.env.get("FIRECRAWL_API_KEY");

    if (!serpApiKey) {
      return new Response(
        JSON.stringify({ error: "Search service temporarily unavailable" }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    
    console.log("Firecrawl API available:", !!firecrawlApiKey);

    // Create a user-scoped client to verify the user
    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } }
    });

    // Get authenticated user
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) {
      console.error("Auth error:", userError?.message);
      return new Response(
        JSON.stringify({ error: "Invalid authentication token" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log("Authenticated user:", user.id);

    let body;
    try {
      body = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid request body" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    
    const { searchId, stream = false, simulateBrowserlessFail = false } = body;
    
    if (!searchId) {
      return new Response(
        JSON.stringify({ error: "Search ID is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validate searchId is a valid UUID
    if (typeof searchId !== "string" || !UUID_REGEX.test(searchId)) {
      return new Response(
        JSON.stringify({ error: "Invalid search ID format" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Use service role client for database operations
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Fetch the search and verify ownership
    const { data: search, error: searchError } = await supabase
      .from("searches")
      .select("*")
      .eq("id", searchId)
      .single();

    if (searchError || !search) {
      return new Response(
        JSON.stringify({ error: "Search not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // CRITICAL: Verify the search belongs to the authenticated user
    if (search.user_id !== user.id) {
      console.error("User", user.id, "attempted to access search owned by", search.user_id);
      return new Response(
        JSON.stringify({ error: "Access denied" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validate the Airbnb URL from the database
    if (!search.airbnb_url || !isValidAirbnbUrl(search.airbnb_url)) {
      console.error("Invalid Airbnb URL in database:", search.airbnb_url);
      return new Response(
        JSON.stringify({ error: "Invalid Airbnb URL" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ============================================================
    // If streaming mode requested, use SSE
    // ============================================================
    if (stream) {
      const sseHeaders = {
        ...corsHeaders,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      };

      const readableStream = new ReadableStream({
        async start(controller) {
          markControllerValid(controller);
          try {
            await runSearchWithStreaming(controller, {
              search,
              searchId,
              supabase,
              serpApiKey: serpApiKey!,
              firecrawlApiKey,
              simulateBrowserlessFail,
            });
          } catch (error) {
            console.error("Streaming search error:", error);
            const errorMessage = (error as Error).message || "Search failed";
            
            // CRITICAL: Always update DB to terminal state on error
            // This prevents searches from being stuck indefinitely
            try {
              await supabase.from("searches").update({ 
                status: "error",
                api_error: errorMessage,
                api_error_code: "pipeline_error",
              }).eq("id", searchId);
              console.log(`Search ${searchId} marked as error in DB`);
            } catch (dbError) {
              console.error("Failed to update search status to error:", dbError);
            }
            
            sendSSE(controller, "error", { message: errorMessage });
            sendSSE(controller, "complete", { success: false, error: errorMessage });
          } finally {
            // SAFETY NET: Ensure search always reaches a terminal state
            // This handles cases where the stream closes before normal completion
            try {
              const { data: finalCheck } = await supabase
                .from("searches")
                .select("status")
                .eq("id", searchId)
                .single();
              
              const nonTerminalStatuses = ['pending', 'searching', 'searching_platforms', 'comparing_prices', 'extracting_price', 'scraping_airbnb_page'];
              if (finalCheck && nonTerminalStatuses.some(s => finalCheck.status?.startsWith(s) || finalCheck.status === s)) {
                console.log(`SAFETY NET: Search ${searchId} was stuck at "${finalCheck.status}", marking as completed`);
                // CRITICAL: Only update status and api_error - do NOT overwrite airbnb_price or other fields
                // The airbnb_price should already be persisted from earlier in the pipeline
                await supabase.from("searches").update({ 
                  status: "completed",
                  api_error: 'Search stream closed before completion',
                }).eq("id", searchId);
              }
            } catch (safetyErr) {
              console.error("Safety net check failed:", safetyErr);
            }
            
            markControllerInvalid(controller);
            try { controller.close(); } catch { /* already closed */ }
          }
        },
      });

      return new Response(readableStream, { headers: sseHeaders });
    }

    // ============================================================
    // Non-streaming mode (legacy) - existing code path
    // ============================================================
    console.log("Processing search for URL:", search.airbnb_url);

    const roomIdMatch = search.airbnb_url.match(/rooms\/(\d+)/);
    const roomId = roomIdMatch ? roomIdMatch[1] : null;
    console.log("Airbnb room ID:", roomId);

    // Extract dates from URL - REQUIRED for price comparison
    const { checkIn, checkOut } = extractDatesFromUrl(search.airbnb_url);
    if (!checkIn || !checkOut) {
      console.log("Missing dates in URL - dates are required for price comparison");
      await supabase.from("searches").update({ 
        status: "dates_required" 
      }).eq("id", searchId);
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: "Dates are required for price comparison. Please copy a full Airbnb URL that includes your check-in and check-out dates (e.g., airbnb.com/rooms/123?check_in=2025-01-15&check_out=2025-01-18).",
          status: "dates_required"
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 }
      );
    }
    console.log("Using URL dates:", checkIn, "to", checkOut);
    
    // Calculate nights
    const nights = calculateNights(checkIn, checkOut);

    // IMPORTANT: Save dates immediately after extraction so they're available even if search stalls
    console.log(`Extracted dates from URL: checkIn=${checkIn}, checkOut=${checkOut}, nights=${nights}`);
    await supabase.from("searches").update({ 
      check_in_date: checkIn, 
      check_out_date: checkOut, 
      nights_count: nights,
      status: "extracting_photos",
      last_progress_at: new Date().toISOString() 
    }).eq("id", searchId);

    const alternatives: SearchResult[] = [];
    const foundUrls = new Set<string>();
    let airbnbTitle = "Vacation Rental";
    let airbnbPrice: number | null = null;
    let firecrawlMarkdown = "";
    let firecrawlHtml = "";
    let directHtml = "";


    // Step 1: Fetch Airbnb page and extract property data using Firecrawl for JS rendering
    console.log("Step 1: Extracting property data from Airbnb...");
    
    let imageUrls: string[] = [];
    
    // Use Firecrawl if available (handles JS-rendered content like prices)
    if (firecrawlApiKey) {
      await supabase.from("searches").update({ status: "scraping_airbnb_page" }).eq("id", searchId);
      console.log("Using Firecrawl to scrape Airbnb (with JS rendering)...");
      try {
        console.log("Firecrawl scraping Airbnb with extended wait time...");
        // NOTE: Firecrawl requires waitFor <= timeout/2. Use timeout=60000, waitFor=25000.
        const firecrawlResponse = await fetch('https://api.firecrawl.dev/v1/scrape', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${firecrawlApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            url: search.airbnb_url,
            formats: ['markdown', 'html', 'rawHtml'],
            onlyMainContent: false,
            waitFor: 25000, // Must be <= timeout/2. Airbnb needs time for JS.
            timeout: 60000, // Overall timeout
          }),
        });
        
        if (firecrawlResponse.ok) {
          const firecrawlData = await firecrawlResponse.json();
          const markdown = firecrawlData.data?.markdown || '';
          const html = firecrawlData.data?.html || '';
          const rawHtml = firecrawlData.data?.rawHtml || html;

          // Keep copies for potential AI-based price extraction later
          firecrawlMarkdown = markdown;
          firecrawlHtml = rawHtml || html;

          
          console.log("Firecrawl response - markdown length:", markdown.length, "html length:", html.length);
          
          // Extract title from metadata or content
          const metaTitle = firecrawlData.data?.metadata?.title;
          if (metaTitle) {
            airbnbTitle = metaTitle
              .replace(" - Airbnb", "")
              .replace(" · Airbnb", "")
              .replace(/\s*-\s*(Houses|Apartments|Homes|Villas|Cabins|Cottages|Condos)?\s*(for Rent|to Rent|zur Miete|in)?\s*.*$/i, "")
              .trim();
            console.log("Extracted title from metadata:", airbnbTitle);
          }
          
          // Extract price from Firecrawl content - multiple patterns for different currencies
          const pricePatterns = [
            // Total price patterns (most reliable)
            /total[:\s]*€\s*(\d{1,5}(?:,\d{3})*)/i,
            /total[:\s]*\$\s*(\d{1,5}(?:,\d{3})*)/i,
            /total[:\s]*CHF\s*(\d{1,5}(?:,\d{3})*)/i,
            /gesamt[:\s]*€\s*(\d{1,5}(?:,\d{3})*)/i,
            // Per night patterns
            /€\s*(\d{1,5}(?:,\d{3})*)\s*(?:per night|\/night|night|pro nacht)/i,
            /\$\s*(\d{1,5}(?:,\d{3})*)\s*(?:per night|\/night|night)/i,
            /CHF\s*(\d{1,5}(?:,\d{3})*)\s*(?:per night|\/night|night|pro nacht)/i,
            // Generic price patterns
            /€(\d{1,5}(?:,\d{3})*)\s*x\s*\d+\s*nights?/i,
            /\$(\d{1,5}(?:,\d{3})*)\s*x\s*\d+\s*nights?/i,
            // Fallback: any price-like number after currency
            /€\s*(\d{2,4})/,
            /\$\s*(\d{2,4})/,
            /CHF\s*(\d{2,4})/,
          ];
          
          // Try markdown first (cleaner), then HTML
          const contentToSearch = markdown + ' ' + html;
          
          for (const pattern of pricePatterns) {
            const priceMatch = contentToSearch.match(pattern);
            if (priceMatch) {
              const priceStr = priceMatch[1].replace(/,/g, '');
              const extractedPrice = parseInt(priceStr);
              // Validate price is reasonable (between 10 and 5000 per night)
              if (extractedPrice >= 10 && extractedPrice <= 5000) {
                airbnbPrice = extractedPrice;
                console.log("Extracted Airbnb price from Firecrawl:", airbnbPrice);
                break;
              }
            }
          }
          
          // Extract images from HTML content - comprehensive patterns for all Airbnb CDN formats
          const imagePatterns = [
            // Standard hosting images
            /https:\/\/a0\.muscache\.com\/im\/pictures\/hosting\/Hosting-[^"'\s\)\]\\<>]+/gi,
            /https:\/\/a0\.muscache\.com\/im\/pictures\/miso\/[^"'\s\)\]\\<>]+/gi,
            /https:\/\/a0\.muscache\.com\/im\/pictures\/BnbProperty\/[^"'\s\)\]\\<>]+/gi,
            /https:\/\/a0\.muscache\.com\/im\/pictures\/prohost-api\/[^"'\s\)\]\\<>]+/gi,
            // UUID format images
            /https:\/\/a0\.muscache\.com\/im\/pictures\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}[^"'\s\)\]\\<>]*/gi,
            // Airbnb media URLs (newer format)
            /https:\/\/a0\.muscache\.com\/im\/ml\/[^"'\s\)\]\\<>]+/gi,
            // Alternative subdomains (a1, a2, etc.)
            /https:\/\/a[0-9]\.muscache\.com\/im\/pictures\/[^"'\s\)\]\\<>]+/gi,
            // Generic muscache with any path to /pictures/
            /https:\/\/[a-z0-9]+\.muscache\.com\/[^"'\s\)\]\\<>]*pictures[^"'\s\)\]\\<>]+/gi,
            // Newer airbnbusercontent.com domain
            /https:\/\/[a-z0-9-]+\.airbnbusercontent\.com\/[^"'\s\)\]\\<>]+/gi,
          ];

          const canonicalizeMuscacheUrl = (url: string) => {
            let cleaned = url.replace(/\\u002F/g, "/").replace(/\\/g, "");
            // Remove trailing punctuation that might have been captured
            cleaned = cleaned.replace(/[,;:]+$/, "");
            // Remove query params like ?im_w=1200 to dedupe correctly
            return cleaned.split("?")[0];
          };

          let allImageUrls: string[] = [];
          const htmlContent = rawHtml || html;

          // Log content length for debugging
          console.log(`Searching for images in ${htmlContent.length} chars of HTML content`);

          for (const pattern of imagePatterns) {
            const matches = htmlContent.match(pattern) || [];
            if (matches.length > 0) {
              console.log(`Pattern ${pattern.source.substring(0, 50)}... found ${matches.length} matches`);
            }
            allImageUrls.push(...matches);
          }

          // Also check markdown for image URLs
          const markdownImageMatches = markdown.match(/https:\/\/[a-z0-9-]+\.(muscache|airbnbusercontent)\.com\/[^\s\)"\]\\<>]+/gi) || [];
          if (markdownImageMatches.length > 0) {
            console.log(`Markdown found ${markdownImageMatches.length} potential image URLs`);
          }
          allImageUrls.push(...markdownImageMatches);

          // Extract from embedded JSON data (more reliable for modern Airbnb pages)
          const jsonImagePatterns = [
            /"(?:pictureUrl|baseUrl|url)"\s*:\s*"(https:\/\/[^"]+muscache\.com[^"]+)"/gi,
            /"(?:pictureUrl|baseUrl|url)"\s*:\s*"(https:\/\/[^"]+airbnbusercontent\.com[^"]+)"/gi,
          ];
          for (const pattern of jsonImagePatterns) {
            let match;
            while ((match = pattern.exec(htmlContent)) !== null) {
              if (match[1]) {
                allImageUrls.push(match[1].replace(/\\u002F/g, "/").replace(/\\/g, ""));
              }
            }
          }

          // Log total found before filtering
          console.log(`Total raw image URLs found: ${allImageUrls.length}`);
          if (allImageUrls.length > 0) {
            console.log(`Sample URLs: ${allImageUrls.slice(0, 3).join(", ")}`);
          }

          const uniqueBases = [...new Set(allImageUrls.map(canonicalizeMuscacheUrl))];
          console.log(`Unique base URLs after deduplication: ${uniqueBases.length}`);

          // More lenient filter - accept muscache or airbnbusercontent
          const filteredUrls = uniqueBases.filter(url => {
            if (!url.includes("muscache.com") && !url.includes("airbnbusercontent.com")) return false;
            // Exclude obvious non-property images
            const excludePatterns = ["favicon", "logo", "icon", "brand", "sprite", "button", "avatar", "profile"];
            if (excludePatterns.some(p => url.toLowerCase().includes(p))) return false;
            return true;
          });
          
          console.log(`Filtered URLs after basic validation: ${filteredUrls.length}`);

          imageUrls = filteredUrls
            .map((base) => base.includes("?") ? base : `${base}?im_w=1200`)
            .slice(0, 5);

          console.log(`Final image URLs for search: ${imageUrls.length}`);
        } else {
          console.log("Firecrawl request failed:", firecrawlResponse.status);
        }
      } catch (e) {
        console.error("Firecrawl error:", e);
      }
    }
    
    // Fallback: direct fetch if Firecrawl didn't work
    if (imageUrls.length === 0 || !airbnbPrice) {
      console.log("Fallback: Direct fetch for Airbnb page...");
      try {
        const airbnbResponse = await fetch(search.airbnb_url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
          },
        });
        
        if (airbnbResponse.ok) {
          const html = await airbnbResponse.text();
          directHtml = html;
          console.log("Fetched Airbnb page directly, length:", html.length);
          
          // Extract title if not already set
          if (!airbnbTitle || airbnbTitle === "Vacation Rental") {
            const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
            if (titleMatch) {
              airbnbTitle = titleMatch[1]
                .replace(" - Airbnb", "")
                .replace(" · Airbnb", "")
                .replace(/\s*-\s*(Houses|Apartments|Homes|Villas|Cabins|Cottages|Condos)?\s*(for Rent|to Rent|zur Miete|in)?\s*.*$/i, "")
                .trim();
            }
          }
          
          // Extract images if not already found
          if (imageUrls.length === 0) {
            const imagePatterns = [
              /https:\/\/a0\.muscache\.com\/im\/pictures\/hosting\/Hosting-[^"'\s\)\]\\<>]+/gi,
              /https:\/\/a0\.muscache\.com\/im\/pictures\/miso\/[^"'\s\)\]\\<>]+/gi,
              /https:\/\/a0\.muscache\.com\/im\/pictures\/BnbProperty\/[^"'\s\)\]\\<>]+/gi,
              /https:\/\/a0\.muscache\.com\/im\/pictures\/prohost-api\/[^"'\s\)\]\\<>]+/gi,
              /https:\/\/a0\.muscache\.com\/im\/pictures\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}[^"'\s\)\]\\<>]*/gi,
              /https:\/\/a0\.muscache\.com\/im\/ml\/[^"'\s\)\]\\<>]+/gi,
              /https:\/\/a[0-9]\.muscache\.com\/im\/pictures\/[^"'\s\)\]\\<>]+/gi,
              /https:\/\/[a-z0-9]+\.muscache\.com\/[^"'\s\)\]\\<>]*pictures[^"'\s\)\]\\<>]+/gi,
              /https:\/\/[a-z0-9-]+\.airbnbusercontent\.com\/[^"'\s\)\]\\<>]+/gi,
            ];

            const canonicalizeMuscacheUrl = (url: string) => {
              let cleaned = url.replace(/\\u002F/g, "/").replace(/\\/g, "");
              cleaned = cleaned.replace(/[,;:]+$/, "");
              return cleaned.split("?")[0];
            };

            let allImageUrls: string[] = [];

            for (const pattern of imagePatterns) {
              const matches = html.match(pattern) || [];
              allImageUrls.push(...matches);
            }

            const jsonMatches = html.match(/"pictureUrl"\s*:\s*"([^"]+)"/g) || [];
            for (const match of jsonMatches) {
              const urlMatch = match.match(/"pictureUrl"\s*:\s*"([^"]+)"/);
              if (urlMatch && urlMatch[1]) {
                allImageUrls.push(urlMatch[1].replace(/\\u002F/g, "/"));
              }
            }

            const uniqueBases = [...new Set(allImageUrls.map(canonicalizeMuscacheUrl))];
            
            // More lenient filter - accept muscache or airbnbusercontent
            const filteredUrls = uniqueBases.filter(url => {
              if (!url.includes("muscache.com") && !url.includes("airbnbusercontent.com")) return false;
              const excludePatterns = ["favicon", "logo", "icon", "brand", "sprite", "button", "avatar", "profile"];
              if (excludePatterns.some(p => url.toLowerCase().includes(p))) return false;
              return true;
            });

            // Also extract from embedded JSON with broader pattern
            const jsonMatches2 = html.match(/"(?:pictureUrl|baseUrl|url)"\s*:\s*"(https:\/\/[^"]+(?:muscache|airbnbusercontent)\.com[^"]+)"/gi) || [];
            for (const match of jsonMatches2) {
              const urlMatch = match.match(/"(?:pictureUrl|baseUrl|url)"\s*:\s*"([^"]+)"/);
              if (urlMatch && urlMatch[1]) {
                const cleanUrl = urlMatch[1].replace(/\\u002F/g, "/").replace(/\\/g, "");
                if (!filteredUrls.includes(cleanUrl)) {
                  filteredUrls.push(cleanUrl);
                }
              }
            }

            imageUrls = filteredUrls
              .map((base) => base.includes("?") ? base : `${base}?im_w=1200`)
              .slice(0, 5);
            
            console.log(`Fallback found ${imageUrls.length} images from direct fetch`);
          }
          
          // Try to extract price from JSON data if not already found
          if (!airbnbPrice) {
            const pricePatterns = [
              /"priceString"\s*:\s*"[€$CHF]\s*(\d+)"/,
              /"price"\s*:\s*(\d+)/,
              /"basePrice"\s*:\s*(\d+)/,
              /"priceForDisplay"\s*:\s*"[€$CHF]?\s*(\d+)/,
            ];
            
            for (const pattern of pricePatterns) {
              const priceMatch = html.match(pattern);
              if (priceMatch) {
                const price = parseInt(priceMatch[1]);
                if (price >= 10 && price <= 5000) {
                  airbnbPrice = price;
                  console.log("Extracted price from direct fetch:", airbnbPrice);
                  break;
                }
              }
            }
          }
          
          console.log(`Direct fetch found ${imageUrls.length} images, price: ${airbnbPrice}`);
        }
      } catch (e) {
        console.error("Error fetching Airbnb page directly:", e);
      }
    }
    
    // CRITICAL: If we still don't have a price, try AI extraction as last resort
    if (!airbnbPrice) {
      await supabase.from("searches").update({ status: "extracting_price_with_ai" }).eq("id", searchId);
      console.log("Attempting AI-based price extraction...");
      
      // Prefer previously scraped content before making another network call
      let contentForAI = "";
      if (firecrawlMarkdown) {
        contentForAI = firecrawlMarkdown;
      } else if (firecrawlHtml) {
        contentForAI = firecrawlHtml;
      } else if (directHtml) {
        contentForAI = directHtml;
      } else if (firecrawlApiKey) {
        try {
          // NOTE: Firecrawl requires waitFor <= timeout/2. Use timeout=30000, waitFor=5000.
          const aiScrapeResponse = await fetch('https://api.firecrawl.dev/v1/scrape', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${firecrawlApiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              url: search.airbnb_url,
              formats: ['markdown'],
              onlyMainContent: true,
              waitFor: 5000,
              timeout: 30000, // Required: waitFor must be <= timeout/2
            }),
          });
          
          if (aiScrapeResponse.ok) {
            const aiData = await aiScrapeResponse.json();
            contentForAI = aiData.data?.markdown || '';
          }
        } catch (e) {
          console.error("Error fetching content for AI:", e);
        }
      }
      
      if (contentForAI) {
        await supabase.from("searches").update({ status: "extracting_price_with_ai" }).eq("id", searchId);
        const nights = calculateNights(checkIn, checkOut);
        const aiResult = await extractAirbnbTotalPriceWithAI(contentForAI, nights);
        airbnbPrice = aiResult.price;
        // Note: currency not tracked in this fallback path
      }
    }

    
    // Log final price status and abort comparison if missing
    if (!airbnbPrice) {
      console.warn("FATAL: Could not extract Airbnb price - aborting comparison");
      const airbnbImageUrl = imageUrls.length > 0 ? imageUrls[0] : null;
      const airbnbImages = imageUrls.slice(0, 5);
      const nights = calculateNights(checkIn, checkOut);

      // Determine specific failure reason
      let errorCode = "airbnb_price_element_missing";
      let errorMessage = "Could not find price information on the Airbnb page";
      
      if (!firecrawlMarkdown && !firecrawlHtml && !directHtml) {
        errorCode = "airbnb_scrape_failed";
        errorMessage = "Failed to load Airbnb page content";
      } else if (firecrawlMarkdown.length < 500 && firecrawlHtml.length < 500) {
        errorCode = "airbnb_blocked";
        errorMessage = "Airbnb may have blocked or limited the request";
      }

      await supabase.from("searches").update({
        status: "price_unavailable",
        airbnb_title: airbnbTitle,
        airbnb_price: null,
        airbnb_image_url: airbnbImageUrl,
        airbnb_images: airbnbImages,
        check_in_date: checkIn,
        check_out_date: checkOut,
        nights_count: nights,
        api_error: errorMessage,
        api_error_code: errorCode,
      }).eq("id", searchId);

      return new Response(
        JSON.stringify({
          success: false,
          error: "AIRBNB_PRICE_UNAVAILABLE",
          message: errorMessage,
          code: errorCode,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    } else {
      console.log("SUCCESS: Airbnb price extracted:", airbnbPrice, "per night");
    }

    // EARLY TERMINATION: If no images found, we can't do visual search - abort early
    if (imageUrls.length === 0) {
      console.warn("FATAL: No property images found - aborting comparison");
      const nights = calculateNights(checkIn, checkOut);

      await supabase.from("searches").update({
        status: "completed",
        airbnb_title: airbnbTitle,
        airbnb_price: airbnbPrice,
        airbnb_image_url: null,
        airbnb_images: [],
        check_in_date: checkIn,
        check_out_date: checkOut,
        nights_count: nights,
      }).eq("id", searchId);

      return new Response(
        JSON.stringify({
          success: true,
          results: [],
          airbnb: {
            title: airbnbTitle,
            price: airbnbPrice,
            url: search.airbnb_url,
            imageUrl: null,
            images: [],
          },
          dates: { checkIn, checkOut, nights },
          message: "Could not extract property images for visual search.",
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Update status to step 2
    await supabase.from("searches").update({ 
      status: "searching_platforms" 
    }).eq("id", searchId);

    // Step 2: Use Google Lens for visual matching (much better than reverse image search)
    // CRITICAL: Track time and AI comparison budget to avoid timeout
    const searchStartTime = Date.now();
    const MAX_SEARCH_TIME_MS = 120000; // 2 minute limit for visual search phase (better coverage)
    const MAX_AI_COMPARISONS = 45; // More AI comparisons to capture more platforms
    const TARGET_VISUAL_MATCHES = 12; // Target more matches before stopping
    let aiComparisonCount = 0;

    const isTimeBudgetExceeded = () => {
      const elapsed = Date.now() - searchStartTime;
      if (elapsed > MAX_SEARCH_TIME_MS) {
        console.log(`TIME BUDGET EXCEEDED: ${elapsed}ms > ${MAX_SEARCH_TIME_MS}ms`);
        return true;
      }
      return false;
    };

    const isAIBudgetExceeded = () => {
      if (aiComparisonCount >= MAX_AI_COMPARISONS) {
        console.log(`AI COMPARISON BUDGET EXCEEDED: ${aiComparisonCount} >= ${MAX_AI_COMPARISONS}`);
        return true;
      }
      return false;
    };

    const hasEnoughMatches = () => {
      const visualCount = alternatives.filter(a => a.match_type === 'visual').length;
      if (visualCount >= TARGET_VISUAL_MATCHES) {
        console.log(`ENOUGH MATCHES FOUND: ${visualCount} >= ${TARGET_VISUAL_MATCHES}`);
        return true;
      }
      return false;
    };

    if (imageUrls.length > 0) {
      console.log("Step 2: Running Google Lens visual matching...");
      console.log(`Budget: ${MAX_AI_COMPARISONS} AI comparisons, ${MAX_SEARCH_TIME_MS}ms time, target ${TARGET_VISUAL_MATCHES} matches`);
      
      // Use up to 5 images for Lens (better recall) but still bounded by budgets
      const lensImages = imageUrls.slice(0, 5);

      for (let idx = 0; idx < lensImages.length; idx++) {
        const imageUrl = lensImages[idx];
        // Check budgets before starting new image
        if (isTimeBudgetExceeded() || hasEnoughMatches()) break;

        // Update status so the UI can show *exactly* what we're doing
        await supabase
          .from("searches")
          .update({ status: `searching_platforms_lens_${idx + 1}_of_${lensImages.length}` })
          .eq("id", searchId);

        try {
          console.log("Google Lens searching:", imageUrl.slice(0, 80));

          // Use Google Lens engine with proper error handling
          const lensResult = await fetchSerpApi(
            `engine=google_lens&url=${encodeURIComponent(imageUrl)}`,
            serpApiKey!
          );

          if (!lensResult.success) {
            console.log("Lens search failed:", lensResult.error?.message || "unknown error");
            // Check for quota/rate limit errors
            if (lensResult.error?.type === 'quota_exceeded' || lensResult.error?.type === 'rate_limited') {
              console.error(`SERPAPI ${lensResult.error.type.toUpperCase()}: ${lensResult.error.message}`);
              await supabase.from("searches").update({ 
                api_error: lensResult.error.message,
                api_error_code: lensResult.error.type,
              }).eq("id", searchId);
              break; // Stop searching if quota exceeded
            }
            continue;
          }

          const lensData = lensResult.data;

          // Log what we got
          console.log(
            "Lens results - visual_matches:",
            lensData.visual_matches?.length || 0,
            "knowledge_graph:",
            lensData.knowledge_graph ? "yes" : "no",
            "text_results:",
            lensData.text_results?.length || 0,
          );

          // Process visual matches - these are the key results with VISUAL CONFIRMATION
          // Prioritize likely booking-platform domains first to spend the AI budget where it matters.
          const visualMatchesRaw = (lensData.visual_matches || []).slice(0, 15);

          const urlPriority = (u: string | null | undefined) => {
            if (!u) return 0;
            const lower = u.toLowerCase();
            if (lower.includes("booking.com")) return 100;
            if (lower.includes("tripadvisor.")) return 95;
            if (isBookingPlatform(u)) return 80;
            if (isRegionalHotelSite(u)) return 70;
            if (isDirectPropertySite(u)) return 60;
            return 0;
          };

          const visualMatches = visualMatchesRaw
            .slice()
            .sort((a: any, b: any) => urlPriority(b.link) - urlPriority(a.link));

          for (const match of visualMatches) {
            // Check budgets before each comparison
            if (isTimeBudgetExceeded() || isAIBudgetExceeded() || hasEnoughMatches()) break;

            const url = match.link;
            if (!url) continue;
            if (url.toLowerCase().includes("airbnb.") || foundUrls.has(url)) continue;

            // Quick filter: only check booking platforms and direct sites, exclude blocked platforms
            if (isBlockedNonBookingPlatform(url)) continue;
            if (!isBookingPlatform(url) && !isRegionalHotelSite(url) && !isDirectPropertySite(url)) {
              continue;
            }
            
            // Validate URL is an actual bookable property page (not category/search page)
            const urlValidation = isValidBookablePropertyUrl(url);
            if (!urlValidation.valid) {
              console.log(`Skipping non-bookable URL: ${urlValidation.reason} - ${url.slice(0, 100)}`);
              continue;
            }

            console.log("Checking visual match:", url.slice(0, 100));

            // Get thumbnail/image URL from the match for AI comparison
            const matchImageUrl = match.thumbnail || match.original || null;

            if (!matchImageUrl) {
              console.log("No image available for AI comparison, skipping:", url.slice(0, 60));
              continue;
            }

            // Use AI to compare images and get similarity score
            // Wrap with timeout to prevent stuck AI comparisons (20s max)
            const platformSlug = getPlatformName(url).toLowerCase().replace(/[^a-z0-9]/g, "_");
            await supabase.from("searches").update({ status: `ai_verifying_${platformSlug}` }).eq("id", searchId);
            console.log(`Running AI comparison ${aiComparisonCount + 1}/${MAX_AI_COMPARISONS}...`);
            aiComparisonCount++;
            
            const AI_COMPARISON_TIMEOUT_MS = 20_000;
            let aiComparison = await withTimeout(
              () => compareImagesWithAI(imageUrl, matchImageUrl),
              AI_COMPARISON_TIMEOUT_MS,
              { score: 0, isMatch: false, explanation: "Timeout" },
              `AI comparison for ${platformSlug}`
            );
            console.log(
              `AI result: score=${aiComparison.score}, isMatch=${aiComparison.isMatch}, reason: ${aiComparison.explanation}`,
            );

            // Some platforms provide tiny/cropped thumbnails -> if we fail, retry with a high-res image from the page.
            if (
              !aiComparison.isMatch &&
              firecrawlApiKey &&
              (url.toLowerCase().includes("booking.com") || url.toLowerCase().includes("tripadvisor.")) &&
              !isAIBudgetExceeded() &&
              !isTimeBudgetExceeded()
            ) {
              console.log("Retrying AI match with scraped high-res image for:", url.slice(0, 80));
              // Wrap image scraping with timeout (15s max)
              const betterImage = await withTimeout(
                () => scrapeBestImageFromListing(url, firecrawlApiKey),
                15_000,
                null,
                `Scrape high-res image from ${platformSlug}`
              );
              if (betterImage) {
                console.log(`Running AI comparison ${aiComparisonCount + 1}/${MAX_AI_COMPARISONS} (hi-res retry)...`);
                aiComparisonCount++;
                aiComparison = await withTimeout(
                  () => compareImagesWithAI(imageUrl, betterImage),
                  AI_COMPARISON_TIMEOUT_MS,
                  { score: 0, isMatch: false, explanation: "Timeout" },
                  `AI comparison retry for ${platformSlug}`
                );
                console.log(
                  `AI retry result: score=${aiComparison.score}, isMatch=${aiComparison.isMatch}, reason: ${aiComparison.explanation}`,
                );

                // If it matches on retry, use the better image for display
                if (aiComparison.isMatch) {
                  match.thumbnail = betterImage;
                }
              }
            }

            // ONLY include matches with ≥90% AI confidence
            if (!aiComparison.isMatch) {
              console.log("AI rejected match (score < 90%):", url.slice(0, 60));
              continue;
            }

            // Store AI-verified confidence score in 0-100 "percent" units (consistent everywhere)
            const verifiedConfidence = aiComparison.score;

            // Check if it's a known booking platform OR regional hotel site (skip blocked platforms)
            if (isBlockedNonBookingPlatform(url)) continue;
            if (isBookingPlatform(url) || isRegionalHotelSite(url)) {
              foundUrls.add(url);
              const resultImages: string[] = [];
              if (match.thumbnail) resultImages.push(match.thumbnail);

              alternatives.push({
                platform_name: getPlatformName(url),
                listing_url: url,
                listing_title: match.title || match.source || null,
                price: null,
                confidence_score: verifiedConfidence, // AI-verified confidence
                image_url: match.thumbnail || null,
                images: resultImages.slice(0, 5),
                match_type: "visual",
                source_airbnb_image: imageUrl, // Store the Airbnb image that matched
              });
              console.log(
                "✓ AI-VERIFIED match on platform:",
                getPlatformName(url),
                "confidence:",
                `${verifiedConfidence.toFixed(0)}%`,
              );
            }
            // Also check for direct property websites
            else if (isDirectPropertySite(url)) {
              foundUrls.add(url);
              const resultImages: string[] = [];
              if (match.thumbnail) resultImages.push(match.thumbnail);

              alternatives.push({
                platform_name: getPlatformName(url) + " (Direct)",
                listing_url: url,
                listing_title: match.title || match.source || null,
                price: null,
                confidence_score: verifiedConfidence, // AI-verified confidence
                image_url: match.thumbnail || null,
                images: resultImages.slice(0, 5),
                match_type: "visual",
                source_airbnb_image: imageUrl, // Store the Airbnb image that matched
              });
              console.log("✓ AI-VERIFIED direct site match:", url.slice(0, 80));
            }
          }

          // Also check knowledge graph for additional context - requires AI verification too
          if (!isTimeBudgetExceeded() && !isAIBudgetExceeded() && !hasEnoughMatches()) {
            if (lensData.knowledge_graph?.source?.link) {
              const kgUrl = lensData.knowledge_graph.source.link;
              const kgImage = lensData.knowledge_graph.thumbnail;

              if (!kgUrl.toLowerCase().includes("airbnb.") && !foundUrls.has(kgUrl) && kgImage) {
                if (isBookingPlatform(kgUrl) || isDirectPropertySite(kgUrl) || isRegionalHotelSite(kgUrl)) {
                  // AI verify knowledge graph match too
                  console.log(`Running AI comparison ${aiComparisonCount + 1}/${MAX_AI_COMPARISONS} (knowledge graph)...`);
                  aiComparisonCount++;
                  const kgComparison = await compareImagesWithAI(imageUrl, kgImage);

                  if (kgComparison.isMatch) {
                    foundUrls.add(kgUrl);
                    alternatives.push({
                      platform_name: getPlatformName(kgUrl),
                      listing_url: kgUrl,
                      listing_title: lensData.knowledge_graph.title || null,
                      price: null,
                      confidence_score: kgComparison.score, // AI-verified (0-100 scale)
                      image_url: kgImage,
                      images: [kgImage],
                      match_type: "visual",
                      source_airbnb_image: imageUrl,
                    });
                    console.log("✓ AI-VERIFIED knowledge graph match:", kgUrl.slice(0, 80));
                  }
                }
              }
            }
          }

          // Small delay between searches to avoid rate limiting
          await new Promise((r) => setTimeout(r, 300));
        } catch (e) {
          console.error("Lens search error:", e);
        }
      }
      // If Lens didn't find enough and we still have budget, try reverse image search as backup
      if (alternatives.length < 3 && !isTimeBudgetExceeded() && !isAIBudgetExceeded()) {
        await supabase.from("searches").update({ status: "reverse_image_search_backup" }).eq("id", searchId);
        console.log("Running reverse image search as backup...");

        for (const imageUrl of imageUrls.slice(0, 2)) {
          // Check budgets before each image
          if (isTimeBudgetExceeded() || isAIBudgetExceeded() || hasEnoughMatches()) break;

          try {
            console.log("Reverse searching:", imageUrl.slice(0, 80));

            const reverseResult = await fetchSerpApi(
              `engine=google_reverse_image&image_url=${encodeURIComponent(imageUrl)}`,
              serpApiKey!,
            );

            if (!reverseResult.success) {
              if (reverseResult.error?.type === "quota_exceeded" || reverseResult.error?.type === "rate_limited") {
                console.error(`SERPAPI ${reverseResult.error.type.toUpperCase()}: ${reverseResult.error.message}`);
                await supabase
                  .from("searches")
                  .update({
                    api_error: reverseResult.error.message,
                    api_error_code: reverseResult.error.type,
                  })
                  .eq("id", searchId);
                break;
              }
              continue;
            }

            const reverseData = reverseResult.data;
            console.log("Reverse results - image:", reverseData?.image_results?.length || 0);

            // LIMIT results to check
            const allResults = [...(reverseData.image_results || []), ...(reverseData.inline_images || []), ...(reverseData.organic_results || [])].slice(0, 8);

            for (const result of allResults) {
              // Check budgets before each comparison
              if (isTimeBudgetExceeded() || isAIBudgetExceeded() || hasEnoughMatches()) break;

              const url = result.link || result.source;
              if (!url) continue;
              if (url.toLowerCase().includes("airbnb.") || foundUrls.has(url)) continue;

              const resultImage = result.thumbnail || result.original;
              if (!resultImage) continue;

              if (isBookingPlatform(url) || isDirectPropertySite(url) || isRegionalHotelSite(url)) {
                // AI verify reverse image match
                console.log(`Running AI comparison ${aiComparisonCount + 1}/${MAX_AI_COMPARISONS} (reverse)...`);
                aiComparisonCount++;
                const reverseComparison = await compareImagesWithAI(imageUrl, resultImage);

                if (!reverseComparison.isMatch) {
                  console.log("AI rejected reverse image match (score < 90%):", url.slice(0, 60));
                  continue;
                }

                foundUrls.add(url);
                alternatives.push({
                  platform_name:
                    isBookingPlatform(url) || isRegionalHotelSite(url)
                      ? getPlatformName(url)
                      : getPlatformName(url) + " (Direct)",
                  listing_url: url,
                  listing_title: result.title || result.snippet || null,
                  price: null,
                  confidence_score: reverseComparison.score, // AI-verified confidence (0-100 scale)
                  image_url: resultImage,
                  images: [result.thumbnail, result.original].filter(Boolean).slice(0, 5),
                  match_type: "visual",
                  source_airbnb_image: imageUrl,
                });
                console.log("✓ AI-VERIFIED reverse image match:", url.slice(0, 80));
              }
            }

            await new Promise((r) => setTimeout(r, 200));
          } catch (e) {
            console.error("Reverse search error:", e);
          }
        }
      }
    }

    console.log(`Search phase complete. AI comparisons used: ${aiComparisonCount}/${MAX_AI_COMPARISONS}, Time: ${Date.now() - searchStartTime}ms`);

    // If no visual matches were found, do a targeted text search on major platforms
    // so we can still surface obvious alternatives (even if not photo-verified).
    const visualMatchCount = alternatives.filter(a => a.match_type === 'visual').length;
    console.log(`Visual search complete: found ${visualMatchCount} AI-verified matches`);

    if (visualMatchCount === 0) {
      console.log("No visual matches found - running targeted text search fallback");

      const location = extractLocationFromTitle(airbnbTitle);
      await addTargetedTextMatches({
        serpApiKey: serpApiKey!,
        title: airbnbTitle,
        cityHint: location.city,
        imageUrlForVerification: imageUrls[0] || null,
        alternatives,
        foundUrls,
      });

      const nights = calculateNights(checkIn, checkOut);
      const airbnbImageUrl = imageUrls.length > 0 ? imageUrls[0] : null;
      const airbnbImages = imageUrls.slice(0, 5);

      // Filter to only results with valid prices before persisting
      const resultsWithValidPrices = alternatives.filter(a => a.price && a.price >= 10);
      
      if (resultsWithValidPrices.length > 0) {
        const { data: insertedResults } = await supabase.from("search_results").insert(
          resultsWithValidPrices.map(r => ({
            search_id: searchId,
            platform_name: r.platform_name,
            listing_url: r.listing_url,
            listing_title: r.listing_title,
            price: r.price,
            original_price: airbnbPrice,
            savings_amount: null,
            savings_percentage: null,
            confidence_score: r.confidence_score,
            image_url: r.image_url,
            images: r.images,
            match_type: r.match_type,
            source_airbnb_image: r.source_airbnb_image || null,
            price_check_in: checkIn,
            price_check_out: checkOut,
            dates_differ: false,
          }))
        ).select();
        
        // Insert into AUTHORITATIVE search_platforms set
        if (insertedResults && insertedResults.length > 0) {
          const platformInserts = insertedResults.map((r: any) => ({
            search_id: searchId,
            platform_name: r.platform_name,
            listing_url: r.listing_url,
            listing_title: r.listing_title,
            image_url: r.image_url,
            images: r.images || [],
            match_type: r.match_type,
            source_airbnb_image: r.source_airbnb_image || null,
          }));
          
          const { error: platformError } = await supabase
            .from("search_platforms")
            .insert(platformInserts);
          
          if (platformError) {
            console.error("[search_platforms] Insert failed (no visual matches path):", platformError.message);
          } else {
            console.log(`[search_platforms] Inserted ${platformInserts.length} platforms (no visual matches path)`);
          }
        }
        
        // Trigger deep link generation for price extraction
        try {
          const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
          const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
          await fetch(`${supabaseUrl}/functions/v1/generate-deep-links`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${supabaseServiceKey}`,
            },
            body: JSON.stringify({ searchId, checkIn, checkOut, adults: 2, children: 0, rooms: 1 }),
          });
          console.log("Triggered generate-deep-links for price extraction");
        } catch (deepLinkError) {
          console.error("Error triggering deep links:", deepLinkError);
        }
      }

      // ATOMIC FINALIZATION: Set snapshot + finalised_at + status='completed' in ONE call
      // This ensures the invariant: status='completed' ONLY when snapshot exists
      const finalizationResult = await finalizeAndCompleteSearch({
        supabase,
        searchId,
        airbnbTitle,
        airbnbPrice,
        airbnbCurrency: search.airbnb_currency || 'USD',
        airbnbImageUrl,
        airbnbImages,
        checkIn,
        checkOut,
        nights,
      });

      if (!finalizationResult.success && !finalizationResult.alreadyFinalized) {
        console.error(`[search-alternatives] Finalization failed: ${finalizationResult.error}`);
        // Status is already set to 'finalization_failed' by the helper
        return new Response(
          JSON.stringify({
            success: false,
            error: `Finalization failed: ${finalizationResult.error}`,
            finalization_failed: true,
          }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      console.log(`[search-alternatives] Finalized search ${searchId} with ${finalizationResult.resultCount} results`);

      return new Response(
        JSON.stringify({
          success: true,
          results: alternatives,
          airbnb: {
            title: airbnbTitle,
            price: airbnbPrice,
            url: search.airbnb_url,
            imageUrl: airbnbImageUrl,
            images: airbnbImages,
          },
          dates: { checkIn, checkOut, nights },
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Update status to step 3
    await supabase.from("searches").update({ 
      status: "comparing_prices" 
    }).eq("id", searchId);

    // Step 3: Multi-strategy text search if we still need more results (only if we have some visual matches)
    if (alternatives.length < 5) {
      console.log("Step 3: Multi-strategy text search...");
      
      // Extract location info for better searches
      const location = extractLocationFromTitle(airbnbTitle);
      console.log("Extracted location:", location);
      
      // Clean up the title for searches
      const cleanTitle = airbnbTitle
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      
      // Multiple search strategies - expanded for better coverage
      const searchStrategies = [
        // Strategy 1: Exact property name + booking sites (including HolidayCheck explicitly)
        `"${cleanTitle.slice(0, 40)}" (booking.com OR tripadvisor OR holidaycheck OR agoda OR hrs) -airbnb`,
        // Strategy 2: Property name + location with broader hotel/guesthouse terms
        location.city ? `"${cleanTitle.slice(0, 30)}" ${location.city} (hotel OR guesthouse OR pension) -airbnb` : null,
        // Strategy 3: Site-specific searches for key platforms
        `${cleanTitle.slice(0, 30)} site:holidaycheck.de OR site:holidaycheck.com`,
        `${cleanTitle.slice(0, 30)} site:tripadvisor.com OR site:tripadvisor.ch OR site:tripadvisor.de`,
        // Strategy 4: Location + property type for regional sites
        location.city ? `${location.city} "${cleanTitle.slice(0, 25)}" (reviews OR booking) -airbnb -pinterest` : null,
        // Strategy 5: Direct site search across multiple platforms
        location.city ? `${cleanTitle.slice(0, 20)} ${location.city} site:booking.com OR site:hrs.de OR site:hotel.de` : null,
      ].filter(Boolean) as string[];
      
      for (const searchQuery of searchStrategies) {
        if (alternatives.length >= 10) break; // Stop if we have enough
        
        console.log("Text search:", searchQuery);
        
        try {
          const textResult = await fetchSerpApi(
            `engine=google&q=${encodeURIComponent(searchQuery)}&num=20`,
            serpApiKey!
          );
          
          if (!textResult.success) {
            if (textResult.error?.type === 'quota_exceeded' || textResult.error?.type === 'rate_limited') {
              console.error(`SERPAPI ${textResult.error.type.toUpperCase()}: ${textResult.error.message}`);
              await supabase.from("searches").update({ 
                api_error: textResult.error.message,
                api_error_code: textResult.error.type,
              }).eq("id", searchId);
              break;
            }
            continue;
          }
          
          const textData = textResult.data;
          const results = textData?.organic_results || [];
          
          for (const result of results) {
            const url = result.link;
            if (!url || url.toLowerCase().includes("airbnb.") || foundUrls.has(url)) continue;
            if (isBlockedNonBookingPlatform(url)) continue;
            
            if (isBookingPlatform(url) || isRegionalHotelSite(url)) {
              foundUrls.add(url);
              alternatives.push({
                platform_name: getPlatformName(url),
                listing_url: url,
                listing_title: result.title || null,
                price: null,
                confidence_score: null, // TEXT MATCH = NO VISUAL CONFIRMATION = NO TRUST SCORE
                image_url: result.thumbnail || null,
                images: result.thumbnail ? [result.thumbnail] : [],
                match_type: 'text',
              });
              console.log("Text match found (no visual confirmation):", getPlatformName(url));
            } else if (isDirectPropertySite(url)) {
              foundUrls.add(url);
              alternatives.push({
                platform_name: getPlatformName(url) + " (Direct)",
                listing_url: url,
                listing_title: result.title || null,
                price: null,
                confidence_score: null, // TEXT MATCH = NO VISUAL CONFIRMATION = NO TRUST SCORE
                image_url: result.thumbnail || null,
                images: result.thumbnail ? [result.thumbnail] : [],
                match_type: 'text',
              });
              console.log("Direct site text match (no visual confirmation):", url.slice(0, 80));
            }
          }
          
          await new Promise(r => setTimeout(r, 300));
        } catch (e) {
          console.error("Text search error:", e);
        }
      }
    }

    console.log(`Total alternatives found: ${alternatives.length}`);

    // Sort by confidence (visual matches first, then by score) and limit results
    // Visual matches with high confidence come first, text matches (null confidence) come last
    alternatives.sort((a, b) => {
      // Visual matches always before text matches
      if (a.match_type === 'visual' && b.match_type === 'text') return -1;
      if (a.match_type === 'text' && b.match_type === 'visual') return 1;
      // Within same type, sort by confidence (null = lowest)
      const scoreA = a.confidence_score ?? 0;
      const scoreB = b.confidence_score ?? 0;
      return scoreB - scoreA;
    });
    const topAlternatives = alternatives.slice(0, 10);

    // Use filtered property images (no logos)
    const airbnbImageUrl = imageUrls.length > 0 ? imageUrls[0] : null;
    const airbnbImages = imageUrls.slice(0, 5);

    console.log("Results breakdown - Visual matches:", alternatives.filter(a => a.match_type === 'visual').length,
                "Text matches:", alternatives.filter(a => a.match_type === 'text').length);

    // nights is already calculated above (line 3054)
    console.log(`Comparing prices for ${nights} nights: ${checkIn} to ${checkOut}`);

    // Step 4: Scrape prices from alternatives using Firecrawl (if available)
    // IMPORTANT: Store ALL visual matches - prices are optional, not required for display
    let resultsWithPriceAttempts: Array<typeof topAlternatives[0] & { 
      price_check_in?: string; 
      price_check_out?: string; 
      dates_differ?: boolean;
    }> = [];
    
    if (firecrawlApiKey && topAlternatives.length > 0) {
      await supabase.from("searches").update({ status: "comparing_prices" }).eq("id", searchId);
      console.log("Step 4: Scraping prices from alternatives...");

      // Prioritize Booking.com + TripAdvisor if present.
      const prioritized = [...topAlternatives].sort((a, b) => {
        const score = (p: string) => {
          const l = p.toLowerCase();
          if (l.includes("booking")) return 2;
          if (l.includes("tripadvisor")) return 2;
          return 0;
        };
        return score(b.platform_name) - score(a.platform_name);
      });

      const toScrape = prioritized.slice(0, 10); // Scrape more to increase chance of getting prices

      // Per-platform timeout: 25 seconds max per price scrape to prevent stuck searches
      const PRICE_SCRAPE_TIMEOUT_MS = 25_000;
      
      // Respect skip requests (manual/auto) while scraping prices
      async function shouldSkipPriceStep(): Promise<boolean> {
        const { data } = await supabase
          .from("searches")
          .select("status")
          .eq("id", searchId)
          .single();
        return data?.status === "skip_current_step";
      }

      for (let i = 0; i < toScrape.length; i++) {
        // Check if user requested to skip before starting this platform
        const skipRequested = await shouldSkipPriceStep();
        if (skipRequested) {
          console.log(`SKIP requested by user - skipping remaining ${toScrape.length - i} price scrapes`);
          // Reset status and break out of loop
          await supabase.from("searches").update({ status: "comparing_prices" }).eq("id", searchId);
          break;
        }
        
        const alt = toScrape[i];
        const platformSlug = alt.platform_name.toLowerCase().replace(/[^a-z0-9]/g, "_");
        await supabase.from("searches").update({
          status: `scraping_price_${platformSlug}_${i + 1}_of_${toScrape.length}`
        }).eq("id", searchId);
        console.log(`Scraping price ${i + 1}/${toScrape.length} from ${alt.platform_name}...`);

        // Wrap price scraping with timeout to prevent stuck searches
        const fallbackPriceData = {
          price: null,
          totalPrice: null,
          perNightRate: null,
          usedCheckIn: checkIn,
          usedCheckOut: checkOut,
          datesDiffer: false,
        };
        
        const priceData = await withTimeout(
          () => scrapePriceFromListing(alt.listing_url, checkIn, checkOut, firecrawlApiKey),
          PRICE_SCRAPE_TIMEOUT_MS,
          fallbackPriceData,
          `Price scrape for ${alt.platform_name}`
        );
        
        // Store ALL results - price is optional (null is OK)
        const hasValidPrice = priceData.perNightRate && priceData.perNightRate >= 10;
        if (hasValidPrice) {
          console.log(`✓ Valid price found: €${priceData.perNightRate}/night for ${alt.platform_name}`);
        } else {
          console.log(`○ No price extracted for ${alt.platform_name} - will still store match`);
        }
        
        resultsWithPriceAttempts.push({
          ...alt,
          price: hasValidPrice ? priceData.perNightRate : null,
          total_price: hasValidPrice ? priceData.totalPrice : null,
          per_night_rate: hasValidPrice ? priceData.perNightRate : null,
          price_check_in: priceData.usedCheckIn || checkIn,
          price_check_out: priceData.usedCheckOut || checkOut,
          dates_differ: priceData.datesDiffer || false,
        });
      }
      
      const withPrices = resultsWithPriceAttempts.filter(r => r.price && r.price >= 10).length;
      console.log(`Price scraping complete. ${withPrices}/${toScrape.length} listings have valid prices.`);
    } else if (topAlternatives.length > 0) {
      // No Firecrawl API key - store all matches without prices
      console.log("No Firecrawl API key available - storing visual matches without prices");
      resultsWithPriceAttempts = topAlternatives.map(alt => ({
        ...alt,
        price_check_in: checkIn,
        price_check_out: checkOut,
        dates_differ: false,
      }));
    }

    // Calculate savings based on Airbnb price
    const resultsWithSavings = resultsWithPriceAttempts.map(alt => {
      let savingsAmount: number | null = null;
      let savingsPercentage: number | null = null;
      
      if (airbnbPrice && alt.price && alt.price < airbnbPrice) {
        savingsAmount = airbnbPrice - alt.price;
        savingsPercentage = Math.round((savingsAmount / airbnbPrice) * 100);
      }
      
      return {
        ...alt,
        original_price: airbnbPrice,
        savings_amount: savingsAmount,
        savings_percentage: savingsPercentage,
      };
    });

    // Sort by savings (best deals first), then by confidence
    resultsWithSavings.sort((a, b) => {
      // First, prioritize results with actual savings
      const savingsA = a.savings_percentage ?? 0;
      const savingsB = b.savings_percentage ?? 0;
      if (savingsA !== savingsB) return savingsB - savingsA;
      
      // Then by match type (visual first)
      if (a.match_type === 'visual' && b.match_type === 'text') return -1;
      if (a.match_type === 'text' && b.match_type === 'visual') return 1;
      
      // Finally by confidence
      const scoreA = a.confidence_score ?? 0;
      const scoreB = b.confidence_score ?? 0;
      return scoreB - scoreA;
    });

    if (resultsWithSavings.length > 0) {
      console.log(`Storing ${resultsWithSavings.length} results with valid prices`);
      const { data: insertedResults } = await supabase.from("search_results").insert(
        resultsWithSavings.map(r => ({
          search_id: searchId,
          platform_name: r.platform_name,
          listing_url: r.listing_url,
          listing_title: r.listing_title,
          price: r.price,
          original_price: r.original_price,
          savings_amount: r.savings_amount,
          savings_percentage: r.savings_percentage,
          confidence_score: r.confidence_score,
          image_url: r.image_url,
          images: r.images,
          match_type: r.match_type,
          source_airbnb_image: r.source_airbnb_image || null,
          price_check_in: r.price_check_in || checkIn,
          price_check_out: r.price_check_out || checkOut,
          dates_differ: r.dates_differ || false,
        }))
      ).select();
      
      // Insert into AUTHORITATIVE search_platforms set
      if (insertedResults && insertedResults.length > 0) {
        const platformInserts = insertedResults.map((r: any) => ({
          search_id: searchId,
          platform_name: r.platform_name,
          listing_url: r.listing_url,
          listing_title: r.listing_title,
          image_url: r.image_url,
          images: r.images || [],
          match_type: r.match_type,
          source_airbnb_image: r.source_airbnb_image || null,
        }));
        
        const { error: platformError } = await supabase
          .from("search_platforms")
          .insert(platformInserts);
        
        if (platformError) {
          console.error("[search_platforms] Insert failed (legacy path):", platformError.message);
        } else {
          console.log(`[search_platforms] Inserted ${platformInserts.length} platforms (legacy path)`);
        }
      }
      
      // Trigger deep link generation for price extraction
      try {
        const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
        const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
        await fetch(`${supabaseUrl}/functions/v1/generate-deep-links`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${supabaseServiceKey}`,
          },
          body: JSON.stringify({ searchId, checkIn, checkOut, adults: 2, children: 0, rooms: 1 }),
        });
        console.log("Triggered generate-deep-links for price extraction (legacy path)");
      } catch (deepLinkError) {
        console.error("Error triggering deep links:", deepLinkError);
      }
    } else {
      console.log("No results with valid prices to store");
    }

    // ATOMIC FINALIZATION: Set snapshot + finalised_at + status='completed' in ONE call
    // This ensures the invariant: status='completed' ONLY when snapshot exists
    const finalizationResult = await finalizeAndCompleteSearch({
      supabase,
      searchId,
      airbnbTitle,
      airbnbPrice,
      airbnbCurrency: search.airbnb_currency || 'USD',
      airbnbImageUrl,
      airbnbImages,
      checkIn,
      checkOut,
      nights,
    });

    if (!finalizationResult.success && !finalizationResult.alreadyFinalized) {
      console.error(`[search-alternatives] Finalization failed: ${finalizationResult.error}`);
      // Status is already set to 'finalization_failed' by the helper
      return new Response(
        JSON.stringify({
          success: false,
          error: `Finalization failed: ${finalizationResult.error}`,
          finalization_failed: true,
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[search-alternatives] Finalized search ${searchId} with ${finalizationResult.resultCount} results`);

    return new Response(
      JSON.stringify({ 
        success: true, 
        results: resultsWithSavings,
        airbnb: { 
          title: airbnbTitle, 
          price: airbnbPrice, 
          url: search.airbnb_url, 
          imageUrl: airbnbImageUrl, 
          images: airbnbImages 
        },
        dates: { checkIn, checkOut, nights }
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Search error:", error);
    return new Response(
      JSON.stringify({ error: "An error occurred processing your request. Please try again." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
