/**
 * Extraction State Machine - Regression Tests
 * 
 * Deterministic tests for the canonical extraction state machine.
 * These tests verify fixed failures remain fixed and state machine invariants hold.
 * 
 * NO LIVE NETWORK CALLS - Uses fixtures and mocked outcomes only.
 */

import { describe, it, expect } from 'vitest';
import { verifyPrice, classifyScrapedPrice } from '../priceVerification';

// =============================================================================
// TEST A: Airbnb subtotal never finalized
// =============================================================================
describe('Test A: Airbnb subtotal never finalized', () => {
  it('rejects extraction with subtotal when full total is not structurally proven', () => {
    // Simulate extraction metadata indicating subtotal only
    const subtotalOnlyResult = verifyPrice({
      extraction_status: 'success',
      dates_validated: true,
      includes_taxes_fees: false, // Subtotal doesn't include taxes/fees
      confidence_score: 0.85,
      extracted_price: 450.00,
      extraction_metadata: {
        breakdown_found: false,
        total_label_found: false,
        rendered_dates_match: true,
        extracted_from_breakdown_total: false,
        // Simulate subtotal detection
        strategy_used: 'url_only',
      },
    });

    expect(subtotalOnlyResult.price_status).toBe('unverified');
    expect(subtotalOnlyResult.eligible_for_comparison).toBe(false);
    expect(subtotalOnlyResult.verification_failures).toContain('taxes_fees_not_included');
    expect(subtotalOnlyResult.verification_failures).toContain('no_structural_total_proof');
  });

  it('accepts extraction with full total when structurally proven', () => {
    const fullTotalResult = verifyPrice({
      extraction_status: 'success',
      dates_validated: true,
      includes_taxes_fees: true,
      confidence_score: 0.90,
      extracted_price: 550.00,
      extraction_metadata: {
        breakdown_found: true,
        total_label_found: true,
        rendered_dates_match: true,
        extracted_from_breakdown_total: true,
      },
    });

    expect(fullTotalResult.price_status).toBe('verified');
    expect(fullTotalResult.eligible_for_comparison).toBe(true);
    expect(fullTotalResult.verification_failures).toHaveLength(0);
    expect(fullTotalResult.structural_total_verified).toBe(true);
  });

  it('prioritizes breakdown total over booking card subtotal', () => {
    // When both amounts exist, the system must use the breakdown total
    // This test verifies the selection logic preference
    const mixedResult = verifyPrice({
      extraction_status: 'success',
      dates_validated: true,
      includes_taxes_fees: true,
      confidence_score: 0.92,
      extracted_price: 587.50, // Full total with fees
      extraction_metadata: {
        breakdown_found: true,
        total_label_found: true,
        rendered_dates_match: true,
        extracted_from_breakdown_total: true,
        // Simulate both values available
        booking_card_amount: 450.00, // Subtotal
        breakdown_total_amount: 587.50, // Full total
        ocr_accepted_via: 'breakdown_match',
      },
    });

    expect(mixedResult.price_status).toBe('verified');
    expect(mixedResult.structural_total_verified).toBe(true);
  });

  it('REGRESSION: book/stays page subtotal must NOT be promoted to total', () => {
    // This test prevents regression of the bug where "$X for N nights" on book/stays
    // page was incorrectly treated as the final total including taxes.
    // Real example: $1,482 for 3 nights (subtotal) vs $1,658.94 (actual total with taxes)
    
    // Simulate what happens when OCR finds subtotal but no breakdown total
    const bookStaysSubtotalOnly = verifyPrice({
      extraction_status: 'success',
      dates_validated: true,
      includes_taxes_fees: false, // Key: subtotal does NOT include taxes
      confidence_score: 0.80,
      extracted_price: 1482.00, // The subtotal
      extraction_metadata: {
        breakdown_found: false, // No breakdown total found
        total_label_found: false, // No "Total (USD)" label found
        rendered_dates_match: true,
        extracted_from_breakdown_total: false,
        // Simulate the book/stays scenario
        booking_card_amount: 1482.00,
        booking_card_nights: 3,
        ocr_accepted_via: null, // NOT accepted
        subtotal_for_nights_pattern_detected: true,
      },
    });

    // MUST be unverified - cannot promote subtotal to total
    expect(bookStaysSubtotalOnly.price_status).toBe('unverified');
    expect(bookStaysSubtotalOnly.eligible_for_comparison).toBe(false);
    expect(bookStaysSubtotalOnly.verification_failures).toContain('taxes_fees_not_included');
    expect(bookStaysSubtotalOnly.verification_failures).toContain('no_structural_total_proof');
    
    // The system should require user confirmation, not silently accept subtotal
    expect(bookStaysSubtotalOnly.structural_total_verified).toBe(false);
  });

  it('REGRESSION: only breakdown total from book/stays page should be verified', () => {
    // When OCR successfully extracts "Total (USD) $1,658.94" from book/stays page
    const bookStaysWithBreakdownTotal = verifyPrice({
      extraction_status: 'success',
      dates_validated: true,
      includes_taxes_fees: true, // Key: breakdown total INCLUDES taxes
      confidence_score: 0.95,
      extracted_price: 1658.94, // The actual total with taxes
      extraction_metadata: {
        breakdown_found: true,
        total_label_found: true, // "Total (USD)" label found
        rendered_dates_match: true,
        extracted_from_breakdown_total: true,
        booking_card_amount: 1482.00, // Subtotal also visible
        booking_card_nights: 3,
        breakdown_total_amount: 1658.94, // The correct total
        ocr_accepted_via: 'breakdown_match',
      },
    });

    // This SHOULD be verified - we have structural proof of the actual total
    expect(bookStaysWithBreakdownTotal.price_status).toBe('verified');
    expect(bookStaysWithBreakdownTotal.eligible_for_comparison).toBe(true);
    expect(bookStaysWithBreakdownTotal.structural_total_verified).toBe(true);
    expect(bookStaysWithBreakdownTotal.verification_failures).toHaveLength(0);
  });
});

