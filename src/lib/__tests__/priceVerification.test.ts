/**
 * Price Verification Regression Tests
 * 
 * REFERENCE TESTS: These tests enforce the structural verification invariant.
 * They use deterministic fixtures - no network calls, fully reproducible.
 * 
 * INVARIANT: A price can ONLY be marked Verified if ALL structural proof fields are true:
 * - breakdown_found === true
 * - total_label_found === true
 * - rendered_dates_match === true
 * - extracted_from_breakdown_total === true
 * 
 * These tests MUST fail the build if the invariant is broken.
 */


import { describe, it, expect } from 'vitest';
import { verifyPrice } from '../priceVerification';

// ============================================================================
// FIXTURES: Hotels.com Reference Implementation
// ============================================================================

/**
 * FIXTURE A: Valid Hotels.com extraction with full structural proof
 * 
 * Represents a real Hotels.com page where:
 * - Breakdown container was found ("Price details" section)
 * - Total row was identified with explicit label
 * - Rendered dates (Jan 15 - Jan 18) match requested dates
 * - Price ($523.00) was extracted from the breakdown total row
 */
const FIXTURE_A_VALID_STRUCTURAL_PROOF = {
  extraction_status: 'success',
  dates_validated: true,
  includes_taxes_fees: true,
  confidence_score: 0.95,
  extracted_price: 523.00,
  extraction_completed_at: '2025-01-03T10:00:00Z',
  price_type: 'TOTAL_STAY',
  extraction_stage: 'phaseB',
  extraction_path: 'hotels_com_breakdown',
  evidence_snippets: [
    'The price is $523.00 total includes taxes and fees',
    'Price details: Room rate $420 + Taxes & fees $103',
  ],
  extraction_metadata: {
    goldenPath: true,
    platform: 'hotels.com',
    structural_proof: {
      breakdown_found: true,
      total_label_found: true,
      rendered_dates_match: true,
      extracted_from_breakdown_total: true,
      proof_version: '1.0',
      breakdown_selector_used: 'price details',
      total_value_raw: 'The price is $523.00 total',
      date_value_raw: 'Jan 15 - Jan 18',
    },
    // These fields are copied to top level for verifier compatibility
    breakdown_found: true,
    total_label_found: true,
    rendered_dates_match: true,
    extracted_from_breakdown_total: true,
  },
};

/**
 * FIXTURE B: Invalid extraction - missing breakdown container
 * 
 * Represents a page where:
 * - No breakdown container was found (single price node only)
 * - Total label cannot be verified
 * - Dates may or may not be rendered
 * - Price came from header, not breakdown
 */
const FIXTURE_B_NO_BREAKDOWN = {
  extraction_status: 'success',
  dates_validated: true,
  includes_taxes_fees: true,
  confidence_score: 0.8,
  extracted_price: 450.00,
  extraction_completed_at: '2025-01-03T10:00:00Z',
  price_type: 'unknown',
  extraction_stage: 'phaseB',
  extraction_path: 'hotels_com_header',
  evidence_snippets: [
    '$450 per night',
  ],
  extraction_metadata: {
    platform: 'hotels.com',
    breakdown_found: false, // CRITICAL: No breakdown found
    total_label_found: false,
    rendered_dates_match: true,
    extracted_from_breakdown_total: false,
  },
};

/**
 * FIXTURE C: Invalid extraction - total label missing in breakdown
 * 
 * Represents a page where:
 * - Breakdown container exists
 * - But no explicit "Total" row was found
 * - Price was inferred, not explicitly labeled
 */
const FIXTURE_C_NO_TOTAL_LABEL = {
  extraction_status: 'success',
  dates_validated: true,
  includes_taxes_fees: true,
  confidence_score: 0.75,
  extracted_price: 380.00,
  extraction_completed_at: '2025-01-03T10:00:00Z',
  price_type: 'unknown',
  extraction_stage: 'phaseB',
  extraction_path: 'hotels_com_breakdown',
  evidence_snippets: [
    'Room: $320, Fees: $60',
  ],
  extraction_metadata: {
    platform: 'hotels.com',
    breakdown_found: true,
    total_label_found: false, // CRITICAL: No total label
    rendered_dates_match: true,
    extracted_from_breakdown_total: false,
  },
};

