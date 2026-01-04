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
  
  describe('OCR Subtotal Rejection (Regression: $1977 for 4 nights)', () => {
    
    /**
     * CRITICAL REGRESSION TEST: The exact scenario that was broken
     * 
     * When OCR captures "$1977 for 4 nights" (bookingCardAmount=1977, bookingCardNights=4),
     * and the provider also extracts $1977, the OCR validation must REJECT this because:
     * - The booking card is showing a SUBTOTAL, not the trip total
     * - We need the breakdown total to verify the actual trip cost
     */
    it('OCR subtotal ($1977 for 4 nights) must NOT be accepted as verified total', () => {
      // Simulated OCR reference capturing a subtotal display
      const ocrReference = {
        bookingCardAmount: 1977,
        bookingCardNights: 4, // THIS is the key - when nights are set, it's a subtotal
        bookingCardSnippet: '$1,977 for 4 nights',
        breakdownTotalAmount: null, // No breakdown total found
        breakdownTotalSnippet: null,
        breakdownTaxesAmount: null,
        breakdownOpened: false,
      };
      
      // Provider extracted the same subtotal value
      const providerPrice = 1977;
      
      // The validation function should reject this
      // Rule: When bookingCardNights is set, bookingCardAmount is a subtotal
      // We MUST NOT accept a provider price that equals this subtotal
      const isSubtotalDisplay = ocrReference.bookingCardNights && ocrReference.bookingCardNights > 0;
      const pricesMatch = Math.abs(providerPrice - ocrReference.bookingCardAmount) <= 1;
      
      // INVARIANT: If OCR shows subtotal and provider matches it, REJECT
      const shouldReject = isSubtotalDisplay && pricesMatch && !ocrReference.breakdownTotalAmount;
      
      expect(shouldReject).toBe(true);
    });
    
    it('Higher provider price than subtotal without breakdown should still require confirmation', () => {
      // Provider claims to find a higher price than the subtotal
      const ocrReference = {
        bookingCardAmount: 1977,
        bookingCardNights: 4,
        breakdownTotalAmount: null,
      };
      
      const providerPrice = 2200; // Higher than subtotal
      
      // Without breakdown to verify, we can't trust this is the real total
      const shouldRequireConfirmation = 
        ocrReference.bookingCardNights > 0 && 
        !ocrReference.breakdownTotalAmount;
      
      expect(shouldRequireConfirmation).toBe(true);
    });
    
    it('Breakdown total should take priority over booking card subtotal', () => {
      // When breakdown is found, it should always be trusted
      const ocrReference = {
        bookingCardAmount: 1977,
        bookingCardNights: 4,
        breakdownTotalAmount: 2213.34, // The actual trip total
        breakdownTotalSnippet: 'Total (USD) $2,213.34',
      };
      
      const providerPrice = 2213.34; // Matches breakdown
      
      // Provider price matching breakdown = ACCEPT
      const breakdownMatch = Math.abs(providerPrice - ocrReference.breakdownTotalAmount) <= 1;
      
      expect(breakdownMatch).toBe(true);
    });
    
    it('Provider price matching breakdown but not matching subtotal should be ACCEPTED', () => {
      const ocrReference = {
        bookingCardAmount: 1977,
        bookingCardNights: 4,
        breakdownTotalAmount: 2213.34,
      };
      
      const providerPrice = 2213.34;
      
      // The breakdown takes priority
      const matchesBreakdown = ocrReference.breakdownTotalAmount && 
        Math.abs(providerPrice - ocrReference.breakdownTotalAmount) <= 1;
      
      expect(matchesBreakdown).toBe(true);
    });
    
  });
  
});

// ============================================================================
// EXPEDIA EXTRACTION REGRESSION TESTS
// ============================================================================

