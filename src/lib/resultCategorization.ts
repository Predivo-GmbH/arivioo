/**
 * Result Categorization Module
 * 
 * Provides unified classification of search results into user-friendly buckets
 * based on the canonical price model and extraction outcome taxonomy.
 * 
 * This module is the single source of truth for result categorization,
 * shared by both Admin and Frontend views.
 * 
 * @module resultCategorization
 */

import type { CanonicalPrice, PriceType } from './canonicalPrice';
import { comparePrices, type PriceComparisonResult } from './canonicalPrice';
import type { OutcomeCategory } from './extractionOutcomeTaxonomy';

// ============================================
// RESULT BUCKET TYPES
// ============================================

/**
 * Primary UX bucket categories for search results
 * These are mutually exclusive and determine how a result is displayed
 */
export type ResultBucket =
  | 'cheaper'           // Found and cheaper than Airbnb (comparable totals)
  | 'more_expensive'    // Found but more expensive than Airbnb (comparable totals)
  | 'not_comparable'    // Found with price but not comparable (subtotal, currency mismatch, etc.)
  | 'sold_out'          // Found but unavailable for selected dates
  | 'price_not_found'   // Found but price couldn't be extracted
  | 'blocked'           // Found but access was blocked (captcha, bot detection)
  | 'requires_action'   // Found but requires user action (login, confirmation)
  | 'service_error'     // True error (timeout, 5xx, etc.)
  | 'platform_blocked'; // Tier C - platform explicitly not supported

/**
 * Detailed categorization result for a single search result
 */
export interface CategorizedResult {
  bucket: ResultBucket;
  bucket_label: string;           // User-friendly label
  bucket_description: string;     // Longer explanation
  
  // Price comparison (only for comparable results)
  is_comparable: boolean;
  comparison_result: PriceComparisonResult | null;
  savings_amount: number | null;    // positive = cheaper, negative = more expensive
  savings_percentage: number | null;
  
  // Verification status (based on canonical price model)
  is_verified: boolean;
  verification_label: 'Verified' | 'Unverified' | 'Not Available';
  has_low_confidence: boolean;     // True if extraction had low confidence (show "manual check" note)
  
  // Non-comparability reasons (for not_comparable bucket)
  non_comparable_reasons: string[];
  non_comparable_user_message: string | null;
  
  // Raw data for debugging
  price_type: PriceType | null;
  outcome_category: OutcomeCategory | null;
}

// ============================================
// BUCKET DISPLAY CONFIGURATION
// ============================================

export const BUCKET_DISPLAY: Record<ResultBucket, {
  label: string;
  description: string;
  icon: string;
  color: 'success' | 'warning' | 'error' | 'muted' | 'info';
  severity: number; // For sorting: lower = better outcome
}> = {
  cheaper: {
    label: 'Found and cheaper',
    description: 'Found on this platform at a lower price than Airbnb for your dates',
    icon: 'TrendingDown',
    color: 'success',
    severity: 1,
  },
  more_expensive: {
    label: 'Found but more expensive',
    description: 'Found on this platform but the price is higher than Airbnb',
    icon: 'TrendingUp',
    color: 'muted',
    severity: 2,
  },
  not_comparable: {
    label: 'Price not comparable',
    description: 'Found with a price, but it cannot be directly compared to Airbnb',
    icon: 'ArrowLeftRight',
    color: 'warning',
    severity: 3,
  },
  sold_out: {
    label: 'Not available for these dates',
    description: 'Found on this platform but sold out or unavailable for your selected dates',
    icon: 'Calendar',
    color: 'muted',
    severity: 4,
  },
  price_not_found: {
    label: 'Price not found',
    description: 'Found on this platform but the price could not be extracted',
    icon: 'DollarSign',
    color: 'warning',
    severity: 5,
  },
  blocked: {
    label: 'Access blocked',
    description: 'The platform blocked automated access. Try visiting directly.',
    icon: 'Ban',
    color: 'error',
    severity: 6,
  },
  requires_action: {
    label: 'Requires action',
    description: 'Found but requires login, confirmation, or other action to view price',
    icon: 'Lock',
    color: 'warning',
    severity: 5,
  },
  service_error: {
    label: 'Temporary error',
    description: 'A temporary error occurred while retrieving the price',
    icon: 'AlertTriangle',
    color: 'error',
    severity: 7,
  },
  platform_blocked: {
    label: 'Platform not supported',
    description: 'This platform is not currently supported for price comparison',
    icon: 'Ban',
    color: 'muted',
    severity: 8,
  },
};

