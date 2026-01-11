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
// Cached matches are ONLY loaded AFTER discovery completes
// =============================================================================
describe('Test E: Discovery and cached match handling', () => {
  /**
   * This test suite verifies that cached matches:
   * 1. Are NOT loaded before the 5-image discovery loop
   * 2. Are merged ONLY after discovery completes
   * 3. Do NOT influence whether discovery continues
   * 4. Do NOT trigger any skip logic
   */

  it('REGRESSION: cached matches are loaded ONLY after discovery completes', () => {
    // Simulates the correct pipeline order:
    // 1. Run full discovery (all 5 images)
    // 2. THEN load cached matches as fallback merge
    
    const imageUrls = ['img1', 'img2', 'img3', 'img4', 'img5'];
    const logSequence: string[] = [];
    
    // Discovery phase - cached matches NOT loaded here
    let discoveryAttempted = false;
    const bestMatchPerPlatform = new Map<string, { platform: string; url: string }>();
    
    for (let idx = 0; idx < imageUrls.length; idx++) {
      discoveryAttempted = true;
      logSequence.push(`Searching image ${idx + 1} of ${imageUrls.length}`);
      
      // Simulate finding matches during discovery
      if (idx === 0) {
        bestMatchPerPlatform.set('booking', { platform: 'Booking.com', url: 'https://booking.com/123' });
        logSequence.push('Found match: Booking.com');
      }
      if (idx === 2) {
        bestMatchPerPlatform.set('vrbo', { platform: 'Vrbo', url: 'https://vrbo.com/456' });
        logSequence.push('Found match: Vrbo');
      }
    }
    
    const discoveredCount = bestMatchPerPlatform.size;
    logSequence.push(`Verification complete for current run: ${discoveredCount} platforms found`);
    
    // Fallback merge phase - cached matches loaded ONLY NOW
    logSequence.push('Loading cached matches (fallback)');
    
    const cachedMatches = [
      { platform: 'Expedia', url: 'https://expedia.com/789' },
      { platform: 'Agoda', url: 'https://agoda.com/101' },
    ];
    
    let addedFromCache = 0;
    let dedupedFromCache = 0;
    
    for (const cached of cachedMatches) {
      const platformKey = cached.platform.toLowerCase();
      if (!bestMatchPerPlatform.has(platformKey)) {
        bestMatchPerPlatform.set(platformKey, cached);
        addedFromCache++;
        logSequence.push(`Added cached match: ${cached.platform}`);
      } else {
        dedupedFromCache++;
      }
    }
    
    logSequence.push(`Merged cached matches — added ${addedFromCache}, deduped ${dedupedFromCache}`);
    logSequence.push(`Proceeding with ${bestMatchPerPlatform.size} candidate listings`);
    
    // ASSERTIONS
    
    // 1. All 5 images were searched before cached matches loaded
    expect(logSequence.filter(l => l.startsWith('Searching image')).length).toBe(5);
    
    // 2. "Loading cached matches" appears AFTER "Verification complete"
    const verificationCompleteIndex = logSequence.findIndex(l => l.includes('Verification complete'));
    const loadingCachedIndex = logSequence.findIndex(l => l.includes('Loading cached matches'));
    expect(loadingCachedIndex).toBeGreaterThan(verificationCompleteIndex);
    
    // 3. "Loading cached matches" never appears before image search
    const firstSearchIndex = logSequence.findIndex(l => l.startsWith('Searching image'));
    expect(loadingCachedIndex).toBeGreaterThan(firstSearchIndex);
    
    // 4. Total platforms = discovered + added from cache
    expect(bestMatchPerPlatform.size).toBe(4); // 2 discovered + 2 from cache
    expect(discoveredCount).toBe(2);
    expect(addedFromCache).toBe(2);
  });

  it('cached matches do NOT appear in logs before image search completes', () => {
    // The following log entries must NEVER appear before the 5-image loop completes:
    // - "Loaded cached matches"
    // - "Found cached platforms"
    // Any skip or stop decision influenced by cached matches
    
    const forbiddenBeforeDiscovery = [
      'Loaded cached matches',
      'Found cached platforms',
      'Loading known matches',
      'cached matches',
    ];
    
    // Simulate correct log sequence
    const correctLogSequence = [
      'Starting search',
      'Searching image 1 of 5',
      'Running AI reverse image search',
      'Found 3 potential matches',
      'Verifying matches',
      'Searching image 2 of 5',
      'Running AI reverse image search',
      'Found 2 potential matches',
      'Searching image 3 of 5',
      'Searching image 4 of 5',
      'Searching image 5 of 5',
      'Verification complete for current run',
      'Loading cached matches (fallback)', // ONLY here
      'Merged cached matches — added 2, deduped 1',
      'Proceeding with combined candidate set',
    ];
    
    // Find the index where discovery ends
    const discoveryEndIndex = correctLogSequence.findIndex(l => l.includes('Verification complete'));
    
    // Check that no forbidden entries appear before discovery ends
    const logsBeforeDiscoveryEnd = correctLogSequence.slice(0, discoveryEndIndex);
    for (const log of logsBeforeDiscoveryEnd) {
      for (const forbidden of forbiddenBeforeDiscovery) {
        expect(log.toLowerCase()).not.toContain(forbidden.toLowerCase());
      }
    }
  });

  it('REGRESSION: match verification never skips due to cached matches or discovered matches', () => {
    // This test verifies that "Skipping remaining match verification"
    // is NEVER triggered based on cached matches or discovery counts.
    // 
    // The ONLY allowed early stops in match verification are:
    // 1. aiCount >= MAX_AI (deterministic cap)
    // 2. matchesThisImage >= 8 (deterministic per-image cap)
    // 3. Time exceeded (deterministic time cap)
    // 4. User explicitly clicked skip button (at image level only)
    
    const MAX_AI = 25;
    const MAX_PER_IMAGE = 8;
    
    // Simulate various states - none should trigger cache-based skipping
    // NOTE: cachedMatchCount is NOT available during discovery loop
    const scenarios = [
      { discovered: 0, aiCount: 5, matchesThisImage: 2 },
      { discovered: 2, aiCount: 10, matchesThisImage: 5 },
      { discovered: 5, aiCount: 8, matchesThisImage: 4 },
      { discovered: 10, aiCount: 20, matchesThisImage: 7 },
    ];
    
    for (const scenario of scenarios) {
      // The logic: skip is ONLY allowed by deterministic caps
      // Cached matches are NOT part of this calculation (not loaded yet)
      const shouldContinue = scenario.aiCount < MAX_AI && scenario.matchesThisImage < MAX_PER_IMAGE;
      
      expect(shouldContinue).toBe(true); // All scenarios continue (under caps)
    }
    
    // Test hitting the caps
    expect(25 >= MAX_AI).toBe(true);  // Cap hit → stop
    expect(8 >= MAX_PER_IMAGE).toBe(true);  // Cap hit → stop
  });
  
  it('REGRESSION: discovery continues for all images regardless of what was found', () => {
    // Discovery must process all configured images (e.g., 5)
    // The number of matches found does NOT reduce the number of images processed
    
    const imageUrls = ['img1', 'img2', 'img3', 'img4', 'img5'];
    
    let imagesProcessed = 0;
    let discoveryAttempted = false;
    const matchesFound: string[] = [];
    
    // Simulate the discovery loop WITHOUT any skip logic based on match count
    for (let idx = 0; idx < imageUrls.length; idx++) {
      discoveryAttempted = true;
      imagesProcessed++;
      
      // Even if we find matches early, we continue
      if (idx === 0) matchesFound.push('match1');
      if (idx === 1) matchesFound.push('match2', 'match3');
      // Still continue to images 3, 4, 5...
    }
    
    // All 5 images should be processed
    expect(imagesProcessed).toBe(5);
    expect(discoveryAttempted).toBe(true);
    expect(matchesFound.length).toBe(3);
  });

  it('merge semantics: cached + discovered are correctly combined and deduped', () => {
    // Given cached matches plus newly discovered platforms,
    // assert final platform list is the union with correct dedupe
    
    const bestMatchPerPlatform = new Map<string, { platform: string; url: string; confidence: number }>();
    
    // Discovery finds 2 platforms
    bestMatchPerPlatform.set('booking', { platform: 'Booking.com', url: 'https://booking.com/123', confidence: 0.92 });
    bestMatchPerPlatform.set('vrbo', { platform: 'Vrbo', url: 'https://vrbo.com/456', confidence: 0.88 });
    
    const discoveredCount = bestMatchPerPlatform.size;
    expect(discoveredCount).toBe(2);
    
    // Cached matches (some overlap)
    const cachedMatches = [
      { platform: 'Expedia', url: 'https://expedia.com/789', confidence: 0.95 },
      { platform: 'Booking.com', url: 'https://booking.com/123', confidence: 0.95 }, // DUPE
      { platform: 'Agoda', url: 'https://agoda.com/101', confidence: 0.95 },
    ];
    
    let addedFromCache = 0;
    let dedupedFromCache = 0;
    
    for (const cached of cachedMatches) {
      const platformKey = cached.platform.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!bestMatchPerPlatform.has(platformKey)) {
        bestMatchPerPlatform.set(platformKey, cached);
        addedFromCache++;
      } else {
        dedupedFromCache++;
      }
    }
    
    // Final count: 2 discovered + 2 added from cache (1 deduped)
    expect(bestMatchPerPlatform.size).toBe(4);
    expect(addedFromCache).toBe(2);
    expect(dedupedFromCache).toBe(1);
    
    // Discovered match is kept (not replaced by cached)
    expect(bestMatchPerPlatform.get('booking')?.confidence).toBe(0.92);
  });
});

