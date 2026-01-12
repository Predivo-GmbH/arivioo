/**
 * buildFinalSnapshot.ts
 * 
 * Shared helper to build and persist the final results snapshot.
 * Called by backend pipeline at TRUE completion points (never by frontend).
 * 
 * INVARIANT: Once finalised_at is set, the snapshot is immutable.
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

export interface BuildSnapshotResult {
  success: boolean;
  alreadyFinalized: boolean;
  finalisedAt: string | null;
  resultCount: number;
  error?: string;
}

/**
 * Build and persist the final results snapshot.
 * 
 * This function:
 * 1. Checks if already finalized (idempotent - returns success if so)
 * 2. Fetches all search_results and price_extractions
 * 3. Builds a denormalized snapshot with all data needed for UI
 * 4. Persists final_results_snapshot and finalised_at atomically
 * 
 * @param supabase - Supabase client (with service role for writes)
 * @param searchId - The search ID to finalize
 * @returns Result indicating success/failure
 */
export async function buildAndPersistFinalSnapshot(
  supabase: any,
  searchId: string
): Promise<BuildSnapshotResult> {
  console.log(`[buildFinalSnapshot] Building snapshot for search ${searchId}`);
  
  try {
    // Step 1: Check if already finalized (idempotent guard)
    const { data: rawSearchData, error: searchError } = await supabase
      .from('searches')
      .select('id, status, finalised_at, airbnb_price, airbnb_currency, airbnb_title, check_in_date, check_out_date, nights_count')
      .eq('id', searchId)
      .single();

    if (searchError || !rawSearchData) {
      console.error('[buildFinalSnapshot] Search not found:', searchError);
      return {
        success: false,
        alreadyFinalized: false,
        finalisedAt: null,
        resultCount: 0,
        error: 'Search not found',
      };
    }

    // Type cast to access columns (Supabase types may not include new columns yet)
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
      console.log(`[buildFinalSnapshot] Search ${searchId} already finalized at ${searchData.finalised_at}`);
      return {
        success: true,
        alreadyFinalized: true,
        finalisedAt: searchData.finalised_at,
        resultCount: 0, // Don't re-count
      };
    }

    // Step 2: Fetch all search results
    const { data: resultsData, error: resultsError } = await supabase
      .from('search_results')
      .select('*')
      .eq('search_id', searchId)
      .order('savings_percentage', { ascending: false, nullsFirst: false });

    if (resultsError) {
      console.error('[buildFinalSnapshot] Failed to fetch results:', resultsError);
      return {
        success: false,
        alreadyFinalized: false,
        finalisedAt: null,
        resultCount: 0,
        error: `Failed to fetch results: ${resultsError.message}`,
      };
    }

    // Step 3: Fetch price extractions
    const { data: extractionsData } = await supabase
      .from('price_extractions')
      .select('*')
      .eq('search_id', searchId);

    // Create extraction lookup maps
    const extractionByResultId = new Map<string, any>();
    const extractionByPlatform = new Map<string, any>();
    extractionsData?.forEach((e: any) => {
      if (e.search_result_id) {
        extractionByResultId.set(e.search_result_id, e);
      }
      extractionByPlatform.set(e.platform_name.toLowerCase(), e);
    });

    // Step 4: Build the final snapshot with all necessary data
    const finalResults: FinalResultRow[] = (resultsData || []).map((result: any) => {
      // Find extraction for this result
      let extraction = extractionByResultId.get(result.id);
      if (!extraction) {
        extraction = extractionByPlatform.get(result.platform_name.toLowerCase());
      }

      // Effective price (prioritize extraction over result.price)
      let effectivePrice = result.price;
      if (extraction?.extracted_price && extraction.extracted_price > 0) {
        effectivePrice = extraction.extracted_price;
      }

      // Build canonical price object if extraction exists
      let canonicalPrice = null;
      if (extraction?.extraction_metadata || extraction?.extracted_price) {
        const metadata = extraction.extraction_metadata as Record<string, any> || {};
        canonicalPrice = {
          total_price: extraction.extracted_price || null,
          currency: extraction.currency || 'USD',
          price_type: extraction.price_type || metadata?.price_type || 'unknown',
          nights_count: searchData.nights_count,
          check_in_date: searchData.check_in_date,
          check_out_date: searchData.check_out_date,
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
        // Extraction data
        extraction_status: extraction?.extraction_status || null,
        extraction_error: extraction?.extraction_error || null,
        canonical_price: canonicalPrice,
        price_type: canonicalPrice?.price_type || 'unknown',
        includes_taxes_fees: extraction?.includes_taxes_fees || false,
        dates_validated: extraction?.dates_validated || false,
      };
    });

    // Step 5: Create the final snapshot
    const snapshot: FinalSnapshot = {
      version: 1,
      generated_at: new Date().toISOString(),
      search_id: searchId,
      airbnb: {
        price: searchData.airbnb_price,
        currency: searchData.airbnb_currency,
        title: searchData.airbnb_title,
      },
      dates: {
        check_in: searchData.check_in_date,
        check_out: searchData.check_out_date,
        nights: searchData.nights_count,
      },
      results: finalResults,
      result_count: finalResults.length,
    };

    // Step 6: Persist the snapshot and set finalised_at atomically
    // Note: Using 'any' cast because Supabase types may not include new columns yet
    const finalisedAt = new Date().toISOString();
    const updatePayload = {
      final_results_snapshot: snapshot,
      finalised_at: finalisedAt,
    };
    const { error: updateError } = await (supabase as any)
      .from('searches')
      .update(updatePayload)
      .eq('id', searchId)
      .is('finalised_at', null); // Only update if not already finalized (race condition guard)

    if (updateError) {
      console.error('[buildFinalSnapshot] Failed to persist snapshot:', updateError);
      return {
        success: false,
        alreadyFinalized: false,
        finalisedAt: null,
        resultCount: 0,
        error: `Failed to persist snapshot: ${updateError.message}`,
      };
    }

    console.log(`[buildFinalSnapshot] Successfully finalized search ${searchId} with ${finalResults.length} results`);

    return {
      success: true,
      alreadyFinalized: false,
      finalisedAt,
      resultCount: finalResults.length,
    };

  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : 'Unknown error';
    console.error('[buildFinalSnapshot] Exception:', e);
    return {
      success: false,
      alreadyFinalized: false,
      finalisedAt: null,
      resultCount: 0,
      error: errorMsg,
    };
  }
}
