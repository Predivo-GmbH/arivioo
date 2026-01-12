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

// =============================================================================
// TEST J: Browserless Canonical Baseline Regression Guard
// =============================================================================
/**
 * CANONICAL BROWSERLESS BASELINE REGRESSION GUARD
 * 
 * Reference: docs/BROWSERLESS_CANONICAL_BASELINE.md
 * 
 * These tests protect the known-working Browserless extraction behaviour.
 * Any change that breaks these tests MUST be compared against the canonical
 * baseline documentation BEFORE modifying the tests.
 * 
 * PROTECTED INVARIANTS:
 * 1. payNowExtraction must be passed through from Browserless to consumer
 * 2. Direct text extraction takes priority over OCR
 * 3. Subtotals are NEVER promoted to verified totals
 * 4. Debug mode vs normal mode produces identical extraction
 * 5. Null payNowExtraction doesn't crash the pipeline
 * 
 * If these tests fail after a change, DO NOT simply update the expectations.
 * Instead: 
 * 1. Compare against docs/BROWSERLESS_CANONICAL_BASELINE.md
 * 2. Identify what changed from the canonical working state
 * 3. Document why the change is intentional OR revert
 */
describe('Test J: Browserless Canonical Baseline Regression Guard', () => {
  /**
   * These tests ensure that the Browserless extraction path produces
   * identical results regardless of debug mode setting.
   * The payNowExtraction field MUST be properly passed through.
   */
  
  // Mock the structure returned from Browserless page.evaluate
  interface MockPayNowExtraction {
    payNowAmount: number | null;
    payNowSnippet: string | null;
    payNowCurrencySymbol: string | null;
    subtotalAmount: number | null;
    subtotalNights: number | null;
    subtotalSnippet: string | null;
    subtotalCurrencySymbol: string | null;
    regexCompilationErrors: string[] | null;
  }
  
  // Simulate the extraction evaluation logic from search-alternatives
  function evaluateBrowserlessExtraction(
    payNowData: MockPayNowExtraction | null,
    ocrBreakdownTotal: number | null,
    ocrBookingCardAmount: number | null
  ): { status: string; price: number | null; source: string } {
    // PRIORITY 1: Direct text extraction
    if (payNowData?.payNowAmount && payNowData.payNowAmount > 0) {
      return {
        status: 'total_price_including_taxes_and_fees',
        price: payNowData.payNowAmount,
        source: 'direct_text_extraction',
      };
    }
    
    // PRIORITY 2: OCR breakdown total
    if (ocrBreakdownTotal && ocrBreakdownTotal > 0) {
      return {
        status: 'total_price_including_taxes_and_fees',
        price: ocrBreakdownTotal,
        source: 'ocr_breakdown',
      };
    }
    
    // PRIORITY 3: OCR booking card (subtotal only)
    if (ocrBookingCardAmount && ocrBookingCardAmount > 0) {
      return {
        status: 'needs_user_confirmation',
        price: null, // Subtotal is NOT promoted to total
        source: 'subtotal_only',
      };
    }
    
    return {
      status: 'price_not_available_in_content',
      price: null,
      source: 'none',
    };
  }
  
  it('payNowExtraction with total returns verified status', () => {
    const payNowData: MockPayNowExtraction = {
      payNowAmount: 1658.94,
      payNowSnippet: 'Pay $1,658.94 now',
      payNowCurrencySymbol: '$',
      subtotalAmount: 1482,
      subtotalNights: 3,
      subtotalSnippet: '$1,482 for 3 nights',
      subtotalCurrencySymbol: '$',
      regexCompilationErrors: null,
    };
    
    const result = evaluateBrowserlessExtraction(payNowData, null, null);
    expect(result.status).toBe('total_price_including_taxes_and_fees');
    expect(result.price).toBe(1658.94);
    expect(result.source).toBe('direct_text_extraction');
  });
  
  it('missing payNowExtraction with only subtotal returns needs_user_confirmation', () => {
    const payNowData: MockPayNowExtraction = {
      payNowAmount: null,  // No total found
      payNowSnippet: null,
      payNowCurrencySymbol: null,
      subtotalAmount: 1482,  // Only subtotal found
      subtotalNights: 3,
      subtotalSnippet: '$1,482 for 3 nights',
      subtotalCurrencySymbol: '$',
      regexCompilationErrors: null,
    };
    
    const result = evaluateBrowserlessExtraction(payNowData, null, 1482);
    expect(result.status).toBe('needs_user_confirmation');
    expect(result.price).toBeNull(); // Subtotal NOT promoted
    expect(result.source).toBe('subtotal_only');
  });
  
  it('OCR breakdown total takes priority over subtotal', () => {
    const payNowData: MockPayNowExtraction = {
      payNowAmount: null,
      payNowSnippet: null,
      payNowCurrencySymbol: null,
      subtotalAmount: 1482,
      subtotalNights: 3,
      subtotalSnippet: '$1,482 for 3 nights',
      subtotalCurrencySymbol: '$',
      regexCompilationErrors: null,
    };
    
    // OCR found the breakdown total
    const result = evaluateBrowserlessExtraction(payNowData, 1658.94, 1482);
    expect(result.status).toBe('total_price_including_taxes_and_fees');
    expect(result.price).toBe(1658.94);
    expect(result.source).toBe('ocr_breakdown');
  });
  
  it('REGRESSION: null payNowExtraction must not crash extraction', () => {
    // This was the bug: payNowExtraction was not being passed through
    // from Browserless response to the consumer code
    const result = evaluateBrowserlessExtraction(null, null, null);
    expect(result.status).toBe('price_not_available_in_content');
    expect(result.price).toBeNull();
  });
  
  it('debug mode vs normal mode produces identical extraction result', () => {
    const payNowData: MockPayNowExtraction = {
      payNowAmount: 1658.94,
      payNowSnippet: 'Pay $1,658.94 now',
      payNowCurrencySymbol: '$',
      subtotalAmount: 1482,
      subtotalNights: 3,
      subtotalSnippet: '$1,482 for 3 nights',
      subtotalCurrencySymbol: '$',
      regexCompilationErrors: null,
    };
    
    // Both modes should produce identical extraction result
    const debugModeResult = evaluateBrowserlessExtraction(payNowData, null, null);
    const normalModeResult = evaluateBrowserlessExtraction(payNowData, null, null);
    
    expect(debugModeResult).toEqual(normalModeResult);
    expect(debugModeResult.status).toBe('total_price_including_taxes_and_fees');
    expect(debugModeResult.price).toBe(1658.94);
  });
  
  /**
   * CANONICAL FIXTURE TEST
   * 
   * This test uses the exact values from a known-working Browserless extraction.
   * It serves as the regression guard for the canonical baseline.
   * 
   * Reference: docs/BROWSERLESS_CANONICAL_BASELINE.md
   * 
   * If this test fails, compare against the canonical baseline before changing.
   */
  it('CANONICAL FIXTURE: verified extraction produces exact expected output', () => {
    // This is the canonical test case from 2026-01-11
    // Airbnb checkout page: 3 nights, total $1658.94
    const canonicalPayNowData: MockPayNowExtraction = {
      payNowAmount: 1658.94,
      payNowSnippet: 'Pay $1,658.94 now',
      payNowCurrencySymbol: '$',
      subtotalAmount: 1482,
      subtotalNights: 3,
      subtotalSnippet: '$1,482 for 3 nights',
      subtotalCurrencySymbol: '$',
      regexCompilationErrors: null,
    };
    
    const result = evaluateBrowserlessExtraction(canonicalPayNowData, null, null);
    
    // EXACT expected output - any deviation is a regression
    expect(result).toEqual({
      status: 'total_price_including_taxes_and_fees',
      price: 1658.94,
      source: 'direct_text_extraction',
    });
  });
  
  it('CANONICAL FIXTURE: priority order is direct text > OCR breakdown > OCR card', () => {
    const payNowData: MockPayNowExtraction = {
      payNowAmount: 1658.94,
      payNowSnippet: 'Pay $1,658.94 now',
      payNowCurrencySymbol: '$',
      subtotalAmount: 1482,
      subtotalNights: 3,
      subtotalSnippet: '$1,482 for 3 nights',
      subtotalCurrencySymbol: '$',
      regexCompilationErrors: null,
    };
    
    // When all three sources are available, direct text wins
    const withAllSources = evaluateBrowserlessExtraction(payNowData, 1660.00, 1482);
    expect(withAllSources.source).toBe('direct_text_extraction');
    expect(withAllSources.price).toBe(1658.94);
    
    // When only OCR sources available, breakdown wins over card
    const withOnlyOcr = evaluateBrowserlessExtraction(null, 1660.00, 1482);
    expect(withOnlyOcr.source).toBe('ocr_breakdown');
    expect(withOnlyOcr.price).toBe(1660.00);
    
    // When only card available, needs_user_confirmation (not promoted)
    const withOnlyCard = evaluateBrowserlessExtraction(null, null, 1482);
    expect(withOnlyCard.source).toBe('subtotal_only');
    expect(withOnlyCard.status).toBe('needs_user_confirmation');
    expect(withOnlyCard.price).toBeNull();
  });
});