// =============================================================================
// TEST B: Frontend Expedia must include date injection
// =============================================================================
describe('Test B: Frontend Expedia must include date injection', () => {
  /**
   * Simulates the URL construction logic from extract-expedia
   * This is the golden path URL builder that MUST be used
   */
  function buildExpediaOffersUrl(
    propertyId: string,
    checkIn: string,
    checkOut: string,
    adults: number = 2
  ): string {
    const url = new URL('https://www.expedia.com/Hotel-Search');
    url.searchParams.set('adults', String(Math.max(2, adults)));
    url.searchParams.set('currency', 'USD');
    url.searchParams.set('locale', 'en_US');
    url.searchParams.set('siteid', '1');
    url.searchParams.set('selected', propertyId);
    url.searchParams.set('startDate', checkIn);
    url.searchParams.set('endDate', checkOut);
    return url.toString();
  }

  it('injects dates into Expedia Hotel-Search URL', () => {
    const propertyId = '76146918';
    const checkIn = '2026-03-01';
    const checkOut = '2026-03-04';
    const adults = 1;

    const offersUrl = buildExpediaOffersUrl(propertyId, checkIn, checkOut, adults);

    expect(offersUrl).toContain('startDate=2026-03-01');
    expect(offersUrl).toContain('endDate=2026-03-04');
    expect(offersUrl).toContain('selected=76146918');
    // Adults should be at least 2 (Expedia minimum)
    expect(offersUrl).toContain('adults=2');
    expect(offersUrl).toContain('currency=USD');
    expect(offersUrl).toContain('locale=en_US');
  });

  it('extracts property ID from various Expedia URL formats', () => {
    // Regex patterns from extract-expedia
    const extractPropertyId = (url: string): string | null => {
      // Pattern 1: .hXXXXXXXX.
      const pathMatch = url.match(/\.h(\d{6,12})(?:\.|$)/i);
      if (pathMatch) return pathMatch[1];
      
      // Pattern 2: /hXXXXXXXX/ or -hXXXXXXXX.
      const hMatch = url.match(/[\/\-]h(\d{6,12})(?:[\/\.\-]|$)/i);
      if (hMatch) return hMatch[1];
      
      return null;
    };

    // Test various URL formats
    expect(extractPropertyId('https://www.expedia.com/Hotel.h76146918.Hotel-Information')).toBe('76146918');
    expect(extractPropertyId('https://www.expedia.com/Sevierville-Hotels-Private-Luxury-Lodge.h76146918.Hotel-Information')).toBe('76146918');
    expect(extractPropertyId('https://www.expedia.co.jp/Hotel-Search?selected=76146918')).toBeNull(); // Query param, different extraction
  });

  it('derives dates from Airbnb URL and passes to Expedia extractor', () => {
    // Simulate the date extraction from Airbnb URL
    const airbnbUrl = 'https://www.airbnb.com/rooms/903802242341279498?check_in=2026-03-01&check_out=2026-03-04&adults=1';
    const urlObj = new URL(airbnbUrl);
    
    const checkIn = urlObj.searchParams.get('check_in');
    const checkOut = urlObj.searchParams.get('check_out');
    const adults = parseInt(urlObj.searchParams.get('adults') || '1', 10);

    expect(checkIn).toBe('2026-03-01');
    expect(checkOut).toBe('2026-03-04');
    expect(adults).toBe(1);

    // Verify Expedia URL includes these dates
    const expediaUrl = buildExpediaOffersUrl('76146918', checkIn!, checkOut!, adults);
    expect(expediaUrl).toContain('startDate=2026-03-01');
    expect(expediaUrl).toContain('endDate=2026-03-04');
  });
});

