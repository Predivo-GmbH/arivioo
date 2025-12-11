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

// Expanded platform list for better coverage - including international variants
function getPlatformName(url: string): string {
  const lowercaseUrl = url.toLowerCase();
  if (lowercaseUrl.includes("vrbo.com")) return "Vrbo";
  if (lowercaseUrl.includes("booking.com")) return "Booking.com";
  if (lowercaseUrl.includes("expedia.")) return "Expedia";
  if (lowercaseUrl.includes("hotels.com")) return "Hotels.com";
  if (lowercaseUrl.includes("tripadvisor.")) return "TripAdvisor";
  if (lowercaseUrl.includes("homeaway.")) return "HomeAway";
  if (lowercaseUrl.includes("vacasa.com")) return "Vacasa";
  if (lowercaseUrl.includes("agoda.")) return "Agoda";
  if (lowercaseUrl.includes("hometogo.")) return "HomeToGo";
  if (lowercaseUrl.includes("holidu.")) return "Holidu";
  if (lowercaseUrl.includes("holidaycheck.")) return "HolidayCheck";
  if (lowercaseUrl.includes("hrs.")) return "HRS";
  if (lowercaseUrl.includes("hostelworld.")) return "Hostelworld";
  if (lowercaseUrl.includes("interhome.")) return "Interhome";
  if (lowercaseUrl.includes("flipkey.")) return "FlipKey";
  if (lowercaseUrl.includes("atraveo.")) return "Atraveo";
  if (lowercaseUrl.includes("fewo-direkt.")) return "FeWo-direkt";
  if (lowercaseUrl.includes("traum-ferienwohnungen.")) return "Traum-Ferienwohnungen";
  if (lowercaseUrl.includes("casamundo.")) return "Casamundo";
  if (lowercaseUrl.includes("kayak.")) return "Kayak";
  if (lowercaseUrl.includes("trivago.")) return "Trivago";
  if (lowercaseUrl.includes("trip.com")) return "Trip.com";
  if (lowercaseUrl.includes("makemytrip.")) return "MakeMyTrip";
  if (lowercaseUrl.includes("hostel.com")) return "Hostel.com";
  if (lowercaseUrl.includes("priceline.")) return "Priceline";
  if (lowercaseUrl.includes("travelocity.")) return "Travelocity";
  if (lowercaseUrl.includes("orbitz.")) return "Orbitz";
  if (lowercaseUrl.includes("hotwire.")) return "Hotwire";
  if (lowercaseUrl.includes("cheaptickets.")) return "CheapTickets";
  if (lowercaseUrl.includes("hotelstonight.")) return "Hotels Tonight";
  if (lowercaseUrl.includes("getaroom.")) return "GetARoom";
  if (lowercaseUrl.includes("hotel.")) return "Hotel.com";
  
  try {
    const domain = new URL(url).hostname.replace("www.", "");
    const name = domain.split(".")[0];
    return name.charAt(0).toUpperCase() + name.slice(1);
  } catch {
    return "Other Platform";
  }
}

// Expanded booking platform check with all international TLDs
function isBookingPlatform(url: string): boolean {
  const lowercaseUrl = url.toLowerCase();
  const platforms = [
    "vrbo.com", "booking.com", "expedia.", "hotels.com", 
    "tripadvisor.", // covers .com, .ch, .de, .fr, .it, etc.
    "homeaway.", "vacasa.com", "agoda.", "hometogo.", "holidu.",
    "interhome.", "flipkey.", "atraveo.", "holidaycheck.",
    "hrs.", "hostelworld.", "fewo-direkt.", "traum-ferienwohnungen.",
    "casamundo.", "kayak.", "trivago.", "trip.com", "makemytrip.",
    "priceline.", "travelocity.", "orbitz.", "hotwire.", "cheaptickets.",
    "hotelstonight.", "getaroom."
  ];
  return platforms.some(p => lowercaseUrl.includes(p));
}

