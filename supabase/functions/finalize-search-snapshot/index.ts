import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * finalize-search-snapshot
 * 
 * Called by the frontend when a search reaches completion.
 * Persists the final results snapshot to `searches.final_results_snapshot`
 * and sets `finalised_at` timestamp.
 * 
 * INVARIANT: Once finalised_at is set, the snapshot is immutable.
 */
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { searchId } = await req.json();

    if (!searchId) {
      return new Response(
        JSON.stringify({ error: "searchId is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    console.log(`[finalize-search-snapshot] Processing search ${searchId}`);

    // Check if already finalized (idempotent)
    const { data: searchData, error: searchError } = await supabase
      .from("searches")
      .select("id, status, finalised_at, airbnb_price, airbnb_currency, airbnb_title, check_in_date, check_out_date, nights_count")
      .eq("id", searchId)
      .single();

    if (searchError || !searchData) {
      console.error("[finalize-search-snapshot] Search not found:", searchError);
      return new Response(
        JSON.stringify({ error: "Search not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // If already finalized, return existing snapshot
    if (searchData.finalised_at) {
      console.log(`[finalize-search-snapshot] Search ${searchId} already finalized at ${searchData.finalised_at}`);
      return new Response(
        JSON.stringify({ 
          success: true, 
          alreadyFinalized: true,
          finalisedAt: searchData.finalised_at,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Only finalize if search is in a terminal status
    const TERMINAL_STATUSES = ['completed', 'done', 'error', 'failed', 'cancelled', 'price_unavailable', 'dates_unavailable'];
    if (!TERMINAL_STATUSES.includes(searchData.status)) {
      console.log(`[finalize-search-snapshot] Search ${searchId} not in terminal status: ${searchData.status}`);
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: "Search not yet complete",
          status: searchData.status,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fetch all search results with extractions for this search
    const { data: resultsData, error: resultsError } = await supabase
      .from("search_results")
      .select("*")
      .eq("search_id", searchId)
      .order("savings_percentage", { ascending: false, nullsFirst: false });

    if (resultsError) {
      console.error("[finalize-search-snapshot] Failed to fetch results:", resultsError);
      return new Response(
        JSON.stringify({ error: "Failed to fetch results" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fetch price extractions
    const { data: extractionsData } = await supabase
      .from("price_extractions")
      .select("*")
      .eq("search_id", searchId);

    // Create extraction lookup
    const extractionByResultId = new Map<string, any>();
    const extractionByPlatform = new Map<string, any>();
    extractionsData?.forEach((e: any) => {
      if (e.search_result_id) {
        extractionByResultId.set(e.search_result_id, e);
      }
      extractionByPlatform.set(e.platform_name.toLowerCase(), e);
    });

    // Build the final snapshot with all necessary data
    const finalResults = (resultsData || []).map((result: any) => {
      // Find extraction
      let extraction = extractionByResultId.get(result.id);
      if (!extraction) {
        extraction = extractionByPlatform.get(result.platform_name.toLowerCase());
      }

      // Effective price (prioritize extraction over result.price)
      let effectivePrice = result.price;
      if (extraction?.extracted_price && extraction.extracted_price > 0) {
        effectivePrice = extraction.extracted_price;
      }

      // Extract canonical price if available
      let canonicalPrice = null;
      if (extraction?.extraction_metadata) {
        const metadata = extraction.extraction_metadata as Record<string, any>;
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
        // Extraction status
        extraction_status: extraction?.extraction_status || null,
        extraction_error: extraction?.extraction_error || null,
        // Canonical price data
        canonical_price: canonicalPrice,
        price_type: canonicalPrice?.price_type || 'unknown',
        includes_taxes_fees: extraction?.includes_taxes_fees || false,
        dates_validated: extraction?.dates_validated || false,
      };
    });

    // Create the final snapshot
    const snapshot = {
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

    // Persist the snapshot and set finalised_at (atomic operation)
    const finalisedAt = new Date().toISOString();
    const { error: updateError } = await supabase
      .from("searches")
      .update({
        final_results_snapshot: snapshot,
        finalised_at: finalisedAt,
      })
      .eq("id", searchId)
      .is("finalised_at", null); // Only update if not already finalized (race condition guard)

    if (updateError) {
      console.error("[finalize-search-snapshot] Failed to persist snapshot:", updateError);
      return new Response(
        JSON.stringify({ error: "Failed to persist snapshot" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[finalize-search-snapshot] Successfully finalized search ${searchId} with ${finalResults.length} results`);

    return new Response(
      JSON.stringify({
        success: true,
        finalisedAt,
        resultCount: finalResults.length,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("[finalize-search-snapshot] Error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
