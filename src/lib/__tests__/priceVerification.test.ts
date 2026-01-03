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
