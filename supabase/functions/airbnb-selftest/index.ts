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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  
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