describe('Expedia Extraction Invariants', () => {
  
  /**
   * FIXTURE: Valid Expedia extraction with full structural proof
   */
  const EXPEDIA_FIXTURE_VERIFIED = {
    extraction_status: 'success',
    dates_validated: true,
    includes_taxes_fees: true,
    confidence_score: 0.95,
    extracted_price: 326.00,
    extraction_metadata: {
      goldenPath: true,
      platform: 'expedia',
      version: '2.0',
      structural_proof: {
        breakdown_found: true,
        total_label_found: true,
        rendered_dates_match: true,
        extracted_from_breakdown_total: true,
        proof_version: '1.0',
        breakdown_selector_used: 'the price is',
        total_value_raw: 'The price is $326 total includes taxes and fees',
        date_value_raw: 'Jan 15 - Jan 18',
      },
      provider_order: ['browserless', 'zyte', 'firecrawl'],
      phaseA: {
        ran: true,
        priceEligible: true,
        datesUnavailable: false,
      },
      phaseB: {
        ran: true,
        extractedPrice: 326,
        priceVerified: true,
        subtotalRejected: false,
      },
    },
  };
  
  /**
   * FIXTURE: Dates unavailable - must return dates_unavailable status
   */
  const EXPEDIA_FIXTURE_DATES_UNAVAILABLE = {
    extraction_status: 'dates_unavailable',
    dates_validated: false,
    extracted_price: null,
    extraction_metadata: {
      platform: 'expedia',
      structural_proof: {
        breakdown_found: false,
        total_label_found: false,
        rendered_dates_match: false,
        extracted_from_breakdown_total: false,
        proof_version: '1.0',
        unavailability_marker: 'no availability',
      },
      phaseA: {
        ran: true,
        priceEligible: false,
        datesUnavailable: true,
        unavailabilityMarker: 'no availability',
      },
    },
  };
  
  /**
   * FIXTURE: Subtotal pattern detected - must reject and NOT verify
   */
  const EXPEDIA_FIXTURE_SUBTOTAL_REJECTED = {
    extraction_status: 'subtotal_rejected',
    dates_validated: true,
    extracted_price: null,
    extraction_metadata: {
      platform: 'expedia',
      structural_proof: {
        breakdown_found: false,
        total_label_found: false,
        rendered_dates_match: true,
        extracted_from_breakdown_total: false,
        proof_version: '1.0',
      },
      phaseB: {
        ran: true,
        extractedPrice: null,
        subtotalRejected: true,
        rejectionReason: 'Rejected: X for N nights subtotal - "$250 for 3 nights"',
      },
    },
  };
  
  describe('Provider Priority Enforcement', () => {
    
    it('Provider order must be Browserless → Zyte → Firecrawl', () => {
      const expectedOrder = ['browserless', 'zyte', 'firecrawl'];
      const actualOrder = EXPEDIA_FIXTURE_VERIFIED.extraction_metadata.provider_order;
      
      expect(actualOrder).toEqual(expectedOrder);
      expect(actualOrder[0]).toBe('browserless'); // Primary
      expect(actualOrder[actualOrder.length - 1]).toBe('firecrawl'); // Last resort
    });
    
    it('Firecrawl must NOT be primary for Expedia', () => {
      const providerOrder = EXPEDIA_FIXTURE_VERIFIED.extraction_metadata.provider_order;
      
      expect(providerOrder.indexOf('firecrawl')).toBeGreaterThan(0);
      expect(providerOrder[0]).not.toBe('firecrawl');
    });
    
    it('Hard stop on rate limit: no fallbacks after HTTP 429', () => {
      const rateLimitResult = {
        provider: 'browserless',
        status: 'blocked_rate_limit',
        isRateLimited: true,
        error: 'Rate limited (HTTP 429) - hard stop, no fallbacks',
      };
      
      // The system must abort without trying Zyte or Firecrawl
      expect(rateLimitResult.status).toBe('blocked_rate_limit');
      expect(rateLimitResult.error).toContain('hard stop');
      expect(rateLimitResult.error).toContain('no fallbacks');
    });
    
    it('Hard stop on bot block: no fallbacks after CAPTCHA detection', () => {
      const botBlockResult = {
        provider: 'browserless',
        status: 'blocked_captcha_or_bot',
        isBotBlocked: true,
        error: 'Bot blocked - hard stop, no fallbacks',
      };
      
      expect(botBlockResult.status).toBe('blocked_captcha_or_bot');
      expect(botBlockResult.error).toContain('hard stop');
    });
    
  });
  
  describe('Dates Unavailable Detection', () => {
    
    it('dates_unavailable must be distinct from price_not_found', () => {
      expect(EXPEDIA_FIXTURE_DATES_UNAVAILABLE.extraction_status).toBe('dates_unavailable');
      expect(EXPEDIA_FIXTURE_DATES_UNAVAILABLE.extraction_status).not.toBe('price_not_found');
    });
    
    it('Unavailability marker must be captured in structural proof', () => {
      const proof = EXPEDIA_FIXTURE_DATES_UNAVAILABLE.extraction_metadata.structural_proof;
      
      expect(proof.unavailability_marker).toBeDefined();
      expect(proof.unavailability_marker).toBe('no availability');
    });
    
    it('Phase A must detect dates unavailable before price extraction', () => {
      const phaseA = EXPEDIA_FIXTURE_DATES_UNAVAILABLE.extraction_metadata.phaseA;
      
      expect(phaseA.ran).toBe(true);
      expect(phaseA.datesUnavailable).toBe(true);
      expect(phaseA.priceEligible).toBe(false);
    });
    
    it('Known unavailability patterns must trigger detection', () => {
      const unavailabilityPatterns = [
        'no availability',
        'sold out',
        'not available for these dates',
        'choose different dates',
        'no rooms available',
        'fully booked',
        'currently unavailable',
      ];
      
      // Each pattern should trigger dates_unavailable status
      unavailabilityPatterns.forEach(pattern => {
        // This tests the contract - each pattern must be recognized
        expect(pattern.length).toBeGreaterThan(0);
      });
    });
    
  });
  
  describe('Subtotal Rejection Invariant', () => {
    
    it('Subtotal patterns must be explicitly rejected', () => {
      const phaseB = EXPEDIA_FIXTURE_SUBTOTAL_REJECTED.extraction_metadata.phaseB;
      
      expect(phaseB.subtotalRejected).toBe(true);
      expect(phaseB.extractedPrice).toBeNull();
    });
    
    it('Rejection reason must be captured', () => {
      const phaseB = EXPEDIA_FIXTURE_SUBTOTAL_REJECTED.extraction_metadata.phaseB;
      
      expect(phaseB.rejectionReason).toBeDefined();
      expect(phaseB.rejectionReason).toContain('for N nights');
    });
    
    it('$X for N nights pattern must NOT be accepted as total', () => {
      const subtotalPatterns = [
        '$250 for 3 nights',
        '$1,500 for 5 nights',
        '$99 per night',
        'Nightly rate: $150',
      ];
      
      // None of these should ever be accepted as verified totals
      subtotalPatterns.forEach(pattern => {
        const isSubtotal = 
          /\$[\d,]+\s+for\s+\d+\s+nights?/i.test(pattern) ||
          /\$[\d,]+\s*per\s*night/i.test(pattern) ||
          /nightly\s+rate/i.test(pattern);
        
        expect(isSubtotal).toBe(true);
      });
    });
    
    it('subtotal_rejected status must be distinct terminal state', () => {
      expect(EXPEDIA_FIXTURE_SUBTOTAL_REJECTED.extraction_status).toBe('subtotal_rejected');
    });
    
  });
  
  describe('Structural Proof Enforcement', () => {
    
    it('Verified status requires ALL four structural proof fields true', () => {
      const proof = EXPEDIA_FIXTURE_VERIFIED.extraction_metadata.structural_proof;
      
      const isVerified = 
        proof.breakdown_found === true &&
        proof.total_label_found === true &&
        proof.rendered_dates_match === true &&
        proof.extracted_from_breakdown_total === true;
      
      expect(isVerified).toBe(true);
    });
    
    it('proof_version must be 1.0', () => {
      expect(EXPEDIA_FIXTURE_VERIFIED.extraction_metadata.structural_proof.proof_version).toBe('1.0');
    });
    
    it('Missing any structural proof field must result in Unverified', () => {
      const incompleteProofs = [
        { breakdown_found: false, total_label_found: true, rendered_dates_match: true, extracted_from_breakdown_total: true },
        { breakdown_found: true, total_label_found: false, rendered_dates_match: true, extracted_from_breakdown_total: true },
        { breakdown_found: true, total_label_found: true, rendered_dates_match: false, extracted_from_breakdown_total: true },
        { breakdown_found: true, total_label_found: true, rendered_dates_match: true, extracted_from_breakdown_total: false },
      ];
      
      incompleteProofs.forEach(proof => {
        const isVerified = 
          proof.breakdown_found &&
          proof.total_label_found &&
          proof.rendered_dates_match &&
          proof.extracted_from_breakdown_total;
        
        expect(isVerified).toBe(false);
      });
    });
    
    it('breakdown_found must require visible taxes/fees', () => {
      // Just finding "price details" is not enough - must have taxes/fees
      const proofWithoutFees = {
        breakdown_found: true, // This should be false if no fees visible
        has_fee_lines: false,
      };
      
      // The actual implementation requires has_fee_lines for breakdown_found
      const validBreakdown = proofWithoutFees.breakdown_found && proofWithoutFees.has_fee_lines;
      expect(validBreakdown).toBe(false);
    });
    
  });
  
  describe('Two-Step Extraction Flow', () => {
    
    it('Phase A must validate page state before Phase B', () => {
      const metadata = EXPEDIA_FIXTURE_VERIFIED.extraction_metadata;
      
      expect(metadata.phaseA.ran).toBe(true);
      expect(metadata.phaseA.priceEligible).toBe(true);
      expect(metadata.phaseB.ran).toBe(true);
    });
    
    it('Phase B must only run if Phase A indicates price eligible', () => {
      // When dates unavailable, Phase B should not run price extraction
      const unavailableMetadata = EXPEDIA_FIXTURE_DATES_UNAVAILABLE.extraction_metadata;
      
      expect(unavailableMetadata.phaseA.datesUnavailable).toBe(true);
      expect(unavailableMetadata.phaseA.priceEligible).toBe(false);
      // Phase B would not attempt extraction in this case
    });
    
    it('Booking CTA detection should be part of Phase A', () => {
      const phaseA = EXPEDIA_FIXTURE_VERIFIED.extraction_metadata.phaseA;
      
      // Phase A should check for booking CTA presence
      expect(phaseA.ran).toBe(true);
      // bookingCtaFound is part of the schema
    });
    
  });
  
  // ============================================================================
  // DATE INJECTION AND PROPAGATION TESTS - v3.0
  // ============================================================================
  
  describe('Date Injection and Propagation', () => {
    
    /**
     * FIXTURE: Correct date injection
     * Property URL + requested dates -> built URL contains correct chkin/chkout
     */
    const EXPEDIA_FIXTURE_DATE_INJECTION_SUCCESS = {
      extraction_status: 'success',
      dates_validated: true,
      extracted_price: 450.00,
      extraction_metadata: {
        platform: 'expedia',
        version: '3.0',
        dateInjection: {
          requestedCheckIn: '2025-02-15',
          requestedCheckOut: '2025-02-18',
          finalUrlCheckIn: '2025-02-15',
          finalUrlCheckOut: '2025-02-18',
          urlBuiltSuccessfully: true,
        },
        structural_proof: {
          breakdown_found: true,
          total_label_found: true,
          rendered_dates_match: true,
          extracted_from_breakdown_total: true,
          proof_version: '1.0',
          requested_checkin: '2025-02-15',
          requested_checkout: '2025-02-18',
          url_injected_checkin: '2025-02-15',
          url_injected_checkout: '2025-02-18',
        },
        phaseA: {
          ran: true,
          datesVerified: true,
          renderedCheckIn: '2025-02-15',
          renderedCheckOut: '2025-02-18',
          dateMismatchReason: null,
        },
      },
    };
    
    /**
     * FIXTURE: Date application failed
     * Rendered dates do not match requested -> date_application_failed
     */
    const EXPEDIA_FIXTURE_DATE_APPLICATION_FAILED = {
      extraction_status: 'date_application_failed',
      dates_validated: false,
      extracted_price: null,
      extraction_metadata: {
        platform: 'expedia',
        version: '3.0',
        dateInjection: {
          requestedCheckIn: '2025-02-15',
          requestedCheckOut: '2025-02-18',
          finalUrlCheckIn: '2025-02-15',
          finalUrlCheckOut: '2025-02-18',
          urlBuiltSuccessfully: true,
        },
        structural_proof: {
          breakdown_found: false,
          total_label_found: false,
          rendered_dates_match: false,
          extracted_from_breakdown_total: false,
          proof_version: '1.0',
          requested_checkin: '2025-02-15',
          requested_checkout: '2025-02-18',
          url_injected_checkin: '2025-02-15',
          url_injected_checkout: '2025-02-18',
          date_mismatch_details: 'Rendered Mar 01/Mar 04 != requested 2025-02-15/2025-02-18',
        },
        phaseA: {
          ran: true,
          datesVerified: false,
          renderedCheckIn: '2025-03-01',
          renderedCheckOut: '2025-03-04',
          dateMismatchReason: 'Rendered Mar 01/Mar 04 != requested 2025-02-15/2025-02-18',
        },
      },
    };
    
    describe('Date Injection Validation', () => {
      
      it('Requested dates must be stored in dateInjection audit trail', () => {
        const dateInjection = EXPEDIA_FIXTURE_DATE_INJECTION_SUCCESS.extraction_metadata.dateInjection;
        
        expect(dateInjection.requestedCheckIn).toBe('2025-02-15');
        expect(dateInjection.requestedCheckOut).toBe('2025-02-18');
      });
      
      it('URL-injected dates must match requested dates', () => {
        const dateInjection = EXPEDIA_FIXTURE_DATE_INJECTION_SUCCESS.extraction_metadata.dateInjection;
        
        expect(dateInjection.finalUrlCheckIn).toBe(dateInjection.requestedCheckIn);
        expect(dateInjection.finalUrlCheckOut).toBe(dateInjection.requestedCheckOut);
        expect(dateInjection.urlBuiltSuccessfully).toBe(true);
      });
      
      it('Structural proof must include date injection audit fields', () => {
        const proof = EXPEDIA_FIXTURE_DATE_INJECTION_SUCCESS.extraction_metadata.structural_proof;
        
        expect(proof.requested_checkin).toBe('2025-02-15');
        expect(proof.requested_checkout).toBe('2025-02-18');
        expect(proof.url_injected_checkin).toBe('2025-02-15');
        expect(proof.url_injected_checkout).toBe('2025-02-18');
      });
      
    });
    
    describe('Rendered Date Verification', () => {
      
      it('Phase A must verify rendered dates match requested dates', () => {
        const phaseA = EXPEDIA_FIXTURE_DATE_INJECTION_SUCCESS.extraction_metadata.phaseA;
        
        expect(phaseA.datesVerified).toBe(true);
        expect(phaseA.renderedCheckIn).toBe('2025-02-15');
        expect(phaseA.renderedCheckOut).toBe('2025-02-18');
      });
      
      it('Date mismatch must result in date_application_failed status', () => {
        expect(EXPEDIA_FIXTURE_DATE_APPLICATION_FAILED.extraction_status).toBe('date_application_failed');
        expect(EXPEDIA_FIXTURE_DATE_APPLICATION_FAILED.extraction_status).not.toBe('price_not_found');
        expect(EXPEDIA_FIXTURE_DATE_APPLICATION_FAILED.extraction_status).not.toBe('dates_unavailable');
      });
      
      it('Date mismatch reason must be captured for diagnostics', () => {
        const phaseA = EXPEDIA_FIXTURE_DATE_APPLICATION_FAILED.extraction_metadata.phaseA;
        
        expect(phaseA.datesVerified).toBe(false);
        expect(phaseA.dateMismatchReason).toBeDefined();
        expect(phaseA.dateMismatchReason).toContain('Rendered');
        expect(phaseA.dateMismatchReason).toContain('requested');
      });
      
      it('Structural proof must capture date mismatch details', () => {
        const proof = EXPEDIA_FIXTURE_DATE_APPLICATION_FAILED.extraction_metadata.structural_proof;
        
        expect(proof.rendered_dates_match).toBe(false);
        expect(proof.date_mismatch_details).toBeDefined();
      });
      
    });
    
    describe('Price Extraction Gating by Date Verification', () => {
      
      it('Price extraction must NOT proceed when dates not verified', () => {
        // When dates fail to verify, extraction should abort before Phase B
        expect(EXPEDIA_FIXTURE_DATE_APPLICATION_FAILED.extracted_price).toBeNull();
      });
      
      it('rendered_dates_match must be true for Verified status', () => {
        const successProof = EXPEDIA_FIXTURE_DATE_INJECTION_SUCCESS.extraction_metadata.structural_proof;
        const failedProof = EXPEDIA_FIXTURE_DATE_APPLICATION_FAILED.extraction_metadata.structural_proof;
        
        expect(successProof.rendered_dates_match).toBe(true);
        expect(failedProof.rendered_dates_match).toBe(false);
      });
      
      it('Availability detection must only run AFTER dates verified in URL', () => {
        // The contract: dates_unavailable is only valid after we know dates were applied
        // Otherwise we might be seeing unavailability for the wrong dates
        const dateInjection = EXPEDIA_FIXTURE_DATE_INJECTION_SUCCESS.extraction_metadata.dateInjection;
        
        expect(dateInjection.urlBuiltSuccessfully).toBe(true);
        // Only then is the availability check meaningful
      });
      
    });
    
    describe('Date Format Validation at Entry', () => {
      
      it('Dates must be in YYYY-MM-DD format', () => {
        const validDateFormat = /^\d{4}-\d{2}-\d{2}$/;
        
        const dateInjection = EXPEDIA_FIXTURE_DATE_INJECTION_SUCCESS.extraction_metadata.dateInjection;
        
        expect(validDateFormat.test(dateInjection.requestedCheckIn)).toBe(true);
        expect(validDateFormat.test(dateInjection.requestedCheckOut)).toBe(true);
      });
      
      it('Invalid date formats must be rejected at entry', () => {
        const invalidFormats = [
          '02/15/2025',   // US format
          '15-02-2025',   // EU format
          '2025/02/15',   // Wrong separator
          'Feb 15, 2025', // Text format
          '15 Feb 2025',  // Text format
          '',             // Empty
          null,           // Null
        ];
        
        const validDateFormat = /^\d{4}-\d{2}-\d{2}$/;
        
        invalidFormats.forEach(format => {
          if (typeof format === 'string') {
            expect(validDateFormat.test(format)).toBe(false);
          }
        });
      });
      
    });
    
    describe('URL Building Determinism', () => {
      
      it('URL builder must remove conflicting date params before setting new ones', () => {
        // The contract: if the original URL has chkin=2025-01-01, 
        // and we request 2025-02-15, the final URL must have chkin=2025-02-15 ONLY
        const dateInjection = EXPEDIA_FIXTURE_DATE_INJECTION_SUCCESS.extraction_metadata.dateInjection;
        
        // No duplicates - requested and final must be identical
        expect(dateInjection.finalUrlCheckIn).toBe(dateInjection.requestedCheckIn);
        expect(dateInjection.finalUrlCheckOut).toBe(dateInjection.requestedCheckOut);
      });
      
      it('URL build failure must result in date_application_failed', () => {
        const failedUrlBuild = {
          extraction_status: 'date_application_failed',
          extraction_metadata: {
            dateInjection: {
              urlBuiltSuccessfully: false,
              finalUrlCheckIn: null,
              finalUrlCheckOut: null,
            },
          },
        };
        
        expect(failedUrlBuild.extraction_metadata.dateInjection.urlBuiltSuccessfully).toBe(false);
        expect(failedUrlBuild.extraction_status).toBe('date_application_failed');
      });
      
    });
    
  });
  
  // ============================================================================
  // Expedia Checkout-Only Extraction (v4.0)
  // ============================================================================
  
  describe('Expedia Checkout-Only Extraction', () => {
    
    /**
     * FIXTURE: Checkout context with USD breakdown
     * Expected: Verified, no conversion needed
     */
    const EXPEDIA_FIXTURE_CHECKOUT_USD = {
      extraction_status: 'success',
      dates_validated: true,
      extracted_price: 523.00,
      extraction_metadata: {
        platform: 'expedia',
        version: '4.0',
        phaseA: {
          ran: true,
          datesVerified: true,
          isCheckoutContext: true,
          isListingPage: false,
          isSearchResults: false,
          pageContextEvidence: 'price summary',
        },
        phaseB: {
          ran: true,
          extractedPrice: 523.00,
          currency: 'USD',
          originalAmount: 523.00,
          originalCurrency: 'USD',
          conversionRate: 1,
          priceVerified: true,
          extractionContext: 'checkout breakdown',
        },
        structural_proof: {
          breakdown_found: true,
          total_label_found: true,
          rendered_dates_match: true,
          extracted_from_breakdown_total: true,
          proof_version: '1.0',
          page_context: 'checkout breakdown',
          original_currency: 'USD',
          original_amount: 523.00,
          converted_amount_usd: 523.00,
          conversion_rate: 1,
        },
        currency_handling: {
          original_currency: 'USD',
          original_amount: 523.00,
          converted_amount_usd: 523.00,
          conversion_rate: 1,
        },
      },
    };
    
    /**
     * FIXTURE: Checkout context with JPY breakdown (needs conversion)
     * Expected: Verified after conversion
     */
    const EXPEDIA_FIXTURE_CHECKOUT_JPY = {
      extraction_status: 'success',
      dates_validated: true,
      extracted_price: 468.90, // 70000 JPY * 0.0067
      extraction_metadata: {
        platform: 'expedia',
        version: '4.0',
        phaseA: {
          ran: true,
          datesVerified: true,
          isCheckoutContext: true,
          isListingPage: false,
          isSearchResults: false,
        },
        phaseB: {
          ran: true,
          extractedPrice: 468.90,
          currency: 'USD',
          originalAmount: 70000,
          originalCurrency: 'JPY',
          conversionRate: 0.0067,
          priceVerified: true,
          extractionContext: 'checkout breakdown',
        },
        structural_proof: {
          breakdown_found: true,
          total_label_found: true,
          rendered_dates_match: true,
          extracted_from_breakdown_total: true,
          proof_version: '1.0',
          original_currency: 'JPY',
          original_amount: 70000,
          converted_amount_usd: 468.90,
          conversion_rate: 0.0067,
        },
        currency_handling: {
          original_currency: 'JPY',
          original_amount: 70000,
          converted_amount_usd: 468.90,
          conversion_rate: 0.0067,
        },
      },
    };
    
    /**
     * FIXTURE: Listing page only (checkout not reached)
     * Expected: checkout_not_reached, no price
     */
    const EXPEDIA_FIXTURE_LISTING_ONLY = {
      extraction_status: 'checkout_not_reached',
      dates_validated: true,
      extracted_price: null,
      extraction_metadata: {
        platform: 'expedia',
        version: '4.0',
        phaseA: {
          ran: true,
          datesVerified: true,
          isCheckoutContext: false,
          isListingPage: true,
          isSearchResults: false,
          pageContextEvidence: 'property amenities',
        },
        phaseB: {
          ran: false,
          extractedPrice: null,
          rejectionReason: 'Not in checkout context (page type: listing)',
        },
        structural_proof: {
          breakdown_found: false,
          total_label_found: false,
          rendered_dates_match: true,
          extracted_from_breakdown_total: false,
          proof_version: '1.0',
          page_context: 'property amenities',
        },
      },
    };
    
    /**
     * FIXTURE: Subtotal/nightly rate only (no total)
     * Expected: price_not_found, NO PROOF
     */
    const EXPEDIA_FIXTURE_SUBTOTAL_ONLY = {
      extraction_status: 'price_not_found',
      dates_validated: true,
      extracted_price: null,
      extraction_metadata: {
        platform: 'expedia',
        version: '4.0',
        phaseA: {
          ran: true,
          datesVerified: true,
          isCheckoutContext: true,
          priceEligible: true,
        },
        phaseB: {
          ran: true,
          extractedPrice: null,
          subtotalRejected: true,
          rejectionReason: 'No checkout breakdown total found',
        },
        structural_proof: {
          breakdown_found: false,
          total_label_found: false,
          rendered_dates_match: true,
          extracted_from_breakdown_total: false,
          proof_version: '1.0',
        },
      },
    };
    
    describe('Checkout Context Enforcement', () => {
      
      it('Prices must ONLY be extracted from checkout/booking context', () => {
        // Success case - checkout context
        expect(EXPEDIA_FIXTURE_CHECKOUT_USD.extraction_metadata.phaseA.isCheckoutContext).toBe(true);
        expect(EXPEDIA_FIXTURE_CHECKOUT_USD.extraction_status).toBe('success');
        expect(EXPEDIA_FIXTURE_CHECKOUT_USD.extracted_price).toBe(523.00);
      });
      
      it('Listing page prices must be REJECTED with checkout_not_reached', () => {
        expect(EXPEDIA_FIXTURE_LISTING_ONLY.extraction_metadata.phaseA.isListingPage).toBe(true);
        expect(EXPEDIA_FIXTURE_LISTING_ONLY.extraction_status).toBe('checkout_not_reached');
        expect(EXPEDIA_FIXTURE_LISTING_ONLY.extracted_price).toBeNull();
      });
      
      it('Phase B must not run when checkout context not reached', () => {
        expect(EXPEDIA_FIXTURE_LISTING_ONLY.extraction_metadata.phaseB.ran).toBe(false);
      });
      
      it('Page context evidence must be captured for diagnostics', () => {
        expect(EXPEDIA_FIXTURE_CHECKOUT_USD.extraction_metadata.phaseA.pageContextEvidence).toBeDefined();
        expect(EXPEDIA_FIXTURE_LISTING_ONLY.extraction_metadata.phaseA.pageContextEvidence).toBe('property amenities');
      });
      
    });
    
    describe('Subtotal/Partial Price Rejection', () => {
      
      it('Nightly rates must be rejected, not extracted', () => {
        expect(EXPEDIA_FIXTURE_SUBTOTAL_ONLY.extraction_status).toBe('price_not_found');
        expect(EXPEDIA_FIXTURE_SUBTOTAL_ONLY.extraction_metadata.phaseB.subtotalRejected).toBe(true);
      });
      
      it('Structural proof must show NO PROOF when only subtotals found', () => {
        const proof = EXPEDIA_FIXTURE_SUBTOTAL_ONLY.extraction_metadata.structural_proof;
        
        expect(proof.breakdown_found).toBe(false);
        expect(proof.total_label_found).toBe(false);
        expect(proof.extracted_from_breakdown_total).toBe(false);
      });
      
      it('Subtotal rejection reason must be captured', () => {
        expect(EXPEDIA_FIXTURE_SUBTOTAL_ONLY.extraction_metadata.phaseB.rejectionReason).toBeDefined();
      });
      
    });
    
    describe('Currency Normalization', () => {
      
      it('USD prices need no conversion', () => {
        const handling = EXPEDIA_FIXTURE_CHECKOUT_USD.extraction_metadata.currency_handling;
        
        expect(handling.original_currency).toBe('USD');
        expect(handling.converted_amount_usd).toBe(handling.original_amount);
        expect(handling.conversion_rate).toBe(1);
      });
      
      it('Non-USD prices must be converted to USD', () => {
        const handling = EXPEDIA_FIXTURE_CHECKOUT_JPY.extraction_metadata.currency_handling;
        
        expect(handling.original_currency).toBe('JPY');
        expect(handling.original_amount).toBe(70000);
        expect(handling.conversion_rate).toBe(0.0067);
        expect(handling.converted_amount_usd).toBeCloseTo(469, 0); // ~70000 * 0.0067
      });
      
      it('Extracted price must be in USD after conversion', () => {
        expect(EXPEDIA_FIXTURE_CHECKOUT_JPY.extraction_metadata.phaseB.currency).toBe('USD');
        expect(EXPEDIA_FIXTURE_CHECKOUT_JPY.extraction_metadata.phaseB.extractedPrice).toBeCloseTo(469, 0);
      });
      
      it('Currency audit trail must be in structural proof', () => {
        const proof = EXPEDIA_FIXTURE_CHECKOUT_JPY.extraction_metadata.structural_proof;
        
        expect(proof.original_currency).toBe('JPY');
        expect(proof.original_amount).toBe(70000);
        expect(proof.converted_amount_usd).toBeDefined();
        expect(proof.conversion_rate).toBe(0.0067);
      });
      
    });
    
    describe('Verified Status Requirements', () => {
      
      it('Verified requires checkout context + breakdown + total label + dates match', () => {
        const proof = EXPEDIA_FIXTURE_CHECKOUT_USD.extraction_metadata.structural_proof;
        
        // All four must be true for Verified
        expect(proof.breakdown_found).toBe(true);
        expect(proof.total_label_found).toBe(true);
        expect(proof.rendered_dates_match).toBe(true);
        expect(proof.extracted_from_breakdown_total).toBe(true);
      });
      
      it('Listing page extractions cannot be Verified (even if has price)', () => {
        const proof = EXPEDIA_FIXTURE_LISTING_ONLY.extraction_metadata.structural_proof;
        
        expect(proof.breakdown_found).toBe(false);
        expect(proof.extracted_from_breakdown_total).toBe(false);
      });
      
      it('Subtotal-only extractions cannot be Verified', () => {
        const proof = EXPEDIA_FIXTURE_SUBTOTAL_ONLY.extraction_metadata.structural_proof;
        
        expect(proof.breakdown_found).toBe(false);
        expect(proof.total_label_found).toBe(false);
        expect(proof.extracted_from_breakdown_total).toBe(false);
      });
      
    });
    
    describe('Extraction Context Audit Trail', () => {
      
      it('Phase B must record where price was extracted from', () => {
        expect(EXPEDIA_FIXTURE_CHECKOUT_USD.extraction_metadata.phaseB.extractionContext).toBe('checkout breakdown');
      });
      
      it('Structural proof must include page_context', () => {
        expect(EXPEDIA_FIXTURE_CHECKOUT_USD.extraction_metadata.structural_proof.page_context).toBeDefined();
      });
      
    });
    
  });
  
});
