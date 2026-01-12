/**
 * buildFinalSnapshot.ts
 * 
 * Shared helper to build and persist the final results snapshot.
 * Called by backend pipeline at TRUE completion points (never by frontend).
 * 
 * CRITICAL INVARIANT: 
 * - status = 'completed' is ONLY set when snapshot persistence succeeds
 * - If snapshot fails, status = 'finalization_failed' with error details
 * - Once finalised_at is set, the snapshot is immutable
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
 * ATOMIC finalize-and-complete helper.
 * 
 * This function ensures the INVARIANT:
 * - status = 'completed' is ONLY set when snapshot persistence succeeds
 * - If snapshot fails, status = 'finalization_failed' with error details
 * 
 * Steps:
 * 1. Check if already finalized (idempotent)
 * 2. Fetch search_results and price_extractions
 * 3. Build denormalized snapshot
 * 4. ATOMIC UPDATE: Set snapshot + finalised_at + status='completed' in ONE call
 * 5. If step 4 fails, set status='finalization_failed' + api_error_code
 */
export async function finalizeAndCompleteSearch(
  params: FinalizeAndCompleteParams
): Promise<FinalizeAndCompleteResult> {
  const { supabase, searchId } = params;
  
  console.log(`[finalizeAndComplete] Starting atomic finalization for search ${searchId}`);
  
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

    // Step 2: Fetch all search results
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

    // Step 3: Fetch price extractions
    const { data: extractionsData, error: extractionsError } = await supabase
      .from('price_extractions')
      .select('*')
      .eq('search_id', searchId);

    if (extractionsError) {
      console.error('[finalizeAndComplete] Failed to fetch extractions:', extractionsError);
      // Non-fatal - continue without extractions
    }

    // Create extraction lookup maps
    const extractionByResultId = new Map<string, any>();
    const extractionByPlatform = new Map<string, any>();
    extractionsData?.forEach((e: any) => {
      if (e.search_result_id) {
        extractionByResultId.set(e.search_result_id, e);
      }
      extractionByPlatform.set(e.platform_name.toLowerCase(), e);
    });

    // Step 4: Build the final snapshot
    const finalResults: FinalResultRow[] = (resultsData || []).map((result: any) => {
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
      };
    });

    const finalisedAt = new Date().toISOString();
    const snapshot: FinalSnapshot = {
      version: 1,
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
    };

    // Step 5: ATOMIC UPDATE - Set snapshot + finalised_at + status='completed' in ONE call
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

    return {
      success: true,
      alreadyFinalized: false,
      finalisedAt,
      resultCount: finalResults.length,
    };

  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : 'Unknown error';
    console.error('[finalizeAndComplete] EXCEPTION:', e);
    
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
  
  const { error } = await (supabase as any)
    .from('searches')
    .update({
      status: 'finalization_failed',
      api_error: errorMessage,
      api_error_code: 'finalization_failed',
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
