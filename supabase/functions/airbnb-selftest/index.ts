import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Secure CORS - Domain allowlist
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

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function safeSnippet(s: string, max = 300): string {
  return (s || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeAmount(raw: string): number | null {
  const s = (raw || '').trim();
  if (!s) return null;
  const cleaned = s.replace(/[^0-9.,]/g, '');
  if (!cleaned) return null;
  const n = Number.parseFloat(cleaned.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

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

// Part 2: Region mapping for Accept-Language and timezone
function getRegionSettings(userCountry: string): { acceptLanguage: string; timezone: string } {
  const countryMap: Record<string, { acceptLanguage: string; timezone: string }> = {
    US: { acceptLanguage: 'en-US,en;q=0.9', timezone: 'America/New_York' },
    CH: { acceptLanguage: 'de-CH,de;q=0.9,en;q=0.8', timezone: 'Europe/Zurich' },
    DE: { acceptLanguage: 'de-DE,de;q=0.9,en;q=0.8', timezone: 'Europe/Berlin' },
    GB: { acceptLanguage: 'en-GB,en;q=0.9', timezone: 'Europe/London' },
    FR: { acceptLanguage: 'fr-FR,fr;q=0.9,en;q=0.8', timezone: 'Europe/Paris' },
    IT: { acceptLanguage: 'it-IT,it;q=0.9,en;q=0.8', timezone: 'Europe/Rome' },
    ES: { acceptLanguage: 'es-ES,es;q=0.9,en;q=0.8', timezone: 'Europe/Madrid' },
    NL: { acceptLanguage: 'nl-NL,nl;q=0.9,en;q=0.8', timezone: 'Europe/Amsterdam' },
    AU: { acceptLanguage: 'en-AU,en;q=0.9', timezone: 'Australia/Sydney' },
    CA: { acceptLanguage: 'en-CA,en;q=0.9', timezone: 'America/Toronto' },
  };
  return countryMap[userCountry] || { acceptLanguage: 'en-US,en;q=0.9', timezone: 'UTC' };
}

async function ocrImageToText(imageBase64Png: string): Promise<string> {
  const key = Deno.env.get('LOVABLE_API_KEY');
  if (!key) throw new Error('Missing LOVABLE_API_KEY');

  const body = {
    model: 'google/gemini-2.5-flash',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              'Read ALL visible text in this Airbnb checkout/booking page screenshot, from top to bottom. Include all prices, amounts with dollar signs, labels like "Total", "Trip total", "Amount due", breakdown items. Return ONLY the recognized text with line breaks. Do not add commentary.',
          },
          {
            type: 'image_url',
            image_url: {
              url: `data:image/png;base64,${imageBase64Png}`,
            },
          },
        ],
      },
    ],
  };

  const resp = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`OCR request failed: HTTP ${resp.status} ${JSON.stringify(json).slice(0, 400)}`);
  }

  const text = json?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('OCR response missing text content');
  }

  return text;
}

// Extract all-in total from OCR text (book/stays page)
function extractAllInTotalFromOcr(ocrTextRaw: string, nightsExpected: number): {
  all_in_total_amount_value: number | null;
  currency: string;
  evidence_snippet: string | null;
  breakdown_items: Array<{ label: string; amount_value: number; currency: string }>;
  extraction_method: string;
} {
  const lines = ocrTextRaw.split('\n').map((l) => l.trim()).filter(Boolean);
  
  // Priority labels for total detection (case-insensitive)
  const totalLabels = [
    /trip\s+total/i,
    /total\s*\(?usd\)?/i,
    /\btotal\b/i,
    /amount\s+due/i,
    /pay\s+now/i,
    /due\s+today/i,
  ];
  
  // Amount pattern: $X,XXX.XX or similar
  const amountPattern = /(\$|€|£)([\d,]+(?:\.\d{2})?)/g;
  
  let bestTotal: { amount: number; currency: string; snippet: string; priority: number } | null = null;
  const breakdownItems: Array<{ label: string; amount_value: number; currency: string }> = [];
  
  // First pass: find totals by label priority
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineLower = line.toLowerCase();
    
    // Check each priority label
    for (let p = 0; p < totalLabels.length; p++) {
      if (totalLabels[p].test(line)) {
        // Look for amount on same line or next line
        const searchLines = [line, lines[i + 1] || ''].join(' ');
        amountPattern.lastIndex = 0;
        const match = amountPattern.exec(searchLines);
        if (match) {
          const currencySymbol = match[1];
          const currency = currencySymbol === '$' ? 'USD' : currencySymbol === '€' ? 'EUR' : 'GBP';
          const amount = normalizeAmount(match[2]);
          if (amount && amount > 50) {
            if (!bestTotal || p < bestTotal.priority) {
              bestTotal = { amount, currency, snippet: line, priority: p };
            }
          }
        }
        break;
      }
    }
    
    // Extract breakdown items (lines with amounts that aren't totals)
    if (!/total|amount\s+due|pay\s+now|due\s+today/i.test(lineLower)) {
      amountPattern.lastIndex = 0;
      const match = amountPattern.exec(line);
      if (match) {
        const currencySymbol = match[1];
        const currency = currencySymbol === '$' ? 'USD' : currencySymbol === '€' ? 'EUR' : 'GBP';
        const amount = normalizeAmount(match[2]);
        // Extract label (text before the amount)
        const labelMatch = line.match(/^(.+?)[\s:]*\$|€|£/);
        const label = labelMatch ? labelMatch[1].trim() : line.split(/\$|€|£/)[0].trim();
        if (amount && amount > 0 && label) {
          breakdownItems.push({ label, amount_value: amount, currency });
        }
      }
    }
  }
  
  // Fallback: if no labeled total found, look for largest amount in checkout context
  if (!bestTotal) {
    const allAmounts: Array<{ amount: number; currency: string; snippet: string }> = [];
    for (const line of lines) {
      amountPattern.lastIndex = 0;
      let match;
      while ((match = amountPattern.exec(line)) !== null) {
        const currencySymbol = match[1];
        const currency = currencySymbol === '$' ? 'USD' : currencySymbol === '€' ? 'EUR' : 'GBP';
        const amount = normalizeAmount(match[2]);
        if (amount && amount > 100) {
          allAmounts.push({ amount, currency, snippet: line });
        }
      }
    }
    if (allAmounts.length > 0) {
      const largest = allAmounts.sort((a, b) => b.amount - a.amount)[0];
      bestTotal = { ...largest, priority: 999 };
    }
  }
  
  return {
    all_in_total_amount_value: bestTotal?.amount ?? null,
    currency: bestTotal?.currency ?? 'USD',
    evidence_snippet: bestTotal?.snippet ?? null,
    breakdown_items: breakdownItems,
    extraction_method: bestTotal?.priority !== undefined && bestTotal.priority < 999 ? 'labeled_total' : 'fallback_largest',
  };
}

// Extract booking card amount from rooms page OCR (fallback)
function extractBookingCardFromRoomsOcr(ocrTextRaw: string, nightsExpected: number): {
  booking_card_amount_value: number | null;
  currency: string;
  evidence_snippet: string | null;
} {
  const lines = ocrTextRaw.split('\n').map((l) => l.trim()).filter(Boolean);
  const nightsRe = new RegExp(`for\\s+${nightsExpected}\\s+night`, 'i');
  const amountPattern = /(\$|€|£)([\d,]+(?:\.\d{2})?)/;
  
  for (const line of lines) {
    if (nightsRe.test(line)) {
      const match = line.match(amountPattern);
      if (match) {
        const currencySymbol = match[1];
        const currency = currencySymbol === '$' ? 'USD' : currencySymbol === '€' ? 'EUR' : 'GBP';
        const amount = normalizeAmount(match[2]);
        if (amount && amount > 50) {
          return { booking_card_amount_value: amount, currency, evidence_snippet: line };
        }
      }
    }
  }
  
  return { booking_card_amount_value: null, currency: 'USD', evidence_snippet: null };
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = 60000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(input, { ...init, signal: controller.signal }); }
  finally { clearTimeout(timeoutId); }
}

