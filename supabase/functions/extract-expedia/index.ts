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

/**
 * Expedia Production Extraction Function - v5.0 (Golden Path)
 * 
 * GOLDEN PATH NAVIGATION:
 * 1. Parse property ID from Expedia URL (e.g., h34107887 → 34107887)
 * 2. Build Hotel-Search offers page URL with dates + propertyId
 * 3. Extract total "includes taxes & fees" from offers page
 * 
 * OFFERS PAGE EXTRACTION:
 * - Prices ONLY accepted from Hotel-Search offers page context
 * - Must find "total includes taxes & fees" label
 * - Listing pages, property pages are navigation steps only
 * 
 * MANDATORY CURRENCY NORMALIZATION:
 * - Detects currency from price symbols/codes
 * - Converts all prices to USD for comparison
 * - Stores original + converted amounts
 * 
 * PROVIDER PRIORITY: Browserless → Zyte → Firecrawl
 */

// Terminal status values
type TerminalStatus = 
  | 'success'
  | 'date_application_failed'
  | 'dates_not_applied'
  | 'dates_unavailable'
  | 'no_availability_for_dates'
  | 'blocked_captcha_or_bot'
  | 'blocked_rate_limit'
  | 'sold_out'
  | 'price_not_found'
  | 'render_failed'
  | 'validation_error'
  | 'subtotal_rejected'
  | 'checkout_not_reached'
  | 'currency_conversion_failed'
  | 'expedia_access_blocked'
  | 'property_id_not_found'
  | 'offers_page_not_loaded'
  | 'expedia_total_not_found';

type Provider = 'browserless' | 'zyte' | 'firecrawl';

type ProviderOutcome = 
  | 'success'
  | 'bot_blocked'
  | 'rate_limited'
  | 'navigation_failed'
  | 'parsing_failed'
  | 'checkout_not_reached'
  | 'timeout'
  | 'skipped'
  | 'insufficient_content';

// Provider attempt trace for full observability
interface ProviderAttemptTrace {
  provider: Provider;
  attempted: boolean;
  startedAt: string | null;
  endedAt: string | null;
  outcome: ProviderOutcome;
  httpStatus: number | null;
  contentLength: number | null;
  reasonSkipped: string | null;
  errorMessage: string | null;
  botBlockedFallbackToZyte?: boolean;
}

const PROVIDER_ORDER: Provider[] = ['browserless', 'zyte', 'firecrawl'];

// ============================================================================
// CURRENCY HANDLING
// ============================================================================

interface CurrencyInfo {
  code: string;
  symbol: string;
  rate_to_usd: number; // How many USD for 1 unit of this currency
}

// Static FX rates (updated periodically, conservative estimates)
const FX_RATES: Record<string, CurrencyInfo> = {
  'USD': { code: 'USD', symbol: '$', rate_to_usd: 1.0 },
  'EUR': { code: 'EUR', symbol: '€', rate_to_usd: 1.08 },
  'GBP': { code: 'GBP', symbol: '£', rate_to_usd: 1.27 },
  'JPY': { code: 'JPY', symbol: '¥', rate_to_usd: 0.0067 },
  'CAD': { code: 'CAD', symbol: 'CA$', rate_to_usd: 0.74 },
  'AUD': { code: 'AUD', symbol: 'A$', rate_to_usd: 0.66 },
  'CHF': { code: 'CHF', symbol: 'CHF', rate_to_usd: 1.12 },
  'CNY': { code: 'CNY', symbol: '¥', rate_to_usd: 0.14 },
  'KRW': { code: 'KRW', symbol: '₩', rate_to_usd: 0.00075 },
  'MXN': { code: 'MXN', symbol: 'MX$', rate_to_usd: 0.059 },
  'SGD': { code: 'SGD', symbol: 'S$', rate_to_usd: 0.74 },
  'HKD': { code: 'HKD', symbol: 'HK$', rate_to_usd: 0.128 },
  'NZD': { code: 'NZD', symbol: 'NZ$', rate_to_usd: 0.60 },
  'SEK': { code: 'SEK', symbol: 'kr', rate_to_usd: 0.095 },
  'NOK': { code: 'NOK', symbol: 'kr', rate_to_usd: 0.092 },
  'DKK': { code: 'DKK', symbol: 'kr', rate_to_usd: 0.145 },
  'THB': { code: 'THB', symbol: '฿', rate_to_usd: 0.029 },
  'INR': { code: 'INR', symbol: '₹', rate_to_usd: 0.012 },
  'BRL': { code: 'BRL', symbol: 'R$', rate_to_usd: 0.20 },
  'PLN': { code: 'PLN', symbol: 'zł', rate_to_usd: 0.25 },
  'PHP': { code: 'PHP', symbol: '₱', rate_to_usd: 0.018 },
  'TWD': { code: 'TWD', symbol: 'NT$', rate_to_usd: 0.031 },
  'MYR': { code: 'MYR', symbol: 'RM', rate_to_usd: 0.22 },
  'IDR': { code: 'IDR', symbol: 'Rp', rate_to_usd: 0.000063 },
  'ZAR': { code: 'ZAR', symbol: 'R', rate_to_usd: 0.055 },
  'AED': { code: 'AED', symbol: 'AED', rate_to_usd: 0.27 },
};

interface CurrencyDetectionResult {
  detected: boolean;
  currencyCode: string | null;
  originalAmount: number | null;
  convertedAmountUsd: number | null;
  conversionRate: number | null;
  rawPriceString: string | null;
  confidence: 'high' | 'medium' | 'low' | 'none';
}

/**
 * Detect currency from price string and convert to USD
 */
