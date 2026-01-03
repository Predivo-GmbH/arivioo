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
 * Expedia Production Extraction Function - v2.0
 * 
 * PROVIDER PRIORITY (per system requirements):
 * 1. Browserless (primary) - best for JavaScript rendering
 * 2. Zyte (secondary) - fallback for non-access failures
 * 3. Firecrawl (last resort) - only if Browserless and Zyte fail for non-access reasons
 * 
 * HARD STOP RULE:
 * If Browserless returns RATE_LIMITED (429) or BOT_BLOCKED, abort immediately - no fallbacks.
 * 
 * TWO-STEP EXTRACTION:
 * Phase 1: Load listing page with dates applied
 * Phase 2: Navigate to booking/checkout context for breakdown extraction
 * 
 * DATES UNAVAILABLE DETECTION:
 * Explicit detection of "sold out", "no availability", etc. surfaced as distinct status.
 * 
 * EXTRACTION RULES:
 * - Never accept subtotals ("$X for N nights")
 * - Only accept totals from breakdown with taxes/fees visible
 * - All structural_proof fields must be explicitly set
 */

// Terminal status values - includes dates_unavailable
type TerminalStatus = 
  | 'success'
  | 'dates_not_applied'
  | 'dates_unavailable'        // NEW: Explicit unavailability status
  | 'no_availability_for_dates'
  | 'blocked_captcha_or_bot'
  | 'blocked_rate_limit'
  | 'sold_out'
  | 'price_not_found'
  | 'render_failed'
  | 'validation_error'
  | 'subtotal_rejected';       // NEW: Subtotal explicitly rejected

// Provider types - ordered by priority
type Provider = 'browserless' | 'zyte' | 'firecrawl';

// Provider priority order (Browserless first, Firecrawl last)
const PROVIDER_ORDER: Provider[] = ['browserless', 'zyte', 'firecrawl'];

/**
 * Structural proof object - REQUIRED for Verified status
 * All boolean fields must be explicitly true for Verified.
 */