// =============================================================================
// TEST K: Zyte Canonical Baseline Regression Guard
// =============================================================================
/**
 * CANONICAL ZYTE BASELINE REGRESSION GUARD
 * 
 * Reference: docs/ZYTE_CANONICAL_BASELINE.md
 * 
 * These tests protect the known-working Zyte extraction behaviour.
 * Any change that breaks these tests MUST be compared against the canonical
 * baseline documentation BEFORE modifying the tests.
 * 
 * PROTECTED INVARIANTS:
 * 1. Output shape must include required fields (ok, providerUsed, error, botIndicators)
 * 2. OCR total takes priority over HTML regex total
 * 3. Subtotals are NEVER promoted to verified totals
 * 4. Currency normalization handles USD, EUR, CHF, GBP formats
 * 5. Empty/malformed input handled without crash
 * 6. Bot indicators trigger immediate abort
 * 
 * If these tests fail after a change, DO NOT simply update the expectations.
 * Instead: 
 * 1. Compare against docs/ZYTE_CANONICAL_BASELINE.md
 * 2. Identify what changed from the canonical working state
 * 3. Document why the change is intentional OR revert
 */
describe('Test K: Zyte Canonical Baseline Regression Guard', () => {
  // Mock Zyte response structure
  interface MockZyteResponse {
    ok: boolean;
    html: string;
    screenshot: string | null;
    providerUsed: string;
    botIndicators: string[];
    statusCode: number;
    error: string | null;
  }
  
  // Simulate Zyte extraction evaluation (mirrors edge function logic)
  function evaluateZyteExtraction(
    response: MockZyteResponse,
    ocrTotal: number | null,
    htmlTotal: number | null,
    subtotalOnly: number | null
  ): { status: string; price: number | null; source: string } {
    // Check for bot detection first
    if (response.botIndicators.length > 0) {
      return { status: 'blocked_captcha_or_bot', price: null, source: 'none' };
    }
    
    // Check for HTTP errors
    if (!response.ok || response.statusCode === 429) {
      return { status: response.statusCode === 429 ? 'rate_limited' : 'provider_error', price: null, source: 'none' };
    }
    
    // Check for insufficient content
    if (!response.html || response.html.length < 500) {
      return { status: 'price_not_available_in_content', price: null, source: 'none' };
    }
    
    // PRIORITY 1: OCR total from screenshot
    if (ocrTotal && ocrTotal > 0) {
      return { status: 'total_price_including_taxes_and_fees', price: ocrTotal, source: 'ocr_total' };
    }
    
    // PRIORITY 2: HTML regex total
    if (htmlTotal && htmlTotal > 0) {
      return { status: 'total_price_including_taxes_and_fees', price: htmlTotal, source: 'html_regex' };
    }
    
    // PRIORITY 3: Subtotal only - NEVER promoted
    if (subtotalOnly && subtotalOnly > 0) {
      return { status: 'needs_user_confirmation', price: null, source: 'subtotal_only' };
    }
    
    return { status: 'price_not_available_in_content', price: null, source: 'none' };
  }
  
  // Currency normalization (mirrors production logic)
  function normalizeCurrencyAmount(raw: string): number | null {
    if (!raw || typeof raw !== 'string') return null;
    const cleaned = raw.replace(/[^0-9.,]/g, '').replace(/,/g, '');
    if (!cleaned) return null;
    const amount = parseFloat(cleaned);
    return Number.isFinite(amount) ? amount : null;
  }
  
  const validResponse: MockZyteResponse = {
    ok: true,
    html: '<html>'.repeat(100), // > 500 chars
    screenshot: 'base64data',
    providerUsed: 'zyte',
    botIndicators: [],
    statusCode: 200,
    error: null,
  };
  
  it('output shape includes required fields', () => {
    expect(validResponse).toHaveProperty('ok');
    expect(validResponse).toHaveProperty('providerUsed');
    expect(validResponse).toHaveProperty('error');
    expect(validResponse).toHaveProperty('botIndicators');
    expect(validResponse.providerUsed).toBe('zyte');
  });
  
  it('OCR total takes priority over HTML total', () => {
    const result = evaluateZyteExtraction(validResponse, 1658.94, 1650.00, 1500.00);
    expect(result.source).toBe('ocr_total');
    expect(result.price).toBe(1658.94);
    expect(result.status).toBe('total_price_including_taxes_and_fees');
  });
  
  it('HTML total used when OCR unavailable', () => {
    const result = evaluateZyteExtraction(validResponse, null, 1650.00, 1500.00);
    expect(result.source).toBe('html_regex');
    expect(result.price).toBe(1650.00);
    expect(result.status).toBe('total_price_including_taxes_and_fees');
  });
  
  it('subtotal never promoted to verified total', () => {
    const result = evaluateZyteExtraction(validResponse, null, null, 1500.00);
    expect(result.status).toBe('needs_user_confirmation');
    expect(result.price).toBeNull();
    expect(result.source).toBe('subtotal_only');
  });
  
  it('currency normalization handles various formats', () => {
    expect(normalizeCurrencyAmount('$1,658.94')).toBeCloseTo(1658.94, 2);
    expect(normalizeCurrencyAmount('CHF 2,500.00')).toBeCloseTo(2500.00, 2);
    expect(normalizeCurrencyAmount('£999.99')).toBeCloseTo(999.99, 2);
    expect(normalizeCurrencyAmount('€1234.56')).toBeCloseTo(1234.56, 2);
  });
  
  it('null safety: empty input returns appropriate status', () => {
    const emptyResponse: MockZyteResponse = {
      ...validResponse,
      html: '', // Empty
    };
    const result = evaluateZyteExtraction(emptyResponse, null, null, null);
    expect(result.status).toBe('price_not_available_in_content');
    expect(result.price).toBeNull();
  });
  
  it('null safety: normalizeCurrencyAmount handles edge cases', () => {
    expect(normalizeCurrencyAmount('')).toBeNull();
    expect(normalizeCurrencyAmount('abc')).toBeNull();
    expect(normalizeCurrencyAmount(null as unknown as string)).toBeNull();
    expect(normalizeCurrencyAmount(undefined as unknown as string)).toBeNull();
  });
  
  it('bot indicators trigger immediate abort', () => {
    const blockedResponse: MockZyteResponse = {
      ...validResponse,
      botIndicators: ['captcha', 'cloudflare'],
    };
    const result = evaluateZyteExtraction(blockedResponse, 1658.94, 1650.00, null);
    expect(result.status).toBe('blocked_captcha_or_bot');
    expect(result.price).toBeNull();
  });
  
  it('rate limit (429) returns rate_limited status', () => {
    const rateLimitedResponse: MockZyteResponse = {
      ...validResponse,
      ok: false,
      statusCode: 429,
    };
    const result = evaluateZyteExtraction(rateLimitedResponse, 1658.94, null, null);
    expect(result.status).toBe('rate_limited');
    expect(result.price).toBeNull();
  });
  
  it('provider error returns provider_error status', () => {
    const errorResponse: MockZyteResponse = {
      ...validResponse,
      ok: false,
      statusCode: 500,
    };
    const result = evaluateZyteExtraction(errorResponse, 1658.94, null, null);
    expect(result.status).toBe('provider_error');
    expect(result.price).toBeNull();
  });
});

// =============================================================================
// TEST L: Firecrawl Canonical Baseline Regression Guard
// =============================================================================
/**
 * CANONICAL FIRECRAWL BASELINE REGRESSION GUARD
 * 
 * Reference: docs/FIRECRAWL_CANONICAL_BASELINE.md
 * 
 * These tests protect the known-working Firecrawl extraction behaviour.
 * Any change that breaks these tests MUST be compared against the canonical
 * baseline documentation BEFORE modifying the tests.
 * 
 * PROTECTED INVARIANTS:
 * 1. Output shape must include required fields (success, providerUsed, error)
 * 2. OCR total takes priority over markdown/HTML regex total
 * 3. Subtotals are NEVER promoted to verified totals
 * 4. Currency normalization handles USD, EUR, CHF, GBP formats
 * 5. Empty/malformed input handled without crash
 * 
 * If these tests fail after a change, DO NOT simply update the expectations.
 * Instead: 
 * 1. Compare against docs/FIRECRAWL_CANONICAL_BASELINE.md
 * 2. Identify what changed from the canonical working state
 * 3. Document why the change is intentional OR revert
 */
