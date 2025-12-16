import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    
    // Use service role to bypass RLS
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Find the most recent completed search with visual matches
    const { data: searches, error: searchError } = await supabase
      .from("searches")
      .select("*")
      .eq("status", "completed")
      .not("airbnb_price", "is", null)
      .not("airbnb_title", "is", null)
      .order("created_at", { ascending: false })
      .limit(10);

    if (searchError) {
      console.error("Search query error:", searchError);
      throw searchError;
    }

    // Find a search with good visual matches and savings
    for (const search of searches || []) {
      const { data: results, error: resultsError } = await supabase
        .from("search_results")
        .select("*")
        .eq("search_id", search.id)
        .eq("match_type", "visual")
        .gte("confidence_score", 0.90)
        .not("price", "is", null)
        .order("price", { ascending: true });

      if (resultsError) {
        console.error("Results query error:", resultsError);
        continue;
      }

      if (results && results.length > 0) {
        const cheapestResult = results[0];
        const airbnbTotal = search.airbnb_price && search.nights_count 
          ? search.airbnb_price * search.nights_count 
          : null;
        const cheapestTotal = cheapestResult.price && search.nights_count
          ? cheapestResult.price * search.nights_count
          : null;
        
        // Add service fee estimate (14%)
        const airbnbWithFees = airbnbTotal ? airbnbTotal * 1.14 : null;
        
        const potentialSavings = airbnbWithFees && cheapestTotal 
          ? Math.round(airbnbWithFees - cheapestTotal)
          : null;
        const savingsPercentage = airbnbWithFees && potentialSavings && potentialSavings > 0
          ? Math.round((potentialSavings / airbnbWithFees) * 100)
          : null;

        // Only use if there are actual savings
        if (potentialSavings && potentialSavings > 0) {
          console.log("Found successful search:", search.id, "with savings:", potentialSavings);
          
          // Return sanitized data - no personal travel dates or IDs
          // This is intentionally public for homepage demo purposes
          return new Response(
            JSON.stringify({
              success: true,
              data: {
                // Omit search.id to prevent correlation attacks
                airbnb_title: search.airbnb_title,
                airbnb_price: search.airbnb_price,
                airbnb_image_url: search.airbnb_image_url,
                airbnb_images: search.airbnb_images,
                // Omit specific dates - only show duration for demo
                nights_count: search.nights_count,
                cheapestResult: {
                  platform_name: cheapestResult.platform_name,
                  price: cheapestResult.price,
                  confidence_score: cheapestResult.confidence_score,
                  image_url: cheapestResult.image_url,
                  source_airbnb_image: cheapestResult.source_airbnb_image,
                },
                potentialSavings,
                savingsPercentage,
              },
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
      }
    }

    // No successful search found
    console.log("No successful search with savings found");
    return new Response(
      JSON.stringify({ success: true, data: null }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("Error:", message);
    return new Response(
      JSON.stringify({ success: false, error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