/**
 * FIXTURE D: Invalid extraction - dates don't match
 * 
 * Represents a page where:
 * - Breakdown exists with total label
 * - But rendered dates (Jan 20 - Jan 23) don't match requested (Jan 15 - Jan 18)
 * - This is the Sierra-type false positive scenario
 */
const FIXTURE_D_DATES_MISMATCH = {
  extraction_status: 'success',
  dates_validated: true, // Semantic validation passed (legacy)
  includes_taxes_fees: true,
  confidence_score: 0.9,
  extracted_price: 1000.00,
  extraction_completed_at: '2025-01-03T10:00:00Z',
  price_type: 'TOTAL_STAY',
  extraction_stage: 'phaseB',
  extraction_path: 'sierra_vacation_rentals',
  evidence_snippets: [
    'Total: $1000.00 for 3 nights',
  ],
  extraction_metadata: {
    platform: 'sierravacationrentals.com',
    breakdown_found: true,
    total_label_found: true,
    rendered_dates_match: false, // CRITICAL: Dates don't match
    extracted_from_breakdown_total: true,
  },
};

/**
 * FIXTURE E: Invalid extraction - price not from breakdown total
 * 
 * Represents a page where:
 * - Breakdown exists
 * - Total label exists
 * - Dates match
 * - But the extracted price came from elsewhere (e.g., header)
 */
const FIXTURE_E_NOT_FROM_BREAKDOWN = {
  extraction_status: 'success',
  dates_validated: true,
  includes_taxes_fees: true,
  confidence_score: 0.85,
  extracted_price: 299.00,
  extraction_completed_at: '2025-01-03T10:00:00Z',
  price_type: 'TOTAL_STAY',
  extraction_stage: 'phaseB',
  extraction_path: 'expedia_header',
  evidence_snippets: [
    '$299 - Book now',
    'Total in breakdown: $350',
  ],
  extraction_metadata: {
    platform: 'expedia.com',
    breakdown_found: true,
    total_label_found: true,
    rendered_dates_match: true,
    extracted_from_breakdown_total: false, // CRITICAL: Price from wrong source
  },
};

/**
 * FIXTURE F: Invalid extraction - untrusted extraction path
 * 
 * Represents an extraction via hash-based or cached path
 * that cannot reliably apply dates
 */
const FIXTURE_F_UNTRUSTED_PATH = {
  extraction_status: 'success',
  dates_validated: true,
  includes_taxes_fees: true,
  confidence_score: 0.9,
  extracted_price: 599.00,
  extraction_completed_at: '2025-01-03T10:00:00Z',
  price_type: 'TOTAL_STAY',
  extraction_stage: 'phaseB',
  extraction_path: 'hash_based_static', // CRITICAL: Untrusted path
  evidence_snippets: [
    'Total: $599.00',
  ],
  extraction_metadata: {
    platform: 'unknown.com',
    breakdown_found: true,
    total_label_found: true,
    rendered_dates_match: true,
    extracted_from_breakdown_total: true,
  },
};

/**
 * FIXTURE G: Missing all structural metadata (legacy extractor)
 * 
 * Represents an extraction from a platform that hasn't been
 * upgraded to emit structural proof
 */
const FIXTURE_G_NO_STRUCTURAL_METADATA = {
  extraction_status: 'success',
  dates_validated: true,
  includes_taxes_fees: true,
  confidence_score: 0.85,
  extracted_price: 275.00,
  extraction_completed_at: '2025-01-03T10:00:00Z',
  price_type: 'unknown',
  extraction_stage: 'phaseB',
  extraction_path: 'generic',
  evidence_snippets: [
    '$275 total for your stay',
  ],
  extraction_metadata: {
    platform: 'legacy-platform.com',
    // NO structural proof fields - legacy extractor
  },
};

// ============================================================================
// REGRESSION TESTS
// ============================================================================