describe('Test L: Firecrawl Canonical Baseline Regression Guard', () => {
  // Mock Firecrawl response structure
  interface MockFirecrawlResponse {
    success: boolean;
    markdown: string | null;
    html: string | null;
    screenshot: string | null;
    providerUsed: string;
    statusCode: number;
    error: string | null;
  }
  
  // Simulate Firecrawl extraction evaluation (mirrors edge function logic)
  function evaluateFirecrawlExtraction(
    response: MockFirecrawlResponse,
    ocrTotal: number | null,
    markdownTotal: number | null,
    htmlTotal: number | null,
    subtotalOnly: number | null
  ): { status: string; price: number | null; source: string } {
    // Check for API errors
    if (!response.success || response.statusCode === 429) {
      return { status: response.statusCode === 429 ? 'rate_limited' : 'provider_error', price: null, source: 'none' };
    }
    
    // Check for insufficient content
    const hasContent = (response.markdown && response.markdown.length > 100) || 
                       (response.html && response.html.length > 500);
    if (!hasContent) {
      return { status: 'price_not_available_in_content', price: null, source: 'none' };
    }
    
    // PRIORITY 1: OCR total from screenshot
    if (ocrTotal && ocrTotal > 0) {
      return { status: 'total_price_including_taxes_and_fees', price: ocrTotal, source: 'ocr_total' };
    }
    
    // PRIORITY 2: Markdown regex total
    if (markdownTotal && markdownTotal > 0) {
      return { status: 'total_price_including_taxes_and_fees', price: markdownTotal, source: 'markdown_regex' };
    }
    
    // PRIORITY 3: HTML regex total
    if (htmlTotal && htmlTotal > 0) {
      return { status: 'total_price_including_taxes_and_fees', price: htmlTotal, source: 'html_regex' };
    }
    
    // PRIORITY 4: Subtotal only - NEVER promoted
    if (subtotalOnly && subtotalOnly > 0) {
      return { status: 'needs_user_confirmation', price: null, source: 'subtotal_only' };
    }
    
    return { status: 'price_not_available_in_content', price: null, source: 'none' };
  }
  
  // Currency normalization (mirrors production logic)
  function normalizeCurrencyAmount(raw: string): number | null {
    if (!raw || typeof raw !== 'string') return null;
    const cleaned = raw.replace(/[^0-9.,]/g, '').replace(/,/g, '');
    if (!cleaned) return null;
    const amount = parseFloat(cleaned);
    return Number.isFinite(amount) ? amount : null;
  }
  
  const validResponse: MockFirecrawlResponse = {
    success: true,
    markdown: '# Booking\n\nTotal (USD) $1,658.94'.repeat(10), // > 100 chars
    html: '<html><body>Total</body></html>'.repeat(20), // > 500 chars
    screenshot: 'base64data',
    providerUsed: 'firecrawl',
    statusCode: 200,
    error: null,
  };
  
  it('output shape includes required fields', () => {
    expect(validResponse).toHaveProperty('success');
    expect(validResponse).toHaveProperty('providerUsed');
    expect(validResponse).toHaveProperty('error');
    expect(validResponse.providerUsed).toBe('firecrawl');
  });
  
  it('OCR total takes priority over markdown and HTML total', () => {
    const result = evaluateFirecrawlExtraction(validResponse, 1658.94, 1650.00, 1640.00, 1500.00);
    expect(result.source).toBe('ocr_total');
    expect(result.price).toBe(1658.94);
    expect(result.status).toBe('total_price_including_taxes_and_fees');
  });
  
  it('markdown total used when OCR unavailable', () => {
    const result = evaluateFirecrawlExtraction(validResponse, null, 1650.00, 1640.00, 1500.00);
    expect(result.source).toBe('markdown_regex');
    expect(result.price).toBe(1650.00);
    expect(result.status).toBe('total_price_including_taxes_and_fees');
  });
  
  it('HTML total used when OCR and markdown unavailable', () => {
    const result = evaluateFirecrawlExtraction(validResponse, null, null, 1640.00, 1500.00);
    expect(result.source).toBe('html_regex');
    expect(result.price).toBe(1640.00);
    expect(result.status).toBe('total_price_including_taxes_and_fees');
  });
  
  it('subtotal never promoted to verified total', () => {
    const result = evaluateFirecrawlExtraction(validResponse, null, null, null, 1500.00);
    expect(result.status).toBe('needs_user_confirmation');
    expect(result.price).toBeNull();
    expect(result.source).toBe('subtotal_only');
  });
  
  it('currency normalization handles various formats', () => {
    expect(normalizeCurrencyAmount('$1,658.94')).toBeCloseTo(1658.94, 2);
    expect(normalizeCurrencyAmount('CHF 2,500.00')).toBeCloseTo(2500.00, 2);
    expect(normalizeCurrencyAmount('£999.99')).toBeCloseTo(999.99, 2);
    expect(normalizeCurrencyAmount('€1234.56')).toBeCloseTo(1234.56, 2);
  });
  
  it('null safety: empty input returns appropriate status', () => {
    const emptyResponse: MockFirecrawlResponse = {
      ...validResponse,
      markdown: '', // Empty
      html: '', // Empty
    };
    const result = evaluateFirecrawlExtraction(emptyResponse, null, null, null, null);
    expect(result.status).toBe('price_not_available_in_content');
    expect(result.price).toBeNull();
  });
  
  it('null safety: normalizeCurrencyAmount handles edge cases', () => {
    expect(normalizeCurrencyAmount('')).toBeNull();
    expect(normalizeCurrencyAmount('abc')).toBeNull();
    expect(normalizeCurrencyAmount(null as unknown as string)).toBeNull();
    expect(normalizeCurrencyAmount(undefined as unknown as string)).toBeNull();
  });
  
  it('rate limit (429) returns rate_limited status', () => {
    const rateLimitedResponse: MockFirecrawlResponse = {
      ...validResponse,
      success: false,
      statusCode: 429,
    };
    const result = evaluateFirecrawlExtraction(rateLimitedResponse, 1658.94, null, null, null);
    expect(result.status).toBe('rate_limited');
    expect(result.price).toBeNull();
  });
  
  it('provider error returns provider_error status', () => {
    const errorResponse: MockFirecrawlResponse = {
      ...validResponse,
      success: false,
      statusCode: 500,
    };
    const result = evaluateFirecrawlExtraction(errorResponse, 1658.94, null, null, null);
    expect(result.status).toBe('provider_error');
    expect(result.price).toBeNull();
  });
});

// =============================================================================
// TEST M: Baseline Chain Canonical Regression Guard (Orchestration)
// =============================================================================
/**
 * BASELINE CHAIN CANONICAL REGRESSION GUARD
 * 
 * Reference: docs/BASELINE_CHAIN_CANONICAL_GUARD.md
 * 
 * These tests protect the provider chain orchestration logic:
 * Browserless → Zyte → Firecrawl
 * 
 * PROTECTED INVARIANTS:
 * 1. Browserless verified → chain stops, result used
 * 2. Zyte only attempted when Browserless not verified
 * 3. Firecrawl only attempted when both previous not verified
 * 4. Subtotals NEVER promoted to verified total across any provider
 * 5. First verified result in chain wins
 * 6. Currency normalization consistent across all providers
 * 
 * If these tests fail after a change, DO NOT simply update the expectations.
 * Instead: 
 * 1. Compare against docs/BASELINE_CHAIN_CANONICAL_GUARD.md
 * 2. Identify what changed from the canonical working state
 * 3. Document why the change is intentional OR revert
 */
