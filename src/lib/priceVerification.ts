/**
 * Price Verification Module
 * 
 * Central source of truth for determining if a price is verified (reliable for comparison)
 * or unverified (informational only, manual check recommended).
 * 
 * A price is VERIFIED only if ALL of the following are true:
 * - extraction_status === 'success'  
 * - dates_validated === true
 * - includes_taxes_fees === true
 * - confidence threshold is met (>= 0.5)
 * 
 * If ANY condition fails, price is UNVERIFIED and must not be used for numeric comparisons.
 */

export type PriceStatus = 'verified' | 'unverified' | 'unavailable';
export type PriceSource = 'extracted' | 'scraped' | 'none';

export interface PriceVerificationResult {
  price_status: PriceStatus;
  price_source: PriceSource;
  price_verified_at: string | null;
  eligible_for_comparison: boolean;
  verification_failures: string[];
}

// Minimum confidence score required for verification
const MIN_CONFIDENCE_THRESHOLD = 0.5;

// Extraction statuses that indicate successful price extraction
const SUCCESS_STATUSES = ['success', 'price_extracted'];

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
    };
  }

  // Rule 1: extraction_status must be success
  if (!params.extraction_status || !SUCCESS_STATUSES.includes(params.extraction_status)) {
    failures.push('extraction_not_successful');
  }

  // Rule 2: dates_validated must be true
  if (params.dates_validated !== true) {
    failures.push('dates_not_validated');
  }

  // Rule 3: includes_taxes_fees must be true
  if (params.includes_taxes_fees !== true) {
    failures.push('taxes_fees_not_included');
  }

  // Rule 4: confidence_score must meet threshold
  if (params.confidence_score === null || params.confidence_score < MIN_CONFIDENCE_THRESHOLD) {
    failures.push('low_confidence');
  }

  // Determine verification status
  const isVerified = failures.length === 0;
  
  return {
    price_status: isVerified ? 'verified' : 'unverified',
    price_source: 'extracted',
    price_verified_at: isVerified && params.extraction_completed_at ? params.extraction_completed_at : null,
    eligible_for_comparison: isVerified,
    verification_failures: failures,
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

  // Return first failure reason as summary
  const firstFailure = result.verification_failures[0];
  return VERIFICATION_FAILURE_LABELS[firstFailure] || 'Manual check recommended';
}