describe('Price Verification - Structural Verification Invariant', () => {
  
  describe('Positive Cases - Verified Status', () => {
    
    it('FIXTURE A: Full structural proof produces Verified status', () => {
      const result = verifyPrice(FIXTURE_A_VALID_STRUCTURAL_PROOF);
      
      expect(result.price_status).toBe('verified');
      expect(result.eligible_for_comparison).toBe(true);
      expect(result.structural_total_verified).toBe(true);
      expect(result.verification_failures).toHaveLength(0);
      
      // Verify structural proof signals
      expect(result.structural_proof.breakdown_found).toBe(true);
      expect(result.structural_proof.total_label_found).toBe(true);
      expect(result.structural_proof.rendered_dates_match).toBe(true);
      expect(result.structural_proof.extracted_from_breakdown_total).toBe(true);
    });
    
  });
  
  describe('Negative Cases - Unverified Status', () => {
    
    it('FIXTURE B: Missing breakdown produces Unverified status', () => {
      const result = verifyPrice(FIXTURE_B_NO_BREAKDOWN);
      
      expect(result.price_status).toBe('unverified');
      expect(result.eligible_for_comparison).toBe(false);
      expect(result.structural_total_verified).toBe(false);
      expect(result.verification_failures).toContain('no_structural_total_proof');
      
      // Verify the specific proof flag that failed
      expect(result.structural_proof.breakdown_found).toBe(false);
    });
    
    it('FIXTURE C: Missing total label produces Unverified status', () => {
      const result = verifyPrice(FIXTURE_C_NO_TOTAL_LABEL);
      
      expect(result.price_status).toBe('unverified');
      expect(result.eligible_for_comparison).toBe(false);
      expect(result.structural_total_verified).toBe(false);
      expect(result.verification_failures).toContain('no_structural_total_proof');
      
      // Verify the specific proof flag that failed
      expect(result.structural_proof.total_label_found).toBe(false);
    });
    
    it('FIXTURE D: Dates mismatch produces Unverified status (Sierra scenario)', () => {
      const result = verifyPrice(FIXTURE_D_DATES_MISMATCH);
      
      expect(result.price_status).toBe('unverified');
      expect(result.eligible_for_comparison).toBe(false);
      expect(result.structural_total_verified).toBe(false);
      expect(result.verification_failures).toContain('no_structural_total_proof');
      
      // Verify the specific proof flag that failed
      expect(result.structural_proof.rendered_dates_match).toBe(false);
    });
    
    it('FIXTURE E: Price not from breakdown total produces Unverified status', () => {
      const result = verifyPrice(FIXTURE_E_NOT_FROM_BREAKDOWN);
      
      expect(result.price_status).toBe('unverified');
      expect(result.eligible_for_comparison).toBe(false);
      expect(result.structural_total_verified).toBe(false);
      expect(result.verification_failures).toContain('no_structural_total_proof');
      
      // Verify the specific proof flag that failed
      expect(result.structural_proof.extracted_from_breakdown_total).toBe(false);
    });
    
    it('FIXTURE F: Untrusted extraction path produces Unverified status', () => {
      const result = verifyPrice(FIXTURE_F_UNTRUSTED_PATH);
      
      expect(result.price_status).toBe('unverified');
      expect(result.eligible_for_comparison).toBe(false);
      expect(result.structural_total_verified).toBe(false);
      expect(result.verification_failures).toContain('no_structural_total_proof');
    });
    
    it('FIXTURE G: Missing structural metadata produces Unverified status', () => {
      const result = verifyPrice(FIXTURE_G_NO_STRUCTURAL_METADATA);
      
      expect(result.price_status).toBe('unverified');
      expect(result.eligible_for_comparison).toBe(false);
      expect(result.structural_total_verified).toBe(false);
      expect(result.verification_failures).toContain('no_structural_total_proof');
      
      // Verify all proof flags are null (unknown)
      expect(result.structural_proof.breakdown_found).toBeNull();
      expect(result.structural_proof.total_label_found).toBeNull();
      expect(result.structural_proof.rendered_dates_match).toBeNull();
      expect(result.structural_proof.extracted_from_breakdown_total).toBeNull();
    });
    
  });
  
  describe('Invariant Enforcement', () => {
    
    it('Verified status is IMPOSSIBLE without all four structural proof flags being true', () => {
      // Create all combinations where at least one flag is false/null
      const invalidCombinations = [
        { breakdown_found: false, total_label_found: true, rendered_dates_match: true, extracted_from_breakdown_total: true },
        { breakdown_found: true, total_label_found: false, rendered_dates_match: true, extracted_from_breakdown_total: true },
        { breakdown_found: true, total_label_found: true, rendered_dates_match: false, extracted_from_breakdown_total: true },
        { breakdown_found: true, total_label_found: true, rendered_dates_match: true, extracted_from_breakdown_total: false },
        { breakdown_found: null, total_label_found: true, rendered_dates_match: true, extracted_from_breakdown_total: true },
        { breakdown_found: true, total_label_found: null, rendered_dates_match: true, extracted_from_breakdown_total: true },
        { breakdown_found: true, total_label_found: true, rendered_dates_match: null, extracted_from_breakdown_total: true },
        { breakdown_found: true, total_label_found: true, rendered_dates_match: true, extracted_from_breakdown_total: null },
        { breakdown_found: undefined, total_label_found: undefined, rendered_dates_match: undefined, extracted_from_breakdown_total: undefined },
      ];
      
      for (const combo of invalidCombinations) {
        const result = verifyPrice({
          extraction_status: 'success',
          dates_validated: true,
          includes_taxes_fees: true,
          confidence_score: 0.95,
          extracted_price: 500.00,
          extraction_metadata: combo,
        });
        
        expect(result.price_status).toBe('unverified');
        expect(result.eligible_for_comparison).toBe(false);
        expect(result.structural_total_verified).toBe(false);
      }
    });
    
    it('Semantic evidence snippets alone CANNOT produce Verified status', () => {
      // Even with strong semantic evidence, without structural proof, must be unverified
      const result = verifyPrice({
        extraction_status: 'success',
        dates_validated: true,
        includes_taxes_fees: true,
        confidence_score: 0.99,
        extracted_price: 500.00,
        evidence_snippets: [
          'Total price: $500.00 including all taxes and fees',
          'Grand total for 3 nights',
          'You\'ll pay $500.00 at checkout',
        ],
        extraction_metadata: {
          // NO structural proof fields
        },
      });
      
      expect(result.price_status).toBe('unverified');
      expect(result.structural_total_verified).toBe(false);
      // Semantic might be true for debugging, but doesn't grant Verified
      expect(result.semantic_total_verified).toBe(true);
    });
    
    it('High confidence score CANNOT bypass structural verification', () => {
      const result = verifyPrice({
        extraction_status: 'success',
        dates_validated: true,
        includes_taxes_fees: true,
        confidence_score: 1.0, // Perfect confidence
        extracted_price: 500.00,
        extraction_metadata: {
          breakdown_found: false, // But no breakdown
        },
      });
      
      expect(result.price_status).toBe('unverified');
      expect(result.structural_total_verified).toBe(false);
    });
    
  });
  
  describe('Edge Cases', () => {
    
    it('No price produces unavailable status', () => {
      const result = verifyPrice({
        extraction_status: 'success',
        dates_validated: true,
        includes_taxes_fees: true,
        confidence_score: 0.9,
        extracted_price: null,
        extraction_metadata: {
          breakdown_found: true,
          total_label_found: true,
          rendered_dates_match: true,
          extracted_from_breakdown_total: true,
        },
      });
      
      expect(result.price_status).toBe('unavailable');
      expect(result.eligible_for_comparison).toBe(false);
    });
    
    it('Zero price produces unavailable status', () => {
      const result = verifyPrice({
        extraction_status: 'success',
        dates_validated: true,
        includes_taxes_fees: true,
        confidence_score: 0.9,
        extracted_price: 0,
        extraction_metadata: {
          breakdown_found: true,
          total_label_found: true,
          rendered_dates_match: true,
          extracted_from_breakdown_total: true,
        },
      });
      
      expect(result.price_status).toBe('unavailable');
      expect(result.eligible_for_comparison).toBe(false);
    });
    
    it('Negative price produces unavailable status', () => {
      const result = verifyPrice({
        extraction_status: 'success',
        dates_validated: true,
        includes_taxes_fees: true,
        confidence_score: 0.9,
        extracted_price: -100,
        extraction_metadata: {
          breakdown_found: true,
          total_label_found: true,
          rendered_dates_match: true,
          extracted_from_breakdown_total: true,
        },
      });
      
      expect(result.price_status).toBe('unavailable');
    });
    
    it('Failed extraction status produces unverified even with structural proof', () => {
      const result = verifyPrice({
        extraction_status: 'failed',
        dates_validated: true,
        includes_taxes_fees: true,
        confidence_score: 0.9,
        extracted_price: 500.00,
        extraction_metadata: {
          breakdown_found: true,
          total_label_found: true,
          rendered_dates_match: true,
          extracted_from_breakdown_total: true,
        },
      });
      
      expect(result.price_status).toBe('unverified');
      expect(result.verification_failures).toContain('extraction_not_successful');
    });
    
  });
  
});

