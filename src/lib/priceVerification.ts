/**
 * Price Verification Module
 * 
 * Central source of truth for determining if a price is verified (reliable for comparison)
 * or unverified (informational only, manual check recommended).
 * 
 * === STRUCTURAL VERIFICATION ===
 * A price is VERIFIED only if ALL of the following are true:
 * - extraction_status === 'success'  
 * - dates_validated === true (semantic validation, not just flag)
 * - includes_taxes_fees === true (based on actual breakdown presence)
 * - confidence threshold is met (>= 0.5)
 * - structural_total_verified === true (extractor explicitly reports structural proof)
 * 
 * STRUCTURAL VERIFICATION requires the extractor to report:
 * - breakdown_found: true (a booking breakdown container was found)
 * - total_label_found: true (a "Total" line was found in the breakdown)
 * - rendered_dates_match: true (rendered UI dates match requested dates)
 * - extracted_from_breakdown_total: true (price was taken from the Total line)
 * 
 * If ANY condition fails, price is UNVERIFIED and must not be used for numeric comparisons.
 * 
 * SAFETY INVARIANT: A price can NEVER be marked Verified if structural verification fails.
 * This prevents false "confidently wrong" prices.
 * 
 * NOTE: Heuristic-based semantic verification (text pattern matching) is NO LONGER sufficient
 * for Verified status. Evidence snippets remain for debugging only.
 */

export type PriceStatus = 'verified' | 'unverified' | 'unavailable';
export type PriceSource = 'extracted' | 'scraped' | 'none';

/**
 * Structural verification metadata that extractors MUST populate
 * for a price to be eligible for Verified status.
 */
export interface StructuralVerificationMetadata {
  // Did the extractor find a booking breakdown container?
  breakdown_found: boolean;
  // Did the extractor find a "Total" label within the breakdown?
  total_label_found: boolean;
  // Did the extractor confirm rendered UI dates match requested dates?
  rendered_dates_match: boolean;
  // Was the extracted price taken from the breakdown Total line?
  extracted_from_breakdown_total: boolean;
  // Optional: selector used to find the breakdown
  breakdown_selector_used?: string;
  // Optional: raw value from Total line
  total_value_raw?: string;
  // Optional: raw date values from rendered UI
  date_value_raw?: string;
}

export interface PriceVerificationResult {
  price_status: PriceStatus;
  price_source: PriceSource;
  price_verified_at: string | null;
  eligible_for_comparison: boolean;
  verification_failures: string[];
  // NEW: Structural verification replaces semantic verification
  structural_total_verified: boolean;
  // Keep for backwards compatibility but not used for verification decisions
  semantic_total_verified: boolean;
  // Detailed structural proof signals for admin diagnostics
  structural_proof: {
    breakdown_found: boolean | null;
    total_label_found: boolean | null;
    rendered_dates_match: boolean | null;
    extracted_from_breakdown_total: boolean | null;
  };
}

// Minimum confidence score required for verification
const MIN_CONFIDENCE_THRESHOLD = 0.5;

// Extraction statuses that indicate successful price extraction
const SUCCESS_STATUSES = ['success', 'price_extracted'];

// Extraction paths that are known to ignore client-side state (hash-based, cached)
// These cannot provide structural verification proof
const UNTRUSTED_EXTRACTION_PATHS = [
  'hash_based',
  'cached',
  'static',
  'default',
];

/**
 * Check if evidence snippets contain semantic total indicators
 * NOTE: This is now ONLY for debugging/logging, not for verification decisions
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
 * STRUCTURAL VERIFICATION
 * 
 * This is the CORE safety check that replaces heuristic-based semantic verification.
 * A price can only be Verified if the extractor explicitly reports structural proof.
 * 
 * The extractor must populate extraction_metadata with:
 * - breakdown_found: true
 * - total_label_found: true
 * - rendered_dates_match: true
 * - extracted_from_breakdown_total: true
 * 
 * If any of these are false/missing/unknown, structural verification fails.
 */