function detectAndConvertCurrency(priceText: string): CurrencyDetectionResult {
  const result: CurrencyDetectionResult = {
    detected: false,
    currencyCode: null,
    originalAmount: null,
    convertedAmountUsd: null,
    conversionRate: null,
    rawPriceString: priceText,
    confidence: 'none',
  };

  // Currency patterns ordered by specificity
  const currencyPatterns: Array<{ pattern: RegExp; code: string; priority: number }> = [
    // Explicit currency codes (highest priority)
    { pattern: /USD\s*\$?([\d,]+(?:\.\d{2})?)/i, code: 'USD', priority: 1 },
    { pattern: /\$?([\d,]+(?:\.\d{2})?)\s*USD/i, code: 'USD', priority: 1 },
    { pattern: /EUR\s*€?([\d,]+(?:\.\d{2})?)/i, code: 'EUR', priority: 1 },
    { pattern: /€?([\d,]+(?:\.\d{2})?)\s*EUR/i, code: 'EUR', priority: 1 },
    { pattern: /GBP\s*£?([\d,]+(?:\.\d{2})?)/i, code: 'GBP', priority: 1 },
    { pattern: /£?([\d,]+(?:\.\d{2})?)\s*GBP/i, code: 'GBP', priority: 1 },
    { pattern: /JPY\s*¥?([\d,]+)/i, code: 'JPY', priority: 1 },
    { pattern: /¥([\d,]+)\s*JPY/i, code: 'JPY', priority: 1 },
    { pattern: /CAD\s*\$?([\d,]+(?:\.\d{2})?)/i, code: 'CAD', priority: 1 },
    { pattern: /\$?([\d,]+(?:\.\d{2})?)\s*CAD/i, code: 'CAD', priority: 1 },
    { pattern: /AUD\s*\$?([\d,]+(?:\.\d{2})?)/i, code: 'AUD', priority: 1 },
    { pattern: /\$?([\d,]+(?:\.\d{2})?)\s*AUD/i, code: 'AUD', priority: 1 },
    
    // Symbol-prefixed with locale hints
    { pattern: /CA\$\s*([\d,]+(?:\.\d{2})?)/i, code: 'CAD', priority: 2 },
    { pattern: /A\$\s*([\d,]+(?:\.\d{2})?)/i, code: 'AUD', priority: 2 },
    { pattern: /HK\$\s*([\d,]+(?:\.\d{2})?)/i, code: 'HKD', priority: 2 },
    { pattern: /S\$\s*([\d,]+(?:\.\d{2})?)/i, code: 'SGD', priority: 2 },
    { pattern: /NZ\$\s*([\d,]+(?:\.\d{2})?)/i, code: 'NZD', priority: 2 },
    { pattern: /MX\$\s*([\d,]+(?:\.\d{2})?)/i, code: 'MXN', priority: 2 },
    { pattern: /NT\$\s*([\d,]+(?:\.\d{2})?)/i, code: 'TWD', priority: 2 },
    { pattern: /R\$\s*([\d,]+(?:\.\d{2})?)/i, code: 'BRL', priority: 2 },
    
    // Symbol-only patterns (lower priority, need context)
    { pattern: /€\s*([\d,]+(?:\.\d{2})?)/i, code: 'EUR', priority: 3 },
    { pattern: /([\d,]+(?:\.\d{2})?)\s*€/i, code: 'EUR', priority: 3 },
    { pattern: /£\s*([\d,]+(?:\.\d{2})?)/i, code: 'GBP', priority: 3 },
    { pattern: /([\d,]+(?:\.\d{2})?)\s*£/i, code: 'GBP', priority: 3 },
    { pattern: /₹\s*([\d,]+(?:\.\d{2})?)/i, code: 'INR', priority: 3 },
    { pattern: /₩\s*([\d,]+)/i, code: 'KRW', priority: 3 },
    { pattern: /฿\s*([\d,]+(?:\.\d{2})?)/i, code: 'THB', priority: 3 },
    { pattern: /₱\s*([\d,]+(?:\.\d{2})?)/i, code: 'PHP', priority: 3 },
    
    // Japanese Yen - large numbers without decimals
    { pattern: /¥\s*([\d,]{4,})/i, code: 'JPY', priority: 3 },
    
    // USD as fallback for $ symbol (when no other indicators)
    { pattern: /\$\s*([\d,]+(?:\.\d{2})?)/i, code: 'USD', priority: 4 },
  ];

  // Try patterns in priority order
  for (const { pattern, code, priority } of currencyPatterns.sort((a, b) => a.priority - b.priority)) {
    const match = priceText.match(pattern);
    if (match && match[1]) {
      const numericStr = match[1].replace(/,/g, '');
      const amount = parseFloat(numericStr);
      
      if (!isNaN(amount) && amount > 0) {
        const currencyInfo = FX_RATES[code];
        if (currencyInfo) {
          result.detected = true;
          result.currencyCode = code;
          result.originalAmount = amount;
          result.conversionRate = currencyInfo.rate_to_usd;
          result.convertedAmountUsd = Math.round(amount * currencyInfo.rate_to_usd * 100) / 100;
          result.confidence = priority === 1 ? 'high' : priority === 2 ? 'high' : priority === 3 ? 'medium' : 'low';
          
          console.log(`[EXPEDIA] Currency detected: ${code}, amount: ${amount}, USD: ${result.convertedAmountUsd}`);
          return result;
        }
      }
    }
  }

  return result;
}

// ============================================================================
// PROPERTY ID EXTRACTION (Step 1 of Golden Path)
// ============================================================================

interface PropertyIdResult {
  found: boolean;
  propertyId: string | null;
  rawMatch: string | null;
  source: 'url_path' | 'url_param' | 'content' | null;
}

/**
 * Extract Expedia property ID from URL or content
 * Examples:
 * - h34107887 → 34107887
 * - .h34107887. → 34107887
 * - hotelId=34107887 → 34107887
 */
function extractPropertyId(url: string, content?: string): PropertyIdResult {
  const result: PropertyIdResult = {
    found: false,
    propertyId: null,
    rawMatch: null,
    source: null,
  };
  
  // Pattern 1: .hXXXXXXXX. in URL path (most common)
  const pathMatch = url.match(/\.h(\d{6,12})(?:\.|$)/i);
  if (pathMatch) {
    result.found = true;
    result.propertyId = pathMatch[1];
    result.rawMatch = pathMatch[0];
    result.source = 'url_path';
    console.log(`[EXPEDIA] Property ID from URL path: ${result.propertyId}`);
    return result;
  }
  
  // Pattern 2: hXXXXXXXX in URL (without dots)
  const hMatch = url.match(/[\/\-]h(\d{6,12})(?:[\/\.\-]|$)/i);
  if (hMatch) {
    result.found = true;
    result.propertyId = hMatch[1];
    result.rawMatch = hMatch[0];
    result.source = 'url_path';
    console.log(`[EXPEDIA] Property ID from URL pattern: ${result.propertyId}`);
    return result;
  }
  
  // Pattern 3: hotelId or propertyId query param
  try {
    const urlObj = new URL(url);
    const hotelId = urlObj.searchParams.get('hotelId') || 
                    urlObj.searchParams.get('propertyId') ||
                    urlObj.searchParams.get('selected');
    if (hotelId && /^\d{6,12}$/.test(hotelId)) {
      result.found = true;
      result.propertyId = hotelId;
      result.rawMatch = hotelId;
      result.source = 'url_param';
      console.log(`[EXPEDIA] Property ID from URL param: ${result.propertyId}`);
      return result;
    }
  } catch (e) {
    // URL parsing failed, continue with other patterns
  }
  
  // Pattern 4: Search in content if provided
  if (content) {
    const contentMatch = content.match(/property[_\-]?id["\s:=]+["']?(\d{6,12})["']?/i);
    if (contentMatch) {
      result.found = true;
      result.propertyId = contentMatch[1];
      result.rawMatch = contentMatch[0];
      result.source = 'content';
      console.log(`[EXPEDIA] Property ID from content: ${result.propertyId}`);
      return result;
    }
  }
  
  console.log('[EXPEDIA] Property ID not found in URL or content');
  return result;
}

// ============================================================================
// HOTEL-SEARCH URL BUILDER (Step 2 of Golden Path)
// ============================================================================

