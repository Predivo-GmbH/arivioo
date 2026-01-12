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
}

export interface FinalizeAndCompleteResult {
  success: boolean;
  alreadyFinalized: boolean;
  finalisedAt: string | null;
  resultCount: number;
  error?: string;
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
    // We must NOT finalize until every matched platform has reached a terminal extraction state.
    // Otherwise the snapshot will capture "pending" and the UI will appear to "miss" platforms
    // (e.g. Expedia), or show incorrect bucket counts.
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

    if (authoritativePlatforms.length > 0) {
      const expected = authoritativePlatforms.length;
      const terminal = terminalPlatforms.size;
      if (terminal < expected) {
        const msg = `Not ready to finalize: ${terminal}/${expected} platforms terminal`;
        console.log(`[finalizeAndComplete] ${msg}`);
        await logActivity(supabase, searchId, 'Finalization waiting', msg);
        return {
          success: false,
          alreadyFinalized: false,
          finalisedAt: null,
          resultCount: 0,
          error: msg,
        };
      }
    }

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

        // Build canonical price object
        let canonicalPrice = null;
        if (extraction?.extraction_metadata || extraction?.extracted_price) {
          const metadata = extraction.extraction_metadata as Record<string, any> || {};
          canonicalPrice = {
            total_price: extraction.extracted_price || null,
            currency: extraction.currency || 'USD',
            price_type: extraction.price_type || metadata?.price_type || 'unknown',
            nights_count: nights,
            check_in_date: checkIn,
            check_out_date: checkOut,
            includes_taxes_fees: extraction.includes_taxes_fees || false,
            dates_validated: extraction.dates_validated || false,
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

        let canonicalPrice = null;
        if (extraction?.extraction_metadata || extraction?.extracted_price) {
          const metadata = extraction.extraction_metadata as Record<string, any> || {};
          canonicalPrice = {
            total_price: extraction.extracted_price || null,
            currency: extraction.currency || 'USD',
            price_type: extraction.price_type || metadata?.price_type || 'unknown',
            nights_count: nights,
            check_in_date: checkIn,
            check_out_date: checkOut,
            includes_taxes_fees: extraction.includes_taxes_fees || false,
            dates_validated: extraction.dates_validated || false,
          };
        }

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
          outcome_category: null,
        };
      });
      
      finalizedPlatformCount = finalResults.length;
    }

    const finalisedAt = new Date().toISOString();
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
    };

    console.log(`[finalizeAndComplete] Built snapshot: ${finalResults.length} results, expected=${expectedPlatformCount}, finalized=${finalizedPlatformCount}`);

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