// ============================================
// NON-COMPARABILITY REASON LABELS
// ============================================

export const NON_COMPARABLE_REASON_LABELS: Record<string, string> = {
  // From canonical price comparability
  no_total_price: 'Total price not available',
  price_type_not_total: 'Only partial price found (subtotal or nightly)',
  dates_not_validated: 'Dates could not be confirmed on platform',
  nights_count_missing: 'Stay duration unknown',
  currency_unknown: 'Currency not detected',
  extraction_not_successful: 'Price extraction incomplete',
  // NOTE: low_confidence is now only added when there's no structural verification
  // It does NOT prevent comparison for total_proven prices
  low_confidence: 'Manual verification recommended',
  taxes_fees_not_included: 'May not include all taxes and fees',
  
  // From price comparison
  baseline_not_comparable: 'Airbnb price not confirmed',
  alternative_not_comparable: 'Alternative price not confirmed',
  currency_mismatch: 'Different currency than Airbnb',
  nights_count_mismatch: 'Different stay duration',
  date_range_mismatch: 'Different dates than requested',
  missing_total_price: 'Price unavailable',
  incompatible_price_types: 'Cannot compare these price types',
  no_canonical_price: 'Price data incomplete',
};

// ============================================
// CATEGORIZATION LOGIC
// ============================================

export interface CategorizationInput {
  // Price data
  price: number | null;
  canonical_price: CanonicalPrice | null;
  
  // Outcome from extraction
  outcome_category: OutcomeCategory | null;
  extraction_status: string | null;
  extraction_error: string | null;
  
  // Platform status
  is_tier_c_blocked: boolean;
  coverage_tier: 'A' | 'B' | 'C' | null;
  
  // Legacy verification (for backwards compat)
  price_status: 'verified' | 'unverified' | 'unavailable';
  eligible_for_comparison: boolean;
  verification_failures: string[];
}

/**
 * Categorize a single result into a UX bucket
 * Uses canonical price model for price-based categorization
 */
export function categorizeResult(
  input: CategorizationInput,
  baselinePrice: CanonicalPrice | null
): CategorizedResult {
  // Tier C platforms are always blocked
  if (input.is_tier_c_blocked || input.coverage_tier === 'C') {
    return createResult('platform_blocked', input, null);
  }
  
  // Check outcome category for non-price states first
  if (input.outcome_category === 'unavailable_for_dates') {
    return createResult('sold_out', input, null);
  }
  
  if (input.outcome_category === 'access_blocked') {
    return createResult('blocked', input, null);
  }
  
  if (input.outcome_category === 'requires_action') {
    return createResult('requires_action', input, null);
  }
  
  if (input.outcome_category === 'service_error') {
    return createResult('service_error', input, null);
  }
  
  // Check for sold out via extraction status
  const soldOutStatuses = ['dates_unavailable', 'sold_out', 'expedia_dates_unavailable_for_target'];
  if (input.extraction_status && soldOutStatuses.includes(input.extraction_status)) {
    return createResult('sold_out', input, null);
  }
  
  // No price at all
  if (!input.price || input.price <= 0) {
    return createResult('price_not_found', input, null);
  }
  
  // Has price - now check if it's comparable
  const canonicalPrice = input.canonical_price;
  
  // If we have a canonical price, use it for comparison
  if (canonicalPrice && baselinePrice) {
    // Check if both prices are comparable totals
    const isCanonicalComparable = 
      canonicalPrice.is_comparable &&
      (canonicalPrice.price_type === 'total_proven' || canonicalPrice.price_type === 'total_derived');
    
    const isBaselineComparable = 
      baselinePrice.is_comparable &&
      (baselinePrice.price_type === 'total_proven' || baselinePrice.price_type === 'total_derived');
    
    if (isCanonicalComparable && isBaselineComparable) {
      // Both are comparable - run full comparison
      const comparison = comparePrices(baselinePrice, canonicalPrice);
      
      if (comparison.is_comparable) {
        // Determine cheaper vs more expensive
        if (comparison.is_cheaper === true) {
          return createResult('cheaper', input, comparison);
        } else {
          return createResult('more_expensive', input, comparison);
        }
      } else {
        // Comparison failed for specific reasons
        return createNotComparableResult(input, comparison.comparison_failures);
      }
    } else {
      // One or both prices are not comparable types
      const reasons: string[] = [];
      if (!isCanonicalComparable) {
        // Defensive: comparability_failures may be undefined in legacy/snapshot data
        const failures = canonicalPrice.comparability_failures ?? ['no_canonical_price'];
        reasons.push(...failures);
      }
      if (!isBaselineComparable) {
        reasons.push('baseline_not_comparable');
      }
      return createNotComparableResult(input, reasons);
    }
  }
  
  // Fallback: Has price but no canonical price model
  // Use legacy verification for backwards compatibility
  if (input.eligible_for_comparison && input.price_status === 'verified') {
    // Verified but no baseline to compare against
    if (!baselinePrice) {
      return createNotComparableResult(input, ['baseline_not_comparable']);
    }
    // This shouldn't happen if we have proper canonical prices
    return createNotComparableResult(input, ['no_canonical_price']);
  }
  
  // Has price but unverified - not comparable
  return createNotComparableResult(input, input.verification_failures);
}

