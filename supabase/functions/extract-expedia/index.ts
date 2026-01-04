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
 * Expedia Production Extraction Function - v4.0
 * 
 * CHECKOUT-ONLY EXTRACTION:
 * - Prices ONLY accepted from booking/checkout breakdown context
 * - Listing pages, search summaries, nightly rates are REJECTED
 * - Must find explicit breakdown with taxes & fees
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
  | 'expedia_access_blocked';  // NEW: All providers blocked by Expedia

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
// These are approximate and should be updated regularly
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
  phase2_navigation_used?: boolean;
  unavailability_marker?: string;
  requested_checkin?: string;
  requested_checkout?: string;
  url_injected_checkin?: string;
  url_injected_checkout?: string;
  date_mismatch_details?: string;
  // Currency fields
  original_currency?: string;
  original_amount?: number;
  converted_amount_usd?: number;
  conversion_rate?: number;
  page_context?: string;  // Where extraction happened
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

interface PhaseAResult {
  ran: boolean;
  priceEligible: boolean;
  enterDatesFound: boolean;
  datesUnavailable: boolean;
  unavailabilityMarker: string | null;
  soldOut: boolean;
  contentHash: string | null;
  contentLength: number;
  bookingCtaFound: boolean;
  datesVerified: boolean;
  renderedCheckIn: string | null;
  renderedCheckOut: string | null;
  dateMismatchReason: string | null;
  // Page context detection
  isCheckoutContext: boolean;
  isListingPage: boolean;
  isSearchResults: boolean;
  pageContextEvidence: string | null;
}

interface PhaseBResult {
  ran: boolean;
  extractedPrice: number | null;
  currency: string | null;
  originalAmount: number | null;
  originalCurrency: string | null;
  conversionRate: number | null;
  includesTaxesFees: boolean | null;
  priceVerified: boolean;
  evidenceSnippet: string | null;
  subtotalRejected: boolean;
  rejectionReason: string | null;
  extractionContext: string | null;  // Where price was found
}

interface ExtractionResult {
  success: boolean;
  status: TerminalStatus;
  phaseA: PhaseAResult;
  phaseB: PhaseBResult;
  structuralProof: StructuralProof;
  durationMs: number;
  error: string | null;
  providerUsed: Provider | null;
  attempts: AttemptResult[];
  providerAttemptTrace: ProviderAttemptTrace[];  // NEW: Full trace for observability
  dateInjection: {
    requestedCheckIn: string;
    requestedCheckOut: string;
    finalUrlCheckIn: string | null;
    finalUrlCheckOut: string | null;
    urlBuiltSuccessfully: boolean;
  };
}

interface AttemptResult {
  attemptNumber: number;
  provider: Provider;
  phase: 'listing' | 'booking';
  contentLength: number;
  contentHash: string;
  success: boolean;
  error?: string;
  isRateLimited?: boolean;
  isBotBlocked?: boolean;
}

// Configuration
const MINIMAL_CONTENT_THRESHOLD = 3000;
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

// ============================================================================
// DETERMINISTIC URL BUILDER
// ============================================================================

interface UrlBuildResult {
  success: boolean;
  url: string;
  injectedCheckIn: string | null;
  injectedCheckOut: string | null;
  error?: string;
}

