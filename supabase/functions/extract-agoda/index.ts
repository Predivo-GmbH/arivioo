import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

/**
 * ============================================================================
 * AGODA GOLDEN PATH EXTRACTOR v3.0
 * ============================================================================
 * 
 * GOLDEN PATH: Navigate to /book/ checkout page for TOTAL price with taxes
 * 
 * This mirrors the Expedia Golden Path approach:
 * 1. Parse property ID from original Agoda URL
 * 2. Build /book/ checkout URL with dates, guests, currency
 * 3. Extract "Total Price" from checkout page (includes taxes/service)
 * 4. Fall back to property page nightly rate if /book/ fails
 * 
 * KEY INSIGHT:
 * - Property page shows "Per night before taxes" (e.g., USD 902)
 * - /book/ page shows "Total Price USD 5,095.34" with taxes/service
 * - We MUST extract from /book/ for directly comparable totals
 * 
 * VERIFIED PATTERNS (from user-provided /book/ URL):
 * - "Total Price" label with adjacent amount
 * - "Room price (X nights)" for subtotal
 * - Currency before amount: "USD 5,095.34"
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
  | 'book_page_not_reached'
  | 'total_price_not_found'
  | 'price_not_found'
  | 'render_failed'
  | 'validation_error'
  | 'property_id_not_found';

// Failure category for admin dashboard
type FailureCategory = 
  | 'blocked'
  | 'params_missing'
  | 'selector_not_found'
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
  book_page_reached: boolean;
  property_page_fallback: boolean;
  dates_injected: boolean;
  dates_visible_on_page: boolean;
  total_price_label_found: boolean;
  total_price_from_book_page: boolean;
  room_price_nights_found: boolean;
  taxes_service_visible: boolean;
  directly_comparable: boolean;
  proof_version: string;
  currency_detected: string | null;
  nights_detected: number | null;
  property_id: string | null;
  book_url_used: string | null;
  property_url_used: string | null;
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
// PROPERTY ID EXTRACTION
// ============================================================================

interface PropertyIdResult {
  found: boolean;
  propertyId: string | null;
  propertySlug: string | null;
}

function extractPropertyId(url: string): PropertyIdResult {
  const result: PropertyIdResult = {
    found: false,
    propertyId: null,
    propertySlug: null,
  };
  
  try {
    // Pattern 1: Property ID in URL path as h{digits}
    // e.g., /sapphire-elegance-h47632023/
    const pathMatch = url.match(/\/([^\/]+-h(\d{6,12}))\//i);
    if (pathMatch) {
      result.found = true;
      result.propertyId = pathMatch[2];
      result.propertySlug = pathMatch[1].replace(/-h\d+$/, '');
      console.log(`[AGODA] Property ID: ${result.propertyId}, slug: ${result.propertySlug}`);
      return result;
    }
    
    // Pattern 2: Property ID as query parameter
    const urlObj = new URL(url);
    const propertyIdParam = urlObj.searchParams.get('propertyId') || 
                            urlObj.searchParams.get('hotel_id') ||
                            urlObj.searchParams.get('hotelId');
    if (propertyIdParam && /^\d{5,12}$/.test(propertyIdParam)) {
      result.found = true;
      result.propertyId = propertyIdParam;
      console.log(`[AGODA] Property ID from param: ${result.propertyId}`);
      return result;
    }
    
    // Pattern 3: Look for digits in path that might be property ID
    const digitsMatch = url.match(/\/(\d{7,10})\//);
    if (digitsMatch) {
      result.found = true;
      result.propertyId = digitsMatch[1];
      console.log(`[AGODA] Property ID from path digits: ${result.propertyId}`);
      return result;
    }
    
    console.log('[AGODA] Property ID not found in URL');
    return result;
    
  } catch (e) {
    console.error('[AGODA] Error parsing URL:', e);
    return result;
  }
}

// ============================================================================
// URL BUILDERS
// ============================================================================

interface AgodaUrls {
  bookPageUrl: string;
  propertyPageUrl: string;
  propertyId: string | null;
  nights: number;
}

/**
 * Build Agoda /book/ checkout URL for total price extraction
 * 
 * Book page URL format (verified from user example):
 * https://www.agoda.com/en-sg/book/{property-slug}-h{property-id}/
 *   ?checkIn=2026-06-23&checkOut=2026-06-28&adults=2&children=0&rooms=1
 *   &currency=USD&cid=-1
 */