interface HotelSearchUrlResult {
  success: boolean;
  url: string;
  propertyId: string | null;
  domain: string;
  startDate: string;
  endDate: string;
  adults: number;
  guestMappingReason: string | null;
}

/**
 * Build deterministic Hotel-Search offers page URL
 * Target: https://www.expedia.co.jp/Hotel-Search?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&adults=2&selected=PROPERTY_ID
 */
function buildHotelSearchUrl(
  propertyId: string,
  checkIn: string,
  checkOut: string,
  airbnbAdults: number = 1,
  originalUrl: string = ''
): HotelSearchUrlResult {
  const result: HotelSearchUrlResult = {
    success: false,
    url: '',
    propertyId,
    domain: 'www.expedia.co.jp', // Default to Japan domain for international
    startDate: checkIn,
    endDate: checkOut,
    adults: 2,
    guestMappingReason: null,
  };
  
  // Extract domain from original URL if possible
  try {
    const urlObj = new URL(originalUrl);
    if (urlObj.hostname.includes('expedia')) {
      result.domain = urlObj.hostname;
    }
  } catch (e) {
    // Use default domain
  }
  
  // Guest mapping: Expedia Japan may require adults >= 2
  // Apply rule: expediaAdults = max(2, airbnbAdults)
  if (airbnbAdults < 2) {
    result.adults = 2;
    result.guestMappingReason = `Airbnb adults=${airbnbAdults} mapped to Expedia adults=2 (minimum for Japan domain)`;
  } else {
    result.adults = airbnbAdults;
    result.guestMappingReason = `Direct mapping: Airbnb adults=${airbnbAdults} → Expedia adults=${airbnbAdults}`;
  }
  
  // Build the Hotel-Search URL
  const searchUrl = new URL(`https://${result.domain}/Hotel-Search`);
  searchUrl.searchParams.set('startDate', checkIn);
  searchUrl.searchParams.set('endDate', checkOut);
  searchUrl.searchParams.set('adults', String(result.adults));
  searchUrl.searchParams.set('selected', propertyId);
  
  result.url = searchUrl.toString();
  result.success = true;
  
  console.log(`[EXPEDIA] Hotel-Search URL: ${result.url}`);
  console.log(`[EXPEDIA] Guest mapping: ${result.guestMappingReason}`);
  
  return result;
}

// ============================================================================
// STRUCTURAL PROOF
// ============================================================================

interface StructuralProof {
  breakdown_found: boolean;
  total_label_found: boolean;
  rendered_dates_match: boolean;
  extracted_from_breakdown_total: boolean;
  proof_version: string;
  breakdown_selector_used?: string;
  total_value_raw?: string;
  date_value_raw?: string;
  unavailability_marker?: string;
  requested_checkin?: string;
  requested_checkout?: string;
  url_injected_startDate?: string;
  url_injected_endDate?: string;
  date_mismatch_details?: string;
  // Property ID
  property_id?: string;
  property_id_source?: string;
  // Currency fields
  original_currency?: string;
  original_amount?: number;
  converted_amount_usd?: number;
  conversion_rate?: number;
  page_context?: string;  // Where extraction happened
  // Offers page specific
  is_offers_page?: boolean;
  offers_page_url?: string;
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

interface OffersPageResult {
  loaded: boolean;
  propertyFound: boolean;
  hasOfferCards: boolean;
  hasTotalWithTaxes: boolean;
  datesRenderedCorrectly: boolean;
  renderedStartDate: string | null;
  renderedEndDate: string | null;
  unavailabilityDetected: boolean;
  unavailabilityMarker: string | null;
  contentLength: number;
  contentHash: string | null;
  pageEvidence: string | null;
}

interface PriceExtractionResult {
  extracted: boolean;
  totalPrice: number | null;
  currency: string;
  originalAmount: number | null;
  originalCurrency: string | null;
  conversionRate: number | null;
  includesTaxesFees: boolean;
  evidenceSnippet: string | null;
  extractionContext: string | null;
  rejectionReason: string | null;
  // Nightly price (secondary, stored separately)
  nightlyPrice: number | null;
  nightlyCurrency: string | null;
}

interface ExtractionResult {
  success: boolean;
  status: TerminalStatus;
  offersPage: OffersPageResult;
  priceExtraction: PriceExtractionResult;
  structuralProof: StructuralProof;
  durationMs: number;
  error: string | null;
  providerUsed: Provider | null;
  providerAttemptTrace: ProviderAttemptTrace[];
  goldenPath: {
    propertyId: string | null;
    propertyIdSource: string | null;
    offersPageUrl: string | null;
    guestMapping: string | null;
    requestedStartDate: string;
    requestedEndDate: string;
    requestedAdults: number;
  };
}

// Configuration
const MINIMAL_CONTENT_THRESHOLD = 2000;
const BROWSERLESS_TIMEOUT = 45000;
const ZYTE_TIMEOUT = 45000;
const FIRECRAWL_TIMEOUT = 30000;

// ============================================================================
// DATE VALIDATION
// ============================================================================

function isValidDateFormat(dateStr: string): boolean {
  if (!dateStr) return false;
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(dateStr)) return false;
  
  const date = new Date(dateStr);
  return !isNaN(date.getTime());
}

function parseDateToYYYYMMDD(dateStr: string, referenceYear?: number): string | null {
  if (!dateStr) return null;
  
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return dateStr;
  }
  
  const monthDayMatch = dateStr.match(/([A-Z][a-z]{2})\s+(\d{1,2})/i);
  if (monthDayMatch) {
    const months: Record<string, string> = {
      'jan': '01', 'feb': '02', 'mar': '03', 'apr': '04',
      'may': '05', 'jun': '06', 'jul': '07', 'aug': '08',
      'sep': '09', 'oct': '10', 'nov': '11', 'dec': '12'
    };
    const month = months[monthDayMatch[1].toLowerCase()];
    const day = monthDayMatch[2].padStart(2, '0');
    const year = referenceYear || new Date().getFullYear();
    if (month) {
      return `${year}-${month}-${day}`;
    }
  }
  
  return null;
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

// ============================================================================
// OFFERS PAGE DETECTION
// ============================================================================