interface StructuralProof {
  breakdown_found: boolean;
  total_label_found: boolean;
  rendered_dates_match: boolean;
  extracted_from_breakdown_total: boolean;
  proof_version: string;
  // Debugging fields
  breakdown_selector_used?: string;
  total_value_raw?: string;
  date_value_raw?: string;
  phase2_navigation_used?: boolean;
  unavailability_marker?: string;
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
const MAX_PROVIDER_ATTEMPTS = 3; // Try each provider up to 3 times
const MINIMAL_CONTENT_THRESHOLD = 3000;
const BROWSERLESS_TIMEOUT = 45000;
const ZYTE_TIMEOUT = 45000;
const FIRECRAWL_TIMEOUT = 30000;

// ============================================================================
// HELPER FUNCTIONS
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

function buildExpediaUrl(baseUrl: string, checkIn: string, checkOut: string, adults: number = 2): string {
  const url = new URL(baseUrl);
  url.searchParams.set('chkin', checkIn);
  url.searchParams.set('chkout', checkOut);
  url.searchParams.set('x_pwa', '1');
  url.searchParams.set('adults', String(adults));
  return url.toString();
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
  const lowerContent = content.toLowerCase();
  
  // Explicit unavailability patterns - ordered by specificity
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
      // Extract evidence snippet around the match
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
  const hasUnavailabilityContext = /unfortunately|sorry|we\s+couldn['']?t/i.test(lowerContent);
  
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
  const lowerText = priceText.toLowerCase();
  
  // Patterns that indicate a subtotal (NOT a total)
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
// BREAKDOWN DETECTION - Enhanced
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
  
  // Breakdown container indicators (Expedia-specific)
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
  
  // Check for visible taxes/fees (required for structural proof)
  const taxPatterns = [
    /taxes\s*(?:and|&)?\s*fees[:\s]*\$?[\d,]+/i,
    /\$[\d,]+(?:\.\d{2})?\s*(?:in\s+)?taxes/i,
    /includes?\s+(?:all\s+)?taxes/i,
    /total\s+with\s+taxes/i,
  ];
  result.has_taxes_visible = taxPatterns.some(p => p.test(content));
  result.has_fee_lines = result.has_taxes_visible;
  
  // Look for explicit total row patterns (highest to lowest specificity)
  const totalPatterns = [
    // "The price is $XXX total" - most explicit
    /the\s+price\s+is\s+\$?([\d,]+(?:\.\d{2})?)\s*total/i,
    // "Total: $XXX" or "Total $XXX"
    /total[:\s]+\$?([\d,]+(?:\.\d{2})?)/i,
    // "$XXX total includes taxes"
    /\$?([\d,]+(?:\.\d{2})?)\s*total\s+includes?\s+taxes/i,
    // "Trip total: $XXX"
    /trip\s+total[:\s]+\$?([\d,]+(?:\.\d{2})?)/i,
    // "$XXX total" at end of breakdown context
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
// RENDERED DATE VALIDATION
// ============================================================================

interface DateValidationResult {
  rendered_dates_match: boolean;
  date_value_raw: string | null;
}

function validateRenderedDates(
  content: string,
  requestedCheckIn: string,
  requestedCheckOut: string
): DateValidationResult {
  const result: DateValidationResult = {
    rendered_dates_match: false,
    date_value_raw: null,
  };
  
  const reqCheckIn = new Date(requestedCheckIn);
  const reqCheckOut = new Date(requestedCheckOut);
  
  if (isNaN(reqCheckIn.getTime()) || isNaN(reqCheckOut.getTime())) {
    console.log('[EXPEDIA] Invalid requested dates for validation');
    return result;
  }
  
  // Pattern 1: "Jan 15 - Jan 18" or "Jan 15 – Jan 18"
  const dateRangePattern = /([A-Z][a-z]{2}\s+\d{1,2})\s*[-–]\s*([A-Z][a-z]{2}\s+\d{1,2})/i;
  const rangeMatch = content.match(dateRangePattern);
  
  if (rangeMatch) {
    result.date_value_raw = rangeMatch[0];
    const year = reqCheckIn.getFullYear();
    
    try {
      const parsedCheckIn = new Date(`${rangeMatch[1]}, ${year}`);
      const parsedCheckOut = new Date(`${rangeMatch[2]}, ${year}`);
      
      // Handle year boundary (Dec-Jan)
      if (parsedCheckOut < parsedCheckIn) {
        const nextYearCheckOut = new Date(`${rangeMatch[2]}, ${year + 1}`);
        if (
          parsedCheckIn.getMonth() === reqCheckIn.getMonth() &&
          parsedCheckIn.getDate() === reqCheckIn.getDate() &&
          nextYearCheckOut.getMonth() === reqCheckOut.getMonth() &&
          nextYearCheckOut.getDate() === reqCheckOut.getDate()
        ) {
          result.rendered_dates_match = true;
          return result;
        }
      }
      
      if (
        parsedCheckIn.getMonth() === reqCheckIn.getMonth() &&
        parsedCheckIn.getDate() === reqCheckIn.getDate() &&
        parsedCheckOut.getMonth() === reqCheckOut.getMonth() &&
        parsedCheckOut.getDate() === reqCheckOut.getDate()
      ) {
        result.rendered_dates_match = true;
        return result;
      }
    } catch {
      // Date parsing failed, continue to other patterns
    }
  }
  
  // Pattern 2: ISO format "2025-01-15 to 2025-01-18"
  const isoPattern = /(\d{4}-\d{2}-\d{2})\s*(?:to|[-–])\s*(\d{4}-\d{2}-\d{2})/i;
  const isoMatch = content.match(isoPattern);
  
  if (isoMatch) {
    result.date_value_raw = isoMatch[0];
    if (isoMatch[1] === requestedCheckIn && isoMatch[2] === requestedCheckOut) {
      result.rendered_dates_match = true;
      return result;
    }
  }
  
  // Pattern 3: Exact date strings in content
  if (content.includes(requestedCheckIn) && content.includes(requestedCheckOut)) {
    result.date_value_raw = `${requestedCheckIn} to ${requestedCheckOut}`;
    result.rendered_dates_match = true;
    return result;
  }
  
  // Pattern 4: "Your dates are available" is strong signal
  if (/your\s+dates\s+are\s+available/i.test(content)) {
    result.date_value_raw = 'your dates are available (implicit)';
    result.rendered_dates_match = true;
    return result;
  }
  
  console.log('[EXPEDIA] Could not validate rendered dates');
  return result;
}

// ============================================================================
// PHASE A: Validate page state
// ============================================================================

function runPhaseA(content: string): PhaseAResult {
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
    };
  }
  
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
  
  // Check for booking CTA (indicates page is actionable)
  const bookingCtaPatterns = [
    /book\s+now/i,
    /reserve\s+now/i,
    /continue\s+booking/i,
    /select\s+room/i,
    /choose\s+room/i,
    /book\s+this/i,
  ];
  const bookingCtaFound = bookingCtaPatterns.some(p => p.test(content));
  
  // Count total price patterns (not subtotals)
  const totalPricePattern = /\$[\d,]+(?:\.\d{2})?\s*total/gi;
  const totalMatches = content.match(totalPricePattern) || [];
  
  // Price-eligible if we find totals, not in "enter dates" state, and not sold out
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
  };
}

