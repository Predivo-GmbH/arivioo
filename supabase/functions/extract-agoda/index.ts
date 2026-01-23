import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

/**
 * ============================================================================
 * AGODA GOLDEN PATH EXTRACTOR v3.1
 * ============================================================================
 * 
 * NEW APPROACH: Use the actual hotel URL as entrypoint, find the real checkout 
 * link on the page, and extract total from the checkout page.
 * 
 * FLOW:
 * 1. Append date/occupancy params to the original hotel URL
 * 2. Fetch hotel page, locate the real checkout/book CTA href
 * 3. Follow that href to get the checkout page
 * 4. Extract "Total Price" from the checkout page
 * 
 * NO LONGER BUILDS FAKE /book/{slug}/ URLs
 */

// Secure CORS
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
  | 'hotel_page_not_reached'
  | 'checkout_link_not_found'
  | 'checkout_page_not_reached'
  | 'total_price_not_found'
  | 'price_not_found'
  | 'render_failed'
  | 'validation_error';

// Failure category for admin dashboard
type FailureCategory = 
  | 'blocked'
  | 'params_missing'
  | 'selector_not_found'
  | 'missing_checkout_link'
  | 'no_price'
  | 'unavailable'
  | 'render_error'
  | 'success';

type Provider = 'browserless' | 'zyte' | 'firecrawl';

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
  hotel_page_reached: boolean;
  checkout_link_found: boolean;
  checkout_url_found: string | null;
  checkout_page_reached: boolean;
  dates_injected: boolean;
  dates_visible_on_page: boolean;
  total_price_label_found: boolean;
  room_price_nights_found: boolean;
  taxes_service_visible: boolean;
  directly_comparable: boolean;
  proof_version: string;
  currency_detected: string | null;
  nights_detected: number | null;
  entry_hotel_url_used: string | null;
  final_url_fetched: string | null;
  content_hash: string | null;
  failure_category: FailureCategory;
  extraction_method: string | null;
  selector_matched: string | null;
}

