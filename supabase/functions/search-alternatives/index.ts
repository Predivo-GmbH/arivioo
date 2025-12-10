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

// Extract platform name from URL
function getPlatformName(url: string): string {
  const lowercaseUrl = url.toLowerCase();
  if (lowercaseUrl.includes("vrbo.com")) return "Vrbo";
  if (lowercaseUrl.includes("booking.com")) return "Booking.com";
  if (lowercaseUrl.includes("expedia.com")) return "Expedia";
  if (lowercaseUrl.includes("hotels.com")) return "Hotels.com";
  if (lowercaseUrl.includes("tripadvisor.com")) return "TripAdvisor";
  if (lowercaseUrl.includes("homeaway.com")) return "HomeAway";
  if (lowercaseUrl.includes("vacasa.com")) return "Vacasa";
  if (lowercaseUrl.includes("evolve.com")) return "Evolve";
  if (lowercaseUrl.includes("marriott.com")) return "Marriott Homes";
  if (lowercaseUrl.includes("agoda.com")) return "Agoda";
  if (lowercaseUrl.includes("kayak.com")) return "Kayak";
  if (lowercaseUrl.includes("hometogo.com")) return "HomeToGo";
  if (lowercaseUrl.includes("wimdu.com")) return "Wimdu";
  if (lowercaseUrl.includes("interhome.com")) return "Interhome";
  if (lowercaseUrl.includes("flipkey.com")) return "FlipKey";
  if (lowercaseUrl.includes("holidu.com")) return "Holidu";
  if (lowercaseUrl.includes("atraveo.com")) return "Atraveo";
  if (lowercaseUrl.includes("fewo-direkt.de")) return "FeWo-direkt";
  
  try {
    const domain = new URL(url).hostname.replace("www.", "");
    return domain.split(".")[0].charAt(0).toUpperCase() + domain.split(".")[0].slice(1);
  } catch {
    return "Other Platform";
  }
}