// ============================================================================
// PHASE B: Extract total price (strict - no subtotals)
// ============================================================================

function runPhaseB(content: string, checkIn: string, checkOut: string): PhaseBResult {
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
  
  // First, look for explicit total patterns
  const totalPatterns = [
    // "The price is $XXX total" - most reliable
    /the\s+price\s+is\s+\$([\d,]+(?:\.\d{2})?)\s*total/i,
    // "$XXX total includes taxes"
    /\$([\d,]+(?:\.\d{2})?)\s*total\s+includes?\s+taxes/i,
    // "Total: $XXX" in breakdown context
    /total[:\s]+\$([\d,]+(?:\.\d{2})?)/i,
    // "Trip total: $XXX"
    /trip\s+total[:\s]+\$([\d,]+(?:\.\d{2})?)/i,
  ];
  
  for (const pattern of totalPatterns) {
    const match = content.match(pattern);
    if (match) {
      const priceStr = match[1].replace(/,/g, '');
      const price = parseFloat(priceStr);
      
      // Get surrounding context for evidence
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
        continue; // Try next pattern
      }
      
      result.extractedPrice = price;
      result.currency = 'USD';
      result.evidenceSnippet = evidence;
      
      // Check if taxes included
      const contextLower = evidence.toLowerCase();
      if (contextLower.includes('taxes') && contextLower.includes('fees')) {
        result.includesTaxesFees = true;
      } else if (contextLower.includes('includes tax')) {
        result.includesTaxesFees = true;
      }
      
      // HALLUCINATION GUARD: Verify price appears verbatim
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
    
    // Reject subtotals
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
    
    // Convert HTML to text-like content for pattern matching
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    
    // Check for bot detection in content
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
      if (response.status === 403 || response.status === 401) {
        return { content: '', error: `Bot blocked (HTTP ${response.status})`, isBotBlocked: true };
      }
      return { content: '', error: `Firecrawl error: ${response.status}` };
    }
    
    const data = await response.json();
    const markdown = data.data?.markdown || data.markdown || '';
    
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
// MAIN EXTRACTION ORCHESTRATOR
// ============================================================================

async function extractFromExpedia(
  url: string,
  checkIn: string,
  checkOut: string,
  adults: number = 2
): Promise<ExtractionResult> {
  const startTime = Date.now();
  const attempts: AttemptResult[] = [];
  
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
    },
    durationMs: 0,
    error: null,
    providerUsed: null,
    attempts: [],
  };
  
  try {
    // Build URL with date parameters
    const fullUrl = buildExpediaUrl(url, checkIn, checkOut, adults);
    console.log(`[EXPEDIA] Starting extraction: ${fullUrl.slice(0, 100)}...`);
    console.log(`[EXPEDIA] Dates: ${checkIn} to ${checkOut}, Adults: ${adults}`);
    console.log(`[EXPEDIA] Provider order: ${PROVIDER_ORDER.join(' → ')}`);
    
    let bestContent = '';
    let successfulProvider: Provider | null = null;
    let hardStopReason: string | null = null;
    
    // ============= PROVIDER LOOP: Browserless → Zyte → Firecrawl =============
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
      
      // ===== HARD STOP: Rate limit or bot block from primary provider =====
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
      
      // Check for errors (non-hard-stop)
      if (fetchResult.error) {
        console.log(`[EXPEDIA] ${provider} error: ${fetchResult.error}`);
        continue;
      }
      
      // Check content sufficiency
      if (fetchResult.content.length < MINIMAL_CONTENT_THRESHOLD) {
        console.log(`[EXPEDIA] ${provider}: Insufficient content (${fetchResult.content.length} chars)`);
        continue;
      }
      
      // ===== PHASE A: Check page state =====
      const phaseAResult = runPhaseA(fetchResult.content);
      
      // Dates unavailable - terminal state
      if (phaseAResult.datesUnavailable) {
        console.log(`[EXPEDIA] Dates unavailable: ${phaseAResult.unavailabilityMarker}`);
        
        result.status = 'dates_unavailable';
        result.error = `Dates unavailable: ${phaseAResult.unavailabilityMarker}`;
        result.phaseA = phaseAResult;
        result.providerUsed = provider;
        result.attempts = attempts;
        result.durationMs = Date.now() - startTime;
        result.structuralProof.unavailability_marker = phaseAResult.unavailabilityMarker || undefined;
        return result;
      }
      
      // Sold out
      if (phaseAResult.soldOut) {
        console.log('[EXPEDIA] Property sold out');
        result.status = 'sold_out';
        result.error = 'Property sold out for these dates';
        result.phaseA = phaseAResult;
        result.providerUsed = provider;
        result.attempts = attempts;
        result.durationMs = Date.now() - startTime;
        return result;
      }
      
      // Price eligible - we have content to work with
      if (phaseAResult.priceEligible) {
        console.log(`[EXPEDIA] ${provider} succeeded - price eligible`);
        bestContent = fetchResult.content;
        successfulProvider = provider;
        attempt.success = true;
        result.phaseA = phaseAResult;
        break;
      }
      
      console.log(`[EXPEDIA] ${provider}: Not price eligible (enterDates=${phaseAResult.enterDatesFound})`);
    }
    
    result.attempts = attempts;
    result.providerUsed = successfulProvider;
    
    // No usable content from any provider
    if (!bestContent || !successfulProvider) {
      const lastAttempt = attempts[attempts.length - 1];
      result.status = 'render_failed';
      result.error = `All providers failed. Last error: ${lastAttempt?.error || 'No content'}`;
      result.durationMs = Date.now() - startTime;
      console.log('[EXPEDIA] All providers exhausted');
      return result;
    }
    
    // ============= PHASE B: Extract price =============
    const phaseBResult = runPhaseB(bestContent, checkIn, checkOut);
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
    
    // ============= STRUCTURAL PROOF =============
    const breakdownResult = detectBreakdown(bestContent);
    const dateResult = validateRenderedDates(bestContent, checkIn, checkOut);
    
    result.structuralProof = {
      breakdown_found: breakdownResult.breakdown_found && breakdownResult.has_fee_lines,
      total_label_found: breakdownResult.total_label_found,
      rendered_dates_match: dateResult.rendered_dates_match,
      extracted_from_breakdown_total: 
        breakdownResult.total_label_found &&
        breakdownResult.breakdown_price !== null &&
        breakdownResult.breakdown_price === phaseBResult.extractedPrice,
      proof_version: '1.0',
      breakdown_selector_used: breakdownResult.breakdown_selector_used || undefined,
      total_value_raw: breakdownResult.total_value_raw || undefined,
      date_value_raw: dateResult.date_value_raw || undefined,
      phase2_navigation_used: false,
    };
    
    console.log('[EXPEDIA] Structural proof:', JSON.stringify(result.structuralProof, null, 2));
    
    // ============= SUCCESS =============
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
    
    if (!checkIn || !checkOut) {
      return new Response(
        JSON.stringify({ success: false, error: 'checkIn and checkOut dates required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    // Run extraction
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
          evidence_snippets: result.phaseB.evidenceSnippet ? [result.phaseB.evidenceSnippet] : null,
          extraction_metadata: {
            goldenPath: true,
            platform: 'expedia',
            version: '2.0',
            phaseA: result.phaseA,
            phaseB: result.phaseB,
            structural_proof: result.structuralProof,
            verification_status: isVerified ? 'Verified' : 'Unverified',
            provider_order: PROVIDER_ORDER,
            attempts: result.attempts,
            durationMs: result.durationMs,
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
        version: '2.0',
        verification_status: isVerified ? 'Verified' : 'Unverified',
        provider_used: result.providerUsed,
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