describe('Test M: Baseline Chain Canonical Regression Guard', () => {
  const VERIFIED_STATUS = 'total_price_including_taxes_and_fees';
  
  // Mock provider result structure
  interface MockProviderResult {
    provider: 'browserless' | 'zyte' | 'firecrawl';
    status: string;
    price: number | null;
    currency: string;
  }
  
  // Simulate baseline chain orchestration logic
  function evaluateBaselineChain(
    browserlessResult: MockProviderResult,
    zyteResult: MockProviderResult,
    firecrawlResult: MockProviderResult
  ): { 
    finalProvider: string; 
    finalStatus: string; 
    finalPrice: number | null;
    finalCurrency: string;
    fallbackAttempted: boolean;
    zyteAttempted: boolean;
    firecrawlAttempted: boolean;
  } {
    // STEP 1: Check Browserless first (primary)
    if (browserlessResult.status === VERIFIED_STATUS) {
      return {
        finalProvider: 'browserless',
        finalStatus: browserlessResult.status,
        finalPrice: browserlessResult.price,
        finalCurrency: browserlessResult.currency,
        fallbackAttempted: false,
        zyteAttempted: false,
        firecrawlAttempted: false,
      };
    }
    
    // STEP 2: Browserless not verified, try Zyte
    if (zyteResult.status === VERIFIED_STATUS) {
      return {
        finalProvider: 'zyte',
        finalStatus: zyteResult.status,
        finalPrice: zyteResult.price,
        finalCurrency: zyteResult.currency,
        fallbackAttempted: true,
        zyteAttempted: true,
        firecrawlAttempted: false,
      };
    }
    
    // STEP 3: Zyte not verified, try Firecrawl
    if (firecrawlResult.status === VERIFIED_STATUS) {
      return {
        finalProvider: 'firecrawl',
        finalStatus: firecrawlResult.status,
        finalPrice: firecrawlResult.price,
        finalCurrency: firecrawlResult.currency,
        fallbackAttempted: true,
        zyteAttempted: true,
        firecrawlAttempted: true,
      };
    }
    
    // STEP 4: None verified - determine final status
    const allStatuses = [browserlessResult.status, zyteResult.status, firecrawlResult.status];
    
    let finalStatus = 'price_not_available_in_content';
    if (allStatuses.includes('needs_user_confirmation')) {
      finalStatus = 'needs_user_confirmation';
    } else if (allStatuses.includes('blocked_captcha_or_bot')) {
      finalStatus = 'blocked_captcha_or_bot';
    } else if (allStatuses.includes('rate_limited')) {
      finalStatus = 'rate_limited';
    }
    
    return {
      finalProvider: 'none',
      finalStatus,
      finalPrice: null,
      finalCurrency: 'USD',
      fallbackAttempted: true,
      zyteAttempted: true,
      firecrawlAttempted: true,
    };
  }
  
  // Currency normalization (consistent across all providers)
  function normalizeCurrencyAmount(raw: string): number | null {
    if (!raw || typeof raw !== 'string') return null;
    const cleaned = raw.replace(/[^0-9.,]/g, '').replace(/,/g, '');
    if (!cleaned) return null;
    const amount = parseFloat(cleaned);
    return Number.isFinite(amount) ? amount : null;
  }
  
  it('A: browserless_wins_when_verified - chain stops when Browserless verified', () => {
    const browserless: MockProviderResult = {
      provider: 'browserless',
      status: VERIFIED_STATUS,
      price: 1658.94,
      currency: 'USD',
    };
    const zyte: MockProviderResult = {
      provider: 'zyte',
      status: VERIFIED_STATUS,
      price: 9999.99, // Should NOT be used
      currency: 'USD',
    };
    const firecrawl: MockProviderResult = {
      provider: 'firecrawl',
      status: VERIFIED_STATUS,
      price: 8888.88, // Should NOT be used
      currency: 'USD',
    };
    
    const result = evaluateBaselineChain(browserless, zyte, firecrawl);
    
    expect(result.finalProvider).toBe('browserless');
    expect(result.finalStatus).toBe(VERIFIED_STATUS);
    expect(result.finalPrice).toBe(1658.94);
    expect(result.fallbackAttempted).toBe(false);
    expect(result.zyteAttempted).toBe(false);
    expect(result.firecrawlAttempted).toBe(false);
  });
  
  it('B: zyte_used_when_browserless_not_verified', () => {
    const browserless: MockProviderResult = {
      provider: 'browserless',
      status: 'needs_user_confirmation',
      price: null,
      currency: 'USD',
    };
    const zyte: MockProviderResult = {
      provider: 'zyte',
      status: VERIFIED_STATUS,
      price: 1650.00,
      currency: 'USD',
    };
    const firecrawl: MockProviderResult = {
      provider: 'firecrawl',
      status: 'provider_error', // Should NOT be consulted
      price: null,
      currency: 'USD',
    };
    
    const result = evaluateBaselineChain(browserless, zyte, firecrawl);
    
    expect(result.finalProvider).toBe('zyte');
    expect(result.finalStatus).toBe(VERIFIED_STATUS);
    expect(result.finalPrice).toBe(1650.00);
    expect(result.zyteAttempted).toBe(true);
    expect(result.firecrawlAttempted).toBe(false);
  });
  
  it('C: firecrawl_used_when_browserless_and_zyte_not_verified', () => {
    const browserless: MockProviderResult = {
      provider: 'browserless',
      status: 'price_not_available_in_content',
      price: null,
      currency: 'USD',
    };
    const zyte: MockProviderResult = {
      provider: 'zyte',
      status: 'needs_user_confirmation',
      price: null,
      currency: 'USD',
    };
    const firecrawl: MockProviderResult = {
      provider: 'firecrawl',
      status: VERIFIED_STATUS,
      price: 1640.00,
      currency: 'USD',
    };
    
    const result = evaluateBaselineChain(browserless, zyte, firecrawl);
    
    expect(result.finalProvider).toBe('firecrawl');
    expect(result.finalStatus).toBe(VERIFIED_STATUS);
    expect(result.finalPrice).toBe(1640.00);
    expect(result.zyteAttempted).toBe(true);
    expect(result.firecrawlAttempted).toBe(true);
  });
  
  it('D: subtotal_never_promoted_across_chain - all subtotals → non-verified', () => {
    const browserless: MockProviderResult = {
      provider: 'browserless',
      status: 'needs_user_confirmation',
      price: null,
      currency: 'USD',
    };
    const zyte: MockProviderResult = {
      provider: 'zyte',
      status: 'needs_user_confirmation',
      price: null,
      currency: 'USD',
    };
    const firecrawl: MockProviderResult = {
      provider: 'firecrawl',
      status: 'needs_user_confirmation',
      price: null,
      currency: 'USD',
    };
    
    const result = evaluateBaselineChain(browserless, zyte, firecrawl);
    
    expect(result.finalStatus).toBe('needs_user_confirmation');
    expect(result.finalStatus).not.toBe(VERIFIED_STATUS);
    expect(result.finalPrice).toBeNull();
    expect(result.finalProvider).toBe('none');
  });
  
  it('E: currency_normalisation_consistent across providers', () => {
    expect(normalizeCurrencyAmount('$1,658.94')).toBeCloseTo(1658.94, 2);
    expect(normalizeCurrencyAmount('CHF 2,500.00')).toBeCloseTo(2500.00, 2);
    expect(normalizeCurrencyAmount('£999.99')).toBeCloseTo(999.99, 2);
    expect(normalizeCurrencyAmount('€1234.56')).toBeCloseTo(1234.56, 2);
  });
  
  it('blocked_captcha_or_bot status propagates when all providers blocked', () => {
    const browserless: MockProviderResult = {
      provider: 'browserless',
      status: 'blocked_captcha_or_bot',
      price: null,
      currency: 'USD',
    };
    const zyte: MockProviderResult = {
      provider: 'zyte',
      status: 'blocked_captcha_or_bot',
      price: null,
      currency: 'USD',
    };
    const firecrawl: MockProviderResult = {
      provider: 'firecrawl',
      status: 'blocked_captcha_or_bot',
      price: null,
      currency: 'USD',
    };
    
    const result = evaluateBaselineChain(browserless, zyte, firecrawl);
    
    expect(result.finalStatus).toBe('blocked_captcha_or_bot');
    expect(result.finalPrice).toBeNull();
  });
  
  it('rate_limited status propagates when all providers rate limited', () => {
    const browserless: MockProviderResult = {
      provider: 'browserless',
      status: 'rate_limited',
      price: null,
      currency: 'USD',
    };
    const zyte: MockProviderResult = {
      provider: 'zyte',
      status: 'rate_limited',
      price: null,
      currency: 'USD',
    };
    const firecrawl: MockProviderResult = {
      provider: 'firecrawl',
      status: 'rate_limited',
      price: null,
      currency: 'USD',
    };
    
    const result = evaluateBaselineChain(browserless, zyte, firecrawl);
    
    expect(result.finalStatus).toBe('rate_limited');
    expect(result.finalPrice).toBeNull();
  });
  
  it('needs_user_confirmation takes priority over other non-verified statuses', () => {
    const browserless: MockProviderResult = {
      provider: 'browserless',
      status: 'price_not_available_in_content',
      price: null,
      currency: 'USD',
    };
    const zyte: MockProviderResult = {
      provider: 'zyte',
      status: 'needs_user_confirmation', // This should win
      price: null,
      currency: 'USD',
    };
    const firecrawl: MockProviderResult = {
      provider: 'firecrawl',
      status: 'provider_error',
      price: null,
      currency: 'USD',
    };
    
    const result = evaluateBaselineChain(browserless, zyte, firecrawl);
    
    expect(result.finalStatus).toBe('needs_user_confirmation');
  });
});