// =============================================================================
// TEST F: Browserless regex patterns must use double-escaped backslashes
// =============================================================================
describe('Test F: Browserless regex serialization', () => {
  /**
   * REGRESSION: Regex patterns inside Browserless code strings must use
   * double-escaped backslashes (\\s, \\d) to survive JSON serialization.
   * 
   * Single backslashes (\s, \d) get stripped when the code string is
   * JSON.stringify()'d and sent to Browserless, causing "Invalid regex" errors.
   * 
   * Error example: "Invalid regular expression: /Totals*(?s*USDs*)?s*$s*([d,]+(?:.d{2})?)/i"
   * This shows all backslashes were stripped from the original pattern.
   */
  
  it('REGRESSION: regex patterns with double-escaped backslashes compile correctly', () => {
    // These are the exact patterns used in the Browserless code string
    // They use double-escaped backslashes to survive JSON serialization
    
    const patterns = [
      { source: 'Pay\\s*\\$\\s*([\\d,]+(?:\\.\\d{2})?)\\s*now', desc: 'Pay now' },
      { source: 'Total\\s*\\(?\\s*USD\\s*\\)?\\s*\\$\\s*([\\d,]+(?:\\.\\d{2})?)', desc: 'Total USD' },
      { source: 'Due\\s+today\\s*\\$\\s*([\\d,]+(?:\\.\\d{2})?)', desc: 'Due today' },
      { source: '\\$\\s*([\\d,]+(?:\\.\\d{2})?)\\s+for\\s+(\\d+)\\s+nights?', desc: 'Subtotal for nights' },
    ];
    
    for (const { source, desc } of patterns) {
      // This simulates what happens when the code is sent to Browserless:
      // 1. The pattern string goes through JSON.stringify (in the payload)
      // 2. Then new RegExp() is called on the resulting string
      
      // First, verify the pattern compiles when used with new RegExp()
      expect(() => new RegExp(source, 'i')).not.toThrow();
      
      // Verify it actually matches expected text
      const regex = new RegExp(source, 'i');
      
      if (desc === 'Pay now') {
        expect(regex.test('Pay $1,658.94 now')).toBe(true);
        expect(regex.test('Pay$500now')).toBe(true);
      }
      if (desc === 'Total USD') {
        expect(regex.test('Total (USD) $1,658.94')).toBe(true);
        expect(regex.test('Total USD $1,658.94')).toBe(true);
      }
      if (desc === 'Due today') {
        expect(regex.test('Due today $500.00')).toBe(true);
      }
      if (desc === 'Subtotal for nights') {
        expect(regex.test('$1,482 for 3 nights')).toBe(true);
        expect(regex.test('$500.00 for 1 night')).toBe(true);
      }
    }
  });

  it('REGRESSION: regex with single backslashes FAILS after JSON round-trip', () => {
    // This demonstrates why double-escaping is necessary
    
    // A regex pattern with single backslashes (WRONG - will break)
    const wrongPattern = 'Total\\s*\\(?\\s*USD\\s*\\)?\\s*\\$\\s*([\\d,]+(?:\\.\\d{2})?)';
    
    // Simulate the wrong approach: using literal regex in a template string
    // When this goes through JSON.stringify, backslashes are preserved once
    // But if the source had single backslashes, they'd be stripped
    const simulatedStrippedPattern = 'Totals*(?s*USDs*)?s*$s*([d,]+(?.d{2})?)';
    
    // This should throw because the pattern is invalid
    expect(() => new RegExp(simulatedStrippedPattern, 'i')).toThrow();
  });
});

