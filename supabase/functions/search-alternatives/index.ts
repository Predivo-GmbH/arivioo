import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface SearchResult {
  platform_name: string;
  listing_url: string;
  listing_title: string | null;
  price: number | null;
  confidence_score: number;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { searchId } = await req.json();
    
    if (!searchId) {
      return new Response(
        JSON.stringify({ error: "Search ID is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const firecrawlKey = Deno.env.get("FIRECRAWL_API_KEY");
    const lovableKey = Deno.env.get("LOVABLE_API_KEY");

    if (!firecrawlKey) {
      console.error("FIRECRAWL_API_KEY not configured");
      return new Response(
        JSON.stringify({ error: "Firecrawl API key not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!lovableKey) {
      console.error("LOVABLE_API_KEY not configured");
      return new Response(
        JSON.stringify({ error: "AI service not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Get the search record
    const { data: search, error: searchError } = await supabase
      .from("searches")
      .select("*")
      .eq("id", searchId)
      .single();

    if (searchError || !search) {
      console.error("Search not found:", searchError);
      return new Response(
        JSON.stringify({ error: "Search not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log("Processing search for URL:", search.airbnb_url);

    // Extract room ID from Airbnb URL for reference
    const roomIdMatch = search.airbnb_url.match(/rooms\/(\d+)/);
    const roomId = roomIdMatch ? roomIdMatch[1] : null;
    console.log("Airbnb room ID:", roomId);

    let airbnbContent = "";
    let airbnbTitle = "Vacation Rental";
    let scrapingSucceeded = false;

    // Step 1: Try to scrape the Airbnb listing using Firecrawl
    console.log("Attempting to scrape Airbnb listing...");
    try {
      const scrapeResponse = await fetch("https://api.firecrawl.dev/v1/scrape", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${firecrawlKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url: search.airbnb_url,
          formats: ["markdown"],
          onlyMainContent: true,
          waitFor: 5000,
          timeout: 30000,
        }),
      });

      const scrapeData = await scrapeResponse.json();
      
      if (scrapeResponse.ok && scrapeData.success && scrapeData.markdown) {
        airbnbContent = scrapeData.markdown;
        airbnbTitle = scrapeData.metadata?.title || "Vacation Rental";
        scrapingSucceeded = true;
        console.log("Successfully scraped Airbnb listing, title:", airbnbTitle);
      } else {
        console.log("Scraping failed, will use fallback approach:", scrapeData.error || "Unknown error");
      }
    } catch (e) {
      console.log("Scraping error, will use fallback:", e);
    }

    // Step 2: Use AI to extract/generate property details
    let propertyDetails: any = {};
    
    if (scrapingSucceeded && airbnbContent) {
      // Extract from scraped content
      console.log("Extracting property details from scraped content...");
      try {
        const extractionResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${lovableKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "google/gemini-2.5-flash",
            messages: [
              {
                role: "system",
                content: `You are a property details extractor. Extract key identifying information from vacation rental listings. Return a JSON object with: property_name, location (as a string like "City, Country"), property_type (apartment, house, villa, etc.), bedrooms, bathrooms, max_guests, amenities (array of key amenities), and estimated_nightly_price (number only, no currency symbol). If you can't determine a value, use null.`
              },
              {
                role: "user",
                content: `Extract property details from this Airbnb listing:\n\n${airbnbContent.slice(0, 8000)}`
              }
            ],
          }),
        });

        if (extractionResponse.ok) {
          const extractionData = await extractionResponse.json();
          const content = extractionData.choices?.[0]?.message?.content || "{}";
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            propertyDetails = JSON.parse(jsonMatch[0]);
          }
        }
      } catch (e) {
        console.error("Failed to extract details:", e);
      }
    } else {
      // Fallback: Generate search terms from URL and AI
      console.log("Using fallback approach - generating search terms from URL...");
      try {
        const extractionResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${lovableKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "google/gemini-2.5-flash",
            messages: [
              {
                role: "system",
                content: `You help generate search terms to find vacation rentals. Given an Airbnb URL, extract any location hints from the URL path or parameters and suggest general vacation rental search terms. Return a JSON object with: property_name (null if unknown), location (string - guess from URL if possible, or use "vacation rental"), property_type ("vacation rental"), estimated_nightly_price (null). Be creative with location guessing from URL patterns like /rooms/123?city=paris or locale hints.`
              },
              {
                role: "user",
                content: `Generate search terms for this Airbnb URL: ${search.airbnb_url}`
              }
            ],
          }),
        });

        if (extractionResponse.ok) {
          const extractionData = await extractionResponse.json();
          const content = extractionData.choices?.[0]?.message?.content || "{}";
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            propertyDetails = JSON.parse(jsonMatch[0]);
          }
        }
      } catch (e) {
        console.error("Failed to generate fallback details:", e);
      }
    }

    // Ensure location is a string
    const locationStr = typeof propertyDetails.location === 'object' 
      ? `${propertyDetails.location?.city || ''} ${propertyDetails.location?.country || ''}`.trim()
      : (propertyDetails.location || '');

    console.log("Property details:", propertyDetails);

    // Update search with Airbnb info
    await supabase.from("searches").update({
      airbnb_title: airbnbTitle,
      airbnb_price: propertyDetails.estimated_nightly_price || null,
      status: "searching_alternatives"
    }).eq("id", searchId);

    // Step 3: Search for alternatives using Firecrawl search
    const propertyName = propertyDetails.property_name || airbnbTitle;
    const bedroomCount = propertyDetails.bedrooms ? `${propertyDetails.bedrooms} bedroom` : '';
    const propertyType = propertyDetails.property_type || "vacation rental";
    
    const searchQueries = [
      `${propertyName} ${locationStr} vacation rental`.trim(),
      `${locationStr} ${propertyType} ${bedroomCount} booking`.trim(),
      `${propertyName} vrbo booking.com`.trim(),
      roomId ? `airbnb ${roomId} alternative booking` : null,
    ].filter(Boolean) as string[];

    console.log("Searching for alternatives with queries:", searchQueries);

    const allSearchResults: any[] = [];

    for (const query of searchQueries) {
      try {
        const searchResponse = await fetch("https://api.firecrawl.dev/v1/search", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${firecrawlKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query,
            limit: 5,
            scrapeOptions: { formats: ["markdown"] },
          }),
        });

        const searchData = await searchResponse.json();
        if (searchData.success && searchData.data) {
          allSearchResults.push(...searchData.data);
        }
      } catch (e) {
        console.error("Search query failed:", e);
      }
    }

    console.log(`Found ${allSearchResults.length} potential results`);

    // Filter out Airbnb results and duplicates
    const filteredResults = allSearchResults.filter((result, index, self) => {
      const url = result.url?.toLowerCase() || "";
      const isAirbnb = url.includes("airbnb.com");
      const isDuplicate = self.findIndex(r => r.url === result.url) !== index;
      return !isAirbnb && !isDuplicate;
    });

    console.log(`Filtered to ${filteredResults.length} non-Airbnb results`);

    // Step 4: Use AI to analyze and match properties
    const alternatives: SearchResult[] = [];

    for (const result of filteredResults.slice(0, 10)) {
      try {
        console.log("Analyzing result:", result.url);
        
        const analysisResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${lovableKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "google/gemini-2.5-flash",
            messages: [
              {
                role: "system",
                content: `You are a vacation rental matcher. Compare two property listings and determine if they are the SAME property (just listed on different platforms) or SIMILAR properties. 

Return a JSON object with:
- is_match: boolean (true if likely the same property)
- confidence: number 0-100 (how confident you are)
- platform_name: string (e.g., "Vrbo", "Booking.com", "Direct Booking", etc.)
- estimated_price: number or null (nightly price if found)
- reasoning: string (brief explanation)

Focus on: exact location match, property name similarity, number of bedrooms/bathrooms, unique features, and host/owner name if available.`
              },
              {
                role: "user",
                content: `ORIGINAL AIRBNB LISTING:
Title: ${airbnbTitle}
Details: ${JSON.stringify(propertyDetails)}
Location: ${locationStr || "Unknown"}
${airbnbContent ? `Content snippet: ${airbnbContent.slice(0, 1500)}` : "No content available - match based on details above"}

POTENTIAL MATCH:
URL: ${result.url}
Title: ${result.title || "Unknown"}
Description: ${result.description || ""}
Content: ${(result.markdown || "").slice(0, 1500)}

Are these the same property or similar? Analyze and return JSON.`
              }
            ],
          }),
        });

        if (!analysisResponse.ok) {
          console.error("Analysis failed for:", result.url);
          continue;
        }

        const analysisData = await analysisResponse.json();
        const analysisContent = analysisData.choices?.[0]?.message?.content || "{}";
        
        let analysis: any = {};
        try {
          const jsonMatch = analysisContent.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            analysis = JSON.parse(jsonMatch[0]);
          }
        } catch (e) {
          console.error("Failed to parse analysis:", e);
          continue;
        }

        // Include results with confidence > 30 (similar or matching)
        if (analysis.confidence >= 30) {
          alternatives.push({
            platform_name: analysis.platform_name || "Other Platform",
            listing_url: result.url,
            listing_title: result.title || null,
            price: analysis.estimated_price || null,
            confidence_score: analysis.confidence / 100,
          });
        }
      } catch (e) {
        console.error("Error analyzing result:", e);
      }
    }

    console.log(`Found ${alternatives.length} matching/similar alternatives`);

    // Sort by confidence and take top results
    alternatives.sort((a, b) => b.confidence_score - a.confidence_score);
    const topAlternatives = alternatives.slice(0, 5);

    // Calculate savings for each alternative
    const airbnbPrice = propertyDetails.estimated_nightly_price || 0;
    const resultsWithSavings = topAlternatives.map(alt => ({
      ...alt,
      original_price: airbnbPrice,
      savings_amount: alt.price && airbnbPrice ? Math.max(0, airbnbPrice - alt.price) : null,
      savings_percentage: alt.price && airbnbPrice && alt.price < airbnbPrice 
        ? Math.round(((airbnbPrice - alt.price) / airbnbPrice) * 100) 
        : null,
    }));

    // Insert results into database
    if (resultsWithSavings.length > 0) {
      const { error: insertError } = await supabase.from("search_results").insert(
        resultsWithSavings.map(r => ({
          search_id: searchId,
          platform_name: r.platform_name,
          listing_url: r.listing_url,
          listing_title: r.listing_title,
          price: r.price,
          original_price: r.original_price,
          savings_amount: r.savings_amount,
          savings_percentage: r.savings_percentage,
          confidence_score: r.confidence_score,
        }))
      );

      if (insertError) {
        console.error("Failed to insert results:", insertError);
      }
    }

    // Update search status
    await supabase.from("searches").update({ 
      status: "completed",
      airbnb_price: airbnbPrice || null,
    }).eq("id", searchId);

    console.log("Search completed successfully");

    return new Response(
      JSON.stringify({ 
        success: true, 
        results: resultsWithSavings,
        airbnb: {
          title: airbnbTitle,
          price: airbnbPrice,
          url: search.airbnb_url,
        }
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Search error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