interface ExtractionRequest {
  extractionId?: string;
  url?: string;
  checkoutUrl?: string;  // Direct checkout URL (bypasses hotel page)
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

/**
 * Parse currency amount from string like "5,095.34" or "5.095,34"
 * Handles both US (1,234.56) and European (1.234,56) formats
 */
function parseCurrencyAmount(amountStr: string): number | null {
  if (!amountStr) return null;
  
  // Remove spaces
  let cleaned = amountStr.trim();
  
  // Detect format: if last separator is comma and has 2 digits after, it's European
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  
  if (lastComma > lastDot && cleaned.length - lastComma === 3) {
    // European format: 5.095,34 -> 5095.34
    cleaned = cleaned.replace(/\./g, '').replace(',', '.');
  } else {
    // US format: 5,095.34 -> 5095.34
    cleaned = cleaned.replace(/,/g, '');
  }
  
  const value = parseFloat(cleaned);
  return isNaN(value) ? null : value;
}

// ============================================================================
// URL BUILDING - ADDS PARAMS TO HOTEL URL (NO FAKE /book/ URLS)
// ============================================================================

interface AgodaHotelUrl {
  hotelUrlWithParams: string;
  nights: number;
}

interface AgodaSearchUrl {
  searchUrl: string;
  propertyId: string | null;
  cityId: string | null;
  nights: number;
}

/**
 * Build hotel URL with date/occupancy params
 * 
 * Example input: https://www.agoda.com/en-sg/sapphire-elegance/hotel/cashiers-us.html
 * Example output: https://www.agoda.com/en-sg/sapphire-elegance/hotel/cashiers-us.html?checkIn=2026-06-23&checkOut=2026-06-28&adults=2&rooms=1&currency=USD
 */
function buildHotelUrlWithParams(
  originalUrl: string,
  checkIn: string,
  checkOut: string,
  adults: number = 2,
  children: number = 0,
  rooms: number = 1
): AgodaHotelUrl {
  const nights = calculateNights(checkIn, checkOut);
  
  try {
    const urlObj = new URL(originalUrl);
    
    // Set required booking params
    urlObj.searchParams.set('checkIn', checkIn);
    urlObj.searchParams.set('checkOut', checkOut);
    urlObj.searchParams.set('los', String(nights));
    urlObj.searchParams.set('adults', String(adults));
    urlObj.searchParams.set('children', String(children));
    urlObj.searchParams.set('rooms', String(rooms));
    urlObj.searchParams.set('currency', 'USD');
    urlObj.searchParams.set('locale', 'en-us');
    
    console.log(`[AGODA] entry_hotel_url_used: ${urlObj.toString()}`);
    console.log(`[AGODA] Nights: ${nights}, Adults: ${adults}`);
    
    return {
      hotelUrlWithParams: urlObj.toString(),
      nights,
    };
  } catch (e) {
    // If URL parsing fails, just append as query string
    const separator = originalUrl.includes('?') ? '&' : '?';
    const params = `checkIn=${checkIn}&checkOut=${checkOut}&los=${nights}&adults=${adults}&children=${children}&rooms=${rooms}&currency=USD&locale=en-us`;
    const hotelUrlWithParams = `${originalUrl}${separator}${params}`;
    
    console.log(`[AGODA] entry_hotel_url_used: ${hotelUrlWithParams}`);
    return { hotelUrlWithParams, nights };
  }
}

/**
 * Extract property ID from Agoda hotel URL
 * 
 * Example URL patterns:
 * - https://www.agoda.com/en-sg/sapphire-elegance/hotel/cashiers-us.html (slug in path)
 * - URLs with property_id or hotelId query param
 */
function extractPropertyIdFromUrl(url: string): string | null {
  try {
    const urlObj = new URL(url);
    
    // Check query params first
    const hotelId = urlObj.searchParams.get('hotelId') || urlObj.searchParams.get('hotel_id') || urlObj.searchParams.get('propertyId');
    if (hotelId) {
      console.log(`[AGODA] Property ID from query param: ${hotelId}`);
      return hotelId;
    }
    
    // Check for selectedproperty in URL
    const selectedProperty = urlObj.searchParams.get('selectedproperty');
    if (selectedProperty) {
      console.log(`[AGODA] Property ID from selectedproperty: ${selectedProperty}`);
      return selectedProperty;
    }
    
    return null;
  } catch {
    return null;
  }
}

/**
 * Extract property ID from hotel page HTML content
 * Look for data attributes, JSON-LD, or other embedded property identifiers
 */
function extractPropertyIdFromContent(html: string): string | null {
  // Look for property ID in various places
  const patterns = [
    // data-hotelid or data-property-id attributes
    /data-(?:hotel-?id|property-?id)=["'](\d+)["']/i,
    // hotelId in JavaScript variables
    /hotelId["']?\s*[:=]\s*["']?(\d+)["']?/i,
    // propertyId in JSON
    /"propertyId"\s*:\s*["']?(\d+)["']?/i,
    /"hotelId"\s*:\s*["']?(\d+)["']?/i,
    // selectedproperty in links
    /selectedproperty=(\d+)/i,
    // hotel ID in canonical URL
    /hotel-information\?hotelId=(\d+)/i,
  ];
  
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      console.log(`[AGODA] Property ID extracted from content: ${match[1]}`);
      return match[1];
    }
  }
  
  return null;
}

/**
 * Extract city ID from hotel page HTML or URL
 */
function extractCityIdFromContent(html: string): string | null {
  const patterns = [
    /cityId["']?\s*[:=]\s*["']?(\d+)["']?/i,
    /"cityId"\s*:\s*["']?(\d+)["']?/i,
    /city=(\d+)/i,
  ];
  
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      console.log(`[AGODA] City ID extracted: ${match[1]}`);
      return match[1];
    }
  }
  
  return null;
}

/**
 * Build Agoda search URL with selectedproperty parameter
 * This is the key to getting checkout links with encrypted params!
 * 
 * The search page URL format:
 * https://www.agoda.com/en-sg/search?city=CITY_ID&checkIn=DATE&checkOut=DATE&los=N&rooms=1&adults=2&selectedproperty=PROPERTY_ID
 */
function buildSearchUrl(
  propertyId: string,
  cityId: string | null,
  checkIn: string,
  checkOut: string,
  adults: number = 2,
  children: number = 0,
  rooms: number = 1,
  locale: string = 'en-sg'
): AgodaSearchUrl {
  const nights = calculateNights(checkIn, checkOut);
  
  const params = new URLSearchParams({
    cid: '-1',
    aid: '130243',
    checkIn: checkIn,
    checkOut: checkOut,
    los: String(nights),
    rooms: String(rooms),
    adults: String(adults),
    children: String(children),
    travellerType: '-1',
    selectedproperty: propertyId,
    currency: 'USD',
  });
  
  if (cityId) {
    params.set('city', cityId);
  }
  
  const searchUrl = `https://www.agoda.com/${locale}/search?${params.toString()}`;
  
  console.log(`[AGODA] Built search URL: ${searchUrl}`);
  
  return {
    searchUrl,
    propertyId,
    cityId,
    nights,
  };
}

// ============================================================================
// CHECKOUT LINK FINDER
// ============================================================================

interface CheckoutLinkResult {
  found: boolean;
  checkoutUrl: string | null;
  method: string | null;
}

/**
 * Find the real checkout/book link from hotel page HTML content
 * 
 * Agoda checkout URLs have this structure:
 * https://www.agoda.com/en-sg/book/?cnty=181&secdat=...&r0=...&sarg=...
 * 
 * The URL contains encrypted session data, NOT simple /book/{slug}/ paths
 */
function findCheckoutLink(html: string, baseUrl: string): CheckoutLinkResult {
  const result: CheckoutLinkResult = {
    found: false,
    checkoutUrl: null,
    method: null,
  };
  
  // ==========================================================================
  // PRIORITY 1: Full /book/ URLs with encrypted params (secdat, r0, sarg)
  // ==========================================================================
  
  // Look for href containing /book/ with query params like secdat=, cnty=, r0=
  const encryptedBookPatterns = [
    // Full URLs with encrypted booking params
    /href=["'](https?:\/\/[^"']*agoda[^"']*\/book\/\?[^"']*(?:secdat|cnty|r0|sarg)[^"']+)["']/gi,
    // Relative /book/ URLs with params
    /href=["'](\/[^"']*\/book\/\?[^"']*(?:secdat|cnty|r0|sarg)[^"']+)["']/gi,
    // Any URL containing /book/? with substantial query string
    /href=["'](https?:\/\/[^"']*\/book\/\?[^"']{50,})["']/gi,
    /href=["'](\/[^"']*\/book\/\?[^"']{50,})["']/gi,
  ];
  
  for (const pattern of encryptedBookPatterns) {
    const matches = [...html.matchAll(pattern)];
    for (const match of matches) {
      let checkoutUrl = match[1];
      
      // Validate it looks like a real checkout URL (has encrypted params)
      if (checkoutUrl.includes('secdat=') || checkoutUrl.includes('cnty=') || checkoutUrl.includes('r0=')) {
        // Make absolute if relative
        if (checkoutUrl.startsWith('/')) {
          try {
            const baseUrlObj = new URL(baseUrl);
            checkoutUrl = `${baseUrlObj.origin}${checkoutUrl}`;
          } catch {
            checkoutUrl = `https://www.agoda.com${checkoutUrl}`;
          }
        }
        
        result.found = true;
        result.checkoutUrl = checkoutUrl;
        result.method = 'encrypted_book_url';
        console.log(`[AGODA] checkout_url_found: ${checkoutUrl.substring(0, 150)}... (method: ${result.method})`);
        return result;
      }
    }
  }
  
  // ==========================================================================
  // PRIORITY 2: Look for /book/ URLs with less validation
  // ==========================================================================
  
  const bookLinkPatterns = [
    // href="/en-us/book/..." or href="/book/..."
    /href=["']([^"']*\/book\/[^"']+)["']/gi,
    // Full URL book links
    /href=["'](https?:\/\/[^"']*agoda[^"']*\/book\/[^"']+)["']/gi,
  ];
  
  for (const pattern of bookLinkPatterns) {
    const matches = [...html.matchAll(pattern)];
    if (matches.length > 0) {
      let checkoutUrl = matches[0][1];
      
      // Make absolute if relative
      if (checkoutUrl.startsWith('/')) {
        try {
          const baseUrlObj = new URL(baseUrl);
          checkoutUrl = `${baseUrlObj.origin}${checkoutUrl}`;
        } catch {
          checkoutUrl = `https://www.agoda.com${checkoutUrl}`;
        }
      }
      
      result.found = true;
      result.checkoutUrl = checkoutUrl;
      result.method = 'book_href_pattern';
      console.log(`[AGODA] checkout_url_found: ${checkoutUrl.substring(0, 150)}... (method: ${result.method})`);
      return result;
    }
  }
  
  // ==========================================================================
  // PRIORITY 3: Look for JavaScript booking URLs in onclick or data attributes
  // ==========================================================================
  
  const jsBookPatterns = [
    // data-bookurl or similar attributes
    /data-(?:book[-_]?url|checkout[-_]?url|reserve[-_]?url)=["']([^"']+)["']/gi,
    // onclick containing book URL
    /onclick=["'][^"']*(?:location\.href|window\.open)\s*\(\s*["']([^"']*\/book\/[^"']+)["']/gi,
    // data-selenium book button with nearby href
    /data-selenium=["'](?:book|reserve|checkout)[^"']*["'][^>]*href=["']([^"']+)["']/gi,
  ];
  
  for (const pattern of jsBookPatterns) {
    const matches = [...html.matchAll(pattern)];
    if (matches.length > 0) {
      let checkoutUrl = matches[0][1];
      
      // Make absolute if relative
      if (checkoutUrl.startsWith('/')) {
        try {
          const baseUrlObj = new URL(baseUrl);
          checkoutUrl = `${baseUrlObj.origin}${checkoutUrl}`;
        } catch {
          checkoutUrl = `https://www.agoda.com${checkoutUrl}`;
        }
      }
      
      result.found = true;
      result.checkoutUrl = checkoutUrl;
      result.method = 'js_book_pattern';
      console.log(`[AGODA] checkout_url_found: ${checkoutUrl.substring(0, 150)}... (method: ${result.method})`);
      return result;
    }
  }
  
  // ==========================================================================
  // PRIORITY 4: Look for any booking-related anchors
  // ==========================================================================
  
  const bookButtonPatterns = [
    /class=["'][^"']*(?:book-button|reserve-button|cta-book|btn-book)[^"']*["'][^>]*href=["']([^"']+)["']/gi,
    /class=["'][^"']*btn[^"']*["'][^>]*href=["']([^"']*book[^"']*)["']/gi,
  ];
  
  for (const pattern of bookButtonPatterns) {
    const matches = [...html.matchAll(pattern)];
    if (matches.length > 0) {
      let checkoutUrl = matches[0][1];
      
      if (checkoutUrl.startsWith('/')) {
        try {
          const baseUrlObj = new URL(baseUrl);
          checkoutUrl = `${baseUrlObj.origin}${checkoutUrl}`;
        } catch {
          checkoutUrl = `https://www.agoda.com${checkoutUrl}`;
        }
      }
      
      result.found = true;
      result.checkoutUrl = checkoutUrl;
      result.method = 'button_class_pattern';
      console.log(`[AGODA] checkout_url_found: ${checkoutUrl.substring(0, 150)}... (method: ${result.method})`);
      return result;
    }
  }
  
  console.log('[AGODA] checkout_url_found: NOT FOUND');
  return result;
}

// ============================================================================
// PRICE EXTRACTION FROM CHECKOUT/HOTEL PAGE
// ============================================================================

interface PriceExtractionResult {
  extracted: boolean;
  totalPrice: number | null;
  roomPriceNights: number | null;
  taxesServiceAmount: number | null;
  currency: string | null;
  nightsDetected: number | null;
  directlyComparable: boolean;
  includesTaxesFees: boolean;
  evidenceSnippet: string | null;
  extractionMethod: string;
  totalLabelFound: boolean;
  selectorMatched: string | null;
}

/**
 * Extract TOTAL price from page content
 * 
 * Expected patterns:
 * - "Total Price" followed by "USD 5,095.34" or "CHF 4,530.00"
 * - "Room price (5 nights)" followed by subtotal
 */
function extractPrice(content: string, expectedNights: number): PriceExtractionResult {
  const result: PriceExtractionResult = {
    extracted: false,
    totalPrice: null,
    roomPriceNights: null,
    taxesServiceAmount: null,
    currency: null,
    nightsDetected: null,
    directlyComparable: false,
    includesTaxesFees: false,
    evidenceSnippet: null,
    extractionMethod: 'none',
    totalLabelFound: false,
    selectorMatched: null,
  };
  
  // Normalize whitespace for pattern matching
  const normalized = content.replace(/\s+/g, ' ');
  
  // ==========================================================================
  // PATTERN 1: TOTAL PRICE (highest priority, directly comparable)
  // ==========================================================================
  
  const totalPricePatterns: Array<{ pattern: RegExp; name: string }> = [
    { pattern: /total\s*price[^$€£¥]*?([A-Z]{3})\s*([\d,\.]+)/i, name: 'total_price_currency_amount' },
    { pattern: /total\s*price[^$€£¥]*?\$\s*([\d,\.]+)/i, name: 'total_price_dollar' },
    { pattern: /\btotal[^$€£¥]{0,30}([A-Z]{3})\s*([\d,\.]+)/i, name: 'total_currency_amount' },
    { pattern: /grand\s*total[^$€£¥]*?([A-Z]{3})\s*([\d,\.]+)/i, name: 'grand_total_currency' },
    { pattern: /total\s*price[\s\S]{0,50}?([A-Z]{3})\s*([\d,\.]+)/i, name: 'total_price_nearby' },
    { pattern: /pay\s*now[^$€£¥]*?([A-Z]{3})\s*([\d,\.]+)/i, name: 'pay_now_currency' },
    { pattern: /amount\s*due[^$€£¥]*?([A-Z]{3})\s*([\d,\.]+)/i, name: 'amount_due_currency' },
  ];
  
  for (const { pattern, name } of totalPricePatterns) {
    const match = normalized.match(pattern);
    if (match) {
      let currency: string;
      let amountStr: string;
      
      if (match[1] && match[2]) {
        currency = match[1].toUpperCase();
        amountStr = match[2];
      } else if (match[1]) {
        currency = 'USD';
        amountStr = match[1];
      } else {
        continue;
      }
      
      const amount = parseCurrencyAmount(amountStr);
      
      // Validate: reasonable hotel stay price
      if (amount && amount >= 50 && amount <= 100000) {
        result.extracted = true;
        result.totalPrice = amount;
        result.currency = currency;
        result.directlyComparable = true;
        result.includesTaxesFees = true;
        result.extractionMethod = 'total_price_label';
        result.totalLabelFound = true;
        result.selectorMatched = name;
        
        // Extract evidence snippet
        const matchIndex = normalized.indexOf(match[0]);
        const start = Math.max(0, matchIndex - 20);
        const end = Math.min(normalized.length, matchIndex + match[0].length + 40);
        result.evidenceSnippet = normalized.slice(start, end).trim();
        
        console.log(`[AGODA] selector_matched: ${name}`);
        console.log(`[AGODA] Total Price found: ${currency} ${amount}`);
        return result;
      }
    }
  }
  
  // ==========================================================================
  // TOTAL-ONLY POLICY: do not accept room subtotals or per-night displays.
  // If we cannot find a checkout "Total Price" (incl. taxes/fees) we treat it as no-price.

  console.log('[AGODA] No TOTAL price pattern matched');
  return result;
}

// ============================================================================
// PROVIDER FETCHING
// ============================================================================

interface FetchResult {
  content: string;
  html: string;
  error?: string;
  httpStatus?: number;
  navigatedUrl?: string;  // URL after navigation/click
}

async function fetchWithBrowserless(url: string, waitMs: number = 6000): Promise<FetchResult> {
  const browserlessApiKey = Deno.env.get('BROWSERLESS_API_KEY');
  
  if (!browserlessApiKey) {
    return { content: '', html: '', error: 'Browserless API key not configured' };
  }
  
  try {
    console.log(`[AGODA] Browserless fetching: ${url}`);
    
    const response = await fetch(`https://chrome.browserless.io/content?token=${browserlessApiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        waitFor: waitMs,
        gotoOptions: {
          waitUntil: 'networkidle2',
          timeout: 35000,
        },
      }),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[AGODA] Browserless error ${response.status}: ${errorText.substring(0, 200)}`);
      return { content: '', html: '', error: `Browserless error: ${response.status}`, httpStatus: response.status };
    }
    
    const html = await response.text();
    
    // Convert HTML to text
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    
    console.log(`[AGODA] Browserless fetched contentLength: ${html.length} (text: ${text.length})`);
    return { content: text, html, httpStatus: response.status };
    
  } catch (error) {
    console.error('[AGODA] Browserless fetch error:', error);
    return { content: '', html: '', error: error instanceof Error ? error.message : 'Browserless fetch failed' };
  }
}

/**
 * Browserless /function API - runs custom Puppeteer code to click booking button
 * and capture the resulting checkout URL with encrypted params
 * 
 * This is the KEY to automating Agoda checkout URL discovery!
 * The search page has JS-rendered booking buttons that generate checkout URLs 
 * with encrypted secdat/r0/sarg params only when clicked.
 */
async function clickBookingButtonWithBrowserless(searchUrl: string): Promise<FetchResult & { checkoutUrlDiscovered?: string }> {
  const browserlessApiKey = Deno.env.get('BROWSERLESS_API_KEY');
  
  if (!browserlessApiKey) {
    return { content: '', html: '', error: 'Browserless API key not configured' };
  }
  
  try {
    console.log(`[AGODA] Browserless /function API - clicking booking button on: ${searchUrl}`);
    
    // Custom Puppeteer code to:
    // 1. Navigate to search page
    // 2. Wait for JS to render booking buttons
    // 3. Click the first "Book Now" / "Reserve" button
    // 4. Capture the URL it navigates to (checkout URL with encrypted params)
    // 5. Get page content after navigation
    const puppeteerCode = `
export default async ({ page }) => {
  let checkoutUrl = null;
  let pageContent = '';
  let pageHtml = '';
  let error = null;
  let debugInfo = { selectorsChecked: [], elementsFound: {}, timing: {} };
  
  try {
    // Make the session look like a normal desktop browser, and keep it fast.
    await page.setViewport({ width: 1440, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'accept-language': 'en-US,en;q=0.9' });

    // Speed: block heavy assets.
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const rt = req.resourceType();
      if (rt === 'image' || rt === 'media' || rt === 'font') return req.abort();
      return req.continue();
    });

    // Light stealth (not full stealth plugin, but helps)
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    
    debugInfo.timing.navigationStart = Date.now();
    
    // Navigate (avoid networkidle0; Agoda can keep long-polling open)
    await page.goto('${searchUrl.replace(/'/g, "\\'")}', {
      waitUntil: 'domcontentloaded',
      timeout: 25000,
    });
    
    debugInfo.timing.navigationEnd = Date.now();
    
    // CRITICAL: Dismiss cookie consent modal first - it blocks interaction!
    const consentSelectors = [
      '[data-element-name="consent-banner-reject-btn"]',
      'button.BtnPair__RejectBtn',
      '[data-modal-action="continue"]',
      'button:has-text("Dismiss")',
      '.ConsentBannerFunctionalOnly button',
    ];
    
    for (const sel of consentSelectors) {
      try {
        const consentBtn = await page.$(sel);
        if (consentBtn) {
          await consentBtn.click();
          console.log('Dismissed consent modal with:', sel);
          debugInfo.elementsFound.consentDismissed = sel;
          await new Promise(r => setTimeout(r, 1000));
          break;
        }
      } catch (e) {}
    }
    
    // Small settle time for hydration
    await new Promise(r => setTimeout(r, 2500));
    
    // Wait for at least one anchor/button to exist (page hydrated)
    try {
      await page.waitForSelector('a, button', { timeout: 12000 });
    } catch (e) {}

    // FAST PATH: If a real checkout URL is already present in the live DOM, use it.
    const directCheckout = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a'));
      const candidates = anchors
        .map((a) => (a instanceof HTMLAnchorElement ? a.href : ''))
        .filter(Boolean)
        .filter((h) => h.includes('/book/') && (h.includes('secdat=') || h.includes('r0=') || h.includes('sarg=')));
      return candidates[0] || null;
    });

    if (directCheckout) {
      checkoutUrl = directCheckout;
      console.log('Found checkout URL directly in DOM:', checkoutUrl.substring(0, 120));
      await page.goto(checkoutUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await new Promise(r => setTimeout(r, 2500));
      pageContent = await page.evaluate(() => document.body.innerText);
      pageHtml = await page.evaluate(() => document.body.innerHTML);

      return {
        data: {
          checkoutUrl,
          pageContent: pageContent.substring(0, 350000),
          pageHtml: pageHtml.substring(0, 350000),
          error,
          finalUrl: page.url(),
          debugInfo,
        },
      };
    }
    
    // STRATEGY 1: Find and click the first property card (whole card is clickable)
    // Agoda property cards navigate to /book/ when clicked
    const cardSelectors = [
      'li.PropertyCardItem a[href*="/book/"]',
      'li.PropertyCardItem[data-hotelid] a',
      '.PropertyCard a[href*="/book/"]',
      '[data-element-name="property-card"] a[href*="/book/"]',
      'a[href*="/book/?cnty="]',
      'a[href*="/book/?"][href*="secdat="]',
    ];
    
    let clickableElement = null;
    for (const selector of cardSelectors) {
      debugInfo.selectorsChecked.push(selector);
      try {
        clickableElement = await page.$(selector);
        if (clickableElement) {
          debugInfo.elementsFound.cardLink = selector;
          console.log('Found clickable card with:', selector);
          break;
        }
      } catch (e) {}
    }
    
    // STRATEGY 2: Find book/reserve buttons within property cards
    if (!clickableElement) {
      const buttonSelectors = [
        '[data-selenium="book-button"]',
        '[data-element-name="book-cta"]',
        'button[class*="BookButton"]',
        'button[class*="book"]',
        '.cta-button',
        '.PropertyCardPrice button',
        '.PropertyCard button',
      ];
      
      for (const selector of buttonSelectors) {
        debugInfo.selectorsChecked.push(selector);
        try {
          clickableElement = await page.$(selector);
          if (clickableElement) {
            debugInfo.elementsFound.button = selector;
            console.log('Found book button with:', selector);
            break;
          }
        } catch (e) {}
      }
    }
    
    // STRATEGY 3: Find any /book/ links on the page
    if (!clickableElement) {
      const bookLinks = await page.$$('a[href*="/book/"]');
      debugInfo.elementsFound.bookLinkCount = bookLinks.length;
      
      if (bookLinks.length > 0) {
        clickableElement = bookLinks[0];
        console.log('Found /book/ link, total count:', bookLinks.length);
      }
    }
    
    // STRATEGY 4: Click the first property card itself
    if (!clickableElement) {
      const propertyCardSelectors = [
        'li.PropertyCardItem',
        '.PropertyCard',
        '[data-element-name="property-card"]',
      ];
      
      for (const selector of propertyCardSelectors) {
        debugInfo.selectorsChecked.push(selector);
        try {
          clickableElement = await page.$(selector);
          if (clickableElement) {
            debugInfo.elementsFound.propertyCard = selector;
            console.log('Will click property card:', selector);
            break;
          }
        } catch (e) {}
      }
    }
    
    // STRATEGY 5: Use text content search for "Book" or price elements
    if (!clickableElement) {
      clickableElement = await page.evaluateHandle(() => {
        // Look for any element with "Book" text that's likely a button
        const allElements = document.querySelectorAll('a, button, [role="button"]');
        for (const el of allElements) {
          const text = (el.textContent || '').trim().toLowerCase();
          if (text === 'book' || text === 'book now' || text === 'reserve' || text === 'see deal') {
            return el;
          }
        }
        // Fallback: find first link that might go to booking
        const links = document.querySelectorAll('a');
        for (const link of links) {
          if (link.href && link.href.includes('/book/')) {
            return link;
          }
        }
        return null;
      });
      
      const isValid = await clickableElement.evaluate(el => el !== null);
      if (!isValid) {
        clickableElement = null;
      } else {
        console.log('Found element via text/href search');
        debugInfo.elementsFound.textSearch = true;
      }
    }
    
    if (clickableElement) {
      // Get href if it's a link (to capture checkout URL directly)
      const href = await clickableElement.evaluate(el => el.href || null).catch(() => null);
      
      if (href && href.includes('/book/')) {
        // We found the checkout URL directly from href!
        checkoutUrl = href;
        console.log('Got checkout URL directly from href:', checkoutUrl.substring(0, 100));
        
        // Navigate to it to get the page content
        await page.goto(checkoutUrl, { waitUntil: 'networkidle2', timeout: 35000 });
        await new Promise(r => setTimeout(r, 3000));
        pageContent = await page.evaluate(() => document.body.innerText);
        pageHtml = await page.evaluate(() => document.body.innerHTML);
      } else {
        // Click and capture navigation
        const navigationPromise = page.waitForNavigation({ 
          waitUntil: 'networkidle2',
          timeout: 25000 
        }).catch(() => null);
        
        await clickableElement.click();
        console.log('Clicked element, waiting for navigation...');
        
        await navigationPromise;
        
        checkoutUrl = page.url();
        console.log('Navigated to:', checkoutUrl);
        
        if (checkoutUrl && checkoutUrl.includes('/book/')) {
          await new Promise(r => setTimeout(r, 3000));
          pageContent = await page.evaluate(() => document.body.innerText);
          pageHtml = await page.evaluate(() => document.body.innerHTML);
        }
      }
    } else {
      error = 'No booking button or checkout link found';
      
      // Capture debug info about what's on the page
      const pageDebug = await page.evaluate(() => {
        return {
          propertyCards: document.querySelectorAll('li.PropertyCardItem').length,
          allLinks: document.querySelectorAll('a').length,
          bookLinks: document.querySelectorAll('a[href*="/book/"]').length,
          buttons: document.querySelectorAll('button').length,
          bodyTextPreview: document.body.innerText.substring(0, 500),
        };
      });
      debugInfo.pageState = pageDebug;
      console.log('Page debug:', JSON.stringify(pageDebug));
      
      pageContent = await page.evaluate(() => document.body.innerText);
    }
    
  } catch (err) {
    error = err.message || 'Unknown error during click navigation';
    console.error('Error:', error);
    
    try {
      pageContent = await page.evaluate(() => document.body.innerText);
    } catch (e) {}
  }
  
  return {
    data: {
      checkoutUrl,
      pageContent: pageContent.substring(0, 350000),
      pageHtml: pageHtml.substring(0, 350000),
      error,
      finalUrl: page.url(),
      debugInfo,
    },
  };
};
`;
    
    const response = await fetch(`https://chrome.browserless.io/function?token=${browserlessApiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/javascript' },
      body: puppeteerCode,
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[AGODA] Browserless /function error ${response.status}: ${errorText.substring(0, 500)}`);
      return { content: '', html: '', error: `Browserless function error: ${response.status}`, httpStatus: response.status };
    }
    
    const result = await response.json();
    
    if (result.data) {
      const { checkoutUrl, pageContent, pageHtml, error: fnError, finalUrl } = result.data;
      
      console.log(`[AGODA] Browserless /function result: checkoutUrl=${checkoutUrl?.substring(0, 80) || 'none'}, contentLength=${pageContent?.length || 0}`);
      
      if (fnError && !checkoutUrl) {
        return { 
          content: pageContent || '', 
          html: pageHtml || '', 
          error: fnError,
          navigatedUrl: finalUrl,
        };
      }
      
      return {
        content: pageContent || '',
        html: pageHtml || '',
        httpStatus: 200,
        navigatedUrl: finalUrl,
        checkoutUrlDiscovered: checkoutUrl && checkoutUrl.includes('/book/') ? checkoutUrl : undefined,
      };
    }
    
    return { content: '', html: '', error: 'Browserless function returned no data' };
    
  } catch (error) {
    console.error('[AGODA] Browserless /function error:', error);
    return { content: '', html: '', error: error instanceof Error ? error.message : 'Browserless function failed' };
  }
}

/**
 * Legacy method - fetch with wait selector (doesn't click)
 * Kept for fallback compatibility
 */
async function fetchWithBrowserlessAndClick(url: string): Promise<FetchResult> {
  const browserlessApiKey = Deno.env.get('BROWSERLESS_API_KEY');
  
  if (!browserlessApiKey) {
    return { content: '', html: '', error: 'Browserless API key not configured' };
  }
  
  try {
    console.log(`[AGODA] Browserless legacy scrape: ${url}`);
    
    // Use Browserless /scrape API with waitForSelector instead of waitFor
    const response = await fetch(`https://chrome.browserless.io/scrape?token=${browserlessApiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        gotoOptions: {
          waitUntil: 'networkidle2',
          timeout: 40000,
        },
        waitForSelector: {
          selector: 'body',
          timeout: 8000,
        },
        elements: [
          { selector: 'body', timeout: 5000 }
        ],
      }),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[AGODA] Browserless scrape error ${response.status}: ${errorText.substring(0, 300)}`);
      return { content: '', html: '', error: `Browserless scrape error: ${response.status}`, httpStatus: response.status };
    }
    
    const result = await response.json();
    
    // Get content from elements
    let html = '';
    let text = '';
    
    if (result.data && Array.isArray(result.data)) {
      for (const element of result.data) {
        if (element.results && Array.isArray(element.results)) {
          for (const r of element.results) {
            if (r.html) html += r.html;
            if (r.text) text += r.text + ' ';
          }
        }
      }
    }
    
    // Fallback if structured data not available
    if (!text && !html) {
      text = JSON.stringify(result);
    }
    
    console.log(`[AGODA] Browserless scrape result: contentLength: ${text.length}`);
    
    return { 
      content: text.trim(), 
      html, 
      httpStatus: response.status,
    };
    
  } catch (error) {
    console.error('[AGODA] Browserless scrape error:', error);
    return { content: '', html: '', error: error instanceof Error ? error.message : 'Browserless scrape failed' };
  }
}

async function fetchWithZyte(url: string): Promise<FetchResult> {
  const zyteApiKey = Deno.env.get('ZYTE_API_KEY');
  
  if (!zyteApiKey) {
    return { content: '', html: '', error: 'Zyte API key not configured' };
  }
  
  try {
    console.log(`[AGODA] Zyte fetching: ${url}`);
    
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
          { action: 'waitForTimeout', timeout: 6000 }
        ],
      }),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[AGODA] Zyte error ${response.status}: ${errorText.substring(0, 200)}`);
      return { content: '', html: '', error: `Zyte error: ${response.status}`, httpStatus: response.status };
    }
    
    const data = await response.json();
    const html = data.browserHtml || '';
    
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    
    console.log(`[AGODA] Zyte fetched contentLength: ${html.length} (text: ${text.length})`);
    return { content: text, html, httpStatus: response.status };
    
  } catch (error) {
    console.error('[AGODA] Zyte fetch error:', error);
    return { content: '', html: '', error: error instanceof Error ? error.message : 'Zyte fetch failed' };
  }
}

async function fetchWithFirecrawl(url: string, waitMs: number = 5000): Promise<FetchResult> {
  const firecrawlApiKey = Deno.env.get('FIRECRAWL_API_KEY_1') || Deno.env.get('FIRECRAWL_API_KEY');
  
  if (!firecrawlApiKey) {
    return { content: '', html: '', error: 'Firecrawl API key not configured' };
  }
  
  try {
    console.log(`[AGODA] Firecrawl fetching: ${url}`);
    
    const response = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${firecrawlApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url,
        formats: ['markdown', 'html'],
        onlyMainContent: false,
        waitFor: waitMs,
        timeout: Math.max(15000, waitMs * 2.5),
      }),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[AGODA] Firecrawl error ${response.status}: ${errorText.substring(0, 200)}`);
      return { content: '', html: '', error: `Firecrawl error: ${response.status}`, httpStatus: response.status };
    }
    
    const data = await response.json();
    const markdown = data.data?.markdown || data.markdown || '';
    const html = data.data?.html || data.html || '';
    
    console.log(`[AGODA] Firecrawl fetched contentLength: ${markdown.length}`);
    return { content: markdown, html, httpStatus: response.status };
    
  } catch (error) {
    console.error('[AGODA] Firecrawl fetch error:', error);
    return { content: '', html: '', error: error instanceof Error ? error.message : 'Firecrawl fetch failed' };
  }
}