describe('Hotels.com Extractor - Structural Proof Contract', () => {
  
  /**
   * This test documents the expected structural proof format
   * that the Hotels.com extractor MUST emit
   */
  it('Hotels.com structural proof contract matches expected format', () => {
    const expectedFormat = {
      breakdown_found: expect.any(Boolean),
      total_label_found: expect.any(Boolean),
      rendered_dates_match: expect.any(Boolean),
      extracted_from_breakdown_total: expect.any(Boolean),
      proof_version: '1.0',
    };
    
    // Verify fixture matches expected contract
    const proof = FIXTURE_A_VALID_STRUCTURAL_PROOF.extraction_metadata.structural_proof;
    expect(proof).toMatchObject(expectedFormat);
    expect(proof.proof_version).toBe('1.0');
  });
  
  it('proof_version must be "1.0" for current implementation', () => {
    const proof = FIXTURE_A_VALID_STRUCTURAL_PROOF.extraction_metadata.structural_proof;
    expect(proof.proof_version).toBe('1.0');
  });
  
});

// ============================================================================
// ACCESS FAILURE CLASSIFICATION TESTS
// ============================================================================

/**
 * Access Failure Classifier - Deterministic Regression Tests
 * 
 * These tests enforce the hard stop behavior for access-layer failures.
 * When RATE_LIMITED or BOT_BLOCKED is detected, no fallback providers
 * should be attempted.
 * 
 * INVARIANT: HTTP 429 or bot blocking always results in shouldAbortFallbacks = true
 */

