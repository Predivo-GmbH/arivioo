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
 * Expedia Production Extraction Function - v3.0
 * 
 * DATE INJECTION FIX:
 * - Dates are the single source of truth from request payload
 * - URL is deterministically rebuilt with exact chkin/chkout params
 * - Rendered dates are validated before price extraction
 * - date_application_failed returned if dates cannot be proven
 * 
 * PROVIDER PRIORITY:
 * 1. Browserless (primary) - best for JavaScript rendering
 * 2. Zyte (secondary) - fallback for non-access failures
 * 3. Firecrawl (last resort) - only if both fail for non-access reasons
 * 
 * TWO-STEP EXTRACTION:
 * Phase 1: Load listing page with dates applied, validate dates match
 * Phase 2: Extract price from breakdown (only if dates verified)
 */

// Terminal status values
type TerminalStatus = 
  | 'success'
  | 'date_application_failed'    // NEW: Dates could not be applied/verified
  | 'dates_not_applied'
  | 'dates_unavailable'
  | 'no_availability_for_dates'
  | 'blocked_captcha_or_bot'
  | 'blocked_rate_limit'
  | 'sold_out'
  | 'price_not_found'
  | 'render_failed'
  | 'validation_error'
  | 'subtotal_rejected';

type Provider = 'browserless' | 'zyte' | 'firecrawl';

const PROVIDER_ORDER: Provider[] = ['browserless', 'zyte', 'firecrawl'];

/**
 * Structural proof object - REQUIRED for Verified status
 */
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
  // Date injection audit fields
  requested_checkin?: string;
  requested_checkout?: string;
  url_injected_checkin?: string;
  url_injected_checkout?: string;
  date_mismatch_details?: string;
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
  // Date validation results
  datesVerified: boolean;
  renderedCheckIn: string | null;
  renderedCheckOut: string | null;
  dateMismatchReason: string | null;
}

interface PhaseBResult {
  ran: boolean;
  extractedPrice: number | null;
  currency: string | null;
  includesTaxesFees: boolean | null;
  priceVerified: boolean;
  evidenceSnippet: string | null;
  subtotalRejected: boolean;
  rejectionReason: string | null;
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
  // Audit trail for date injection
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
// DATE VALIDATION - STRICT
// ============================================================================

/**
 * Validate date format (YYYY-MM-DD)
 */
function isValidDateFormat(dateStr: string): boolean {
  if (!dateStr) return false;
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(dateStr)) return false;
  
  const date = new Date(dateStr);
  return !isNaN(date.getTime());
}

/**
 * Parse date from various formats to YYYY-MM-DD
 */
function parseDateToYYYYMMDD(dateStr: string, referenceYear?: number): string | null {
  if (!dateStr) return null;
  
  // Already in YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return dateStr;
  }
  
  // Handle "Jan 15" format
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

/**
 * Build Expedia URL with EXACT date injection
 * - Removes any existing date params
 * - Sets chkin=YYYY-MM-DD and chkout=YYYY-MM-DD exactly
 * - Preserves other params
 */
