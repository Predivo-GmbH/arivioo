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
  image_url: string | null;
  images: string[];
}

// Expanded platform list for better coverage
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
  if (lowercaseUrl.includes("holidaycheck.")) return "HolidayCheck";
  if (lowercaseUrl.includes("hrs.de") || lowercaseUrl.includes("hrs.com")) return "HRS";
  if (lowercaseUrl.includes("hostelworld.com")) return "Hostelworld";
  if (lowercaseUrl.includes("interhome.")) return "Interhome";
  if (lowercaseUrl.includes("flipkey.com")) return "FlipKey";
  if (lowercaseUrl.includes("atraveo.")) return "Atraveo";
  if (lowercaseUrl.includes("fewo-direkt.")) return "FeWo-direkt";
  if (lowercaseUrl.includes("traum-ferienwohnungen.")) return "Traum-Ferienwohnungen";
  if (lowercaseUrl.includes("casamundo.")) return "Casamundo";
  if (lowercaseUrl.includes("facebook.com")) return "Facebook";
  
  try {
    const domain = new URL(url).hostname.replace("www.", "");
    const name = domain.split(".")[0];
    return name.charAt(0).toUpperCase() + name.slice(1);
  } catch {
    return "Other Platform";
  }
}

// Expanded booking platform check
function isBookingPlatform(url: string): boolean {
  const lowercaseUrl = url.toLowerCase();
  const platforms = [
    "vrbo.com", "booking.com", "expedia.com", "hotels.com", "tripadvisor.com",
    "homeaway.com", "vacasa.com", "agoda.com", "hometogo.com", "holidu.com",
    "interhome.com", "interhome.de", "interhome.ch", "flipkey.com", 
    "atraveo.com", "atraveo.de", "holidaycheck.de", "holidaycheck.com",
    "hrs.de", "hrs.com", "hostelworld.com", "fewo-direkt.de",
    "traum-ferienwohnungen.de", "casamundo.de", "casamundo.com"
  ];
  return platforms.some(p => lowercaseUrl.includes(p));
}

// Check if URL is a direct property website (not a major platform)
function isDirectPropertySite(url: string): boolean {
  const lowercaseUrl = url.toLowerCase();
  // Exclude major platforms, social media, and generic sites
  const excludePatterns = [
    "airbnb.", "google.", "facebook.", "instagram.", "twitter.", "pinterest.",
    "youtube.", "wikipedia.", "tripadvisor.", "yelp.", "maps.", "cloudflare.",
    ".gov", ".edu", "amazon.", "ebay.", "craigslist."
  ];
  
  if (excludePatterns.some(p => lowercaseUrl.includes(p))) return false;
  
  // Look for property-related keywords in URL
  const propertyKeywords = [
    "villa", "cottage", "cabin", "chalet", "apartment", "flat", "house",
    "rental", "holiday", "vacation", "stay", "lodge", "guest", "bnb",
    "ferienwohnung", "ferienhaus", "gite", "chambre", "pension"
  ];
  
  return propertyKeywords.some(k => lowercaseUrl.includes(k));
}

// UUID v4 validation regex
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Validate Airbnb URL format (supports all locales)
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

// Check if an image URL is a valid property photo (not logo/favicon)
function isValidPropertyImage(url: string): boolean {
  const lowercaseUrl = url.toLowerCase();
  
  // Exclude favicons, logos, and platform assets
  const excludePatterns = [
    "favicon", "logo", "icon", "brand", "platform-assets",
    "airbnbplatformassets", "airbnb-platform-assets",
    "sprite", "button", "arrow", "avatar", "profile",
    "social", "badge", "marker", "pin", "placeholder"
  ];
  
  if (excludePatterns.some(p => lowercaseUrl.includes(p))) {
    return false;
  }
  
  // Must be a muscache CDN image with reasonable size
  if (!url.includes("muscache.com")) return false;
  
  // Must be in pictures folder (not assets)
  if (!url.includes("/pictures/") && !url.includes("/im/pictures/")) return false;
  
  // Prefer hosting/miso format images (actual property photos)
  const preferredPatterns = [
    "/hosting/", "/miso/", "/BnbProperty/", "Hosting-"
  ];
  
  return preferredPatterns.some(p => url.includes(p)) || 
         // Or general property images with proper extensions
         (/\.(jpg|jpeg|png|webp)/i.test(url) && url.length > 100);
}

// Extract dates from Airbnb URL
function extractDatesFromUrl(url: string): { checkIn: string | null; checkOut: string | null } {
  try {
    const urlObj = new URL(url);
    return {
      checkIn: urlObj.searchParams.get('check_in'),
      checkOut: urlObj.searchParams.get('check_out')
    };
  } catch {
    return { checkIn: null, checkOut: null };
  }
}