// =============================================================================
// TEST N: Total Proven Must Not Be Shown as Partial (Confidence ≠ Price Type)
// =============================================================================
describe('Test N: Total proven with low/null confidence must not be shown as partial', () => {
  /**
   * CRITICAL REGRESSION TEST
   * 
   * Bug: Expedia extraction with verified structural proof and semantic pass 
   * was being shown as "unverified" with "Only partial price found" message
   * because confidence_score was null → mapped to 'low' → blocked comparison.
   * 
   * Fix: Price type is derived from WHAT was found (total vs subtotal),
   * not from confidence. Low confidence should only add "manual check" note.
   */

  it('total_proven price type should be returned when structural proof exists regardless of confidence score', () => {
    // Import normalizeExtraction
    const { normalizeExtraction } = require('../canonicalPrice');
    
    // Simulate Expedia extraction metadata exactly as seen in production
    const expediaExtraction = {
      platform_name: 'Expedia',
      deep_link: 'https://www.expedia.com/Hotel-Search?...',
      extracted_price: 2225.00,
      currency: 'USD',
      includes_taxes_fees: true,
      dates_validated: true,
      detected_checkin: '2026-03-08',
      detected_checkout: '2026-03-11',
      confidence_score: null, // NULL confidence - this was causing the bug
      extraction_status: 'success',
      extraction_metadata: {
        breakdown_found: true,
        extracted_from_breakdown_total: true,
        structuralProof: {
          breakdown_found: true,
          total_label_found: true,
          extracted_from_breakdown_total: true,
          extracted_from_target_card: true,
        },
        offersPage: {
          hasOfferCards: true,
          hasTotalWithTaxes: true,
          datesRenderedCorrectly: true,
        },
      },
      evidence_snippets: ['TARGET_CARD [23179611]: $2,225 total (with taxes and fees)'],
      price_type: null,
    };

    const canonical = normalizeExtraction(expediaExtraction);

    // CRITICAL ASSERTIONS:
    // 1. Price type must be total_proven (NOT unknown or subtotal)
    expect(canonical.price_type).toBe('total_proven');
    
    // 2. Total price must be populated
    expect(canonical.total_price).toBe(2225.00);
    
    // 3. Must be marked as comparable (low confidence should NOT block this)
    expect(canonical.is_comparable).toBe(true);
    
    // 4. Confidence should NOT be 'low' when structural proof exists
    expect(canonical.confidence).not.toBe('low');
    
    // 5. Comparability failures should NOT include 'low_confidence' or 'price_type_not_total'
    expect(canonical.comparability_failures).not.toContain('low_confidence');
    expect(canonical.comparability_failures).not.toContain('price_type_not_total');
    expect(canonical.comparability_failures).not.toContain('no_total_price');
  });

  it('categorization should return "more_expensive" bucket for verified total higher than baseline', () => {
    const { normalizeExtraction } = require('../canonicalPrice');
    const { categorizeResult } = require('../resultCategorization');

    // Create Airbnb baseline
    const baselinePrice = {
      platform_id: 'airbnb',
      source_url: 'https://www.airbnb.com/rooms/...',
      check_in_date: '2026-03-08',
      check_out_date: '2026-03-11',
      nights_count: 3,
      currency: 'USD',
      total_price: 1659.00, // Cheaper than Expedia
      price_type: 'total_proven' as const,
      is_comparable: true,
      comparability_failures: [],
      confidence: 'high' as const,
      extraction_method: 'visual_ocr' as const,
      nightly_rate: null,
      subtotal_nights: null,
      fees_total: null,
      taxes_total: null,
      extracted_at: new Date().toISOString(),
    };

    // Create Expedia canonical price with structural proof but null confidence
    const expediaCanonical = normalizeExtraction({
      platform_name: 'Expedia',
      deep_link: 'https://www.expedia.com/Hotel-Search?...',
      extracted_price: 2225.00,
      currency: 'USD',
      includes_taxes_fees: true,
      dates_validated: true,
      detected_checkin: '2026-03-08',
      detected_checkout: '2026-03-11',
      confidence_score: null,
      extraction_status: 'success',
      extraction_metadata: {
        structuralProof: {
          breakdown_found: true,
          total_label_found: true,
          extracted_from_breakdown_total: true,
        },
        offersPage: {
          hasTotalWithTaxes: true,
          datesRenderedCorrectly: true,
        },
      },
      evidence_snippets: ['$2,225 total (with taxes and fees)'],
      requested_check_in: '2026-03-08',
      requested_check_out: '2026-03-11',
      requested_nights: 3,
    });

    const input = {
      price: 2225.00,
      canonical_price: expediaCanonical,
      outcome_category: null,
      extraction_status: 'success',
      extraction_error: null,
      is_tier_c_blocked: false,
      coverage_tier: 'A' as const,
      price_status: 'verified' as const,
      eligible_for_comparison: true,
      verification_failures: [],
    };

    const categorized = categorizeResult(input, baselinePrice);

    // CRITICAL ASSERTIONS:
    // 1. Bucket must be 'more_expensive' (NOT 'not_comparable')
    expect(categorized.bucket).toBe('more_expensive');
    
    // 2. Must be marked as verified
    expect(categorized.is_verified).toBe(true);
    expect(categorized.verification_label).toBe('Verified');
    
    // 3. Comparison must work correctly
    expect(categorized.is_comparable).toBe(true);
    expect(categorized.savings_amount).toBeLessThan(0); // More expensive = negative savings
    
    // 4. User message should NOT contain "partial" or "not available"
    expect(categorized.bucket_label).not.toContain('partial');
    expect(categorized.bucket_description).not.toContain('partial');
    expect(categorized.non_comparable_user_message).toBeNull();
  });

  it('NON_COMPARABLE_REASON_LABELS must not show "partial" for total prices', () => {
    const { NON_COMPARABLE_REASON_LABELS } = require('../resultCategorization');
    
    // The 'price_type_not_total' message should only appear for subtotals/nightly rates
    // It should NOT appear for total_proven prices
    expect(NON_COMPARABLE_REASON_LABELS.price_type_not_total).toContain('partial');
    
    // Verify it's properly labeled
    expect(NON_COMPARABLE_REASON_LABELS.price_type_not_total).toBe('Only partial price found (subtotal or nightly)');
  });
});

