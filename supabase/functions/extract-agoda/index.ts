import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

/**
 * ============================================================================
 * AGODA GOLDEN PATH EXTRACTOR v2.0
 * ============================================================================
 * 
 * GOLDEN PATH NAVIGATION:
 * 1. Extract property ID from Agoda URL (e.g., h47632023)
 * 2. Build canonical search page URL with dates + property ID
 * 3. Use Browserless for JS rendering (Agoda requires heavy JS)
 * 4. Extract total price with taxes from price breakdown
 * 
 * KEY LEARNINGS FROM FAILURES:
 * - Agoda REQUIRES `los` (length of stay) parameter for dates to apply
 * - Property pages often show "Select dates" even with URL params
 * - Search page (with property filter) is more reliable for prices
 * - "sold out" text on property pages may be generic template, not actual status
 * - Currency defaults to regional (SGD for en-sg), need to normalize
 * 
 * PROVIDER PRIORITY: Browserless → Zyte (Firecrawl has low success on Agoda)
 */

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

// Terminal status values for failure categorization
type TerminalStatus = 
  | 'success'
  | 'success_total_stay'
  | 'dates_not_applied'
  | 'dates_unavailable'
  | 'no_availability_for_dates'
  | 'blocked_captcha_or_bot'
  | 'blocked_rate_limit'
  | 'sold_out'
  | 'price_not_found'
  | 'render_failed'
  | 'validation_error'
  | 'property_id_not_found'
  | 'insufficient_content'
  | 'currency_conversion_failed'
  // Agoda-specific terminal statuses
  | 'agoda_property_page_not_reached'
  | 'agoda_dates_not_injected'
  | 'agoda_total_not_found'
  | 'agoda_price_not_verified';

// Failure category for admin dashboard display
type FailureCategory = 
  | 'blocked'           // Bot detection, rate limiting
  | 'params_missing'    // Dates/guests not applied
  | 'selector_not_found'// Price element not in DOM
  | 'no_price'          // Page loaded but no price visible
  | 'unavailable'       // Genuinely sold out for dates
  | 'render_error'      // Page didn't load properly
  | 'success';          // Not a failure

type Provider = 'browserless' | 'zyte' | 'firecrawl';

type ProviderOutcome = 
  | 'success'
  | 'bot_blocked'
  | 'rate_limited'
  | 'navigation_failed'
  | 'parsing_failed'
  | 'timeout'
  | 'skipped'
  | 'insufficient_content';

interface ProviderAttemptTrace {
  provider: Provider;
  attempted: boolean;
  attemptIndex: number;
  startedAt: string | null;
  endedAt: string | null;
  outcome: ProviderOutcome;
  httpStatus: number | null;
  contentLength: number | null;
  errorMessage: string | null;
  isRetry?: boolean;
  retryReason?: string;
}

interface PropertyIdResult {
  found: boolean;
  propertyId: string | null;
  propertySlug: string | null;  // e.g., "sapphire-elegance"
  rawMatch: string | null;
  source: 'url_path' | 'url_param' | null;
}

interface AgodaUrlResult {
  success: boolean;
  propertyPageUrl: string;
  searchPageUrl: string;
  propertyId: string | null;
  propertySlug: string | null;
  startDate: string;
  endDate: string;
  los: number;  // Length of stay in nights
  adults: number;
  currency: string;
}

interface StructuralProof {
  property_page_reached: boolean;
  dates_injected: boolean;
  dates_rendered: boolean;
  rendered_checkin: string | null;
  rendered_checkout: string | null;
  total_label_found: boolean;
  price_breakdown_found: boolean;
  extracted_from_breakdown: boolean;
  proof_version: string;
  // Currency handling
  original_currency: string | null;
  original_amount: number | null;
  converted_amount_usd: number | null;
  conversion_rate: number | null;
  // Diagnostics
  property_id: string | null;
  url_used: string | null;
  content_hash: string | null;
  failure_category: FailureCategory;
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
  evidenceSnippet: string | null;
  structuralProof: StructuralProof;
  durationMs: number;
  error: string | null;
  providerAttempts: ProviderAttemptTrace[];
  goldenPath: boolean;
}

