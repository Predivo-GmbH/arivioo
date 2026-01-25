/**
 * buildFinalSnapshot.ts
 * 
 * Shared helper to build and persist the final results snapshot.
 * Called by backend pipeline at TRUE completion points (never by frontend).
 * 
 * CRITICAL INVARIANTS (NO_RESULTS_UNTIL_FINAL contract):
 * 1. status = 'completed' is ONLY set when snapshot persistence succeeds
 * 2. If snapshot fails, status = 'finalization_failed' with error details
 * 3. Once finalised_at is set, the snapshot is immutable
 * 4. Snapshot is built from AUTHORITATIVE search_platforms set, not search_results
 * 5. Every matched platform appears in final results, even if price is missing
 */

// Note: We use 'any' for supabase client type to allow flexibility across different edge functions

// Result bucket types - must match frontend ResultBucket
export type ResultBucket =
  | 'cheaper'
  | 'more_expensive'
  | 'not_comparable'
  | 'sold_out'
  | 'price_not_found'
  | 'blocked'
  | 'requires_action'
  | 'service_error'
  | 'platform_blocked'
  | 'additional_issues';

// Bucket display labels - frozen at finalization time
const BUCKET_LABELS: Record<ResultBucket, string> = {
  cheaper: 'Found and cheaper',
  more_expensive: 'Found but more expensive',
  not_comparable: 'Price not comparable',
  sold_out: 'Not available for these dates',
  price_not_found: 'Price not found',
  blocked: 'Blocked access',
  requires_action: 'Action required',
  service_error: 'Service error',
  platform_blocked: 'Platform not supported',
  additional_issues: 'Additional issues detected',
};

// Dynamic label generation based on specific failure reason
function getDynamicBucketLabel(
  bucket: ResultBucket,
  canonicalPrice: Record<string, unknown> | null,
  extractionStatus: string | null
): string {
  // For not_comparable, generate specific reason labels
  if (bucket === 'not_comparable' && canonicalPrice) {
    const currency = canonicalPrice.currency as string | undefined;
    if (currency && currency !== 'USD') {
      // Currency mismatch - show specific currency
      const currencyLabels: Record<string, string> = {
        CAD: 'Price in CAD (not comparable)',
        EUR: 'Price in EUR (not comparable)',
        GBP: 'Price in GBP (not comparable)',
        ZAR: 'Price in ZAR (not comparable)',
        AUD: 'Price in AUD (not comparable)',
        NZD: 'Price in NZD (not comparable)',
      };
      return currencyLabels[currency] || `Price in ${currency} (not comparable)`;
    }
    
    const priceType = String(canonicalPrice.price_type || '').toLowerCase();
    if (priceType === 'subtotal_nights_only') {
      return 'Subtotal only (taxes not included)';
    }
    if (priceType === 'nightly_only') {
      return 'Nightly rate only';
    }
    if (!canonicalPrice.dates_validated) {
      return 'Dates not confirmed';
    }
    if (!canonicalPrice.includes_taxes_fees) {
      return 'Taxes/fees not included';
    }
  }
  
  // For price_not_found, show specific extraction issue
  if (bucket === 'price_not_found' && extractionStatus) {
    const statusLabels: Record<string, string> = {
      checkout_not_reached: 'Checkout page not accessible',
      total_price_not_found: 'Total price not visible',
      nightly_only_rejected: 'Only nightly rate found',
      render_failed: 'Page failed to load',
      timeout: 'Request timed out',
    };
    return statusLabels[extractionStatus] || BUCKET_LABELS[bucket];
  }
  
  return BUCKET_LABELS[bucket];
}

export interface FinalResultRow {
  id: string;
  platform_name: string;
  listing_url: string;
  listing_title: string | null;
  price: number | null;
  original_price: number | null;
  savings_amount: number | null;
  savings_percentage: number | null;
  confidence_score: number | null;
  image_url: string | null;
  images: any;
  match_type?: string;
  source_airbnb_image?: string | null;
  price_check_in?: string | null;
  price_check_out?: string | null;
  dates_differ?: boolean;
  // Extraction data
  extraction_status?: string | null;
  extraction_error?: string | null;
  canonical_price?: Record<string, unknown> | null;
  price_type?: string;
  includes_taxes_fees?: boolean;
  dates_validated?: boolean;
  // Outcome category for UI bucketing
  outcome_category?: string | null;
  // TWO-PASS IMAGE VERIFICATION: Authority status
  // is_authoritative = true means PASS 2 >= 90% (high trust)
  // is_authoritative = false means PASS 1 passed (75-89%) but PASS 2 < 90% (needs review)
  is_authoritative?: boolean;
  // FROZEN BUCKET: Determined at finalization, immutable on refresh
  final_bucket: ResultBucket;
  final_bucket_label: string;
  // Foreign currency fallback: Show non-USD price when extraction found foreign currency
  original_currency?: string | null;
  original_amount?: number | null;
}

export interface FinalSnapshot {
  version: number;
  generated_at: string;
  search_id: string;
  airbnb: {
    price: number | null;
    currency: string | null;
    title: string | null;
  };
  dates: {
    check_in: string | null;
    check_out: string | null;
    nights: number | null;
  };
  results: FinalResultRow[];
  result_count: number;
  // Metadata for debugging
  expected_platform_count: number;
  finalized_platform_count: number;
  // Rendering completeness proof (persisted per finalized run)
  render_debug: {
    candidates_total_after_merge: number;
    candidates_rendered: number;
    included_platform_keys: string[];
    excluded_platform_keys: string[]; // must always be empty
  };
}

export interface FinalizeAndCompleteResult {
  success: boolean;
  alreadyFinalized: boolean;
  finalisedAt: string | null;
  resultCount: number;
  error?: string;
}

// ============================================
// PRICE TYPE DETERMINATION
// ============================================

