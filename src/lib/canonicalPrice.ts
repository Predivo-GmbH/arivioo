/**
 * Canonical Price Model
 * 
 * Platform-agnostic price extraction model and strict comparison rules.
 * This module defines:
 * - CanonicalPrice: The single source of truth for price representation
 * - Normalization: Converting platform-specific extraction outputs to canonical form
 * - Comparison: Strict rules for determining if two prices are comparable
 * 
 * === CORE INVARIANTS ===
 * 1. Never populate total_price unless explicitly proven or correctly derived
 * 2. Subtotal-only prices cannot be used for "cheaper" claims
 * 3. Nightly rates cannot be used for "cheaper" claims without verified derivation
 * 4. Same currency required for comparison (no silent conversions)
 * 5. Same date range required for comparison
 * 
 * @module canonicalPrice
 */

// ============================================
// ENUMS AND TYPES
// ============================================

/**
 * What the price represents semantically
 */
export type PriceType =
  | 'total_proven'      // Total verified via structural proof (breakdown, taxes included)
  | 'total_derived'     // Total calculated from components with explicit derivation
  | 'subtotal_nights_only' // Sum of nightly rates without fees/taxes
  | 'nightly_only'      // Single night rate (no stay total available)
  | 'unknown';          // Cannot determine what this price represents

/**
 * How the price was obtained
 */
export type ExtractionMethod =
  | 'dom'          // Extracted from DOM structure (selectors, text content)
  | 'visual_ocr'   // Extracted via visual OCR from screenshots
  | 'api'          // Retrieved from platform API
  | 'derived'      // Calculated from other extracted values
  | 'scraped'      // Scraped from search results (not verified)
  | 'user_input'   // Manually entered by user
  | 'unknown';

/**
 * Confidence level in the extraction
 */
export type ConfidenceLevel = 'high' | 'medium' | 'low';

/**
 * Structural verification proof from the extractor
 */
export interface StructuralProof {
  breakdown_found: boolean | null;
  total_label_found: boolean | null;
  rendered_dates_match: boolean | null;
  extracted_from_breakdown_total: boolean | null;
  breakdown_selector_used?: string | null;
  total_value_raw?: string | null;
  date_value_raw?: string | null;
}

/**
 * Fee breakdown components (all optional, in cents or smallest currency unit)
 */
export interface FeeBreakdown {
  cleaning_fee?: number | null;
  service_fee?: number | null;
  platform_fee?: number | null;
  other_fees?: number | null;
  fee_labels?: string[];
}

/**
 * Derivation path for computed prices
 * Documents how a total was calculated from components
 */
export interface DerivationPath {
  formula: string;  // e.g., "nightly_rate * nights + fees_total + taxes_total"
  inputs: Record<string, number | null>;
  computed_at: string;
}

// ============================================
// CANONICAL PRICE SCHEMA
// ============================================

/**
 * The canonical, platform-agnostic price object.
 * Used everywhere: storage, API responses, UI rendering, ranking.
 */
export interface CanonicalPrice {
  // === IDENTITY AND CONTEXT ===
  platform_id: string;           // Platform identifier (e.g., "expedia.com", "booking.com")
  source_url: string;            // The URL from which the price was extracted
  check_in_date: string | null;  // ISO date string (YYYY-MM-DD)
  check_out_date: string | null; // ISO date string (YYYY-MM-DD)
  nights_count: number | null;   // Number of nights for this price
  currency: string;              // ISO 4217 currency code (e.g., "USD", "EUR")
  
  // Occupancy (optional)
  guests?: number | null;
  adults?: number | null;
  children?: number | null;
  rooms?: number | null;
  
  // === PRICE COMPONENTS (all nullable) ===
  nightly_rate: number | null;       // Per-night rate
  subtotal_nights: number | null;    // nightly_rate * nights (before fees/taxes)
  fees_total: number | null;         // Sum of all fees
  fees_breakdown?: FeeBreakdown;     // Optional detailed fee breakdown
  taxes_total: number | null;        // Sum of all taxes
  total_price: number | null;        // Grand total (subtotal + fees + taxes)
  