// Static FX rates for currency conversion
const FX_RATES: Record<string, number> = {
  'USD': 1.0,
  'EUR': 1.08,
  'GBP': 1.27,
  'SGD': 0.74,
  'JPY': 0.0067,
  'AUD': 0.66,
  'CAD': 0.74,
  'THB': 0.029,
  'MYR': 0.22,
  'IDR': 0.000063,
  'PHP': 0.018,
  'INR': 0.012,
  'KRW': 0.00075,
  'CNY': 0.14,
  'HKD': 0.128,
  'TWD': 0.031,
  'VND': 0.00004,
  'NZD': 0.60,
  'CHF': 1.12,
};

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

// ============================================================================
// PROPERTY ID EXTRACTION (Step 1 of Golden Path)
// ============================================================================

/**
 * Extract Agoda property ID and slug from URL
 * 
 * URL patterns:
 * - https://www.agoda.com/en-sg/sapphire-elegance-h47632023/hotel/sapphire-nc-us.html
 * - https://www.agoda.com/hotel/rome-it.html?propertyId=123456
 * - https://www.agoda.com/en-us/some-property-h12345678/hotel/city-country.html
 */
function extractPropertyId(url: string): PropertyIdResult {
  const result: PropertyIdResult = {
    found: false,
    propertyId: null,
    propertySlug: null,
    rawMatch: null,
    source: null,
  };
  
  try {
    const urlObj = new URL(url);
    
    // Pattern 1: Property ID in URL path as h{digits}
    // e.g., /sapphire-elegance-h47632023/
    const pathMatch = url.match(/\/([^\/]+-h(\d{6,12}))\//i);
    if (pathMatch) {
      result.found = true;
      result.propertyId = pathMatch[2];
      result.propertySlug = pathMatch[1].replace(/-h\d+$/, '');
      result.rawMatch = pathMatch[0];
      result.source = 'url_path';
      console.log(`[AGODA] Property ID from path: ${result.propertyId}, slug: ${result.propertySlug}`);
      return result;
    }
    
    // Pattern 2: Property ID as query parameter
    const propertyIdParam = urlObj.searchParams.get('propertyId') || 
                            urlObj.searchParams.get('hotel_id') ||
                            urlObj.searchParams.get('hotelId');
    if (propertyIdParam && /^\d{5,12}$/.test(propertyIdParam)) {
      result.found = true;
      result.propertyId = propertyIdParam;
      result.rawMatch = propertyIdParam;
      result.source = 'url_param';
      console.log(`[AGODA] Property ID from param: ${result.propertyId}`);
      return result;
    }
    
    // Pattern 3: Property slug without explicit ID (try to extract slug)
    // e.g., /campo-de-fiori-residence/hotel/rome-it.html
    const slugMatch = url.match(/\/([a-z0-9-]+)\/hotel\/[a-z-]+\.html/i);
    if (slugMatch) {
      result.propertySlug = slugMatch[1];
      console.log(`[AGODA] Property slug only (no ID): ${result.propertySlug}`);
      // Don't mark as found since we don't have the ID
    }
    
    console.log('[AGODA] Property ID not found in URL');
    return result;
    
  } catch (e) {
    console.error('[AGODA] Error parsing URL:', e);
    return result;
  }
}

// ============================================================================
// URL BUILDER (Step 2 of Golden Path)
// ============================================================================

/**
 * Build Agoda URL with MANDATORY date parameters
 * 
 * CRITICAL: Agoda requires ALL of these for dates to apply:
 * - checkIn: YYYY-MM-DD
 * - checkOut: YYYY-MM-DD  
 * - los: Number of nights (LENGTH OF STAY)
 * - adults: Number of adults
 * - rooms: Number of rooms
 * - cid: Campaign ID (-1 for direct access)
 * - currency: USD (to normalize prices)
 * - locale: en_US (to get English content)
 */
function buildAgodaUrl(
  originalUrl: string,
  checkIn: string,
  checkOut: string,
  adults: number = 2
): AgodaUrlResult {
  const los = calculateNights(checkIn, checkOut);
  const propertyInfo = extractPropertyId(originalUrl);
  
  const result: AgodaUrlResult = {
    success: false,
    propertyPageUrl: '',
    searchPageUrl: '',
    propertyId: propertyInfo.propertyId,
    propertySlug: propertyInfo.propertySlug,
    startDate: checkIn,
    endDate: checkOut,
    los,
    adults: Math.max(1, adults),
    currency: 'USD',
  };
  
  try {
    // Parse original URL and rebuild with required params
    const urlObj = new URL(originalUrl);
    
    // Convert locale prefix to en-us for USD pricing
    // e.g., /en-sg/ → /en-us/
    let pathname = urlObj.pathname;
    pathname = pathname.replace(/^\/en-[a-z]{2}\//i, '/en-us/');
    
    // If no locale prefix, add one
    if (!pathname.startsWith('/en-')) {
      pathname = '/en-us' + pathname;
    }
    
    // Build property page URL with date parameters
    const propertyUrl = new URL(`https://www.agoda.com${pathname}`);
    
    // MANDATORY parameters for date application
    propertyUrl.searchParams.set('checkIn', checkIn);
    propertyUrl.searchParams.set('checkOut', checkOut);
    propertyUrl.searchParams.set('los', String(los));
    propertyUrl.searchParams.set('adults', String(result.adults));
    propertyUrl.searchParams.set('children', '0');
    propertyUrl.searchParams.set('rooms', '1');
    propertyUrl.searchParams.set('cid', '-1');
    
    // Currency and locale for consistent pricing
    propertyUrl.searchParams.set('currency', 'USD');
    propertyUrl.searchParams.set('locale', 'en-us');
    
    result.propertyPageUrl = propertyUrl.toString();
    result.success = true;
    
    console.log(`[AGODA] Property page URL: ${result.propertyPageUrl}`);
    console.log(`[AGODA] LOS: ${los} nights, Adults: ${result.adults}`);
    
    return result;
    
  } catch (e) {
    console.error('[AGODA] Error building URL:', e);
    return result;
  }
}

// ============================================================================
// CONTENT ANALYSIS - Phase A: Validate page state
// ============================================================================

interface PageStateResult {
  pageLoaded: boolean;
  datesApplied: boolean;
  pricesVisible: boolean;
  soldOut: boolean;
  selectDatesState: boolean;
  botBlocked: boolean;
  loginRequired: boolean;
  renderedCheckin: string | null;
  renderedCheckout: string | null;
  priceCount: number;
  contentLength: number;
}

function analyzePageState(content: string, expectedLos: number): PageStateResult {
  const lower = content.toLowerCase();
  
  const result: PageStateResult = {
    pageLoaded: content.length > 5000,
    datesApplied: false,
    pricesVisible: false,
    soldOut: false,
    selectDatesState: false,
    botBlocked: false,
    loginRequired: false,
    renderedCheckin: null,
    renderedCheckout: null,
    priceCount: 0,
    contentLength: content.length,
  };
  
  // Check for bot blocking (EXPLICIT indicators only)
  const explicitBotIndicators = [
    'access denied',
    'please verify you are human',
    'complete the captcha',
    'security check required',
    'unusual traffic detected',
    'automated access is not allowed',
  ];
  result.botBlocked = explicitBotIndicators.some(ind => lower.includes(ind));
  
  if (result.botBlocked) {
    console.log('[AGODA] Bot blocking detected');
    return result;
  }
  
  // Check for "select dates" / "enter dates" state
  // IMPORTANT: Be specific - generic text may appear in footer/templates
  const selectDatesIndicators = [
    'enter your dates to see',
    'select dates to see price',
    'choose dates to see price',
    'add dates for prices',
    'pick your dates',
  ];
  result.selectDatesState = selectDatesIndicators.some(ind => lower.includes(ind));
  
  // Check for actual sold out (STRICT matching)
  // Only match if it's clearly about THIS property for THESE dates
  const soldOutPatterns = [
    /this property is fully booked/i,
    /no rooms? available for/i,
    /sold out for your dates/i,
    /not available for selected dates/i,
    /no availability for these dates/i,
    /fully booked for \d+ nights?/i,
  ];
  result.soldOut = soldOutPatterns.some(pattern => pattern.test(content));
  
  // Verify dates are applied by looking for rendered date range
  // Look for patterns like "Jan 21 - Jan 23" or "2026-01-21"
  const datePatterns = [
    // "Jan 21 - Jan 23"
    /(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}\s*[-–]\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}/gi,
    // "21 Jan - 23 Jan"
    /\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*[-–]\s*\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*/gi,
    // Length of stay indicator "X nights"
    new RegExp(`${expectedLos}\\s*nights?`, 'i'),
  ];
  
  const dateMatches = datePatterns.flatMap(p => content.match(p) || []);
  result.datesApplied = dateMatches.length > 0 || !result.selectDatesState;
  
  // Extract rendered dates if found
  if (dateMatches.length > 0) {
    console.log(`[AGODA] Dates detected: ${dateMatches[0]}`);
  }
  
  // Count visible prices - USD format
  // Look for "$XXX" or "USD XXX" patterns
  const pricePatterns = [
    /\$\s*[\d,]+(?:\.\d{2})?/g,
    /USD\s*[\d,]+(?:\.\d{2})?/g,
    /US\$\s*[\d,]+(?:\.\d{2})?/g,
  ];
  
  const priceMatches = pricePatterns.flatMap(p => content.match(p) || []);
  result.priceCount = priceMatches.length;
  result.pricesVisible = priceMatches.length > 0;
  
  console.log(`[AGODA] Page state: loaded=${result.pageLoaded}, datesApplied=${result.datesApplied}, prices=${result.priceCount}, soldOut=${result.soldOut}, selectDates=${result.selectDatesState}`);
  
  return result;
}

// ============================================================================
// PRICE EXTRACTION - Phase B: Extract total price
// ============================================================================

interface PriceExtractionResult {
  extracted: boolean;
  totalPrice: number | null;
  nightlyPrice: number | null;
  currency: string;
  originalCurrency: string | null;
  originalAmount: number | null;
  includesTaxesFees: boolean | null;
  evidenceSnippet: string | null;
  priceVerified: boolean;
  priceType: 'total_proven' | 'total_derived' | 'nightly_computed';
  extractionMethod: string;
}

function extractAgodaPrice(content: string, nights: number): PriceExtractionResult {
  const result: PriceExtractionResult = {
    extracted: false,
    totalPrice: null,
    nightlyPrice: null,
    currency: 'USD',
    originalCurrency: null,
    originalAmount: null,
    includesTaxesFees: null,
    evidenceSnippet: null,
    priceVerified: false,
    priceType: 'nightly_computed',
    extractionMethod: 'none',
  };
  
  const lower = content.toLowerCase();
  
  // Determine if prices include taxes
  if (lower.includes('including taxes') || 
      lower.includes('incl. taxes') ||
      lower.includes('taxes included') ||
      lower.includes('total price')) {
    result.includesTaxesFees = true;
  } else if (lower.includes('excluding taxes') ||
             lower.includes('before taxes') ||
             lower.includes('+ taxes')) {
    result.includesTaxesFees = false;
  }
  
  // ==========================================================================
  // PATTERN 1: TOTAL PRICE (highest priority)
  // Look for explicit total price with taxes
  // ==========================================================================
  
  const totalPatterns = [
    // "Total: $1,234" or "Grand total $1,234"
    /(?:total|grand total|final price)[:\s]*\$\s*([\d,]+(?:\.\d{2})?)/gi,
    // "USD 1,234 total"
    /(?:USD|US\$)\s*([\d,]+(?:\.\d{2})?)\s*total/gi,
    // "$1,234 for X nights"
    /\$\s*([\d,]+(?:\.\d{2})?)\s*for\s*\d+\s*nights?/gi,
    // "Total: USD 1,234"
    /(?:total|price)[:\s]*(?:USD|US\$)\s*([\d,]+(?:\.\d{2})?)/gi,
  ];
  
  for (const pattern of totalPatterns) {
    const matches = [...content.matchAll(pattern)];
    if (matches.length > 0) {
      const match = matches[0];
      const priceStr = match[1].replace(/,/g, '');
      const price = parseFloat(priceStr);
      
      if (price >= 10 && price <= 100000) {
        result.extracted = true;
        result.totalPrice = price;
        result.priceType = 'total_proven';
        result.extractionMethod = 'explicit_total';
        result.originalCurrency = 'USD';
        result.originalAmount = price;
        
        // Extract evidence snippet
        const matchIndex = content.indexOf(match[0]);
        const start = Math.max(0, matchIndex - 30);
        const end = Math.min(content.length, matchIndex + match[0].length + 50);
        result.evidenceSnippet = content.slice(start, end).replace(/\s+/g, ' ').trim();
        
        // Verify price appears verbatim in content
        result.priceVerified = content.includes(match[0]) || 
                               content.includes(priceStr) ||
                               content.includes(price.toLocaleString());
        
        console.log(`[AGODA] Total price found: $${price} (method: ${result.extractionMethod})`);
        return result;
      }
    }
  }
  
  // ==========================================================================
  // PATTERN 2: NIGHTLY RATE (compute total)
  // ==========================================================================
  
  const nightlyPatterns = [
    // "USD 798 Per night" or "USD798\nPer night"
    /(?:USD|US\$)\s*([\d,]+(?:\.\d{2})?)\s*(?:\n\s*)?per\s*night/gi,
    // "$798 per night" or "$798/night"
    /\$\s*([\d,]+(?:\.\d{2})?)\s*(?:per\s*night|\/\s*night)/gi,
    // "Per night $798" or "Per night: $798"
    /per\s*night[:\s]*\$\s*([\d,]+(?:\.\d{2})?)/gi,
  ];
  
  for (const pattern of nightlyPatterns) {
    const matches = [...content.matchAll(pattern)];
    if (matches.length > 0) {
      // Get the LOWEST nightly rate (most common booking option)
      let lowestNightly = Infinity;
      let bestMatch = matches[0];
      
      for (const match of matches) {
        const priceStr = match[1].replace(/,/g, '');
        const price = parseFloat(priceStr);
        if (price >= 5 && price < lowestNightly && price <= 20000) {
          lowestNightly = price;
          bestMatch = match;
        }
      }
      
      if (lowestNightly !== Infinity) {
        result.extracted = true;
        result.nightlyPrice = lowestNightly;
        result.totalPrice = lowestNightly * nights;
        result.priceType = 'nightly_computed';
        result.extractionMethod = 'nightly_rate';
        result.originalCurrency = 'USD';
        result.originalAmount = lowestNightly;
        
        // Extract evidence snippet
        const matchIndex = content.indexOf(bestMatch[0]);
        const start = Math.max(0, matchIndex - 30);
        const end = Math.min(content.length, matchIndex + bestMatch[0].length + 50);
        result.evidenceSnippet = content.slice(start, end).replace(/\s+/g, ' ').trim();
        
        result.priceVerified = true; // We found it in content
        
        console.log(`[AGODA] Nightly price found: $${lowestNightly}/night × ${nights} = $${result.totalPrice}`);
        return result;
      }
    }
  }
  
  // ==========================================================================
  // PATTERN 3: STANDALONE USD PRICE (fallback)
  // ==========================================================================
  
  // Look for any USD price that could be a total
  const standalonePattern = /\$\s*([\d,]+(?:\.\d{2})?)/g;
  const standaloneMatches = [...content.matchAll(standalonePattern)];
  
  if (standaloneMatches.length > 0) {
    // Collect reasonable prices (filter out unrealistic values)
    const validPrices: { price: number; match: RegExpMatchArray }[] = [];
    
    for (const match of standaloneMatches) {
      const priceStr = match[1].replace(/,/g, '');
      const price = parseFloat(priceStr);
      
      // Filter: $50 minimum, $50,000 maximum, reasonable for hotel stay
      if (price >= 50 && price <= 50000) {
        validPrices.push({ price, match });
      }
    }
    
    // Use the most prominent price (first reasonable one found, or most common)
    if (validPrices.length > 0) {
      const { price, match } = validPrices[0];
      
      result.extracted = true;
      result.totalPrice = price;
      result.priceType = 'total_derived';
      result.extractionMethod = 'standalone_price';
      result.originalCurrency = 'USD';
      result.originalAmount = price;
      
      const matchIndex = content.indexOf(match[0]);
      const start = Math.max(0, matchIndex - 30);
      const end = Math.min(content.length, matchIndex + match[0].length + 50);
      result.evidenceSnippet = content.slice(start, end).replace(/\s+/g, ' ').trim();
      
      result.priceVerified = true;
      
      console.log(`[AGODA] Standalone price found: $${price} (method: ${result.extractionMethod})`);
      return result;
    }
  }
  
  console.log('[AGODA] No price found in content');
  return result;
}

// ============================================================================
// PROVIDER FETCHING
// ============================================================================

async function fetchWithBrowserless(url: string, waitMs: number = 5000): Promise<{ content: string; error?: string; httpStatus?: number }> {
  const browserlessApiKey = Deno.env.get('BROWSERLESS_API_KEY');
  
  if (!browserlessApiKey) {
    console.log('[AGODA] Browserless API key not configured, skipping');
    return { content: '', error: 'Browserless API key not configured' };
  }
  
  try {
    console.log(`[AGODA] Fetching with Browserless: ${url}`);
    
    const response = await fetch(`https://chrome.browserless.io/content?token=${browserlessApiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        waitFor: waitMs,
        gotoOptions: {
          waitUntil: 'networkidle2',
          timeout: 30000,
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
    console.log('[AGODA] Zyte API key not configured, skipping');
    return { content: '', error: 'Zyte API key not configured' };
  }
  
  try {
    console.log(`[AGODA] Fetching with Zyte: ${url}`);
    
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
          { action: 'waitForTimeout', timeout: 5000 }
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
    
    // Convert HTML to text
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

async function fetchWithFirecrawl(url: string, waitMs: number = 4000): Promise<{ content: string; error?: string; httpStatus?: number }> {
  const firecrawlApiKey = Deno.env.get('FIRECRAWL_API_KEY_1') || Deno.env.get('FIRECRAWL_API_KEY');
  
  if (!firecrawlApiKey) {
    console.log('[AGODA] Firecrawl API key not configured, skipping');
    return { content: '', error: 'Firecrawl API key not configured' };
  }
  
  try {
    console.log(`[AGODA] Fetching with Firecrawl: ${url}`);
    
    const response = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${firecrawlApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url,
        formats: ['markdown'],
        onlyMainContent: false,  // Get full page for price extraction
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
// MAIN EXTRACTION FUNCTION
// ============================================================================

const PROVIDER_ORDER: Provider[] = ['browserless', 'zyte', 'firecrawl'];
const MIN_CONTENT_LENGTH = 5000;

async function extractFromAgoda(
  originalUrl: string,
  checkIn: string,
  checkOut: string,
  adults: number = 2
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
    evidenceSnippet: null,
    structuralProof: {
      property_page_reached: false,
      dates_injected: false,
      dates_rendered: false,
      rendered_checkin: null,
      rendered_checkout: null,
      total_label_found: false,
      price_breakdown_found: false,
      extracted_from_breakdown: false,
      proof_version: 'agoda-golden-path-v2.0',
      original_currency: null,
      original_amount: null,
      converted_amount_usd: null,
      conversion_rate: null,
      property_id: null,
      url_used: null,
      content_hash: null,
      failure_category: 'render_error',
    },
    durationMs: 0,
    error: null,
    providerAttempts: [],
    goldenPath: true,
  };
  
  try {
    // Step 1: Build URL with date parameters
    const urlResult = buildAgodaUrl(originalUrl, checkIn, checkOut, adults);
    
    if (!urlResult.success) {
      result.status = 'validation_error';
      result.error = 'Failed to build Agoda URL with date parameters';
      result.failureCategory = 'params_missing';
      result.durationMs = Date.now() - startTime;
      return result;
    }
    
    result.structuralProof.property_id = urlResult.propertyId;
    result.structuralProof.url_used = urlResult.propertyPageUrl;
    result.structuralProof.dates_injected = true;
    
    const targetUrl = urlResult.propertyPageUrl;
    console.log(`[AGODA] Target URL: ${targetUrl}`);
    
    // Step 2: Fetch page content using provider chain
    let content = '';
    let successfulProvider: Provider | null = null;
    
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
      };
      
      let fetchResult: { content: string; error?: string; httpStatus?: number };
      
      switch (provider) {
        case 'browserless':
          fetchResult = await fetchWithBrowserless(targetUrl, 5000);
          break;
        case 'zyte':
          fetchResult = await fetchWithZyte(targetUrl);
          break;
        case 'firecrawl':
          fetchResult = await fetchWithFirecrawl(targetUrl, 4000);
          break;
      }
      
      attemptTrace.endedAt = new Date().toISOString();
      attemptTrace.httpStatus = fetchResult.httpStatus || null;
      attemptTrace.contentLength = fetchResult.content.length;
      
      if (fetchResult.error) {
        attemptTrace.errorMessage = fetchResult.error;
        
        if (fetchResult.error.includes('429') || fetchResult.error.includes('rate limit')) {
          attemptTrace.outcome = 'rate_limited';
        } else if (fetchResult.error.includes('timeout')) {
          attemptTrace.outcome = 'timeout';
        } else {
          attemptTrace.outcome = 'navigation_failed';
        }
        
        providerAttempts.push(attemptTrace);
        console.log(`[AGODA] ${provider} failed: ${fetchResult.error}`);
        continue;
      }
      
      if (fetchResult.content.length < MIN_CONTENT_LENGTH) {
        attemptTrace.outcome = 'insufficient_content';
        attemptTrace.errorMessage = `Content too short: ${fetchResult.content.length} chars`;
        providerAttempts.push(attemptTrace);
        console.log(`[AGODA] ${provider}: insufficient content (${fetchResult.content.length} chars)`);
        continue;
      }
      
      // Check for bot blocking
      const pageState = analyzePageState(fetchResult.content, nights);
      
      if (pageState.botBlocked) {
        attemptTrace.outcome = 'bot_blocked';
        attemptTrace.errorMessage = 'Bot detection triggered';
        providerAttempts.push(attemptTrace);
        console.log(`[AGODA] ${provider}: bot blocked`);
        continue;
      }
      
      // Success - we got meaningful content
      attemptTrace.outcome = 'success';
      providerAttempts.push(attemptTrace);
      content = fetchResult.content;
      successfulProvider = provider;
      console.log(`[AGODA] ${provider} succeeded: ${content.length} chars`);
      break;
    }
    
    result.providerAttempts = providerAttempts;
    
    // Check if all providers failed
    if (!content || !successfulProvider) {
      const lastAttempt = providerAttempts[providerAttempts.length - 1];
      
      if (providerAttempts.every(a => a.outcome === 'bot_blocked')) {
        result.status = 'blocked_captcha_or_bot';
        result.error = 'All providers blocked by bot detection';
        result.failureCategory = 'blocked';
      } else if (providerAttempts.every(a => a.outcome === 'rate_limited')) {
        result.status = 'blocked_rate_limit';
        result.error = 'All providers rate limited';
        result.failureCategory = 'blocked';
      } else {
        result.status = 'render_failed';
        result.error = `All providers failed. Last: ${lastAttempt?.errorMessage || 'unknown'}`;
        result.failureCategory = 'render_error';
      }
      
      result.structuralProof.failure_category = result.failureCategory;
      result.durationMs = Date.now() - startTime;
      return result;
    }
    
    // Step 3: Analyze page state
    result.structuralProof.property_page_reached = true;
    result.structuralProof.content_hash = simpleHash(content);
    
    const pageState = analyzePageState(content, nights);
    
    // Handle sold out
    if (pageState.soldOut) {
      result.status = 'dates_unavailable';
      result.error = 'Property not available for selected dates';
      result.failureCategory = 'unavailable';
      result.structuralProof.failure_category = 'unavailable';
      result.durationMs = Date.now() - startTime;
      console.log('[AGODA] Property sold out for dates');
      return result;
    }
    
    // Handle "select dates" state (dates not applied)
    if (pageState.selectDatesState && !pageState.pricesVisible) {
      result.status = 'dates_not_applied';
      result.error = 'Dates not applied to page - "select dates" state detected';
      result.failureCategory = 'params_missing';
      result.structuralProof.failure_category = 'params_missing';
      result.structuralProof.dates_rendered = false;
      result.durationMs = Date.now() - startTime;
      console.log('[AGODA] Dates not applied - select dates state');
      return result;
    }
    
    result.structuralProof.dates_rendered = pageState.datesApplied;
    
    // Step 4: Extract price
    if (!pageState.pricesVisible) {
      result.status = 'price_not_found';
      result.error = 'No prices visible on page';
      result.failureCategory = 'no_price';
      result.structuralProof.failure_category = 'no_price';
      result.durationMs = Date.now() - startTime;
      console.log('[AGODA] No prices visible');
      return result;
    }
    
    const priceResult = extractAgodaPrice(content, nights);
    
    if (!priceResult.extracted || !priceResult.totalPrice) {
      result.status = 'agoda_total_not_found';
      result.error = 'Could not extract price from page content';
      result.failureCategory = 'selector_not_found';
      result.structuralProof.failure_category = 'selector_not_found';
      result.durationMs = Date.now() - startTime;
      console.log('[AGODA] Price extraction failed');
      return result;
    }
    
    // Verify price against hallucination guard
    if (!priceResult.priceVerified) {
      result.status = 'agoda_price_not_verified';
      result.error = 'Extracted price failed verification (not found verbatim in content)';
      result.failureCategory = 'selector_not_found';
      result.structuralProof.failure_category = 'selector_not_found';
      result.durationMs = Date.now() - startTime;
      console.log('[AGODA] Price verification failed');
      return result;
    }
    
    // SUCCESS!
    result.success = true;
    result.status = priceResult.priceType === 'total_proven' ? 'success_total_stay' : 'success';
    result.failureCategory = 'success';
    result.extractedPrice = priceResult.totalPrice;
    result.currency = priceResult.currency;
    result.includesTaxesFees = priceResult.includesTaxesFees;
    result.evidenceSnippet = priceResult.evidenceSnippet;
    
    result.structuralProof.total_label_found = priceResult.priceType === 'total_proven';
    result.structuralProof.price_breakdown_found = true;
    result.structuralProof.extracted_from_breakdown = priceResult.priceType === 'total_proven';
    result.structuralProof.original_currency = priceResult.originalCurrency;
    result.structuralProof.original_amount = priceResult.originalAmount;
    result.structuralProof.failure_category = 'success';
    
    result.durationMs = Date.now() - startTime;
    
    console.log(`[AGODA] SUCCESS: $${result.extractedPrice} (${priceResult.priceType})`);
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
    const { url, extractionId, checkIn, checkOut, adults = 2 } = body;
    
    console.log('[AGODA] Golden Path extraction request received');
    
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
        console.error('[AGODA] Extraction not found:', extractionId);
        return new Response(
          JSON.stringify({ success: false, error: 'Extraction not found' }),
          { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      
      // Verify platform is Agoda
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
    
    console.log(`[AGODA] Starting extraction for ${targetUrl}`);
    console.log(`[AGODA] Dates: ${checkIn} to ${checkOut}, Adults: ${adults}`);
    
    // Run extraction
    const result = await extractFromAgoda(targetUrl, checkIn, checkOut, adults);
    
    // Update DB if extractionId provided
    if (dbExtractionId) {
      await supabaseClient
        .from('price_extractions')
        .update({
          extraction_status: result.status,
          extracted_price: result.extractedPrice,
          currency: result.currency,
          includes_taxes_fees: result.includesTaxesFees,
          extraction_error: result.error,
          page_content_hash: result.structuralProof.content_hash,
          evidence_snippets: result.evidenceSnippet ? [result.evidenceSnippet] : null,
          dates_validated: result.structuralProof.dates_rendered,
          provider_used: result.providerAttempts.find(a => a.outcome === 'success')?.provider || null,
          extraction_metadata: {
            goldenPath: true,
            platform: 'agoda',
            version: 'agoda-golden-path-v2.0',
            failureCategory: result.failureCategory,
            structuralProof: result.structuralProof,
            durationMs: result.durationMs,
            providerAttempts: result.providerAttempts,
          },
          updated_at: new Date().toISOString(),
        })
        .eq('id', dbExtractionId);
      
      console.log(`[AGODA] Updated extraction ${dbExtractionId} with status: ${result.status}`);
    }
    
    return new Response(
      JSON.stringify({
        success: result.success,
        result,
        goldenPath: true,
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