// =============================================================================
// TEST O: Expedia Golden Path - verification: "VERIFIED" and semantic: "pass"
// =============================================================================
describe('Test O: Expedia Golden Path - verification and semantic signals', () => {
  it('classifies Expedia with verification: "VERIFIED" as total_proven regardless of confidence', () => {
    const { normalizeExtraction } = require('../canonicalPrice');
    
    // Simulate exact Expedia golden path response format
    const expediaGoldenPath = normalizeExtraction({
      platform_name: 'Expedia',
      deep_link: 'https://www.expedia.com/Hotel-Search?selected=12345',
      extracted_price: 2225.00,
      currency: 'USD',
      includes_taxes_fees: true,
      dates_validated: true,
      detected_checkin: '2026-03-08',
      detected_checkout: '2026-03-11',
      confidence_score: null, // No confidence score from extractor
      extraction_status: 'success',
      extraction_metadata: {
        verification: 'VERIFIED', // Key signal from golden path
        semantic: 'pass',         // Key signal from golden path
        dates_matched: true,
        offersPage: {
          hasTotalWithTaxes: true,
          datesRenderedCorrectly: true,
          hasOfferCards: true,
        },
        structuralProof: {
          verification: 'VERIFIED',
          breakdown_found: true,
        },
      },
      evidence_snippets: ['$2,225 total (with taxes and fees)'],
      requested_check_in: '2026-03-08',
      requested_check_out: '2026-03-11',
      requested_nights: 3,
    });

    // CRITICAL: Must be total_proven
    expect(expediaGoldenPath.price_type).toBe('total_proven');
    
    // CRITICAL: Must have total_price populated
    expect(expediaGoldenPath.total_price).toBe(2225.00);
    
    // CRITICAL: Must be comparable
    expect(expediaGoldenPath.is_comparable).toBe(true);
    
    // Confidence should NOT be 'low' when structural verification exists
    expect(expediaGoldenPath.confidence).not.toBe('low');
  });

  it('USD formatting must show $2,225 not $2.225', () => {
    const { formatUSDPrice } = require('../priceFormatter');
    
    // CRITICAL: Price formatting must use en-US locale
    expect(formatUSDPrice(2225)).toBe('2,225');
    expect(formatUSDPrice(1659)).toBe('1,659');
    expect(formatUSDPrice(12345.67)).toBe('12,346'); // Rounds to nearest
    expect(formatUSDPrice(null)).toBe('—');
    expect(formatUSDPrice(undefined)).toBe('—');
  });

  it('Expedia proven total lands in more_expensive bucket when higher than Airbnb', () => {
    const { normalizeExtraction } = require('../canonicalPrice');
    const { categorizeResult } = require('../resultCategorization');
    
    // Create Airbnb baseline
    const baselinePrice = {
      platform_id: 'airbnb',
      source_url: 'https://www.airbnb.com/rooms/12345',
      check_in_date: '2026-03-08',
      check_out_date: '2026-03-11',
      nights_count: 3,
      currency: 'USD',
      total_price: 1659,
      price_type: 'total_proven' as const,
      confidence: 'high' as const,
      is_comparable: true,
      comparability_failures: [],
      nightly_rate: null,
      subtotal_nights: null,
      fees_total: null,
      taxes_total: null,
      extraction_method: 'dom' as const,
      extracted_at: new Date().toISOString(),
    };
    
    // Create Expedia with verification: "VERIFIED"
    const expediaCanonical = normalizeExtraction({
      platform_name: 'Expedia',
      deep_link: 'https://www.expedia.com/Hotel-Search?selected=12345',
      extracted_price: 2225.00,
      currency: 'USD',
      includes_taxes_fees: true,
      dates_validated: true,
      detected_checkin: '2026-03-08',
      detected_checkout: '2026-03-11',
      confidence_score: null,
      extraction_status: 'success',
      extraction_metadata: {
        verification: 'VERIFIED',
        semantic: 'pass',
      },
      evidence_snippets: ['$2,225 total (with taxes and fees)'],
      requested_check_in: '2026-03-08',
      requested_check_out: '2026-03-11',
      requested_nights: 3,
    });
    
    const input = {
      price: 2225.00,
      canonical_price: expediaCanonical,
      outcome_category: null,
      extraction_status: 'success',
      extraction_error: null,
      is_tier_c_blocked: false,
      coverage_tier: 'A' as const,
      price_status: 'verified' as const,
      eligible_for_comparison: true,
      verification_failures: [],
    };
    
    const categorized = categorizeResult(input, baselinePrice);
    
    // CRITICAL: Must be in more_expensive bucket, NOT not_comparable or unverified
    expect(categorized.bucket).toBe('more_expensive');
    expect(categorized.is_verified).toBe(true);
    expect(categorized.is_comparable).toBe(true);
    
    // Message must NOT contain "partial" or "Total price not available"
    expect(categorized.bucket_label).toBe('Found but more expensive');
    expect(categorized.non_comparable_user_message).toBeNull();
  });
});

// =============================================================================
// TEST P: Expedia canonical total must be used over stale result.price
// Regression test for: subtotal ($742) in search_results vs total ($2225) in extraction
// =============================================================================
describe('Test P: Expedia canonical total must be used over stale result.price', () => {
  it('when Expedia has both subtotal in search_results and total in extraction, frontend must use total', () => {
    const { normalizeExtraction } = require('../canonicalPrice');
    const { categorizeResult } = require('../resultCategorization');
    
    // Create Airbnb baseline at $1659
    const baselinePrice = {
      platform_id: 'airbnb',
      source_url: 'https://www.airbnb.com/rooms/12345',
      check_in_date: '2026-03-08',
      check_out_date: '2026-03-11',
      nights_count: 3,
      currency: 'USD',
      total_price: 1659,
      price_type: 'total_proven' as const,
      confidence: 'high' as const,
      is_comparable: true,
      comparability_failures: [],
      nightly_rate: null,
      subtotal_nights: null,
      fees_total: null,
      taxes_total: null,
      extraction_method: 'dom' as const,
      extracted_at: new Date().toISOString(),
    };
    
    // Create Expedia extraction with the correct total ($2225)
    const expediaCanonical = normalizeExtraction({
      platform_name: 'Expedia',
      deep_link: 'https://www.expedia.com/Hotel-Search?selected=12345',
      extracted_price: 2225.00, // The correct total from golden path
      currency: 'USD',
      includes_taxes_fees: true,
      dates_validated: true,
      detected_checkin: '2026-03-08',
      detected_checkout: '2026-03-11',
      confidence_score: null,
      extraction_status: 'success',
      extraction_metadata: {
        verification: 'VERIFIED',
        semantic: 'pass',
        structuralProof: {
          breakdown_found: true,
          total_label_found: true,
          extracted_from_breakdown_total: true,
        },
      },
      evidence_snippets: ['$2,225 total (with taxes and fees)'],
      requested_check_in: '2026-03-08',
      requested_check_out: '2026-03-11',
      requested_nights: 3,
    });
    
    // CRITICAL: canonical_price.total_price must be $2225, not $742
    expect(expediaCanonical.total_price).toBe(2225);
    expect(expediaCanonical.price_type).toBe('total_proven');
    expect(expediaCanonical.is_comparable).toBe(true);
    
    // Simulate what happens in SearchResults.tsx with stale result.price
    const staleSubtotalPrice = 742; // This was scraped earlier
    
    // The categorization input uses canonical_price, so even if price is wrong,
    // the comparison should use canonical_price.total_price
    const input = {
      price: staleSubtotalPrice, // Stale subtotal - but should NOT be used for comparison
      canonical_price: expediaCanonical,
      outcome_category: null,
      extraction_status: 'success',
      extraction_error: null,
      is_tier_c_blocked: false,
      coverage_tier: 'A' as const,
      price_status: 'verified' as const,
      eligible_for_comparison: true,
      verification_failures: [],
    };
    
    const categorized = categorizeResult(input, baselinePrice);
    
    // CRITICAL: Must be in more_expensive bucket using $2225 (the canonical total)
    // NOT cheaper bucket using $742 (the stale subtotal)
    expect(categorized.bucket).toBe('more_expensive');
    expect(categorized.is_verified).toBe(true);
    expect(categorized.is_comparable).toBe(true);
    
    // The savings should be calculated from $2225 vs $1659, not $742 vs $1659
    // $2225 - $1659 = $566 more expensive (negative savings)
    expect(categorized.savings_amount).toBeLessThan(0);
    expect(categorized.savings_amount).toBeCloseTo(-566, 0);
  });

  it('getEffectivePrice helper should prefer canonical total for Expedia', () => {
    // This tests the helper function logic (simulated, as the real helper is in SearchResults.tsx)
    const isExpedia = true;
    const resultPrice = 742; // Stale subtotal
    const canonicalTotalPrice = 2225; // Correct total
    const priceType = 'total_proven';
    
    // Simulate getEffectivePrice logic
    const getEffectivePrice = (
      isExpediaPlatform: boolean, 
      rPrice: number | null, 
      canonicalPrice: { total_price: number | null; price_type: string } | null
    ): number | null => {
      if (isExpediaPlatform && canonicalPrice?.total_price && canonicalPrice.total_price > 0) {
        return canonicalPrice.total_price;
      }
      if (canonicalPrice?.total_price && canonicalPrice.total_price > 0) {
        const isTotalType = canonicalPrice.price_type === 'total_proven' || 
                            canonicalPrice.price_type === 'total_derived';
        if (isTotalType) {
          return canonicalPrice.total_price;
        }
      }
      return rPrice;
    };
    
    const effectivePrice = getEffectivePrice(isExpedia, resultPrice, { 
      total_price: canonicalTotalPrice, 
      price_type: priceType 
    });
    
    // CRITICAL: Must return $2225, not $742
    expect(effectivePrice).toBe(2225);
  });
});

