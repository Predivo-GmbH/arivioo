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

    // Find the most recent completed search that the user opted-in to show on the public demo
    const { data: searches, error: searchError } = await supabase
      .from("searches")
      .select("*")
      .eq("status", "completed")
      .eq("public_demo_ok", true)
      .not("airbnb_title", "is", null)
      .order("created_at", { ascending: false })
      .limit(10);

    if (searchError) {
      console.error("Search query error:", searchError);
      throw searchError;
    }

    // Pick the most recent search that has at least one strong visual match.
    // Accept flexible high-confidence matches (not requiring strict 90% threshold).
    // The goal is to find REAL image pairs for demo, even if pricing is unavailable or higher.
    for (const search of searches || []) {
      // First try to find high-confidence visual matches (>= 85%)
      // Then fall back to any visual match (>= 70%) for demo purposes
      const { data: results, error: resultsError } = await supabase
        .from("search_results")
        .select("*")
        .eq("search_id", search.id)
        .eq("match_type", "visual")
        .gte("confidence_score", 0.70) // Lower threshold for flexible matching
        .order("confidence_score", { ascending: false })
        .limit(25);

      if (resultsError) {
        console.error("Results query error:", resultsError);
        continue;
      }

      if (!results || results.length === 0) continue;

      // Prioritize results for demo display:
      // 1. Best: Has image + source_airbnb_image (for side-by-side) + price with savings
      // 2. Good: Has image + source_airbnb_image (for side-by-side) - even without price
      // 3. Acceptable: Has image only
      // The key is to get REAL matched image pairs for transparency/trust
      const hasImagePair = (r: typeof results[0]) => 
        r.image_url && r.source_airbnb_image;
      
      const hasSavings = (r: typeof results[0]) => 
        r.price !== null && search.airbnb_price && r.price < search.airbnb_price;

      const bestResult =
        results.find((r) => hasImagePair(r) && hasSavings(r)) ||
        results.find((r) => hasImagePair(r) && r.price !== null) ||
        results.find((r) => hasImagePair(r)) ||
        results.find((r) => r.image_url && r.price !== null) ||
        results.find((r) => r.image_url) ||
        results[0];

      const nightsCount = search.nights_count ?? null;
      const airbnbTotal = search.airbnb_price && nightsCount ? search.airbnb_price * nightsCount : null;
      const bestTotal = bestResult.price && nightsCount ? bestResult.price * nightsCount : null;

      // Add service fee estimate (14%)
      const airbnbWithFees = airbnbTotal ? airbnbTotal * 1.14 : null;

      // Calculate real savings if available
      let potentialSavings = airbnbWithFees && bestTotal
        ? Math.round(airbnbWithFees - bestTotal)
        : null;
      let savingsPercentage = airbnbWithFees && potentialSavings !== null
        ? Math.round((potentialSavings / airbnbWithFees) * 100)
        : null;
      
      // Flag to indicate if savings are simulated (for marketing transparency)
      let savingsSimulated = false;
      
      // If we have a verified image pair but no real savings data,
      // generate simulated savings for marketing/demo purposes
      // This helps explain how the product works without requiring live booking data
      if ((potentialSavings === null || potentialSavings <= 0) && hasImagePair(bestResult)) {
        const basePrice = search.airbnb_price || 150; // Default price if unknown
        const nights = nightsCount || 3;
        
        // Simulate realistic savings (15-25% off Airbnb price)
        const simulatedSavingsPercent = 15 + Math.floor(Math.random() * 10); // 15-24%
        const simulatedAirbnbTotal = Math.round(basePrice * nights * 1.14);
        const simulatedDirectTotal = Math.round(simulatedAirbnbTotal * (1 - simulatedSavingsPercent / 100));
        
        potentialSavings = simulatedAirbnbTotal - simulatedDirectTotal;
        savingsPercentage = simulatedSavingsPercent;
        savingsSimulated = true;
      }

      console.log("Found last successful visual match for landing demo:", {
        created_at: search.created_at,
        has_airbnb_image_url: Boolean(search.airbnb_image_url),
        has_airbnb_images: Array.isArray(search.airbnb_images) && search.airbnb_images.length > 0,
        result_platform: bestResult.platform_name,
        has_result_image: Boolean(bestResult.image_url),
        has_source_airbnb_image: Boolean(bestResult.source_airbnb_image),
        has_result_price: bestResult.price !== null,
        confidence_score: bestResult.confidence_score,
        savings_simulated: savingsSimulated,
      });

      // Return sanitized data - no personal travel dates or IDs
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            airbnb_title: search.airbnb_title,
            airbnb_price: search.airbnb_price,
            airbnb_image_url: search.airbnb_image_url,
            airbnb_images: search.airbnb_images,
            nights_count: nightsCount,
            cheapestResult: {
              platform_name: bestResult.platform_name,
              price: bestResult.price,
              confidence_score: bestResult.confidence_score,
              image_url: bestResult.image_url,
              source_airbnb_image: bestResult.source_airbnb_image,
            },
            potentialSavings,
            savingsPercentage,
            savingsSimulated, // Let UI know if these are simulated for demo
          },
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
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