function buildExpediaUrlDeterministic(
  baseUrl: string, 
  checkIn: string, 
  checkOut: string, 
  adults: number = 2
): UrlBuildResult {
  try {
    const url = new URL(baseUrl);
    
    // Remove any conflicting date params
    const dateParamsToRemove = ['chkin', 'chkout', 'checkin', 'checkout', 'startDate', 'endDate'];
    for (const param of dateParamsToRemove) {
      url.searchParams.delete(param);
    }
    
    // Set exact dates
    url.searchParams.set('chkin', checkIn);
    url.searchParams.set('chkout', checkOut);
    url.searchParams.set('adults', String(adults));
    url.searchParams.set('x_pwa', '1');
    
    // Force USD currency if possible
    url.searchParams.set('currency', 'USD');
    
    const verifyCheckIn = url.searchParams.get('chkin');
    const verifyCheckOut = url.searchParams.get('chkout');
    
    if (verifyCheckIn !== checkIn || verifyCheckOut !== checkOut) {
      return {
        success: false,
        url: url.toString(),
        injectedCheckIn: verifyCheckIn,
        injectedCheckOut: verifyCheckOut,
        error: `Date injection mismatch: expected ${checkIn}/${checkOut}, got ${verifyCheckIn}/${verifyCheckOut}`
      };
    }
    
    console.log(`[EXPEDIA] URL built: chkin=${checkIn}, chkout=${checkOut}, currency=USD`);
    
    return {
      success: true,
      url: url.toString(),
      injectedCheckIn: checkIn,
      injectedCheckOut: checkOut,
    };
  } catch (error) {
    return {
      success: false,
      url: baseUrl,
      injectedCheckIn: null,
      injectedCheckOut: null,
      error: `URL build failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    };
  }
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
// PAGE CONTEXT DETECTION - Critical for checkout-only extraction
// ============================================================================

interface PageContextResult {
  isCheckoutContext: boolean;
  isListingPage: boolean;
  isSearchResults: boolean;
  pageType: 'checkout' | 'booking' | 'listing' | 'search' | 'unknown';
  evidence: string | null;
  hasBreakdown: boolean;
  hasTaxesFeesLine: boolean;
}

function detectPageContext(content: string): PageContextResult {
  const lowerContent = content.toLowerCase();
  
  const result: PageContextResult = {
    isCheckoutContext: false,
    isListingPage: false,
    isSearchResults: false,
    pageType: 'unknown',
    evidence: null,
    hasBreakdown: false,
    hasTaxesFeesLine: false,
  };
  
  // CHECKOUT/BOOKING INDICATORS (high confidence)
  const checkoutIndicators = [
    'complete your booking',
    'review your booking',
    'confirm your booking',
    'booking details',
    'trip details',
    'payment details',
    'enter payment',
    'pay now',
    'payment summary',
    'price summary',
    'your price summary',
    'total for your trip',
    'trip total',
    'booking total',
    'the price is',
    'ready to book',
    'complete booking',
  ];
  
  for (const indicator of checkoutIndicators) {
    if (lowerContent.includes(indicator)) {
      result.isCheckoutContext = true;
      result.pageType = 'checkout';
      result.evidence = indicator;
      break;
    }
  }
  
  // BREAKDOWN INDICATORS
  const breakdownIndicators = [
    'taxes and fees',
    'taxes & fees',
    'including taxes',
    'includes taxes',
    'price breakdown',
    'price details',
    'total includes',
    'service fee',
    'cleaning fee',
    'resort fee',
  ];
  
  for (const indicator of breakdownIndicators) {
    if (lowerContent.includes(indicator)) {
      result.hasBreakdown = true;
      result.hasTaxesFeesLine = true;
      break;
    }
  }
  
  // If we have breakdown but not checkout context, it might still be checkout-like
  if (result.hasBreakdown && result.hasTaxesFeesLine && !result.isCheckoutContext) {
    // Check for booking CTA to distinguish from listing
    if (/book\s+now|reserve\s+now|continue\s+booking|complete\s+booking/i.test(content)) {
      result.isCheckoutContext = true;
      result.pageType = 'booking';
      result.evidence = 'breakdown with booking CTA';
    }
  }
  
  // LISTING PAGE INDICATORS (must reject prices from here)
  const listingIndicators = [
    'see all properties',
    'property amenities',
    'about this property',
    'property highlights',
    'location highlights',
    'what\'s around',
    'similar properties',
    'you might also like',
    'policies',
    'house rules',
  ];
  
  if (!result.isCheckoutContext) {
    for (const indicator of listingIndicators) {
      if (lowerContent.includes(indicator)) {
        result.isListingPage = true;
        result.pageType = 'listing';
        result.evidence = indicator;
        break;
      }
    }
  }
  
  // SEARCH RESULTS INDICATORS (must reject prices from here)
  const searchIndicators = [
    'search results',
    'properties found',
    'hotels found',
    'showing results',
    'filter results',
    'sort by',
    'map view',
  ];
  
  if (!result.isCheckoutContext && !result.isListingPage) {
    for (const indicator of searchIndicators) {
      if (lowerContent.includes(indicator)) {
        result.isSearchResults = true;
        result.pageType = 'search';
        result.evidence = indicator;
        break;
      }
    }
  }
  
  console.log(`[EXPEDIA] Page context: ${result.pageType}, checkout=${result.isCheckoutContext}, breakdown=${result.hasBreakdown}`);
  
  return result;
}

// ============================================================================
// DATES UNAVAILABLE DETECTION
// ============================================================================

interface UnavailabilityResult {
  isUnavailable: boolean;
  marker: string | null;
  evidenceSnippet: string | null;
}

function detectDatesUnavailable(content: string): UnavailabilityResult {
  const unavailabilityPatterns = [
    { pattern: /no\s+availability/i, label: 'no availability' },
    { pattern: /sold\s+out/i, label: 'sold out' },
    { pattern: /not\s+available\s+for\s+(these|selected|your)\s+dates/i, label: 'not available for dates' },
    { pattern: /choose\s+different\s+dates/i, label: 'choose different dates' },
    { pattern: /try\s+different\s+dates/i, label: 'try different dates' },
    { pattern: /no\s+rooms?\s+available/i, label: 'no rooms available' },
    { pattern: /fully\s+booked/i, label: 'fully booked' },
    { pattern: /currently\s+unavailable/i, label: 'currently unavailable' },
    { pattern: /property\s+is\s+unavailable/i, label: 'property unavailable' },
    { pattern: /we\s+don['']?t\s+have\s+availability/i, label: 'no availability message' },
    { pattern: /no\s+longer\s+available/i, label: 'no longer available' },
  ];
  
  for (const { pattern, label } of unavailabilityPatterns) {
    const match = content.match(pattern);
    if (match) {
      const idx = content.toLowerCase().indexOf(match[0].toLowerCase());
      const start = Math.max(0, idx - 50);
      const end = Math.min(content.length, idx + match[0].length + 50);
      const snippet = content.slice(start, end).replace(/\s+/g, ' ').trim();
      
      return {
        isUnavailable: true,
        marker: label,
        evidenceSnippet: snippet,
      };
    }
  }
  
  // Additional check: No booking CTA + unavailability text
  const noBookingCta = !/book\s+now|reserve\s+now|continue\s+booking/i.test(content);
  const hasUnavailabilityContext = /unfortunately|sorry|we\s+couldn['']?t/i.test(content.toLowerCase());
  
  if (noBookingCta && hasUnavailabilityContext) {
    return {
      isUnavailable: true,
      marker: 'implicit unavailability (no booking CTA + apology text)',
      evidenceSnippet: null,
    };
  }
  
  return { isUnavailable: false, marker: null, evidenceSnippet: null };
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
    { pattern: /[\$€£¥]\s*[\d,]+(?:\.\d{2})?\s+for\s+\d+\s+nights?/i, label: 'X for N nights subtotal' },
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
    
    // Search/listing context prices
    { pattern: /show\s+prices?/i, label: 'show prices button context' },
    { pattern: /view\s+deal/i, label: 'view deal button context' },
    { pattern: /see\s+availability/i, label: 'availability button context' },
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
// CHECKOUT BREAKDOWN DETECTION
// ============================================================================

interface BreakdownResult {
  breakdown_found: boolean;
  total_label_found: boolean;
  breakdown_selector_used: string | null;
  total_value_raw: string | null;
  breakdown_price: number | null;
  breakdown_currency: string | null;
  has_fee_lines: boolean;
  has_taxes_visible: boolean;
  isCheckoutTotal: boolean;  // True ONLY if from checkout breakdown
}

function detectBreakdown(content: string, pageContext: PageContextResult): BreakdownResult {
  const result: BreakdownResult = {
    breakdown_found: false,
    total_label_found: false,
    breakdown_selector_used: null,
    total_value_raw: null,
    breakdown_price: null,
    breakdown_currency: null,
    has_fee_lines: false,
    has_taxes_visible: false,
    isCheckoutTotal: false,
  };
  
  // CRITICAL: Only accept prices from checkout context
  if (!pageContext.isCheckoutContext && !pageContext.hasBreakdown) {
    console.log('[EXPEDIA] Not in checkout context - breakdown detection skipped');
    return result;
  }
  
  const lowerContent = content.toLowerCase();
  
  // Look for breakdown container indicators
  const breakdownIndicators = [
    'price details',
    'price breakdown',
    'price summary',
    'your price summary',
    'payment summary',
    'total for your trip',
    'trip total',
    'booking total',
    'the price is',
  ];
  
  for (const indicator of breakdownIndicators) {
    if (lowerContent.includes(indicator)) {
      result.breakdown_found = true;
      result.breakdown_selector_used = indicator;
      break;
    }
  }
  
  // Check for taxes/fees lines
  const taxPatterns = [
    /taxes\s*(?:and|&)?\s*fees[:\s]*[\$€£¥]?[\d,]+/i,
    /[\$€£¥][\d,]+(?:\.\d{2})?\s*(?:in\s+)?taxes/i,
    /includes?\s+(?:all\s+)?taxes/i,
    /total\s+with\s+taxes/i,
    /including\s+taxes\s+(?:and|&)\s+fees/i,
  ];
  result.has_taxes_visible = taxPatterns.some(p => p.test(content));
  result.has_fee_lines = result.has_taxes_visible;
  
  // STRICT total patterns - only accept explicit checkout totals
  const checkoutTotalPatterns = [
    // "The price is $XXX total" - Expedia's canonical format
    /the\s+price\s+is\s+([\$€£¥]?\s*[\d,]+(?:\.\d{2})?)\s*total/i,
    // "Total: $XXX" in breakdown
    /(?:trip\s+)?total[:\s]+([\$€£¥]?\s*[\d,]+(?:\.\d{2})?)/i,
    // "$XXX total includes taxes"
    /([\$€£¥]?\s*[\d,]+(?:\.\d{2})?)\s*total\s+includes?\s+taxes/i,
    // "Total (includes taxes & fees): $XXX"
    /total\s*\([^)]*taxes[^)]*\)[:\s]*([\$€£¥]?\s*[\d,]+(?:\.\d{2})?)/i,
    // "Pay now: $XXX"
    /pay\s+now[:\s]*([\$€£¥]?\s*[\d,]+(?:\.\d{2})?)/i,
    // "Your total: $XXX"
    /your\s+total[:\s]*([\$€£¥]?\s*[\d,]+(?:\.\d{2})?)/i,
  ];
  
  for (const pattern of checkoutTotalPatterns) {
    const match = content.match(pattern);
    if (match && match[1]) {
      // Get surrounding context to verify it's not a subtotal
      const idx = content.indexOf(match[0]);
      const start = Math.max(0, idx - 100);
      const end = Math.min(content.length, idx + match[0].length + 100);
      const context = content.slice(start, end);
      
      // Reject if subtotal pattern found in context
      const subtotalCheck = detectSubtotal(context);
      if (subtotalCheck.isSubtotal) {
        console.log(`[EXPEDIA] Rejected total candidate - subtotal in context: ${subtotalCheck.pattern}`);
        continue;
      }
      
      result.total_label_found = true;
      result.total_value_raw = match[0];
      
      // Extract currency and amount
      const currencyResult = detectAndConvertCurrency(match[1]);
      if (currencyResult.detected) {
        result.breakdown_price = currencyResult.convertedAmountUsd;
        result.breakdown_currency = currencyResult.currencyCode;
        result.isCheckoutTotal = true;
        
        console.log(`[EXPEDIA] Checkout total found: ${currencyResult.originalAmount} ${currencyResult.currencyCode} = ${currencyResult.convertedAmountUsd} USD`);
        break;
      } else {
        // Try to parse as plain number (assume USD if $ present)
        const priceStr = match[1].replace(/[\$€£¥,\s]/g, '');
        const price = parseFloat(priceStr);
        if (!isNaN(price) && price > 0) {
          result.breakdown_price = price;
          result.breakdown_currency = match[1].includes('€') ? 'EUR' : 
                                       match[1].includes('£') ? 'GBP' :
                                       match[1].includes('¥') ? 'JPY' : 'USD';
          result.isCheckoutTotal = true;
          break;
        }
      }
    }
  }
  
  return result;
}

// ============================================================================
// RENDERED DATE VALIDATION
// ============================================================================

interface DateValidationResult {
  rendered_dates_match: boolean;
  renderedCheckIn: string | null;
  renderedCheckOut: string | null;
  date_value_raw: string | null;
  mismatchReason: string | null;
}

function validateRenderedDates(
  content: string,
  requestedCheckIn: string,
  requestedCheckOut: string
): DateValidationResult {
  const result: DateValidationResult = {
    rendered_dates_match: false,
    renderedCheckIn: null,
    renderedCheckOut: null,
    date_value_raw: null,
    mismatchReason: null,
  };
  
  const reqCheckIn = new Date(requestedCheckIn);
  const reqCheckOut = new Date(requestedCheckOut);
  
  if (isNaN(reqCheckIn.getTime()) || isNaN(reqCheckOut.getTime())) {
    result.mismatchReason = 'Invalid requested dates';
    return result;
  }
  
  // Pattern 1: "Jan 15 - Jan 18"
  const dateRangePattern = /([A-Z][a-z]{2}\s+\d{1,2})\s*[-–]\s*([A-Z][a-z]{2}\s+\d{1,2})/i;
  const rangeMatch = content.match(dateRangePattern);
  
  if (rangeMatch) {
    result.date_value_raw = rangeMatch[0];
    const year = reqCheckIn.getFullYear();
    
    const parsedCheckIn = parseDateToYYYYMMDD(rangeMatch[1], year);
    const parsedCheckOut = parseDateToYYYYMMDD(rangeMatch[2], year);
    
    result.renderedCheckIn = parsedCheckIn;
    result.renderedCheckOut = parsedCheckOut;
    
    if (parsedCheckIn && parsedCheckOut) {
      let checkOutYear = year;
      if (parsedCheckOut < parsedCheckIn) {
        checkOutYear = year + 1;
        result.renderedCheckOut = parseDateToYYYYMMDD(rangeMatch[2], checkOutYear);
      }
      
      if (parsedCheckIn === requestedCheckIn && result.renderedCheckOut === requestedCheckOut) {
        result.rendered_dates_match = true;
        console.log(`[EXPEDIA] Dates validated: ${parsedCheckIn} to ${result.renderedCheckOut}`);
        return result;
      } else {
        result.mismatchReason = `Rendered ${parsedCheckIn}/${result.renderedCheckOut} != requested ${requestedCheckIn}/${requestedCheckOut}`;
      }
    }
  }
  
  // Pattern 2: ISO format
  const isoPattern = /(\d{4}-\d{2}-\d{2})\s*(?:to|[-–])\s*(\d{4}-\d{2}-\d{2})/i;
  const isoMatch = content.match(isoPattern);
  
  if (isoMatch) {
    result.date_value_raw = isoMatch[0];
    result.renderedCheckIn = isoMatch[1];
    result.renderedCheckOut = isoMatch[2];
    
    if (isoMatch[1] === requestedCheckIn && isoMatch[2] === requestedCheckOut) {
      result.rendered_dates_match = true;
      return result;
    } else {
      result.mismatchReason = `Rendered ${isoMatch[1]}/${isoMatch[2]} != requested ${requestedCheckIn}/${requestedCheckOut}`;
    }
  }
  
  // Pattern 3: Exact date strings
  if (content.includes(requestedCheckIn) && content.includes(requestedCheckOut)) {
    result.date_value_raw = `${requestedCheckIn} to ${requestedCheckOut}`;
    result.renderedCheckIn = requestedCheckIn;
    result.renderedCheckOut = requestedCheckOut;
    result.rendered_dates_match = true;
    return result;
  }
  
  // Pattern 4: Implicit availability message
  if (/your\s+dates\s+are\s+available/i.test(content)) {
    result.date_value_raw = 'your dates are available (implicit)';
    result.rendered_dates_match = true;
    return result;
  }
  
  if (!result.mismatchReason) {
    result.mismatchReason = 'No recognizable date range found in content';
  }
  
  return result;
}

// ============================================================================
// PHASE A: Validate page state, context, and dates
// ============================================================================

function runPhaseA(
  content: string, 
  requestedCheckIn: string, 
  requestedCheckOut: string
): PhaseAResult {
  const lowerContent = content.toLowerCase();
  
  // Detect page context FIRST
  const pageContext = detectPageContext(content);
  
  // Check dates unavailable
  const unavailability = detectDatesUnavailable(content);
  if (unavailability.isUnavailable) {
    return {
      ran: true,
      priceEligible: false,
      enterDatesFound: false,
      datesUnavailable: true,
      unavailabilityMarker: unavailability.marker,
      soldOut: true,
      contentHash: simpleHash(content),
      contentLength: content.length,
      bookingCtaFound: false,
      datesVerified: false,
      renderedCheckIn: null,
      renderedCheckOut: null,
      dateMismatchReason: 'Dates unavailable',
      isCheckoutContext: pageContext.isCheckoutContext,
      isListingPage: pageContext.isListingPage,
      isSearchResults: pageContext.isSearchResults,
      pageContextEvidence: pageContext.evidence,
    };
  }
  
  // Validate rendered dates
  const dateValidation = validateRenderedDates(content, requestedCheckIn, requestedCheckOut);
  
  // Check for "enter dates" state
  const enterDatesIndicators = [
    'enter your dates',
    'select dates',
    'choose your dates',
    'add dates',
    'enter dates to see',
    'select check-in',
    'pick dates',
  ];
  const enterDatesFound = enterDatesIndicators.some(ind => lowerContent.includes(ind));
  
  // Check for booking CTA
  const bookingCtaPatterns = [
    /book\s+now/i,
    /reserve\s+now/i,
    /continue\s+booking/i,
    /select\s+room/i,
    /choose\s+room/i,
    /book\s+this/i,
  ];
  const bookingCtaFound = bookingCtaPatterns.some(p => p.test(content));
  
  // CRITICAL: Price eligible ONLY if in checkout context with breakdown
  const priceEligible = (pageContext.isCheckoutContext || pageContext.hasBreakdown) && 
                         !enterDatesFound && 
                         pageContext.hasTaxesFeesLine;
  
  return {
    ran: true,
    priceEligible,
    enterDatesFound,
    datesUnavailable: false,
    unavailabilityMarker: null,
    soldOut: false,
    contentHash: simpleHash(content),
    contentLength: content.length,
    bookingCtaFound,
    datesVerified: dateValidation.rendered_dates_match,
    renderedCheckIn: dateValidation.renderedCheckIn,
    renderedCheckOut: dateValidation.renderedCheckOut,
    dateMismatchReason: dateValidation.mismatchReason,
    isCheckoutContext: pageContext.isCheckoutContext,
    isListingPage: pageContext.isListingPage,
    isSearchResults: pageContext.isSearchResults,
    pageContextEvidence: pageContext.evidence,
  };
}

// ============================================================================
// PHASE B: Extract total price from CHECKOUT BREAKDOWN ONLY
// ============================================================================

function runPhaseB(content: string, phaseA: PhaseAResult): PhaseBResult {
  const result: PhaseBResult = {
    ran: true,
    extractedPrice: null,
    currency: null,
    originalAmount: null,
    originalCurrency: null,
    conversionRate: null,
    includesTaxesFees: null,
    priceVerified: false,
    evidenceSnippet: null,
    subtotalRejected: false,
    rejectionReason: null,
    extractionContext: null,
  };
  
  // CRITICAL: Reject if not in checkout context
  if (!phaseA.isCheckoutContext && !phaseA.priceEligible) {
    result.rejectionReason = `Not in checkout context (page type: ${phaseA.isListingPage ? 'listing' : phaseA.isSearchResults ? 'search' : 'unknown'})`;
    console.log(`[EXPEDIA] Phase B rejected: ${result.rejectionReason}`);
    return result;
  }
  
  // Get page context for breakdown detection
  const pageContext = detectPageContext(content);
  
  // Detect breakdown in checkout context
  const breakdownResult = detectBreakdown(content, pageContext);
  
  if (!breakdownResult.isCheckoutTotal) {
    result.rejectionReason = 'No checkout breakdown total found';
    console.log('[EXPEDIA] Phase B: No checkout breakdown total');
    return result;
  }
  
  if (!breakdownResult.breakdown_price) {
    result.rejectionReason = 'Breakdown found but price could not be parsed';
    return result;
  }
  
  // Extract currency and convert to USD
  const currencyResult = detectAndConvertCurrency(breakdownResult.total_value_raw || '');
  
  if (currencyResult.detected) {
    result.extractedPrice = currencyResult.convertedAmountUsd;
    result.currency = 'USD';
    result.originalAmount = currencyResult.originalAmount;
    result.originalCurrency = currencyResult.currencyCode;
    result.conversionRate = currencyResult.conversionRate;
    result.evidenceSnippet = breakdownResult.total_value_raw;
    result.extractionContext = breakdownResult.breakdown_selector_used || 'checkout breakdown';
    result.includesTaxesFees = breakdownResult.has_taxes_visible;
    result.priceVerified = true;
    
    console.log(`[EXPEDIA] Phase B: Extracted ${currencyResult.originalAmount} ${currencyResult.currencyCode} = $${result.extractedPrice} USD`);
  } else {
    // Use breakdown price directly (already parsed)
    result.extractedPrice = breakdownResult.breakdown_price;
    result.currency = breakdownResult.breakdown_currency || 'USD';
    result.originalAmount = breakdownResult.breakdown_price;
    result.originalCurrency = breakdownResult.breakdown_currency;
    result.conversionRate = breakdownResult.breakdown_currency === 'USD' ? 1 : null;
    result.evidenceSnippet = breakdownResult.total_value_raw;
    result.extractionContext = breakdownResult.breakdown_selector_used || 'checkout breakdown';
    result.includesTaxesFees = breakdownResult.has_taxes_visible;
    result.priceVerified = breakdownResult.has_taxes_visible;
    
    console.log(`[EXPEDIA] Phase B: Extracted $${result.extractedPrice} ${result.currency}`);
  }
  
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
  screenshot?: string;
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
    console.log('[EXPEDIA] Fetching with Firecrawl (last resort)...');
    
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
// MAIN EXTRACTION FUNCTION
// ============================================================================

async function extractFromExpedia(
  baseUrl: string,
  checkIn: string,
  checkOut: string,
  adults: number = 2
): Promise<ExtractionResult> {
  const startTime = Date.now();
  const attempts: AttemptResult[] = [];
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
    phaseA: {
      ran: false,
      priceEligible: false,
      enterDatesFound: false,
      datesUnavailable: false,
      unavailabilityMarker: null,
      soldOut: false,
      contentHash: null,
      contentLength: 0,
      bookingCtaFound: false,
      datesVerified: false,
      renderedCheckIn: null,
      renderedCheckOut: null,
      dateMismatchReason: null,
      isCheckoutContext: false,
      isListingPage: false,
      isSearchResults: false,
      pageContextEvidence: null,
    },
    phaseB: {
      ran: false,
      extractedPrice: null,
      currency: null,
      originalAmount: null,
      originalCurrency: null,
      conversionRate: null,
      includesTaxesFees: null,
      priceVerified: false,
      evidenceSnippet: null,
      subtotalRejected: false,
      rejectionReason: null,
      extractionContext: null,
    },
    structuralProof: {
      breakdown_found: false,
      total_label_found: false,
      rendered_dates_match: false,
      extracted_from_breakdown_total: false,
      proof_version: '1.0',
      requested_checkin: checkIn,
      requested_checkout: checkOut,
    },
    durationMs: 0,
    error: null,
    providerUsed: null,
    attempts: [],
    providerAttemptTrace: [],
    dateInjection: {
      requestedCheckIn: checkIn,
      requestedCheckOut: checkOut,
      finalUrlCheckIn: null,
      finalUrlCheckOut: null,
      urlBuiltSuccessfully: false,
    },
  };
  
  // Helper to update trace
  const updateTrace = (provider: Provider, updates: Partial<ProviderAttemptTrace>) => {
    const trace = providerAttemptTrace.find(t => t.provider === provider);
    if (trace) Object.assign(trace, updates);
  };
  
  try {
    // Build URL with dates
    console.log(`[EXPEDIA] Building URL with dates: ${checkIn} to ${checkOut}`);
    
    const urlBuild = buildExpediaUrlDeterministic(baseUrl, checkIn, checkOut, adults);
    
    result.dateInjection.urlBuiltSuccessfully = urlBuild.success;
    result.dateInjection.finalUrlCheckIn = urlBuild.injectedCheckIn;
    result.dateInjection.finalUrlCheckOut = urlBuild.injectedCheckOut;
    result.structuralProof.url_injected_checkin = urlBuild.injectedCheckIn || undefined;
    result.structuralProof.url_injected_checkout = urlBuild.injectedCheckOut || undefined;
    
    if (!urlBuild.success) {
      result.status = 'date_application_failed';
      result.error = urlBuild.error || 'Failed to build URL with dates';
      result.durationMs = Date.now() - startTime;
      result.providerAttemptTrace = providerAttemptTrace;
      // Mark first provider as failed before we even started
      updateTrace('browserless', { 
        reasonSkipped: 'URL build failed before provider attempt',
        outcome: 'navigation_failed'
      });
      result.providerUsed = 'browserless'; // Never leave as null
      return result;
    }
    
    const fullUrl = urlBuild.url;
    console.log(`[EXPEDIA] Final URL: ${fullUrl}`);
    
    // Fetch with provider chain - CONTROLLED FALLBACK POLICY
    let bestContent: string | null = null;
    let successfulProvider: Provider | null = null;
    let browserlessWasBotBlocked = false;
    let browserlessWasRateLimited = false;
    
    // ============================================================
    // STEP 1: Try Browserless first
    // ============================================================
    console.log('[EXPEDIA] Step 1: Trying Browserless...');
    
    const browserlessStartTime = new Date().toISOString();
    updateTrace('browserless', { attempted: true, startedAt: browserlessStartTime });
    
    const browserlessResult = await fetchWithBrowserless(fullUrl);
    
    updateTrace('browserless', {
      endedAt: new Date().toISOString(),
      contentLength: browserlessResult.content.length,
    });
    
    const browserlessAttempt: AttemptResult = {
      attemptNumber: 1,
      provider: 'browserless',
      phase: 'listing',
      contentLength: browserlessResult.content.length,
      contentHash: simpleHash(browserlessResult.content || ''),
      success: false,
      error: browserlessResult.error,
      isRateLimited: browserlessResult.isRateLimited,
      isBotBlocked: browserlessResult.isBotBlocked,
    };
    attempts.push(browserlessAttempt);
    
    // Check for hard-stop conditions
    if (browserlessResult.isRateLimited) {
      // HARD STOP: Rate limited - no fallbacks
      console.log('[EXPEDIA] HARD STOP: Browserless rate limited (429)');
      browserlessWasRateLimited = true;
      
      updateTrace('browserless', {
        outcome: 'rate_limited',
        errorMessage: browserlessResult.error || 'HTTP 429',
      });
      updateTrace('zyte', { reasonSkipped: 'Browserless rate-limited - no fallbacks per policy' });
      updateTrace('firecrawl', { reasonSkipped: 'Browserless rate-limited - no fallbacks per policy' });
      
      result.status = 'blocked_rate_limit';
      result.error = 'Browserless rate limited (HTTP 429) - no fallback per anti-amplification policy';
      result.attempts = attempts;
      result.providerAttemptTrace = providerAttemptTrace;
      result.providerUsed = 'browserless';
      result.durationMs = Date.now() - startTime;
      return result;
    }
    
    if (browserlessResult.isBotBlocked) {
      // BOT BLOCKED: Attempt exactly ONE Zyte fallback
      console.log('[EXPEDIA] Browserless bot-blocked - attempting controlled Zyte fallback');
      browserlessWasBotBlocked = true;
      
      updateTrace('browserless', {
        outcome: 'bot_blocked',
        errorMessage: browserlessResult.error || 'CAPTCHA/WAF detected',
        botBlockedFallbackToZyte: true,
      });
      
      // Firecrawl is explicitly skipped when Browserless is bot-blocked
      updateTrace('firecrawl', { reasonSkipped: 'Browserless bot-blocked - only Zyte fallback per policy' });
      
    } else if (browserlessResult.error) {
      // Other error - continue to next provider
      console.log(`[EXPEDIA] Browserless error: ${browserlessResult.error}`);
      updateTrace('browserless', {
        outcome: 'navigation_failed',
        errorMessage: browserlessResult.error,
      });
    } else if (browserlessResult.content.length < MINIMAL_CONTENT_THRESHOLD) {
      // Insufficient content
      console.log(`[EXPEDIA] Browserless insufficient content (${browserlessResult.content.length} chars)`);
      updateTrace('browserless', {
        outcome: 'insufficient_content',
        errorMessage: `Only ${browserlessResult.content.length} chars (need ${MINIMAL_CONTENT_THRESHOLD})`,
      });
    } else {
      // Browserless got content - run Phase A
      const phaseAResult = runPhaseA(browserlessResult.content, checkIn, checkOut);
      result.phaseA = phaseAResult;
      
      if (phaseAResult.datesUnavailable) {
        updateTrace('browserless', { outcome: 'success' });
        browserlessAttempt.success = true;
        result.status = 'dates_unavailable';
        result.error = `Dates unavailable: ${phaseAResult.unavailabilityMarker}`;
        result.providerUsed = 'browserless';
        result.attempts = attempts;
        result.providerAttemptTrace = providerAttemptTrace;
        result.durationMs = Date.now() - startTime;
        result.structuralProof.unavailability_marker = phaseAResult.unavailabilityMarker || undefined;
        updateTrace('zyte', { reasonSkipped: 'Browserless detected dates_unavailable' });
        updateTrace('firecrawl', { reasonSkipped: 'Browserless detected dates_unavailable' });
        return result;
      }
      
      if (phaseAResult.priceEligible && phaseAResult.datesVerified) {
        console.log('[EXPEDIA] Browserless succeeded - checkout context, dates verified');
        updateTrace('browserless', { outcome: 'success' });
        browserlessAttempt.success = true;
        bestContent = browserlessResult.content;
        successfulProvider = 'browserless';
        updateTrace('zyte', { reasonSkipped: 'Browserless succeeded' });
        updateTrace('firecrawl', { reasonSkipped: 'Browserless succeeded' });
      } else if (!phaseAResult.datesVerified) {
        console.log(`[EXPEDIA] Browserless: Dates not verified - ${phaseAResult.dateMismatchReason}`);
        updateTrace('browserless', {
          outcome: 'parsing_failed',
          errorMessage: `Dates not verified: ${phaseAResult.dateMismatchReason}`,
        });
        result.structuralProof.date_mismatch_details = phaseAResult.dateMismatchReason || undefined;
      } else if (!phaseAResult.isCheckoutContext && !phaseAResult.priceEligible) {
        console.log(`[EXPEDIA] Browserless: Not in checkout context`);
        updateTrace('browserless', {
          outcome: 'checkout_not_reached',
          errorMessage: `Page type: ${phaseAResult.isListingPage ? 'listing' : phaseAResult.isSearchResults ? 'search' : 'unknown'}`,
        });
      }
    }
    
    // ============================================================
    // STEP 2: Try Zyte (if Browserless didn't succeed)
    // ============================================================
    if (!successfulProvider) {
      // Only try Zyte if:
      // - Browserless was bot-blocked (controlled fallback)
      // - OR Browserless had other non-rate-limit issues
      if (browserlessWasRateLimited) {
        // Already handled above - should not reach here
        console.log('[EXPEDIA] Unexpected: reached Zyte section after rate limit');
      } else {
        console.log('[EXPEDIA] Step 2: Trying Zyte...');
        
        const zyteStartTime = new Date().toISOString();
        updateTrace('zyte', { attempted: true, startedAt: zyteStartTime });
        
        const zyteResult = await fetchWithZyte(fullUrl);
        
        updateTrace('zyte', {
          endedAt: new Date().toISOString(),
          contentLength: zyteResult.content.length,
        });
        
        const zyteAttempt: AttemptResult = {
          attemptNumber: attempts.length + 1,
          provider: 'zyte',
          phase: 'listing',
          contentLength: zyteResult.content.length,
          contentHash: simpleHash(zyteResult.content || ''),
          success: false,
          error: zyteResult.error,
          isRateLimited: zyteResult.isRateLimited,
          isBotBlocked: zyteResult.isBotBlocked,
        };
        attempts.push(zyteAttempt);
        
        if (zyteResult.isRateLimited || zyteResult.isBotBlocked) {
          // Both providers blocked - terminal state
          console.log(`[EXPEDIA] Zyte also blocked: ${zyteResult.isRateLimited ? 'rate limited' : 'bot blocked'}`);
          updateTrace('zyte', {
            outcome: zyteResult.isRateLimited ? 'rate_limited' : 'bot_blocked',
            errorMessage: zyteResult.error,
          });
          
          // If Browserless was bot-blocked AND Zyte is also blocked -> expedia_access_blocked
          if (browserlessWasBotBlocked) {
            updateTrace('firecrawl', { reasonSkipped: 'Both Browserless and Zyte blocked - terminal' });
            
            result.status = 'expedia_access_blocked';
            result.error = 'Expedia blocked access (CAPTCHA) - cannot retrieve price for these dates';
            result.attempts = attempts;
            result.providerAttemptTrace = providerAttemptTrace;
            result.providerUsed = 'zyte'; // Last attempted provider
            result.durationMs = Date.now() - startTime;
            return result;
          }
        } else if (zyteResult.error) {
          console.log(`[EXPEDIA] Zyte error: ${zyteResult.error}`);
          updateTrace('zyte', {
            outcome: 'navigation_failed',
            errorMessage: zyteResult.error,
          });
        } else if (zyteResult.content.length < MINIMAL_CONTENT_THRESHOLD) {
          console.log(`[EXPEDIA] Zyte insufficient content (${zyteResult.content.length} chars)`);
          updateTrace('zyte', {
            outcome: 'insufficient_content',
            errorMessage: `Only ${zyteResult.content.length} chars (need ${MINIMAL_CONTENT_THRESHOLD})`,
          });
        } else {
          // Zyte got content - run Phase A
          const phaseAResult = runPhaseA(zyteResult.content, checkIn, checkOut);
          result.phaseA = phaseAResult;
          
          if (phaseAResult.datesUnavailable) {
            updateTrace('zyte', { outcome: 'success' });
            zyteAttempt.success = true;
            result.status = 'dates_unavailable';
            result.error = `Dates unavailable: ${phaseAResult.unavailabilityMarker}`;
            result.providerUsed = 'zyte';
            result.attempts = attempts;
            result.providerAttemptTrace = providerAttemptTrace;
            result.durationMs = Date.now() - startTime;
            result.structuralProof.unavailability_marker = phaseAResult.unavailabilityMarker || undefined;
            updateTrace('firecrawl', { reasonSkipped: 'Zyte detected dates_unavailable' });
            return result;
          }
          
          if (phaseAResult.priceEligible && phaseAResult.datesVerified) {
            console.log('[EXPEDIA] Zyte succeeded - checkout context, dates verified');
            updateTrace('zyte', { outcome: 'success' });
            zyteAttempt.success = true;
            bestContent = zyteResult.content;
            successfulProvider = 'zyte';
            updateTrace('firecrawl', { reasonSkipped: 'Zyte succeeded' });
          } else if (!phaseAResult.datesVerified) {
            console.log(`[EXPEDIA] Zyte: Dates not verified - ${phaseAResult.dateMismatchReason}`);
            updateTrace('zyte', {
              outcome: 'parsing_failed',
              errorMessage: `Dates not verified: ${phaseAResult.dateMismatchReason}`,
            });
            result.structuralProof.date_mismatch_details = phaseAResult.dateMismatchReason || undefined;
          } else {
            console.log('[EXPEDIA] Zyte: Not in checkout context');
            updateTrace('zyte', {
              outcome: 'checkout_not_reached',
              errorMessage: `Page type: ${phaseAResult.isListingPage ? 'listing' : 'unknown'}`,
            });
          }
        }
      }
    }
    
    // ============================================================
    // STEP 3: Try Firecrawl (only if Browserless wasn't bot-blocked)
    // ============================================================
    if (!successfulProvider && !browserlessWasBotBlocked) {
      console.log('[EXPEDIA] Step 3: Trying Firecrawl (last resort)...');
      
      const firecrawlStartTime = new Date().toISOString();
      updateTrace('firecrawl', { attempted: true, startedAt: firecrawlStartTime });
      
      const firecrawlResult = await fetchWithFirecrawl(fullUrl);
      
      updateTrace('firecrawl', {
        endedAt: new Date().toISOString(),
        contentLength: firecrawlResult.content.length,
      });
      
      const firecrawlAttempt: AttemptResult = {
        attemptNumber: attempts.length + 1,
        provider: 'firecrawl',
        phase: 'listing',
        contentLength: firecrawlResult.content.length,
        contentHash: simpleHash(firecrawlResult.content || ''),
        success: false,
        error: firecrawlResult.error,
        isRateLimited: firecrawlResult.isRateLimited,
        isBotBlocked: firecrawlResult.isBotBlocked,
      };
      attempts.push(firecrawlAttempt);
      
      if (firecrawlResult.error) {
        console.log(`[EXPEDIA] Firecrawl error: ${firecrawlResult.error}`);
        updateTrace('firecrawl', {
          outcome: firecrawlResult.isRateLimited ? 'rate_limited' : 
                   firecrawlResult.isBotBlocked ? 'bot_blocked' : 'navigation_failed',
          errorMessage: firecrawlResult.error,
        });
      } else if (firecrawlResult.content.length < MINIMAL_CONTENT_THRESHOLD) {
        console.log(`[EXPEDIA] Firecrawl insufficient content (${firecrawlResult.content.length} chars)`);
        updateTrace('firecrawl', {
          outcome: 'insufficient_content',
          errorMessage: `Only ${firecrawlResult.content.length} chars`,
        });
      } else {
        // Firecrawl got content - run Phase A
        const phaseAResult = runPhaseA(firecrawlResult.content, checkIn, checkOut);
        result.phaseA = phaseAResult;
        
        if (phaseAResult.datesUnavailable) {
          updateTrace('firecrawl', { outcome: 'success' });
          firecrawlAttempt.success = true;
          result.status = 'dates_unavailable';
          result.error = `Dates unavailable: ${phaseAResult.unavailabilityMarker}`;
          result.providerUsed = 'firecrawl';
          result.attempts = attempts;
          result.providerAttemptTrace = providerAttemptTrace;
          result.durationMs = Date.now() - startTime;
          result.structuralProof.unavailability_marker = phaseAResult.unavailabilityMarker || undefined;
          return result;
        }
        
        if (phaseAResult.priceEligible && phaseAResult.datesVerified) {
          console.log('[EXPEDIA] Firecrawl succeeded - checkout context, dates verified');
          updateTrace('firecrawl', { outcome: 'success' });
          firecrawlAttempt.success = true;
          bestContent = firecrawlResult.content;
          successfulProvider = 'firecrawl';
        } else if (!phaseAResult.datesVerified) {
          console.log(`[EXPEDIA] Firecrawl: Dates not verified - ${phaseAResult.dateMismatchReason}`);
          updateTrace('firecrawl', {
            outcome: 'parsing_failed',
            errorMessage: `Dates not verified: ${phaseAResult.dateMismatchReason}`,
          });
          result.structuralProof.date_mismatch_details = phaseAResult.dateMismatchReason || undefined;
        } else {
          console.log('[EXPEDIA] Firecrawl: Not in checkout context');
          updateTrace('firecrawl', {
            outcome: 'checkout_not_reached',
            errorMessage: 'Page type: unknown',
          });
        }
      }
    }
    
    result.attempts = attempts;
    result.providerAttemptTrace = providerAttemptTrace;
    result.providerUsed = successfulProvider;
    
    // If no provider succeeded, determine terminal status
    if (!bestContent || !successfulProvider) {
      // Find the last attempted provider for providerUsed
      const lastAttempted = providerAttemptTrace.filter(t => t.attempted).pop();
      result.providerUsed = lastAttempted?.provider || 'browserless';
      
      if (browserlessWasBotBlocked && !successfulProvider) {
        // Browserless bot-blocked and Zyte failed too
        result.status = 'expedia_access_blocked';
        result.error = 'Expedia blocked access (CAPTCHA) - cannot retrieve price for these dates';
      } else if (result.phaseA.dateMismatchReason && !result.phaseA.datesVerified) {
        result.status = 'date_application_failed';
        result.error = `Dates not verified: ${result.phaseA.dateMismatchReason}`;
      } else if (!result.phaseA.isCheckoutContext) {
        result.status = 'checkout_not_reached';
        result.error = 'Could not reach checkout context for price extraction';
      } else {
        const lastAttempt = attempts[attempts.length - 1];
        result.status = 'render_failed';
        result.error = `All providers failed. Last: ${lastAttempt?.error || 'No content'}`;
      }
      result.durationMs = Date.now() - startTime;
      return result;
    }
    
    // Run Phase B - checkout-only extraction
    const phaseBResult = runPhaseB(bestContent, result.phaseA);
    result.phaseB = phaseBResult;
    
    // No checkout total found
    if (!phaseBResult.extractedPrice || !phaseBResult.priceVerified) {
      result.status = 'price_not_found';
      result.error = phaseBResult.rejectionReason || 'No verified checkout total found';
      result.durationMs = Date.now() - startTime;
      return result;
    }
    
    // Currency conversion failed (non-USD without conversion)
    if (phaseBResult.originalCurrency && 
        phaseBResult.originalCurrency !== 'USD' && 
        !phaseBResult.conversionRate) {
      result.status = 'currency_conversion_failed';
      result.error = `Currency ${phaseBResult.originalCurrency} could not be converted to USD`;
      result.durationMs = Date.now() - startTime;
      return result;
    }
    
    // Build structural proof
    const pageContext = detectPageContext(bestContent);
    const breakdownResult = detectBreakdown(bestContent, pageContext);
    
    result.structuralProof = {
      breakdown_found: breakdownResult.breakdown_found && breakdownResult.has_fee_lines,
      total_label_found: breakdownResult.total_label_found,
      rendered_dates_match: result.phaseA.datesVerified,
      extracted_from_breakdown_total: breakdownResult.isCheckoutTotal && breakdownResult.breakdown_price !== null,
      proof_version: '1.0',
      breakdown_selector_used: breakdownResult.breakdown_selector_used || undefined,
      total_value_raw: breakdownResult.total_value_raw || undefined,
      date_value_raw: result.phaseA.renderedCheckIn && result.phaseA.renderedCheckOut 
        ? `${result.phaseA.renderedCheckIn} to ${result.phaseA.renderedCheckOut}` 
        : undefined,
      phase2_navigation_used: false,
      requested_checkin: checkIn,
      requested_checkout: checkOut,
      url_injected_checkin: result.dateInjection.finalUrlCheckIn || undefined,
      url_injected_checkout: result.dateInjection.finalUrlCheckOut || undefined,
      // Currency audit
      original_currency: phaseBResult.originalCurrency || undefined,
      original_amount: phaseBResult.originalAmount || undefined,
      converted_amount_usd: phaseBResult.extractedPrice || undefined,
      conversion_rate: phaseBResult.conversionRate || undefined,
      page_context: phaseBResult.extractionContext || undefined,
    };
    
    const isVerified = 
      result.structuralProof.breakdown_found &&
      result.structuralProof.total_label_found &&
      result.structuralProof.rendered_dates_match &&
      result.structuralProof.extracted_from_breakdown_total;
    
    console.log('[EXPEDIA] Structural proof:', JSON.stringify(result.structuralProof, null, 2));
    console.log(`[EXPEDIA] Success: $${phaseBResult.extractedPrice} USD (${isVerified ? 'Verified' : 'Unverified'})`);
    
    result.success = true;
    result.status = 'success';
    result.durationMs = Date.now() - startTime;
    
    return result;
    
  } catch (error) {
    result.error = error instanceof Error ? error.message : 'Unknown error';
    result.status = 'validation_error';
    result.durationMs = Date.now() - startTime;
    result.attempts = attempts;
    result.providerAttemptTrace = providerAttemptTrace;
    // Never leave providerUsed as null
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
    const { url, extractionId, checkIn, checkOut, adults = 2 } = body;
    
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
          error: `Invalid date format. Expected YYYY-MM-DD, got checkIn="${checkIn}", checkOut="${checkOut}"`,
          status: 'validation_error'
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    const checkInDate = new Date(checkIn);
    const checkOutDate = new Date(checkOut);
    if (checkOutDate <= checkInDate) {
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: `checkOut must be after checkIn. Got ${checkIn} to ${checkOut}`,
          status: 'validation_error'
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabaseClient = createClient(supabaseUrl, supabaseKey);
    
    let targetUrl = url;
    let dbExtractionId = extractionId;
    
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
      
      if (!extraction.platform_name.toLowerCase().includes('expedia')) {
        return new Response(
          JSON.stringify({ success: false, error: 'This function only handles Expedia extractions' }),
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
    
    console.log(`[EXPEDIA] Starting extraction: ${checkIn} to ${checkOut}`);
    console.log(`[EXPEDIA] Base URL: ${targetUrl}`);
    
    const result = await extractFromExpedia(targetUrl, checkIn, checkOut, adults);
    
    const isVerified = 
      result.structuralProof.breakdown_found &&
      result.structuralProof.total_label_found &&
      result.structuralProof.rendered_dates_match &&
      result.structuralProof.extracted_from_breakdown_total;
    
    // Update DB
    if (dbExtractionId) {
      await supabaseClient
        .from('price_extractions')
        .update({
          extraction_status: result.status,
          extracted_price: result.phaseB.extractedPrice,
          currency: result.phaseB.currency || 'USD',
          includes_taxes_fees: result.phaseB.includesTaxesFees,
          extraction_error: result.error,
          page_content_hash: result.phaseA.contentHash,
          provider_used: result.providerUsed,
          dates_validated: result.phaseA.datesVerified,
          detected_checkin: result.phaseA.renderedCheckIn,
          detected_checkout: result.phaseA.renderedCheckOut,
          evidence_snippets: result.phaseB.evidenceSnippet ? [result.phaseB.evidenceSnippet] : null,
          extraction_metadata: {
            goldenPath: true,
            platform: 'expedia',
            version: '4.1',
            phaseA: result.phaseA,
            phaseB: result.phaseB,
            structural_proof: result.structuralProof,
            verification_status: isVerified ? 'Verified' : 'Unverified',
            provider_order: PROVIDER_ORDER,
            attempts: result.attempts,
            providerAttemptTrace: result.providerAttemptTrace, // NEW: Full trace for observability
            durationMs: result.durationMs,
            dateInjection: result.dateInjection,
            // Currency audit
            currency_handling: {
              original_currency: result.phaseB.originalCurrency,
              original_amount: result.phaseB.originalAmount,
              converted_amount_usd: result.phaseB.extractedPrice,
              conversion_rate: result.phaseB.conversionRate,
            },
          },
          updated_at: new Date().toISOString(),
        })
        .eq('id', dbExtractionId);
    }
    
    return new Response(
      JSON.stringify({
        success: result.success,
        result,
        goldenPath: true,
        platform: 'expedia',
        version: '4.0',
        verification_status: isVerified ? 'Verified' : 'Unverified',
        provider_used: result.providerUsed,
        dateInjection: result.dateInjection,
        currency_handling: {
          original_currency: result.phaseB.originalCurrency,
          original_amount: result.phaseB.originalAmount,
          converted_amount_usd: result.phaseB.extractedPrice,
          conversion_rate: result.phaseB.conversionRate,
        },
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
    
  } catch (error) {
    console.error('[EXPEDIA] Fatal error:', error);
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