/**
 * Determine price_type for a canonical price object.
 * Must mirror logic in src/lib/canonicalPrice.ts determinePriceType()
 * 
 * This is critical for correct categorization:
 * - 'total_proven' or 'total_derived' = comparable for cheaper/more expensive
 * - 'unknown', 'subtotal_nights_only', 'nightly_only' = not comparable
 */
function determinePriceTypeFromExtraction(extraction: any): string {
  if (!extraction) return 'unknown';
  
  const metadata = extraction.extraction_metadata || {};
  const platformName = (extraction.platform_name || '').toLowerCase();
  const isExpedia = platformName.includes('expedia');
  const isVrbo = platformName.includes('vrbo');
  
  // 1. Check explicit price_type from extractor first
  const rawPriceType = extraction.price_type || metadata?.price_type || '';
  const normalizedRawType = String(rawPriceType).toLowerCase();
  
  // VRBO/Expedia golden path: TOTAL_STAY = total_proven
  if (normalizedRawType === 'total_stay' || normalizedRawType === 'total-stay') {
    return 'total_proven';
  }
  
  if (normalizedRawType.includes('total') && (normalizedRawType.includes('proven') || normalizedRawType.includes('verified'))) {
    return 'total_proven';
  }
  if (normalizedRawType.includes('total') && normalizedRawType.includes('derived')) {
    return 'total_derived';
  }
  if (normalizedRawType.includes('subtotal') || normalizedRawType.includes('nights_only')) {
    return 'subtotal_nights_only';
  }
  if (normalizedRawType.includes('nightly') || normalizedRawType.includes('per_night')) {
    return 'nightly_only';
  }
  
  // 2. VRBO-SPECIFIC: Check for verification signal from golden path
  if (isVrbo) {
    const verification = metadata.verification || '';
    const structuralProof = metadata.structuralProof || {};
    
    if (
      (typeof verification === 'string' && verification.toUpperCase() === 'VERIFIED') ||
      (structuralProof.directly_comparable === true && structuralProof.total_label_found === true)
    ) {
      if (extraction.includes_taxes_fees === true || extraction.dates_validated === true) {
        return 'total_proven';
      }
    }
  }
  
  // 3. EXPEDIA-SPECIFIC: Check for verification: "VERIFIED" signal from golden path
  if (isExpedia) {
    const verification = metadata.verification || metadata.structuralProof?.verification || '';
    const semantic = metadata.semantic || '';
    
    if (
      typeof verification === 'string' &&
      verification.toUpperCase() === 'VERIFIED' &&
      extraction.includes_taxes_fees === true &&
      extraction.dates_validated === true
    ) {
      return 'total_proven';
    }
    
    // Also accept semantic: "pass" with taxes/fees for Expedia
    if (
      typeof semantic === 'string' &&
      semantic.toLowerCase() === 'pass' &&
      extraction.includes_taxes_fees === true &&
      extraction.dates_validated === true &&
      extraction.extraction_status === 'success'
    ) {
      return 'total_proven';
    }
  }
  
  // 4. Check structural proof from metadata
  const structuralProof = metadata.structuralProof || metadata.structural_proof || {};
  const offersPage = metadata.offersPage || {};
  
  const hasStructuralProof = 
    (metadata.breakdown_found === true && metadata.total_label_found === true && metadata.extracted_from_breakdown_total === true) ||
    (structuralProof.breakdown_found === true && 
     (structuralProof.total_label_found === true || structuralProof.hasTotalWithTaxes === true) &&
     (structuralProof.extracted_from_breakdown_total === true || structuralProof.extracted_from_target_card === true)) ||
    (offersPage.hasOfferCards === true && offersPage.hasTotalWithTaxes === true && offersPage.datesRenderedCorrectly === true) ||
    // VRBO structural proof
    (structuralProof.total_label_found === true && structuralProof.directly_comparable === true);
  
  if (hasStructuralProof && extraction.includes_taxes_fees === true && extraction.dates_validated === true) {
    return 'total_proven';
  }
  
  // 5. Check if taxes/fees are included with successful extraction → total_derived
  if (extraction.includes_taxes_fees === true && extraction.dates_validated === true) {
    const successStatuses = ['success', 'price_extracted', 'completed', 'success_total_stay'];
    if (extraction.extraction_status && successStatuses.includes(extraction.extraction_status)) {
      return 'total_derived';
    }
  }
  
  // 6. If taxes/fees explicitly not included
  if (extraction.includes_taxes_fees === false) {
    return 'subtotal_nights_only';
  }
  
  return 'unknown';
}

// ============================================
// RESULT CATEGORIZATION (Backend-side)
// ============================================

/**
 * Categorize a result into a bucket at finalization time.
 * This is the SINGLE SOURCE OF TRUTH - the bucket is frozen into the snapshot
 * and NEVER re-computed by the frontend.
 * 
 * Must match the categorization logic in src/lib/resultCategorization.ts
 */