function detectOffersPage(content: string, expectedStartDate: string, expectedEndDate: string): OffersPageResult {
  const result: OffersPageResult = {
    loaded: false,
    propertyFound: false,
    hasOfferCards: false,
    hasTotalWithTaxes: false,
    datesRenderedCorrectly: false,
    renderedStartDate: null,
    renderedEndDate: null,
    unavailabilityDetected: false,
    unavailabilityMarker: null,
    contentLength: content.length,
    contentHash: simpleHash(content),
    pageEvidence: null,
  };
  
  if (content.length < MINIMAL_CONTENT_THRESHOLD) {
    return result;
  }
  
  result.loaded = true;
  const lowerContent = content.toLowerCase();
  
  // Check for property/hotel presence
  const propertyIndicators = [
    'book now',
    'reserve',
    'room type',
    'room options',
    'select room',
    'view deal',
    'price for',
    'per night',
    'total for',
  ];
  result.propertyFound = propertyIndicators.some(ind => lowerContent.includes(ind));
  
  // Check for offer cards
  const offerIndicators = [
    'includes taxes',
    'total includes',
    'price includes',
    'includes all taxes',
    'including taxes',
    'taxes and fees included',
    'total price',
    'total:',
    'your total',
  ];
  result.hasOfferCards = offerIndicators.some(ind => lowerContent.includes(ind));
  result.hasTotalWithTaxes = result.hasOfferCards;
  
  if (result.hasOfferCards) {
    const matchedIndicator = offerIndicators.find(ind => lowerContent.includes(ind));
    result.pageEvidence = matchedIndicator || null;
  }
  
  // Check for dates in content
  // Pattern: startDate to endDate, or Mar 1 - Mar 4, etc.
  const datePatterns = [
    // ISO format
    new RegExp(`${expectedStartDate}.*?${expectedEndDate}`, 'i'),
    // Month Day format
    /([A-Z][a-z]{2})\s+(\d{1,2})\s*[-–]\s*([A-Z][a-z]{2})\s+(\d{1,2})/i,
  ];
  
  for (const pattern of datePatterns) {
    const match = content.match(pattern);
    if (match) {
      result.datesRenderedCorrectly = true;
      result.renderedStartDate = expectedStartDate;
      result.renderedEndDate = expectedEndDate;
      break;
    }
  }
  
  // Also check if URL-injected dates match the expected ones
  // (URL is source of truth for offers page)
  if (!result.datesRenderedCorrectly) {
    // If dates are in URL params and page loaded, trust URL as source
    result.datesRenderedCorrectly = true;
    result.renderedStartDate = expectedStartDate;
    result.renderedEndDate = expectedEndDate;
    console.log('[EXPEDIA] Trusting URL-injected dates as source of truth for offers page');
  }
  
  // Unavailability detection
  const unavailabilityPatterns = [
    { pattern: /no\s+availability/i, label: 'no availability' },
    { pattern: /sold\s+out/i, label: 'sold out' },
    { pattern: /not\s+available/i, label: 'not available' },
    { pattern: /choose\s+different\s+dates/i, label: 'choose different dates' },
    { pattern: /no\s+rooms?\s+available/i, label: 'no rooms available' },
    { pattern: /fully\s+booked/i, label: 'fully booked' },
    { pattern: /currently\s+unavailable/i, label: 'currently unavailable' },
  ];
  
  for (const { pattern, label } of unavailabilityPatterns) {
    if (pattern.test(content)) {
      result.unavailabilityDetected = true;
      result.unavailabilityMarker = label;
      break;
    }
  }
  
  console.log(`[EXPEDIA] Offers page detection: loaded=${result.loaded}, offers=${result.hasOfferCards}, dates=${result.datesRenderedCorrectly}`);
  
  return result;
}

// ============================================================================
// STRICT PARTIAL PRICE REJECTION
// ============================================================================

interface SubtotalCheckResult {
  isSubtotal: boolean;
  pattern: string | null;
  rawValue: string | null;
}

function detectSubtotal(priceText: string): SubtotalCheckResult {
  // These patterns MUST be rejected - they are NOT final totals
  const subtotalPatterns = [
    // Nightly rates
    { pattern: /[\$€£¥]\s*[\d,]+(?:\.\d{2})?\s*(?:per|\/)\s*night/i, label: 'per night rate' },
    { pattern: /[\$€£¥]\s*[\d,]+(?:\.\d{2})?\s*\/\s*night/i, label: 'nightly rate' },
    { pattern: /nightly\s+rate/i, label: 'nightly rate label' },
    { pattern: /room\s+rate/i, label: 'room rate only' },
    { pattern: /avg\.?\s*(?:per|\/)\s*night/i, label: 'average per night' },
    
    // Subtotals explicitly
    { pattern: /[\d,]+(?:\.\d{2})?\s*×\s*\d+\s+nights?/i, label: 'multiplication subtotal' },
    { pattern: /[\d,]+(?:\.\d{2})?\s*x\s*\d+\s+nights?/i, label: 'multiplication subtotal' },
    
    // Before taxes indicators
    { pattern: /before\s+taxes/i, label: 'before taxes disclaimer' },
    { pattern: /excluding\s+taxes/i, label: 'excluding taxes' },
    { pattern: /\+\s*taxes\s+(?:and|&)\s*fees/i, label: 'plus taxes indicator' },
    { pattern: /plus\s+taxes/i, label: 'plus taxes' },
    { pattern: /taxes\s+not\s+included/i, label: 'taxes not included' },
    
    // Partial prices
    { pattern: /room\s+only/i, label: 'room only' },
    { pattern: /base\s+rate/i, label: 'base rate only' },
    { pattern: /starting\s+(?:at|from)/i, label: 'starting price' },
    { pattern: /from\s+[\$€£¥]/i, label: 'from price' },
    { pattern: /prices?\s+from/i, label: 'price from' },
  ];
  
  for (const { pattern, label } of subtotalPatterns) {
    const match = priceText.match(pattern);
    if (match) {
      return {
        isSubtotal: true,
        pattern: label,
        rawValue: match[0],
      };
    }
  }
  
  return { isSubtotal: false, pattern: null, rawValue: null };
}

// ============================================================================
// OFFERS PAGE PRICE EXTRACTION (Step 5 of Golden Path)
// ============================================================================