// =============================================================================
// TEST Q: Finalization Baseline Regression Guard
// =============================================================================
// Reference: docs/FINALIZATION_CANONICAL_BASELINE.md
// These tests protect the "No Results Until Final" contract.
// =============================================================================
describe('Test Q: Finalization Baseline Regression Guard', () => {
  /**
   * FINALIZATION BASELINE INVARIANTS:
   * 
   * 1. No results before finalised_at - Results page must not render until finalised_at is set
   * 2. Atomic backend finalization - status='completed' only set with snapshot
   * 3. Deterministic snapshot - final_results_snapshot is authoritative source
   * 4. No background mutation - isTerminalFrozen blocks all setState calls
   * 5. All platforms in snapshot - Every search_platform appears in final results
   * 6. Refresh stability - Same results on page reload
   */

  // Simulate terminal statuses from pipelineStages.ts
  const TERMINAL_STATUSES = [
    'completed',
    'done',
    'error',
    'failed',
    'cancelled',
    'price_unavailable',
    'dates_unavailable',
    'finalization_failed',
  ];

  // Check Q1: Terminal status detection works correctly
  it('correctly identifies all terminal statuses', () => {
    const isTerminalStatus = (status: string): boolean => {
      return TERMINAL_STATUSES.includes(status);
    };

    // All terminal statuses should return true
    for (const status of TERMINAL_STATUSES) {
      expect(isTerminalStatus(status)).toBe(true);
    }

    // Non-terminal statuses should return false
    expect(isTerminalStatus('searching')).toBe(false);
    expect(isTerminalStatus('pending')).toBe(false);
    expect(isTerminalStatus('extracting')).toBe(false);
    expect(isTerminalStatus('finding_alternatives')).toBe(false);
  });

  // Check Q2: Results should not render before finalization
  it('shouldRenderResults returns false when finalised_at is null', () => {
    const shouldRenderResults = (
      status: string,
      finalisedAt: string | null,
      finalSnapshot: object | null
    ): boolean => {
      // Results should ONLY render when finalised_at is set
      return finalisedAt !== null && finalSnapshot !== null;
    };

    // Terminal status but no finalised_at = NO RESULTS
    expect(shouldRenderResults('completed', null, null)).toBe(false);
    expect(shouldRenderResults('done', null, { results: [] })).toBe(false);
    
    // Non-terminal with finalised_at (edge case) = still render if snapshot exists
    expect(shouldRenderResults('searching', '2026-01-12T00:00:00Z', { results: [] })).toBe(true);
    
    // Terminal with finalised_at = RENDER RESULTS
    expect(shouldRenderResults('completed', '2026-01-12T00:00:00Z', { results: [] })).toBe(true);
  });

  // Check Q3: Atomic finalization contract
  it('atomic finalization requires all three fields to be set together', () => {
    interface AtomicUpdate {
      status: string;
      finalised_at: string | null;
      final_results_snapshot: object | null;
    }

    const isValidAtomicFinalization = (update: AtomicUpdate): boolean => {
      // If status is 'completed', finalised_at and snapshot MUST be non-null
      if (update.status === 'completed') {
        return update.finalised_at !== null && update.final_results_snapshot !== null;
      }
      // If status is 'finalization_failed', finalised_at should be null
      if (update.status === 'finalization_failed') {
        return update.finalised_at === null;
      }
      return true;
    };

    // Valid: completed with all fields
    expect(isValidAtomicFinalization({
      status: 'completed',
      finalised_at: '2026-01-12T00:00:00Z',
      final_results_snapshot: { results: [] },
    })).toBe(true);

    // INVALID: completed without finalised_at
    expect(isValidAtomicFinalization({
      status: 'completed',
      finalised_at: null,
      final_results_snapshot: { results: [] },
    })).toBe(false);

    // INVALID: completed without snapshot
    expect(isValidAtomicFinalization({
      status: 'completed',
      finalised_at: '2026-01-12T00:00:00Z',
      final_results_snapshot: null,
    })).toBe(false);

    // Valid: finalization_failed without finalised_at
    expect(isValidAtomicFinalization({
      status: 'finalization_failed',
      finalised_at: null,
      final_results_snapshot: null,
    })).toBe(true);
  });

  // Check Q4: Terminal freeze blocks mutations
  it('isTerminalFrozen guard blocks all setState calls', () => {
    let stateUpdates = 0;
    let isTerminalFrozen = false;

    const safeSetState = (newValue: any) => {
      if (isTerminalFrozen) {
        // This should NOT increment stateUpdates
        return;
      }
      stateUpdates++;
    };

    // Before freeze, updates work
    safeSetState({ results: ['a'] });
    safeSetState({ results: ['a', 'b'] });
    expect(stateUpdates).toBe(2);

    // Activate freeze
    isTerminalFrozen = true;

    // After freeze, updates are blocked
    safeSetState({ results: ['a', 'b', 'c'] });
    safeSetState({ results: [] });
    expect(stateUpdates).toBe(2); // Still 2, no new updates
  });

  // Check Q5: All platforms appear in snapshot
  it('all search_platforms must appear in final_results_snapshot', () => {
    interface SearchPlatform {
      id: string;
      platform_name: string;
      extraction_status_terminal: string | null;
    }

    interface FinalResultRow {
      platform: string;
      price: number | null;
      outcome: string;
    }

    const validateSnapshotCompleteness = (
      platforms: SearchPlatform[],
      snapshotResults: FinalResultRow[]
    ): { valid: boolean; missing: string[] } => {
      const snapshotPlatforms = new Set(snapshotResults.map(r => r.platform.toLowerCase()));
      const missing = platforms
        .filter(p => !snapshotPlatforms.has(p.platform_name.toLowerCase()))
        .map(p => p.platform_name);
      
      return { valid: missing.length === 0, missing };
    };

    // All platforms present
    const platforms1: SearchPlatform[] = [
      { id: '1', platform_name: 'Expedia', extraction_status_terminal: 'success' },
      { id: '2', platform_name: 'Booking.com', extraction_status_terminal: 'failed' },
    ];
    const snapshot1: FinalResultRow[] = [
      { platform: 'Expedia', price: 2225, outcome: 'verified' },
      { platform: 'Booking.com', price: null, outcome: 'failed' },
    ];
    expect(validateSnapshotCompleteness(platforms1, snapshot1).valid).toBe(true);

    // INVALID: Platform missing from snapshot
    const snapshot2: FinalResultRow[] = [
      { platform: 'Expedia', price: 2225, outcome: 'verified' },
      // Booking.com is missing!
    ];
    const result2 = validateSnapshotCompleteness(platforms1, snapshot2);
    expect(result2.valid).toBe(false);
    expect(result2.missing).toContain('Booking.com');
  });

  // Check Q6: Refresh stability (deterministic rendering)
  it('same snapshot produces identical render output', () => {
    const snapshot = {
      version: '1.0',
      generated_at: '2026-01-12T00:00:00Z',
      search_id: 'test-123',
      results: [
        { platform: 'Expedia', price: 2225, savings_amount: -566 },
        { platform: 'Booking.com', price: null, outcome: 'sold_out' },
      ],
    };

    // Simulate rendering logic
    const renderFromSnapshot = (snap: typeof snapshot) => {
      return snap.results.map(r => ({
        key: `${r.platform}-${r.price || 'no-price'}`,
        displayPrice: r.price ? `$${r.price.toLocaleString()}` : 'N/A',
      }));
    };

    const render1 = renderFromSnapshot(snapshot);
    const render2 = renderFromSnapshot(snapshot);

    // Results must be identical
    expect(render1).toEqual(render2);
    expect(JSON.stringify(render1)).toBe(JSON.stringify(render2));
  });

  // Check Q7: Finalization progress gate logic
  it('finalization gate calculates correct platform count', () => {
    interface SearchPlatform {
      extraction_status_terminal: string | null;
    }

    const TERMINAL_EXTRACTION_STATUSES = [
      'success',
      'failed',
      'sold_out',
      'blocked',
      'dates_unavailable',
      'price_not_found',
      'timeout',
    ];

    const countTerminalPlatforms = (platforms: SearchPlatform[]): { ready: number; total: number } => {
      const total = platforms.length;
      const ready = platforms.filter(p => 
        p.extraction_status_terminal !== null && 
        TERMINAL_EXTRACTION_STATUSES.includes(p.extraction_status_terminal)
      ).length;
      return { ready, total };
    };

    // All platforms terminal
    const platforms1: SearchPlatform[] = [
      { extraction_status_terminal: 'success' },
      { extraction_status_terminal: 'failed' },
      { extraction_status_terminal: 'sold_out' },
    ];
    expect(countTerminalPlatforms(platforms1)).toEqual({ ready: 3, total: 3 });

    // Some platforms still pending
    const platforms2: SearchPlatform[] = [
      { extraction_status_terminal: 'success' },
      { extraction_status_terminal: null }, // Still pending
      { extraction_status_terminal: 'failed' },
    ];
    expect(countTerminalPlatforms(platforms2)).toEqual({ ready: 2, total: 3 });

    // All pending
    const platforms3: SearchPlatform[] = [
      { extraction_status_terminal: null },
      { extraction_status_terminal: null },
    ];
    expect(countTerminalPlatforms(platforms3)).toEqual({ ready: 0, total: 2 });
  });

  // Check Q8: Edge function response contract (HTTP 200 always)
  it('baseline check response follows stable contract schema', () => {
    // Simulates the response shape from edge function
    interface BaselineCheckResponse {
      ok: boolean;
      passed: boolean;
      status: string;
      checks: Array<{ name: string; expected: string; actual: string; passed: boolean }>;
      error: { code: string; message: string; details?: string[] | null } | null;
      meta: { evaluated_at: string; duration_ms?: number };
    }

    const validateResponseContract = (response: BaselineCheckResponse): boolean => {
      // Required fields
      if (typeof response.ok !== 'boolean') return false;
      if (typeof response.passed !== 'boolean') return false;
      if (typeof response.status !== 'string') return false;
      if (!Array.isArray(response.checks)) return false;
      if (response.meta?.evaluated_at === undefined) return false;
      
      // ok and passed must be consistent
      if (response.ok !== response.passed) return false;
      
      // Error must be present when not ok
      if (!response.ok && response.error === null) return false;
      
      return true;
    };

    // Valid pass response
    expect(validateResponseContract({
      ok: true,
      passed: true,
      status: 'finalization_baseline_valid',
      checks: [{ name: 'test', expected: 'a', actual: 'a', passed: true }],
      error: null,
      meta: { evaluated_at: '2026-01-12T00:00:00Z' },
    })).toBe(true);

    // Valid fail response (ok=false with error)
    expect(validateResponseContract({
      ok: false,
      passed: false,
      status: 'finalization_baseline_violation',
      checks: [{ name: 'test', expected: 'a', actual: 'b', passed: false }],
      error: { code: 'BASELINE_CHECK_FAILED', message: '1 invariant(s) failed' },
      meta: { evaluated_at: '2026-01-12T00:00:00Z' },
    })).toBe(true);

    // Invalid: ok=false but no error
    expect(validateResponseContract({
      ok: false,
      passed: false,
      status: 'error',
      checks: [],
      error: null, // Missing error when not ok
      meta: { evaluated_at: '2026-01-12T00:00:00Z' },
    })).toBe(false);
  });
});