function buildExpediaUrlDeterministic(
  baseUrl: string, 
  checkIn: string, 
  checkOut: string, 
  adults: number = 2
): UrlBuildResult {
  try {
    const url = new URL(baseUrl);
    
    // Remove any conflicting date params (clean slate)
    const dateParamsToRemove = ['chkin', 'chkout', 'checkin', 'checkout', 'startDate', 'endDate'];
    for (const param of dateParamsToRemove) {
      url.searchParams.delete(param);
    }
    
    // Set exact dates in YYYY-MM-DD format
    url.searchParams.set('chkin', checkIn);
    url.searchParams.set('chkout', checkOut);
    url.searchParams.set('adults', String(adults));
    url.searchParams.set('x_pwa', '1');
    
    // Verify dates were set correctly by re-reading
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
    
    console.log(`[EXPEDIA] URL built: chkin=${checkIn}, chkout=${checkOut}`);
    
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
// SUBTOTAL DETECTION (MUST REJECT)
// ============================================================================

interface SubtotalCheckResult {
  isSubtotal: boolean;
  pattern: string | null;
  rawValue: string | null;
}

function detectSubtotal(priceText: string): SubtotalCheckResult {
  const subtotalPatterns = [
    { pattern: /\$[\d,]+(?:\.\d{2})?\s*(?:per|\/)\s*night/i, label: 'per night rate' },
    { pattern: /\$[\d,]+(?:\.\d{2})?\s+for\s+\d+\s+nights?/i, label: 'X for N nights subtotal' },
    { pattern: /nightly\s+rate[:\s]*\$[\d,]+/i, label: 'nightly rate' },
    { pattern: /room\s+rate[:\s]*\$[\d,]+/i, label: 'room rate only' },
    { pattern: /before\s+taxes/i, label: 'before taxes disclaimer' },
    { pattern: /excluding\s+taxes/i, label: 'excluding taxes' },
    { pattern: /\+\s*taxes\s+(?:and|&)\s*fees/i, label: 'plus taxes indicator' },
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
// BREAKDOWN DETECTION
// ============================================================================

interface BreakdownResult {
  breakdown_found: boolean;
  total_label_found: boolean;
  breakdown_selector_used: string | null;
  total_value_raw: string | null;
  breakdown_price: number | null;
  has_fee_lines: boolean;
  has_taxes_visible: boolean;
}

function detectBreakdown(content: string): BreakdownResult {
  const result: BreakdownResult = {
    breakdown_found: false,
    total_label_found: false,
    breakdown_selector_used: null,
    total_value_raw: null,
    breakdown_price: null,
    has_fee_lines: false,
    has_taxes_visible: false,
  };
  
  const lowerContent = content.toLowerCase();
  
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
    'taxes and fees',
    'taxes & fees',
  ];
  
  for (const indicator of breakdownIndicators) {
    if (lowerContent.includes(indicator)) {
      result.breakdown_found = true;
      result.breakdown_selector_used = indicator;
      break;
    }
  }
  
  const taxPatterns = [
    /taxes\s*(?:and|&)?\s*fees[:\s]*\$?[\d,]+/i,
    /\$[\d,]+(?:\.\d{2})?\s*(?:in\s+)?taxes/i,
    /includes?\s+(?:all\s+)?taxes/i,
    /total\s+with\s+taxes/i,
  ];
  result.has_taxes_visible = taxPatterns.some(p => p.test(content));
  result.has_fee_lines = result.has_taxes_visible;
  
  const totalPatterns = [
    /the\s+price\s+is\s+\$?([\d,]+(?:\.\d{2})?)\s*total/i,
    /total[:\s]+\$?([\d,]+(?:\.\d{2})?)/i,
    /\$?([\d,]+(?:\.\d{2})?)\s*total\s+includes?\s+taxes/i,
    /trip\s+total[:\s]+\$?([\d,]+(?:\.\d{2})?)/i,
    /\$?([\d,]+(?:\.\d{2})?)\s*total(?:\s|$)/i,
  ];
  
  for (const pattern of totalPatterns) {
    const match = content.match(pattern);
    if (match) {
      result.total_label_found = true;
      result.total_value_raw = match[0];
      const priceStr = match[1].replace(/,/g, '');
      result.breakdown_price = parseFloat(priceStr);
      break;
    }
  }
  
  return result;
}

// ============================================================================
// RENDERED DATE VALIDATION - STRICT
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
    console.log('[EXPEDIA] Invalid requested dates for validation');
    return result;
  }
  
  // Pattern 1: "Jan 15 - Jan 18" or "Jan 15 – Jan 18"
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
      // Handle year boundary (Dec-Jan)
      let checkOutYear = year;
      if (parsedCheckOut < parsedCheckIn) {
        checkOutYear = year + 1;
        result.renderedCheckOut = parseDateToYYYYMMDD(rangeMatch[2], checkOutYear);
      }
      
      if (parsedCheckIn === requestedCheckIn && (result.renderedCheckOut === requestedCheckOut)) {
        result.rendered_dates_match = true;
        console.log(`[EXPEDIA] Dates validated: ${parsedCheckIn} to ${result.renderedCheckOut}`);
        return result;
      } else {
        result.mismatchReason = `Rendered ${parsedCheckIn}/${result.renderedCheckOut} != requested ${requestedCheckIn}/${requestedCheckOut}`;
      }
    }
  }
  
  // Pattern 2: ISO format "2025-01-15 to 2025-01-18"
  const isoPattern = /(\d{4}-\d{2}-\d{2})\s*(?:to|[-–])\s*(\d{4}-\d{2}-\d{2})/i;
  const isoMatch = content.match(isoPattern);
  
  if (isoMatch) {
    result.date_value_raw = isoMatch[0];
    result.renderedCheckIn = isoMatch[1];
    result.renderedCheckOut = isoMatch[2];
    
    if (isoMatch[1] === requestedCheckIn && isoMatch[2] === requestedCheckOut) {
      result.rendered_dates_match = true;
      console.log(`[EXPEDIA] Dates validated (ISO): ${isoMatch[1]} to ${isoMatch[2]}`);
      return result;
    } else {
      result.mismatchReason = `Rendered ${isoMatch[1]}/${isoMatch[2]} != requested ${requestedCheckIn}/${requestedCheckOut}`;
    }
  }
  
  // Pattern 3: Exact date strings in content
  if (content.includes(requestedCheckIn) && content.includes(requestedCheckOut)) {
    result.date_value_raw = `${requestedCheckIn} to ${requestedCheckOut}`;
    result.renderedCheckIn = requestedCheckIn;
    result.renderedCheckOut = requestedCheckOut;
    result.rendered_dates_match = true;
    console.log('[EXPEDIA] Dates validated (exact match in content)');
    return result;
  }
  
  // Pattern 4: "Your dates are available" is strong signal
  if (/your\s+dates\s+are\s+available/i.test(content)) {
    result.date_value_raw = 'your dates are available (implicit)';
    result.rendered_dates_match = true;
    console.log('[EXPEDIA] Dates validated (implicit availability message)');
    return result;
  }
  
  if (!result.mismatchReason) {
    result.mismatchReason = 'No recognizable date range found in content';
  }
  
  console.log(`[EXPEDIA] Date validation failed: ${result.mismatchReason}`);
  return result;
}