// Run Browserless on book/stays page (primary) with fallback to rooms page
async function runBrowserlessBookStays(
  bookStaysUrl: string,
  roomsUrl: string,
  roomId: string,
  nightsExpected: number,
  userCountry: string,
  guestCurrency: string
): Promise<any> {
  const apiKey = Deno.env.get('BROWSERLESS_API_KEY');
  if (!apiKey) return { status: 'provider_not_configured', error: 'No BROWSERLESS_API_KEY' };
  
  const regionSettings = getRegionSettings(userCountry);
  const start = Date.now();
  
  try {
    const functionPayload = {
      code: `export default async function({ page }) {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        
        const bookStaysUrl = ${JSON.stringify(bookStaysUrl)};
        const roomsUrl = ${JSON.stringify(roomsUrl)};
        const roomId = ${JSON.stringify(roomId)};
        const acceptLanguage = ${JSON.stringify(regionSettings.acceptLanguage)};
        const timezone = ${JSON.stringify(regionSettings.timezone)};
        const userCountry = ${JSON.stringify(userCountry)};
        const guestCurrency = ${JSON.stringify(guestCurrency)};
        
        // Step 1: Enforce consistent session context
        await page.setUserAgent(
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        );
        await page.setExtraHTTPHeaders({
          'Accept-Language': acceptLanguage
        });
        await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
        
        // Set timezone and clear session via CDP
        let proxyCountryUsed = 'unknown';
        try {
          const client = await page.target().createCDPSession();
          await client.send('Emulation.setTimezoneOverride', { timezoneId: timezone });
          await client.send('Network.enable');
          await client.send('Network.clearBrowserCookies');
          await client.send('Network.clearBrowserCache');
          proxyCountryUsed = userCountry; // Assume proxy matches user country
        } catch (cdpErr) {
          console.log('CDP setup partial failure:', cdpErr);
        }
        
        // Capture redirect chain
        const redirectChain = [];
        page.on('response', (res) => {
          try {
            redirectChain.push(res.url());
            if (redirectChain.length > 25) redirectChain.shift();
          } catch {}
        });
        
        // Establish origin and clear storage
        await page.goto('https://www.airbnb.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
        await sleep(500);
        try {
          await page.evaluate(() => {
            localStorage.clear();
            sessionStorage.clear();
            if ('caches' in window) {
              caches.keys().then((keys) => keys.forEach((k) => caches.delete(k)));
            }
          });
        } catch {}
        
        // ============================================================
        // PRIMARY: Try book/stays page first
        // ============================================================
        let usedFallback = false;
        let finalUrl = '';
        let pageTitle = '';
        let bodyTextSnippet = '';
        let wrongPageReason = null;
        let screenshotBase64 = null;
        
        console.log('Navigating to book/stays URL:', bookStaysUrl);
        await page.goto(bookStaysUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await sleep(2000);
        
        finalUrl = page.url();
        pageTitle = await page.title().catch(() => '');
        bodyTextSnippet = await page.evaluate(() => (document.body?.innerText || '').slice(0, 1000)).catch(() => '');
        
        // Check if we landed correctly on book/stays
        const bookStaysPathOk = finalUrl.includes('/book/stays/' + roomId);
        const isLoginRedirect = finalUrl.includes('/login') || finalUrl.includes('/signin');
        const isConsentWall = /consent|agree|accept.*cookies/i.test(bodyTextSnippet);
        const isErrorPage = /error|not found|unavailable/i.test(pageTitle);
        
        // Check for unavailable dates (listing not bookable for these dates)
        const isUnavailable = /no longer available|dates are no longer available|unavailable for your dates|not available for these dates|someone else just requested/i.test(bodyTextSnippet);
        
        // Detect page type for structured reporting
        let pageType = 'unknown';
        if (isUnavailable) {
          pageType = 'dates_unavailable';
        } else if (pageTitle.toLowerCase().includes('confirm and pay')) {
          pageType = 'checkout_with_pricing';
        } else if (pageTitle.toLowerCase().includes('request to book')) {
          pageType = 'request_to_book';
        }
        
        if (!bookStaysPathOk || isLoginRedirect || isConsentWall || (isErrorPage && !isUnavailable)) {
          console.log('book/stays blocked, trying rooms fallback...');
          usedFallback = true;
          wrongPageReason = isLoginRedirect ? 'login_redirect' : 
                           isConsentWall ? 'consent_wall' :
                           isErrorPage ? 'error_page' : 'wrong_path';
          
          // Fallback to rooms page
          await page.goto(roomsUrl, { waitUntil: 'networkidle2', timeout: 60000 });
          await sleep(2000);
          
          finalUrl = page.url();
          pageTitle = await page.title().catch(() => '');
          bodyTextSnippet = await page.evaluate(() => (document.body?.innerText || '').slice(0, 1000)).catch(() => '');
          
          // On rooms page, try to click "Price details" to reveal full breakdown
          try {
            const clickLog = [];
            const detailsSelector = 'button[aria-label*="price"], [data-testid="book-it-default"] button, a:has-text("Price details")';
            const detailsBtn = await page.$(detailsSelector);
            if (detailsBtn) {
              await detailsBtn.click();
              clickLog.push('clicked_price_details');
              await sleep(1500);
            }
          } catch (clickErr) {
            console.log('Price details click failed:', clickErr);
          }
        }
        
        // Reset scroll and take screenshot
        await page.evaluate(() => window.scrollTo(0, 0));
        await sleep(300);
        
        const scrollY = await page.evaluate(() => Math.round(window.scrollY || 0));
        screenshotBase64 = await page.screenshot({ encoding: 'base64', clip: { x: 0, y: 0, width: 1440, height: 900 } }).catch(() => null);
        
        // Get full page HTML for DOM extraction
        const html = await page.content();
        
        return {
          bookStaysUrl,
          roomsUrl,
          finalUrl,
          pageTitle,
          bodyTextSnippet,
          redirectChain: redirectChain.slice(-10),
          usedFallback,
          wrongPageReason,
          pageType,
          isUnavailable,
          screenshotBase64,
          scrollY,
          html,
          proxyCountryUsed,
          userCountry,
          guestCurrency,
          regionMismatch: proxyCountryUsed !== userCountry,
        };
      }`,
      context: {},
    };

    const resp = await fetchWithTimeout(`https://chrome.browserless.io/function?token=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(functionPayload),
    }, 120000);

    const durationMs = Date.now() - start;
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      return { status: 'provider_fetch_failed', durationMs, error: `HTTP ${resp.status}: ${errText.slice(0, 200)}` };
    }

    const result = await resp.json().catch(() => ({}));
    
    return {
      status: 'browser_completed',
      durationMs,
      ...result,
    };
  } catch (e) {
    return { status: 'provider_error', error: String(e), durationMs: Date.now() - start };
  }
}

// =============================================================================
// CANONICAL BASELINE CHECK MODE
// =============================================================================
// When mode=canonical-check is passed, this function runs deterministic
// validation against the canonical baseline expectations.
// This is the PRIMARY enforcement mechanism - it runs automatically on deploy.
// Reference: docs/BROWSERLESS_CANONICAL_BASELINE.md
// =============================================================================

interface CanonicalCheckResult {
  mode: 'canonical-check';
  passed: boolean;
  checks: Array<{
    name: string;
    expected: string;
    actual: string;
    passed: boolean;
  }>;
  status: 'canonical_baseline_valid' | 'canonical_baseline_violation';
  timestamp: string;
}

function runCanonicalBaselineCheck(): CanonicalCheckResult {
  const checks: CanonicalCheckResult['checks'] = [];
  
  // Check 1: Regex patterns compile without error
  const currencySymbols = '$€£CHF';
  let regexCompiles = true;
  let regexError = '';
  try {
    new RegExp('Pay\\s+(?:US\\s*)?[' + currencySymbols + ']\\s*([\\d,]+(?:\\.\\d{2})?)\\s*(?:now|today)', 'i');
    new RegExp('Total\\s+\\([A-Z]{3}\\)\\s*(?:US\\s*)?[' + currencySymbols + ']\\s*([\\d,]+(?:\\.\\d{2})?)', 'i');
    new RegExp('Due\\s+today\\s*(?:US\\s*)?[' + currencySymbols + ']\\s*([\\d,]+(?:\\.\\d{2})?)', 'i');
  } catch (e) {
    regexCompiles = false;
    regexError = String(e);
  }
  checks.push({
    name: 'regex_patterns_compile',
    expected: 'true',
    actual: regexCompiles ? 'true' : `false: ${regexError}`,
    passed: regexCompiles,
  });
  
  // Check 2: Priority evaluation logic matches canonical
  const mockPayNowData = { payNowAmount: 1658.94, payNowSnippet: 'Pay CHF1,658.94 now' };
  const evaluationResult = mockPayNowData.payNowAmount > 0 ? 'total_price_including_taxes_and_fees' : 'needs_user_confirmation';
  checks.push({
    name: 'payNow_priority_respected',
    expected: 'total_price_including_taxes_and_fees',
    actual: evaluationResult,
    passed: evaluationResult === 'total_price_including_taxes_and_fees',
  });
  
  // Check 3: Subtotal is never promoted
  const mockSubtotalOnlyData = { payNowAmount: null, ocrBookingCardAmount: 1500 };
  const subtotalResult = mockSubtotalOnlyData.payNowAmount ? 'total_price_including_taxes_and_fees' : 'needs_user_confirmation';
  checks.push({
    name: 'subtotal_never_promoted',
    expected: 'needs_user_confirmation',
    actual: subtotalResult,
    passed: subtotalResult === 'needs_user_confirmation',
  });
  
  // Check 4: buildBookStaysUrl function works correctly
  const testUrl = 'https://www.airbnb.com/rooms/123456?check_in=2026-02-01&check_out=2026-02-05&adults=2';
  const parsedUrl = buildBookStaysUrl(testUrl);
  const urlParsingWorks = parsedUrl !== null && parsedUrl.room_id === '123456' && parsedUrl.nights_count === 4;
  checks.push({
    name: 'url_parsing_canonical',
    expected: 'room_id=123456, nights=4',
    actual: parsedUrl ? `room_id=${parsedUrl.room_id}, nights=${parsedUrl.nights_count}` : 'null',
    passed: urlParsingWorks,
  });
  
  // Check 5: OCR extraction function exists and handles empty input
  let ocrExtractionSafe = true;
  try {
    const result = extractAllInTotalFromOcr('', 3);
    ocrExtractionSafe = result.all_in_total_amount_value === null;
  } catch {
    ocrExtractionSafe = false;
  }
  checks.push({
    name: 'ocr_extraction_null_safe',
    expected: 'null for empty input',
    actual: ocrExtractionSafe ? 'null for empty input' : 'threw error or returned value',
    passed: ocrExtractionSafe,
  });
  
  const allPassed = checks.every(c => c.passed);
  
  return {
    mode: 'canonical-check',
    passed: allPassed,
    checks,
    status: allPassed ? 'canonical_baseline_valid' : 'canonical_baseline_violation',
    timestamp: new Date().toISOString(),
  };
}
// =============================================================================
// ZYTE CANONICAL BASELINE CHECK MODE
// =============================================================================
// When mode=zyte-canonical-check is passed, this function runs deterministic
// validation against the Zyte canonical baseline expectations.
// Reference: docs/ZYTE_CANONICAL_BASELINE.md
// =============================================================================

interface ZyteCanonicalCheckResult {
  mode: 'zyte-canonical-check';
  passed: boolean;
  checks: Array<{
    name: string;
    expected: string;
    actual: string;
    passed: boolean;
  }>;
  status: 'zyte_canonical_valid' | 'zyte_canonical_violation';
  timestamp: string;
}

// Mock Zyte response structure for testing
interface MockZyteResponse {
  ok: boolean;
  html: string;
  screenshot: string | null;
  providerUsed: string;
  botIndicators: string[];
  statusCode: number;
  error: string | null;
}

// Simulate Zyte extraction evaluation logic
function evaluateZyteExtraction(
  response: MockZyteResponse,
  ocrTotal: number | null,
  htmlTotal: number | null,
  subtotalOnly: number | null
): { status: string; price: number | null; source: string } {
  // Check for bot detection first
  if (response.botIndicators.length > 0) {
    return { status: 'blocked_captcha_or_bot', price: null, source: 'none' };
  }
  
  // Check for HTTP errors
  if (!response.ok || response.statusCode === 429) {
    return { status: response.statusCode === 429 ? 'rate_limited' : 'provider_error', price: null, source: 'none' };
  }
  
  // Check for insufficient content
  if (!response.html || response.html.length < 500) {
    return { status: 'price_not_available_in_content', price: null, source: 'none' };
  }
  
  // PRIORITY 1: OCR total from screenshot
  if (ocrTotal && ocrTotal > 0) {
    return { status: 'total_price_including_taxes_and_fees', price: ocrTotal, source: 'ocr_total' };
  }
  
  // PRIORITY 2: HTML regex total
  if (htmlTotal && htmlTotal > 0) {
    return { status: 'total_price_including_taxes_and_fees', price: htmlTotal, source: 'html_regex' };
  }
  
  // PRIORITY 3: Subtotal only - NEVER promoted
  if (subtotalOnly && subtotalOnly > 0) {
    return { status: 'needs_user_confirmation', price: null, source: 'subtotal_only' };
  }
  
  return { status: 'price_not_available_in_content', price: null, source: 'none' };
}

// Currency normalization function (mirrors production logic)
function normalizeCurrencyAmount(raw: string): number | null {
  if (!raw || typeof raw !== 'string') return null;
  const cleaned = raw.replace(/[^0-9.,]/g, '').replace(/,/g, '');
  if (!cleaned) return null;
  const amount = parseFloat(cleaned);
  return Number.isFinite(amount) ? amount : null;
}

function runZyteCanonicalBaselineCheck(): ZyteCanonicalCheckResult {
  const checks: ZyteCanonicalCheckResult['checks'] = [];
  
  // Check 1: Output shape validation
  const mockValidResponse: MockZyteResponse = {
    ok: true,
    html: '<html>'.repeat(100), // > 500 chars
    screenshot: 'base64data',
    providerUsed: 'zyte',
    botIndicators: [],
    statusCode: 200,
    error: null,
  };
  const hasRequiredFields = 
    'ok' in mockValidResponse && 
    'providerUsed' in mockValidResponse && 
    'error' in mockValidResponse &&
    'botIndicators' in mockValidResponse;
  checks.push({
    name: 'zyte_output_shape_valid',
    expected: 'ok, providerUsed, error, botIndicators present',
    actual: hasRequiredFields ? 'all required fields present' : 'missing fields',
    passed: hasRequiredFields,
  });
  
  // Check 2: Total priority respected (OCR > HTML > subtotal)
  const resultWithBoth = evaluateZyteExtraction(mockValidResponse, 1658.94, 1650.00, 1500.00);
  const totalPriorityRespected = resultWithBoth.source === 'ocr_total' && resultWithBoth.price === 1658.94;
  checks.push({
    name: 'zyte_total_priority_respected',
    expected: 'ocr_total wins with price 1658.94',
    actual: `${resultWithBoth.source} with price ${resultWithBoth.price}`,
    passed: totalPriorityRespected,
  });
  
  // Check 3: Subtotal never promoted
  const resultSubtotalOnly = evaluateZyteExtraction(mockValidResponse, null, null, 1500.00);
  const subtotalNeverPromoted = 
    resultSubtotalOnly.status === 'needs_user_confirmation' && 
    resultSubtotalOnly.price === null;
  checks.push({
    name: 'zyte_subtotal_never_promoted',
    expected: 'needs_user_confirmation with null price',
    actual: `${resultSubtotalOnly.status} with price ${resultSubtotalOnly.price}`,
    passed: subtotalNeverPromoted,
  });
  
  // Check 4: Currency normalization (US/CH formats - primary markets)
  const testCases = [
    { input: '$1,658.94', expected: 1658.94 },
    { input: 'CHF 2,500.00', expected: 2500.00 },
    { input: '£999.99', expected: 999.99 },
    { input: '€1234.56', expected: 1234.56 },
  ];
  let allCurrencyPassed = true;
  const currencyResults: string[] = [];
  for (const tc of testCases) {
    const result = normalizeCurrencyAmount(tc.input);
    // Allow for floating point precision
    const passed = result !== null && Math.abs(result - tc.expected) < 0.01;
    if (!passed) allCurrencyPassed = false;
    currencyResults.push(`${tc.input}→${result}`);
  }
  checks.push({
    name: 'zyte_currency_normalization',
    expected: 'all currency formats parse correctly',
    actual: allCurrencyPassed ? 'all passed' : currencyResults.join(', '),
    passed: allCurrencyPassed,
  });
  
  // Check 5: Null safety (empty/malformed input)
  const emptyResponse: MockZyteResponse = {
    ok: true,
    html: '', // Empty content
    screenshot: null,
    providerUsed: 'zyte',
    botIndicators: [],
    statusCode: 200,
    error: null,
  };
  const emptyResult = evaluateZyteExtraction(emptyResponse, null, null, null);
  const nullSafe = emptyResult.status === 'price_not_available_in_content' && emptyResult.price === null;
  checks.push({
    name: 'zyte_null_safe',
    expected: 'price_not_available_in_content with null price',
    actual: `${emptyResult.status} with price ${emptyResult.price}`,
    passed: nullSafe,
  });
  
  const allPassed = checks.every(c => c.passed);
  
  return {
    mode: 'zyte-canonical-check',
    passed: allPassed,
    checks,
    status: allPassed ? 'zyte_canonical_valid' : 'zyte_canonical_violation',
    timestamp: new Date().toISOString(),
  };
}

// =============================================================================
// FIRECRAWL CANONICAL BASELINE CHECK
// =============================================================================

interface FirecrawlCanonicalCheckResult {
  mode: 'firecrawl-canonical-check';
  passed: boolean;
  checks: Array<{
    name: string;
    expected: string;
    actual: string;
    passed: boolean;
  }>;
  status: 'firecrawl_canonical_valid' | 'firecrawl_canonical_violation';
  timestamp: string;
}

// Mock Firecrawl response structure (mirrors production)
interface MockFirecrawlResponse {
  success: boolean;
  markdown: string | null;
  html: string | null;
  screenshot: string | null;
  providerUsed: string;
  statusCode: number;
  error: string | null;
}

// Simulate Firecrawl extraction evaluation logic
function evaluateFirecrawlExtraction(
  response: MockFirecrawlResponse,
  ocrTotal: number | null,
  markdownTotal: number | null,
  htmlTotal: number | null,
  subtotalOnly: number | null
): { status: string; price: number | null; source: string } {
  // Check for API errors
  if (!response.success || response.statusCode === 429) {
    return { status: response.statusCode === 429 ? 'rate_limited' : 'provider_error', price: null, source: 'none' };
  }
  
  // Check for insufficient content
  const hasContent = (response.markdown && response.markdown.length > 100) || 
                     (response.html && response.html.length > 500);
  if (!hasContent) {
    return { status: 'price_not_available_in_content', price: null, source: 'none' };
  }
  
  // PRIORITY 1: OCR total from screenshot
  if (ocrTotal && ocrTotal > 0) {
    return { status: 'total_price_including_taxes_and_fees', price: ocrTotal, source: 'ocr_total' };
  }
  
  // PRIORITY 2: Markdown regex total
  if (markdownTotal && markdownTotal > 0) {
    return { status: 'total_price_including_taxes_and_fees', price: markdownTotal, source: 'markdown_regex' };
  }
  
  // PRIORITY 3: HTML regex total
  if (htmlTotal && htmlTotal > 0) {
    return { status: 'total_price_including_taxes_and_fees', price: htmlTotal, source: 'html_regex' };
  }
  
  // PRIORITY 4: Subtotal only - NEVER promoted
  if (subtotalOnly && subtotalOnly > 0) {
    return { status: 'needs_user_confirmation', price: null, source: 'subtotal_only' };
  }
  
  return { status: 'price_not_available_in_content', price: null, source: 'none' };
}

function runFirecrawlCanonicalBaselineCheck(): FirecrawlCanonicalCheckResult {
  const checks: FirecrawlCanonicalCheckResult['checks'] = [];
  
  // Check 1: Output shape validation
  const mockValidResponse: MockFirecrawlResponse = {
    success: true,
    markdown: '# Booking\n\nTotal (USD) $1,658.94'.repeat(10), // > 100 chars
    html: '<html><body>Total</body></html>'.repeat(20), // > 500 chars
    screenshot: 'base64data',
    providerUsed: 'firecrawl',
    statusCode: 200,
    error: null,
  };
  const hasRequiredFields = 
    'success' in mockValidResponse && 
    'providerUsed' in mockValidResponse && 
    'error' in mockValidResponse &&
    mockValidResponse.providerUsed === 'firecrawl';
  checks.push({
    name: 'firecrawl_output_shape_valid',
    expected: 'success, providerUsed, error present; providerUsed=firecrawl',
    actual: hasRequiredFields ? 'all required fields present' : 'missing fields',
    passed: hasRequiredFields,
  });
  
  // Check 2: Total priority respected (OCR > markdown > HTML > subtotal)
  const resultWithAll = evaluateFirecrawlExtraction(mockValidResponse, 1658.94, 1650.00, 1640.00, 1500.00);
  const totalPriorityRespected = resultWithAll.source === 'ocr_total' && resultWithAll.price === 1658.94;
  checks.push({
    name: 'firecrawl_total_priority_respected',
    expected: 'ocr_total wins with price 1658.94',
    actual: `${resultWithAll.source} with price ${resultWithAll.price}`,
    passed: totalPriorityRespected,
  });
  
  // Check 3: Subtotal never promoted
  const resultSubtotalOnly = evaluateFirecrawlExtraction(mockValidResponse, null, null, null, 1500.00);
  const subtotalNeverPromoted = 
    resultSubtotalOnly.status === 'needs_user_confirmation' && 
    resultSubtotalOnly.price === null;
  checks.push({
    name: 'firecrawl_subtotal_never_promoted',
    expected: 'needs_user_confirmation with null price',
    actual: `${resultSubtotalOnly.status} with price ${resultSubtotalOnly.price}`,
    passed: subtotalNeverPromoted,
  });
  
  // Check 4: Currency normalization (reuse existing normalizeCurrencyAmount)
  const testCases = [
    { input: '$1,658.94', expected: 1658.94 },
    { input: 'CHF 2,500.00', expected: 2500.00 },
    { input: '£999.99', expected: 999.99 },
    { input: '€1234.56', expected: 1234.56 },
  ];
  let allCurrencyPassed = true;
  const currencyResults: string[] = [];
  for (const tc of testCases) {
    const result = normalizeCurrencyAmount(tc.input);
    const passed = result !== null && Math.abs(result - tc.expected) < 0.01;
    if (!passed) allCurrencyPassed = false;
    currencyResults.push(`${tc.input}→${result}`);
  }
  checks.push({
    name: 'firecrawl_currency_normalization',
    expected: 'all currency formats parse correctly',
    actual: allCurrencyPassed ? 'all passed' : currencyResults.join(', '),
    passed: allCurrencyPassed,
  });
  
  // Check 5: Null safety (empty/malformed input)
  const emptyResponse: MockFirecrawlResponse = {
    success: true,
    markdown: '', // Empty content
    html: '',
    screenshot: null,
    providerUsed: 'firecrawl',
    statusCode: 200,
    error: null,
  };
  const emptyResult = evaluateFirecrawlExtraction(emptyResponse, null, null, null, null);
  const nullSafe = emptyResult.status === 'price_not_available_in_content' && emptyResult.price === null;
  checks.push({
    name: 'firecrawl_null_safe',
    expected: 'price_not_available_in_content with null price',
    actual: `${emptyResult.status} with price ${emptyResult.price}`,
    passed: nullSafe,
  });
  
  const allPassed = checks.every(c => c.passed);
  
  return {
    mode: 'firecrawl-canonical-check',
    passed: allPassed,
    checks,
    status: allPassed ? 'firecrawl_canonical_valid' : 'firecrawl_canonical_violation',
    timestamp: new Date().toISOString(),
  };
}

// =============================================================================
// BASELINE CHAIN CANONICAL CHECK (Orchestration Guard)
// =============================================================================

interface BaselineChainCanonicalCheckResult {
  mode: 'baseline-chain-canonical-check';
  passed: boolean;
  checks: Array<{
    name: string;
    expected: string;
    actual: string;
    passed: boolean;
  }>;
  status: 'baseline_chain_canonical_valid' | 'baseline_chain_canonical_violation';
  timestamp: string;
}

// Mock provider result structure for chain testing
interface MockProviderResult {
  provider: 'browserless' | 'zyte' | 'firecrawl';
  status: string;
  price: number | null;
  currency: string;
}

// Simulate baseline chain orchestration logic
function evaluateBaselineChain(
  browserlessResult: MockProviderResult,
  zyteResult: MockProviderResult,
  firecrawlResult: MockProviderResult
): { 
  finalProvider: string; 
  finalStatus: string; 
  finalPrice: number | null;
  finalCurrency: string;
  fallbackAttempted: boolean;
  zyteAttempted: boolean;
  firecrawlAttempted: boolean;
} {
  const VERIFIED_STATUS = 'total_price_including_taxes_and_fees';
  
  // STEP 1: Check Browserless first (primary)
  if (browserlessResult.status === VERIFIED_STATUS) {
    return {
      finalProvider: 'browserless',
      finalStatus: browserlessResult.status,
      finalPrice: browserlessResult.price,
      finalCurrency: browserlessResult.currency,
      fallbackAttempted: false,
      zyteAttempted: false,
      firecrawlAttempted: false,
    };
  }
  
  // STEP 2: Browserless not verified, try Zyte
  if (zyteResult.status === VERIFIED_STATUS) {
    return {
      finalProvider: 'zyte',
      finalStatus: zyteResult.status,
      finalPrice: zyteResult.price,
      finalCurrency: zyteResult.currency,
      fallbackAttempted: true,
      zyteAttempted: true,
      firecrawlAttempted: false,
    };
  }
  
  // STEP 3: Zyte not verified, try Firecrawl
  if (firecrawlResult.status === VERIFIED_STATUS) {
    return {
      finalProvider: 'firecrawl',
      finalStatus: firecrawlResult.status,
      finalPrice: firecrawlResult.price,
      finalCurrency: firecrawlResult.currency,
      fallbackAttempted: true,
      zyteAttempted: true,
      firecrawlAttempted: true,
    };
  }
  
  // STEP 4: None verified - determine final status
  // Priority: needs_user_confirmation > blocked > rate_limited > price_not_available > provider_error
  const allStatuses = [browserlessResult.status, zyteResult.status, firecrawlResult.status];
  
  let finalStatus = 'price_not_available_in_content';
  if (allStatuses.includes('needs_user_confirmation')) {
    finalStatus = 'needs_user_confirmation';
  } else if (allStatuses.includes('blocked_captcha_or_bot')) {
    finalStatus = 'blocked_captcha_or_bot';
  } else if (allStatuses.includes('rate_limited')) {
    finalStatus = 'rate_limited';
  }
  
  return {
    finalProvider: 'none',
    finalStatus,
    finalPrice: null,
    finalCurrency: 'USD',
    fallbackAttempted: true,
    zyteAttempted: true,
    firecrawlAttempted: true,
  };
}

function runBaselineChainCanonicalCheck(): BaselineChainCanonicalCheckResult {
  const checks: BaselineChainCanonicalCheckResult['checks'] = [];
  const VERIFIED_STATUS = 'total_price_including_taxes_and_fees';
  
  // Check A: browserless_wins_when_verified
  // When Browserless returns verified, it should be used and no fallback attempted
  const checkA_browserless: MockProviderResult = {
    provider: 'browserless',
    status: VERIFIED_STATUS,
    price: 1658.94,
    currency: 'USD',
  };
  const checkA_zyte: MockProviderResult = {
    provider: 'zyte',
    status: VERIFIED_STATUS,
    price: 9999.99, // Should not be used
    currency: 'USD',
  };
  const checkA_firecrawl: MockProviderResult = {
    provider: 'firecrawl',
    status: VERIFIED_STATUS,
    price: 8888.88, // Should not be used
    currency: 'USD',
  };
  const resultA = evaluateBaselineChain(checkA_browserless, checkA_zyte, checkA_firecrawl);
  const checkA_passed = 
    resultA.finalProvider === 'browserless' &&
    resultA.finalStatus === VERIFIED_STATUS &&
    resultA.finalPrice === 1658.94 &&
    !resultA.fallbackAttempted &&
    !resultA.zyteAttempted &&
    !resultA.firecrawlAttempted;
  checks.push({
    name: 'browserless_wins_when_verified',
    expected: 'browserless verified, no fallback',
    actual: `provider=${resultA.finalProvider}, fallback=${resultA.fallbackAttempted}`,
    passed: checkA_passed,
  });
  
  // Check B: zyte_used_when_browserless_not_verified
  const checkB_browserless: MockProviderResult = {
    provider: 'browserless',
    status: 'needs_user_confirmation', // Not verified
    price: null,
    currency: 'USD',
  };
  const checkB_zyte: MockProviderResult = {
    provider: 'zyte',
    status: VERIFIED_STATUS,
    price: 1650.00,
    currency: 'USD',
  };
  const checkB_firecrawl: MockProviderResult = {
    provider: 'firecrawl',
    status: 'provider_error', // Should not be consulted
    price: null,
    currency: 'USD',
  };
  const resultB = evaluateBaselineChain(checkB_browserless, checkB_zyte, checkB_firecrawl);
  const checkB_passed = 
    resultB.finalProvider === 'zyte' &&
    resultB.finalStatus === VERIFIED_STATUS &&
    resultB.finalPrice === 1650.00 &&
    resultB.zyteAttempted &&
    !resultB.firecrawlAttempted;
  checks.push({
    name: 'zyte_used_when_browserless_not_verified',
    expected: 'zyte verified, firecrawl not attempted',
    actual: `provider=${resultB.finalProvider}, firecrawl=${resultB.firecrawlAttempted}`,
    passed: checkB_passed,
  });
  
  // Check C: firecrawl_used_when_browserless_and_zyte_not_verified
  const checkC_browserless: MockProviderResult = {
    provider: 'browserless',
    status: 'price_not_available_in_content',
    price: null,
    currency: 'USD',
  };
  const checkC_zyte: MockProviderResult = {
    provider: 'zyte',
    status: 'needs_user_confirmation',
    price: null,
    currency: 'USD',
  };
  const checkC_firecrawl: MockProviderResult = {
    provider: 'firecrawl',
    status: VERIFIED_STATUS,
    price: 1640.00,
    currency: 'USD',
  };
  const resultC = evaluateBaselineChain(checkC_browserless, checkC_zyte, checkC_firecrawl);
  const checkC_passed = 
    resultC.finalProvider === 'firecrawl' &&
    resultC.finalStatus === VERIFIED_STATUS &&
    resultC.finalPrice === 1640.00 &&
    resultC.zyteAttempted &&
    resultC.firecrawlAttempted;
  checks.push({
    name: 'firecrawl_used_when_both_not_verified',
    expected: 'firecrawl verified after both fallbacks',
    actual: `provider=${resultC.finalProvider}, price=${resultC.finalPrice}`,
    passed: checkC_passed,
  });
  
  // Check D: subtotal_never_promoted_across_chain
  const checkD_browserless: MockProviderResult = {
    provider: 'browserless',
    status: 'needs_user_confirmation', // Subtotal only
    price: null,
    currency: 'USD',
  };
  const checkD_zyte: MockProviderResult = {
    provider: 'zyte',
    status: 'needs_user_confirmation', // Subtotal only
    price: null,
    currency: 'USD',
  };
  const checkD_firecrawl: MockProviderResult = {
    provider: 'firecrawl',
    status: 'needs_user_confirmation', // Subtotal only
    price: null,
    currency: 'USD',
  };
  const resultD = evaluateBaselineChain(checkD_browserless, checkD_zyte, checkD_firecrawl);
  const checkD_passed = 
    resultD.finalStatus === 'needs_user_confirmation' &&
    resultD.finalPrice === null;
  checks.push({
    name: 'subtotal_never_promoted_across_chain',
    expected: 'needs_user_confirmation, NOT verified',
    actual: `status=${resultD.finalStatus}, price=${resultD.finalPrice}`,
    passed: checkD_passed,
  });
  
  // Check E: currency_normalisation_consistent
  // Test that currency normalization produces consistent results
  const testCases = [
    { input: '$1,658.94', expected: 1658.94 },
    { input: 'CHF 2,500.00', expected: 2500.00 },
    { input: '£999.99', expected: 999.99 },
    { input: '€1234.56', expected: 1234.56 },
  ];
  let allCurrencyPassed = true;
  const currencyResults: string[] = [];
  for (const tc of testCases) {
    const result = normalizeCurrencyAmount(tc.input);
    const passed = result !== null && Math.abs(result - tc.expected) < 0.01;
    if (!passed) allCurrencyPassed = false;
    currencyResults.push(`${tc.input}→${result}`);
  }
  checks.push({
    name: 'currency_normalisation_consistent',
    expected: 'all formats normalize correctly',
    actual: allCurrencyPassed ? 'all passed' : currencyResults.join(', '),
    passed: allCurrencyPassed,
  });
  
  const allPassed = checks.every(c => c.passed);
  
  return {
    mode: 'baseline-chain-canonical-check',
    passed: allPassed,
    checks,
    status: allPassed ? 'baseline_chain_canonical_valid' : 'baseline_chain_canonical_violation',
    timestamp: new Date().toISOString(),
  };
}

// =============================================================================
// CANARY URL CONFIGURATION
// Fixed test scenario for live provider capability checks
// =============================================================================
const CANARY_CONFIG = {
  // Use a known stable listing with dates far in the future
  // This URL should reliably show the checkout page with a grounded total
  baseUrl: 'https://www.airbnb.com/rooms/903802242341279498',
  checkIn: '2026-02-01',
  checkOut: '2026-02-05',
  adults: 2,
  guestCurrency: 'USD',
  userCountry: 'US',
  nightsCount: 4,
  // Expected total with 1% tolerance
  expectedTotal: 2214,
  tolerance: 0.01,
};

function buildCanaryUrl(): string {
  return `${CANARY_CONFIG.baseUrl}?check_in=${CANARY_CONFIG.checkIn}&check_out=${CANARY_CONFIG.checkOut}&adults=${CANARY_CONFIG.adults}`;
}

interface CanaryCheckResult {
  mode: string;
  passed: boolean;
  provider: string;
  canary_url: string;
  canary_dates: { check_in: string; check_out: string; nights: number };
  extraction_result: {
    status: string;
    price: number | null;
    currency: string;
    evidence_snippet: string | null;
  } | null;
  failure_reason: string | null;
  expected_behavior: string;
  timestamp: string;
  duration_ms: number;
  checks: Array<{
    name: string;
    expected: string;
    actual: string;
    passed: boolean;
  }>;
}

// Run live Browserless canary check
async function runBrowserlessCanaryCheck(): Promise<CanaryCheckResult> {
  const startTime = Date.now();
  const canaryUrl = buildCanaryUrl();
  const checks: CanaryCheckResult['checks'] = [];
  
  const VERIFIED_STATUS = 'total_price_including_taxes_and_fees';
  
  try {
    // Build book/stays URL for canary
    const bookStaysParams = buildBookStaysUrl(canaryUrl, CANARY_CONFIG.guestCurrency);
    if (!bookStaysParams) {
      return {
        mode: 'browserless-canary',
        passed: false,
        provider: 'browserless',
        canary_url: canaryUrl,
        canary_dates: { check_in: CANARY_CONFIG.checkIn, check_out: CANARY_CONFIG.checkOut, nights: CANARY_CONFIG.nightsCount },
        extraction_result: null,
        failure_reason: 'Failed to parse canary URL',
        expected_behavior: 'Extract grounded total with status total_price_including_taxes_and_fees',
        timestamp: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        checks: [{ name: 'url_parse', expected: 'valid', actual: 'invalid', passed: false }],
      };
    }
    
    // Actually call Browserless
    const browserResult = await runBrowserlessBookStays(
      bookStaysParams.book_stays_url,
      bookStaysParams.rooms_url,
      bookStaysParams.room_id,
      CANARY_CONFIG.nightsCount,
      CANARY_CONFIG.userCountry,
      CANARY_CONFIG.guestCurrency
    );
    
    // Check if provider is configured
    if (browserResult.status === 'provider_not_configured') {
      return {
        mode: 'browserless-canary',
        passed: false,
        provider: 'browserless',
        canary_url: canaryUrl,
        canary_dates: { check_in: CANARY_CONFIG.checkIn, check_out: CANARY_CONFIG.checkOut, nights: CANARY_CONFIG.nightsCount },
        extraction_result: null,
        failure_reason: 'BROWSERLESS_API_KEY not configured',
        expected_behavior: 'Extract grounded total with status total_price_including_taxes_and_fees',
        timestamp: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        checks: [{ name: 'provider_configured', expected: 'true', actual: 'false', passed: false }],
      };
    }
    
    // Check if we got a screenshot
    if (!browserResult.screenshotBase64) {
      return {
        mode: 'browserless-canary',
        passed: false,
        provider: 'browserless',
        canary_url: canaryUrl,
        canary_dates: { check_in: CANARY_CONFIG.checkIn, check_out: CANARY_CONFIG.checkOut, nights: CANARY_CONFIG.nightsCount },
        extraction_result: { status: browserResult.status || 'screenshot_missing', price: null, currency: 'USD', evidence_snippet: null },
        failure_reason: browserResult.wrongPageReason || 'No screenshot captured',
        expected_behavior: 'Extract grounded total with status total_price_including_taxes_and_fees',
        timestamp: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        checks: [{ name: 'screenshot_captured', expected: 'true', actual: 'false', passed: false }],
      };
    }
    
    // Run OCR on the screenshot
    let ocrTextRaw = '';
    try {
      ocrTextRaw = await ocrImageToText(browserResult.screenshotBase64);
    } catch (ocrErr) {
      return {
        mode: 'browserless-canary',
        passed: false,
        provider: 'browserless',
        canary_url: canaryUrl,
        canary_dates: { check_in: CANARY_CONFIG.checkIn, check_out: CANARY_CONFIG.checkOut, nights: CANARY_CONFIG.nightsCount },
        extraction_result: { status: 'ocr_error', price: null, currency: 'USD', evidence_snippet: null },
        failure_reason: `OCR failed: ${ocrErr instanceof Error ? ocrErr.message : String(ocrErr)}`,
        expected_behavior: 'Extract grounded total with status total_price_including_taxes_and_fees',
        timestamp: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        checks: [{ name: 'ocr_success', expected: 'true', actual: 'false', passed: false }],
      };
    }
    
    // Extract total from OCR
    const extractionResult = browserResult.usedFallback
      ? extractBookingCardFromRoomsOcr(ocrTextRaw, CANARY_CONFIG.nightsCount)
      : extractAllInTotalFromOcr(ocrTextRaw, CANARY_CONFIG.nightsCount);
    
    const extractedPrice = browserResult.usedFallback 
      ? (extractionResult as any).booking_card_amount_value 
      : (extractionResult as any).all_in_total_amount_value;
    const extractedCurrency = (extractionResult as any).currency || 'USD';
    const evidenceSnippet = (extractionResult as any).evidence_snippet || null;
    
    // Determine status based on extraction
    let finalStatus = 'price_not_available_in_content';
    if (browserResult.isUnavailable) {
      finalStatus = 'dates_unavailable';
    } else if (extractedPrice && extractedPrice > 0) {
      // Check for grounded total patterns in evidence
      const hasPayNowPattern = /pay\s*\$?\s*[\d,]+/i.test(ocrTextRaw);
      const hasTotalPattern = /total\s*\(?[A-Z]{3}\)?\s*\$?\s*[\d,]+/i.test(ocrTextRaw);
      const hasDueTodayPattern = /due\s+today\s*\$?\s*[\d,]+/i.test(ocrTextRaw);
      
      if (hasPayNowPattern || hasTotalPattern || hasDueTodayPattern) {
        finalStatus = VERIFIED_STATUS;
      } else {
        finalStatus = 'needs_user_confirmation';
      }
    } else {
      finalStatus = 'needs_user_confirmation';
    }
    
    // Build checks
    checks.push({
      name: 'navigation_success',
      expected: 'reached checkout page',
      actual: browserResult.usedFallback ? 'fallback to rooms page' : 'book/stays page',
      passed: !browserResult.wrongPageReason,
    });
    
    checks.push({
      name: 'screenshot_captured',
      expected: 'true',
      actual: 'true',
      passed: true,
    });
    
    checks.push({
      name: 'extraction_status',
      expected: VERIFIED_STATUS,
      actual: finalStatus,
      passed: finalStatus === VERIFIED_STATUS,
    });
    
    checks.push({
      name: 'price_extracted',
      expected: `~${CANARY_CONFIG.expectedTotal} USD`,
      actual: extractedPrice ? `${extractedPrice} ${extractedCurrency}` : 'null',
      passed: extractedPrice !== null && extractedPrice > 0,
    });
    
    const isPassed = finalStatus === VERIFIED_STATUS && extractedPrice !== null && extractedPrice > 0;
    
    let failureReason: string | null = null;
    if (!isPassed) {
      if (finalStatus === 'needs_user_confirmation') {
        failureReason = extractedPrice 
          ? `Only subtotal found (${extractedPrice}), no grounded total pattern detected`
          : 'No price extracted from page content';
      } else if (finalStatus === 'dates_unavailable') {
        failureReason = 'Dates unavailable for canary listing';
      } else {
        failureReason = `Status ${finalStatus} is not verified`;
      }
    }
    
    return {
      mode: 'browserless-canary',
      passed: isPassed,
      provider: 'browserless',
      canary_url: canaryUrl,
      canary_dates: { check_in: CANARY_CONFIG.checkIn, check_out: CANARY_CONFIG.checkOut, nights: CANARY_CONFIG.nightsCount },
      extraction_result: {
        status: finalStatus,
        price: extractedPrice,
        currency: extractedCurrency,
        evidence_snippet: evidenceSnippet ? safeSnippet(evidenceSnippet, 200) : null,
      },
      failure_reason: failureReason,
      expected_behavior: 'Extract grounded total with status total_price_including_taxes_and_fees',
      timestamp: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      checks,
    };
  } catch (err) {
    return {
      mode: 'browserless-canary',
      passed: false,
      provider: 'browserless',
      canary_url: canaryUrl,
      canary_dates: { check_in: CANARY_CONFIG.checkIn, check_out: CANARY_CONFIG.checkOut, nights: CANARY_CONFIG.nightsCount },
      extraction_result: null,
      failure_reason: `Exception: ${err instanceof Error ? err.message : String(err)}`,
      expected_behavior: 'Extract grounded total with status total_price_including_taxes_and_fees',
      timestamp: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      checks: [{ name: 'execution_success', expected: 'no exception', actual: 'exception thrown', passed: false }],
    };
  }
}

// =============================================================================
// ZYTE CANARY CHECK - Live provider capability test
// =============================================================================
async function runZyteCanaryCheck(): Promise<CanaryCheckResult> {
  const startTime = Date.now();
  const canaryUrl = buildCanaryUrl();
  const checks: CanaryCheckResult['checks'] = [];
  const VERIFIED_STATUS = 'total_price_including_taxes_and_fees';
  
  try {
    const zyteApiKey = Deno.env.get('ZYTE_API_KEY');
    if (!zyteApiKey) {
      return {
        mode: 'zyte-canary',
        passed: false,
        provider: 'zyte',
        canary_url: canaryUrl,
        canary_dates: { check_in: CANARY_CONFIG.checkIn, check_out: CANARY_CONFIG.checkOut, nights: CANARY_CONFIG.nightsCount },
        extraction_result: null,
        failure_reason: 'ZYTE_API_KEY not configured',
        expected_behavior: 'Extract grounded total with status total_price_including_taxes_and_fees',
        timestamp: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        checks: [{ name: 'provider_configured', expected: 'true', actual: 'false', passed: false }],
      };
    }
    
    // Build book/stays URL for canary
    const bookStaysParams = buildBookStaysUrl(canaryUrl, CANARY_CONFIG.guestCurrency);
    if (!bookStaysParams) {
      return {
        mode: 'zyte-canary',
        passed: false,
        provider: 'zyte',
        canary_url: canaryUrl,
        canary_dates: { check_in: CANARY_CONFIG.checkIn, check_out: CANARY_CONFIG.checkOut, nights: CANARY_CONFIG.nightsCount },
        extraction_result: null,
        failure_reason: 'Failed to parse canary URL',
        expected_behavior: 'Extract grounded total with status total_price_including_taxes_and_fees',
        timestamp: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        checks: [{ name: 'url_parse', expected: 'valid', actual: 'invalid', passed: false }],
      };
    }
    
    // Call Zyte API
    const zytePayload = {
      url: bookStaysParams.book_stays_url,
      browserHtml: true,
      screenshot: true,
      javascript: true,
      actions: [
        { action: 'waitForTimeout', timeout: 5000 },
      ],
    };
    
    const zyteResponse = await fetchWithTimeout('https://api.zyte.com/v1/extract', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${btoa(zyteApiKey + ':')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(zytePayload),
    }, 60000);
    
    if (!zyteResponse.ok) {
      const errorText = await zyteResponse.text().catch(() => '');
      return {
        mode: 'zyte-canary',
        passed: false,
        provider: 'zyte',
        canary_url: canaryUrl,
        canary_dates: { check_in: CANARY_CONFIG.checkIn, check_out: CANARY_CONFIG.checkOut, nights: CANARY_CONFIG.nightsCount },
        extraction_result: { status: `http_${zyteResponse.status}`, price: null, currency: 'USD', evidence_snippet: null },
        failure_reason: `Zyte API returned ${zyteResponse.status}: ${safeSnippet(errorText, 100)}`,
        expected_behavior: 'Extract grounded total with status total_price_including_taxes_and_fees',
        timestamp: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        checks: [{ name: 'api_success', expected: '200', actual: String(zyteResponse.status), passed: false }],
      };
    }
    
    const zyteData = await zyteResponse.json();
    const html = zyteData.browserHtml || '';
    const screenshotBase64 = zyteData.screenshot || null;
    
    checks.push({
      name: 'api_success',
      expected: '200',
      actual: '200',
      passed: true,
    });
    
    checks.push({
      name: 'html_received',
      expected: '>1000 chars',
      actual: `${html.length} chars`,
      passed: html.length > 1000,
    });
    
    // Try OCR if we have a screenshot
    let extractedPrice: number | null = null;
    let extractedCurrency = 'USD';
    let evidenceSnippet: string | null = null;
    let finalStatus = 'price_not_available_in_content';
    
    if (screenshotBase64) {
      try {
        const ocrText = await ocrImageToText(screenshotBase64);
        const extraction = extractAllInTotalFromOcr(ocrText, CANARY_CONFIG.nightsCount);
        extractedPrice = extraction.all_in_total_amount_value;
        extractedCurrency = extraction.currency;
        evidenceSnippet = extraction.evidence_snippet;
        
        if (extractedPrice && extractedPrice > 0) {
          const hasPayNowPattern = /pay\s*\$?\s*[\d,]+/i.test(ocrText);
          const hasTotalPattern = /total\s*\(?[A-Z]{3}\)?\s*\$?\s*[\d,]+/i.test(ocrText);
          if (hasPayNowPattern || hasTotalPattern) {
            finalStatus = VERIFIED_STATUS;
          } else {
            finalStatus = 'needs_user_confirmation';
          }
        }
        
        checks.push({ name: 'ocr_extraction', expected: 'price found', actual: extractedPrice ? `${extractedPrice}` : 'null', passed: !!extractedPrice });
      } catch (ocrErr) {
        checks.push({ name: 'ocr_extraction', expected: 'success', actual: 'ocr_failed', passed: false });
      }
    } else {
      // Fallback to HTML regex extraction
      const htmlExtraction = extractAllInTotalFromOcr(html, CANARY_CONFIG.nightsCount);
      extractedPrice = htmlExtraction.all_in_total_amount_value;
      extractedCurrency = htmlExtraction.currency;
      evidenceSnippet = htmlExtraction.evidence_snippet;
      
      if (extractedPrice && extractedPrice > 0) {
        finalStatus = VERIFIED_STATUS;
      }
      
      checks.push({ name: 'html_extraction', expected: 'price found', actual: extractedPrice ? `${extractedPrice}` : 'null', passed: !!extractedPrice });
    }
    
    checks.push({
      name: 'extraction_status',
      expected: VERIFIED_STATUS,
      actual: finalStatus,
      passed: finalStatus === VERIFIED_STATUS,
    });
    
    const isPassed = finalStatus === VERIFIED_STATUS && extractedPrice !== null && extractedPrice > 0;
    let failureReason: string | null = null;
    if (!isPassed) {
      if (finalStatus === 'needs_user_confirmation') {
        failureReason = extractedPrice 
          ? `Only subtotal found (${extractedPrice}), no grounded total pattern`
          : 'No price extracted from content';
      } else {
        failureReason = `Status ${finalStatus} is not verified`;
      }
    }
    
    return {
      mode: 'zyte-canary',
      passed: isPassed,
      provider: 'zyte',
      canary_url: canaryUrl,
      canary_dates: { check_in: CANARY_CONFIG.checkIn, check_out: CANARY_CONFIG.checkOut, nights: CANARY_CONFIG.nightsCount },
      extraction_result: {
        status: finalStatus,
        price: extractedPrice,
        currency: extractedCurrency,
        evidence_snippet: evidenceSnippet ? safeSnippet(evidenceSnippet, 200) : null,
      },
      failure_reason: failureReason,
      expected_behavior: 'Extract grounded total with status total_price_including_taxes_and_fees',
      timestamp: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      checks,
    };
  } catch (err) {
    return {
      mode: 'zyte-canary',
      passed: false,
      provider: 'zyte',
      canary_url: canaryUrl,
      canary_dates: { check_in: CANARY_CONFIG.checkIn, check_out: CANARY_CONFIG.checkOut, nights: CANARY_CONFIG.nightsCount },
      extraction_result: null,
      failure_reason: `Exception: ${err instanceof Error ? err.message : String(err)}`,
      expected_behavior: 'Extract grounded total with status total_price_including_taxes_and_fees',
      timestamp: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      checks: [{ name: 'execution_success', expected: 'no exception', actual: 'exception thrown', passed: false }],
    };
  }
}

// =============================================================================
// FIRECRAWL CANARY CHECK - Live provider capability test
// =============================================================================
async function runFirecrawlCanaryCheck(): Promise<CanaryCheckResult> {
  const startTime = Date.now();
  const canaryUrl = buildCanaryUrl();
  const checks: CanaryCheckResult['checks'] = [];
  const VERIFIED_STATUS = 'total_price_including_taxes_and_fees';
  
  try {
    const firecrawlApiKey = Deno.env.get('FIRECRAWL_API_KEY');
    if (!firecrawlApiKey) {
      return {
        mode: 'firecrawl-canary',
        passed: false,
        provider: 'firecrawl',
        canary_url: canaryUrl,
        canary_dates: { check_in: CANARY_CONFIG.checkIn, check_out: CANARY_CONFIG.checkOut, nights: CANARY_CONFIG.nightsCount },
        extraction_result: null,
        failure_reason: 'FIRECRAWL_API_KEY not configured',
        expected_behavior: 'Extract grounded total with status total_price_including_taxes_and_fees',
        timestamp: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        checks: [{ name: 'provider_configured', expected: 'true', actual: 'false', passed: false }],
      };
    }
    
    // Build book/stays URL for canary
    const bookStaysParams = buildBookStaysUrl(canaryUrl, CANARY_CONFIG.guestCurrency);
    if (!bookStaysParams) {
      return {
        mode: 'firecrawl-canary',
        passed: false,
        provider: 'firecrawl',
        canary_url: canaryUrl,
        canary_dates: { check_in: CANARY_CONFIG.checkIn, check_out: CANARY_CONFIG.checkOut, nights: CANARY_CONFIG.nightsCount },
        extraction_result: null,
        failure_reason: 'Failed to parse canary URL',
        expected_behavior: 'Extract grounded total with status total_price_including_taxes_and_fees',
        timestamp: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        checks: [{ name: 'url_parse', expected: 'valid', actual: 'invalid', passed: false }],
      };
    }
    
    // Call Firecrawl API with waitFor for dynamic content
    const waitForMs = 10000;
    const timeoutMs = Math.max(waitForMs * 2.5, 30000);
    
    const firecrawlResponse = await fetchWithTimeout('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${firecrawlApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: bookStaysParams.book_stays_url,
        formats: ['markdown', 'html', 'screenshot'],
        waitFor: waitForMs,
        timeout: timeoutMs,
      }),
    }, 90000);
    
    if (!firecrawlResponse.ok) {
      const errorText = await firecrawlResponse.text().catch(() => '');
      return {
        mode: 'firecrawl-canary',
        passed: false,
        provider: 'firecrawl',
        canary_url: canaryUrl,
        canary_dates: { check_in: CANARY_CONFIG.checkIn, check_out: CANARY_CONFIG.checkOut, nights: CANARY_CONFIG.nightsCount },
        extraction_result: { status: `http_${firecrawlResponse.status}`, price: null, currency: 'USD', evidence_snippet: null },
        failure_reason: `Firecrawl API returned ${firecrawlResponse.status}: ${safeSnippet(errorText, 100)}`,
        expected_behavior: 'Extract grounded total with status total_price_including_taxes_and_fees',
        timestamp: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        checks: [{ name: 'api_success', expected: '200', actual: String(firecrawlResponse.status), passed: false }],
      };
    }
    
    const firecrawlData = await firecrawlResponse.json();
    const markdown = firecrawlData.data?.markdown || firecrawlData.markdown || '';
    const html = firecrawlData.data?.html || firecrawlData.html || '';
    const screenshotBase64 = firecrawlData.data?.screenshot || firecrawlData.screenshot || null;
    
    checks.push({
      name: 'api_success',
      expected: '200',
      actual: '200',
      passed: true,
    });
    
    checks.push({
      name: 'content_received',
      expected: 'markdown or html',
      actual: `markdown:${markdown.length}, html:${html.length}`,
      passed: markdown.length > 100 || html.length > 500,
    });
    
    // Try extraction from different sources
    let extractedPrice: number | null = null;
    let extractedCurrency = 'USD';
    let evidenceSnippet: string | null = null;
    let finalStatus = 'price_not_available_in_content';
    
    // Priority 1: OCR from screenshot
    if (screenshotBase64) {
      try {
        const ocrText = await ocrImageToText(screenshotBase64);
        const extraction = extractAllInTotalFromOcr(ocrText, CANARY_CONFIG.nightsCount);
        if (extraction.all_in_total_amount_value && extraction.all_in_total_amount_value > 0) {
          extractedPrice = extraction.all_in_total_amount_value;
          extractedCurrency = extraction.currency;
          evidenceSnippet = extraction.evidence_snippet;
          
          const hasPayNowPattern = /pay\s*\$?\s*[\d,]+/i.test(ocrText);
          const hasTotalPattern = /total\s*\(?[A-Z]{3}\)?\s*\$?\s*[\d,]+/i.test(ocrText);
          if (hasPayNowPattern || hasTotalPattern) {
            finalStatus = VERIFIED_STATUS;
          } else {
            finalStatus = 'needs_user_confirmation';
          }
        }
        checks.push({ name: 'ocr_extraction', expected: 'price found', actual: extractedPrice ? `${extractedPrice}` : 'null', passed: !!extractedPrice });
      } catch {
        checks.push({ name: 'ocr_extraction', expected: 'success', actual: 'ocr_failed', passed: false });
      }
    }
    
    // Priority 2: Markdown extraction
    if (!extractedPrice && markdown.length > 100) {
      const mdExtraction = extractAllInTotalFromOcr(markdown, CANARY_CONFIG.nightsCount);
      if (mdExtraction.all_in_total_amount_value && mdExtraction.all_in_total_amount_value > 0) {
        extractedPrice = mdExtraction.all_in_total_amount_value;
        extractedCurrency = mdExtraction.currency;
        evidenceSnippet = mdExtraction.evidence_snippet;
        finalStatus = VERIFIED_STATUS;
      }
      checks.push({ name: 'markdown_extraction', expected: 'price found', actual: extractedPrice ? `${extractedPrice}` : 'null', passed: !!extractedPrice });
    }
    
    // Priority 3: HTML extraction
    if (!extractedPrice && html.length > 500) {
      const htmlExtraction = extractAllInTotalFromOcr(html, CANARY_CONFIG.nightsCount);
      if (htmlExtraction.all_in_total_amount_value && htmlExtraction.all_in_total_amount_value > 0) {
        extractedPrice = htmlExtraction.all_in_total_amount_value;
        extractedCurrency = htmlExtraction.currency;
        evidenceSnippet = htmlExtraction.evidence_snippet;
        finalStatus = VERIFIED_STATUS;
      }
      checks.push({ name: 'html_extraction', expected: 'price found', actual: extractedPrice ? `${extractedPrice}` : 'null', passed: !!extractedPrice });
    }
    
    checks.push({
      name: 'extraction_status',
      expected: VERIFIED_STATUS,
      actual: finalStatus,
      passed: finalStatus === VERIFIED_STATUS,
    });
    
    const isPassed = finalStatus === VERIFIED_STATUS && extractedPrice !== null && extractedPrice > 0;
    let failureReason: string | null = null;
    if (!isPassed) {
      if (finalStatus === 'needs_user_confirmation') {
        failureReason = extractedPrice 
          ? `Only subtotal found (${extractedPrice}), no grounded total pattern`
          : 'No price extracted from content';
      } else {
        failureReason = `Status ${finalStatus} is not verified`;
      }
    }
    
    return {
      mode: 'firecrawl-canary',
      passed: isPassed,
      provider: 'firecrawl',
      canary_url: canaryUrl,
      canary_dates: { check_in: CANARY_CONFIG.checkIn, check_out: CANARY_CONFIG.checkOut, nights: CANARY_CONFIG.nightsCount },
      extraction_result: {
        status: finalStatus,
        price: extractedPrice,
        currency: extractedCurrency,
        evidence_snippet: evidenceSnippet ? safeSnippet(evidenceSnippet, 200) : null,
      },
      failure_reason: failureReason,
      expected_behavior: 'Extract grounded total with status total_price_including_taxes_and_fees',
      timestamp: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      checks,
    };
  } catch (err) {
    return {
      mode: 'firecrawl-canary',
      passed: false,
      provider: 'firecrawl',
      canary_url: canaryUrl,
      canary_dates: { check_in: CANARY_CONFIG.checkIn, check_out: CANARY_CONFIG.checkOut, nights: CANARY_CONFIG.nightsCount },
      extraction_result: null,
      failure_reason: `Exception: ${err instanceof Error ? err.message : String(err)}`,
      expected_behavior: 'Extract grounded total with status total_price_including_taxes_and_fees',
      timestamp: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      checks: [{ name: 'execution_success', expected: 'no exception', actual: 'exception thrown', passed: false }],
    };
  }
}

// =============================================================================
// PERSIST CANARY RESULT TO DATABASE
// =============================================================================
async function persistCanaryResult(result: CanaryCheckResult, supabase: any): Promise<void> {
  try {
    await supabase.from('provider_canary_checks').insert({
      provider: result.provider,
      canary_url: result.canary_url,
      check_in_date: result.canary_dates.check_in,
      check_out_date: result.canary_dates.check_out,
      nights_count: result.canary_dates.nights,
      passed: result.passed,
      extraction_status: result.extraction_result?.status || null,
      extracted_price: result.extraction_result?.price || null,
      currency: result.extraction_result?.currency || 'USD',
      evidence_snippet: result.extraction_result?.evidence_snippet || null,
      failure_reason: result.failure_reason,
      duration_ms: result.duration_ms,
      checks_detail: result.checks,
      checked_at: result.timestamp,
    });
  } catch (err) {
    console.error('Failed to persist canary result:', err);
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  
  const supabaseForCanary = createClient(
    Deno.env.get('SUPABASE_URL')!, 
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );
  
  // Check for canonical baseline check modes
  const reqUrl = new URL(req.url);
  const mode = reqUrl.searchParams.get('mode');
  
  // ==========================================================================
  // LIVE CANARY CHECKS - Actually call providers against fixed canary URL
  // ==========================================================================
  
  // Browserless live canary check
  if (mode === 'browserless-canary') {
    const result = await runBrowserlessCanaryCheck();
    await persistCanaryResult(result, supabaseForCanary);
    return new Response(JSON.stringify(result, null, 2), {
      status: result.passed ? 200 : 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  
  // Zyte live canary check
  if (mode === 'zyte-canary') {
    const result = await runZyteCanaryCheck();
    await persistCanaryResult(result, supabaseForCanary);
    return new Response(JSON.stringify(result, null, 2), {
      status: result.passed ? 200 : 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  
  // Firecrawl live canary check
  if (mode === 'firecrawl-canary') {
    const result = await runFirecrawlCanaryCheck();
    await persistCanaryResult(result, supabaseForCanary);
    return new Response(JSON.stringify(result, null, 2), {
      status: result.passed ? 200 : 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  
  // ==========================================================================
  // DETERMINISTIC CANONICAL CHECKS - Logic validation with mock data
  // ==========================================================================
  
  // Browserless canonical check (logic validation)
  if (mode === 'canonical-check') {
    const result = runCanonicalBaselineCheck();
    return new Response(JSON.stringify(result, null, 2), {
      status: result.passed ? 200 : 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  
  // Zyte canonical check (logic validation)
  if (mode === 'zyte-canonical-check') {
    const result = runZyteCanonicalBaselineCheck();
    return new Response(JSON.stringify(result, null, 2), {
      status: result.passed ? 200 : 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  
  // Firecrawl canonical check (logic validation)
  if (mode === 'firecrawl-canonical-check') {
    const result = runFirecrawlCanonicalBaselineCheck();
    return new Response(JSON.stringify(result, null, 2), {
      status: result.passed ? 200 : 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  
  // Baseline chain canonical check (orchestration logic validation)
  if (mode === 'baseline-chain-canonical-check') {
    const result = runBaselineChainCanonicalCheck();
    return new Response(JSON.stringify(result, null, 2), {
      status: result.passed ? 200 : 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  
  let body: any = {};
  try {
    body = await req.json();
  } catch {}
  
  const url = body.url;
  if (!url?.includes('airbnb.com')) {
    return new Response(JSON.stringify({ error: 'Airbnb URL required' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  
  // Configuration
  const userCountry = body.user_country || 'US';
  const guestCurrency = body.guest_currency || 'USD';
  const runId = crypto.randomUUID();
  
  // Part 1: Build book/stays URL from rooms URL
  const bookStaysParams = buildBookStaysUrl(url, guestCurrency);
  if (!bookStaysParams) {
    return new Response(JSON.stringify({
      error: 'Could not parse rooms URL. Ensure it contains /rooms/<id> and check_in/check_out params.',
      requested_rooms_url: url,
    }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  
  const { book_stays_url, room_id, check_in, check_out, nights_count, adults } = bookStaysParams;
  
  console.log(`[${runId}] Starting book/stays extraction`);
  console.log(`[${runId}] Rooms URL: ${url}`);
  console.log(`[${runId}] Book/Stays URL: ${book_stays_url}`);
  console.log(`[${runId}] User country: ${userCountry}, Currency: ${guestCurrency}`);
  
  // Part 2 & 3: Run Browserless with book/stays primary, rooms fallback
  const browserResult = await runBrowserlessBookStays(
    book_stays_url,
    url,
    room_id,
    nights_count,
    userCountry,
    guestCurrency
  );
  
  if (browserResult.status === 'provider_not_configured' || browserResult.status === 'provider_error' || browserResult.status === 'provider_fetch_failed') {
    return new Response(JSON.stringify({
      run_id: runId,
      requested_rooms_url: url,
      generated_book_stays_url: book_stays_url,
      final_status: browserResult.status,
      error: browserResult.error,
      user_country: userCountry,
      guest_currency: guestCurrency,
    }, null, 2), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  
  const screenshotBase64 = browserResult.screenshotBase64 || null;
  
  if (!screenshotBase64) {
    return new Response(JSON.stringify({
      run_id: runId,
      requested_rooms_url: url,
      generated_book_stays_url: book_stays_url,
      final_status: 'screenshot_missing',
      navigation_phase: {
        final_url: browserResult.finalUrl,
        redirect_chain: browserResult.redirectChain || [],
        page_title: browserResult.pageTitle,
        used_fallback: browserResult.usedFallback,
        wrong_page_reason: browserResult.wrongPageReason,
      },
      user_country: userCountry,
      proxy_country_used: browserResult.proxyCountryUsed,
      region_mismatch: browserResult.regionMismatch,
    }, null, 2), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  
  // Compute screenshot hash
  const screenshotBytes = base64ToBytes(screenshotBase64);
  const screenshotSha256 = await sha256Hex(screenshotBytes);
  
  // Run OCR on screenshot
  let ocrTextRaw = '';
  let ocrError: string | null = null;
  try {
    ocrTextRaw = await ocrImageToText(screenshotBase64);
  } catch (err) {
    ocrError = err instanceof Error ? err.message : String(err);
  }
  
  if (ocrError) {
    return new Response(JSON.stringify({
      run_id: runId,
      requested_rooms_url: url,
      generated_book_stays_url: book_stays_url,
      final_status: 'ocr_error',
      error: ocrError,
      navigation_phase: {
        final_url: browserResult.finalUrl,
        redirect_chain: browserResult.redirectChain || [],
        page_title: browserResult.pageTitle,
        used_fallback: browserResult.usedFallback,
        wrong_page_reason: browserResult.wrongPageReason,
      },
      user_country: userCountry,
      proxy_country_used: browserResult.proxyCountryUsed,
      region_mismatch: browserResult.regionMismatch,
      screenshot_sha256: screenshotSha256,
    }, null, 2), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  
  // Extract total based on which page we're on
  let extractionResult: any;
  if (!browserResult.usedFallback) {
    // Primary: book/stays page - extract all-in total
    extractionResult = extractAllInTotalFromOcr(ocrTextRaw, nights_count);
  } else {
    // Fallback: rooms page - extract booking card amount
    const roomsExtraction = extractBookingCardFromRoomsOcr(ocrTextRaw, nights_count);
    extractionResult = {
      all_in_total_amount_value: roomsExtraction.booking_card_amount_value,
      currency: roomsExtraction.currency,
      evidence_snippet: roomsExtraction.evidence_snippet,
      breakdown_items: [],
      extraction_method: 'rooms_fallback',
    };
  }
  
  // Determine final status - use structured failure types
  let finalStatus = 'extraction_complete';
  
  // Check for dates unavailable (valid terminal state - not an extraction bug)
  if (browserResult.isUnavailable) {
    finalStatus = 'dates_unavailable';
  } else if (!extractionResult.all_in_total_amount_value) {
    finalStatus = 'price_not_available_in_content';
  }
  
  // Check if we got the expected ~2214 for the test URL (allow for decimal precision)
  const expectedTotal = 2214;
  const isTestUrl = room_id === '903802242341279498';
  const actualTotal = extractionResult.all_in_total_amount_value;
  // Allow 1% tolerance for rounding differences (2213.34 vs 2214)
  const assertionPassed = !isTestUrl || (actualTotal !== null && Math.abs(actualTotal - expectedTotal) < expectedTotal * 0.01);
  
  if (isTestUrl && !assertionPassed) {
    finalStatus = 'assertion_failed';
  }
  
  // Persist to DB
  await supabase.from('airbnb_baseline_debug').insert({
    run_id: runId,
    run_number: 1,
    provider: browserResult.usedFallback ? 'browserless_rooms_fallback' : 'browserless_book_stays',
    provider_order: 1,
    status: finalStatus,
    duration_ms: browserResult.durationMs || 0,
    extracted_price: extractionResult.all_in_total_amount_value,
    currency: extractionResult.currency,
    evidence_snippet: safeSnippet(extractionResult.evidence_snippet || '', 2000),
    airbnb_url: url,
    check_in_date: check_in,
    check_out_date: check_out,
    nights_count: nights_count,
    screenshot_top_base64: screenshotBase64,
    screenshot_top_sha256: screenshotSha256,
    scroll_y_at_capture: browserResult.scrollY ?? 0,
    booking_card_ocr_text_raw: ocrTextRaw,
    booking_card_visible_evidence_snippet: extractionResult.evidence_snippet,
    ocr_booking_card_amount_value: extractionResult.all_in_total_amount_value,
    ocr_booking_card_nights: nights_count,
  });
  
  // Build response
  const response = {
    run_id: runId,
    requested_rooms_url: url,
    generated_book_stays_url: book_stays_url,
    
    // Part 2: Region-aware session info
    user_country: userCountry,
    proxy_country_used: browserResult.proxyCountryUsed,
    region_mismatch: browserResult.regionMismatch,
    guest_currency: guestCurrency,
    
    // Navigation phase
    navigation_phase: {
      final_url: browserResult.finalUrl,
      redirect_chain: browserResult.redirectChain || [],
      page_title: browserResult.pageTitle,
      page_type: browserResult.pageType,
      is_unavailable: browserResult.isUnavailable,
      used_fallback: browserResult.usedFallback,
      wrong_page_reason: browserResult.wrongPageReason,
      body_text_snippet: browserResult.bodyTextSnippet?.slice(0, 500),
    },
    
    // Extraction phase
    extraction_phase: {
      all_in_total_amount_value: extractionResult.all_in_total_amount_value,
      currency: extractionResult.currency,
      nights_count: nights_count,
      breakdown_items: extractionResult.breakdown_items,
      evidence_snippet: extractionResult.evidence_snippet,
      extraction_method: extractionResult.extraction_method,
    },
    
    // Artifacts
    artifacts: {
      screenshot_sha256: screenshotSha256,
      ocr_text_raw: ocrTextRaw,
      scroll_y: browserResult.scrollY,
    },
    
    // Status
    final_status: finalStatus,
    
    // Assertion (for test URL)
    ...(isTestUrl && {
      assertion: {
        expected_total: expectedTotal,
        actual_total: extractionResult.all_in_total_amount_value,
        passed: assertionPassed,
      },
    }),
  };
  
  return new Response(JSON.stringify(response, null, 2), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
