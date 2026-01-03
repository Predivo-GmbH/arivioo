/**
 * Price Verification Module
 * 
 * Central source of truth for determining if a price is verified (reliable for comparison)
 * or unverified (informational only, manual check recommended).
 * 
 * A price is VERIFIED only if ALL of the following are true:
 * - extraction_status === 'success'  
 * - dates_validated === true (semantic validation, not just flag)
 * - includes_taxes_fees === true (based on actual breakdown presence)
 * - confidence threshold is met (>= 0.5)
 * - semantic_total_verified === true (proven booking total, not nightly/placeholder)
 * - extraction_path is a known booking/checkout flow (not hash-based or client-side only)
 * 
 * If ANY condition fails, price is UNVERIFIED and must not be used for numeric comparisons.
 * 
 * SAFETY INVARIANT: A price can NEVER be marked Verified if semantic total verification fails.
 * This prevents false "confidently wrong" prices.
 */

export type PriceStatus = 'verified' | 'unverified' | 'unavailable';
export type PriceSource = 'extracted' | 'scraped' | 'none';

export interface PriceVerificationResult {
  price_status: PriceStatus;
  price_source: PriceSource;
  price_verified_at: string | null;
  eligible_for_comparison: boolean;
  verification_failures: string[];
  semantic_total_verified: boolean;
}

// Minimum confidence score required for verification
const MIN_CONFIDENCE_THRESHOLD = 0.5;

// Extraction statuses that indicate successful price extraction
const SUCCESS_STATUSES = ['success', 'price_extracted'];

// Extraction paths that are known to provide semantic totals (booking/checkout flows)
const VALID_EXTRACTION_PATHS = [
  'checkout',
  'booking',
  'checkout_review',
  'booking_page',
  'rooms_page',
  'listing_page',
  'deep_link',
];

// Extraction paths that are known to ignore client-side state (hash-based, cached)
// These cannot be trusted for semantic verification
const UNTRUSTED_EXTRACTION_PATHS = [
  'hash_based',
  'cached',
  'static',
  'default',
];

// Price types that indicate a semantic booking total
const VALID_TOTAL_PRICE_TYPES = [
  'TOTAL_STAY',
  'total',
  'trip_total',
  'stay_total',
];

// Price types that are NOT semantic totals (nightly, placeholder, unknown)
const INVALID_PRICE_TYPES = [
  'NIGHTLY',
  'nightly',
  'per_night',
  'UNKNOWN',
  'unknown',
  'placeholder',
  'base',
];

/**
 * Check if evidence snippets contain semantic total indicators
 * This verifies the price was labeled as a total on the page
 */