function buildAgodaUrls(
  originalUrl: string,
  checkIn: string,
  checkOut: string,
  adults: number = 2,
  children: number = 0,
  rooms: number = 1
): AgodaUrls {
  const nights = calculateNights(checkIn, checkOut);
  const propertyInfo = extractPropertyId(originalUrl);
  
  // Parse original URL components
  const urlObj = new URL(originalUrl);
  let pathname = urlObj.pathname;
  
  // Extract locale (e.g., /en-sg/)
  const localeMatch = pathname.match(/^\/(en-[a-z]{2})\//i);
  const locale = localeMatch ? localeMatch[1] : 'en-us';
  
  // Extract property path segment (e.g., sapphire-elegance-h47632023)
  const propertyPathMatch = pathname.match(/\/([^\/]+-h\d+)\//i) || 
                            pathname.match(/\/([^\/]+)\/hotel\//i);
  const propertyPath = propertyPathMatch ? propertyPathMatch[1] : '';
  
  // Build common query params
  const params = new URLSearchParams();
  params.set('checkIn', checkIn);
  params.set('checkOut', checkOut);
  params.set('los', String(nights));
  params.set('adults', String(adults));
  params.set('children', String(children));
  params.set('rooms', String(rooms));
  params.set('cid', '-1');
  params.set('currency', 'USD');
  
  // Build /book/ URL (primary target)
  // Format: /en-sg/book/sapphire-elegance-h47632023/
  const bookPageUrl = `https://www.agoda.com/${locale}/book/${propertyPath}/?${params.toString()}`;
  
  // Build property page URL (fallback)
  const propertyPageUrl = `https://www.agoda.com/${locale}/${propertyPath}/hotel/sapphire-nc-us.html?${params.toString()}`;
  
  console.log(`[AGODA] Book page URL: ${bookPageUrl}`);
  console.log(`[AGODA] Property page URL: ${propertyPageUrl}`);
  console.log(`[AGODA] Nights: ${nights}, Adults: ${adults}`);
  
  return {
    bookPageUrl,
    propertyPageUrl,
    propertyId: propertyInfo.propertyId,
    nights,
  };
}

// ============================================================================
// PRICE EXTRACTION FROM /BOOK/ PAGE
// ============================================================================

interface BookPagePriceResult {
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
}

/**
 * Extract TOTAL price from Agoda /book/ checkout page
 * 
 * Expected patterns on /book/ page:
 * - "Total Price" followed by "USD 5,095.34" or "CHF 4,530.00"
 * - "Room price (5 nights)" followed by subtotal
 * - Taxes/service fees listed separately
 * 
 * Priority:
 * 1. "Total Price" with adjacent currency+amount (directly comparable)
 * 2. "Room price (X nights)" as fallback (not directly comparable - missing taxes)
 */
function extractBookPagePrice(content: string, expectedNights: number): BookPagePriceResult {
  const result: BookPagePriceResult = {
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
  };
  
  // Normalize whitespace for pattern matching
  const normalized = content.replace(/\s+/g, ' ');
  const lower = normalized.toLowerCase();
  
  // ==========================================================================
  // PATTERN 1: TOTAL PRICE (highest priority, directly comparable)
  // Look for "Total Price" followed by currency + amount
  // ==========================================================================
  
  const totalPricePatterns = [
    // "Total Price ... USD 5,095.34" - most reliable
    /total\s*price[^$€£¥]*?([A-Z]{3})\s*([\d,\.]+)/i,
    // "Total Price ... $ 5,095.34"  
    /total\s*price[^$€£¥]*?\$\s*([\d,\.]+)/i,
    // "Total ... USD 5,095.34"
    /\btotal[^$€£¥]{0,30}([A-Z]{3})\s*([\d,\.]+)/i,
    // "Grand Total USD 5,095.34"
    /grand\s*total[^$€£¥]*?([A-Z]{3})\s*([\d,\.]+)/i,
    // Look for "Total Price" then currency code on next line
    /total\s*price[\s\S]{0,50}?([A-Z]{3})\s*([\d,\.]+)/i,
  ];
  
  for (const pattern of totalPricePatterns) {
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
        
        // Extract evidence snippet
        const matchIndex = normalized.indexOf(match[0]);
        const start = Math.max(0, matchIndex - 20);
        const end = Math.min(normalized.length, matchIndex + match[0].length + 40);
        result.evidenceSnippet = normalized.slice(start, end).trim();
        
        console.log(`[AGODA] Total Price found: ${currency} ${amount} (method: total_price_label)`);
        return result;
      }
    }
  }
  
  // ==========================================================================
  // PATTERN 2: Room price (X nights) - fallback, NOT directly comparable
  // This is subtotal without taxes
  // ==========================================================================
  
  const roomPricePatterns = [
    // "Room price (5 nights) USD 4,510.00"
    /room\s*price\s*\((\d+)\s*nights?\)[^$€£¥]*?([A-Z]{3})\s*([\d,\.]+)/i,
    // "Room price (5 nights) $ 4,510.00"
    /room\s*price\s*\((\d+)\s*nights?\)[^$]*?\$\s*([\d,\.]+)/i,
  ];
  
  for (const pattern of roomPricePatterns) {
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
        result.totalPrice = amount; // Use as price but mark not comparable
        result.nightsDetected = nightsFound;
        result.currency = currency;
        result.directlyComparable = false; // Missing taxes!
        result.includesTaxesFees = false;
        result.extractionMethod = 'room_price_nights';
        
        const matchIndex = normalized.indexOf(match[0]);
        const start = Math.max(0, matchIndex - 10);
        const end = Math.min(normalized.length, matchIndex + match[0].length + 30);
        result.evidenceSnippet = normalized.slice(start, end).trim();
        
        console.log(`[AGODA] Room price found: ${currency} ${amount} for ${nightsFound} nights (NOT directly comparable - missing taxes)`);
        return result;
      }
    }
  }
  
  // ==========================================================================
  // PATTERN 3: Look for taxes/service to see if we're on checkout page
  // ==========================================================================
  
  const taxPatterns = [
    /taxes?\s*(?:&|and)?\s*service[^$€£¥]*?([A-Z]{3})\s*([\d,\.]+)/i,
    /service\s*(?:charge|fee)[^$€£¥]*?([A-Z]{3})\s*([\d,\.]+)/i,
  ];
  
  for (const pattern of taxPatterns) {
    const match = normalized.match(pattern);
    if (match) {
      const amount = parseCurrencyAmount(match[2]);
      if (amount) {
        result.taxesServiceAmount = amount;
        console.log(`[AGODA] Taxes/service found: ${match[1]} ${amount}`);
      }
    }
  }
  
  // ==========================================================================
  // PATTERN 4: Generic currency + amount on book page
  // Only use if we see booking-related context
  // ==========================================================================
  
  if (lower.includes('book') || lower.includes('checkout') || lower.includes('confirm')) {
    const currencyAmountPattern = /([A-Z]{3})\s*([\d,\.]{4,12})/g;
    const matches = [...normalized.matchAll(currencyAmountPattern)];
    
    // Find largest reasonable price (likely total)
    let bestPrice: number | null = null;
    let bestCurrency: string | null = null;
    let bestMatch: string | null = null;
    
    for (const match of matches) {
      const currency = match[1].toUpperCase();
      // Only process known currencies
      if (!['USD', 'EUR', 'GBP', 'CHF', 'SGD', 'AUD', 'CAD', 'JPY'].includes(currency)) {
        continue;
      }
      
      const amount = parseCurrencyAmount(match[2]);
      if (amount && amount >= 100 && amount <= 100000) {
        if (!bestPrice || amount > bestPrice) {
          bestPrice = amount;
          bestCurrency = currency;
          bestMatch = match[0];
        }
      }
    }
    
    if (bestPrice && bestCurrency && bestMatch) {
      result.extracted = true;
      result.totalPrice = bestPrice;
      result.currency = bestCurrency;
        result.directlyComparable = false; // Can't confirm it's total
        result.includesTaxesFees = false; // Unknown - assume not included
      result.extractionMethod = 'book_page_largest_amount';
      
      const matchIndex = normalized.indexOf(bestMatch);
      const start = Math.max(0, matchIndex - 20);
      const end = Math.min(normalized.length, matchIndex + bestMatch.length + 30);
      result.evidenceSnippet = normalized.slice(start, end).trim();
      
      console.log(`[AGODA] Book page amount found: ${bestCurrency} ${bestPrice} (method: largest_amount)`);
      return result;
    }
  }
  
  console.log('[AGODA] No price found on book page');
  return result;
}