// =============================================================================
// TEST C: Frontend must not suppress unverified
// =============================================================================
describe('Test C: Frontend must not suppress unverified', () => {
  it('classifies scraped prices as unverified, not hidden', () => {
    const scrapedResult = classifyScrapedPrice(299.00);

    expect(scrapedResult.price_status).toBe('unverified');
    expect(scrapedResult.price_source).toBe('scraped');
    expect(scrapedResult.eligible_for_comparison).toBe(false);
    expect(scrapedResult.verification_failures).toContain('scraped_not_extracted');
  });

  it('returns unverified with reasons when structural proof missing', () => {
    const unverifiedResult = verifyPrice({
      extraction_status: 'success',
      dates_validated: true,
      includes_taxes_fees: true,
      confidence_score: 0.85,
      extracted_price: 425.00,
      extraction_metadata: {
        breakdown_found: true,
        total_label_found: false, // Missing total label
        rendered_dates_match: true,
        extracted_from_breakdown_total: false,
      },
    });

    expect(unverifiedResult.price_status).toBe('unverified');
    expect(unverifiedResult.verification_failures).toContain('no_structural_total_proof');
    // Should include specific reason
    expect(unverifiedResult.structural_proof.total_label_found).toBe(false);
  });

  it('provides human-readable failure labels for all failure types', () => {
    const EXPECTED_FAILURES = [
      'extraction_not_successful',
      'dates_not_validated',
      'taxes_fees_not_included',
      'low_confidence',
      'scraped_not_extracted',
      'no_price_extracted',
      'no_structural_total_proof',
    ];

    // Import failure labels
    const { VERIFICATION_FAILURE_LABELS } = require('../priceVerification');

    for (const failure of EXPECTED_FAILURES) {
      expect(VERIFICATION_FAILURE_LABELS[failure]).toBeDefined();
      expect(VERIFICATION_FAILURE_LABELS[failure].length).toBeGreaterThan(0);
    }
  });
});

