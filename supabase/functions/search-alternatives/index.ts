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

function getPlatformName(url: string): string {
  const lowercaseUrl = url.toLowerCase();
  if (lowercaseUrl.includes("vrbo.com")) return "Vrbo";
  if (lowercaseUrl.includes("booking.com")) return "Booking.com";
  if (lowercaseUrl.includes("expedia.com")) return "Expedia";
  if (lowercaseUrl.includes("hotels.com")) return "Hotels.com";
  if (lowercaseUrl.includes("tripadvisor.com")) return "TripAdvisor";
  if (lowercaseUrl.includes("homeaway.com")) return "HomeAway";
  if (lowercaseUrl.includes("vacasa.com")) return "Vacasa";
  if (lowercaseUrl.includes("agoda.com")) return "Agoda";
  if (lowercaseUrl.includes("hometogo.com")) return "HomeToGo";
  if (lowercaseUrl.includes("holidu.com")) return "Holidu";
  
  try {
    const domain = new URL(url).hostname.replace("www.", "");
    return domain.split(".")[0].charAt(0).toUpperCase() + domain.split(".")[0].slice(1);
  } catch {
    return "Other Platform";
  }
}

function isBookingPlatform(url: string): boolean {
  const lowercaseUrl = url.toLowerCase();
  const platforms = [
    "vrbo.com", "booking.com", "expedia.com", "hotels.com", "tripadvisor.com",
    "homeaway.com", "vacasa.com", "agoda.com", "hometogo.com", "holidu.com",
    "interhome.com", "flipkey.com", "atraveo.com"
  ];
  return platforms.some(p => lowercaseUrl.includes(p));
}