function hasSemanticTotalInEvidence(evidenceSnippets: string[]): boolean {
  if (!evidenceSnippets || evidenceSnippets.length === 0) {
    return false;
  }

  const totalIndicators = [
    /\btotal\b/i,
    /\btrip\s+total\b/i,
    /\bstay\s+total\b/i,
    /\bfinal\s+price\b/i,
    /\bfull\s+price\b/i,
    /\bgrand\s+total\b/i,
    /\bfor\s+\d+\s+nights?\b/i,
    /\bincluding\s+(all\s+)?taxes\b/i,
    /\bincludes?\s+(all\s+)?fees?\b/i,
    /\btaxes?\s+(&|and)\s+fees?\s+included\b/i,
    /\byou('ll)?\s+pay\b/i,
    /\bamount\s+due\b/i,
    /\bpay\s+now\b/i,
    /\breserve\s+for\s+\$/i,
  ];

  for (const snippet of evidenceSnippets) {
    if (typeof snippet !== 'string') continue;
    for (const pattern of totalIndicators) {
      if (pattern.test(snippet)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check if the extracted price represents a semantic booking total
 * This is the core safety check to prevent false verified prices
 */
function verifySemanticTotal(params: {
  price_type: string | null;
  extraction_stage: string | null;
  extraction_path: string | null;
  evidence_snippets: string[];
  includes_breakdown: boolean | null;
  breakdown_has_subtotal_plus_fees: boolean | null;
}): { verified: boolean; reason: string } {
  // Rule 1: Price type must indicate a total (not nightly/unknown)
  if (params.price_type) {
    const priceTypeLower = params.price_type.toLowerCase();
    if (INVALID_PRICE_TYPES.some(t => priceTypeLower.includes(t.toLowerCase()))) {
      return { 
        verified: false, 
        reason: `price_type_not_total: ${params.price_type}` 
      };
    }
  }

  // Rule 2: Extraction path must not be untrusted (hash-based, cached)
  if (params.extraction_path) {
    const pathLower = params.extraction_path.toLowerCase();
    if (UNTRUSTED_EXTRACTION_PATHS.some(p => pathLower.includes(p.toLowerCase()))) {
      return { 
        verified: false, 
        reason: `untrusted_extraction_path: ${params.extraction_path}` 
      };
    }
  }

  // Rule 3: Evidence snippets must contain semantic total indicators
  const hasSemanticEvidence = hasSemanticTotalInEvidence(params.evidence_snippets);
  
  // Rule 4: If breakdown is present, total must be >= subtotal (consistency check)
  // This catches cases where a subtotal is extracted instead of total
  if (params.includes_breakdown && params.breakdown_has_subtotal_plus_fees === false) {
    return { 
      verified: false, 
      reason: 'breakdown_missing_fees_aggregation' 
    };
  }

  // Rule 5: Must have EITHER valid price type OR semantic evidence in snippets
  // This is the core verification - at least one form of proof is required
  const hasValidPriceType = params.price_type && 
    VALID_TOTAL_PRICE_TYPES.some(t => params.price_type!.toLowerCase().includes(t.toLowerCase()));

  if (!hasValidPriceType && !hasSemanticEvidence) {
    return { 
      verified: false, 
      reason: 'no_semantic_total_proof' 
    };
  }

  return { verified: true, reason: '' };
}

/**
 * Determine if a price meets all verification requirements
 * This is the SINGLE source of truth - do not duplicate this logic elsewhere
 */
export function verifyPrice(params: {
  extraction_status: string | null;
  dates_validated: boolean | null;
  includes_taxes_fees: boolean | null;
  confidence_score: number | null;
  extracted_price: number | null;
  extraction_completed_at?: string | null;
  // New params for semantic verification
  price_type?: string | null;
  extraction_stage?: string | null;
  extraction_path?: string | null;
  evidence_snippets?: string[] | null;
  extraction_metadata?: {
    includes_breakdown?: boolean;
    breakdown_has_subtotal_plus_fees?: boolean;
    [key: string]: any;
  } | null;
}): PriceVerificationResult {
  const failures: string[] = [];
  
  // Check if we have any price at all
  if (params.extracted_price === null || params.extracted_price <= 0) {
    return {
      price_status: 'unavailable',
      price_source: 'none',
      price_verified_at: null,
      eligible_for_comparison: false,
      verification_failures: ['no_price_extracted'],
      semantic_total_verified: false,
    };
  }

  // Rule 1: extraction_status must be success
  if (!params.extraction_status || !SUCCESS_STATUSES.includes(params.extraction_status)) {
    failures.push('extraction_not_successful');
  }

  // Rule 2: dates_validated must be true (semantic validation)
  if (params.dates_validated !== true) {
    failures.push('dates_not_validated');
  }

  // Rule 3: includes_taxes_fees must be true (based on actual breakdown)
  if (params.includes_taxes_fees !== true) {
    failures.push('taxes_fees_not_included');
  }

  // Rule 4: confidence_score must meet threshold
  if (params.confidence_score === null || params.confidence_score < MIN_CONFIDENCE_THRESHOLD) {
    failures.push('low_confidence');
  }

  // Rule 5: SEMANTIC TOTAL VERIFICATION (NEW - CRITICAL SAFETY CHECK)
  // This prevents false verified prices where extraction succeeded but price is not a real booking total
  const evidenceSnippets = Array.isArray(params.evidence_snippets) 
    ? params.evidence_snippets.filter(s => typeof s === 'string')
    : [];
  
  const semanticResult = verifySemanticTotal({
    price_type: params.price_type || null,
    extraction_stage: params.extraction_stage || null,
    extraction_path: params.extraction_path || null,
    evidence_snippets: evidenceSnippets,
    includes_breakdown: params.extraction_metadata?.includes_breakdown ?? null,
    breakdown_has_subtotal_plus_fees: params.extraction_metadata?.breakdown_has_subtotal_plus_fees ?? null,
  });

  if (!semanticResult.verified) {
    failures.push('semantic_total_not_verified');
    // Log the specific reason for debugging
    console.warn(`[PRICE_VERIFICATION] Semantic total verification failed: ${semanticResult.reason}`);
  }

  // Determine verification status - ALL checks must pass
  const isVerified = failures.length === 0;
  
  // SAFETY INVARIANT: Double-check that semantic verification passed if marking as verified
  if (isVerified && !semanticResult.verified) {
    console.error('[PRICE_VERIFICATION] CRITICAL: Attempted to mark as verified without semantic total proof');
    failures.push('semantic_total_not_verified');
  }
  
  return {
    price_status: isVerified ? 'verified' : 'unverified',
    price_source: 'extracted',
    price_verified_at: isVerified && params.extraction_completed_at ? params.extraction_completed_at : null,
    eligible_for_comparison: isVerified,
    verification_failures: failures,
    semantic_total_verified: semanticResult.verified,
  };
}

/**
 * Classify a result that has a price in search_results but no extraction record
 * This indicates the price came from scraping (image search results) not verified extraction
 */
export function classifyScrapedPrice(price: number | null): PriceVerificationResult {
  if (price === null || price <= 0) {
    return {
      price_status: 'unavailable',
      price_source: 'none',
      price_verified_at: null,
      eligible_for_comparison: false,
      verification_failures: ['no_price'],
      semantic_total_verified: false,
    };
  }

  // Scraped prices are NEVER verified - they come from search page snippets
  // and cannot be trusted for accurate date-specific comparisons
  return {
    price_status: 'unverified',
    price_source: 'scraped',
    price_verified_at: null,
    eligible_for_comparison: false,
    verification_failures: ['scraped_not_extracted'],
    semantic_total_verified: false,
  };
}

// Human-readable labels for verification failures
export const VERIFICATION_FAILURE_LABELS: Record<string, string> = {
  'extraction_not_successful': 'Price extraction failed',
  'dates_not_validated': 'Dates could not be confirmed',
  'taxes_fees_not_included': 'May not include all fees',
  'low_confidence': 'Low extraction confidence',
  'scraped_not_extracted': 'Price not verified for dates',
  'no_price_extracted': 'Price unavailable',
  'no_price': 'Price unavailable',
  // New semantic verification failures
  'semantic_total_not_verified': 'Not proven to be booking total',
  'price_type_not_total': 'Price appears to be nightly, not total',
  'untrusted_extraction_path': 'Extraction path may ignore selected dates',
  'breakdown_missing_fees_aggregation': 'Price breakdown incomplete',
  'no_semantic_total_proof': 'No evidence this is the final booking total',
};

/**
 * Get a user-friendly summary of why a price is unverified
 */
export function getVerificationSummary(result: PriceVerificationResult): string {
  if (result.price_status === 'verified') {
    return 'Price verified for your dates';
  }
  
  if (result.price_status === 'unavailable') {
    return 'Price unavailable';
  }

  // Prioritize semantic failures for clearer user messaging
  if (result.verification_failures.includes('semantic_total_not_verified')) {
    return 'Manual check recommended - price may not be final total';
  }

  // Return first failure reason as summary
  const firstFailure = result.verification_failures[0];
  return VERIFICATION_FAILURE_LABELS[firstFailure] || 'Manual check recommended';
}

/**
 * Get detailed reasons for admin diagnostics
 */
export function getDetailedVerificationReasons(result: PriceVerificationResult): string[] {
  return result.verification_failures.map(failure => 
    VERIFICATION_FAILURE_LABELS[failure] || failure
  );
}