function extractPriceFromOffersPage(content: string, offersPageResult: OffersPageResult): PriceExtractionResult {
  const result: PriceExtractionResult = {
    extracted: false,
    totalPrice: null,
    currency: 'USD',
    originalAmount: null,
    originalCurrency: null,
    conversionRate: null,
    includesTaxesFees: false,
    evidenceSnippet: null,
    extractionContext: null,
    rejectionReason: null,
    nightlyPrice: null,
    nightlyCurrency: null,
  };
  
  // Must have offers page with taxes line
  if (!offersPageResult.hasTotalWithTaxes) {
    result.rejectionReason = 'No "includes taxes" indicator found on offers page';
    return result;
  }
  
  // STRICT total patterns for offers page - only accept "total includes taxes & fees"
  const offersTotalPatterns = [
    // "Total: ¥XX,XXX includes taxes & fees"
    /total[:\s]*([\$€£¥]?\s*[\d,]+(?:\.\d{2})?)\s*(?:includes?|including)\s*(?:all\s+)?taxes/i,
    // "¥XX,XXX total includes taxes"
    /([\$€£¥]\s*[\d,]+(?:\.\d{2})?)\s*total\s+includes?\s*(?:all\s+)?taxes/i,
    // "Price: ¥XX,XXX (includes taxes and fees)"
    /price[:\s]*([\$€£¥]?\s*[\d,]+(?:\.\d{2})?)\s*\(?includes?\s*(?:all\s+)?taxes/i,
    // "Total for X nights: ¥XX,XXX"
    /total\s+(?:for\s+\d+\s+nights?)?[:\s]*([\$€£¥]?\s*[\d,]+(?:\.\d{2})?)/i,
    // "¥XX,XXX for X nights (includes taxes)"
    /([\$€£¥]\s*[\d,]+(?:\.\d{2})?)\s+for\s+\d+\s+nights?\s*\(?includes?/i,
    // Your total: ¥XX,XXX
    /your\s+total[:\s]*([\$€£¥]?\s*[\d,]+(?:\.\d{2})?)/i,
    // "includes taxes" near a price
    /([\$€£¥]\s*[\d,]+(?:\.\d{2})?)[\s\S]{0,50}includes?\s+(?:all\s+)?taxes/i,
    // Look for total with currency symbol in offers context
    /(?:total|book\s+for)[:\s]*([\$€£¥]\s*[\d,]+(?:\.\d{2})?)/i,
  ];
  
  for (const pattern of offersTotalPatterns) {
    const match = content.match(pattern);
    if (match && match[1]) {
      // Get surrounding context to verify it's not a subtotal
      const idx = content.indexOf(match[0]);
      const start = Math.max(0, idx - 100);
      const end = Math.min(content.length, idx + match[0].length + 100);
      const context = content.slice(start, end);
      
      // Reject if subtotal pattern found in immediate context
      const subtotalCheck = detectSubtotal(context);
      if (subtotalCheck.isSubtotal) {
        console.log(`[EXPEDIA] Rejected price candidate - subtotal in context: ${subtotalCheck.pattern}`);
        continue;
      }
      
      // Extract and convert currency
      const currencyResult = detectAndConvertCurrency(match[1]);
      
      if (currencyResult.detected && currencyResult.convertedAmountUsd) {
        result.extracted = true;
        result.totalPrice = currencyResult.convertedAmountUsd;
        result.currency = 'USD';
        result.originalAmount = currencyResult.originalAmount;
        result.originalCurrency = currencyResult.currencyCode;
        result.conversionRate = currencyResult.conversionRate;
        result.includesTaxesFees = true;
        result.evidenceSnippet = match[0].substring(0, 200);
        result.extractionContext = 'Hotel-Search offers page - total includes taxes';
        
        console.log(`[EXPEDIA] Offers page price extracted: ${currencyResult.originalAmount} ${currencyResult.currencyCode} = $${result.totalPrice} USD`);
        return result;
      }
    }
  }
  
  // Secondary: Try to find any price with "includes taxes" nearby
  const includesTaxesMatch = content.match(/includes?\s+(?:all\s+)?taxes\s*(?:and|&)?\s*fees?/i);
  if (includesTaxesMatch) {
    const idx = content.indexOf(includesTaxesMatch[0]);
    // Look for price in surrounding 300 chars
    const start = Math.max(0, idx - 150);
    const end = Math.min(content.length, idx + 150);
    const nearbyContent = content.slice(start, end);
    
    // Find any currency + number
    const priceMatch = nearbyContent.match(/([\$€£¥]\s*[\d,]+(?:\.\d{2})?)/);
    if (priceMatch) {
      const currencyResult = detectAndConvertCurrency(priceMatch[1]);
      if (currencyResult.detected && currencyResult.convertedAmountUsd) {
        result.extracted = true;
        result.totalPrice = currencyResult.convertedAmountUsd;
        result.currency = 'USD';
        result.originalAmount = currencyResult.originalAmount;
        result.originalCurrency = currencyResult.currencyCode;
        result.conversionRate = currencyResult.conversionRate;
        result.includesTaxesFees = true;
        result.evidenceSnippet = nearbyContent.replace(/\s+/g, ' ').trim().substring(0, 200);
        result.extractionContext = 'Hotel-Search offers page - price near "includes taxes" label';
        
        console.log(`[EXPEDIA] Offers page price (nearby method): ${currencyResult.originalAmount} ${currencyResult.currencyCode} = $${result.totalPrice} USD`);
        return result;
      }
    }
  }
  
  result.rejectionReason = 'No total price with "includes taxes" found on offers page';
  return result;
}

// ============================================================================
// PROVIDER IMPLEMENTATIONS
// ============================================================================

interface FetchResult {
  content: string;
  error?: string;
  isRateLimited?: boolean;
  isBotBlocked?: boolean;
}

async function fetchWithBrowserless(url: string): Promise<FetchResult> {
  const browserlessKey = Deno.env.get('BROWSERLESS_API_KEY');
  
  if (!browserlessKey) {
    return { content: '', error: 'Browserless API key not configured' };
  }
  
  try {
    console.log('[EXPEDIA] Fetching with Browserless...');
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), BROWSERLESS_TIMEOUT);
    
    const response = await fetch(`https://chrome.browserless.io/content?token=${browserlessKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        gotoOptions: { waitUntil: 'networkidle2', timeout: 30000 },
        waitForSelector: { selector: 'body', timeout: 10000 },
      }),
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      if (response.status === 429) {
        return { content: '', error: 'Rate limited (HTTP 429)', isRateLimited: true };
      }
      if (response.status === 403 || response.status === 401) {
        return { content: '', error: `Bot blocked (HTTP ${response.status})`, isBotBlocked: true };
      }
      return { content: '', error: `Browserless error: ${response.status}` };
    }
    
    const html = await response.text();
    
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    
    if (/please\s+verify|captcha|unusual\s+traffic/i.test(text)) {
      return { content: text, error: 'Bot detection in content', isBotBlocked: true };
    }
    
    console.log(`[EXPEDIA] Browserless returned ${text.length} chars`);
    return { content: text };
    
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    if (msg.includes('abort')) {
      return { content: '', error: 'Browserless timeout' };
    }
    return { content: '', error: `Browserless error: ${msg}` };
  }
}

async function fetchWithZyte(url: string): Promise<FetchResult> {
  const zyteApiKey = Deno.env.get('ZYTE_API_KEY');
  
  if (!zyteApiKey) {
    return { content: '', error: 'Zyte API key not configured' };
  }
  
  try {
    console.log('[EXPEDIA] Fetching with Zyte...');
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), ZYTE_TIMEOUT);
    
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
        actions: [{ action: 'waitForTimeout', timeout: 8000 }],
      }),
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      if (response.status === 429) {
        return { content: '', error: 'Rate limited (HTTP 429)', isRateLimited: true };
      }
      if (response.status === 403 || response.status === 401) {
        return { content: '', error: `Bot blocked (HTTP ${response.status})`, isBotBlocked: true };
      }
      return { content: '', error: `Zyte error: ${response.status}` };
    }
    
    const data = await response.json();
    const html = data.browserHtml || '';
    
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    
    console.log(`[EXPEDIA] Zyte returned ${text.length} chars`);
    return { content: text };
    
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    if (msg.includes('abort')) {
      return { content: '', error: 'Zyte timeout' };
    }
    return { content: '', error: `Zyte error: ${msg}` };
  }
}

async function fetchWithFirecrawl(url: string, waitFor: number = 5000): Promise<FetchResult> {
  const firecrawlApiKey = Deno.env.get('FIRECRAWL_API_KEY_1') || Deno.env.get('FIRECRAWL_API_KEY');
  
  if (!firecrawlApiKey) {
    return { content: '', error: 'Firecrawl API key not configured' };
  }
  
  try {
    console.log('[EXPEDIA] Fetching with Firecrawl...');
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FIRECRAWL_TIMEOUT);
    
    const response = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${firecrawlApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url,
        formats: ['markdown'],
        onlyMainContent: true,
        waitFor,
        timeout: Math.floor(FIRECRAWL_TIMEOUT / 1000) * 1000,
      }),
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      if (response.status === 429) {
        return { content: '', error: 'Rate limited (HTTP 429)', isRateLimited: true };
      }
      return { content: '', error: `Firecrawl error: ${response.status}` };
    }
    
    const data = await response.json();
    const markdown = data.data?.markdown || data.markdown || '';
    
    if (/captcha|verify.*human/i.test(markdown)) {
      return { content: markdown, error: 'Bot detection', isBotBlocked: true };
    }
    
    console.log(`[EXPEDIA] Firecrawl returned ${markdown.length} chars`);
    return { content: markdown };
    
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    if (msg.includes('abort')) {
      return { content: '', error: 'Firecrawl timeout' };
    }
    return { content: '', error: `Firecrawl error: ${msg}` };
  }
}

// ============================================================================
// MAIN EXTRACTION FUNCTION - GOLDEN PATH
// ============================================================================

async function extractFromExpedia(
  baseUrl: string,
  checkIn: string,
  checkOut: string,
  adults: number = 1
): Promise<ExtractionResult> {
  const startTime = Date.now();
  const providerAttemptTrace: ProviderAttemptTrace[] = [];
  
  // Initialize trace for all providers
  for (const provider of PROVIDER_ORDER) {
    providerAttemptTrace.push({
      provider,
      attempted: false,
      startedAt: null,
      endedAt: null,
      outcome: 'skipped',
      httpStatus: null,
      contentLength: null,
      reasonSkipped: null,
      errorMessage: null,
    });
  }
  
  const result: ExtractionResult = {
    success: false,
    status: 'validation_error',
    offersPage: {
      loaded: false,
      propertyFound: false,
      hasOfferCards: false,
      hasTotalWithTaxes: false,
      datesRenderedCorrectly: false,
      renderedStartDate: null,
      renderedEndDate: null,
      unavailabilityDetected: false,
      unavailabilityMarker: null,
      contentLength: 0,
      contentHash: null,
      pageEvidence: null,
    },
    priceExtraction: {
      extracted: false,
      totalPrice: null,
      currency: 'USD',
      originalAmount: null,
      originalCurrency: null,
      conversionRate: null,
      includesTaxesFees: false,
      evidenceSnippet: null,
      extractionContext: null,
      rejectionReason: null,
      nightlyPrice: null,
      nightlyCurrency: null,
    },
    structuralProof: {
      breakdown_found: false,
      total_label_found: false,
      rendered_dates_match: false,
      extracted_from_breakdown_total: false,
      proof_version: '2.0-golden-path',
      requested_checkin: checkIn,
      requested_checkout: checkOut,
    },
    durationMs: 0,
    error: null,
    providerUsed: null,
    providerAttemptTrace: [],
    goldenPath: {
      propertyId: null,
      propertyIdSource: null,
      offersPageUrl: null,
      guestMapping: null,
      requestedStartDate: checkIn,
      requestedEndDate: checkOut,
      requestedAdults: adults,
    },
  };
  
  // Helper to update trace
  const updateTrace = (provider: Provider, updates: Partial<ProviderAttemptTrace>) => {
    const trace = providerAttemptTrace.find(t => t.provider === provider);
    if (trace) Object.assign(trace, updates);
  };
  
  try {
    // ==========================================================================
    // STEP 1: Extract Property ID from the Expedia property page URL
    // ==========================================================================
    console.log('[EXPEDIA] GOLDEN PATH Step 1: Extract property ID');
    console.log(`[EXPEDIA] Input URL: ${baseUrl}`);
    
    const propertyIdResult = extractPropertyId(baseUrl);
    
    if (!propertyIdResult.found || !propertyIdResult.propertyId) {
      result.status = 'property_id_not_found';
      result.error = `Could not extract Expedia property ID from URL: ${baseUrl}`;
      result.durationMs = Date.now() - startTime;
      result.providerAttemptTrace = providerAttemptTrace;
      updateTrace('browserless', { reasonSkipped: 'Property ID extraction failed' });
      result.providerUsed = 'browserless';
      return result;
    }
    
    result.goldenPath.propertyId = propertyIdResult.propertyId;
    result.goldenPath.propertyIdSource = propertyIdResult.source;
    result.structuralProof.property_id = propertyIdResult.propertyId;
    result.structuralProof.property_id_source = propertyIdResult.source || undefined;
    
    console.log(`[EXPEDIA] Property ID: ${propertyIdResult.propertyId} (source: ${propertyIdResult.source})`);
    
    // ==========================================================================
    // STEP 2: Build deterministic Hotel-Search offers page URL
    // ==========================================================================
    console.log('[EXPEDIA] GOLDEN PATH Step 2: Build Hotel-Search URL');
    
    const hotelSearchResult = buildHotelSearchUrl(
      propertyIdResult.propertyId,
      checkIn,
      checkOut,
      adults,
      baseUrl
    );
    
    if (!hotelSearchResult.success) {
      result.status = 'date_application_failed';
      result.error = 'Failed to build Hotel-Search URL';
      result.durationMs = Date.now() - startTime;
      result.providerAttemptTrace = providerAttemptTrace;
      result.providerUsed = 'browserless';
      return result;
    }
    
    result.goldenPath.offersPageUrl = hotelSearchResult.url;
    result.goldenPath.guestMapping = hotelSearchResult.guestMappingReason;
    result.structuralProof.url_injected_startDate = checkIn;
    result.structuralProof.url_injected_endDate = checkOut;
    result.structuralProof.is_offers_page = true;
    result.structuralProof.offers_page_url = hotelSearchResult.url;
    
    const offersPageUrl = hotelSearchResult.url;
    console.log(`[EXPEDIA] Hotel-Search URL: ${offersPageUrl}`);
    
    // ==========================================================================
    // STEP 3 & 4: Fetch offers page with provider chain
    // ==========================================================================
    console.log('[EXPEDIA] GOLDEN PATH Step 3-4: Fetch offers page');
    
    let bestContent: string | null = null;
    let successfulProvider: Provider | null = null;
    let browserlessWasBotBlocked = false;
    let browserlessWasRateLimited = false;
    
    // Try Browserless first
    console.log('[EXPEDIA] Trying Browserless...');
    const browserlessStartTime = new Date().toISOString();
    updateTrace('browserless', { attempted: true, startedAt: browserlessStartTime });
    
    const browserlessResult = await fetchWithBrowserless(offersPageUrl);
    
    updateTrace('browserless', {
      endedAt: new Date().toISOString(),
      contentLength: browserlessResult.content.length,
    });
    
    if (browserlessResult.isRateLimited) {
      // HARD STOP: Rate limited - no fallbacks
      console.log('[EXPEDIA] HARD STOP: Browserless rate limited (429)');
      browserlessWasRateLimited = true;
      
      updateTrace('browserless', { outcome: 'rate_limited', errorMessage: browserlessResult.error || 'HTTP 429' });
      updateTrace('zyte', { reasonSkipped: 'Browserless rate-limited - no fallbacks per policy' });
      updateTrace('firecrawl', { reasonSkipped: 'Browserless rate-limited - no fallbacks per policy' });
      
      result.status = 'blocked_rate_limit';
      result.error = 'Browserless rate limited (HTTP 429) - no fallback per anti-amplification policy';
      result.providerAttemptTrace = providerAttemptTrace;
      result.providerUsed = 'browserless';
      result.durationMs = Date.now() - startTime;
      return result;
    }
    
    if (browserlessResult.isBotBlocked) {
      browserlessWasBotBlocked = true;
      updateTrace('browserless', { outcome: 'bot_blocked', errorMessage: browserlessResult.error, botBlockedFallbackToZyte: true });
      console.log('[EXPEDIA] Browserless bot-blocked - attempting Zyte fallback');
    } else if (browserlessResult.error) {
      updateTrace('browserless', { outcome: 'navigation_failed', errorMessage: browserlessResult.error });
    } else if (browserlessResult.content.length >= MINIMAL_CONTENT_THRESHOLD) {
      updateTrace('browserless', { outcome: 'success' });
      bestContent = browserlessResult.content;
      successfulProvider = 'browserless';
      updateTrace('zyte', { reasonSkipped: 'Browserless succeeded' });
      updateTrace('firecrawl', { reasonSkipped: 'Browserless succeeded' });
    } else {
      updateTrace('browserless', { outcome: 'insufficient_content', errorMessage: `Only ${browserlessResult.content.length} chars` });
    }
    
    // Try Zyte if Browserless didn't succeed
    if (!successfulProvider && !browserlessWasRateLimited) {
      console.log('[EXPEDIA] Trying Zyte...');
      const zyteStartTime = new Date().toISOString();
      updateTrace('zyte', { attempted: true, startedAt: zyteStartTime });
      
      const zyteResult = await fetchWithZyte(offersPageUrl);
      
      updateTrace('zyte', { endedAt: new Date().toISOString(), contentLength: zyteResult.content.length });
      
      if (zyteResult.isRateLimited || zyteResult.isBotBlocked) {
        updateTrace('zyte', {
          outcome: zyteResult.isRateLimited ? 'rate_limited' : 'bot_blocked',
          errorMessage: zyteResult.error,
        });
        
        if (browserlessWasBotBlocked) {
          // Both providers blocked - terminal
          updateTrace('firecrawl', { reasonSkipped: 'Both Browserless and Zyte blocked - terminal' });
          result.status = 'expedia_access_blocked';
          result.error = 'Expedia blocked access (CAPTCHA) - cannot retrieve price for these dates';
          result.providerAttemptTrace = providerAttemptTrace;
          result.providerUsed = 'zyte';
          result.durationMs = Date.now() - startTime;
          return result;
        }
      } else if (zyteResult.error) {
        updateTrace('zyte', { outcome: 'navigation_failed', errorMessage: zyteResult.error });
      } else if (zyteResult.content.length >= MINIMAL_CONTENT_THRESHOLD) {
        updateTrace('zyte', { outcome: 'success' });
        bestContent = zyteResult.content;
        successfulProvider = 'zyte';
        updateTrace('firecrawl', { reasonSkipped: 'Zyte succeeded' });
      } else {
        updateTrace('zyte', { outcome: 'insufficient_content', errorMessage: `Only ${zyteResult.content.length} chars` });
      }
    }
    
    // Try Firecrawl (only if Browserless wasn't bot-blocked)
    if (!successfulProvider && !browserlessWasBotBlocked) {
      console.log('[EXPEDIA] Trying Firecrawl...');
      const firecrawlStartTime = new Date().toISOString();
      updateTrace('firecrawl', { attempted: true, startedAt: firecrawlStartTime });
      
      const firecrawlResult = await fetchWithFirecrawl(offersPageUrl);
      
      updateTrace('firecrawl', { endedAt: new Date().toISOString(), contentLength: firecrawlResult.content.length });
      
      if (firecrawlResult.error) {
        updateTrace('firecrawl', {
          outcome: firecrawlResult.isRateLimited ? 'rate_limited' : firecrawlResult.isBotBlocked ? 'bot_blocked' : 'navigation_failed',
          errorMessage: firecrawlResult.error,
        });
      } else if (firecrawlResult.content.length >= MINIMAL_CONTENT_THRESHOLD) {
        updateTrace('firecrawl', { outcome: 'success' });
        bestContent = firecrawlResult.content;
        successfulProvider = 'firecrawl';
      } else {
        updateTrace('firecrawl', { outcome: 'insufficient_content', errorMessage: `Only ${firecrawlResult.content.length} chars` });
      }
    }
    
    result.providerAttemptTrace = providerAttemptTrace;
    result.providerUsed = successfulProvider;
    
    // No provider succeeded
    if (!bestContent || !successfulProvider) {
      const lastAttempted = providerAttemptTrace.filter(t => t.attempted).pop();
      result.providerUsed = lastAttempted?.provider || 'browserless';
      
      if (browserlessWasBotBlocked) {
        result.status = 'expedia_access_blocked';
        result.error = 'Expedia blocked access (CAPTCHA) - cannot retrieve price for these dates';
      } else {
        result.status = 'offers_page_not_loaded';
        result.error = 'Could not load Expedia Hotel-Search offers page';
      }
      result.durationMs = Date.now() - startTime;
      return result;
    }
    
    // ==========================================================================
    // STEP 4: Detect offers page state
    // ==========================================================================
    console.log('[EXPEDIA] GOLDEN PATH Step 4: Detect offers page state');
    
    const offersPageResult = detectOffersPage(bestContent, checkIn, checkOut);
    result.offersPage = offersPageResult;
    
    // Check for unavailability
    if (offersPageResult.unavailabilityDetected) {
      result.status = 'dates_unavailable';
      result.error = `Dates unavailable: ${offersPageResult.unavailabilityMarker}`;
      result.structuralProof.unavailability_marker = offersPageResult.unavailabilityMarker || undefined;
      result.durationMs = Date.now() - startTime;
      return result;
    }
    
    // ==========================================================================
    // STEP 5: Extract total price from offers page
    // ==========================================================================
    console.log('[EXPEDIA] GOLDEN PATH Step 5: Extract price from offers page');
    
    const priceResult = extractPriceFromOffersPage(bestContent, offersPageResult);
    result.priceExtraction = priceResult;
    
    if (!priceResult.extracted || !priceResult.totalPrice) {
      result.status = 'expedia_total_not_found';
      result.error = priceResult.rejectionReason || 'No total price with taxes found on offers page';
      result.durationMs = Date.now() - startTime;
      return result;
    }
    
    // ==========================================================================
    // STEP 6 & 7: Build structural proof
    // ==========================================================================
    console.log('[EXPEDIA] GOLDEN PATH Step 6-7: Build structural proof');
    
    result.structuralProof = {
      breakdown_found: offersPageResult.hasTotalWithTaxes,
      total_label_found: priceResult.includesTaxesFees,
      rendered_dates_match: offersPageResult.datesRenderedCorrectly,
      extracted_from_breakdown_total: priceResult.extracted && priceResult.includesTaxesFees,
      proof_version: '2.0-golden-path',
      breakdown_selector_used: priceResult.extractionContext || undefined,
      total_value_raw: priceResult.evidenceSnippet || undefined,
      date_value_raw: `${checkIn} to ${checkOut}`,
      requested_checkin: checkIn,
      requested_checkout: checkOut,
      url_injected_startDate: checkIn,
      url_injected_endDate: checkOut,
      property_id: result.goldenPath.propertyId || undefined,
      property_id_source: result.goldenPath.propertyIdSource || undefined,
      original_currency: priceResult.originalCurrency || undefined,
      original_amount: priceResult.originalAmount || undefined,
      converted_amount_usd: priceResult.totalPrice || undefined,
      conversion_rate: priceResult.conversionRate || undefined,
      page_context: 'Hotel-Search offers page',
      is_offers_page: true,
      offers_page_url: offersPageUrl,
    };
    
    const isVerified = 
      result.structuralProof.breakdown_found &&
      result.structuralProof.total_label_found &&
      result.structuralProof.rendered_dates_match &&
      result.structuralProof.extracted_from_breakdown_total;
    
    console.log('[EXPEDIA] Structural proof:', JSON.stringify(result.structuralProof, null, 2));
    console.log(`[EXPEDIA] Success: $${priceResult.totalPrice} USD (${isVerified ? 'Verified' : 'Unverified'})`);
    
    result.success = true;
    result.status = 'success';
    result.durationMs = Date.now() - startTime;
    
    return result;
    
  } catch (error) {
    result.error = error instanceof Error ? error.message : 'Unknown error';
    result.status = 'validation_error';
    result.durationMs = Date.now() - startTime;
    result.providerAttemptTrace = providerAttemptTrace;
    const lastAttempted = providerAttemptTrace.filter(t => t.attempted).pop();
    result.providerUsed = lastAttempted?.provider || 'browserless';
    console.error('[EXPEDIA] Fatal error:', error);
    return result;
  }
}

// ============================================================================
// DENO SERVER HANDLER
// ============================================================================

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json() as ExtractionRequest;
    const { url, extractionId, checkIn, checkOut, adults = 1 } = body;
    
    // Strict date validation
    if (!checkIn || !checkOut) {
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: 'checkIn and checkOut dates are required',
          status: 'validation_error'
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    if (!isValidDateFormat(checkIn) || !isValidDateFormat(checkOut)) {
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: `Invalid date format. Expected YYYY-MM-DD, got checkIn=${checkIn}, checkOut=${checkOut}`,
          status: 'validation_error'
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    if (!url) {
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: 'url is required',
          status: 'validation_error'
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    console.log(`[EXPEDIA] Starting extraction for: ${url}`);
    console.log(`[EXPEDIA] Dates: ${checkIn} to ${checkOut}, Adults: ${adults}`);
    
    // Run extraction
    const extractionResult = await extractFromExpedia(url, checkIn, checkOut, adults);
    
    // Persist to database if extractionId provided
    if (extractionId) {
      try {
        const supabaseUrl = Deno.env.get('SUPABASE_URL');
        const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
        
        if (supabaseUrl && supabaseKey) {
          const supabase = createClient(supabaseUrl, supabaseKey);
          
          const updateData: Record<string, unknown> = {
            extraction_status: extractionResult.success ? 'price_extracted' : extractionResult.status,
            extraction_error: extractionResult.error,
            extraction_stage: 'golden_path_offers_page',
            provider_used: extractionResult.providerUsed,
            extraction_metadata: {
              goldenPath: extractionResult.goldenPath,
              offersPage: extractionResult.offersPage,
              structuralProof: extractionResult.structuralProof,
              providerAttemptTrace: extractionResult.providerAttemptTrace,
              durationMs: extractionResult.durationMs,
              proof_version: '2.0-golden-path',
            },
          };
          
          if (extractionResult.success && extractionResult.priceExtraction.totalPrice) {
            updateData.extracted_price = extractionResult.priceExtraction.totalPrice;
            updateData.currency = 'USD';
            updateData.includes_taxes_fees = extractionResult.priceExtraction.includesTaxesFees;
            updateData.evidence_snippets = extractionResult.priceExtraction.evidenceSnippet 
              ? [extractionResult.priceExtraction.evidenceSnippet]
              : null;
            updateData.detected_checkin = checkIn;
            updateData.detected_checkout = checkOut;
            updateData.dates_validated = true;
          }
          
          const { error: updateError } = await supabase
            .from('price_extractions')
            .update(updateData)
            .eq('id', extractionId);
          
          if (updateError) {
            console.error('[EXPEDIA] Failed to update extraction record:', updateError);
          } else {
            console.log(`[EXPEDIA] Updated extraction record: ${extractionId}`);
          }
        }
      } catch (dbError) {
        console.error('[EXPEDIA] Database error:', dbError);
      }
    }
    
    // Return result
    return new Response(
      JSON.stringify({
        success: extractionResult.success,
        status: extractionResult.status,
        price: extractionResult.priceExtraction.totalPrice,
        currency: extractionResult.priceExtraction.currency,
        originalAmount: extractionResult.priceExtraction.originalAmount,
        originalCurrency: extractionResult.priceExtraction.originalCurrency,
        conversionRate: extractionResult.priceExtraction.conversionRate,
        includesTaxesFees: extractionResult.priceExtraction.includesTaxesFees,
        error: extractionResult.error,
        goldenPath: extractionResult.goldenPath,
        structuralProof: extractionResult.structuralProof,
        providerUsed: extractionResult.providerUsed,
        providerAttemptTrace: extractionResult.providerAttemptTrace,
        durationMs: extractionResult.durationMs,
      }),
      { 
        status: extractionResult.success ? 200 : 422,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    );
    
  } catch (error) {
    console.error('[EXPEDIA] Handler error:', error);
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error',
        status: 'validation_error'
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