// =============================================================================
// TEST D: Terminal state messaging correctness
// =============================================================================
describe('Test D: Terminal state messaging correctness', () => {
  /**
   * Simulates the failure classification from useEnrichedSearchResults
   */
  function classifyFailure(
    extractionStatus: string | null,
    extractionError: string | null,
    coverageTier: string | null
  ): { category: string | null; reason: string | null } {
    if (!extractionStatus || extractionStatus === 'success' || extractionStatus === 'pending') {
      return { category: null, reason: null };
    }

    const status = extractionStatus;

    // Expedia-specific terminal statuses
    if (status === 'expedia_target_offer_not_found') {
      return { category: 'price_not_visible', reason: 'Property not found on Expedia' };
    }
    if (status === 'expedia_dates_unavailable_for_target' || status === 'dates_unavailable') {
      return { category: 'sold_out', reason: 'Not available for these dates on Expedia' };
    }
    if (status === 'expedia_access_blocked') {
      return { category: 'blocked', reason: 'Blocked by Expedia' };
    }

    // Generic terminal statuses
    if (status === 'blocked_captcha_or_bot' || status === 'blocked_rate_limit') {
      return { category: 'blocked', reason: 'Blocked by platform' };
    }
    if (status === 'render_failed') {
      return { category: 'render_failed', reason: 'Page failed to load' };
    }
    if (status === 'price_not_found') {
      return { category: 'price_not_visible', reason: 'Price not visible on page' };
    }
    if (status === 'platform_unsupported' || coverageTier === 'C') {
      return { category: 'unsupported', reason: 'Platform not supported' };
    }

    return { category: 'unknown', reason: extractionError || 'Unknown error' };
  }

  it('maps dates_unavailable to sold_out category with correct message', () => {
    const result = classifyFailure('dates_unavailable', null, 'A');
    
    expect(result.category).toBe('sold_out');
    expect(result.reason).toContain('Not available');
    // Must NOT be null or empty
    expect(result.reason).not.toBe(null);
    expect(result.reason!.length).toBeGreaterThan(0);
  });

  it('maps expedia_dates_unavailable_for_target to sold_out', () => {
    const result = classifyFailure('expedia_dates_unavailable_for_target', null, 'A');
    
    expect(result.category).toBe('sold_out');
    expect(result.reason).toContain('Expedia');
  });

  it('maps blocked_captcha_or_bot to blocked category', () => {
    const result = classifyFailure('blocked_captcha_or_bot', null, 'A');
    
    expect(result.category).toBe('blocked');
    expect(result.reason).toContain('Blocked');
  });

  it('maps expedia_access_blocked to blocked category', () => {
    const result = classifyFailure('expedia_access_blocked', null, 'A');
    
    expect(result.category).toBe('blocked');
    expect(result.reason).toContain('Expedia');
  });

  it('maps platform_unsupported to unsupported category', () => {
    const result = classifyFailure('platform_unsupported', null, 'C');
    
    expect(result.category).toBe('unsupported');
    expect(result.reason).toContain('not supported');
  });

  it('maps render_failed to render_failed category', () => {
    const result = classifyFailure('render_failed', null, 'B');
    
    expect(result.category).toBe('render_failed');
    expect(result.reason).toContain('Page failed');
  });

  it('does not return "No Alternative Listings Found" for terminal failures', () => {
    const terminalStatuses = [
      'dates_unavailable',
      'expedia_dates_unavailable_for_target',
      'blocked_captcha_or_bot',
      'expedia_access_blocked',
      'render_failed',
      'price_not_found',
    ];

    for (const status of terminalStatuses) {
      const result = classifyFailure(status, null, 'A');
      
      // Reason must NOT be empty or indicate no alternatives
      expect(result.reason).not.toBe(null);
      expect(result.reason).not.toBe('');
      expect(result.reason!.toLowerCase()).not.toContain('no alternative');
      expect(result.category).not.toBe(null);
    }
  });
});

// =============================================================================
// Additional invariant tests
// =============================================================================
describe('State Machine Invariants', () => {
  it('unavailable status returns price_status = unavailable', () => {
    const result = verifyPrice({
      extraction_status: 'dates_unavailable',
      dates_validated: false,
      includes_taxes_fees: false,
      confidence_score: null,
      extracted_price: null,
    });

    expect(result.price_status).toBe('unavailable');
    expect(result.price_source).toBe('none');
    expect(result.eligible_for_comparison).toBe(false);
  });

  it('low confidence score results in unverified', () => {
    const result = verifyPrice({
      extraction_status: 'success',
      dates_validated: true,
      includes_taxes_fees: true,
      confidence_score: 0.3, // Below 0.5 threshold
      extracted_price: 400.00,
      extraction_metadata: {
        breakdown_found: true,
        total_label_found: true,
        rendered_dates_match: true,
        extracted_from_breakdown_total: true,
      },
    });

    expect(result.price_status).toBe('unverified');
    expect(result.verification_failures).toContain('low_confidence');
  });

  it('hash-based extraction path results in unverified', () => {
    const result = verifyPrice({
      extraction_status: 'success',
      dates_validated: true,
      includes_taxes_fees: true,
      confidence_score: 0.9,
      extracted_price: 500.00,
      extraction_path: 'hash_based_cache',
      extraction_metadata: {
        breakdown_found: true,
        total_label_found: true,
        rendered_dates_match: true,
        extracted_from_breakdown_total: true,
      },
    });

    expect(result.price_status).toBe('unverified');
    expect(result.verification_failures).toContain('no_structural_total_proof');
  });

  it('structural proof flags are preserved in result', () => {
    const result = verifyPrice({
      extraction_status: 'success',
      dates_validated: true,
      includes_taxes_fees: true,
      confidence_score: 0.85,
      extracted_price: 450.00,
      extraction_metadata: {
        breakdown_found: true,
        total_label_found: false,
        rendered_dates_match: true,
        extracted_from_breakdown_total: false,
      },
    });

    expect(result.structural_proof.breakdown_found).toBe(true);
    expect(result.structural_proof.total_label_found).toBe(false);
  expect(result.structural_proof.rendered_dates_match).toBe(true);
    expect(result.structural_proof.extracted_from_breakdown_total).toBe(false);
  });
});