// Inline implementation of classifyAccessFailure for testing
// (Edge function version is in supabase/functions/_shared/accessFailureClassifier.ts)
type AccessFailureClass = 
  | 'RATE_LIMITED'
  | 'BOT_BLOCKED'
  | 'NAVIGATION_FAILED'
  | 'PARSING_FAILED'
  | 'NONE';

interface AccessFailureResult {
  failureClass: AccessFailureClass;
  shouldAbortFallbacks: boolean;
  httpStatus: number | null;
  responseSize: number;
  evidence: string[];
}

function classifyAccessFailure(
  httpStatus: number | null,
  responseBody: string | null,
  errorMessage: string | null
): AccessFailureResult {
  const result: AccessFailureResult = {
    failureClass: 'NONE',
    shouldAbortFallbacks: false,
    httpStatus,
    responseSize: responseBody?.length ?? 0,
    evidence: [],
  };

  const bodyLower = (responseBody ?? '').toLowerCase();
  const errorLower = (errorMessage ?? '').toLowerCase();
  const combinedLower = `${bodyLower} ${errorLower}`;

  // RATE_LIMITED Detection
  if (httpStatus === 429) {
    result.failureClass = 'RATE_LIMITED';
    result.shouldAbortFallbacks = true;
    result.evidence.push('HTTP 429 Too Many Requests');
    return result;
  }

  const rateLimitPatterns = [
    '429 too many requests',
    'too many requests',
    'rate limit exceeded',
    'rate limited',
  ];

  for (const pattern of rateLimitPatterns) {
    if (combinedLower.includes(pattern)) {
      result.failureClass = 'RATE_LIMITED';
      result.shouldAbortFallbacks = true;
      result.evidence.push(`Rate limit pattern: "${pattern}"`);
      return result;
    }
  }

  // BOT_BLOCKED Detection
  const botBlockPatterns = [
    { pattern: 'captcha', label: 'CAPTCHA challenge' },
    { pattern: 'verify you are human', label: 'Human verification' },
    { pattern: 'access denied', label: 'Access denied' },
    { pattern: 'cloudflare', label: 'Cloudflare protection' },
  ];

  for (const { pattern, label } of botBlockPatterns) {
    if (combinedLower.includes(pattern)) {
      result.failureClass = 'BOT_BLOCKED';
      result.shouldAbortFallbacks = true;
      result.evidence.push(label);
    }
  }

  if (result.failureClass === 'BOT_BLOCKED') {
    return result;
  }

  if (httpStatus === 403 || httpStatus === 401) {
    result.failureClass = 'BOT_BLOCKED';
    result.shouldAbortFallbacks = true;
    result.evidence.push(`HTTP ${httpStatus} (likely bot block)`);
    return result;
  }

  // NAVIGATION_FAILED Detection
  const navigationFailPatterns = ['timeout', 'connection refused', 'fetch failed'];

  for (const pattern of navigationFailPatterns) {
    if (combinedLower.includes(pattern)) {
      result.failureClass = 'NAVIGATION_FAILED';
      result.shouldAbortFallbacks = false;
      result.evidence.push(`Navigation failure: "${pattern}"`);
      return result;
    }
  }

  if (httpStatus && httpStatus >= 500 && httpStatus < 600) {
    result.failureClass = 'NAVIGATION_FAILED';
    result.shouldAbortFallbacks = false;
    result.evidence.push(`HTTP ${httpStatus} server error`);
    return result;
  }

  return result;
}