// UUID v4 validation regex
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Validate Airbnb URL format
function isValidAirbnbUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.hostname.includes("airbnb.") || parsed.hostname === "airbnb.com") &&
      parsed.pathname.includes("/rooms/")
    );
  } catch {
    return false;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    let body;
    try {
      body = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid request body" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    
    const { searchId } = body;
    
    if (!searchId) {
      return new Response(
        JSON.stringify({ error: "Search ID is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validate searchId is a valid UUID
    if (typeof searchId !== "string" || !UUID_REGEX.test(searchId)) {
      return new Response(
        JSON.stringify({ error: "Invalid search ID format" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const serpApiKey = Deno.env.get("SERPAPI_API_KEY");

    if (!serpApiKey) {
      return new Response(
        JSON.stringify({ error: "SerpAPI key not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { data: search, error: searchError } = await supabase
      .from("searches")
      .select("*")
      .eq("id", searchId)
      .single();

    if (searchError || !search) {
      return new Response(
        JSON.stringify({ error: "Search not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validate the Airbnb URL from the database
    if (!search.airbnb_url || !isValidAirbnbUrl(search.airbnb_url)) {
      console.error("Invalid Airbnb URL in database:", search.airbnb_url);
      return new Response(
        JSON.stringify({ error: "Invalid Airbnb URL" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log("Processing search for URL:", search.airbnb_url);

    const roomIdMatch = search.airbnb_url.match(/rooms\/(\d+)/);
    const roomId = roomIdMatch ? roomIdMatch[1] : null;
    console.log("Airbnb room ID:", roomId);

    await supabase.from("searches").update({ status: "searching_alternatives" }).eq("id", searchId);

    const alternatives: SearchResult[] = [];
    const foundUrls = new Set<string>();
    let airbnbTitle = "Vacation Rental";
    let airbnbPrice: number | null = null;

    // Step 1: Fetch Airbnb page directly and extract image URLs
    console.log("Step 1: Fetching Airbnb page to extract image URLs...");
    
    let imageUrls: string[] = [];
    
    try {
      const airbnbResponse = await fetch(search.airbnb_url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
        },
      });
      
      if (airbnbResponse.ok) {
        const html = await airbnbResponse.text();
        console.log("Fetched Airbnb page, length:", html.length);
        
        // Extract title
        const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
        if (titleMatch) {
          airbnbTitle = titleMatch[1].replace(" - Airbnb", "").replace(" · Airbnb", "");
          console.log("Extracted title:", airbnbTitle);
        }
        
        // Look for muscache.com image URLs in various patterns
        const imagePatterns = [
          // Direct image URLs
          /https:\/\/a0\.muscache\.com\/im\/pictures\/[^"'\s\)]+\.(?:jpg|jpeg|png|webp)/gi,
          // BnbProperty format
          /https:\/\/a0\.muscache\.com\/im\/pictures\/BnbProperty\/[^"'\s\)]+/gi,
          // Hosting format  
          /https:\/\/a0\.muscache\.com\/im\/pictures\/hosting\/[^"'\s\)]+/gi,
          // miso format
          /https:\/\/a0\.muscache\.com\/im\/pictures\/miso\/[^"'\s\)]+/gi,
          // General pictures format
          /https:\/\/a0\.muscache\.com\/im\/pictures\/[a-f0-9-]+\.(?:jpg|jpeg|png|webp)/gi,
          // With im_w parameter
          /https:\/\/a0\.muscache\.com[^"'\s\)]+im_w=\d+/gi,
        ];
        
        for (const pattern of imagePatterns) {
          const matches = html.match(pattern) || [];
          console.log(`Pattern ${pattern.source.slice(0, 40)}... found ${matches.length} matches`);
          imageUrls.push(...matches);
        }
        
        // Also look in JSON data embedded in page
        const jsonMatches = html.match(/"pictureUrl"\s*:\s*"([^"]+)"/g) || [];
        for (const match of jsonMatches) {
          const urlMatch = match.match(/"pictureUrl"\s*:\s*"([^"]+)"/);
          if (urlMatch && urlMatch[1]) {
            imageUrls.push(urlMatch[1]);
          }
        }
        
        // Look for og:image
        const ogImageMatch = html.match(/property="og:image"\s+content="([^"]+)"/);
        if (ogImageMatch && ogImageMatch[1]) {
          imageUrls.push(ogImageMatch[1]);
          console.log("Found og:image:", ogImageMatch[1].slice(0, 80));
        }
        
        // Extract price if possible
        const priceMatch = html.match(/\$(\d{1,5})\s*(?:per night|\/night|night)/i) ||
                          html.match(/"priceString"\s*:\s*"\$(\d+)"/);
        if (priceMatch) {
          airbnbPrice = parseInt(priceMatch[1]);
          console.log("Extracted price:", airbnbPrice);
        }
      } else {
        console.log("Failed to fetch Airbnb page:", airbnbResponse.status);
      }
    } catch (e) {
      console.error("Error fetching Airbnb page:", e);
    }

    // Clean and dedupe image URLs
    imageUrls = [...new Set(imageUrls)]
      .map(url => url.replace(/\\u002F/g, '/').replace(/\\/g, ''))
      .filter(url => url.includes('muscache.com') && url.length > 50)
      .slice(0, 5);
    
    console.log(`Found ${imageUrls.length} unique image URLs`);
    imageUrls.forEach((url, i) => console.log(`Image ${i + 1}:`, url.slice(0, 100)));

    // Step 2: Reverse image search each image
    if (imageUrls.length > 0) {
      console.log("Step 2: Reverse image searching...");
      
      for (const imageUrl of imageUrls) {
        try {
          console.log("Reverse searching:", imageUrl.slice(0, 80));
          
          const reverseResponse = await fetch(
            `https://serpapi.com/search.json?engine=google_reverse_image&image_url=${encodeURIComponent(imageUrl)}&api_key=${serpApiKey}`
          );
          
          if (!reverseResponse.ok) {
            console.log("Reverse search failed:", reverseResponse.status);
            continue;
          }
          
          const reverseData = await reverseResponse.json();
          console.log("Reverse search results - image_results:", reverseData.image_results?.length || 0);
          console.log("Reverse search results - inline_images:", reverseData.inline_images?.length || 0);
          console.log("Reverse search results - organic_results:", reverseData.organic_results?.length || 0);
          
          // Check all result types
          const allResults = [
            ...(reverseData.image_results || []),
            ...(reverseData.inline_images || []),
            ...(reverseData.organic_results || []),
          ];
          
          for (const result of allResults) {
            const url = result.link || result.source;
            if (!url) continue;
            if (url.toLowerCase().includes("airbnb.") || foundUrls.has(url)) continue;
            
            if (isBookingPlatform(url)) {
              foundUrls.add(url);
              alternatives.push({
                platform_name: getPlatformName(url),
                listing_url: url,
                listing_title: result.title || result.snippet || null,
                price: null,
                confidence_score: 0.9,
              });
              console.log("FOUND MATCH:", getPlatformName(url), url.slice(0, 80));
            }
          }
          
          // Small delay between searches
          await new Promise(r => setTimeout(r, 500));
        } catch (e) {
          console.error("Reverse search error:", e);
        }
      }
    }

    // Step 3: Text search fallback
    if (alternatives.length === 0) {
      console.log("Step 3: Text search fallback...");
      
      // Search using the title
      const searchQuery = `"${airbnbTitle}" booking OR vrbo -airbnb`;
      console.log("Text search query:", searchQuery);
      
      try {
        const textResponse = await fetch(
          `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(searchQuery)}&api_key=${serpApiKey}&num=20`
        );
        
        if (textResponse.ok) {
          const textData = await textResponse.json();
          const results = textData.organic_results || [];
          
          for (const result of results) {
            const url = result.link;
            if (!url || url.toLowerCase().includes("airbnb.") || foundUrls.has(url)) continue;
            
            if (isBookingPlatform(url)) {
              foundUrls.add(url);
              alternatives.push({
                platform_name: getPlatformName(url),
                listing_url: url,
                listing_title: result.title || null,
                price: null,
                confidence_score: 0.6,
              });
              console.log("Text match found:", getPlatformName(url));
            }
          }
        }
      } catch (e) {
        console.error("Text search error:", e);
      }
    }

    console.log(`Total alternatives found: ${alternatives.length}`);

    // Sort and limit results
    alternatives.sort((a, b) => b.confidence_score - a.confidence_score);
    const topAlternatives = alternatives.slice(0, 5);

    const resultsWithSavings = topAlternatives.map(alt => ({
      ...alt,
      original_price: airbnbPrice,
      savings_amount: null,
      savings_percentage: null,
    }));

    if (resultsWithSavings.length > 0) {
      await supabase.from("search_results").insert(
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
    }

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
        airbnb: { title: airbnbTitle, price: airbnbPrice, url: search.airbnb_url }
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