// ============================================================================
// PAGE STATE ANALYSIS
// ============================================================================

interface PageStateResult {
  isCheckoutPage: boolean;
  isPropertyPage: boolean;
  botBlocked: boolean;
  soldOut: boolean;
  datesVisible: boolean;
  contentLength: number;
}

function analyzePageState(content: string, url: string): PageStateResult {
  const lower = content.toLowerCase();
  
  const result: PageStateResult = {
    isCheckoutPage: url.includes('/book/') || lower.includes('booking confirmation') || lower.includes('complete your booking') || lower.includes('total price'),
    isPropertyPage: !url.includes('/book/') && (lower.includes('room type') || lower.includes('per night') || lower.includes('select room')),
    botBlocked: false,
    soldOut: false,
    datesVisible: false,
    contentLength: content.length,
  };
  
  // Bot detection
  const botIndicators = [
    'access denied',
    'please verify you are human',
    'captcha',
    'security check',
    'unusual traffic',
  ];
  result.botBlocked = botIndicators.some(ind => lower.includes(ind));
  
  // Sold out detection
  const soldOutPatterns = [
    /this property is fully booked/i,
    /no rooms? available/i,
    /sold out for your dates/i,
    /not available for selected dates/i,
  ];
  result.soldOut = soldOutPatterns.some(p => p.test(content));
  
  // Check if dates are visible
  result.datesVisible = /\d{4}-\d{2}-\d{2}/.test(content) || 
                        /(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d{1,2}/i.test(content);
  
  return result;
}

// ============================================================================
// MAIN EXTRACTION FUNCTION
// ============================================================================

const PROVIDER_ORDER: Provider[] = ['firecrawl', 'browserless', 'zyte'];
const MIN_CONTENT_LENGTH = 2000;

async function extractFromAgoda(
  originalUrl: string,
  checkIn: string,
  checkOut: string,
  adults: number = 2,
  children: number = 0,
  rooms: number = 1
): Promise<ExtractionResult> {
  const startTime = Date.now();
  const nights = calculateNights(checkIn, checkOut);
  const providerAttempts: ProviderAttemptTrace[] = [];
  
  // Initialize result
  const result: ExtractionResult = {
    success: false,
    status: 'validation_error',
    failureCategory: 'render_error',
    extractedPrice: null,
    currency: null,
    includesTaxesFees: null,
    directlyComparable: false,
    evidenceSnippet: null,
    structuralProof: {
      hotel_page_reached: false,
      checkout_link_found: false,
      checkout_url_found: null,
      checkout_page_reached: false,
      dates_injected: true,
      dates_visible_on_page: false,
      total_price_label_found: false,
      room_price_nights_found: false,
      taxes_service_visible: false,
      directly_comparable: false,
      proof_version: 'agoda-golden-path-v3.1',
      currency_detected: null,
      nights_detected: nights,
      entry_hotel_url_used: null,
      final_url_fetched: null,
      content_hash: null,
      failure_category: 'render_error',
      extraction_method: null,
      selector_matched: null,
    },
    durationMs: 0,
    error: null,
    providerAttempts: [],
    goldenPath: true,
  };
  
  try {
    // Build hotel URL with params (NO FAKE /book/ URLS)
    const urlData = buildHotelUrlWithParams(originalUrl, checkIn, checkOut, adults, children, rooms);
    result.structuralProof.entry_hotel_url_used = urlData.hotelUrlWithParams;
    
    // ========================================================================
    // PHASE 1: Fetch hotel page to find checkout link
    // ========================================================================
    
    console.log('[AGODA] Phase 1: Fetching hotel page to find checkout link');
    
    let hotelPageContent = '';
    let hotelPageHtml = '';
    let hotelPageProvider: Provider | null = null;
    
    for (const provider of PROVIDER_ORDER) {
      const attemptTrace: ProviderAttemptTrace = {
        provider,
        attempted: true,
        attemptIndex: providerAttempts.length,
        startedAt: new Date().toISOString(),
        endedAt: null,
        outcome: 'navigation_failed',
        httpStatus: null,
        contentLength: null,
        errorMessage: null,
        urlUsed: urlData.hotelUrlWithParams,
      };
      
      let fetchResult: FetchResult;
      
      switch (provider) {
        case 'browserless':
          fetchResult = await fetchWithBrowserless(urlData.hotelUrlWithParams, 6000);
          break;
        case 'zyte':
          fetchResult = await fetchWithZyte(urlData.hotelUrlWithParams);
          break;
        case 'firecrawl':
          fetchResult = await fetchWithFirecrawl(urlData.hotelUrlWithParams, 5000);
          break;
      }
      
      attemptTrace.endedAt = new Date().toISOString();
      attemptTrace.httpStatus = fetchResult.httpStatus || null;
      attemptTrace.contentLength = fetchResult.content.length;
      
      if (fetchResult.error) {
        attemptTrace.errorMessage = fetchResult.error;
        attemptTrace.outcome = 'navigation_failed';
        providerAttempts.push(attemptTrace);
        console.log(`[AGODA] ${provider} failed for hotel page: ${fetchResult.error}`);
        continue;
      }
      
      if (fetchResult.content.length < MIN_CONTENT_LENGTH) {
        attemptTrace.outcome = 'insufficient_content';
        attemptTrace.errorMessage = `Content too short: ${fetchResult.content.length} chars`;
        providerAttempts.push(attemptTrace);
        continue;
      }
      
      const pageState = analyzePageState(fetchResult.content, urlData.hotelUrlWithParams);
      
      if (pageState.botBlocked) {
        attemptTrace.outcome = 'bot_blocked';
        attemptTrace.errorMessage = 'Bot detection triggered';
        providerAttempts.push(attemptTrace);
        continue;
      }
      
      if (pageState.soldOut) {
        attemptTrace.outcome = 'sold_out';
        attemptTrace.errorMessage = 'Property sold out for dates';
        providerAttempts.push(attemptTrace);
        result.status = 'dates_unavailable';
        result.error = 'Property not available for selected dates';
        result.failureCategory = 'unavailable';
        result.structuralProof.failure_category = 'unavailable';
        result.durationMs = Date.now() - startTime;
        result.providerAttempts = providerAttempts;
        return result;
      }
      
      // Success - got hotel page content
      attemptTrace.outcome = 'success';
      providerAttempts.push(attemptTrace);
      hotelPageContent = fetchResult.content;
      hotelPageHtml = fetchResult.html;
      hotelPageProvider = provider;
      result.structuralProof.hotel_page_reached = true;
      result.structuralProof.dates_visible_on_page = pageState.datesVisible;
      result.structuralProof.content_hash = simpleHash(fetchResult.content);
      console.log(`[AGODA] ${provider} succeeded for hotel page: ${hotelPageContent.length} chars`);
      break;
    }
    
    if (!hotelPageContent) {
      // All providers failed for hotel page - try SEARCH PAGE FALLBACK directly
      // The search page often works when hotel page is blocked
      console.log('[AGODA] Phase 1B: Hotel page failed - trying search page fallback');
      
      // Try to extract property ID from URL itself (some URLs have it)
      const propertyIdFromUrl = extractPropertyIdFromUrl(originalUrl);
      
      // If we can't get property ID from URL, we need to try with a generated search URL
      // Use the hotel slug to build a search query
      const urlSlugMatch = originalUrl.match(/\/([^\/]+)\/hotel\/([^\/]+)\.html/);
      const hotelSlug = urlSlugMatch ? urlSlugMatch[1] : null;
      
      console.log(`[AGODA] PropertyId from URL: ${propertyIdFromUrl}, Hotel slug: ${hotelSlug}`);
      
      // Build a fallback search URL using the hotel page URL with search path
      // Example: /search?q=sapphire-elegance&checkIn=...
      const fallbackSearchUrl = new URL('https://www.agoda.com/en-sg/search');
      fallbackSearchUrl.searchParams.set('checkIn', checkIn);
      fallbackSearchUrl.searchParams.set('checkOut', checkOut);
      fallbackSearchUrl.searchParams.set('los', String(nights));
      fallbackSearchUrl.searchParams.set('rooms', String(rooms));
      fallbackSearchUrl.searchParams.set('adults', String(adults));
      fallbackSearchUrl.searchParams.set('children', String(children));
      fallbackSearchUrl.searchParams.set('currency', 'USD');
      if (hotelSlug) {
        fallbackSearchUrl.searchParams.set('textToSearch', hotelSlug.replace(/-/g, ' '));
      }
      if (propertyIdFromUrl) {
        fallbackSearchUrl.searchParams.set('selectedproperty', propertyIdFromUrl);
      }
      
      console.log(`[AGODA] Fallback search URL: ${fallbackSearchUrl.toString()}`);
      
      // Try to fetch search page
      for (const provider of PROVIDER_ORDER) {
        const attemptTrace: ProviderAttemptTrace = {
          provider,
          attempted: true,
          attemptIndex: providerAttempts.length,
          startedAt: new Date().toISOString(),
          endedAt: null,
          outcome: 'navigation_failed',
          httpStatus: null,
          contentLength: null,
          errorMessage: null,
          urlUsed: fallbackSearchUrl.toString(),
        };
        
        let fetchResult: FetchResult;
        
        switch (provider) {
          case 'browserless':
            fetchResult = await fetchWithBrowserless(fallbackSearchUrl.toString(), 8000);
            break;
          case 'zyte':
            fetchResult = await fetchWithZyte(fallbackSearchUrl.toString());
            break;
          case 'firecrawl':
            fetchResult = await fetchWithFirecrawl(fallbackSearchUrl.toString(), 7000);
            break;
        }
        
        attemptTrace.endedAt = new Date().toISOString();
        attemptTrace.httpStatus = fetchResult.httpStatus || null;
        attemptTrace.contentLength = fetchResult.content.length;
        
        if (fetchResult.error) {
          attemptTrace.errorMessage = fetchResult.error;
          attemptTrace.outcome = 'navigation_failed';
          providerAttempts.push(attemptTrace);
          console.log(`[AGODA] ${provider} failed for fallback search: ${fetchResult.error}`);
          continue;
        }
        
        if (fetchResult.content.length < MIN_CONTENT_LENGTH) {
          attemptTrace.outcome = 'insufficient_content';
          attemptTrace.errorMessage = `Content too short: ${fetchResult.content.length}`;
          providerAttempts.push(attemptTrace);
          continue;
        }
        
        const pageState = analyzePageState(fetchResult.content, fallbackSearchUrl.toString());
        
        if (pageState.botBlocked) {
          attemptTrace.outcome = 'bot_blocked';
          attemptTrace.errorMessage = 'Bot detection triggered';
          providerAttempts.push(attemptTrace);
          continue;
        }
        
        attemptTrace.outcome = 'success';
        providerAttempts.push(attemptTrace);
        
        console.log(`[AGODA] ${provider} succeeded for fallback search: ${fetchResult.content.length} chars`);
        
        // Try to extract nightly rate from search page
        const fallbackSearchContent = fetchResult.html || fetchResult.content;
        const fallbackPriceResult = extractPrice(fallbackSearchContent, nights);
        
        if (fallbackPriceResult.extracted && fallbackPriceResult.totalPrice) {
          result.success = true;
          result.status = fallbackPriceResult.directlyComparable ? 'success_total_stay' : 'success_partial';
          result.failureCategory = 'success';
          result.extractedPrice = fallbackPriceResult.totalPrice;
          result.currency = fallbackPriceResult.currency;
          result.includesTaxesFees = fallbackPriceResult.includesTaxesFees;
          result.directlyComparable = fallbackPriceResult.directlyComparable;
          result.evidenceSnippet = fallbackPriceResult.evidenceSnippet;
          
          result.structuralProof.total_price_label_found = fallbackPriceResult.totalLabelFound;
          result.structuralProof.directly_comparable = fallbackPriceResult.directlyComparable;
          result.structuralProof.currency_detected = fallbackPriceResult.currency;
          result.structuralProof.failure_category = 'success';
          result.structuralProof.extraction_method = `fallback_search_${fallbackPriceResult.extractionMethod}`;
          result.structuralProof.selector_matched = fallbackPriceResult.selectorMatched;
          result.structuralProof.final_url_fetched = fallbackSearchUrl.toString();
          
          result.durationMs = Date.now() - startTime;
          result.providerAttempts = providerAttempts;
          
          console.log(`[AGODA] SUCCESS via fallback search: ${result.currency} ${result.extractedPrice}`);
          return result;
        }
        
        break;
      }
      
      // All fallbacks failed
      result.status = 'hotel_page_not_reached';
      result.error = 'Could not reach hotel page or search fallback';
      result.failureCategory = providerAttempts.every(a => a.outcome === 'bot_blocked') ? 'blocked' : 'render_error';
      result.structuralProof.failure_category = result.failureCategory;
      result.durationMs = Date.now() - startTime;
      result.providerAttempts = providerAttempts;
      return result;
    }
    
    // ========================================================================
    // PHASE 2: Find checkout link in hotel page
    // ========================================================================
    
    console.log('[AGODA] Phase 2: Looking for checkout link in hotel page');
    
    const checkoutLinkResult = findCheckoutLink(hotelPageHtml || hotelPageContent, urlData.hotelUrlWithParams);
    
    if (checkoutLinkResult.found && checkoutLinkResult.checkoutUrl) {
      result.structuralProof.checkout_link_found = true;
      result.structuralProof.checkout_url_found = checkoutLinkResult.checkoutUrl;
      
      // ======================================================================
      // PHASE 3: Fetch checkout page and extract price
      // ======================================================================
      
      console.log('[AGODA] Phase 3: Fetching checkout page');
      console.log(`[AGODA] final_url_fetched: ${checkoutLinkResult.checkoutUrl}`);
      result.structuralProof.final_url_fetched = checkoutLinkResult.checkoutUrl;
      
      let checkoutPageContent = '';
      
      for (const provider of PROVIDER_ORDER) {
        const attemptTrace: ProviderAttemptTrace = {
          provider,
          attempted: true,
          attemptIndex: providerAttempts.length,
          startedAt: new Date().toISOString(),
          endedAt: null,
          outcome: 'navigation_failed',
          httpStatus: null,
          contentLength: null,
          errorMessage: null,
          urlUsed: checkoutLinkResult.checkoutUrl,
        };
        
        let fetchResult: FetchResult;
        
        switch (provider) {
          case 'browserless':
            fetchResult = await fetchWithBrowserless(checkoutLinkResult.checkoutUrl, 7000);
            break;
          case 'zyte':
            fetchResult = await fetchWithZyte(checkoutLinkResult.checkoutUrl);
            break;
          case 'firecrawl':
            fetchResult = await fetchWithFirecrawl(checkoutLinkResult.checkoutUrl, 6000);
            break;
        }
        
        attemptTrace.endedAt = new Date().toISOString();
        attemptTrace.httpStatus = fetchResult.httpStatus || null;
        attemptTrace.contentLength = fetchResult.content.length;
        
        if (fetchResult.error) {
          attemptTrace.errorMessage = fetchResult.error;
          attemptTrace.outcome = 'navigation_failed';
          providerAttempts.push(attemptTrace);
          continue;
        }
        
        if (fetchResult.content.length < MIN_CONTENT_LENGTH) {
          attemptTrace.outcome = 'insufficient_content';
          attemptTrace.errorMessage = `Content too short: ${fetchResult.content.length}`;
          providerAttempts.push(attemptTrace);
          continue;
        }
        
        const pageState = analyzePageState(fetchResult.content, checkoutLinkResult.checkoutUrl);
        
        if (pageState.botBlocked) {
          attemptTrace.outcome = 'bot_blocked';
          attemptTrace.errorMessage = 'Bot detection triggered';
          providerAttempts.push(attemptTrace);
          continue;
        }
        
        attemptTrace.outcome = 'success';
        providerAttempts.push(attemptTrace);
        checkoutPageContent = fetchResult.content;
        result.structuralProof.checkout_page_reached = true;
        console.log(`[AGODA] ${provider} succeeded for checkout page: contentLength: ${checkoutPageContent.length}`);
        break;
      }
      
      // Try to extract from checkout page
      if (checkoutPageContent) {
        const priceResult = extractPrice(checkoutPageContent, nights);
        
        if (priceResult.extracted && priceResult.totalPrice) {
          result.success = true;
          result.status = priceResult.directlyComparable ? 'success_total_stay' : 'success_partial';
          result.failureCategory = 'success';
          result.extractedPrice = priceResult.totalPrice;
          result.currency = priceResult.currency;
          result.includesTaxesFees = priceResult.includesTaxesFees;
          result.directlyComparable = priceResult.directlyComparable;
          result.evidenceSnippet = priceResult.evidenceSnippet;
          
          result.structuralProof.total_price_label_found = priceResult.totalLabelFound;
          result.structuralProof.room_price_nights_found = priceResult.roomPriceNights !== null;
          result.structuralProof.directly_comparable = priceResult.directlyComparable;
          result.structuralProof.currency_detected = priceResult.currency;
          result.structuralProof.failure_category = 'success';
          result.structuralProof.extraction_method = priceResult.extractionMethod;
          result.structuralProof.selector_matched = priceResult.selectorMatched;
          
          result.durationMs = Date.now() - startTime;
          result.providerAttempts = providerAttempts;
          
          console.log(`[AGODA] SUCCESS from checkout page: ${result.currency} ${result.extractedPrice} (directlyComparable: ${result.directlyComparable})`);
          return result;
        }
      }
      
      // Checkout page reached but no price found
      if (checkoutPageContent) {
        result.status = 'total_price_not_found';
        result.error = 'Checkout page reached but Total Price not found';
        result.failureCategory = 'selector_not_found';
      } else {
        result.status = 'checkout_page_not_reached';
        result.error = 'Could not fetch checkout page';
        result.failureCategory = providerAttempts.filter(a => a.urlUsed === checkoutLinkResult.checkoutUrl).every(a => a.outcome === 'bot_blocked') ? 'blocked' : 'render_error';
      }
    } else {
      // ======================================================================
      // PHASE 2B: No static checkout link - try SEARCH PAGE workflow
      // ======================================================================
      // 
      // The hotel page doesn't have direct checkout links (they're JS-generated).
      // The workflow is:
      // 1. Extract property ID from hotel page content
      // 2. Build search URL with selectedproperty param
      // 3. Scrape search page - it has checkout links with encrypted params!
      // 4. Follow checkout link to get total price
      
      console.log('[AGODA] Phase 2B: No static checkout link - trying search page workflow');
      
      // Step 1: Extract property ID from hotel page
      let propertyId = extractPropertyIdFromUrl(urlData.hotelUrlWithParams);
      if (!propertyId && hotelPageHtml) {
        propertyId = extractPropertyIdFromContent(hotelPageHtml);
      }
      
      // Also try to get city ID for better search results
      let cityId: string | null = null;
      if (hotelPageHtml) {
        cityId = extractCityIdFromContent(hotelPageHtml);
      }
      
      if (propertyId) {
        console.log(`[AGODA] Found propertyId: ${propertyId}, cityId: ${cityId}`);
        
        // Step 2: Build search URL
        const searchUrlData = buildSearchUrl(
          propertyId,
          cityId,
          checkIn,
          checkOut,
          adults,
          children,
          rooms
        );
        
        // Step 3: Fetch search page
        console.log(`[AGODA] Phase 2B-2: Fetching search page: ${searchUrlData.searchUrl}`);
        
        let searchPageContent = '';
        let searchPageHtml = '';
        
        for (const provider of PROVIDER_ORDER) {
          const attemptTrace: ProviderAttemptTrace = {
            provider,
            attempted: true,
            attemptIndex: providerAttempts.length,
            startedAt: new Date().toISOString(),
            endedAt: null,
            outcome: 'navigation_failed',
            httpStatus: null,
            contentLength: null,
            errorMessage: null,
            urlUsed: searchUrlData.searchUrl,
          };
          
          let fetchResult: FetchResult;
          
          switch (provider) {
            case 'browserless':
              fetchResult = await fetchWithBrowserless(searchUrlData.searchUrl, 8000);
              break;
            case 'zyte':
              fetchResult = await fetchWithZyte(searchUrlData.searchUrl);
              break;
            case 'firecrawl':
              fetchResult = await fetchWithFirecrawl(searchUrlData.searchUrl, 7000);
              break;
          }
          
          attemptTrace.endedAt = new Date().toISOString();
          attemptTrace.httpStatus = fetchResult.httpStatus || null;
          attemptTrace.contentLength = fetchResult.content.length;
          
          if (fetchResult.error) {
            attemptTrace.errorMessage = fetchResult.error;
            attemptTrace.outcome = 'navigation_failed';
            providerAttempts.push(attemptTrace);
            console.log(`[AGODA] ${provider} failed for search page: ${fetchResult.error}`);
            continue;
          }
          
          if (fetchResult.content.length < MIN_CONTENT_LENGTH) {
            attemptTrace.outcome = 'insufficient_content';
            attemptTrace.errorMessage = `Content too short: ${fetchResult.content.length}`;
            providerAttempts.push(attemptTrace);
            continue;
          }
          
          const pageState = analyzePageState(fetchResult.content, searchUrlData.searchUrl);
          
          if (pageState.botBlocked) {
            attemptTrace.outcome = 'bot_blocked';
            attemptTrace.errorMessage = 'Bot detection triggered';
            providerAttempts.push(attemptTrace);
            continue;
          }
          
          attemptTrace.outcome = 'success';
          providerAttempts.push(attemptTrace);
          searchPageContent = fetchResult.content;
          searchPageHtml = fetchResult.html;
          console.log(`[AGODA] ${provider} succeeded for search page: ${searchPageContent.length} chars`);
          break;
        }
        
        // Step 4: First try static link discovery on search page
        if (searchPageHtml || searchPageContent) {
          const searchCheckoutLink = findCheckoutLink(searchPageHtml || searchPageContent, searchUrlData.searchUrl);
          
          if (searchCheckoutLink.found && searchCheckoutLink.checkoutUrl) {
            console.log(`[AGODA] Phase 2B-3: Found checkout link on search page: ${searchCheckoutLink.checkoutUrl.substring(0, 100)}...`);
            
            result.structuralProof.checkout_link_found = true;
            result.structuralProof.checkout_url_found = searchCheckoutLink.checkoutUrl;
            result.structuralProof.final_url_fetched = searchCheckoutLink.checkoutUrl;
            
            // Step 5: Fetch checkout page and extract price
            console.log('[AGODA] Phase 2B-4: Fetching checkout page from search result');
            
            for (const provider of PROVIDER_ORDER) {
              const attemptTrace: ProviderAttemptTrace = {
                provider,
                attempted: true,
                attemptIndex: providerAttempts.length,
                startedAt: new Date().toISOString(),
                endedAt: null,
                outcome: 'navigation_failed',
                httpStatus: null,
                contentLength: null,
                errorMessage: null,
                urlUsed: searchCheckoutLink.checkoutUrl,
              };
              
              let fetchResult: FetchResult;
              
              switch (provider) {
                case 'browserless':
                  fetchResult = await fetchWithBrowserless(searchCheckoutLink.checkoutUrl, 8000);
                  break;
                case 'zyte':
                  fetchResult = await fetchWithZyte(searchCheckoutLink.checkoutUrl);
                  break;
                case 'firecrawl':
                  fetchResult = await fetchWithFirecrawl(searchCheckoutLink.checkoutUrl, 7000);
                  break;
              }
              
              attemptTrace.endedAt = new Date().toISOString();
              attemptTrace.httpStatus = fetchResult.httpStatus || null;
              attemptTrace.contentLength = fetchResult.content.length;
              
              if (fetchResult.error) {
                attemptTrace.errorMessage = fetchResult.error;
                attemptTrace.outcome = 'navigation_failed';
                providerAttempts.push(attemptTrace);
                continue;
              }
              
              if (fetchResult.content.length < MIN_CONTENT_LENGTH) {
                attemptTrace.outcome = 'insufficient_content';
                attemptTrace.errorMessage = `Content too short: ${fetchResult.content.length}`;
                providerAttempts.push(attemptTrace);
                continue;
              }
              
              const pageState = analyzePageState(fetchResult.content, searchCheckoutLink.checkoutUrl);
              
              if (pageState.botBlocked) {
                attemptTrace.outcome = 'bot_blocked';
                attemptTrace.errorMessage = 'Bot detection triggered';
                providerAttempts.push(attemptTrace);
                continue;
              }
              
              attemptTrace.outcome = 'success';
              providerAttempts.push(attemptTrace);
              result.structuralProof.checkout_page_reached = true;
              
              console.log(`[AGODA] ${provider} succeeded for checkout page: ${fetchResult.content.length} chars`);
              
              // Extract price
              const priceResult = extractPrice(fetchResult.content, nights);
              
              if (priceResult.extracted && priceResult.totalPrice) {
                result.success = true;
                result.status = priceResult.directlyComparable ? 'success_total_stay' : 'success_partial';
                result.failureCategory = 'success';
                result.extractedPrice = priceResult.totalPrice;
                result.currency = priceResult.currency;
                result.includesTaxesFees = priceResult.includesTaxesFees;
                result.directlyComparable = priceResult.directlyComparable;
                result.evidenceSnippet = priceResult.evidenceSnippet;
                
                result.structuralProof.total_price_label_found = priceResult.totalLabelFound;
                result.structuralProof.room_price_nights_found = priceResult.roomPriceNights !== null;
                result.structuralProof.directly_comparable = priceResult.directlyComparable;
                result.structuralProof.currency_detected = priceResult.currency;
                result.structuralProof.failure_category = 'success';
                result.structuralProof.extraction_method = `search_page_${priceResult.extractionMethod}`;
                result.structuralProof.selector_matched = priceResult.selectorMatched;
                
                result.durationMs = Date.now() - startTime;
                result.providerAttempts = providerAttempts;
                
                console.log(`[AGODA] SUCCESS via search page workflow: ${result.currency} ${result.extractedPrice} (directlyComparable: ${result.directlyComparable})`);
                return result;
              }
              
              break;
            }
          } else {
            console.log('[AGODA] No static checkout link found on search page');
          }
        }
        
        // ======================================================================
        // PHASE 2B-5: SKIPPED - Search page click is slow and unreliable
        // Hotel page click (Phase 2C) is more reliable and faster
        // ======================================================================
        console.log('[AGODA] Skipping Phase 2B-5 (search page click) - hotel page click is more reliable');
      } else {
        console.log('[AGODA] Could not extract property ID from hotel page - cannot use search workflow');
      }
      
      // Fallback: Try Browserless click navigation on hotel page as last resort
      console.log('[AGODA] Phase 2C: Trying Browserless click navigation on hotel page');
      
      const hotelClickResult = await clickBookingButtonWithBrowserless(urlData.hotelUrlWithParams);
      
      const hotelClickAttemptTrace: ProviderAttemptTrace = {
        provider: 'browserless',
        attempted: true,
        attemptIndex: providerAttempts.length,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        outcome: hotelClickResult.checkoutUrlDiscovered ? 'success' : 'navigation_failed',
        httpStatus: hotelClickResult.httpStatus || null,
        contentLength: hotelClickResult.content?.length || null,
        errorMessage: hotelClickResult.error || null,
        urlUsed: urlData.hotelUrlWithParams,
      };
      providerAttempts.push(hotelClickAttemptTrace);
      
      if (hotelClickResult.checkoutUrlDiscovered) {
        console.log(`[AGODA] Hotel page click discovered checkout URL: ${hotelClickResult.checkoutUrlDiscovered.substring(0, 120)}...`);
        
        result.structuralProof.checkout_link_found = true;
        result.structuralProof.checkout_url_found = hotelClickResult.checkoutUrlDiscovered;
        result.structuralProof.final_url_fetched = hotelClickResult.checkoutUrlDiscovered;
        result.structuralProof.checkout_page_reached = true;
        
        // Extract price from the page content after click navigation
        if (hotelClickResult.content && hotelClickResult.content.length >= MIN_CONTENT_LENGTH) {
          const priceResult = extractPrice(hotelClickResult.content, nights);
          
          if (priceResult.extracted && priceResult.totalPrice) {
            result.success = true;
            result.status = priceResult.directlyComparable ? 'success_total_stay' : 'success_partial';
            result.failureCategory = 'success';
            result.extractedPrice = priceResult.totalPrice;
            result.currency = priceResult.currency;
            result.includesTaxesFees = priceResult.includesTaxesFees;
            result.directlyComparable = priceResult.directlyComparable;
            result.evidenceSnippet = priceResult.evidenceSnippet;
            
            result.structuralProof.total_price_label_found = priceResult.totalLabelFound;
            result.structuralProof.room_price_nights_found = priceResult.roomPriceNights !== null;
            result.structuralProof.directly_comparable = priceResult.directlyComparable;
            result.structuralProof.currency_detected = priceResult.currency;
            result.structuralProof.failure_category = 'success';
            result.structuralProof.extraction_method = `hotel_click_${priceResult.extractionMethod}`;
            result.structuralProof.selector_matched = priceResult.selectorMatched;
            
            result.durationMs = Date.now() - startTime;
            result.providerAttempts = providerAttempts;
            
            console.log(`[AGODA] SUCCESS via hotel page click: ${result.currency} ${result.extractedPrice} (directlyComparable: ${result.directlyComparable})`);
            return result;
          }
        }
        
        console.log('[AGODA] Hotel page click navigated to /book/ but price extraction failed');
      } else if (hotelClickResult.error) {
        console.log(`[AGODA] Hotel page click failed: ${hotelClickResult.error}`);
      } else {
        console.log('[AGODA] Hotel page click did not discover checkout URL');
      }
      
      // No checkout link found - fall through to extract from hotel page directly
      console.log('[AGODA] No checkout link found via any method');
      result.structuralProof.checkout_link_found = false;
      result.structuralProof.final_url_fetched = urlData.hotelUrlWithParams;
    }
    
    // ========================================================================
    // PHASE 4: Fallback - extract from hotel page if no checkout
    // ========================================================================
    
    if (!result.success && hotelPageContent) {
      console.log('[AGODA] Phase 4: Attempting extraction from hotel page');
      
      const priceResult = extractPrice(hotelPageContent, nights);
      
      if (priceResult.extracted && priceResult.totalPrice) {
        result.success = true;
        result.status = priceResult.directlyComparable ? 'success_total_stay' : 'success_partial';
        result.failureCategory = 'success';
        result.extractedPrice = priceResult.totalPrice;
        result.currency = priceResult.currency;
        result.includesTaxesFees = priceResult.includesTaxesFees;
        result.directlyComparable = priceResult.directlyComparable;
        result.evidenceSnippet = priceResult.evidenceSnippet;
        
        result.structuralProof.total_price_label_found = priceResult.totalLabelFound;
        result.structuralProof.room_price_nights_found = priceResult.roomPriceNights !== null;
        result.structuralProof.directly_comparable = priceResult.directlyComparable;
        result.structuralProof.currency_detected = priceResult.currency;
        result.structuralProof.failure_category = 'success';
        result.structuralProof.extraction_method = priceResult.extractionMethod;
        result.structuralProof.selector_matched = priceResult.selectorMatched;
        
        result.durationMs = Date.now() - startTime;
        result.providerAttempts = providerAttempts;
        
        console.log(`[AGODA] SUCCESS from hotel page: ${result.currency} ${result.extractedPrice} (directlyComparable: ${result.directlyComparable})`);
        return result;
      }
    }
    
    // ========================================================================
    // PHASE 5: All extraction attempts failed
    // ========================================================================
    
    if (!result.status || result.status === 'validation_error') {
      if (providerAttempts.every(a => a.outcome === 'bot_blocked')) {
        result.status = 'blocked_captcha_or_bot';
        result.error = 'All providers blocked by bot detection';
        result.failureCategory = 'blocked';
      } else if (!result.structuralProof.checkout_link_found) {
        result.status = 'checkout_link_not_found';
        result.error = 'Could not find checkout/book link on hotel page';
        result.failureCategory = 'missing_checkout_link';
      } else if (!hotelPageContent) {
        result.status = 'hotel_page_not_reached';
        result.error = 'Could not reach hotel page';
        result.failureCategory = 'render_error';
      } else {
        result.status = 'total_price_not_found';
        result.error = 'Could not find Total Price on page';
        result.failureCategory = 'selector_not_found';
      }
    }
    
    result.structuralProof.failure_category = result.failureCategory;
    result.durationMs = Date.now() - startTime;
    result.providerAttempts = providerAttempts;
    
    console.log(`[AGODA] Extraction failed: ${result.status} - ${result.failureCategory}`);
    return result;
    
  } catch (error) {
    result.error = error instanceof Error ? error.message : 'Unknown error';
    result.status = 'validation_error';
    result.failureCategory = 'render_error';
    result.structuralProof.failure_category = 'render_error';
    result.durationMs = Date.now() - startTime;
    result.providerAttempts = providerAttempts;
    console.error('[AGODA] Fatal error:', error);
    return result;
  }
}

// ============================================================================
// DIRECT CHECKOUT URL EXTRACTION (bypasses hotel page discovery)
// ============================================================================

async function extractFromCheckoutUrl(
  checkoutUrl: string,
  checkIn: string,
  checkOut: string
): Promise<ExtractionResult> {
  const startTime = Date.now();
  const nights = calculateNights(checkIn, checkOut);
  const providerAttempts: ProviderAttemptTrace[] = [];
  
  // Initialize result
  const result: ExtractionResult = {
    success: false,
    status: 'validation_error',
    failureCategory: 'render_error',
    extractedPrice: null,
    currency: null,
    includesTaxesFees: null,
    directlyComparable: false,
    evidenceSnippet: null,
    structuralProof: {
      hotel_page_reached: false,  // Not used in direct checkout mode
      checkout_link_found: true,   // Direct URL provided
      checkout_url_found: checkoutUrl,
      checkout_page_reached: false,
      dates_injected: true,
      dates_visible_on_page: false,
      total_price_label_found: false,
      room_price_nights_found: false,
      taxes_service_visible: false,
      directly_comparable: false,
      proof_version: 'agoda-golden-path-v3.1-direct',
      currency_detected: null,
      nights_detected: nights,
      entry_hotel_url_used: null,  // Direct mode, no hotel URL
      final_url_fetched: checkoutUrl,
      content_hash: null,
      failure_category: 'render_error',
      extraction_method: null,
      selector_matched: null,
    },
    durationMs: 0,
    error: null,
    providerAttempts: [],
    goldenPath: true,
  };
  
  console.log('[AGODA] DIRECT CHECKOUT MODE - bypassing hotel page discovery');
  console.log(`[AGODA] final_url_fetched: ${checkoutUrl}`);
  
  try {
    // Fetch checkout page directly
    let checkoutPageContent = '';
    
    for (const provider of PROVIDER_ORDER) {
      const attemptTrace: ProviderAttemptTrace = {
        provider,
        attempted: true,
        attemptIndex: providerAttempts.length,
        startedAt: new Date().toISOString(),
        endedAt: null,
        outcome: 'navigation_failed',
        httpStatus: null,
        contentLength: null,
        errorMessage: null,
        urlUsed: checkoutUrl,
      };
      
      let fetchResult: FetchResult;
      
      switch (provider) {
        case 'browserless':
          fetchResult = await fetchWithBrowserless(checkoutUrl, 8000);
          break;
        case 'zyte':
          fetchResult = await fetchWithZyte(checkoutUrl);
          break;
        case 'firecrawl':
          fetchResult = await fetchWithFirecrawl(checkoutUrl, 7000);
          break;
      }
      
      attemptTrace.endedAt = new Date().toISOString();
      attemptTrace.httpStatus = fetchResult.httpStatus || null;
      attemptTrace.contentLength = fetchResult.content.length;
      
      console.log(`[AGODA] ${provider} checkout fetch: contentLength: ${fetchResult.content.length}`);
      
      if (fetchResult.error) {
        attemptTrace.errorMessage = fetchResult.error;
        attemptTrace.outcome = 'navigation_failed';
        providerAttempts.push(attemptTrace);
        continue;
      }
      
      if (fetchResult.content.length < MIN_CONTENT_LENGTH) {
        attemptTrace.outcome = 'insufficient_content';
        attemptTrace.errorMessage = `Content too short: ${fetchResult.content.length}`;
        providerAttempts.push(attemptTrace);
        continue;
      }
      
      const pageState = analyzePageState(fetchResult.content, checkoutUrl);
      
      if (pageState.botBlocked) {
        attemptTrace.outcome = 'bot_blocked';
        attemptTrace.errorMessage = 'Bot detection triggered';
        providerAttempts.push(attemptTrace);
        continue;
      }
      
      if (pageState.soldOut) {
        attemptTrace.outcome = 'sold_out';
        attemptTrace.errorMessage = 'Property sold out for dates';
        providerAttempts.push(attemptTrace);
        result.status = 'dates_unavailable';
        result.error = 'Property not available for selected dates';
        result.failureCategory = 'unavailable';
        result.structuralProof.failure_category = 'unavailable';
        result.durationMs = Date.now() - startTime;
        result.providerAttempts = providerAttempts;
        return result;
      }
      
      attemptTrace.outcome = 'success';
      providerAttempts.push(attemptTrace);
      checkoutPageContent = fetchResult.content;
      result.structuralProof.checkout_page_reached = true;
      result.structuralProof.content_hash = simpleHash(fetchResult.content);
      result.structuralProof.dates_visible_on_page = pageState.datesVisible;
      console.log(`[AGODA] ${provider} succeeded for checkout page: contentLength: ${checkoutPageContent.length}`);
      break;
    }
    
    if (!checkoutPageContent) {
      result.status = 'checkout_page_not_reached';
      result.error = 'Could not reach checkout page';
      result.failureCategory = providerAttempts.every(a => a.outcome === 'bot_blocked') ? 'blocked' : 'render_error';
      result.structuralProof.failure_category = result.failureCategory;
      result.durationMs = Date.now() - startTime;
      result.providerAttempts = providerAttempts;
      return result;
    }
    
    // Extract price from checkout page
    const priceResult = extractPrice(checkoutPageContent, nights);
    
    if (priceResult.extracted && priceResult.totalPrice) {
      result.success = true;
      result.status = priceResult.directlyComparable ? 'success_total_stay' : 'success_partial';
      result.failureCategory = 'success';
      result.extractedPrice = priceResult.totalPrice;
      result.currency = priceResult.currency;
      result.includesTaxesFees = priceResult.includesTaxesFees;
      result.directlyComparable = priceResult.directlyComparable;
      result.evidenceSnippet = priceResult.evidenceSnippet;
      
      result.structuralProof.total_price_label_found = priceResult.totalLabelFound;
      result.structuralProof.room_price_nights_found = priceResult.roomPriceNights !== null;
      result.structuralProof.directly_comparable = priceResult.directlyComparable;
      result.structuralProof.currency_detected = priceResult.currency;
      result.structuralProof.failure_category = 'success';
      result.structuralProof.extraction_method = priceResult.extractionMethod;
      result.structuralProof.selector_matched = priceResult.selectorMatched;
      
      result.durationMs = Date.now() - startTime;
      result.providerAttempts = providerAttempts;
      
      console.log(`[AGODA] SUCCESS from direct checkout: ${result.currency} ${result.extractedPrice} (directlyComparable: ${result.directlyComparable})`);
      return result;
    }
    
    // Price not found on checkout page
    result.status = 'total_price_not_found';
    result.error = 'Checkout page reached but Total Price not found';
    result.failureCategory = 'selector_not_found';
    result.structuralProof.failure_category = 'selector_not_found';
    result.durationMs = Date.now() - startTime;
    result.providerAttempts = providerAttempts;
    
    console.log(`[AGODA] Direct checkout extraction failed: ${result.status}`);
    return result;
    
  } catch (error) {
    result.error = error instanceof Error ? error.message : 'Unknown error';
    result.status = 'validation_error';
    result.failureCategory = 'render_error';
    result.structuralProof.failure_category = 'render_error';
    result.durationMs = Date.now() - startTime;
    result.providerAttempts = providerAttempts;
    console.error('[AGODA] Fatal error in direct checkout:', error);
    return result;
  }
}

// ============================================================================
// HTTP HANDLER
// ============================================================================

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json() as ExtractionRequest;
    const { url, checkoutUrl, extractionId, checkIn, checkOut, adults = 2, children = 0, rooms = 1 } = body;
    
    console.log('[AGODA] Golden Path v3.1 extraction request');
    
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabaseClient = createClient(supabaseUrl, supabaseKey);
    
    if (!checkIn || !checkOut) {
      return new Response(
        JSON.stringify({ success: false, error: 'checkIn and checkOut dates required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    // ==========================================================================
    // PRIORITY 1: Direct checkout URL provided - bypass hotel page discovery
    // ==========================================================================
    
    if (checkoutUrl) {
      console.log(`[AGODA] Direct checkout URL provided: ${checkoutUrl.substring(0, 100)}...`);
      console.log(`[AGODA] Dates: ${checkIn} to ${checkOut}`);
      
      const result = await extractFromCheckoutUrl(checkoutUrl, checkIn, checkOut);
      
      // Update DB if extractionId provided
      if (extractionId) {
        const updateData: Record<string, unknown> = {
          extraction_status: result.status,
          extracted_price: result.extractedPrice,
          currency: result.currency,
          includes_taxes_fees: result.includesTaxesFees,
          extraction_error: result.error,
          page_content_hash: result.structuralProof.content_hash,
          evidence_snippets: result.evidenceSnippet ? [result.evidenceSnippet] : null,
          dates_validated: result.structuralProof.dates_visible_on_page,
          provider_used: result.providerAttempts.find(a => a.outcome === 'success')?.provider || null,
          price_type: result.directlyComparable ? 'total_proven' : 'UNKNOWN',
          extraction_metadata: {
            goldenPath: true,
            platform: 'agoda',
            version: 'agoda-golden-path-v3.1-direct',
            failureCategory: result.failureCategory,
            directlyComparable: result.directlyComparable,
            structuralProof: result.structuralProof,
            durationMs: result.durationMs,
            providerAttempts: result.providerAttempts,
          },
          updated_at: new Date().toISOString(),
        };
        
        await supabaseClient
          .from('price_extractions')
          .update(updateData)
          .eq('id', extractionId);
        
        console.log(`[AGODA] Updated extraction ${extractionId}: status=${result.status}, price=${result.extractedPrice}, comparable=${result.directlyComparable}`);
      }
      
      return new Response(
        JSON.stringify({
          success: result.success,
          result,
          goldenPath: true,
          directlyComparable: result.directlyComparable,
          mode: 'direct_checkout',
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    // ==========================================================================
    // PRIORITY 2: Hotel URL - discovery mode
    // ==========================================================================
    
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
        return new Response(
          JSON.stringify({ success: false, error: 'Extraction not found' }),
          { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      
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
        JSON.stringify({ success: false, error: 'URL, checkoutUrl, or extractionId required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    console.log(`[AGODA] Extracting: ${targetUrl}`);
    console.log(`[AGODA] Dates: ${checkIn} to ${checkOut}`);
    
    // Run extraction
    const result = await extractFromAgoda(targetUrl, checkIn, checkOut, adults, children, rooms);
    
    // Update DB if extractionId provided
    if (dbExtractionId) {
      const updateData: Record<string, unknown> = {
        extraction_status: result.status,
        extracted_price: result.extractedPrice,
        currency: result.currency,
        includes_taxes_fees: result.includesTaxesFees,
        extraction_error: result.error,
        page_content_hash: result.structuralProof.content_hash,
        evidence_snippets: result.evidenceSnippet ? [result.evidenceSnippet] : null,
        dates_validated: result.structuralProof.dates_visible_on_page,
        provider_used: result.providerAttempts.find(a => a.outcome === 'success')?.provider || null,
        price_type: result.directlyComparable ? 'total_proven' : 'UNKNOWN',
        extraction_metadata: {
          goldenPath: true,
          platform: 'agoda',
          version: 'agoda-golden-path-v3.1',
          failureCategory: result.failureCategory,
          directlyComparable: result.directlyComparable,
          structuralProof: result.structuralProof,
          durationMs: result.durationMs,
          providerAttempts: result.providerAttempts,
        },
        updated_at: new Date().toISOString(),
      };
      
      await supabaseClient
        .from('price_extractions')
        .update(updateData)
        .eq('id', dbExtractionId);
      
      console.log(`[AGODA] Updated extraction ${dbExtractionId}: status=${result.status}, price=${result.extractedPrice}, comparable=${result.directlyComparable}`);
    }
    
    return new Response(
      JSON.stringify({
        success: result.success,
        result,
        goldenPath: true,
        directlyComparable: result.directlyComparable,
        mode: 'hotel_discovery',
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