/**
 * Create a categorized result with common fields
 */
function createResult(
  bucket: ResultBucket,
  input: CategorizationInput,
  comparison: PriceComparisonResult | null
): CategorizedResult {
  const display = BUCKET_DISPLAY[bucket];
  const canonicalPrice = input.canonical_price;
  
  // Determine verification status from canonical price model
  // CRITICAL: "Verified" means we have a proven or derived total.
  // Low confidence does NOT prevent "verified" status when structural proof exists.
  // Low confidence only adds a "manual check recommended" note.
  let isVerified = false;
  let verificationLabel: 'Verified' | 'Unverified' | 'Not Available' = 'Not Available';
  let hasLowConfidence = false;
  
  if (canonicalPrice) {
    const isTotalType = canonicalPrice.price_type === 'total_proven' || canonicalPrice.price_type === 'total_derived';
    
    // Check for structural verification
    const structuralProof = canonicalPrice.structural_proof;
    const hasStructuralVerification = structuralProof && (
      (structuralProof.breakdown_found === true && structuralProof.extracted_from_breakdown_total === true) ||
      (structuralProof.breakdown_found === true && structuralProof.total_label_found === true)
    );
    
    // Verified if:
    // - Price type is total_proven or total_derived
    // - Either: has structural verification OR is_comparable is true
    // Low confidence does NOT prevent verified status when we have structural proof
    isVerified = isTotalType && (canonicalPrice.is_comparable || hasStructuralVerification);
    
    hasLowConfidence = canonicalPrice.confidence === 'low';
    
    if (canonicalPrice.total_price !== null) {
      verificationLabel = isVerified ? 'Verified' : 'Unverified';
    }
  } else if (input.price && input.price > 0) {
    verificationLabel = input.price_status === 'verified' ? 'Verified' : 'Unverified';
    isVerified = input.price_status === 'verified';
  }
  
  return {
    bucket,
    bucket_label: display.label,
    bucket_description: display.description,
    
    is_comparable: comparison?.is_comparable ?? false,
    comparison_result: comparison,
    savings_amount: comparison?.price_difference ?? null,
    savings_percentage: comparison?.savings_percentage ?? null,
    
    is_verified: isVerified,
    verification_label: verificationLabel,
    
    non_comparable_reasons: [],
    non_comparable_user_message: null,
    
    price_type: canonicalPrice?.price_type ?? null,
    outcome_category: input.outcome_category,
    
    // Add low confidence flag for UI to show "manual check recommended" badge
    has_low_confidence: hasLowConfidence,
  };
}

/**
 * Create a not-comparable result with reasons
 */