// Check if URL is a specific property listing (not a homepage or category page)
function isSpecificListing(url: string): boolean {
  const lowercaseUrl = url.toLowerCase();
  
  // Exclude homepage URLs
  if (lowercaseUrl.match(/^https?:\/\/[^\/]+\/?$/)) return false;
  
  // Exclude category/search pages
  if (lowercaseUrl.includes("/vacation-rentals/") && !lowercaseUrl.match(/\/\d+/)) return false;
  if (lowercaseUrl.includes("/holiday-homes/country/")) return false;
  if (lowercaseUrl.includes("/search")) return false;
  
  // Look for property ID patterns
  const hasPropertyId = lowercaseUrl.match(/\/(\d{5,})|\/p\/|\/property\/|\/rental\/|\/listing\//);
  return !!hasPropertyId;
}

// Check if URL is a booking platform
function isBookingPlatform(url: string): boolean {
  const lowercaseUrl = url.toLowerCase();
  const bookingPlatforms = [
    "vrbo.com", "booking.com", "expedia.com", "hotels.com", "tripadvisor.com",
    "homeaway.com", "vacasa.com", "evolve.com", "marriott.com", "agoda.com",
    "hometogo.com", "wimdu.com", "interhome.com", "flipkey.com",
    "holidu.com", "atraveo.com", "fewo-direkt.de", "stayz.com"
  ];
  return bookingPlatforms.some(platform => lowercaseUrl.includes(platform));
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
    const serpApiKey = Deno.env.get("SERPAPI_API_KEY");
    const lovableKey = Deno.env.get("LOVABLE_API_KEY");

    if (!serpApiKey) {
      console.error("SERPAPI_API_KEY not configured");
      return new Response(
        JSON.stringify({ error: "SerpAPI key not configured" }),
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

    // Extract room ID from Airbnb URL
    const roomIdMatch = search.airbnb_url.match(/rooms\/(\d+)/);
    const roomId = roomIdMatch ? roomIdMatch[1] : null;
    console.log("Airbnb room ID:", roomId);

    // Update search status
    await supabase.from("searches").update({
      status: "searching_alternatives"
    }).eq("id", searchId);

    const alternatives: SearchResult[] = [];
    const foundUrls = new Set<string>();
    let airbnbTitle = "Vacation Rental";
    let airbnbPrice: number | null = null;

    // Step 1: Use SerpAPI Google Images to find the Airbnb listing images
    console.log("Step 1: Searching Google Images for Airbnb listing...");
    
    let imageUrls: string[] = [];
    
    try {
      // Search for images of this specific Airbnb listing
      const imageSearchQuery = `site:airbnb.com rooms/${roomId}`;
      console.log("Image search query:", imageSearchQuery);
      
      const imageSearchResponse = await fetch(
        `https://serpapi.com/search.json?engine=google_images&q=${encodeURIComponent(imageSearchQuery)}&api_key=${serpApiKey}`
      );
      
      if (imageSearchResponse.ok) {
        const imageSearchData = await imageSearchResponse.json();
        const imagesResults = imageSearchData.images_results || [];
        
        console.log(`Found ${imagesResults.length} images from Google Images search`);
        
        // Get the first few image URLs (these are the Airbnb listing photos)
        for (const img of imagesResults.slice(0, 5)) {
          if (img.original) {
            imageUrls.push(img.original);
            console.log("Found image:", img.original.slice(0, 80) + "...");
          }
        }
        
        // Also try to get title from the search
        if (imagesResults[0]?.title) {
          airbnbTitle = imagesResults[0].title.replace(" - Airbnb", "");
        }
      }
    } catch (e) {
      console.error("Image search error:", e);
    }

    // Step 2: Reverse image search each image to find it on other platforms
    if (imageUrls.length > 0) {
      console.log(`Step 2: Reverse image searching ${imageUrls.length} images...`);
      
      for (const imageUrl of imageUrls.slice(0, 3)) {
        try {
          console.log("Reverse searching:", imageUrl.slice(0, 60) + "...");
          
          const reverseResponse = await fetch(
            `https://serpapi.com/search.json?engine=google_reverse_image&image_url=${encodeURIComponent(imageUrl)}&api_key=${serpApiKey}`
          );
          
          if (!reverseResponse.ok) {
            console.log("Reverse search failed:", reverseResponse.status);
            continue;
          }
          
          const reverseData = await reverseResponse.json();
          
          // Check image_results (pages with this exact image)
          const imageResults = reverseData.image_results || [];
          console.log(`Reverse search found ${imageResults.length} image results`);
          
          for (const result of imageResults) {
            const url = result.link;
            if (!url) continue;
            if (url.toLowerCase().includes("airbnb.") || foundUrls.has(url)) continue;
            
            if (isBookingPlatform(url)) {
              foundUrls.add(url);
              const isSpecific = isSpecificListing(url);
              
              alternatives.push({
                platform_name: getPlatformName(url),
                listing_url: url,
                listing_title: result.title || null,
                price: null,
                confidence_score: isSpecific ? 0.95 : 0.7, // Higher confidence for specific listings
              });
              
              console.log("Found match:", getPlatformName(url), isSpecific ? "(specific listing)" : "(category page)");
            }
          }
          
          // Also check inline_images for visually similar
          const inlineImages = reverseData.inline_images || [];
          for (const img of inlineImages) {
            const url = img.source;
            if (!url) continue;
            if (url.toLowerCase().includes("airbnb.") || foundUrls.has(url)) continue;
            
            if (isBookingPlatform(url)) {
              foundUrls.add(url);
              alternatives.push({
                platform_name: getPlatformName(url),
                listing_url: url,
                listing_title: img.title || null,
                price: null,
                confidence_score: 0.85,
              });
              console.log("Found similar image on:", getPlatformName(url));
            }
          }
          
          // Check organic results too
          const organicResults = reverseData.organic_results || [];
          for (const result of organicResults) {
            const url = result.link;
            if (!url) continue;
            if (url.toLowerCase().includes("airbnb.") || foundUrls.has(url)) continue;
            
            if (isBookingPlatform(url) && isSpecificListing(url)) {
              foundUrls.add(url);
              alternatives.push({
                platform_name: getPlatformName(url),
                listing_url: url,
                listing_title: result.title || null,
                price: null,
                confidence_score: 0.75,
              });
              console.log("Found organic match on:", getPlatformName(url));
            }
          }
        } catch (e) {
          console.error("Reverse search error:", e);
        }
      }
    } else {
      console.log("No images found from Google Images search");
    }

    // Step 3: Also do a direct text search for the property on other platforms
    console.log("Step 3: Text search for property on booking platforms...");
    
    const textSearchQueries = [
      `"${roomId}" vrbo OR booking.com -airbnb`,
      `airbnb ${roomId} site:vrbo.com OR site:booking.com`,
    ];
    
    for (const query of textSearchQueries) {
      try {
        console.log("Text search:", query);
        
        const textResponse = await fetch(
          `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query)}&api_key=${serpApiKey}&num=10`
        );
        
        if (textResponse.ok) {
          const textData = await textResponse.json();
          const results = textData.organic_results || [];
          
          for (const result of results) {
            const url = result.link;
            if (!url) continue;
            if (url.toLowerCase().includes("airbnb.") || foundUrls.has(url)) continue;
            
            if (isBookingPlatform(url) && isSpecificListing(url)) {
              foundUrls.add(url);
              alternatives.push({
                platform_name: getPlatformName(url),
                listing_url: url,
                listing_title: result.title || null,
                price: null,
                confidence_score: 0.6,
              });
              console.log("Found text match on:", getPlatformName(url));
            }
          }
        }
      } catch (e) {
        console.error("Text search error:", e);
      }
    }

    console.log(`Total alternatives found: ${alternatives.length}`);

    // Step 4: Try to extract prices using AI
    if (alternatives.length > 0 && lovableKey) {
      console.log("Step 4: Extracting prices...");
      
      for (const alt of alternatives.slice(0, 5)) {
        try {
          // Use SerpAPI to get page snippet for price extraction
          const pageResponse = await fetch(
            `https://serpapi.com/search.json?engine=google&q=site:${new URL(alt.listing_url).hostname} "${new URL(alt.listing_url).pathname}"&api_key=${serpApiKey}`
          );
          
          if (pageResponse.ok) {
            const pageData = await pageResponse.json();
            const snippet = pageData.organic_results?.[0]?.snippet || "";
            
            // Look for price patterns in snippet
            const priceMatch = snippet.match(/[\$€£CHF]\s*(\d{2,4})|\b(\d{2,4})\s*(?:per night|\/night|night)/i);
            if (priceMatch) {
              alt.price = parseInt(priceMatch[1] || priceMatch[2]);
              console.log(`Found price ${alt.price} for ${alt.platform_name}`);
            }
          }
        } catch (e) {
          console.log("Price extraction failed for", alt.platform_name);
        }
      }
    }

    // Sort by confidence and filter to specific listings
    alternatives.sort((a, b) => b.confidence_score - a.confidence_score);
    const topAlternatives = alternatives
      .filter(a => a.confidence_score >= 0.5)
      .slice(0, 5);

    // Calculate savings
    const resultsWithSavings = topAlternatives.map(alt => ({
      ...alt,
      original_price: airbnbPrice,
      savings_amount: alt.price && airbnbPrice ? Math.max(0, airbnbPrice - alt.price) : null,
      savings_percentage: alt.price && airbnbPrice && alt.price < airbnbPrice 
        ? Math.round(((airbnbPrice - alt.price) / airbnbPrice) * 100) 
        : null,
    }));

    // Insert results
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
      airbnb_title: airbnbTitle,
      airbnb_price: airbnbPrice,
    }).eq("id", searchId);

    console.log("Search completed with", resultsWithSavings.length, "results");

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