  // === SEMANTICS AND PROVENANCE ===
  price_type: PriceType;
  extraction_method: ExtractionMethod;
  confidence: ConfidenceLevel;
  
  // Evidence and provenance
  evidence_snippet?: string | null;  // Short text proving the price
  structural_proof?: StructuralProof;
  derivation_path?: DerivationPath;  // If price_type is 'total_derived'
  
  // Metadata
  extracted_at: string;              // ISO timestamp
  extractor_version?: string;
  page_content_hash?: string;
  
  // === COMPARISON FLAGS ===
  is_comparable: boolean;            // Pre-computed: can this be used for comparisons?
  comparability_failures: string[];  // Reasons why not comparable (if any)
}

// ============================================
// NORMALIZATION FUNCTIONS
// ============================================

/**
 * Input from price_extractions table or API response
 */
export interface ExtractionInput {
  platform_name: string;
  deep_link: string;
  extracted_price: number | null;
  currency: string | null;
  includes_taxes_fees: boolean | null;
  dates_validated: boolean | null;
  detected_checkin: string | null;
  detected_checkout: string | null;
  confidence_score: number | null;
  extraction_status: string | null;
  extraction_metadata?: Record<string, any> | null;
  evidence_snippets?: string[] | null;
  price_type?: string | null;
  updated_at?: string | null;
  
  // Context from search
  requested_check_in?: string | null;
  requested_check_out?: string | null;
  requested_nights?: number | null;
  requested_currency?: string | null;
}

/**
 * Parse numeric values safely
 */