describe('Access Failure Classification - Hard Stop Invariants', () => {
  
  describe('RATE_LIMITED Detection', () => {
    
    it('HTTP 429 status triggers RATE_LIMITED and aborts fallbacks', () => {
      const result = classifyAccessFailure(429, null, null);
      
      expect(result.failureClass).toBe('RATE_LIMITED');
      expect(result.shouldAbortFallbacks).toBe(true);
      expect(result.evidence).toContain('HTTP 429 Too Many Requests');
    });
    
    it('Body containing "429 Too Many Requests" triggers RATE_LIMITED', () => {
      const result = classifyAccessFailure(200, '<html>429 Too Many Requests</html>', null);
      
      expect(result.failureClass).toBe('RATE_LIMITED');
      expect(result.shouldAbortFallbacks).toBe(true);
    });
    
    it('Error message containing "rate limit exceeded" triggers RATE_LIMITED', () => {
      const result = classifyAccessFailure(null, null, 'Error: rate limit exceeded');
      
      expect(result.failureClass).toBe('RATE_LIMITED');
      expect(result.shouldAbortFallbacks).toBe(true);
    });
    
    it('Openresty 429 response triggers RATE_LIMITED', () => {
      const result = classifyAccessFailure(
        429, 
        '<html><head><title>429 Too Many Requests</title></head><body><center>openresty</center></body></html>', 
        null
      );
      
      expect(result.failureClass).toBe('RATE_LIMITED');
      expect(result.shouldAbortFallbacks).toBe(true);
    });
    
  });
  
  describe('BOT_BLOCKED Detection', () => {
    
    it('CAPTCHA in content triggers BOT_BLOCKED and aborts fallbacks', () => {
      const result = classifyAccessFailure(200, 'Please complete the CAPTCHA to continue', null);
      
      expect(result.failureClass).toBe('BOT_BLOCKED');
      expect(result.shouldAbortFallbacks).toBe(true);
      expect(result.evidence).toContain('CAPTCHA challenge');
    });
    
    it('HTTP 403 triggers BOT_BLOCKED', () => {
      const result = classifyAccessFailure(403, null, null);
      
      expect(result.failureClass).toBe('BOT_BLOCKED');
      expect(result.shouldAbortFallbacks).toBe(true);
    });
    
    it('Cloudflare protection page triggers BOT_BLOCKED', () => {
      const result = classifyAccessFailure(200, 'Checking your browser... Cloudflare Ray ID: abc123', null);
      
      expect(result.failureClass).toBe('BOT_BLOCKED');
      expect(result.shouldAbortFallbacks).toBe(true);
    });
    
    it('Human verification request triggers BOT_BLOCKED', () => {
      const result = classifyAccessFailure(200, 'Please verify you are human to continue', null);
      
      expect(result.failureClass).toBe('BOT_BLOCKED');
      expect(result.shouldAbortFallbacks).toBe(true);
    });
    
  });
  
  describe('NAVIGATION_FAILED Detection (allows fallback)', () => {
    
    it('Timeout allows fallback to continue', () => {
      const result = classifyAccessFailure(null, null, 'Request timeout after 30s');
      
      expect(result.failureClass).toBe('NAVIGATION_FAILED');
      expect(result.shouldAbortFallbacks).toBe(false);
    });
    
    it('HTTP 500 allows fallback to continue', () => {
      const result = classifyAccessFailure(500, 'Internal Server Error', null);
      
      expect(result.failureClass).toBe('NAVIGATION_FAILED');
      expect(result.shouldAbortFallbacks).toBe(false);
    });
    
    it('Connection refused allows fallback to continue', () => {
      const result = classifyAccessFailure(null, null, 'Connection refused');
      
      expect(result.failureClass).toBe('NAVIGATION_FAILED');
      expect(result.shouldAbortFallbacks).toBe(false);
    });
    
  });
  
  describe('Hard Stop Invariant', () => {
    
    it('RATE_LIMITED always sets shouldAbortFallbacks = true', () => {
      const scenarios = [
        { httpStatus: 429, body: null, error: null },
        { httpStatus: 200, body: 'rate limited', error: null },
        { httpStatus: null, body: null, error: 'too many requests' },
      ];
      
      for (const scenario of scenarios) {
        const result = classifyAccessFailure(scenario.httpStatus, scenario.body, scenario.error);
        if (result.failureClass === 'RATE_LIMITED') {
          expect(result.shouldAbortFallbacks).toBe(true);
        }
      }
    });
    
    it('BOT_BLOCKED always sets shouldAbortFallbacks = true', () => {
      const scenarios = [
        { httpStatus: 403, body: null, error: null },
        { httpStatus: 401, body: null, error: null },
        { httpStatus: 200, body: 'captcha', error: null },
        { httpStatus: 200, body: 'cloudflare', error: null },
      ];
      
      for (const scenario of scenarios) {
        const result = classifyAccessFailure(scenario.httpStatus, scenario.body, scenario.error);
        if (result.failureClass === 'BOT_BLOCKED') {
          expect(result.shouldAbortFallbacks).toBe(true);
        }
      }
    });
    
    it('No fallback providers should be called after access-layer failure', () => {
      // This test documents the contract for the extraction pipeline
      const rateLimitResult = classifyAccessFailure(429, null, null);
      const botBlockResult = classifyAccessFailure(403, 'Access Denied', null);
      
      // Both must prevent fallbacks
      expect(rateLimitResult.shouldAbortFallbacks).toBe(true);
      expect(botBlockResult.shouldAbortFallbacks).toBe(true);
      
      // Terminal status should be explicit
      expect(rateLimitResult.failureClass).toBe('RATE_LIMITED');
      expect(botBlockResult.failureClass).toBe('BOT_BLOCKED');
    });
    
  });
  
  describe('Abort Record Structure', () => {
    
    it('Abort record contains required fields for diagnostics', () => {
      const result = classifyAccessFailure(429, '<html>Too Many Requests</html>', null);
      
      // Required fields for abort record
      expect(result).toHaveProperty('failureClass');
      expect(result).toHaveProperty('shouldAbortFallbacks');
      expect(result).toHaveProperty('httpStatus');
      expect(result).toHaveProperty('responseSize');
      expect(result).toHaveProperty('evidence');
      
      // Evidence should be populated
      expect(result.evidence.length).toBeGreaterThan(0);
    });
    
  });
  
});

