import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { finalizeAndCompleteSearch } from "../_shared/buildFinalSnapshot.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * finalize-search-snapshot
 * 
 * This endpoint handles finalization in two modes:
 * 
 * 1. READ-ONLY (default): Returns existing snapshot or error if not finalized
 * 2. FORCE MODE (force=true): Admin-triggered force finalization for stuck searches
 * 
 * INVARIANT: Once finalised_at is set, the snapshot is immutable.
 */
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { searchId, force } = await req.json();

    if (!searchId) {
      return new Response(
        JSON.stringify({ error: "searchId is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    console.log(`[finalize-search-snapshot] ${force ? 'FORCE' : 'READ-ONLY'} check for search ${searchId}`);

    // Check if already finalized
    const { data: searchData, error: searchError } = await supabase
      .from("searches")
      .select("id, status, finalised_at, final_results_snapshot")
      .eq("id", searchId)
      .single();

    if (searchError || !searchData) {
      console.error("[finalize-search-snapshot] Search not found:", searchError);
      return new Response(
        JSON.stringify({ error: "Search not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const typedData = searchData as any;

    // If already finalized, return success with existing data
    if (typedData.finalised_at) {
      console.log(`[finalize-search-snapshot] Search ${searchId} already finalized at ${typedData.finalised_at}`);
      const snapshot = typedData.final_results_snapshot;
      return new Response(
        JSON.stringify({ 
          success: true, 
          alreadyFinalized: true,
          finalisedAt: typedData.finalised_at,
          resultCount: snapshot?.result_count || snapshot?.results?.length || 0,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // FORCE MODE: Admin-triggered finalization for stuck searches
    if (force === true) {
      console.log(`[finalize-search-snapshot] Force-finalizing search ${searchId}`);
      
      const result = await finalizeAndCompleteSearch({
        supabase,
        searchId,
      });
      
      return new Response(
        JSON.stringify({
          success: result.success,
          finalisedAt: result.finalisedAt,
          resultCount: result.resultCount,
          error: result.error,
          alreadyFinalized: result.alreadyFinalized,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // READ-ONLY MODE: Frontend should NOT call this to create the snapshot
    console.log(`[finalize-search-snapshot] Search ${searchId} not yet finalized by backend (status: ${typedData.status})`);
    
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: "Search not yet finalized by backend pipeline",
        status: typedData.status,
        message: "Finalization is now handled by the backend pipeline. Please wait for the search to complete.",
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