function parsePrice(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && !isNaN(value) && value > 0) return value;
  if (typeof value === 'string') {
    const cleaned = value.replace(/[^0-9.,-]/g, '').replace(',', '.');
    const parsed = parseFloat(cleaned);
    return !isNaN(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

/**
 * Map confidence score (0-1) to confidence level
 * IMPORTANT: null confidence with structural proof should NOT be treated as 'low'
 * That case will be handled separately by checking structural verification
 */
function mapConfidence(score: number | null, hasStructuralVerification: boolean = false): ConfidenceLevel {
  // If structural verification exists but no numeric score, treat as medium (not low)
  if (score === null) {
    return hasStructuralVerification ? 'medium' : 'low';
  }
  if (score < 0.3) return 'low';
  if (score < 0.7) return 'medium';
  return 'high';
}

/**
 * Check if structural proof exists in any of the nested metadata locations
 * Extractors may store proof in different nested structures
 * 
 * EXPEDIA-SPECIFIC: The extract-expedia golden path returns:
 * - structuralProof.breakdown_found, structuralProof.total_label_found, etc.
 * - verification: "VERIFIED" or "PARTIAL"
 * - semantic: "pass" or "fail"
 * - offersPage metadata
 */
function hasVerifiedStructuralProof(metadata: Record<string, any> | null): boolean {
  if (!metadata) return false;
  
  // Check for verification: "VERIFIED" (case insensitive) - used by both Expedia and VRBO
  // This is the primary signal from golden path extractors
  const verification = metadata.verification || metadata.structuralProof?.verification || '';
  if (typeof verification === 'string' && verification.toUpperCase() === 'VERIFIED') {
    return true;
  }
  
  // Check top-level fields
  const topLevel = 
    metadata.breakdown_found === true &&
    metadata.total_label_found === true &&
    metadata.extracted_from_breakdown_total === true;
  if (topLevel) return true;
  
  // Check nested structuralProof object (Expedia and VRBO golden paths use this)
  const structuralProof = metadata.structuralProof || metadata.structural_proof || {};
  
  // VRBO-SPECIFIC: VRBO uses checkout_session_reached + total_label_found as proof
  // When VRBO reaches checkout and finds a total label, that's verified
  const vrboProof = 
    structuralProof.checkout_session_reached === true &&
    structuralProof.total_label_found === true &&
    structuralProof.dates_visible_on_page === true;
  if (vrboProof) return true;
  
  // Expedia nested proof pattern
  const nestedProof = 
    structuralProof.breakdown_found === true &&
    (structuralProof.total_label_found === true || structuralProof.hasTotalWithTaxes === true) &&
    (structuralProof.extracted_from_breakdown_total === true || structuralProof.extracted_from_target_card === true);
  if (nestedProof) return true;
  
  // Check offersPage object (also used by Expedia)
  const offersPage = metadata.offersPage || {};
  const offersProof = 
    offersPage.hasOfferCards === true &&
    offersPage.hasTotalWithTaxes === true &&
    offersPage.datesRenderedCorrectly === true;
  if (offersProof) return true;
  
  // Check semantic pass as additional verification
  // If semantic: "pass" and extraction was successful, trust it
  const semantic = metadata.semantic || '';
  if (typeof semantic === 'string' && semantic.toLowerCase() === 'pass') {
    return true;
  }
  
  return false;
}

/**
 * Check if this is an Expedia extraction based on platform name
 */
function isExpediaPlatform(platformName: string): boolean {
  const lower = platformName.toLowerCase();
  return lower.includes('expedia');
}

/**
 * Determine price type from extraction metadata and flags
 * CRITICAL: This determines whether we have a comparable total or just a partial price
 * Price type must be derived from WHAT was found (total vs subtotal), NOT from confidence
 * 
 * EXPEDIA-SPECIFIC: The golden path extractor returns verification: "VERIFIED" and
 * semantic: "pass" when it successfully extracts a total with taxes and fees.
 */
function determinePriceType(input: ExtractionInput): PriceType {
  const metadata = input.extraction_metadata || {};
  const isExpedia = isExpediaPlatform(input.platform_name);
  
  // Explicit price_type from extractor takes priority
  if (input.price_type) {
    const explicit = input.price_type.toLowerCase();
    if (explicit.includes('total') && (explicit.includes('proven') || explicit.includes('verified'))) {
      return 'total_proven';
    }
    if (explicit.includes('total') && explicit.includes('derived')) {
      return 'total_derived';
    }
    if (explicit.includes('subtotal') || explicit.includes('nights_only')) {
      return 'subtotal_nights_only';
    }
    if (explicit.includes('nightly') || explicit.includes('per_night')) {
      return 'nightly_only';
    }
  }
  
  // EXPEDIA-SPECIFIC: Check for verification: "VERIFIED" with semantic: "pass"
  // This is the definitive signal from extract-expedia golden path
  if (isExpedia) {
    const verification = metadata.verification || metadata.structuralProof?.verification || '';
    const semantic = metadata.semantic || '';
    
    if (
      typeof verification === 'string' && 
      verification.toUpperCase() === 'VERIFIED' &&
      input.includes_taxes_fees === true &&
      input.dates_validated === true
    ) {
      return 'total_proven';
    }
    
    // Also accept semantic: "pass" with taxes/fees for Expedia
    if (
      typeof semantic === 'string' &&
      semantic.toLowerCase() === 'pass' &&
      input.includes_taxes_fees === true &&
      input.dates_validated === true &&
      input.extraction_status === 'success'
    ) {
      return 'total_proven';
    }
  }
  
  // Check for verified structural proof from any nested location
  const hasStructural = hasVerifiedStructuralProof(metadata);
  
  // If structural proof exists with taxes/fees and dates validated, it's a proven total
  if (hasStructural && input.includes_taxes_fees === true && input.dates_validated === true) {
    return 'total_proven';
  }
  
  // Check evidence snippets for "total with taxes and fees" patterns
  const evidenceSnippets = input.evidence_snippets || [];
  const evidenceText = evidenceSnippets.join(' ').toLowerCase();
  const hasTotalEvidence = 
    evidenceText.includes('total (with taxes') ||
    evidenceText.includes('total with taxes') ||
    evidenceText.includes('including taxes') ||
    evidenceText.includes('taxes and fees');
  
  // Evidence of "total with taxes" + dates validated + taxes included = proven total
  if (hasTotalEvidence && input.dates_validated === true && input.includes_taxes_fees === true) {
    return 'total_proven';
  }
  
  // Check offersPage semantic signals (Expedia golden path)
  const offersPage = metadata.offersPage || {};
  if (offersPage.hasTotalWithTaxes === true && 
      offersPage.datesRenderedCorrectly === true && 
      input.includes_taxes_fees === true) {
    return 'total_proven';
  }
  
  // Check if this looks like a derived total
  if (metadata.derivation_path || metadata.computed_total) {
    return 'total_derived';
  }
  
  // Check if taxes/fees are included with successful extraction
  // This indicates a total was found, though we can't prove it structurally
  if (input.includes_taxes_fees === true && input.dates_validated === true) {
    // VRBO uses 'success_total_stay' as its golden path success status
    const successStatuses = ['success', 'price_extracted', 'completed', 'success_total_stay'];
    if (input.extraction_status && successStatuses.includes(input.extraction_status)) {
      // If we have structural verification, it's proven; otherwise derived
      return hasVerifiedStructuralProof(input.extraction_metadata || null) ? 'total_proven' : 'total_derived';
    }
  }
  
  // If we only have nightly rate indicators
  if (metadata.is_nightly_rate === true || metadata.price_per_night) {
    return 'nightly_only';
  }
  
  // If taxes/fees explicitly not included
  if (input.includes_taxes_fees === false) {
    return 'subtotal_nights_only';
  }
  
  return 'unknown';
}

/**
 * Determine extraction method from metadata
 */
function determineExtractionMethod(input: ExtractionInput): ExtractionMethod {
  const metadata = input.extraction_metadata || {};
  
  if (metadata.extraction_method) {
    const method = String(metadata.extraction_method).toLowerCase();
    if (method.includes('ocr') || method.includes('visual')) return 'visual_ocr';
    if (method.includes('api')) return 'api';
    if (method.includes('derived') || method.includes('computed')) return 'derived';
    if (method.includes('scrape')) return 'scraped';
    if (method.includes('user')) return 'user_input';
  }
  
  // Infer from evidence
  if (metadata.ocr_used === true || metadata.screenshot_extracted === true) {
    return 'visual_ocr';
  }
  
  if (metadata.api_response || metadata.from_api === true) {
    return 'api';
  }
  
  // Default to DOM extraction if we have selector info
  if (metadata.selector_used || metadata.breakdown_selector_used) {
    return 'dom';
  }
  
  // Check extraction status
  if (input.extraction_status === 'success' || input.extraction_status === 'price_extracted') {
    return 'dom';
  }
  
  return 'unknown';
}

/**
 * Extract structural proof from metadata
 */
function extractStructuralProof(metadata: Record<string, any> | null): StructuralProof {
  if (!metadata) {
    return {
      breakdown_found: null,
      total_label_found: null,
      rendered_dates_match: null,
      extracted_from_breakdown_total: null,
    };
  }
  
  // Check nested structuralProof object first
  const proof = metadata.structuralProof || metadata.structural_proof || {};
  const offersPage = metadata.offersPage || {};
  
  // VRBO uses checkout_session_reached as proof of reaching the breakdown
  // Also uses dates_visible_on_page for date matching
  const vrboCheckoutReached = proof.checkout_session_reached === true;
  const vrboDatesVisible = proof.dates_visible_on_page === true;
  
  return {
    breakdown_found: metadata.breakdown_found ?? proof.breakdown_found ?? offersPage.hasOfferCards ?? vrboCheckoutReached ?? null,
    total_label_found: metadata.total_label_found ?? proof.total_label_found ?? offersPage.hasTotalWithTaxes ?? null,
    rendered_dates_match: metadata.rendered_dates_match ?? proof.rendered_dates_match ?? metadata.dates_matched ?? vrboDatesVisible ?? null,
    extracted_from_breakdown_total: metadata.extracted_from_breakdown_total ?? proof.extracted_from_breakdown_total ?? vrboCheckoutReached ?? null,
    breakdown_selector_used: metadata.breakdown_selector_used ?? proof.breakdown_selector_used ?? null,
    total_value_raw: metadata.total_value_raw ?? proof.total_value_raw ?? null,
    date_value_raw: metadata.date_value_raw ?? proof.date_value_raw ?? null,
  };
}

/**
 * Calculate nights between two dates
 */
function calculateNights(checkIn: string, checkOut: string): number | null {
  try {
    const start = new Date(checkIn);
    const end = new Date(checkOut);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) return null;
    const diffMs = end.getTime() - start.getTime();
    const nights = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    return nights > 0 ? nights : null;
  } catch {
    return null;
  }
}

/**
 * Normalize an extraction input to a CanonicalPrice
 */
export function normalizeExtraction(input: ExtractionInput): CanonicalPrice {
  const metadata = input.extraction_metadata || {};
  
  // Determine check-in/out dates (prefer detected, fall back to requested)
  const checkIn = input.detected_checkin || input.requested_check_in || null;
  const checkOut = input.detected_checkout || input.requested_check_out || null;
  
  // Calculate nights
  const nights = input.requested_nights || 
    (checkIn && checkOut ? calculateNights(checkIn, checkOut) : null);
  
  // Determine currency
  const currency = input.currency || input.requested_currency || 'USD';
  
  // Parse price components from metadata if available
  const nightlyRate = parsePrice(metadata.nightly_rate || metadata.price_per_night);
  const subtotalNights = parsePrice(metadata.subtotal_nights || metadata.nights_subtotal);
  const feesTotal = parsePrice(metadata.fees_total || metadata.total_fees);
  const taxesTotal = parsePrice(metadata.taxes_total || metadata.total_taxes);
  
  // Determine price type
  const priceType = determinePriceType(input);
  
  // Get the main extracted price
  let totalPrice: number | null = null;
  const extractedPrice = parsePrice(input.extracted_price);
  
  // Only set total_price if it's actually a total
  if (priceType === 'total_proven' || priceType === 'total_derived') {
    totalPrice = extractedPrice;
  }
  
  // Compute subtotal from nightly rate if needed
  let computedSubtotal = subtotalNights;
  if (!computedSubtotal && nightlyRate && nights) {
    computedSubtotal = nightlyRate * nights;
  }
  
  // If price type is subtotal_nights_only, the extracted price IS the subtotal
  if (priceType === 'subtotal_nights_only' && !computedSubtotal) {
    computedSubtotal = extractedPrice;
  }
  
  // Structural proof
  const structuralProof = extractStructuralProof(metadata);
  
  // Evidence
  const evidenceSnippet = input.evidence_snippets && input.evidence_snippets.length > 0
    ? input.evidence_snippets[0]
    : (metadata.evidence_snippet || null);
  
  // Check for structural verification to adjust confidence mapping
  const hasStructural = hasVerifiedStructuralProof(metadata);
  
  // Confidence - if structural proof exists but no score, don't penalize
  const confidence = mapConfidence(input.confidence_score, hasStructural);
  
  // Pre-compute comparability
  const { isComparable, failures } = computeComparability({
    priceType,
    totalPrice,
    currency,
    checkIn,
    checkOut,
    nights,
    extractionStatus: input.extraction_status,
    datesValidated: input.dates_validated,
    includesTaxesFees: input.includes_taxes_fees,
    confidence,
    structuralProof,
  });
  
  return {
    platform_id: input.platform_name.toLowerCase().replace(/\s+/g, '_'),
    source_url: input.deep_link,
    check_in_date: checkIn,
    check_out_date: checkOut,
    nights_count: nights,
    currency,
    
    // Occupancy
    guests: metadata.guests || metadata.occupancy || null,
    adults: metadata.adults || null,
    children: metadata.children || null,
    rooms: metadata.rooms || null,
    
    // Price components
    nightly_rate: nightlyRate,
    subtotal_nights: computedSubtotal,
    fees_total: feesTotal,
    taxes_total: taxesTotal,
    total_price: totalPrice,
    
    // Semantics
    price_type: priceType,
    extraction_method: determineExtractionMethod(input),
    confidence,
    
    // Evidence
    evidence_snippet: evidenceSnippet,
    structural_proof: structuralProof,
    
    // Metadata
    extracted_at: input.updated_at || new Date().toISOString(),
    extractor_version: metadata.extractor_version || undefined,
    page_content_hash: metadata.page_content_hash || undefined,
    
    // Comparability
    is_comparable: isComparable,
    comparability_failures: failures,
  };
}

// ============================================
// COMPARISON AND RANKING LOGIC
// ============================================

interface ComparabilityInput {
  priceType: PriceType;
  totalPrice: number | null;
  currency: string;
  checkIn: string | null;
  checkOut: string | null;
  nights: number | null;
  extractionStatus: string | null;
  datesValidated: boolean | null;
  includesTaxesFees: boolean | null;
  confidence: ConfidenceLevel;
  structuralProof: StructuralProof;
}

/**
 * Compute whether a price is eligible for comparison
 * Returns reasons for any failures
 */
function computeComparability(input: ComparabilityInput): { isComparable: boolean; failures: string[] } {
  const failures: string[] = [];
  
  // Rule 1: Must have a total price
  if (input.totalPrice === null || input.totalPrice <= 0) {
    failures.push('no_total_price');
  }
  
  // Rule 2: Price type must be total_proven or total_derived
  if (input.priceType !== 'total_proven' && input.priceType !== 'total_derived') {
    failures.push('price_type_not_total');
  }
  
  // Rule 3: Dates must be validated
  if (input.datesValidated !== true) {
    failures.push('dates_not_validated');
  }
  
  // Rule 4: Must have nights count
  if (!input.nights || input.nights <= 0) {
    failures.push('nights_count_missing');
  }
  
  // Rule 5: Currency must be known
  if (!input.currency) {
    failures.push('currency_unknown');
  }
  
  // Rule 6: Extraction must have succeeded
  const successStatuses = ['success', 'price_extracted', 'completed'];
  if (!input.extractionStatus || !successStatuses.includes(input.extractionStatus)) {
    failures.push('extraction_not_successful');
  }
  
  // Rule 7: Low confidence prices add a warning but do NOT block comparison
  // when we have a proven total (structural proof verified).
  // CRITICAL: Price type is derived from WHAT was found, not confidence.
  // Low confidence is a signal for "recommend manual check", not a blocker.
  // If price_type is total_proven, structural verification already passed.
  const hasStructuralVerification = 
    input.structuralProof.breakdown_found === true &&
    (input.structuralProof.total_label_found === true || input.structuralProof.extracted_from_breakdown_total === true);
  
  // Only block on low confidence if we DON'T have structural verification
  // A total_proven price type implies structural verification was successful
  if (input.confidence === 'low' && input.priceType !== 'total_proven' && !hasStructuralVerification) {
    failures.push('low_confidence');
  }
  
  // Rule 8: Must include taxes/fees for accurate comparison
  if (input.includesTaxesFees !== true) {
    failures.push('taxes_fees_not_included');
  }
  
  return {
    isComparable: failures.length === 0,
    failures,
  };
}

/**
 * Compare two canonical prices for savings calculation
 * Returns comparison result with strict validation
 */
export interface PriceComparisonResult {
  is_comparable: boolean;
  comparison_failures: string[];
  
  // Only populated if is_comparable === true
  price_difference: number | null;      // positive = alternative is cheaper
  savings_percentage: number | null;
  is_cheaper: boolean | null;
  
  // Debug info
  baseline_total: number | null;
  alternative_total: number | null;
}

/**
 * Compare an alternative price against a baseline (Airbnb) price
 * Enforces strict comparability rules
 */
export function comparePrices(
  baseline: CanonicalPrice,
  alternative: CanonicalPrice
): PriceComparisonResult {
  const failures: string[] = [];
  
  // Rule 1: Both must be individually comparable
  if (!baseline.is_comparable) {
    failures.push('baseline_not_comparable');
  }
  if (!alternative.is_comparable) {
    failures.push('alternative_not_comparable');
  }
  
  // Rule 2: Same currency (no silent conversions)
  if (baseline.currency !== alternative.currency) {
    failures.push('currency_mismatch');
  }
  
  // Rule 3: Same night count (same stay duration)
  if (baseline.nights_count !== alternative.nights_count) {
    failures.push('nights_count_mismatch');
  }
  
  // Rule 4: Same date range
  if (baseline.check_in_date !== alternative.check_in_date ||
      baseline.check_out_date !== alternative.check_out_date) {
    failures.push('date_range_mismatch');
  }
  
  // Rule 5: Both must have total prices
  if (baseline.total_price === null || alternative.total_price === null) {
    failures.push('missing_total_price');
  }
  
  // Rule 6: Price types must be comparable (both must be totals)
  const comparableTypes: PriceType[] = ['total_proven', 'total_derived'];
  if (!comparableTypes.includes(baseline.price_type) || 
      !comparableTypes.includes(alternative.price_type)) {
    failures.push('incompatible_price_types');
  }
  
  // If not comparable, return with failures
  if (failures.length > 0 || baseline.total_price === null || alternative.total_price === null) {
    return {
      is_comparable: false,
      comparison_failures: failures,
      price_difference: null,
      savings_percentage: null,
      is_cheaper: null,
      baseline_total: baseline.total_price,
      alternative_total: alternative.total_price,
    };
  }
  
  // Compute savings
  const difference = baseline.total_price - alternative.total_price;
  const percentage = (difference / baseline.total_price) * 100;
  
  return {
    is_comparable: true,
    comparison_failures: [],
    price_difference: difference,
    savings_percentage: Math.round(percentage * 10) / 10, // 1 decimal place
    is_cheaper: difference > 0,
    baseline_total: baseline.total_price,
    alternative_total: alternative.total_price,
  };
}

/**
 * Rank alternatives by price, excluding non-comparable ones
 */
export function rankAlternatives(
  baseline: CanonicalPrice,
  alternatives: CanonicalPrice[]
): {
  comparable: Array<{ price: CanonicalPrice; comparison: PriceComparisonResult }>;
  not_comparable: Array<{ price: CanonicalPrice; reasons: string[] }>;
  cheapest: CanonicalPrice | null;
  cheapest_savings: number | null;
} {
  const comparable: Array<{ price: CanonicalPrice; comparison: PriceComparisonResult }> = [];
  const notComparable: Array<{ price: CanonicalPrice; reasons: string[] }> = [];
  
  for (const alt of alternatives) {
    const comparison = comparePrices(baseline, alt);
    
    if (comparison.is_comparable) {
      comparable.push({ price: alt, comparison });
    } else {
      notComparable.push({ 
        price: alt, 
        reasons: [...alt.comparability_failures, ...comparison.comparison_failures]
      });
    }
  }
  
  // Sort comparable by price (ascending = cheapest first)
  comparable.sort((a, b) => (a.price.total_price ?? Infinity) - (b.price.total_price ?? Infinity));
  
  // Find cheapest that is actually cheaper than baseline
  const cheaperOptions = comparable.filter(c => c.comparison.is_cheaper === true);
  const cheapest = cheaperOptions.length > 0 ? cheaperOptions[0].price : null;
  const cheapestSavings = cheaperOptions.length > 0 ? cheaperOptions[0].comparison.price_difference : null;
  
  return {
    comparable,
    not_comparable: notComparable,
    cheapest,
    cheapest_savings: cheapestSavings,
  };
}

// ============================================
// UI HELPER FUNCTIONS
// ============================================

/**
 * Human-readable labels for price types
 */
export const PRICE_TYPE_LABELS: Record<PriceType, string> = {
  total_proven: 'Total',
  total_derived: 'Total (calculated)',
  subtotal_nights_only: 'Subtotal (nights only)',
  nightly_only: 'Per night',
  unknown: 'Price',
};

/**
 * Short labels for compact UI
 */
export const PRICE_TYPE_SHORT_LABELS: Record<PriceType, string> = {
  total_proven: 'Total',
  total_derived: 'Total*',
  subtotal_nights_only: 'Subtotal',
  nightly_only: '/night',
  unknown: '',
};

/**
 * Labels for comparability failures
 */
export const COMPARABILITY_FAILURE_LABELS: Record<string, string> = {
  no_total_price: 'Total price not available',
  price_type_not_total: 'Not a verified total price',
  dates_not_validated: 'Dates could not be confirmed',
  nights_count_missing: 'Stay duration unknown',
  currency_unknown: 'Currency not detected',
  extraction_not_successful: 'Price extraction failed',
  low_confidence: 'Low extraction confidence',
  taxes_fees_not_included: 'May not include all fees',
  baseline_not_comparable: 'Airbnb price not confirmed',
  alternative_not_comparable: 'Alternative price not confirmed',
  currency_mismatch: 'Different currency',
  nights_count_mismatch: 'Different stay duration',
  date_range_mismatch: 'Different dates',
  missing_total_price: 'Price unavailable',
  incompatible_price_types: 'Prices not comparable',
};

/**
 * Get display info for a canonical price
 */
export function getPriceDisplayInfo(price: CanonicalPrice): {
  display_value: string;
  label: string;
  is_total: boolean;
  is_comparable: boolean;
  warning: string | null;
  tooltip: string | null;
} {
  const currencySymbols: Record<string, string> = {
    USD: '$', EUR: '€', GBP: '£', CHF: 'CHF ', AUD: 'A$', CAD: 'C$',
  };
  const symbol = currencySymbols[price.currency] || price.currency + ' ';
  
  // Determine which value to display
  let displayValue: string;
  let isTotal = false;
  
  if (price.price_type === 'total_proven' || price.price_type === 'total_derived') {
    displayValue = price.total_price !== null 
      ? `${symbol}${Math.round(price.total_price)}`
      : '—';
    isTotal = true;
  } else if (price.price_type === 'subtotal_nights_only') {
    displayValue = price.subtotal_nights !== null
      ? `${symbol}${Math.round(price.subtotal_nights)}`
      : '—';
  } else if (price.price_type === 'nightly_only') {
    displayValue = price.nightly_rate !== null
      ? `${symbol}${Math.round(price.nightly_rate)}/night`
      : '—';
  } else {
    // Unknown - show whatever we have
    displayValue = price.total_price !== null 
      ? `${symbol}${Math.round(price.total_price)}`
      : price.subtotal_nights !== null
        ? `${symbol}${Math.round(price.subtotal_nights)}`
        : '—';
  }
  
  // Get label
  const label = PRICE_TYPE_LABELS[price.price_type];
  
  // Warning for non-total prices
  let warning: string | null = null;
  if (!isTotal && (price.subtotal_nights || price.nightly_rate)) {
    if (price.price_type === 'subtotal_nights_only') {
      warning = 'Does not include taxes and fees';
    } else if (price.price_type === 'nightly_only') {
      warning = 'Per-night rate — total may vary';
    }
  }
  
  // Tooltip with details
  let tooltip: string | null = null;
  if (!price.is_comparable && price.comparability_failures.length > 0) {
    const reasons = price.comparability_failures
      .map(f => COMPARABILITY_FAILURE_LABELS[f] || f)
      .slice(0, 3)
      .join(', ');
    tooltip = `Not comparable: ${reasons}`;
  } else if (price.price_type === 'total_derived' && price.confidence === 'medium') {
    tooltip = 'Price calculated from components';
  }
  
  return {
    display_value: displayValue,
    label,
    is_total: isTotal,
    is_comparable: price.is_comparable,
    warning,
    tooltip,
  };
}

/**
 * Get user-facing status for non-comparable prices
 */
export function getNonComparableStatus(price: CanonicalPrice): {
  headline: string;
  description: string;
  action_label: string;
} {
  // Prioritize failures by user-friendliness
  const failures = price.comparability_failures;
  
  if (failures.includes('no_total_price')) {
    return {
      headline: 'Price unavailable',
      description: 'We couldn\'t retrieve the price for your dates.',
      action_label: 'Check on site',
    };
  }
  
  if (failures.includes('price_type_not_total') || failures.includes('taxes_fees_not_included')) {
    return {
      headline: 'Price incomplete',
      description: 'This price may not include all taxes and fees.',
      action_label: 'Verify total',
    };
  }
  
  if (failures.includes('dates_not_validated')) {
    return {
      headline: 'Dates not confirmed',
      description: 'We couldn\'t confirm these dates are available.',
      action_label: 'Check availability',
    };
  }
  
  if (failures.includes('extraction_not_successful')) {
    return {
      headline: 'Price check failed',
      description: 'We couldn\'t load the price from this platform.',
      action_label: 'Try on site',
    };
  }
  
  // Default
  return {
    headline: 'Price not comparable',
    description: 'Manual verification recommended.',
    action_label: 'View listing',
  };
}