function verifyStructuralTotal(params: {
  extraction_path: string | null;
  extraction_metadata: {
    breakdown_found?: boolean;
    total_label_found?: boolean;
    rendered_dates_match?: boolean;
    extracted_from_breakdown_total?: boolean;
    [key: string]: any;
  } | null;
}): { 
  verified: boolean; 
  reason: string;
  proof: {
    breakdown_found: boolean | null;
    total_label_found: boolean | null;
    rendered_dates_match: boolean | null;
    extracted_from_breakdown_total: boolean | null;
  };
} {
  const metadata = params.extraction_metadata || {};
  
  const proof = {
    breakdown_found: metadata.breakdown_found ?? null,
    total_label_found: metadata.total_label_found ?? null,
    rendered_dates_match: metadata.rendered_dates_match ?? null,
    extracted_from_breakdown_total: metadata.extracted_from_breakdown_total ?? null,
  };

  // Rule 1: Extraction path must not be untrusted (hash-based, cached)
  // These paths cannot provide reliable structural proof
  if (params.extraction_path) {
    const pathLower = params.extraction_path.toLowerCase();
    if (UNTRUSTED_EXTRACTION_PATHS.some(p => pathLower.includes(p.toLowerCase()))) {
      return { 
        verified: false, 
        reason: `untrusted_extraction_path: ${params.extraction_path}`,
        proof,
      };
    }
  }

  // Rule 2: breakdown_found must be explicitly true
  if (proof.breakdown_found !== true) {
    return { 
      verified: false, 
      reason: 'no_breakdown_found',
      proof,
    };
  }

  // Rule 3: total_label_found must be explicitly true
  if (proof.total_label_found !== true) {
    return { 
      verified: false, 
      reason: 'no_total_label_found',
      proof,
    };
  }

  // Rule 4: rendered_dates_match must be explicitly true
  if (proof.rendered_dates_match !== true) {
    return { 
      verified: false, 
      reason: 'rendered_dates_do_not_match',
      proof,
    };
  }

  // Rule 5: extracted_from_breakdown_total must be explicitly true
  if (proof.extracted_from_breakdown_total !== true) {
    return { 
      verified: false, 
      reason: 'price_not_from_breakdown_total',
      proof,
    };
  }

  // All structural checks passed
  return { verified: true, reason: '', proof };
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
  // Params for structural verification
  price_type?: string | null;
  extraction_stage?: string | null;
  extraction_path?: string | null;
  evidence_snippets?: string[] | null;
  extraction_metadata?: {
    breakdown_found?: boolean;
    total_label_found?: boolean;
    rendered_dates_match?: boolean;
    extracted_from_breakdown_total?: boolean;
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
      structural_total_verified: false,
      semantic_total_verified: false,
      structural_proof: {
        breakdown_found: null,
        total_label_found: null,
        rendered_dates_match: null,
        extracted_from_breakdown_total: null,
      },
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

  // Rule 5: STRUCTURAL TOTAL VERIFICATION (CRITICAL SAFETY CHECK)
  // This replaces heuristic-based semantic verification
  const structuralResult = verifyStructuralTotal({
    extraction_path: params.extraction_path || null,
    extraction_metadata: params.extraction_metadata || null,
  });

  if (!structuralResult.verified) {
    failures.push('no_structural_total_proof');
    // Log the specific reason for debugging
    console.warn(`[PRICE_VERIFICATION] Structural verification failed: ${structuralResult.reason}`);
  }

  // Also compute semantic verification for backwards compatibility / debugging
  const evidenceSnippets = Array.isArray(params.evidence_snippets) 
    ? params.evidence_snippets.filter(s => typeof s === 'string')
    : [];
  const semanticVerified = hasSemanticTotalInEvidence(evidenceSnippets);

  // Determine verification status - ALL checks must pass including STRUCTURAL
  const isVerified = failures.length === 0;
  
  // SAFETY INVARIANT: Double-check that structural verification passed if marking as verified
  if (isVerified && !structuralResult.verified) {
    console.error('[PRICE_VERIFICATION] CRITICAL: Attempted to mark as verified without structural proof');
    failures.push('no_structural_total_proof');
  }
  
  return {
    price_status: failures.length === 0 ? 'verified' : 'unverified',
    price_source: 'extracted',
    price_verified_at: failures.length === 0 && params.extraction_completed_at ? params.extraction_completed_at : null,
    eligible_for_comparison: failures.length === 0,
    verification_failures: failures,
    structural_total_verified: structuralResult.verified,
    semantic_total_verified: semanticVerified,
    structural_proof: structuralResult.proof,
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
      structural_total_verified: false,
      semantic_total_verified: false,
      structural_proof: {
        breakdown_found: null,
        total_label_found: null,
        rendered_dates_match: null,
        extracted_from_breakdown_total: null,
      },
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
    structural_total_verified: false,
    semantic_total_verified: false,
    structural_proof: {
      breakdown_found: null,
      total_label_found: null,
      rendered_dates_match: null,
      extracted_from_breakdown_total: null,
    },
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
  // STRUCTURAL verification failures (NEW)
  'no_structural_total_proof': 'No structural proof of booking total',
  'no_breakdown_found': 'Booking breakdown not found on page',
  'no_total_label_found': 'Total label not found in breakdown',
  'rendered_dates_do_not_match': 'Rendered dates do not match requested dates',
  'price_not_from_breakdown_total': 'Price not extracted from breakdown total',
  'untrusted_extraction_path': 'Extraction path cannot verify dates',
  // Legacy semantic failures (kept for debugging, not used for decisions)
  'semantic_total_not_verified': 'Not proven to be booking total (semantic)',
  'price_type_not_total': 'Price appears to be nightly, not total',
  'breakdown_missing_fees_aggregation': 'Price breakdown incomplete',
  'no_semantic_total_proof': 'No semantic evidence of total',
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

  // Prioritize structural failures for clearer user messaging
  if (result.verification_failures.includes('no_structural_total_proof')) {
    return 'Manual check recommended - price not structurally verified';
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