function createNotComparableResult(
  input: CategorizationInput,
  reasons: string[]
): CategorizedResult {
  const base = createResult('not_comparable', input, null);
  
  // Deduplicate and filter empty reasons
  const uniqueReasons = [...new Set(reasons.filter(r => r && r.length > 0))];
  
  // Generate user-friendly message from reasons
  let userMessage = 'Price cannot be directly compared to Airbnb';
  if (uniqueReasons.length > 0) {
    const labeledReasons = uniqueReasons
      .map(r => NON_COMPARABLE_REASON_LABELS[r] || r)
      .slice(0, 2); // Show max 2 reasons
    userMessage = labeledReasons.join('. ');
  }
  
  return {
    ...base,
    non_comparable_reasons: uniqueReasons,
    non_comparable_user_message: userMessage,
  };
}

// ============================================
// BATCH CATEGORIZATION
// ============================================

export interface BatchCategorizationResult {
  cheaper: CategorizedResult[];
  more_expensive: CategorizedResult[];
  not_comparable: CategorizedResult[];
  sold_out: CategorizedResult[];
  price_not_found: CategorizedResult[];
  blocked: CategorizedResult[];
  requires_action: CategorizedResult[];
  service_error: CategorizedResult[];
  platform_blocked: CategorizedResult[];
  
  // Summary stats
  cheapest: CategorizedResult | null;
  cheapest_savings: number | null;
  comparable_count: number;
  total_count: number;
}

/**
 * Categorize all results and organize into buckets
 */
export function categorizeAllResults(
  results: Array<CategorizationInput & { id: string }>,
  baselinePrice: CanonicalPrice | null
): BatchCategorizationResult {
  const buckets: BatchCategorizationResult = {
    cheaper: [],
    more_expensive: [],
    not_comparable: [],
    sold_out: [],
    price_not_found: [],
    blocked: [],
    requires_action: [],
    service_error: [],
    platform_blocked: [],
    cheapest: null,
    cheapest_savings: null,
    comparable_count: 0,
    total_count: results.length,
  };
  
  for (const result of results) {
    const categorized = categorizeResult(result, baselinePrice);
    
    // Add to appropriate bucket
    switch (categorized.bucket) {
      case 'cheaper':
        buckets.cheaper.push(categorized);
        buckets.comparable_count++;
        break;
      case 'more_expensive':
        buckets.more_expensive.push(categorized);
        buckets.comparable_count++;
        break;
      case 'not_comparable':
        buckets.not_comparable.push(categorized);
        break;
      case 'sold_out':
        buckets.sold_out.push(categorized);
        break;
      case 'price_not_found':
        buckets.price_not_found.push(categorized);
        break;
      case 'blocked':
        buckets.blocked.push(categorized);
        break;
      case 'requires_action':
        buckets.requires_action.push(categorized);
        break;
      case 'service_error':
        buckets.service_error.push(categorized);
        break;
      case 'platform_blocked':
        buckets.platform_blocked.push(categorized);
        break;
    }
  }
  
  // Sort cheaper by savings (most savings first)
  buckets.cheaper.sort((a, b) => (b.savings_amount ?? 0) - (a.savings_amount ?? 0));
  
  // Find cheapest
  if (buckets.cheaper.length > 0) {
    buckets.cheapest = buckets.cheaper[0];
    buckets.cheapest_savings = buckets.cheaper[0].savings_amount;
  }
  
  return buckets;
}

// ============================================
// ADMIN DISPLAY HELPERS
// ============================================

/**
 * Get admin-friendly status for a categorized result
 */
export function getAdminStatusDisplay(categorized: CategorizedResult): {
  status: string;
  comparability: string;
  position: string;
} {
  const position = categorized.bucket === 'cheaper' 
    ? `Cheaper by ${categorized.savings_percentage?.toFixed(1)}%`
    : categorized.bucket === 'more_expensive'
    ? `More expensive by ${Math.abs(categorized.savings_percentage ?? 0).toFixed(1)}%`
    : 'N/A';
  
  return {
    status: categorized.bucket_label,
    comparability: categorized.is_comparable ? 'Comparable' : `Not comparable: ${categorized.non_comparable_user_message}`,
    position,
  };
}