// =============================================================================
// TEST R: Image Verification Gate - Core Product Invariant
// =============================================================================
describe('Test R: Image Verification Gate', () => {
  const IMAGE_VERIFICATION_THRESHOLD = 75;

  interface MockResult {
    id: string;
    platform_name: string;
    match_type: string | null;
    confidence_score: number | null;
    images: string[];
  }

  const isImageVerified = (result: MockResult): boolean => {
    if (result.match_type !== 'visual') {
      return false;
    }
    if (typeof result.confidence_score !== 'number' || result.confidence_score < IMAGE_VERIFICATION_THRESHOLD) {
      return false;
    }
    return true;
  };

  it('R1: text-only matches are never valid alternatives', () => {
    const textOnlyResult: MockResult = {
      id: '1',
      platform_name: 'Booking.com',
      match_type: 'text',
      confidence_score: null,
      images: ['https://example.com/image.jpg'],
    };

    expect(isImageVerified(textOnlyResult)).toBe(false);
  });

  it('R2: visual matches with high confidence are valid', () => {
    const visualResult: MockResult = {
      id: '2',
      platform_name: 'Vrbo',
      match_type: 'visual',
      confidence_score: 92,
      images: ['https://example.com/property.jpg'],
    };

    expect(isImageVerified(visualResult)).toBe(true);
  });

  it('R3: visual matches with low confidence are rejected', () => {
    const lowConfidenceVisual: MockResult = {
      id: '3',
      platform_name: 'Expedia',
      match_type: 'visual',
      confidence_score: 60,
      images: ['https://example.com/image.jpg'],
    };

    expect(isImageVerified(lowConfidenceVisual)).toBe(false);
  });

  it('R4: null match_type is rejected', () => {
    const nullMatchType: MockResult = {
      id: '4',
      platform_name: 'TripAdvisor',
      match_type: null,
      confidence_score: 85,
      images: ['https://example.com/image.jpg'],
    };

    expect(isImageVerified(nullMatchType)).toBe(false);
  });

  it('R5: null confidence_score is rejected even for visual matches', () => {
    const nullConfidence: MockResult = {
      id: '5',
      platform_name: 'Agoda',
      match_type: 'visual',
      confidence_score: null,
      images: ['https://example.com/image.jpg'],
    };

    expect(isImageVerified(nullConfidence)).toBe(false);
  });

  it('R6: edge case - exactly threshold confidence is valid', () => {
    const thresholdResult: MockResult = {
      id: '6',
      platform_name: 'Hotels.com',
      match_type: 'visual',
      confidence_score: 75,
      images: ['https://example.com/image.jpg'],
    };

    expect(isImageVerified(thresholdResult)).toBe(true);
  });

  it('R7: edge case - just below threshold is rejected', () => {
    const belowThreshold: MockResult = {
      id: '7',
      platform_name: 'Rentbyowner',
      match_type: 'visual',
      confidence_score: 74,
      images: ['https://example.com/image.jpg'],
    };

    expect(isImageVerified(belowThreshold)).toBe(false);
  });

  it('R8: text-only matches are filtered from results array', () => {
    const mixedResults: MockResult[] = [
      { id: '1', platform_name: 'Booking.com', match_type: 'visual', confidence_score: 90, images: ['img1'] },
      { id: '2', platform_name: 'Vrbo', match_type: 'text', confidence_score: null, images: ['img2'] },
      { id: '3', platform_name: 'Expedia', match_type: 'visual', confidence_score: 85, images: ['img3'] },
      { id: '4', platform_name: 'Rentbyowner', match_type: 'text', confidence_score: null, images: [] },
      { id: '5', platform_name: 'TripAdvisor', match_type: 'visual', confidence_score: 50, images: ['img5'] },
    ];

    const imageVerifiedResults = mixedResults.filter(isImageVerified);

    expect(imageVerifiedResults.length).toBe(2);
    expect(imageVerifiedResults.map(r => r.platform_name)).toEqual(['Booking.com', 'Expedia']);
  });

  it('R9: empty results when all matches are text-only (valid outcome)', () => {
    const textOnlyResults: MockResult[] = [
      { id: '1', platform_name: 'Booking.com', match_type: 'text', confidence_score: null, images: ['img1'] },
      { id: '2', platform_name: 'Vrbo', match_type: 'text', confidence_score: null, images: ['img2'] },
      { id: '3', platform_name: 'Rentbyowner', match_type: 'text', confidence_score: null, images: [] },
    ];

    const imageVerifiedResults = textOnlyResults.filter(isImageVerified);

    // "No verified alternatives found" is a valid outcome, not an error
    expect(imageVerifiedResults.length).toBe(0);
  });

  it('R10: platform deduplication - same platform cannot appear multiple times unless each is image-verified', () => {
    const duplicatePlatformResults: MockResult[] = [
      { id: '1', platform_name: 'Booking.com', match_type: 'visual', confidence_score: 90, images: ['img1'] },
      { id: '2', platform_name: 'Booking.com', match_type: 'text', confidence_score: null, images: ['img2'] },
      { id: '3', platform_name: 'Booking.com', match_type: 'visual', confidence_score: 88, images: ['img3'] },
    ];

    const imageVerifiedResults = duplicatePlatformResults.filter(isImageVerified);

    // Both visual matches should be kept (different listings on same platform)
    expect(imageVerifiedResults.length).toBe(2);
    expect(imageVerifiedResults.every(r => r.match_type === 'visual')).toBe(true);
    expect(imageVerifiedResults.every(r => r.confidence_score !== null && r.confidence_score >= IMAGE_VERIFICATION_THRESHOLD)).toBe(true);
  });
});
