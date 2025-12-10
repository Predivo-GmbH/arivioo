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
  
  // Try to extract domain name
  try {
    const domain = new URL(url).hostname.replace("www.", "");
    return domain.split(".")[0].charAt(0).toUpperCase() + domain.split(".")[0].slice(1);
  } catch {
    return "Other Platform";
  }
}

// Check if URL is a booking platform (not a generic site)
function isBookingPlatform(url: string): boolean {
  const lowercaseUrl = url.toLowerCase();
  const bookingPlatforms = [
    "vrbo.com", "booking.com", "expedia.com", "hotels.com", "tripadvisor.com",
    "homeaway.com", "vacasa.com", "evolve.com", "marriott.com", "agoda.com",
    "kayak.com", "hometogo.com", "wimdu.com", "interhome.com", "flipkey.com",
    "stayz.com.au", "abritel.fr", "fewo-direkt.de", "homelidays.com"
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
    const firecrawlKey = Deno.env.get("FIRECRAWL_API_KEY");
    const serpApiKey = Deno.env.get("SERPAPI_API_KEY");
    const lovableKey = Deno.env.get("LOVABLE_API_KEY");

    if (!serpApiKey) {
      console.error("SERPAPI_API_KEY not configured");
      return new Response(
        JSON.stringify({ error: "SerpAPI key not configured" }),
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

    // Extract room ID from Airbnb URL
    const roomIdMatch = search.airbnb_url.match(/rooms\/(\d+)/);
    const roomId = roomIdMatch ? roomIdMatch[1] : null;
    console.log("Airbnb room ID:", roomId);

    // Step 1: Get Airbnb listing images using Firecrawl
    let imageUrls: string[] = [];
    let airbnbTitle = "Vacation Rental";
    let airbnbPrice: number | null = null;

    if (firecrawlKey) {
      console.log("Attempting to scrape Airbnb listing for images...");
      try {
        const scrapeResponse = await fetch("https://api.firecrawl.dev/v1/scrape", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${firecrawlKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            url: search.airbnb_url,
            formats: ["html", "links"],
            onlyMainContent: false,
            waitFor: 8000,
            timeout: 45000,
          }),
        });

        const scrapeData = await scrapeResponse.json();
        
        if (scrapeResponse.ok && scrapeData.success) {
          console.log("Scrape successful, extracting images...");
          
          // Extract title
          airbnbTitle = scrapeData.metadata?.title || "Vacation Rental";
          airbnbTitle = airbnbTitle.replace(" - Airbnb", "").replace(" · ", " - ");
          
          // Extract images from HTML content - look for Airbnb image CDN URLs
          const html = scrapeData.html || "";
          
          // Airbnb uses various image URL patterns
          const imagePatterns = [
            /https:\/\/a0\.muscache\.com\/im\/pictures\/[^"'\s]+/g,
            /https:\/\/a0\.muscache\.com\/[^"'\s]+\.jpg/g,
            /https:\/\/images\.rentals-united\.com\/[^"'\s]+/g,
          ];
          
          for (const pattern of imagePatterns) {
            const matches = html.match(pattern) || [];
            imageUrls.push(...matches);
          }
          
          // Also check links array
          if (scrapeData.links) {
            const imageLinks = scrapeData.links.filter((link: string) => 
              link.includes("muscache.com") && (link.includes(".jpg") || link.includes("pictures"))
            );
            imageUrls.push(...imageLinks);
          }
          
          // Remove duplicates and limit
          imageUrls = [...new Set(imageUrls)].slice(0, 5);
          console.log(`Found ${imageUrls.length} unique images`);
          
          // Try to extract price
          const priceMatch = html.match(/\$(\d{1,5})\s*(per night|\/night|night)/i);
          if (priceMatch) {
            airbnbPrice = parseInt(priceMatch[1]);
          }
        } else {
          console.log("Scraping failed:", scrapeData.error || "Unknown error");
        }
      } catch (e) {
        console.log("Scraping error:", e);
      }
    }

    // If no images found from scraping, try to construct Airbnb image URL from room ID
    if (imageUrls.length === 0 && roomId) {
      console.log("No images from scraping, using Airbnb API approach...");
      // Try a different approach - search for the listing images via text search
    }

    // Update search status
    await supabase.from("searches").update({
      airbnb_title: airbnbTitle,
      airbnb_price: airbnbPrice,
      status: "searching_alternatives"
    }).eq("id", searchId);

    // Step 2: Use reverse image search with SerpAPI
    const alternatives: SearchResult[] = [];
    const foundUrls = new Set<string>();

    if (imageUrls.length > 0) {
      console.log("Performing reverse image search on", imageUrls.length, "images...");
      
      for (const imageUrl of imageUrls.slice(0, 3)) { // Limit to 3 images for speed
        try {
          console.log("Reverse searching image:", imageUrl.slice(0, 100) + "...");
          
          const serpResponse = await fetch(
            `https://serpapi.com/search.json?engine=google_reverse_image&image_url=${encodeURIComponent(imageUrl)}&api_key=${serpApiKey}`
          );
          
          if (!serpResponse.ok) {
            console.log("SerpAPI error:", serpResponse.status);
            continue;
          }
          
          const serpData = await serpResponse.json();
          
          // Process image results
          const imageResults = serpData.image_results || [];
          const inlineImages = serpData.inline_images || [];
          
          console.log(`Found ${imageResults.length} image results, ${inlineImages.length} inline images`);
          
          for (const result of [...imageResults, ...inlineImages]) {
            const url = result.link || result.source || result.original;
            if (!url) continue;
            
            // Skip Airbnb and duplicates
            if (url.toLowerCase().includes("airbnb.") || foundUrls.has(url)) continue;
            
            // Check if it's a booking platform
            if (isBookingPlatform(url)) {
              foundUrls.add(url);
              
              alternatives.push({
                platform_name: getPlatformName(url),
                listing_url: url,
                listing_title: result.title || result.snippet || null,
                price: null, // Will try to extract later
                confidence_score: 0.9, // High confidence - same image found
              });
              
              console.log("Found match on:", getPlatformName(url), url.slice(0, 80));
            }
          }
          
          // Also check organic/text results that mention the same property
          const organicResults = serpData.organic_results || [];
          for (const result of organicResults) {
            const url = result.link;
            if (!url) continue;
            if (url.toLowerCase().includes("airbnb.") || foundUrls.has(url)) continue;
            
            if (isBookingPlatform(url)) {
              foundUrls.add(url);
              
              alternatives.push({
                platform_name: getPlatformName(url),
                listing_url: url,
                listing_title: result.title || null,
                price: null,
                confidence_score: 0.75, // Slightly lower - text result, not direct image
              });
              
              console.log("Found text match on:", getPlatformName(url));
            }
          }
        } catch (e) {
          console.error("Reverse image search error:", e);
        }
      }
    }

    // Step 3: Fallback - text-based search if no image results
    if (alternatives.length === 0 && firecrawlKey) {
      console.log("No image matches, trying text search...");
      
      const searchQueries = [
        roomId ? `"${roomId}" vacation rental -airbnb` : null,
        `${airbnbTitle} vrbo booking.com`,
      ].filter(Boolean) as string[];
      
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
              limit: 10,
            }),
          });

          const searchData = await searchResponse.json();
          if (searchData.success && searchData.data) {
            for (const result of searchData.data) {
              const url = result.url;
              if (!url || url.toLowerCase().includes("airbnb.") || foundUrls.has(url)) continue;
              
              if (isBookingPlatform(url)) {
                foundUrls.add(url);
                alternatives.push({
                  platform_name: getPlatformName(url),
                  listing_url: url,
                  listing_title: result.title || null,
                  price: null,
                  confidence_score: 0.5, // Lower confidence - text search only
                });
              }
            }
          }
        } catch (e) {
          console.error("Text search error:", e);
        }
      }
    }

    // Step 4: Try to extract prices from found listings
    console.log(`Found ${alternatives.length} alternatives, extracting prices...`);
    
    for (const alt of alternatives.slice(0, 5)) {
      if (firecrawlKey) {
        try {
          const priceResponse = await fetch("https://api.firecrawl.dev/v1/scrape", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${firecrawlKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              url: alt.listing_url,
              formats: ["markdown"],
              onlyMainContent: true,
              timeout: 15000,
            }),
          });

          const priceData = await priceResponse.json();
          if (priceData.success && priceData.markdown) {
            // Extract price using AI
            const priceAiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
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
                    content: "Extract the nightly price from this vacation rental listing. Return ONLY a number (no currency symbols). If you can't find a clear nightly price, return 'null'."
                  },
                  {
                    role: "user",
                    content: priceData.markdown.slice(0, 3000)
                  }
                ],
              }),
            });

            if (priceAiResponse.ok) {
              const priceAiData = await priceAiResponse.json();
              const priceStr = priceAiData.choices?.[0]?.message?.content?.trim();
              const extractedPrice = parseFloat(priceStr);
              if (!isNaN(extractedPrice) && extractedPrice > 0 && extractedPrice < 10000) {
                alt.price = extractedPrice;
                console.log(`Extracted price ${extractedPrice} for ${alt.platform_name}`);
              }
            }
          }
        } catch (e) {
          console.log("Price extraction failed for", alt.platform_name);
        }
      }
    }

    // Sort by confidence and limit
    alternatives.sort((a, b) => b.confidence_score - a.confidence_score);
    const topAlternatives = alternatives.slice(0, 5);

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