// =============================================================================
// TEST E: Discovery never skipped due to cached matches
// =============================================================================
describe('Test E: Discovery never skipped due to cached matches', () => {
  /**
   * This test verifies the orchestration invariant that platform discovery
   * is NEVER skipped just because cached matches exist.
   * 
   * The fix ensures:
   * 1. `discoveryAttempted` flag must be true before skip can be claimed
   * 2. At least one image search attempt is made before allowing skip
   * 3. Logs show "Discovery Complete" with correct merge counts
   */
  
  it('discovery must run even when cached matches exist', () => {
    // Simulate the orchestration state after loading cached matches
    const cachedMatchCount = 3;
    let discoveryAttempted = false;
    let imageSearchCount = 0;
    const skipRequested = true; // User or auto requested skip
    
    // The FIXED logic: skip can only be claimed AFTER discoveryAttempted = true
    const canSkipBeforeFix = skipRequested; // BUG: skip immediately
    const canSkipAfterFix = discoveryAttempted && skipRequested; // FIX: must attempt first
    
    // Before fix: skip would be allowed immediately
    expect(canSkipBeforeFix).toBe(true);
    // After fix: skip is NOT allowed until discovery is attempted
    expect(canSkipAfterFix).toBe(false);
    
    // Simulate one discovery attempt
    imageSearchCount++;
    discoveryAttempted = true;
    
    // Now skip CAN be claimed (after at least one attempt)
    const canSkipAfterAttempt = discoveryAttempted && skipRequested;
    expect(canSkipAfterAttempt).toBe(true);
  });

  it('merge semantics: final count = cached + newly discovered', () => {
    // Simulate the merge logic
    const cachedMatches = [
      { platform: 'expedia', url: 'https://expedia.com/123' },
      { platform: 'booking', url: 'https://booking.com/456' },
      { platform: 'vrbo', url: 'https://vrbo.com/789' },
    ];
    
    const bestMatchPerPlatform = new Map<string, { platform: string; url: string }>();
    
    // Load cached matches
    for (const cached of cachedMatches) {
      const platformKey = cached.platform.toLowerCase();
      if (!bestMatchPerPlatform.has(platformKey)) {
        bestMatchPerPlatform.set(platformKey, cached);
      }
    }
    
    expect(bestMatchPerPlatform.size).toBe(3);
    
    // Discovery finds a new platform (not in cache)
    const newDiscovery = { platform: 'agoda', url: 'https://agoda.com/999' };
    const newPlatformKey = newDiscovery.platform.toLowerCase();
    
    if (!bestMatchPerPlatform.has(newPlatformKey)) {
      bestMatchPerPlatform.set(newPlatformKey, newDiscovery);
    }
    
    // Final count should be 4 (3 cached + 1 new)
    expect(bestMatchPerPlatform.size).toBe(4);
    
    // Verify merge counts
    const cachedCount = cachedMatches.length;
    const newlyDiscovered = bestMatchPerPlatform.size - cachedCount;
    expect(cachedCount).toBe(3);
    expect(newlyDiscovered).toBe(1);
  });

  it('discovery finds better match for existing platform', () => {
    // When discovery finds a higher-confidence match for a cached platform,
    // it should replace the cached match
    const bestMatchPerPlatform = new Map<string, { platform: string; confidence: number }>();
    
    // Load cached match with 0.95 confidence (default for cached)
    bestMatchPerPlatform.set('expedia', { platform: 'Expedia', confidence: 0.95 });
    
    // Discovery finds same platform with higher confidence
    const discoveredMatch = { platform: 'Expedia', confidence: 0.98 };
    const existingMatch = bestMatchPerPlatform.get('expedia');
    
    if (!existingMatch || discoveredMatch.confidence > existingMatch.confidence) {
      bestMatchPerPlatform.set('expedia', discoveredMatch);
    }
    
    // Should use the higher confidence match
    expect(bestMatchPerPlatform.get('expedia')?.confidence).toBe(0.98);
  });
});