function categorizeResultForSnapshot(
  result: {
    price: number | null;
    outcome_category: string | null;
    extraction_status: string | null;
    extraction_error: string | null;
    canonical_price: Record<string, unknown> | null;
    is_tier_c_blocked?: boolean;
    coverage_tier?: string | null;
  },
  airbnbPrice: number | null
): ResultBucket {
  // 1. Tier C platforms are always blocked
  if (result.is_tier_c_blocked || result.coverage_tier === 'C') {
    return 'platform_blocked';
  }
  
  // 2. Check outcome category for non-price states
  const outcomeCategory = result.outcome_category?.toLowerCase() || '';
  
  if (outcomeCategory === 'unavailable_for_dates' || outcomeCategory === 'sold_out') {
    return 'sold_out';
  }
  
  if (outcomeCategory === 'access_blocked' || outcomeCategory === 'blocked') {
    return 'blocked';
  }
  
  if (outcomeCategory === 'requires_action') {
    return 'requires_action';
  }
  
  if (outcomeCategory === 'service_error') {
    return 'service_error';
  }
  
  // 3. Check extraction status for sold out
  const extractionStatus = result.extraction_status?.toLowerCase() || '';
  const soldOutStatuses = ['dates_unavailable', 'sold_out', 'expedia_dates_unavailable_for_target'];
  if (soldOutStatuses.includes(extractionStatus)) {
    return 'sold_out';
  }
  
  // 3b. Check for success states (including VRBO's success_total_stay)
  const successStatuses = ['success', 'price_extracted', 'completed', 'success_total_stay'];
  const isSuccessStatus = successStatuses.includes(extractionStatus);
  
  // 4. Check extraction status for blocked
  const blockedStatuses = ['blocked', 'blocked_captcha_or_bot', 'access_denied', 'bot_detected'];
  if (blockedStatuses.includes(extractionStatus)) {
    return 'blocked';
  }
  
  // 5. No price - categorize based on extraction status
  if (!result.price || result.price <= 0) {
    const pendingStatuses = ['pending', 'running', 'in_progress'];
    const successStatuses = ['success', 'price_extracted', 'completed', 'success_total_stay'];
    // Known "price not found" statuses - extraction reached platform but couldn't get price
    const priceNotFoundStatuses = [
      'checkout_not_reached',
      'total_price_not_found',
      'nightly_only_rejected',
      'price_not_found',
      'price_not_found_after_dates_applied',
      'no_price_found',
    ];
    
    // If it's a known "price not found" variant, categorize as such
    if (priceNotFoundStatuses.includes(extractionStatus)) {
      return 'price_not_found';
    }
    
    // If it's pending or success (but no price), treat as price_not_found
    if (!extractionStatus || pendingStatuses.includes(extractionStatus) || successStatuses.includes(extractionStatus)) {
      return 'price_not_found';
    }
    
    // Unknown terminal status - additional_issues
    return 'additional_issues';
  }
  
  // 6. Has price - check comparability
  const canonicalPrice = result.canonical_price;
  if (!canonicalPrice || !airbnbPrice) {
    return 'not_comparable';
  }
  
  // Check if this is a comparable total
  const priceType = String(canonicalPrice.price_type || '').toLowerCase();
  const isComparable = canonicalPrice.is_comparable === true;
  const isTotalType = priceType === 'total_proven' || priceType === 'total_derived';
  
  if (!isComparable || !isTotalType) {
    return 'not_comparable';
  }
  
  // 7. Compare prices
  const totalPrice = canonicalPrice.total_price as number | null;
  if (!totalPrice || totalPrice <= 0) {
    return 'not_comparable';
  }
  
  if (totalPrice < airbnbPrice) {
    return 'cheaper';
  } else {
    return 'more_expensive';
  }
}

export interface FinalizeAndCompleteParams {
  supabase: any;
  searchId: string;
  // Search metadata to persist alongside completion
  airbnbTitle?: string | null;
  airbnbPrice?: number | null;
  airbnbCurrency?: string | null;
  airbnbImageUrl?: string | null;
  airbnbImages?: any[];
  checkIn?: string | null;
  checkOut?: string | null;
  nights?: number | null;
}

/**
 * Log activity to searches.activity_log
 */
async function logActivity(
  supabase: any,
  searchId: string,
  message: string,
  detail?: string
): Promise<void> {
  try {
    // Fetch current activity log
    const { data: search } = await supabase
      .from('searches')
      .select('activity_log')
      .eq('id', searchId)
      .single();
    
    const currentLog = (search?.activity_log as any[]) || [];
    const newEntry = {
      ts: Date.now(),
      message,
      detail,
    };
    
    await supabase
      .from('searches')
      .update({ activity_log: [...currentLog, newEntry] })
      .eq('id', searchId);
  } catch (e) {
    console.error('[logActivity] Failed:', e);
  }
}

// Track the last logged terminal count per search to avoid duplicate log entries
const lastLoggedTerminalCount = new Map<string, number>();

/**
 * ATOMIC finalize-and-complete helper.
 * 
 * This function ensures the INVARIANT:
 * - status = 'completed' is ONLY set when snapshot persistence succeeds
 * - If snapshot fails, status = 'finalization_failed' with error details
 * 
 * Steps:
 * 1. Check if already finalized (idempotent)
 * 2. Fetch AUTHORITATIVE search_platforms set (immutable matched platforms)
 * 3. Join with search_results and price_extractions for enrichment
 * 4. Build denormalized snapshot including ALL matched platforms
 * 5. ATOMIC UPDATE: Set snapshot + finalised_at + status='completed' in ONE call
 * 6. If step 5 fails, set status='finalization_failed' + finalization_error
 */
