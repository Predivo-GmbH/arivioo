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
 * Looks for patterns like:
 * - href="/book/..." or href="https://www.agoda.com/book/..."
 * - Book Now, Reserve, etc. button hrefs
 */
function findCheckoutLink(html: string, baseUrl: string): CheckoutLinkResult {
  const result: CheckoutLinkResult = {
    found: false,
    checkoutUrl: null,
    method: null,
  };
  
  // Pattern 1: Direct /book/ links in href
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
      console.log(`[AGODA] checkout_url_found: ${checkoutUrl} (method: ${result.method})`);
      return result;
    }
  }
  
  // Pattern 2: Look for booking-related data attributes or onclick handlers
  const dataBookPatterns = [
    /data-selenium="book-button"[^>]*href=["']([^"']+)["']/gi,
    /class="[^"]*book[^"]*"[^>]*href=["']([^"']+)["']/gi,
  ];
  
  for (const pattern of dataBookPatterns) {
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
      result.method = 'data_attribute_pattern';
      console.log(`[AGODA] checkout_url_found: ${checkoutUrl} (method: ${result.method})`);
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
  // PATTERN 2: Room price (X nights) - fallback, NOT directly comparable
  // ==========================================================================
  
  const roomPricePatterns: Array<{ pattern: RegExp; name: string }> = [
    { pattern: /room\s*price\s*\((\d+)\s*nights?\)[^$€£¥]*?([A-Z]{3})\s*([\d,\.]+)/i, name: 'room_price_nights_currency' },
    { pattern: /room\s*price\s*\((\d+)\s*nights?\)[^$]*?\$\s*([\d,\.]+)/i, name: 'room_price_nights_dollar' },
    { pattern: /(\d+)\s*nights?[^$€£¥]*?([A-Z]{3})\s*([\d,\.]+)/i, name: 'nights_currency_amount' },
  ];
  
  for (const { pattern, name } of roomPricePatterns) {
    const match = normalized.match(pattern);
    if (match) {
      const nightsFound = parseInt(match[1], 10);
      let currency: string;
      let amountStr: string;
      
      if (match[3]) {
        currency = match[2].toUpperCase();
        amountStr = match[3];
      } else {
        currency = 'USD';
        amountStr = match[2];
      }
      
      const amount = parseCurrencyAmount(amountStr);
      
      if (amount && amount >= 50 && amount <= 100000) {
        result.extracted = true;
        result.roomPriceNights = amount;
        result.totalPrice = amount;
        result.nightsDetected = nightsFound;
        result.currency = currency;
        result.directlyComparable = false; // Missing taxes!
        result.includesTaxesFees = false;
        result.extractionMethod = 'room_price_nights';
        result.selectorMatched = name;
        
        const matchIndex = normalized.indexOf(match[0]);
        const start = Math.max(0, matchIndex - 10);
        const end = Math.min(normalized.length, matchIndex + match[0].length + 30);
        result.evidenceSnippet = normalized.slice(start, end).trim();
        
        console.log(`[AGODA] selector_matched: ${name}`);
        console.log(`[AGODA] Room price found: ${currency} ${amount} for ${nightsFound} nights (NOT directly comparable)`);
        return result;
      }
    }
  }
  
  // ==========================================================================
  // PATTERN 3: Nightly rate × nights (property page fallback)
  // ==========================================================================
  
  const nightlyPatterns: Array<{ pattern: RegExp; name: string }> = [
    { pattern: /(?:USD|US\$)\s*([\d,]+(?:\.\d{2})?)\s*(?:\n\s*)?per\s*night/i, name: 'usd_per_night' },
    { pattern: /\$\s*([\d,]+(?:\.\d{2})?)\s*(?:per\s*night|\/\s*night)/i, name: 'dollar_per_night' },
    { pattern: /per\s*night[:\s]*(?:USD|US\$|)\s*([\d,]+(?:\.\d{2})?)/i, name: 'per_night_amount' },
    { pattern: /([A-Z]{3})\s*([\d,]+(?:\.\d{2})?)\s*\/\s*night/i, name: 'currency_slash_night' },
  ];
  
  for (const { pattern, name } of nightlyPatterns) {
    const match = content.match(pattern);
    if (match) {
      let currency = 'USD';
      let amountStr: string;
      
      if (match[2]) {
        currency = match[1].toUpperCase();
        amountStr = match[2];
      } else {
        amountStr = match[1];
      }
      
      const nightlyRate = parseCurrencyAmount(amountStr);
      
      if (nightlyRate && nightlyRate >= 10 && nightlyRate <= 20000) {
        const totalFromNightly = nightlyRate * expectedNights;
        
        result.extracted = true;
        result.totalPrice = totalFromNightly;
        result.currency = currency;
        result.directlyComparable = false;
        result.includesTaxesFees = false;
        result.extractionMethod = 'nightly_rate_computed';
        result.selectorMatched = name;
        
        const matchIndex = content.indexOf(match[0]);
        const start = Math.max(0, matchIndex - 20);
        const end = Math.min(content.length, matchIndex + match[0].length + 30);
        result.evidenceSnippet = content.slice(start, end).replace(/\s+/g, ' ').trim();
        
        console.log(`[AGODA] selector_matched: ${name}`);
        console.log(`[AGODA] Nightly rate: ${currency} ${nightlyRate} × ${expectedNights} = ${totalFromNightly}`);
        return result;
      }
    }
  }
  
  console.log('[AGODA] No price found');
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
      // All providers failed for hotel page
      result.status = 'hotel_page_not_reached';
      result.error = 'Could not reach hotel page';
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
      // No checkout link found - try to extract from hotel page directly
      console.log('[AGODA] No checkout link found, trying to extract from hotel page');
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
// HTTP HANDLER
// ============================================================================

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json() as ExtractionRequest;
    const { url, extractionId, checkIn, checkOut, adults = 2, children = 0, rooms = 1 } = body;
    
    console.log('[AGODA] Golden Path v3.1 extraction request');
    
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