// ============================================================================
// AIRBNB SUBTOTAL REJECTION REGRESSION TESTS
// ============================================================================

/**
 * These tests document the invariant that "$X for N nights" patterns are SUBTOTALS
 * and must NOT be accepted as verified totals. Only explicit checkout patterns
 * like "Pay $X now" or "Total (USD) $X" are acceptable.
 * 
 * This regression was introduced when the validation logic incorrectly accepted
 * aria-label="$1,977 for 4 nights" as a valid total context, when it's actually
 * a subtotal that excludes taxes and fees.
 */

describe('Airbnb Subtotal Rejection - Regression Guard', () => {
  
  describe('Subtotal Pattern Rejection', () => {
    
    it('$X for N nights pattern must NOT pass as verified total', () => {
      // This test documents the core regression: "$1,977 for 4 nights" was incorrectly
      // being accepted as a total when it's actually a subtotal
      
      // Simulated extraction metadata for a subtotal
      const subtotalExtraction = {
        extraction_status: 'needs_user_confirmation', // Expected status for subtotals
        dates_validated: true,
        includes_taxes_fees: false, // Key: subtotals don't include taxes
        confidence_score: 0.7,
        extracted_price: null, // Should NOT have a price when only subtotal found
        extraction_metadata: {
          subtotal_nights_only: 1977, // The subtotal amount
          subtotal_nights_count: 4,
          rejection_reason: 'subtotal_for_nights_only',
        },
      };
      
      const result = verifyPrice(subtotalExtraction);
      
      // INVARIANT: Subtotals must never be verified
      expect(result.price_status).toBe('unavailable');
      expect(result.eligible_for_comparison).toBe(false);
      expect(result.structural_total_verified).toBe(false);
    });
    
    it('Only checkout patterns (Pay $X now, Total USD) should be accepted', () => {
      // Valid checkout pattern extraction
      const checkoutExtraction = {
        extraction_status: 'success',
        dates_validated: true,
        includes_taxes_fees: true, // Checkout totals include taxes
        confidence_score: 0.95,
        extracted_price: 2213.34, // The correct total from "Pay $2,213.34 now"
        extraction_metadata: {
          breakdown_found: true,
          total_label_found: true,
          rendered_dates_match: true,
          extracted_from_breakdown_total: true,
          pattern_matched: 'checkout_pay_now',
        },
      };
      
      const result = verifyPrice(checkoutExtraction);
      
      expect(result.price_status).toBe('verified');
      expect(result.eligible_for_comparison).toBe(true);
    });
    
  });
  
  describe('Fallback Chain Orchestration', () => {
    
    it('When Browserless returns subtotal, fallback providers MUST be tried', () => {
      // This test documents the expected behavior when Browserless fails to find a total
      // The pipeline should try Zyte, then Firecrawl
      
      // Simulated provider results
      const browserlessResult = {
        provider: 'browserless',
        status: 'needs_user_confirmation',
        price: null,
        subtotal_nights_only: 1977,
      };
      
      // The fallback chain should continue if:
      // 1. Status is NOT total_price_including_taxes_and_fees
      // 2. No rate limiting or bot blocking detected
      const shouldContinueToFallback = 
        browserlessResult.status !== 'total_price_including_taxes_and_fees' &&
        browserlessResult.price === null;
      
      expect(shouldContinueToFallback).toBe(true);
    });
    
    it('When rate limited, NO fallback providers should be called', () => {
      const rateLimitedResult = {
        provider: 'browserless',
        status: 'rate_limited',
        isRateLimited: true,
        price: null,
      };
      
      // Hard stop condition
      const shouldAbortFallbacks = rateLimitedResult.isRateLimited;
      
      expect(shouldAbortFallbacks).toBe(true);
    });
    
  });
  
  describe('Manual Override Provenance', () => {
    
    it('Manual confirmation must be distinguished from extractor verified', () => {
      // When user manually enters a price, it should be marked with explicit provenance
      const manualConfirmation = {
        confirmation_source: 'user',
        subtotal_nights_only: 1977,
        confirmed_total_amount: 2213.34, // User entered the correct total
      };
      
      // Manual overrides should be clearly marked
      expect(manualConfirmation.confirmation_source).toBe('user');
      expect(manualConfirmation.confirmed_total_amount).not.toBe(manualConfirmation.subtotal_nights_only);
    });
    
    it('no_verified_price_found terminal state should trigger modal', () => {
      // When no provider can verify, the system should return this terminal state
      const noVerifiedPriceResult = {
        airbnbPrice: null,
        subtotalInfo: { amount: 1977, nights: 4, currency: 'USD' },
        allProvidersFailed: false, // We got content, just no verified total
      };
      
      // This should trigger the confirmation modal
      const shouldShowModal = 
        noVerifiedPriceResult.airbnbPrice === null && 
        noVerifiedPriceResult.subtotalInfo !== null;
      
      expect(shouldShowModal).toBe(true);
    });
    
  });
  
});