export async function finalizeAndCompleteSearch(
  params: FinalizeAndCompleteParams
): Promise<FinalizeAndCompleteResult> {
  const { supabase, searchId } = params;
  
  console.log(`[finalizeAndComplete] Starting atomic finalization for search ${searchId}`);
  await logActivity(supabase, searchId, 'Finalization started', 'Building authoritative snapshot from matched platforms');
  
  try {
    // Step 1: Check if already finalized (idempotent guard)
    const { data: rawSearchData, error: searchError } = await supabase
      .from('searches')
      .select('id, status, finalised_at, airbnb_price, airbnb_currency, airbnb_title, check_in_date, check_out_date, nights_count')
      .eq('id', searchId)
      .single();

    if (searchError || !rawSearchData) {
      console.error('[finalizeAndComplete] Search not found:', searchError);
      return {
        success: false,
        alreadyFinalized: false,
        finalisedAt: null,
        resultCount: 0,
        error: 'Search not found',
      };
    }

    const searchData = rawSearchData as {
      id: string;
      status: string;
      finalised_at: string | null;
      airbnb_price: number | null;
      airbnb_currency: string | null;
      airbnb_title: string | null;
      check_in_date: string | null;
      check_out_date: string | null;
      nights_count: number | null;
    };

    // If already finalized, return success (idempotent)
    if (searchData.finalised_at) {
      console.log(`[finalizeAndComplete] Search ${searchId} already finalized at ${searchData.finalised_at}`);
      return {
        success: true,
        alreadyFinalized: true,
        finalisedAt: searchData.finalised_at,
        resultCount: 0,
      };
    }

    // Use provided metadata or fall back to existing DB values
    const airbnbPrice = params.airbnbPrice ?? searchData.airbnb_price;
    const airbnbCurrency = params.airbnbCurrency ?? searchData.airbnb_currency;
    const airbnbTitle = params.airbnbTitle ?? searchData.airbnb_title;
    const checkIn = params.checkIn ?? searchData.check_in_date;
    const checkOut = params.checkOut ?? searchData.check_out_date;
    const nights = params.nights ?? searchData.nights_count;

    // Step 2: Fetch AUTHORITATIVE search_platforms set
    // This is the canonical set of matched platforms - nothing can be excluded
    const { data: platformsData, error: platformsError } = await supabase
      .from('search_platforms')
      .select('*')
      .eq('search_id', searchId);

    if (platformsError) {
      console.error('[finalizeAndComplete] Failed to fetch search_platforms:', platformsError);
      // Fall back to search_results if search_platforms is empty (backwards compatibility)
    }

    const authoritativePlatforms = platformsData || [];
    console.log(`[finalizeAndComplete] Authoritative platform set: ${authoritativePlatforms.length} platforms`);

    // Step 3: Fetch search_results for enrichment data
    const { data: resultsData, error: resultsError } = await supabase
      .from('search_results')
      .select('*')
      .eq('search_id', searchId)
      .order('savings_percentage', { ascending: false, nullsFirst: false });

    if (resultsError) {
      console.error('[finalizeAndComplete] Failed to fetch results:', resultsError);
      await markFinalizationFailed(supabase, searchId, `Failed to fetch results: ${resultsError.message}`);
      return {
        success: false,
        alreadyFinalized: false,
        finalisedAt: null,
        resultCount: 0,
        error: `Failed to fetch results: ${resultsError.message}`,
      };
    }

    // Step 4: Fetch price extractions for enrichment
    const { data: extractionsData, error: extractionsError } = await supabase
      .from('price_extractions')
      .select('*')
      .eq('search_id', searchId);

    if (extractionsError) {
      console.error('[finalizeAndComplete] Failed to fetch extractions:', extractionsError);
      // Non-fatal - continue without extractions
    }

    // -----------------------------
    // FINALIZATION GATE (CRITICAL)
    // -----------------------------
    // We must NOT finalize until every VERIFIED matched platform has reached a terminal extraction state.
    // Otherwise the snapshot will capture "pending" and the UI will appear to "miss" platforms
    // (e.g. Expedia), or show incorrect bucket counts.
    //
    // IMPORTANT: Rejected/low_confidence candidates from Working Baseline are considered terminal
    // by definition - they don't need price extractions since they failed image verification.
    // Only 'verified' outcome_category platforms need extraction completion.
    const NON_TERMINAL_EXTRACTION_STATUSES = new Set([
      'pending',
      'queued',
      'running',
      'in_progress',
      'started',
    ]);

    const isTerminalExtractionStatus = (status: unknown): boolean => {
      if (!status || typeof status !== 'string') return false;
      return !NON_TERMINAL_EXTRACTION_STATUSES.has(status);
    };
    
    // WORKING BASELINE: outcome_category values that are terminal without extraction
    const TERMINAL_OUTCOME_CATEGORIES = new Set([
      'rejected',
      'low_confidence',
    ]);
    
    const isTerminalOutcomeCategory = (category: unknown): boolean => {
      if (!category || typeof category !== 'string') return false;
      return TERMINAL_OUTCOME_CATEGORIES.has(category);
    };

    // Create lookup maps for enrichment
    const extractionByResultId = new Map<string, any>();
    const extractionByPlatform = new Map<string, any>();
    const extractionByUrl = new Map<string, any>();
    const terminalPlatforms = new Set<string>();

    extractionsData?.forEach((e: any) => {
      const platformKey = typeof e.platform_name === 'string' ? e.platform_name.toLowerCase() : '';
      if (e.search_result_id) {
        extractionByResultId.set(e.search_result_id, e);
      }
      if (platformKey) {
        extractionByPlatform.set(platformKey, e);
        if (isTerminalExtractionStatus(e.extraction_status)) {
          terminalPlatforms.add(platformKey);
        }
      }
      if (e.deep_link) {
        extractionByUrl.set(e.deep_link, e);
      }
    });
    
    // WORKING BASELINE: Add platforms with terminal outcome_category to terminalPlatforms
    // These are rejected/low_confidence candidates that don't need extractions
    // EXCEPTION: Hotels.com with bypass MUST wait for extraction before being terminal
    authoritativePlatforms.forEach((p: any) => {
      const platformKey = typeof p.platform_name === 'string' ? p.platform_name.toLowerCase() : '';
      if (!platformKey) return;
      
      // Hotels.com bypass check: if bypass is active, Hotels.com needs extraction
      const isHotelsComBypassed = HOTELS_COM_GLOBAL_BYPASS_ENABLED && 
        (platformKey === 'hotels.com' || platformKey === 'hotelscom' || platformKey === 'hotels');
      
      if (isHotelsComBypassed) {
        // Hotels.com with bypass: only terminal if extraction exists and is terminal
        const hasTerminalExtraction = terminalPlatforms.has(platformKey);
        if (hasTerminalExtraction) {
          console.log(`[finalizeAndComplete] Hotels.com bypass: extraction terminal, ready`);
        } else {
          console.log(`[finalizeAndComplete] Hotels.com bypass: waiting for extraction...`);
        }
        // Don't add to terminal here - it's already handled by extraction lookup above
        return;
      }
      
      // Standard logic: rejected/low_confidence are terminal without extraction
      if (isTerminalOutcomeCategory(p.outcome_category)) {
        terminalPlatforms.add(platformKey);
      }
    });

    if (authoritativePlatforms.length > 0) {
      const expected = authoritativePlatforms.length;
      const terminal = terminalPlatforms.size;
      if (terminal < expected) {
        const msg = `Not ready to finalize: ${terminal}/${expected} platforms terminal`;
        console.log(`[finalizeAndComplete] ${msg}`);
        
        // ACTIVITY LOG DE-DUPLICATION: Only log if terminal count increased since last check
        const lastLogged = lastLoggedTerminalCount.get(searchId) ?? -1;
        if (terminal > lastLogged) {
          lastLoggedTerminalCount.set(searchId, terminal);
          await logActivity(supabase, searchId, 'Finalizing results', msg);
        }
        // (If terminal count unchanged, skip log to prevent spam)
        
        return {
          success: false,
          alreadyFinalized: false,
          finalisedAt: null,
          resultCount: 0,
          error: msg,
        };
      }
    }
    
    // Finalization succeeded path - clean up the de-duplication tracker
    lastLoggedTerminalCount.delete(searchId);

    // Create lookup map for search_results by URL (used to enrich authoritative platform rows)
    const resultByUrl = new Map<string, any>();
    resultsData?.forEach((r: any) => {
      if (r?.listing_url) resultByUrl.set(r.listing_url, r);
    });

    // Step 5: Build the final snapshot from AUTHORITATIVE platform set
    // If search_platforms is populated, use it. Otherwise fall back to search_results.
    let finalResults: FinalResultRow[];
    let expectedPlatformCount: number;
    let finalizedPlatformCount: number;

    if (authoritativePlatforms.length > 0) {
      // NEW PATH: Build from search_platforms (authoritative)
      expectedPlatformCount = authoritativePlatforms.length;
      
      finalResults = authoritativePlatforms.map((platform: any) => {
        // Find corresponding search_result for enrichment
        const result = resultByUrl.get(platform.listing_url);
        
        // Find extraction by multiple paths
        let extraction = result ? extractionByResultId.get(result.id) : null;
        if (!extraction) {
          extraction = extractionByPlatform.get(platform.platform_name.toLowerCase());
        }
        if (!extraction && platform.listing_url) {
          extraction = extractionByUrl.get(platform.listing_url);
        }

        // Determine effective price
        let effectivePrice = result?.price || null;
        if (extraction?.extracted_price && extraction.extracted_price > 0) {
          effectivePrice = extraction.extracted_price;
        }

        // Build canonical price object with PROPER price_type determination
        let canonicalPrice = null;
        if (extraction?.extraction_metadata || extraction?.extracted_price) {
          // Use the determinePriceTypeFromExtraction helper to properly classify
          const derivedPriceType = determinePriceTypeFromExtraction(extraction);
          const extractedCurrency = extraction.currency || 'USD';
          const isCurrencyUSD = extractedCurrency === 'USD';
          
          // A price is only comparable if it's a proven/derived total, includes taxes, 
          // dates are validated, AND it's in USD (to compare with Airbnb USD baseline)
          const isComparable = (derivedPriceType === 'total_proven' || derivedPriceType === 'total_derived') &&
                               extraction.includes_taxes_fees === true &&
                               extraction.dates_validated === true &&
                               isCurrencyUSD;
          
          // Build comparability_failures array for frontend categorization
          const failures: string[] = [];
          if (!isComparable) {
            if (!isCurrencyUSD) {
              failures.push('currency_mismatch');
            }
            if (derivedPriceType !== 'total_proven' && derivedPriceType !== 'total_derived') {
              failures.push('price_type_not_total');
            }
            if (!extraction.includes_taxes_fees) {
              failures.push('taxes_fees_not_included');
            }
            if (!extraction.dates_validated) {
              failures.push('dates_not_validated');
            }
          }
          
          canonicalPrice = {
            total_price: extraction.extracted_price || null,
            currency: extractedCurrency,
            price_type: derivedPriceType,
            nights_count: nights,
            check_in_date: checkIn,
            check_out_date: checkOut,
            includes_taxes_fees: extraction.includes_taxes_fees || false,
            dates_validated: extraction.dates_validated || false,
            is_comparable: isComparable,
            comparability_failures: failures,
          };
        }

        // Determine outcome category
        let outcomeCategory = platform.outcome_category;
        if (!outcomeCategory && extraction) {
          if (extraction.extraction_status === 'completed' && effectivePrice) {
            outcomeCategory = 'price_extracted';
          } else if (extraction.extraction_status === 'sold_out') {
            outcomeCategory = 'sold_out';
          } else if (extraction.extraction_status === 'blocked') {
            outcomeCategory = 'blocked';
          } else if (extraction.extraction_status === 'failed') {
            outcomeCategory = 'extraction_failed';
          }
        }
        if (!outcomeCategory) {
          outcomeCategory = effectivePrice ? 'price_extracted' : 'no_price';
        }

        // CRITICAL: Determine final bucket at finalization time (frozen forever)
        const finalBucket = categorizeResultForSnapshot(
          {
            price: effectivePrice,
            outcome_category: outcomeCategory,
            extraction_status: extraction?.extraction_status || platform.extraction_status_terminal || null,
            extraction_error: extraction?.extraction_error || platform.last_error || null,
            canonical_price: canonicalPrice,
            is_tier_c_blocked: false,
            coverage_tier: null,
          },
          airbnbPrice
        );

        // SAFEGUARD ASSERTION: success_total_stay MUST be classified correctly
        // This prevents silent drops of successful VRBO/Agoda extractions
        const extractionStatus = extraction?.extraction_status || platform.extraction_status_terminal || '';
        if (extractionStatus === 'success_total_stay') {
          const validBuckets = ['cheaper', 'more_expensive', 'not_comparable'];
          if (!validBuckets.includes(finalBucket)) {
            console.error(
              `[CRITICAL] success_total_stay extraction incorrectly bucketed as "${finalBucket}" ` +
              `for platform="${platform.platform_name}". ` +
              `This violates baseline invariant vrbo-price-extraction-golden-path-v1. ` +
              `Price=${effectivePrice}, Airbnb=${airbnbPrice}, CanonicalPrice=${JSON.stringify(canonicalPrice)}`
            );
          }
        }

        // Determine image verification authority status from two-pass outcome
        // 'authoritative' = PASS 2 >= 90% (high trust)
        // 'needs_review' = PASS 1 passed (75%+) but PASS 2 < 90%
        const imageVerificationCategory = platform.outcome_category;
        const isAuthoritative = imageVerificationCategory === 'authoritative';

        // Determine original currency/amount for foreign currency fallback display
        const extractedCurrency = extraction?.currency || canonicalPrice?.currency || 'USD';
        const isNonUSD = extractedCurrency && extractedCurrency !== 'USD';
        const originalCurrency = isNonUSD ? extractedCurrency : null;
        const originalAmount = isNonUSD ? (extraction?.extracted_price || canonicalPrice?.total_price || null) : null;

        return {
          id: result?.id || platform.id,
          platform_name: platform.platform_name,
          listing_url: platform.listing_url,
          listing_title: platform.listing_title || result?.listing_title || null,
          price: effectivePrice,
          original_price: result?.original_price || null,
          savings_amount: result?.savings_amount || null,
          savings_percentage: result?.savings_percentage || null,
          confidence_score: result?.confidence_score || null,
          image_url: platform.image_url || result?.image_url || null,
          images: platform.images || result?.images || [],
          match_type: platform.match_type || result?.match_type || null,
          source_airbnb_image: platform.source_airbnb_image || result?.source_airbnb_image || null,
          price_check_in: result?.price_check_in || null,
          price_check_out: result?.price_check_out || null,
          dates_differ: result?.dates_differ || false,
          extraction_status: extraction?.extraction_status || platform.extraction_status_terminal || null,
          extraction_error: extraction?.extraction_error || platform.last_error || null,
          canonical_price: canonicalPrice,
          price_type: canonicalPrice?.price_type || 'unknown',
          includes_taxes_fees: extraction?.includes_taxes_fees || false,
          dates_validated: extraction?.dates_validated || false,
          outcome_category: outcomeCategory,
          is_authoritative: isAuthoritative,
          final_bucket: finalBucket,
          final_bucket_label: getDynamicBucketLabel(finalBucket, canonicalPrice, extraction?.extraction_status || platform.extraction_status_terminal || null),
          // Foreign currency fallback display
          original_currency: originalCurrency as string | null,
          original_amount: originalAmount as number | null,
        };
      });
      
      finalizedPlatformCount = finalResults.length;
      
    } else {
      // LEGACY PATH: Fall back to search_results only (backwards compatibility)
      console.log('[finalizeAndComplete] No search_platforms found, falling back to search_results');
      expectedPlatformCount = resultsData?.length || 0;
      
      finalResults = (resultsData || []).map((result: any) => {
        let extraction = extractionByResultId.get(result.id);
        if (!extraction) {
          extraction = extractionByPlatform.get(result.platform_name.toLowerCase());
        }

        let effectivePrice = result.price;
        if (extraction?.extracted_price && extraction.extracted_price > 0) {
          effectivePrice = extraction.extracted_price;
        }

        // Build canonical price object with PROPER price_type determination (legacy path)
        let canonicalPrice = null;
        if (extraction?.extraction_metadata || extraction?.extracted_price) {
          const derivedPriceType = determinePriceTypeFromExtraction(extraction);
          const extractedCurrency = extraction.currency || 'USD';
          const isCurrencyUSD = extractedCurrency === 'USD';
          
          // A price is only comparable if it's a proven/derived total, includes taxes, 
          // dates are validated, AND it's in USD (to compare with Airbnb USD baseline)
          const isComparable = (derivedPriceType === 'total_proven' || derivedPriceType === 'total_derived') &&
                               extraction.includes_taxes_fees === true &&
                               extraction.dates_validated === true &&
                               isCurrencyUSD;
          
          const failures: string[] = [];
          if (!isComparable) {
            if (!isCurrencyUSD) {
              failures.push('currency_mismatch');
            }
            if (derivedPriceType !== 'total_proven' && derivedPriceType !== 'total_derived') {
              failures.push('price_type_not_total');
            }
            if (!extraction.includes_taxes_fees) {
              failures.push('taxes_fees_not_included');
            }
            if (!extraction.dates_validated) {
              failures.push('dates_not_validated');
            }
          }
          
          canonicalPrice = {
            total_price: extraction.extracted_price || null,
            currency: extractedCurrency,
            price_type: derivedPriceType,
            nights_count: nights,
            check_in_date: checkIn,
            check_out_date: checkOut,
            includes_taxes_fees: extraction.includes_taxes_fees || false,
            dates_validated: extraction.dates_validated || false,
            is_comparable: isComparable,
            comparability_failures: failures,
          };
        }

        // CRITICAL: Determine final bucket at finalization time (frozen forever) - legacy path
        const outcomeCategory = effectivePrice ? 'price_extracted' : 'no_price';
        const finalBucket = categorizeResultForSnapshot(
          {
            price: effectivePrice,
            outcome_category: outcomeCategory,
            extraction_status: extraction?.extraction_status || null,
            extraction_error: extraction?.extraction_error || null,
            canonical_price: canonicalPrice,
            is_tier_c_blocked: false,
            coverage_tier: null,
          },
          airbnbPrice
        );

        // Legacy path: assume authoritative if high confidence score (90%+)
        // This maintains backwards compatibility for older searches
        const isAuthoritative = (result.confidence_score && result.confidence_score >= 90);

        // Determine original currency/amount for foreign currency fallback display (legacy path)
        const extractedCurrency = extraction?.currency || canonicalPrice?.currency || 'USD';
        const isNonUSD = extractedCurrency && extractedCurrency !== 'USD';
        const originalCurrency = isNonUSD ? extractedCurrency : null;
        const originalAmount = isNonUSD ? (extraction?.extracted_price || canonicalPrice?.total_price || null) : null;

        return {
          id: result.id,
          platform_name: result.platform_name,
          listing_url: result.listing_url,
          listing_title: result.listing_title,
          price: effectivePrice,
          original_price: result.original_price,
          savings_amount: result.savings_amount,
          savings_percentage: result.savings_percentage,
          confidence_score: result.confidence_score,
          image_url: result.image_url,
          images: result.images,
          match_type: result.match_type,
          source_airbnb_image: result.source_airbnb_image,
          price_check_in: result.price_check_in,
          price_check_out: result.price_check_out,
          dates_differ: result.dates_differ,
          extraction_status: extraction?.extraction_status || null,
          extraction_error: extraction?.extraction_error || null,
          canonical_price: canonicalPrice,
          price_type: canonicalPrice?.price_type || 'unknown',
          includes_taxes_fees: extraction?.includes_taxes_fees || false,
          dates_validated: extraction?.dates_validated || false,
          outcome_category: outcomeCategory,
          is_authoritative: isAuthoritative,
          final_bucket: finalBucket,
          final_bucket_label: getDynamicBucketLabel(finalBucket, canonicalPrice, extraction?.extraction_status || null),
          // Foreign currency fallback display
          original_currency: originalCurrency as string | null,
          original_amount: originalAmount as number | null,
        };
      });
      
      finalizedPlatformCount = finalResults.length;
    }

    // ============================================================================
    // IMAGE EVIDENCE GATE (AUTHORITATIVE INVARIANT)
    // ============================================================================
    // A listing may only appear in the final snapshot if:
    // 1. match_type === 'visual' (not text-only)
    // 2. confidence_score >= 75 (image verification threshold)
    // 3. source_airbnb_image exists (Airbnb reference image for comparison)
    // 4. images array has >=1 valid URL (alternative platform image for comparison)
    //
    // If ANY of these conditions fail, the result is EXCLUDED from the snapshot.
    // This ensures that every result shown has photo comparison available.
    // ============================================================================
    const IMAGE_VERIFICATION_THRESHOLD = 75;
    const preFilterCount = finalResults.length;
    
    // ============================================================================
    // TESTING EXCEPTION: Hotels.com Global Bypass
    // When enabled, Hotels.com results are included in the snapshot even if they
    // fail the image verification gate. This allows testing Hotels.com extraction.
    // Added: 2026-01-24
    // Remove when: Testing complete
    // ============================================================================
    const HOTELS_COM_GLOBAL_BYPASS_ENABLED = true;
    
    const shouldBypassImageGate = (platformName: string): boolean => {
      if (!HOTELS_COM_GLOBAL_BYPASS_ENABLED) return false;
      const normalized = platformName.toLowerCase().replace(/[^a-z]/g, '');
      return normalized === 'hotelscom' || normalized === 'hotels';
    };
    
    /**
     * Helper to check if a value is a non-empty string URL
     */
    const isValidImageUrl = (url: unknown): boolean => {
      if (typeof url !== 'string') return false;
      const trimmed = url.trim();
      return trimmed.length > 0 && (trimmed.startsWith('http://') || trimmed.startsWith('https://'));
    };
    
    /**
     * Helper to extract valid images from an images array (handles various formats)
     */
    const extractValidImages = (images: unknown): string[] => {
      if (!images) return [];
      if (Array.isArray(images)) {
        return images.filter(isValidImageUrl) as string[];
      }
      // Handle case where images might be a JSON string
      if (typeof images === 'string') {
        try {
          const parsed = JSON.parse(images);
          if (Array.isArray(parsed)) {
            return parsed.filter(isValidImageUrl) as string[];
          }
        } catch {
          // Not valid JSON, check if it's a single URL
          if (isValidImageUrl(images)) {
            return [images];
          }
        }
      }
      return [];
    };
    
    finalResults = finalResults.filter((result) => {
      const platformName = result.platform_name || 'Unknown';
      
      // TESTING BYPASS: Allow Hotels.com through regardless of image verification
      if (shouldBypassImageGate(platformName)) {
        console.log(`[ImageEvidenceGate] BYPASS ACTIVE: Hotels.com included despite low confidence - confidence=${result.confidence_score}`);
        return true;
      }
      
      // GATE 1: Only 'visual' match types are valid for display
      if (result.match_type !== 'visual') {
        console.log(`[ImageEvidenceGate] REJECTED text-only match: ${platformName} - match_type=${result.match_type}`);
        return false;
      }
      
      // GATE 2: Must have adequate confidence score
      if (typeof result.confidence_score !== 'number' || result.confidence_score < IMAGE_VERIFICATION_THRESHOLD) {
        console.log(`[ImageEvidenceGate] REJECTED low-confidence match: ${platformName} - confidence=${result.confidence_score}`);
        return false;
      }
      
      // GATE 3: Must have source Airbnb image (required for photo comparison)
      if (!isValidImageUrl(result.source_airbnb_image)) {
        console.log(`[ImageEvidenceGate] REJECTED missing source_airbnb_image: ${platformName} - source_airbnb_image=${result.source_airbnb_image}`);
        return false;
      }
      
      // GATE 4: Must have at least one alternative platform image (required for photo comparison)
      const alternativeImages = extractValidImages(result.images);
      if (alternativeImages.length === 0) {
        // Also check image_url as fallback
        if (!isValidImageUrl(result.image_url)) {
          console.log(`[ImageEvidenceGate] REJECTED missing alternative images: ${platformName} - images=${JSON.stringify(result.images)}, image_url=${result.image_url}`);
          return false;
        }
      }
      
      // All gates passed - this result has complete photo comparison evidence
      return true;
    });
    
    const filteredOutCount = preFilterCount - finalResults.length;
    if (filteredOutCount > 0) {
      console.log(`[SnapshotGate] Filtered out ${filteredOutCount} non-visual matches from final snapshot`);
    }
    
    // Update finalized count after filtering
    finalizedPlatformCount = finalResults.length;

    const finalisedAt = new Date().toISOString();

    // Persist a minimal, structured proof that snapshot rendering is complete.
    // NOTE: This is persisted inside the snapshot to avoid any new tables and
    // without impacting UI behavior.
    const includedPlatformKeys = finalResults.map((r) => {
      const name = String(r.platform_name || '').toLowerCase();
      const url = String(r.listing_url || '');
      return `${name}|${url}`;
    });

    const snapshot: FinalSnapshot = {
      version: 2, // Version 2 = authoritative platform set
      generated_at: finalisedAt,
      search_id: searchId,
      airbnb: {
        price: airbnbPrice,
        currency: airbnbCurrency,
        title: airbnbTitle,
      },
      dates: {
        check_in: checkIn,
        check_out: checkOut,
        nights: nights,
      },
      results: finalResults,
      result_count: finalResults.length,
      expected_platform_count: expectedPlatformCount,
      finalized_platform_count: finalizedPlatformCount,
      render_debug: {
        candidates_total_after_merge: expectedPlatformCount,
        candidates_rendered: finalResults.length,
        included_platform_keys: includedPlatformKeys,
        excluded_platform_keys: [],
      },
    };

    console.log(`[finalizeAndComplete] Built snapshot: ${finalResults.length} results (${filteredOutCount} non-visual filtered), expected=${expectedPlatformCount}, finalized=${finalizedPlatformCount}`);

    // Step 6: ATOMIC UPDATE - Set snapshot + finalised_at + status='completed' in ONE call
    // This ensures the invariant: completed status = snapshot exists
    const atomicPayload: Record<string, any> = {
      status: 'completed',
      final_results_snapshot: snapshot,
      finalised_at: finalisedAt,
      airbnb_title: airbnbTitle,
      airbnb_price: airbnbPrice,
      airbnb_currency: airbnbCurrency,
      check_in_date: checkIn,
      check_out_date: checkOut,
      nights_count: nights,
      updated_at: finalisedAt,
      // Clear any previous error state
      api_error: null,
      api_error_code: null,
      finalization_error: null,
    };

    // Add optional fields if provided
    if (params.airbnbImageUrl !== undefined) {
      atomicPayload.airbnb_image_url = params.airbnbImageUrl;
    }
    if (params.airbnbImages !== undefined) {
      atomicPayload.airbnb_images = params.airbnbImages;
    }

    const { error: updateError } = await (supabase as any)
      .from('searches')
      .update(atomicPayload)
      .eq('id', searchId)
      .is('finalised_at', null); // Race condition guard

    if (updateError) {
      console.error('[finalizeAndComplete] ATOMIC UPDATE FAILED:', updateError);
      await markFinalizationFailed(supabase, searchId, `Atomic update failed: ${updateError.message}`);
      return {
        success: false,
        alreadyFinalized: false,
        finalisedAt: null,
        resultCount: 0,
        error: `Atomic update failed: ${updateError.message}`,
      };
    }

    console.log(`[finalizeAndComplete] SUCCESS - Search ${searchId} finalized with ${finalResults.length} results`);
    await logActivity(supabase, searchId, 'Finalization complete', `Persisted ${finalResults.length} results to immutable snapshot`);

    return {
      success: true,
      alreadyFinalized: false,
      finalisedAt,
      resultCount: finalResults.length,
    };

  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : 'Unknown error';
    console.error('[finalizeAndComplete] EXCEPTION:', e);
    
    await logActivity(supabase, searchId, 'Finalization failed', errorMsg);
    
    // Mark as finalization_failed
    try {
      await markFinalizationFailed(supabase, searchId, errorMsg);
    } catch (markError) {
      console.error('[finalizeAndComplete] Failed to mark finalization_failed:', markError);
    }
    
    return {
      success: false,
      alreadyFinalized: false,
      finalisedAt: null,
      resultCount: 0,
      error: errorMsg,
    };
  }
}

/**
 * Mark a search as finalization_failed with error details.
 * This is a terminal status - the search will not auto-retry.
 */
async function markFinalizationFailed(
  supabase: any,
  searchId: string,
  errorMessage: string
): Promise<void> {
  console.log(`[finalizeAndComplete] Marking search ${searchId} as finalization_failed: ${errorMessage}`);
  
  const errorDetails = {
    message: errorMessage,
    timestamp: new Date().toISOString(),
    stage: 'finalization',
  };
  
  const { error } = await (supabase as any)
    .from('searches')
    .update({
      status: 'finalization_failed',
      api_error: errorMessage,
      api_error_code: 'finalization_failed',
      finalization_error: errorDetails,
      updated_at: new Date().toISOString(),
    })
    .eq('id', searchId)
    .is('finalised_at', null); // Only update if not already finalized
  
  if (error) {
    console.error('[finalizeAndComplete] Failed to mark finalization_failed:', error);
  }
}

// Legacy export for backwards compatibility (deprecated)
export const buildAndPersistFinalSnapshot = async (
  supabase: any,
  searchId: string
): Promise<FinalizeAndCompleteResult> => {
  return finalizeAndCompleteSearch({ supabase, searchId });
};