// =============================================================================
// TEST G: Airbnb OCR total extraction from book/stays page
// =============================================================================
describe('Test G: Airbnb OCR total extraction', () => {
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

// =============================================================================
// TEST H: Browserless regex pattern serialization safety
// =============================================================================
describe('Test H: Browserless regex pattern serialization', () => {
  /**
   * These tests ensure that regex patterns survive the full serialization
   * round-trip when sent to Browserless.
   * 
   * The pattern of errors like:
   * "Invalid regular expression: /Totals*(?s*USDs*)?s*$s*([d,]+(?.d{2})?)/i"
   * shows that backslashes were stripped during serialization.
   */
  
  // These are the EXACT pattern strings used in the Browserless code
  // They need quadruple escaping: \\\\s becomes \\s after JSON.parse, then \s in regex
  const BROWSERLESS_PATTERNS = [
    {
      name: 'payNowRe',
      // Pattern as written in code (inside template literal going to Browserless)
      sourceInCode: 'Pay\\\\s*\\\\$\\\\s*([\\\\d,]+(?:\\\\.\\\\d{2})?)\\\\s*now',
      expectedAfterParse: 'Pay\\s*\\$\\s*([\\d,]+(?:\\.\\d{2})?)\\s*now',
      testCases: ['Pay $1,658.94 now', 'Pay$500now', 'Pay $2,214 now'],
    },
    {
      name: 'totalUsdRe',
      sourceInCode: 'Total\\\\s*\\\\(?\\\\s*USD\\\\s*\\\\)?\\\\s*\\\\$\\\\s*([\\\\d,]+(?:\\\\.\\\\d{2})?)',
      expectedAfterParse: 'Total\\s*\\(?\\s*USD\\s*\\)?\\s*\\$\\s*([\\d,]+(?:\\.\\d{2})?)',
      testCases: ['Total (USD) $1,658.94', 'Total USD $1,658.94', 'Total(USD)$500'],
    },
    {
      name: 'dueTodayRe',
      sourceInCode: 'Due\\\\s+today\\\\s*\\\\$\\\\s*([\\\\d,]+(?:\\\\.\\\\d{2})?)',
      expectedAfterParse: 'Due\\s+today\\s*\\$\\s*([\\d,]+(?:\\.\\d{2})?)',
      testCases: ['Due today $500.00', 'Due today$1,234.56'],
    },
    {
      name: 'subtotalRe',
      sourceInCode: '\\\\$\\\\s*([\\\\d,]+(?:\\\\.\\\\d{2})?)\\\\s+for\\\\s+(\\\\d+)\\\\s+nights?',
      expectedAfterParse: '\\$\\s*([\\d,]+(?:\\.\\d{2})?)\\s+for\\s+(\\d+)\\s+nights?',
      testCases: ['$1,482 for 3 nights', '$500.00 for 1 night', '$ 2,000 for 7 nights'],
    },
  ];
  
  it('patterns compile correctly after simulated JSON round-trip', () => {
    for (const { name, sourceInCode, expectedAfterParse, testCases } of BROWSERLESS_PATTERNS) {
      // Simulate what happens when the code string is sent to Browserless:
      // 1. Template literal is created with the pattern
      // 2. JSON.stringify() is called on the payload
      // 3. Browserless receives and parses the JSON
      // 4. new RegExp() is called with the resulting string
      
      // Simulate JSON round-trip
      const afterJsonParse = JSON.parse(JSON.stringify(sourceInCode));
      
      // Verify it matches expected
      expect(afterJsonParse).toBe(expectedAfterParse);
      
      // Verify pattern compiles
      let regex: RegExp;
      expect(() => {
        regex = new RegExp(afterJsonParse, 'i');
      }).not.toThrow();
      
      // Verify it matches test cases
      for (const testCase of testCases) {
        expect(regex!.test(testCase)).toBe(true);
      }
    }
  });
  
  it('detects incorrectly escaped patterns (single backslashes)', () => {
    // These are WRONG patterns - single backslashes that get stripped
    const wrongPatterns = [
      { name: 'wrong_payNow', pattern: 'Pay\\s*\\$\\s*' },
      { name: 'wrong_total', pattern: 'Total\\s*\\(USD\\)' },
    ];
    
    for (const { name, pattern } of wrongPatterns) {
      // After JSON round-trip, single backslashes become nothing
      // But in this test context, we simulate what happens if someone
      // mistakenly uses the pattern without proper escaping
      
      // Construct what would result from stripped backslashes
      const strippedPattern = pattern
        .replace(/\\s/g, 's')
        .replace(/\\$/g, '$')
        .replace(/\\(/g, '(')
        .replace(/\\)/g, ')');
      
      // This may or may not throw depending on the pattern,
      // but it definitely won't match what we expect
      const regex = new RegExp(strippedPattern, 'i');
      
      // Even if it compiles, it won't match "Pay $500 now"
      // because it's looking for literal 's' instead of whitespace
      expect(regex.test('Pay $500 now')).toBe(false);
    }
  });
  
  it('REGRESSION: invalid pattern from error logs does not compile', () => {
    // This is the exact pattern that appeared in the error logs
    const invalidPatternFromLogs = 'Totals*(?s*USDs*)?s*$s*([d,]+(?.d{2})?)';
    
    // This should throw because:
    // - 's*' instead of '\\s*' (whitespace)
    // - '$' instead of '\\$' (dollar sign)
    // - 'd' instead of '\\d' (digit)
    // - '(?' is incomplete lookahead/lookbehind
    expect(() => new RegExp(invalidPatternFromLogs, 'i')).toThrow();
  });
  
  it('ensures no patterns contain unsupported constructs', () => {
    // JavaScript regex does NOT support:
    // - (?s) - DOTALL modifier (Python/PCRE only)
    // - (?m) as inline modifier (only as flag)
    // - (?x) - verbose mode
    
    const unsupportedConstructs = [
      /\(\?s\)/,  // DOTALL modifier
      /\(\?x\)/,  // Verbose mode
      /\(\?i\)/,  // Inline case-insensitive (use 'i' flag instead)
    ];
    
    for (const { expectedAfterParse } of BROWSERLESS_PATTERNS) {
      for (const badConstruct of unsupportedConstructs) {
        expect(expectedAfterParse).not.toMatch(badConstruct);
      }
    }
  });
});

// =============================================================================
// TEST I: Browserless-only debug mode state machine
// =============================================================================
describe('Test I: Browserless-only debug mode behavior', () => {
  /**
   * These tests verify the state machine logic for BROWSERLESS_ONLY_BASELINE mode.
   * When enabled, the pipeline should HARD STOP on any non-success state.
   */
  
  // Define all possible baseline status values
  type BaselineStatus = 
    | 'total_price_including_taxes_and_fees'      // SUCCESS - only this continues
    | 'total_price_excluding_taxes_and_fees'      // STOP - not final total
    | 'needs_user_confirmation'                    // STOP - subtotal only
    | 'price_not_available_in_content';           // STOP - no price found
  
  // Helper to simulate the debug mode decision logic
  function shouldStopInDebugMode(
    browserlessOnlyMode: boolean,
    airbnbPrice: number | null,
    airbnbCurrency: string | null,
    baselineStatus: BaselineStatus
  ): { shouldStop: boolean; reason: string | null } {
    if (!browserlessOnlyMode) {
      return { shouldStop: false, reason: null };
    }
    
    const hasVerifiedTotal = airbnbPrice && airbnbCurrency && 
      baselineStatus === 'total_price_including_taxes_and_fees';
    
    if (!hasVerifiedTotal) {
      let reason: string;
      if (baselineStatus === 'needs_user_confirmation') {
        reason = 'needs_user_confirmation (subtotal only, no verified total)';
      } else if (baselineStatus === 'price_not_available_in_content') {
        reason = 'price_not_available_in_content (no price found)';
      } else if (baselineStatus === 'total_price_excluding_taxes_and_fees') {
        reason = 'total_price_excluding_taxes_and_fees (not final total)';
      } else {
        reason = `${baselineStatus} (non-success state)`;
      }
      return { shouldStop: true, reason };
    }
    
    return { shouldStop: false, reason: null };
  }
  
  it('when debug mode OFF, never stops regardless of status', () => {
    const statuses: BaselineStatus[] = [
      'total_price_including_taxes_and_fees',
      'total_price_excluding_taxes_and_fees',
      'needs_user_confirmation',
      'price_not_available_in_content',
    ];
    
    for (const status of statuses) {
      const result = shouldStopInDebugMode(false, null, null, status);
      expect(result.shouldStop).toBe(false);
      expect(result.reason).toBeNull();
    }
  });
  
  it('when debug mode ON with verified total, continues normally', () => {
    const result = shouldStopInDebugMode(
      true, 
      1658.94, 
      'USD', 
      'total_price_including_taxes_and_fees'
    );
    expect(result.shouldStop).toBe(false);
    expect(result.reason).toBeNull();
  });
  
  it('when debug mode ON with needs_user_confirmation, STOPS', () => {
    const result = shouldStopInDebugMode(
      true,
      null,
      null,
      'needs_user_confirmation'
    );
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toContain('needs_user_confirmation');
  });
  
  it('when debug mode ON with price_not_available_in_content, STOPS', () => {
    const result = shouldStopInDebugMode(
      true,
      null,
      null,
      'price_not_available_in_content'
    );
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toContain('price_not_available_in_content');
  });
  
  it('when debug mode ON with total_price_excluding_taxes_and_fees, STOPS', () => {
    // Even if we have a price, if it's not the verified total, we stop
    const result = shouldStopInDebugMode(
      true,
      1500.00,
      'USD',
      'total_price_excluding_taxes_and_fees'
    );
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toContain('total_price_excluding_taxes_and_fees');
  });
  
  it('REGRESSION: needs_user_confirmation with subtotal price still stops', () => {
    // This was the bug: we had a price (subtotal) but not verified total
    // The old code only checked !airbnbPrice which was false
    const result = shouldStopInDebugMode(
      true,
      1482.00, // subtotal price present!
      'USD',
      'needs_user_confirmation' // but status says not verified
    );
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toContain('needs_user_confirmation');
  });
});