// Enhanced direct property site detection - more permissive for hotel/guesthouse sites
function isDirectPropertySite(url: string): boolean {
  const lowercaseUrl = url.toLowerCase();
  
  // Exclude major platforms, social media, generic sites, and search engines
  const excludePatterns = [
    "airbnb.", "google.", "facebook.", "instagram.", "twitter.", "pinterest.",
    "youtube.", "wikipedia.", "yelp.", "maps.", "cloudflare.",
    ".gov", ".edu", "amazon.", "ebay.", "craigslist.", "tiktok.",
    "linkedin.", "reddit.", "quora.", "medium.", "tumblr.",
    "serpapi.", "bing.", "yahoo.", "duckduckgo."
  ];
  
  if (excludePatterns.some(p => lowercaseUrl.includes(p))) return false;
  
  // Look for property-related keywords in URL - expanded list
  const propertyKeywords = [
    "villa", "cottage", "cabin", "chalet", "apartment", "flat", "house",
    "rental", "holiday", "vacation", "stay", "lodge", "guest", "bnb",
    "ferienwohnung", "ferienhaus", "gite", "chambre", "pension",
    "hotel", "hostel", "inn", "resort", "maison", "casa", "haus",
    "suite", "room", "accommodation", "zimmer", "unterkunft",
    "guesthouse", "bed-and-breakfast", "b-and-b", "bandb",
    "african", "home", "place", "retreat", "escape", "haven",
    "-hotels-", "hotels-"
  ];
  
  // Check if URL contains property keywords
  if (propertyKeywords.some(k => lowercaseUrl.includes(k))) return true;
  
  // Also accept URLs that look like direct booking sites (short domain with specific path)
  try {
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split('/').filter(Boolean);
    // If it has a short path and the domain doesn't look like a major site
    if (pathParts.length <= 3 && urlObj.hostname.split('.').length <= 3) {
      // Check for booking-related paths
      const bookingPaths = ["book", "reserve", "rates", "availability", "rooms", "contact"];
      if (pathParts.some(p => bookingPaths.some(bp => p.toLowerCase().includes(bp)))) {
        return true;
      }
    }
  } catch {
    // Ignore URL parsing errors
  }
  
  return false;
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

// Extract location info from title/URL
function extractLocationFromTitle(title: string): { city: string | null; country: string | null } {
  // Common location patterns in Airbnb titles
  const locationPatterns = [
    /in\s+([A-Za-z\s]+),\s*([A-Za-z\s]+)$/i,
    /([A-Za-z\s]+),\s*([A-Za-z\s]+)$/,
    /·\s*([A-Za-z\s]+)$/i,
  ];
  
  for (const pattern of locationPatterns) {
    const match = title.match(pattern);
    if (match) {
      return { city: match[1]?.trim() || null, country: match[2]?.trim() || null };
    }
  }
  
  // Try to find city names in the title
  const knownCities = [
    "Cape Town", "Johannesburg", "Durban", "Paris", "London", "Berlin", "Rome",
    "Barcelona", "Madrid", "Amsterdam", "Vienna", "Prague", "Budapest", "Lisbon",
    "Zurich", "Geneva", "Munich", "Frankfurt", "Milan", "Venice", "Florence",
    "Nice", "Marseille", "Lyon", "Hamburg", "Cologne", "Stuttgart", "Salzburg"
  ];
  
  const lowerTitle = title.toLowerCase();
  for (const city of knownCities) {
    if (lowerTitle.includes(city.toLowerCase())) {
      return { city, country: null };
    }
  }
  
  return { city: null, country: null };
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

    // Step 2: Use Google Lens for visual matching (much better than reverse image search)
    if (imageUrls.length > 0) {
      console.log("Step 2: Running Google Lens visual matching...");
      
      // Use only first 3 images for Lens (most distinctive ones)
      const lensImages = imageUrls.slice(0, 3);
      
      for (const imageUrl of lensImages) {
        try {
          console.log("Google Lens searching:", imageUrl.slice(0, 80));
          
          // Use Google Lens engine - MUCH better at finding same place across sites
          const lensResponse = await fetch(
            `https://serpapi.com/search.json?engine=google_lens&url=${encodeURIComponent(imageUrl)}&api_key=${serpApiKey}`
          );
          
          if (!lensResponse.ok) {
            console.log("Lens search failed:", lensResponse.status);
            continue;
          }
          
          const lensData = await lensResponse.json();
          
          // Log what we got
          console.log("Lens results - visual_matches:", lensData.visual_matches?.length || 0,
                      "knowledge_graph:", lensData.knowledge_graph ? "yes" : "no",
                      "text_results:", lensData.text_results?.length || 0);
          
          // Process visual matches - these are the key results
          const visualMatches = lensData.visual_matches || [];
          for (const match of visualMatches) {
            const url = match.link;
            if (!url) continue;
            if (url.toLowerCase().includes("airbnb.") || foundUrls.has(url)) continue;
            
            console.log("Checking visual match:", url.slice(0, 100));
            
            // Check if it's a known booking platform
            if (isBookingPlatform(url)) {
              foundUrls.add(url);
              const resultImages: string[] = [];
              if (match.thumbnail) resultImages.push(match.thumbnail);
              
              alternatives.push({
                platform_name: getPlatformName(url),
                listing_url: url,
                listing_title: match.title || match.source || null,
                price: null,
                confidence_score: 0.95, // Lens matches are very reliable
                image_url: match.thumbnail || null,
                images: resultImages.slice(0, 5),
              });
              console.log("FOUND via Lens on platform:", getPlatformName(url), url.slice(0, 80));
            }
            // Also check for direct property websites
            else if (isDirectPropertySite(url)) {
              foundUrls.add(url);
              const resultImages: string[] = [];
              if (match.thumbnail) resultImages.push(match.thumbnail);
              
              alternatives.push({
                platform_name: getPlatformName(url) + " (Direct)",
                listing_url: url,
                listing_title: match.title || match.source || null,
                price: null,
                confidence_score: 0.90,
                image_url: match.thumbnail || null,
                images: resultImages.slice(0, 5),
              });
              console.log("FOUND direct site via Lens:", url.slice(0, 80));
            }
          }
          
          // Also check knowledge graph for additional context
          if (lensData.knowledge_graph?.source?.link) {
            const kgUrl = lensData.knowledge_graph.source.link;
            if (!kgUrl.toLowerCase().includes("airbnb.") && !foundUrls.has(kgUrl)) {
              if (isBookingPlatform(kgUrl) || isDirectPropertySite(kgUrl)) {
                foundUrls.add(kgUrl);
                alternatives.push({
                  platform_name: getPlatformName(kgUrl),
                  listing_url: kgUrl,
                  listing_title: lensData.knowledge_graph.title || null,
                  price: null,
                  confidence_score: 0.92,
                  image_url: lensData.knowledge_graph.thumbnail || null,
                  images: lensData.knowledge_graph.thumbnail ? [lensData.knowledge_graph.thumbnail] : [],
                });
                console.log("FOUND via Lens knowledge graph:", kgUrl.slice(0, 80));
              }
            }
          }
          
          // Small delay between searches to avoid rate limiting
          await new Promise(r => setTimeout(r, 500));
        } catch (e) {
          console.error("Lens search error:", e);
        }
      }
      
      // If Lens didn't find enough, also try reverse image search as backup
      if (alternatives.length < 3) {
        console.log("Running reverse image search as backup...");
        
        for (const imageUrl of imageUrls.slice(0, 2)) {
          try {
            console.log("Reverse searching:", imageUrl.slice(0, 80));
            
            const reverseResponse = await fetch(
              `https://serpapi.com/search.json?engine=google_reverse_image&image_url=${encodeURIComponent(imageUrl)}&api_key=${serpApiKey}`
            );
            
            if (!reverseResponse.ok) continue;
            
            const reverseData = await reverseResponse.json();
            console.log("Reverse results - image:", reverseData.image_results?.length || 0);
            
            const allResults = [
              ...(reverseData.image_results || []),
              ...(reverseData.inline_images || []),
              ...(reverseData.organic_results || []),
            ];
            
            for (const result of allResults) {
              const url = result.link || result.source;
              if (!url) continue;
              if (url.toLowerCase().includes("airbnb.") || foundUrls.has(url)) continue;
              
              if (isBookingPlatform(url) || isDirectPropertySite(url)) {
                foundUrls.add(url);
                alternatives.push({
                  platform_name: isBookingPlatform(url) ? getPlatformName(url) : getPlatformName(url) + " (Direct)",
                  listing_url: url,
                  listing_title: result.title || result.snippet || null,
                  price: null,
                  confidence_score: isBookingPlatform(url) ? 0.85 : 0.80,
                  image_url: result.thumbnail || result.original || null,
                  images: [result.thumbnail, result.original].filter(Boolean).slice(0, 5),
                });
                console.log("FOUND via reverse image:", url.slice(0, 80));
              }
            }
            
            await new Promise(r => setTimeout(r, 300));
          } catch (e) {
            console.error("Reverse search error:", e);
          }
        }
      }
    }

    // Update status to step 3
    await supabase.from("searches").update({ 
      status: "comparing_prices" 
    }).eq("id", searchId);

    // Step 3: Multi-strategy text search if we still need more results
    if (alternatives.length < 5) {
      console.log("Step 3: Multi-strategy text search...");
      
      // Extract location info for better searches
      const location = extractLocationFromTitle(airbnbTitle);
      console.log("Extracted location:", location);
      
      // Clean up the title for searches
      const cleanTitle = airbnbTitle
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      
      // Multiple search strategies
      const searchStrategies = [
        // Strategy 1: Exact property name + booking sites
        `"${cleanTitle.slice(0, 40)}" (booking.com OR tripadvisor OR holidaycheck OR agoda) -airbnb`,
        // Strategy 2: Property name + location if available
        location.city ? `"${cleanTitle.slice(0, 30)}" ${location.city} hotel guesthouse -airbnb` : null,
        // Strategy 3: Broader search with just key terms
        `${cleanTitle.slice(0, 25)} ${location.city || ''} vacation rental booking -airbnb -pinterest`,
        // Strategy 4: Direct site search for the property
        location.city ? `${cleanTitle.slice(0, 20)} ${location.city} site:booking.com OR site:tripadvisor.com OR site:holidaycheck.de` : null,
      ].filter(Boolean) as string[];
      
      for (const searchQuery of searchStrategies) {
        if (alternatives.length >= 8) break; // Stop if we have enough
        
        console.log("Text search:", searchQuery);
        
        try {
          const textResponse = await fetch(
            `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(searchQuery)}&api_key=${serpApiKey}&num=20`
          );
          
          if (!textResponse.ok) continue;
          
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
                confidence_score: 0.65,
                image_url: result.thumbnail || null,
                images: result.thumbnail ? [result.thumbnail] : [],
              });
              console.log("Text match found:", getPlatformName(url));
            } else if (isDirectPropertySite(url)) {
              foundUrls.add(url);
              alternatives.push({
                platform_name: getPlatformName(url) + " (Direct)",
                listing_url: url,
                listing_title: result.title || null,
                price: null,
                confidence_score: 0.60,
                image_url: result.thumbnail || null,
                images: result.thumbnail ? [result.thumbnail] : [],
              });
              console.log("Direct site text match:", url.slice(0, 80));
            }
          }
          
          await new Promise(r => setTimeout(r, 300));
        } catch (e) {
          console.error("Text search error:", e);
        }
      }
    }

    console.log(`Total alternatives found: ${alternatives.length}`);

    // Sort by confidence and limit results
    alternatives.sort((a, b) => b.confidence_score - a.confidence_score);
    const topAlternatives = alternatives.slice(0, 10);

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