// Generate default dates (2 weeks from now, 3 nights)
function generateDefaultDates(): { checkIn: string; checkOut: string } {
  const today = new Date();
  const checkIn = new Date(today);
  checkIn.setDate(today.getDate() + 14);
  
  const checkOut = new Date(checkIn);
  checkOut.setDate(checkIn.getDate() + 3);
  
  return {
    checkIn: checkIn.toISOString().split('T')[0],
    checkOut: checkOut.toISOString().split('T')[0]
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Extract and verify JWT token
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Authentication required" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const serpApiKey = Deno.env.get("SERPAPI_API_KEY");

    if (!serpApiKey) {
      return new Response(
        JSON.stringify({ error: "Search service temporarily unavailable" }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Create a user-scoped client to verify the user
    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } }
    });

    // Get authenticated user
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) {
      console.error("Auth error:", userError?.message);
      return new Response(
        JSON.stringify({ error: "Invalid authentication token" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log("Authenticated user:", user.id);

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

    // Use service role client for database operations
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Fetch the search and verify ownership
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

    // CRITICAL: Verify the search belongs to the authenticated user
    if (search.user_id !== user.id) {
      console.error("User", user.id, "attempted to access search owned by", search.user_id);
      return new Response(
        JSON.stringify({ error: "Access denied" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
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

    // Extract dates from URL or generate defaults
    let { checkIn, checkOut } = extractDatesFromUrl(search.airbnb_url);
    if (!checkIn || !checkOut) {
      const defaults = generateDefaultDates();
      checkIn = defaults.checkIn;
      checkOut = defaults.checkOut;
      console.log("Using default dates:", checkIn, "to", checkOut);
    } else {
      console.log("Using URL dates:", checkIn, "to", checkOut);
    }

    // Update status to step 1
    await supabase.from("searches").update({ 
      status: "extracting_photos" 
    }).eq("id", searchId);

    const alternatives: SearchResult[] = [];
    const foundUrls = new Set<string>();
    let airbnbTitle = "Vacation Rental";
    let airbnbPrice: number | null = null;

    // Step 1: Fetch Airbnb page and extract CLEAN property images
    console.log("Step 1: Extracting clean property photos from Airbnb...");
    
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
          airbnbTitle = titleMatch[1]
            .replace(" - Airbnb", "")
            .replace(" · Airbnb", "")
            .replace(/\s*-\s*(Houses|Apartments|Homes|Villas|Cabins|Cottages|Condos)?\s*(for Rent|to Rent|zur Miete|in)?\s*.*$/i, "")
            .trim();
          console.log("Extracted title:", airbnbTitle);
        }
        
        // Look for muscache.com image URLs - prioritize actual property photos
        const imagePatterns = [
          // Hosting format (most reliable for property photos)
          /https:\/\/a0\.muscache\.com\/im\/pictures\/hosting\/Hosting-[^"'\s\)]+/gi,
          // miso format (also good quality property photos)
          /https:\/\/a0\.muscache\.com\/im\/pictures\/miso\/[^"'\s\)]+/gi,
          // BnbProperty format
          /https:\/\/a0\.muscache\.com\/im\/pictures\/BnbProperty\/[^"'\s\)]+/gi,
          // prohost-api format
          /https:\/\/a0\.muscache\.com\/im\/pictures\/prohost-api\/[^"'\s\)]+/gi,
          // General UUID format images (property photos)
          /https:\/\/a0\.muscache\.com\/im\/pictures\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(?:jpg|jpeg|png|webp)/gi,
        ];
        
        let allImageUrls: string[] = [];
        
        for (const pattern of imagePatterns) {
          const matches = html.match(pattern) || [];
          console.log(`Pattern found ${matches.length} matches`);
          allImageUrls.push(...matches);
        }
        
        // Also look in JSON data embedded in page
        const jsonMatches = html.match(/"pictureUrl"\s*:\s*"([^"]+)"/g) || [];
        for (const match of jsonMatches) {
          const urlMatch = match.match(/"pictureUrl"\s*:\s*"([^"]+)"/);
          if (urlMatch && urlMatch[1]) {
            allImageUrls.push(urlMatch[1].replace(/\\u002F/g, '/'));
          }
        }
        
        // Extract price if possible
        const pricePatterns = [
          /\$(\d{1,5})\s*(?:per night|\/night|night)/i,
          /"priceString"\s*:\s*"\$(\d+)"/,
          /"price"\s*:\s*(\d+)/,
          /CHF\s*(\d{1,5})/,
          /€\s*(\d{1,5})/,
        ];
        
        for (const pattern of pricePatterns) {
          const priceMatch = html.match(pattern);
          if (priceMatch) {
            airbnbPrice = parseInt(priceMatch[1]);
            console.log("Extracted price:", airbnbPrice);
            break;
          }
        }
        
        // Clean, dedupe, and filter images - NO LOGOS OR FAVICONS
        imageUrls = [...new Set(allImageUrls)]
          .map(url => url.replace(/\\u002F/g, '/').replace(/\\/g, ''))
          .filter(isValidPropertyImage)
          .slice(0, 5);
        
        console.log(`Found ${imageUrls.length} clean property images (filtered out logos/favicons)`);
        imageUrls.forEach((url, i) => console.log(`Image ${i + 1}:`, url.slice(0, 120)));
      } else {
        console.log("Failed to fetch Airbnb page:", airbnbResponse.status);
      }
    } catch (e) {
      console.error("Error fetching Airbnb page:", e);
    }

    // Update status to step 2
    await supabase.from("searches").update({ 
      status: "searching_platforms" 
    }).eq("id", searchId);

    // Step 2: Reverse image search each image
    if (imageUrls.length > 0) {
      console.log("Step 2: Running reverse image search across platforms...");
      
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
          console.log("Results - image:", reverseData.image_results?.length || 0, 
                      "inline:", reverseData.inline_images?.length || 0,
                      "organic:", reverseData.organic_results?.length || 0);
          
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
            
            // Check if it's a known booking platform
            if (isBookingPlatform(url)) {
              foundUrls.add(url);
              const resultImages: string[] = [];
              if (result.thumbnail) resultImages.push(result.thumbnail);
              if (result.original) resultImages.push(result.original);
              
              alternatives.push({
                platform_name: getPlatformName(url),
                listing_url: url,
                listing_title: result.title || result.snippet || null,
                price: null,
                confidence_score: 0.9,
                image_url: resultImages[0] || null,
                images: resultImages.slice(0, 5),
              });
              console.log("FOUND on platform:", getPlatformName(url), url.slice(0, 80));
            }
            // Also check for direct property websites
            else if (isDirectPropertySite(url)) {
              foundUrls.add(url);
              const resultImages: string[] = [];
              if (result.thumbnail) resultImages.push(result.thumbnail);
              if (result.original) resultImages.push(result.original);
              
              alternatives.push({
                platform_name: getPlatformName(url) + " (Direct)",
                listing_url: url,
                listing_title: result.title || result.snippet || null,
                price: null,
                confidence_score: 0.85,
                image_url: resultImages[0] || null,
                images: resultImages.slice(0, 5),
              });
              console.log("FOUND direct site:", url.slice(0, 80));
            }
          }
          
          // Small delay between searches
          await new Promise(r => setTimeout(r, 500));
        } catch (e) {
          console.error("Reverse search error:", e);
        }
      }
    }

    // Update status to step 3
    await supabase.from("searches").update({ 
      status: "comparing_prices" 
    }).eq("id", searchId);

    // Step 3: Text search fallback if no image matches
    if (alternatives.length === 0) {
      console.log("Step 3: Text search fallback...");
      
      // Clean up the title for better search
      const cleanTitle = airbnbTitle
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60);
      
      const searchQuery = `"${cleanTitle}" (booking.com OR vrbo OR hotels.com OR agoda OR holidaycheck) -airbnb -pinterest`;
      console.log("Text search query:", searchQuery);
      
      try {
        const textResponse = await fetch(
          `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(searchQuery)}&api_key=${serpApiKey}&num=30`
        );
        
        if (textResponse.ok) {
          const textData = await textResponse.json();
          const results = textData.organic_results || [];
          
          for (const result of results) {
            const url = result.link;
            if (!url || url.toLowerCase().includes("airbnb.") || foundUrls.has(url)) continue;
            
            if (isBookingPlatform(url)) {
              foundUrls.add(url);
              const resultImages: string[] = result.thumbnail ? [result.thumbnail] : [];
              alternatives.push({
                platform_name: getPlatformName(url),
                listing_url: url,
                listing_title: result.title || null,
                price: null,
                confidence_score: 0.6,
                image_url: result.thumbnail || null,
                images: resultImages,
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

    // Sort by confidence and limit results
    alternatives.sort((a, b) => b.confidence_score - a.confidence_score);
    const topAlternatives = alternatives.slice(0, 8);

    // Use filtered property images (no logos)
    const airbnbImageUrl = imageUrls.length > 0 ? imageUrls[0] : null;
    const airbnbImages = imageUrls.slice(0, 5);

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
          image_url: r.image_url,
          images: r.images,
        }))
      );
    }

    await supabase.from("searches").update({ 
      status: "completed",
      airbnb_title: airbnbTitle,
      airbnb_price: airbnbPrice,
      airbnb_image_url: airbnbImageUrl,
      airbnb_images: airbnbImages,
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
          imageUrl: airbnbImageUrl, 
          images: airbnbImages 
        },
        dates: { checkIn, checkOut }
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Search error:", error);
    return new Response(
      JSON.stringify({ error: "An error occurred processing your request. Please try again." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