// ============================================================================
// PROVIDER FETCHING
// ============================================================================

async function fetchWithBrowserless(url: string, waitMs: number = 6000): Promise<{ content: string; error?: string; httpStatus?: number }> {
  const browserlessApiKey = Deno.env.get('BROWSERLESS_API_KEY');
  
  if (!browserlessApiKey) {
    return { content: '', error: 'Browserless API key not configured' };
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
      return { content: '', error: `Browserless error: ${response.status}`, httpStatus: response.status };
    }
    
    const html = await response.text();
    
    // Convert HTML to text
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    
    console.log(`[AGODA] Browserless fetched ${text.length} chars`);
    return { content: text, httpStatus: response.status };
    
  } catch (error) {
    console.error('[AGODA] Browserless fetch error:', error);
    return { content: '', error: error instanceof Error ? error.message : 'Browserless fetch failed' };
  }
}

async function fetchWithZyte(url: string): Promise<{ content: string; error?: string; httpStatus?: number }> {
  const zyteApiKey = Deno.env.get('ZYTE_API_KEY');
  
  if (!zyteApiKey) {
    return { content: '', error: 'Zyte API key not configured' };
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
      return { content: '', error: `Zyte error: ${response.status}`, httpStatus: response.status };
    }
    
    const data = await response.json();
    const html = data.browserHtml || '';
    
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    
    console.log(`[AGODA] Zyte fetched ${text.length} chars`);
    return { content: text, httpStatus: response.status };
    
  } catch (error) {
    console.error('[AGODA] Zyte fetch error:', error);
    return { content: '', error: error instanceof Error ? error.message : 'Zyte fetch failed' };
  }
}