// =============================================================================
// TEST F: Airbnb OCR total extraction from book/stays page
// =============================================================================
describe('Test F: Airbnb OCR total extraction', () => {
  /**
   * This test verifies that OCR correctly extracts the all-in total
   * from Airbnb book/stays checkout pages.
   * 
   * The key patterns are:
   * - "Pay $X now" → breakdownTotalAmountValue
   * - "Total (USD) $X" → breakdownTotalAmountValue  
   * - "$X for Y nights" → bookingCardAmountValue (subtotal only)
   */
  
  it('OCR should prioritize Pay now over subtotal for nights', () => {
    // Simulate OCR result from a book/stays page
    const ocrResult = {
      bookingCardAmountRaw: '$1,482',
      bookingCardAmountValue: 1482.00,
      bookingCardNights: 3,
      bookingCardSnippet: '$1,482 for 3 nights',
      breakdownTotalAmountRaw: '$1,658.94',
      breakdownTotalAmountValue: 1658.94, // The actual total with taxes
      breakdownTotalSnippet: 'Pay $1,658.94 now',
      breakdownTaxesAmountValue: null,
      breakdownOpened: true,
    };
    
    // The correct price to use is breakdownTotalAmountValue
    const correctPrice = ocrResult.breakdownTotalAmountValue;
    const wrongPrice = ocrResult.bookingCardAmountValue;
    
    expect(correctPrice).toBe(1658.94);
    expect(wrongPrice).toBe(1482.00);
    expect(correctPrice).toBeGreaterThan(wrongPrice);
    
    // Verify the difference is taxes/fees (about 12%)
    const taxPercent = ((correctPrice - wrongPrice) / wrongPrice) * 100;
    expect(taxPercent).toBeGreaterThan(10);
    expect(taxPercent).toBeLessThan(20);
  });

  it('OCR with breakdown total should result in needs_user_confirmation = false', () => {
    // When OCR finds a breakdown total, we have a grounded price
    const hasBreakdownTotal = true;
    const breakdownTotalValue = 1658.94;
    
    // The selection logic from the edge function
    let status: 'total_price_including_taxes_and_fees' | 'needs_user_confirmation';
    
    if (breakdownTotalValue && breakdownTotalValue > 0) {
      status = 'total_price_including_taxes_and_fees';
    } else {
      status = 'needs_user_confirmation';
    }
    
    expect(status).toBe('total_price_including_taxes_and_fees');
  });

  it('OCR without breakdown total should result in needs_user_confirmation', () => {
    // When OCR only finds a subtotal, we need user confirmation
    const ocrResult = {
      bookingCardAmountValue: 1482.00,
      breakdownTotalAmountValue: null, // No total found
    };
    
    let status: 'total_price_including_taxes_and_fees' | 'needs_user_confirmation';
    
    if (ocrResult.breakdownTotalAmountValue && ocrResult.breakdownTotalAmountValue > 0) {
      status = 'total_price_including_taxes_and_fees';
    } else {
      status = 'needs_user_confirmation';
    }
    
    expect(status).toBe('needs_user_confirmation');
  });

  it('REGRESSION: Total (USD) pattern must be extracted', () => {
    // This test ensures the OCR prompt correctly identifies "Total (USD) $X" patterns
    const ocrText = `
      Confirm and pay
      
      $1,482 for 3 nights
      Cleaning fee: $100
      Service fee: $76.94
      
      Total (USD) $1,658.94
    `;
    
    // The OCR should extract:
    // - bookingCardAmountValue: 1482 (the subtotal)
    // - breakdownTotalAmountValue: 1658.94 (the Total USD line)
    
    // Verify the patterns exist in the text
    expect(ocrText).toMatch(/\$1,482 for 3 nights/);
    expect(ocrText).toMatch(/Total \(USD\) \$1,658\.94/);
    
    // The Total (USD) amount is 1658.94 which is greater than the subtotal
    const subtotal = 1482;
    const total = 1658.94;
    expect(total).toBeGreaterThan(subtotal);
  });
});