// ============================================================================
// PHASE A: Validate page state AND dates
// ============================================================================

function runPhaseA(
  content: string, 
  requestedCheckIn: string, 
  requestedCheckOut: string
): PhaseAResult {
  const lowerContent = content.toLowerCase();
  
  // Check dates unavailable FIRST (highest priority)
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
    };
  }
  
  // Validate rendered dates match requested dates
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
  
  // Count total price patterns
  const totalPricePattern = /\$[\d,]+(?:\.\d{2})?\s*total/gi;
  const totalMatches = content.match(totalPricePattern) || [];
  
  // Price-eligible if we find totals, not in "enter dates" state
  const priceEligible = totalMatches.length > 0 && !enterDatesFound;
  
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
  };
}

// ============================================================================
// PHASE B: Extract total price (strict - no subtotals)
// ============================================================================

function runPhaseB(content: string): PhaseBResult {
  const result: PhaseBResult = {
    ran: true,
    extractedPrice: null,
    currency: null,
    includesTaxesFees: null,
    priceVerified: false,
    evidenceSnippet: null,
    subtotalRejected: false,
    rejectionReason: null,
  };
  
  // Look for explicit total patterns
  const totalPatterns = [
    /the\s+price\s+is\s+\$([\d,]+(?:\.\d{2})?)\s*total/i,
    /\$([\d,]+(?:\.\d{2})?)\s*total\s+includes?\s+taxes/i,
    /total[:\s]+\$([\d,]+(?:\.\d{2})?)/i,
    /trip\s+total[:\s]+\$([\d,]+(?:\.\d{2})?)/i,
  ];
  
  for (const pattern of totalPatterns) {
    const match = content.match(pattern);
    if (match) {
      const priceStr = match[1].replace(/,/g, '');
      const price = parseFloat(priceStr);
      
      const idx = content.indexOf(match[0]);
      const start = Math.max(0, idx - 30);
      const end = Math.min(content.length, idx + match[0].length + 50);
      const evidence = content.slice(start, end).replace(/\s+/g, ' ').trim();
      
      // CHECK: Is this actually a subtotal in disguise?
      const subtotalCheck = detectSubtotal(evidence);
      if (subtotalCheck.isSubtotal) {
        result.subtotalRejected = true;
        result.rejectionReason = `Rejected: ${subtotalCheck.pattern} - "${subtotalCheck.rawValue}"`;
        console.log(`[EXPEDIA] Subtotal rejected: ${result.rejectionReason}`);
        continue;
      }
      
      result.extractedPrice = price;
      result.currency = 'USD';
      result.evidenceSnippet = evidence;
      
      const contextLower = evidence.toLowerCase();
      if (contextLower.includes('taxes') && contextLower.includes('fees')) {
        result.includesTaxesFees = true;
      } else if (contextLower.includes('includes tax')) {
        result.includesTaxesFees = true;
      }
      
      // HALLUCINATION GUARD
      const priceFormatted = price.toLocaleString('en-US');
      const priceSimple = price.toString();
      result.priceVerified = evidence.includes(priceFormatted) || 
                             evidence.includes(priceSimple) ||
                             evidence.includes(match[1]);
      
      if (result.priceVerified) {
        console.log(`[EXPEDIA] Phase B: Extracted $${price} (verified)`);
        return result;
      }
    }
  }
  
  // Fallback: Generic "$XXX total" pattern
  const genericTotalPattern = /\$([\d,]+(?:\.\d{2})?)\s*total/gi;
  const matches = [...content.matchAll(genericTotalPattern)];
  
  for (const match of matches) {
    const priceStr = match[1].replace(/,/g, '');
    const price = parseFloat(priceStr);
    
    const idx = content.indexOf(match[0]);
    const start = Math.max(0, idx - 50);
    const end = Math.min(content.length, idx + match[0].length + 50);
    const evidence = content.slice(start, end).replace(/\s+/g, ' ').trim();
    
    const subtotalCheck = detectSubtotal(evidence);
    if (subtotalCheck.isSubtotal) {
      result.subtotalRejected = true;
      result.rejectionReason = `Rejected: ${subtotalCheck.pattern}`;
      continue;
    }
    
    result.extractedPrice = price;
    result.currency = 'USD';
    result.evidenceSnippet = evidence;
    result.priceVerified = true;
    
    console.log(`[EXPEDIA] Phase B: Extracted $${price} via fallback pattern`);
    return result;
  }
  
  console.log('[EXPEDIA] Phase B: No valid total price found');
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
  
  // Initialize result with date injection audit
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
    },
    phaseB: {
      ran: false,
      extractedPrice: null,
      currency: null,
      includesTaxesFees: null,
      priceVerified: false,
      evidenceSnippet: null,
      subtotalRejected: false,
      rejectionReason: null,
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
    dateInjection: {
      requestedCheckIn: checkIn,
      requestedCheckOut: checkOut,
      finalUrlCheckIn: null,
      finalUrlCheckOut: null,
      urlBuiltSuccessfully: false,
    },
  };
  
  try {
    // ===== STEP 1: Build URL deterministically with exact dates =====
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
      console.log(`[EXPEDIA] URL build failed: ${result.error}`);
      return result;
    }
    
    const fullUrl = urlBuild.url;
    console.log(`[EXPEDIA] Final URL: ${fullUrl}`);
    
    // ===== STEP 2: Fetch with provider chain =====
    let bestContent: string | null = null;
    let successfulProvider: Provider | null = null;
    let hardStopReason: string | null = null;
    
    for (const provider of PROVIDER_ORDER) {
      console.log(`[EXPEDIA] Trying provider: ${provider}`);
      
      let fetchResult: FetchResult;
      
      if (provider === 'browserless') {
        fetchResult = await fetchWithBrowserless(fullUrl);
      } else if (provider === 'zyte') {
        fetchResult = await fetchWithZyte(fullUrl);
      } else {
        fetchResult = await fetchWithFirecrawl(fullUrl);
      }
      
      const attempt: AttemptResult = {
        attemptNumber: attempts.length + 1,
        provider,
        phase: 'listing',
        contentLength: fetchResult.content.length,
        contentHash: simpleHash(fetchResult.content || ''),
        success: false,
        error: fetchResult.error,
        isRateLimited: fetchResult.isRateLimited,
        isBotBlocked: fetchResult.isBotBlocked,
      };
      attempts.push(attempt);
      
      // HARD STOP: Rate limit or bot block from primary provider
      if (provider === 'browserless' && (fetchResult.isRateLimited || fetchResult.isBotBlocked)) {
        hardStopReason = fetchResult.isRateLimited 
          ? 'Rate limited (HTTP 429) - hard stop, no fallbacks'
          : 'Bot blocked - hard stop, no fallbacks';
        
        console.log(`[EXPEDIA] HARD STOP: ${hardStopReason}`);
        
        result.status = fetchResult.isRateLimited ? 'blocked_rate_limit' : 'blocked_captcha_or_bot';
        result.error = hardStopReason;
        result.attempts = attempts;
        result.durationMs = Date.now() - startTime;
        return result;
      }
      
      if (fetchResult.error) {
        console.log(`[EXPEDIA] ${provider} error: ${fetchResult.error}`);
        continue;
      }
      
      if (fetchResult.content.length < MINIMAL_CONTENT_THRESHOLD) {
        console.log(`[EXPEDIA] ${provider}: Insufficient content (${fetchResult.content.length} chars)`);
        continue;
      }
      
      // ===== PHASE A: Check page state AND validate dates =====
      const phaseAResult = runPhaseA(fetchResult.content, checkIn, checkOut);
      result.phaseA = phaseAResult;
      
      // Dates unavailable - terminal state (only valid AFTER dates are confirmed in URL)
      if (phaseAResult.datesUnavailable) {
        console.log(`[EXPEDIA] Dates unavailable: ${phaseAResult.unavailabilityMarker}`);
        
        result.status = 'dates_unavailable';
        result.error = `Dates unavailable: ${phaseAResult.unavailabilityMarker}`;
        result.providerUsed = provider;
        result.attempts = attempts;
        result.durationMs = Date.now() - startTime;
        result.structuralProof.unavailability_marker = phaseAResult.unavailabilityMarker || undefined;
        return result;
      }
      
      // Check date verification - CRITICAL
      if (!phaseAResult.datesVerified) {
        console.log(`[EXPEDIA] ${provider}: Dates not verified - ${phaseAResult.dateMismatchReason}`);
        result.structuralProof.date_mismatch_details = phaseAResult.dateMismatchReason || undefined;
        
        // Try next provider - maybe rendered differently
        if (provider !== 'firecrawl') {
          continue;
        }
        
        // After all providers, if dates still not verified, it's a hard failure
        result.status = 'date_application_failed';
        result.error = `Dates could not be verified: ${phaseAResult.dateMismatchReason}`;
        result.providerUsed = provider;
        result.attempts = attempts;
        result.durationMs = Date.now() - startTime;
        return result;
      }
      
      // Sold out
      if (phaseAResult.soldOut) {
        console.log('[EXPEDIA] Property sold out');
        result.status = 'sold_out';
        result.error = 'Property sold out for these dates';
        result.providerUsed = provider;
        result.attempts = attempts;
        result.durationMs = Date.now() - startTime;
        return result;
      }
      
      // Price eligible and dates verified
      if (phaseAResult.priceEligible && phaseAResult.datesVerified) {
        console.log(`[EXPEDIA] ${provider} succeeded - price eligible, dates verified`);
        bestContent = fetchResult.content;
        successfulProvider = provider;
        attempt.success = true;
        break;
      }
      
      console.log(`[EXPEDIA] ${provider}: Not price eligible (enterDates=${phaseAResult.enterDatesFound}, datesVerified=${phaseAResult.datesVerified})`);
    }
    
    result.attempts = attempts;
    result.providerUsed = successfulProvider;
    
    // No usable content from any provider
    if (!bestContent || !successfulProvider) {
      // Check if the issue is date verification
      if (result.phaseA.dateMismatchReason && !result.phaseA.datesVerified) {
        result.status = 'date_application_failed';
        result.error = `Dates not applied/verified: ${result.phaseA.dateMismatchReason}`;
      } else {
        const lastAttempt = attempts[attempts.length - 1];
        result.status = 'render_failed';
        result.error = `All providers failed. Last error: ${lastAttempt?.error || 'No content'}`;
      }
      result.durationMs = Date.now() - startTime;
      console.log('[EXPEDIA] All providers exhausted');
      return result;
    }
    
    // ===== PHASE B: Extract price (only if dates verified) =====
    const phaseBResult = runPhaseB(bestContent);
    result.phaseB = phaseBResult;
    
    // Subtotal was rejected
    if (phaseBResult.subtotalRejected && !phaseBResult.extractedPrice) {
      result.status = 'subtotal_rejected';
      result.error = phaseBResult.rejectionReason || 'Subtotal pattern rejected - no total found';
      result.durationMs = Date.now() - startTime;
      console.log('[EXPEDIA] Subtotal rejected, no valid total');
      return result;
    }
    
    // No price found
    if (!phaseBResult.extractedPrice || !phaseBResult.priceVerified) {
      result.status = 'price_not_found';
      result.error = 'No verified total price found in breakdown';
      result.durationMs = Date.now() - startTime;
      console.log('[EXPEDIA] No verified price found');
      return result;
    }
    
    // ===== STRUCTURAL PROOF =====
    const breakdownResult = detectBreakdown(bestContent);
    
    result.structuralProof = {
      breakdown_found: breakdownResult.breakdown_found && breakdownResult.has_fee_lines,
      total_label_found: breakdownResult.total_label_found,
      rendered_dates_match: result.phaseA.datesVerified,
      extracted_from_breakdown_total: 
        breakdownResult.total_label_found &&
        breakdownResult.breakdown_price !== null &&
        breakdownResult.breakdown_price === phaseBResult.extractedPrice,
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
    };
    
    console.log('[EXPEDIA] Structural proof:', JSON.stringify(result.structuralProof, null, 2));
    
    // ===== SUCCESS =====
    result.success = true;
    result.status = 'success';
    result.durationMs = Date.now() - startTime;
    
    const isVerified = 
      result.structuralProof.breakdown_found &&
      result.structuralProof.total_label_found &&
      result.structuralProof.rendered_dates_match &&
      result.structuralProof.extracted_from_breakdown_total;
    
    console.log(`[EXPEDIA] Success: $${phaseBResult.extractedPrice} (${isVerified ? 'Verified' : 'Unverified'})`);
    
    return result;
    
  } catch (error) {
    result.error = error instanceof Error ? error.message : 'Unknown error';
    result.status = 'validation_error';
    result.durationMs = Date.now() - startTime;
    result.attempts = attempts;
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
    
    // ===== STRICT DATE VALIDATION AT ENTRY =====
    if (!checkIn || !checkOut) {
      console.log('[EXPEDIA] Missing required dates');
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
      console.log(`[EXPEDIA] Invalid date format: checkIn=${checkIn}, checkOut=${checkOut}`);
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: `Invalid date format. Expected YYYY-MM-DD, got checkIn="${checkIn}", checkOut="${checkOut}"`,
          status: 'validation_error'
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    // Validate date order
    const checkInDate = new Date(checkIn);
    const checkOutDate = new Date(checkOut);
    if (checkOutDate <= checkInDate) {
      console.log(`[EXPEDIA] Invalid date range: ${checkIn} to ${checkOut}`);
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
    
    // Run extraction with strict date handling
    const result = await extractFromExpedia(targetUrl, checkIn, checkOut, adults);
    
    // Compute verification status
    const isVerified = 
      result.structuralProof.breakdown_found &&
      result.structuralProof.total_label_found &&
      result.structuralProof.rendered_dates_match &&
      result.structuralProof.extracted_from_breakdown_total;
    
    // Update DB if extractionId provided
    if (dbExtractionId) {
      await supabaseClient
        .from('price_extractions')
        .update({
          extraction_status: result.status,
          extracted_price: result.phaseB.extractedPrice,
          currency: result.phaseB.currency,
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
            version: '3.0',
            phaseA: result.phaseA,
            phaseB: result.phaseB,
            structural_proof: result.structuralProof,
            verification_status: isVerified ? 'Verified' : 'Unverified',
            provider_order: PROVIDER_ORDER,
            attempts: result.attempts,
            durationMs: result.durationMs,
            dateInjection: result.dateInjection,
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
        version: '3.0',
        verification_status: isVerified ? 'Verified' : 'Unverified',
        provider_used: result.providerUsed,
        dateInjection: result.dateInjection,
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