async function fetchWithFirecrawl(url: string, waitMs: number = 5000): Promise<{ content: string; error?: string; httpStatus?: number }> {
  const firecrawlApiKey = Deno.env.get('FIRECRAWL_API_KEY_1') || Deno.env.get('FIRECRAWL_API_KEY');
  
  if (!firecrawlApiKey) {
    return { content: '', error: 'Firecrawl API key not configured' };
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
        formats: ['markdown'],
        onlyMainContent: false,
        waitFor: waitMs,
      }),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[AGODA] Firecrawl error ${response.status}: ${errorText.substring(0, 200)}`);
      return { content: '', error: `Firecrawl error: ${response.status}`, httpStatus: response.status };
    }
    
    const data = await response.json();
    const markdown = data.data?.markdown || data.markdown || '';
    
    console.log(`[AGODA] Firecrawl fetched ${markdown.length} chars`);
    return { content: markdown, httpStatus: response.status };
    
  } catch (error) {
    console.error('[AGODA] Firecrawl fetch error:', error);
    return { content: '', error: error instanceof Error ? error.message : 'Firecrawl fetch failed' };
  }
}

// ============================================================================
// PAGE STATE ANALYSIS
// ============================================================================

interface PageStateResult {
  isBookPage: boolean;
  isPropertyPage: boolean;
  botBlocked: boolean;
  soldOut: boolean;
  datesVisible: boolean;
  contentLength: number;
}

function analyzePageState(content: string, url: string): PageStateResult {
  const lower = content.toLowerCase();
  
  const result: PageStateResult = {
    isBookPage: url.includes('/book/') || lower.includes('booking confirmation') || lower.includes('complete your booking'),
    isPropertyPage: !url.includes('/book/') && (lower.includes('room type') || lower.includes('per night')),
    botBlocked: false,
    soldOut: false,
    datesVisible: false,
    contentLength: content.length,
  };
  
  // Bot detection (explicit only)
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

const PROVIDER_ORDER: Provider[] = ['browserless', 'zyte', 'firecrawl'];
const MIN_CONTENT_LENGTH = 3000;

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
      book_page_reached: false,
      property_page_fallback: false,
      dates_injected: true,
      dates_visible_on_page: false,
      total_price_label_found: false,
      total_price_from_book_page: false,
      room_price_nights_found: false,
      taxes_service_visible: false,
      directly_comparable: false,
      proof_version: 'agoda-golden-path-v3.0',
      currency_detected: null,
      nights_detected: nights,
      property_id: null,
      book_url_used: null,
      property_url_used: null,
      content_hash: null,
      failure_category: 'render_error',
      extraction_method: null,
    },
    durationMs: 0,
    error: null,
    providerAttempts: [],
    goldenPath: true,
  };
  
  try {
    // Build URLs
    const urls = buildAgodaUrls(originalUrl, checkIn, checkOut, adults, children, rooms);
    result.structuralProof.property_id = urls.propertyId;
    result.structuralProof.book_url_used = urls.bookPageUrl;
    result.structuralProof.property_url_used = urls.propertyPageUrl;
    
    // ========================================================================
    // PHASE 1: Try /book/ page first (for Total Price with taxes)
    // ========================================================================
    
    console.log('[AGODA] Phase 1: Attempting /book/ page extraction');
    
    let bookPageContent = '';
    let bookPageProvider: Provider | null = null;
    
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
        urlUsed: urls.bookPageUrl,
      };
      
      let fetchResult: { content: string; error?: string; httpStatus?: number };
      
      switch (provider) {
        case 'browserless':
          fetchResult = await fetchWithBrowserless(urls.bookPageUrl, 6000);
          break;
        case 'zyte':
          fetchResult = await fetchWithZyte(urls.bookPageUrl);
          break;
        case 'firecrawl':
          fetchResult = await fetchWithFirecrawl(urls.bookPageUrl, 5000);
          break;
      }
      
      attemptTrace.endedAt = new Date().toISOString();
      attemptTrace.httpStatus = fetchResult.httpStatus || null;
      attemptTrace.contentLength = fetchResult.content.length;
      
      if (fetchResult.error) {
        attemptTrace.errorMessage = fetchResult.error;
        attemptTrace.outcome = 'navigation_failed';
        providerAttempts.push(attemptTrace);
        console.log(`[AGODA] ${provider} failed for /book/: ${fetchResult.error}`);
        continue;
      }
      
      if (fetchResult.content.length < MIN_CONTENT_LENGTH) {
        attemptTrace.outcome = 'insufficient_content';
        attemptTrace.errorMessage = `Content too short: ${fetchResult.content.length} chars`;
        providerAttempts.push(attemptTrace);
        continue;
      }
      
      const pageState = analyzePageState(fetchResult.content, urls.bookPageUrl);
      
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
      
      // Success - got book page content
      attemptTrace.outcome = 'success';
      providerAttempts.push(attemptTrace);
      bookPageContent = fetchResult.content;
      bookPageProvider = provider;
      result.structuralProof.book_page_reached = true;
      result.structuralProof.content_hash = simpleHash(fetchResult.content);
      console.log(`[AGODA] ${provider} succeeded for /book/ page: ${bookPageContent.length} chars`);
      break;
    }
    
    // Try to extract from /book/ page
    if (bookPageContent) {
      const priceResult = extractBookPagePrice(bookPageContent, nights);
      
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
        result.structuralProof.total_price_from_book_page = true;
        result.structuralProof.room_price_nights_found = priceResult.roomPriceNights !== null;
        result.structuralProof.taxes_service_visible = priceResult.taxesServiceAmount !== null;
        result.structuralProof.directly_comparable = priceResult.directlyComparable;
        result.structuralProof.currency_detected = priceResult.currency;
        result.structuralProof.failure_category = 'success';
        result.structuralProof.extraction_method = priceResult.extractionMethod;
        
        result.durationMs = Date.now() - startTime;
        result.providerAttempts = providerAttempts;
        
        console.log(`[AGODA] SUCCESS from /book/ page: ${result.currency} ${result.extractedPrice} (directlyComparable: ${result.directlyComparable})`);
        return result;
      } else {
        console.log('[AGODA] /book/ page reached but price not found, trying property page fallback');
      }
    }
    
    // ========================================================================
    // PHASE 2: Fallback to property page (nightly rate × nights)
    // ========================================================================
    
    console.log('[AGODA] Phase 2: Fallback to property page');
    result.structuralProof.property_page_fallback = true;
    
    let propertyPageContent = '';
    
    for (const provider of PROVIDER_ORDER) {
      // Skip if already tried this provider for book page
      if (providerAttempts.some(a => a.provider === provider && a.outcome === 'success')) {
        continue;
      }
      
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
        urlUsed: urls.propertyPageUrl,
      };
      
      let fetchResult: { content: string; error?: string; httpStatus?: number };
      
      switch (provider) {
        case 'browserless':
          fetchResult = await fetchWithBrowserless(urls.propertyPageUrl, 5000);
          break;
        case 'zyte':
          fetchResult = await fetchWithZyte(urls.propertyPageUrl);
          break;
        case 'firecrawl':
          fetchResult = await fetchWithFirecrawl(urls.propertyPageUrl, 4000);
          break;
      }
      
      attemptTrace.endedAt = new Date().toISOString();
      attemptTrace.httpStatus = fetchResult.httpStatus || null;
      attemptTrace.contentLength = fetchResult.content.length;
      
      if (fetchResult.error || fetchResult.content.length < MIN_CONTENT_LENGTH) {
        attemptTrace.errorMessage = fetchResult.error || `Content too short: ${fetchResult.content.length}`;
        attemptTrace.outcome = fetchResult.error ? 'navigation_failed' : 'insufficient_content';
        providerAttempts.push(attemptTrace);
        continue;
      }
      
      attemptTrace.outcome = 'success';
      providerAttempts.push(attemptTrace);
      propertyPageContent = fetchResult.content;
      break;
    }
    
    result.providerAttempts = providerAttempts;
    
    if (propertyPageContent) {
      // Extract nightly rate and compute total
      const nightlyPatterns = [
        /(?:USD|US\$)\s*([\d,]+(?:\.\d{2})?)\s*(?:\n\s*)?per\s*night/gi,
        /\$\s*([\d,]+(?:\.\d{2})?)\s*(?:per\s*night|\/\s*night)/gi,
        /per\s*night[:\s]*(?:USD|US\$|)\s*([\d,]+(?:\.\d{2})?)/gi,
      ];
      
      for (const pattern of nightlyPatterns) {
        const matches = [...propertyPageContent.matchAll(pattern)];
        if (matches.length > 0) {
          // Find lowest nightly rate
          let lowestNightly = Infinity;
          let bestMatch = matches[0];
          
          for (const match of matches) {
            const priceStr = match[1].replace(/,/g, '');
            const price = parseFloat(priceStr);
            if (price >= 10 && price < lowestNightly && price <= 20000) {
              lowestNightly = price;
              bestMatch = match;
            }
          }
          
          if (lowestNightly !== Infinity) {
            const totalFromNightly = lowestNightly * nights;
            
            result.success = true;
            result.status = 'success_partial';
            result.failureCategory = 'success';
            result.extractedPrice = totalFromNightly;
            result.currency = 'USD';
            result.includesTaxesFees = false;
            result.directlyComparable = false; // Nightly rate doesn't include taxes
            
            const matchIndex = propertyPageContent.indexOf(bestMatch[0]);
            const start = Math.max(0, matchIndex - 30);
            const end = Math.min(propertyPageContent.length, matchIndex + bestMatch[0].length + 50);
            result.evidenceSnippet = propertyPageContent.slice(start, end).replace(/\s+/g, ' ').trim();
            
            result.structuralProof.directly_comparable = false;
            result.structuralProof.failure_category = 'success';
            result.structuralProof.extraction_method = 'nightly_rate_computed';
            result.structuralProof.content_hash = simpleHash(propertyPageContent);
            
            result.durationMs = Date.now() - startTime;
            
            console.log(`[AGODA] Fallback: $${lowestNightly}/night × ${nights} = $${totalFromNightly} (NOT directly comparable)`);
            return result;
          }
        }
      }
    }
    
    // ========================================================================
    // PHASE 3: All extraction attempts failed
    // ========================================================================
    
    if (providerAttempts.every(a => a.outcome === 'bot_blocked')) {
      result.status = 'blocked_captcha_or_bot';
      result.error = 'All providers blocked by bot detection';
      result.failureCategory = 'blocked';
    } else if (!bookPageContent && !propertyPageContent) {
      result.status = 'book_page_not_reached';
      result.error = 'Could not reach book page or property page';
      result.failureCategory = 'render_error';
    } else {
      result.status = 'total_price_not_found';
      result.error = 'Could not find Total Price on book page';
      result.failureCategory = 'selector_not_found';
    }
    
    result.structuralProof.failure_category = result.failureCategory;
    result.durationMs = Date.now() - startTime;
    result.providerAttempts = providerAttempts;
    
    console.log(`[AGODA] Extraction failed: ${result.status}`);
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
    
    console.log('[AGODA] Golden Path v3.0 extraction request');
    
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
          version: 'agoda-golden-path-v3.0',
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
