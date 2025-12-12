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
  confidence_score: number | null; // null for text-only matches (no visual confirmation)
  image_url: string | null;
  images: string[];
  match_type: 'visual' | 'text'; // Track how match was found
  total_price?: number | null;
  per_night_rate?: number | null;
  source_airbnb_image?: string | null; // The Airbnb image that was used for this match
}

// Use Lovable AI to extract Airbnb price from scraped content
async function extractAirbnbPriceWithAI(content: string, nights: number): Promise<number | null> {
  const lovableApiKey = Deno.env.get("LOVABLE_API_KEY");
  if (!lovableApiKey) {
    console.log("LOVABLE_API_KEY not available for AI price extraction");
    return null;
  }
  
  try {
    const prompt = `Extract the nightly price from this Airbnb listing content. Look for the price per night (not total).
    
Content:
${content.slice(0, 8000)}

Return ONLY a single number representing the price per night in the listing's currency (e.g., "125" for €125/night). 
If you cannot find a clear nightly price, return "null".
Do not include currency symbols or units - just the number.`;

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${lovableApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "user", content: prompt }
        ],
        max_tokens: 50,
      }),
    });
    
    if (!response.ok) {
      console.error("Lovable AI request failed:", response.status);
      return null;
    }
    
    const data = await response.json();
    const priceText = data.choices?.[0]?.message?.content?.trim();
    
    if (!priceText || priceText.toLowerCase() === "null") {
      console.log("AI could not extract price");
      return null;
    }
    
    // Parse the price
    const price = parseFloat(priceText.replace(/[^0-9.]/g, ''));
    if (isNaN(price) || price < 10 || price > 5000) {
      console.log("AI returned invalid price:", priceText);
      return null;
    }
    
    console.log("AI extracted price:", price, "per night");
    return price;
  } catch (error) {
    console.error("AI price extraction error:", error);
    return null;
  }
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

// Expanded booking platform check with all international TLDs - comprehensive list
function isBookingPlatform(url: string): boolean {
  const lowercaseUrl = url.toLowerCase();
  const platforms = [
    // Major global platforms
    "vrbo.com", "booking.com", "expedia.", "hotels.com", 
    "tripadvisor.", // covers .com, .ch, .de, .fr, .it, .co.za, etc.
    "homeaway.", "vacasa.com", "agoda.", "hometogo.", "holidu.",
    // European platforms
    "interhome.", "flipkey.", "atraveo.", "holidaycheck.", 
    "hrs.", "hrs.com", "hrs.de", // HRS variations
    "hostelworld.", "fewo-direkt.", "traum-ferienwohnungen.",
    "casamundo.", "kayak.", "trivago.", "trip.com", "makemytrip.",
    "priceline.", "travelocity.", "orbitz.", "hotwire.", "cheaptickets.",
    "hotelstonight.", "getaroom.",
    // Additional international platforms
    "hotel.de", "hotel.info", "hotel-mix.",
    "easyjet.com/en/hotels", "lastminute.",
    "laterooms.", "opodo.", "edreams.", "destinia.",
    "centraldereservas.", "logitravel.",
    // Regional South Africa platforms
    "safarinow.", "lekkeslaap.", "nightsbridge.",
    "sa-venues.", "wheretostay.", "travelground.",
    // Metasearch that show direct links
    "skyscanner.", "momondo.", "cheapflights.",
    // Direct hotel booking aggregators
    "-hotels-", "hotels-", // Pattern for regional hotel sites like "capetown-hotels-za.com"
  ];
  return platforms.some(p => lowercaseUrl.includes(p));
}

// Additional check for regional hotel booking domains (like maison-b.capetown-hotels-za.com)
function isRegionalHotelSite(url: string): boolean {
  const lowercaseUrl = url.toLowerCase();
  // Pattern: property-name.location-hotels-countrycode.com
  const hotelDomainPattern = /[a-z0-9-]+\.[a-z]+-hotels-[a-z]{2}\.com/;
  if (hotelDomainPattern.test(lowercaseUrl)) return true;
  
  // Other regional booking patterns
  const regionalPatterns = [
    /[a-z]+\.hotels-[a-z]+\.com/,
    /book[a-z]*\.[a-z]+\.com/,
    /reserve\.[a-z]+\.com/,
  ];
  return regionalPatterns.some(p => p.test(lowercaseUrl));
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

// Calculate nights between dates
function calculateNights(checkIn: string, checkOut: string): number {
  const start = new Date(checkIn);
  const end = new Date(checkOut);
  const diffTime = Math.abs(end.getTime() - start.getTime());
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

// Format dates for different platforms
function formatDateForPlatform(date: string, platform: string): string {
  const d = new Date(date);
  // Most platforms use YYYY-MM-DD
  return d.toISOString().split('T')[0];
}

// Add date parameters to a URL for a given platform
function addDatesToUrl(url: string, checkIn: string, checkOut: string): string {
  try {
    const urlObj = new URL(url);
    const lowercaseUrl = url.toLowerCase();
    
    // Platform-specific date parameter names
    if (lowercaseUrl.includes("booking.com")) {
      urlObj.searchParams.set('checkin', checkIn);
      urlObj.searchParams.set('checkout', checkOut);
    } else if (lowercaseUrl.includes("vrbo.com") || lowercaseUrl.includes("homeaway.")) {
      urlObj.searchParams.set('arrival', checkIn);
      urlObj.searchParams.set('departure', checkOut);
    } else if (lowercaseUrl.includes("expedia.")) {
      urlObj.searchParams.set('chkin', checkIn);
      urlObj.searchParams.set('chkout', checkOut);
    } else if (lowercaseUrl.includes("hotels.com")) {
      urlObj.searchParams.set('checkIn', checkIn);
      urlObj.searchParams.set('checkOut', checkOut);
    } else if (lowercaseUrl.includes("agoda.")) {
      urlObj.searchParams.set('checkIn', checkIn);
      urlObj.searchParams.set('checkOut', checkOut);
    } else if (lowercaseUrl.includes("tripadvisor.")) {
      // TripAdvisor uses different format
      urlObj.searchParams.set('checkin', checkIn);
      urlObj.searchParams.set('checkout', checkOut);
    } else if (lowercaseUrl.includes("holidaycheck.")) {
      urlObj.searchParams.set('checkin', checkIn);
      urlObj.searchParams.set('checkout', checkOut);
    } else {
      // Generic - try common parameter names
      urlObj.searchParams.set('checkin', checkIn);
      urlObj.searchParams.set('checkout', checkOut);
    }
    
    return urlObj.toString();
  } catch {
    return url;
  }
}

// Scrape price from a listing page using Firecrawl
async function scrapePriceFromListing(url: string, checkIn: string, checkOut: string, firecrawlApiKey: string): Promise<{ price: number | null; totalPrice: number | null; perNightRate: number | null }> {
  try {
    // Add dates to URL for price lookup
    const urlWithDates = addDatesToUrl(url, checkIn, checkOut);
    console.log("Scraping price from:", urlWithDates.slice(0, 100));
    
    const response = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${firecrawlApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: urlWithDates,
        formats: ['markdown'],
        onlyMainContent: true,
        waitFor: 3000, // Wait for dynamic content
      }),
    });
    
    if (!response.ok) {
      console.log("Firecrawl request failed:", response.status);
      return { price: null, totalPrice: null, perNightRate: null };
    }
    
    const data = await response.json();
    const content = data.data?.markdown || data.markdown || '';
    
    if (!content) {
      console.log("No content from Firecrawl");
      return { price: null, totalPrice: null, perNightRate: null };
    }
    
    // Extract price patterns from the content
    const pricePatterns = [
      // Total price patterns
      /total[:\s]*[\$€£CHF]\s*(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/i,
      /[\$€£CHF]\s*(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)\s*total/i,
      // Per night patterns
      /[\$€£CHF]\s*(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)\s*(?:per night|\/night|night)/i,
      /(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)\s*[\$€£CHF]?\s*(?:per night|\/night)/i,
      // Generic price pattern
      /price[:\s]*[\$€£CHF]?\s*(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/i,
      /[\$€£CHF]\s*(\d{1,3}(?:,\d{3})*)/,
    ];
    
    let extractedPrice: number | null = null;
    let isPerNight = false;
    
    for (const pattern of pricePatterns) {
      const match = content.match(pattern);
      if (match) {
        const priceStr = match[1].replace(/,/g, '');
        extractedPrice = parseFloat(priceStr);
        
        // Check if this is a per-night price
        if (pattern.toString().includes('night')) {
          isPerNight = true;
        }
        
        if (extractedPrice && extractedPrice > 0 && extractedPrice < 50000) {
          console.log("Extracted price:", extractedPrice, isPerNight ? "(per night)" : "(total)");
          break;
        }
      }
    }
    
    if (!extractedPrice) {
      return { price: null, totalPrice: null, perNightRate: null };
    }
    
    const nights = calculateNights(checkIn, checkOut);
    
    if (isPerNight) {
      return {
        price: extractedPrice,
        totalPrice: extractedPrice * nights,
        perNightRate: extractedPrice,
      };
    } else {
      return {
        price: Math.round(extractedPrice / nights),
        totalPrice: extractedPrice,
        perNightRate: Math.round(extractedPrice / nights),
      };
    }
  } catch (error) {
    console.error("Price scraping error:", error);
    return { price: null, totalPrice: null, perNightRate: null };
  }
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
    const firecrawlApiKey = Deno.env.get("FIRECRAWL_API_KEY");

    if (!serpApiKey) {
      return new Response(
        JSON.stringify({ error: "Search service temporarily unavailable" }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    
    console.log("Firecrawl API available:", !!firecrawlApiKey);

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

    // Step 1: Fetch Airbnb page and extract property data using Firecrawl for JS rendering
    console.log("Step 1: Extracting property data from Airbnb...");
    
    let imageUrls: string[] = [];
    
    // Use Firecrawl if available (handles JS-rendered content like prices)
    if (firecrawlApiKey) {
      console.log("Using Firecrawl to scrape Airbnb (with JS rendering)...");
      try {
        const firecrawlResponse = await fetch('https://api.firecrawl.dev/v1/scrape', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${firecrawlApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            url: search.airbnb_url,
            formats: ['markdown', 'html'],
            onlyMainContent: false,
            waitFor: 5000, // Wait for dynamic price content to load
          }),
        });
        
        if (firecrawlResponse.ok) {
          const firecrawlData = await firecrawlResponse.json();
          const markdown = firecrawlData.data?.markdown || '';
          const html = firecrawlData.data?.html || '';
          const rawHtml = firecrawlData.data?.rawHtml || html;
          
          console.log("Firecrawl response - markdown length:", markdown.length, "html length:", html.length);
          
          // Extract title from metadata or content
          const metaTitle = firecrawlData.data?.metadata?.title;
          if (metaTitle) {
            airbnbTitle = metaTitle
              .replace(" - Airbnb", "")
              .replace(" · Airbnb", "")
              .replace(/\s*-\s*(Houses|Apartments|Homes|Villas|Cabins|Cottages|Condos)?\s*(for Rent|to Rent|zur Miete|in)?\s*.*$/i, "")
              .trim();
            console.log("Extracted title from metadata:", airbnbTitle);
          }
          
          // Extract price from Firecrawl content - multiple patterns for different currencies
          const pricePatterns = [
            // Total price patterns (most reliable)
            /total[:\s]*€\s*(\d{1,5}(?:,\d{3})*)/i,
            /total[:\s]*\$\s*(\d{1,5}(?:,\d{3})*)/i,
            /total[:\s]*CHF\s*(\d{1,5}(?:,\d{3})*)/i,
            /gesamt[:\s]*€\s*(\d{1,5}(?:,\d{3})*)/i,
            // Per night patterns
            /€\s*(\d{1,5}(?:,\d{3})*)\s*(?:per night|\/night|night|pro nacht)/i,
            /\$\s*(\d{1,5}(?:,\d{3})*)\s*(?:per night|\/night|night)/i,
            /CHF\s*(\d{1,5}(?:,\d{3})*)\s*(?:per night|\/night|night|pro nacht)/i,
            // Generic price patterns
            /€(\d{1,5}(?:,\d{3})*)\s*x\s*\d+\s*nights?/i,
            /\$(\d{1,5}(?:,\d{3})*)\s*x\s*\d+\s*nights?/i,
            // Fallback: any price-like number after currency
            /€\s*(\d{2,4})/,
            /\$\s*(\d{2,4})/,
            /CHF\s*(\d{2,4})/,
          ];
          
          // Try markdown first (cleaner), then HTML
          const contentToSearch = markdown + ' ' + html;
          
          for (const pattern of pricePatterns) {
            const priceMatch = contentToSearch.match(pattern);
            if (priceMatch) {
              const priceStr = priceMatch[1].replace(/,/g, '');
              const extractedPrice = parseInt(priceStr);
              // Validate price is reasonable (between 10 and 5000 per night)
              if (extractedPrice >= 10 && extractedPrice <= 5000) {
                airbnbPrice = extractedPrice;
                console.log("Extracted Airbnb price from Firecrawl:", airbnbPrice);
                break;
              }
            }
          }
          
          // Extract images from HTML content
          const imagePatterns = [
            /https:\/\/a0\.muscache\.com\/im\/pictures\/hosting\/Hosting-[^"'\s\)]+/gi,
            /https:\/\/a0\.muscache\.com\/im\/pictures\/miso\/[^"'\s\)]+/gi,
            /https:\/\/a0\.muscache\.com\/im\/pictures\/BnbProperty\/[^"'\s\)]+/gi,
            /https:\/\/a0\.muscache\.com\/im\/pictures\/prohost-api\/[^"'\s\)]+/gi,
            /https:\/\/a0\.muscache\.com\/im\/pictures\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(?:jpg|jpeg|png|webp)/gi,
          ];
          
          let allImageUrls: string[] = [];
          const htmlContent = rawHtml || html;
          
          for (const pattern of imagePatterns) {
            const matches = htmlContent.match(pattern) || [];
            allImageUrls.push(...matches);
          }
          
          // Also check markdown for image URLs
          const markdownImageMatches = markdown.match(/https:\/\/a0\.muscache\.com\/im\/pictures\/[^\s\)"\]]+/gi) || [];
          allImageUrls.push(...markdownImageMatches);
          
          imageUrls = [...new Set(allImageUrls)]
            .map(url => url.replace(/\\u002F/g, '/').replace(/\\/g, ''))
            .filter(isValidPropertyImage)
            .slice(0, 5);
          
          console.log(`Firecrawl found ${imageUrls.length} property images`);
        } else {
          console.log("Firecrawl request failed:", firecrawlResponse.status);
        }
      } catch (e) {
        console.error("Firecrawl error:", e);
      }
    }
    
    // Fallback: direct fetch if Firecrawl didn't work
    if (imageUrls.length === 0 || !airbnbPrice) {
      console.log("Fallback: Direct fetch for Airbnb page...");
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
          console.log("Fetched Airbnb page directly, length:", html.length);
          
          // Extract title if not already set
          if (!airbnbTitle || airbnbTitle === "Vacation Rental") {
            const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
            if (titleMatch) {
              airbnbTitle = titleMatch[1]
                .replace(" - Airbnb", "")
                .replace(" · Airbnb", "")
                .replace(/\s*-\s*(Houses|Apartments|Homes|Villas|Cabins|Cottages|Condos)?\s*(for Rent|to Rent|zur Miete|in)?\s*.*$/i, "")
                .trim();
            }
          }
          
          // Extract images if not already found
          if (imageUrls.length === 0) {
            const imagePatterns = [
              /https:\/\/a0\.muscache\.com\/im\/pictures\/hosting\/Hosting-[^"'\s\)]+/gi,
              /https:\/\/a0\.muscache\.com\/im\/pictures\/miso\/[^"'\s\)]+/gi,
              /https:\/\/a0\.muscache\.com\/im\/pictures\/BnbProperty\/[^"'\s\)]+/gi,
              /https:\/\/a0\.muscache\.com\/im\/pictures\/prohost-api\/[^"'\s\)]+/gi,
              /https:\/\/a0\.muscache\.com\/im\/pictures\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(?:jpg|jpeg|png|webp)/gi,
            ];
            
            let allImageUrls: string[] = [];
            
            for (const pattern of imagePatterns) {
              const matches = html.match(pattern) || [];
              allImageUrls.push(...matches);
            }
            
            const jsonMatches = html.match(/"pictureUrl"\s*:\s*"([^"]+)"/g) || [];
            for (const match of jsonMatches) {
              const urlMatch = match.match(/"pictureUrl"\s*:\s*"([^"]+)"/);
              if (urlMatch && urlMatch[1]) {
                allImageUrls.push(urlMatch[1].replace(/\\u002F/g, '/'));
              }
            }
            
            imageUrls = [...new Set(allImageUrls)]
              .map(url => url.replace(/\\u002F/g, '/').replace(/\\/g, ''))
              .filter(isValidPropertyImage)
              .slice(0, 5);
          }
          
          // Try to extract price from JSON data if not already found
          if (!airbnbPrice) {
            const pricePatterns = [
              /"priceString"\s*:\s*"[€$CHF]\s*(\d+)"/,
              /"price"\s*:\s*(\d+)/,
              /"basePrice"\s*:\s*(\d+)/,
              /"priceForDisplay"\s*:\s*"[€$CHF]?\s*(\d+)/,
            ];
            
            for (const pattern of pricePatterns) {
              const priceMatch = html.match(pattern);
              if (priceMatch) {
                const price = parseInt(priceMatch[1]);
                if (price >= 10 && price <= 5000) {
                  airbnbPrice = price;
                  console.log("Extracted price from direct fetch:", airbnbPrice);
                  break;
                }
              }
            }
          }
          
          console.log(`Direct fetch found ${imageUrls.length} images, price: ${airbnbPrice}`);
        }
      } catch (e) {
        console.error("Error fetching Airbnb page directly:", e);
      }
    }
    
    // CRITICAL: If we still don't have a price, try AI extraction as last resort
    if (!airbnbPrice) {
      console.log("Attempting AI-based price extraction...");
      
      // Try to get content for AI extraction
      let contentForAI = "";
      if (firecrawlApiKey) {
        try {
          const aiScrapeResponse = await fetch('https://api.firecrawl.dev/v1/scrape', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${firecrawlApiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              url: search.airbnb_url,
              formats: ['markdown'],
              onlyMainContent: true,
              waitFor: 5000,
            }),
          });
          
          if (aiScrapeResponse.ok) {
            const aiData = await aiScrapeResponse.json();
            contentForAI = aiData.data?.markdown || '';
          }
        } catch (e) {
          console.error("Error fetching content for AI:", e);
        }
      }
      
      if (contentForAI) {
        const nights = calculateNights(checkIn, checkOut);
        airbnbPrice = await extractAirbnbPriceWithAI(contentForAI, nights);
      }
    }
    
    // Log final price status and abort comparison if missing
    if (!airbnbPrice) {
      console.warn("FATAL: Could not extract Airbnb price - aborting comparison");
      const airbnbImageUrl = imageUrls.length > 0 ? imageUrls[0] : null;
      const airbnbImages = imageUrls.slice(0, 5);
      const nights = calculateNights(checkIn, checkOut);

      await supabase.from("searches").update({
        status: "price_unavailable",
        airbnb_title: airbnbTitle,
        airbnb_price: null,
        airbnb_image_url: airbnbImageUrl,
        airbnb_images: airbnbImages,
        check_in_date: checkIn,
        check_out_date: checkOut,
        nights_count: nights,
      }).eq("id", searchId);

      return new Response(
        JSON.stringify({
          success: false,
          error: "AIRBNB_PRICE_UNAVAILABLE",
          message: "Could not extract Airbnb price for the selected dates, so we cannot compare alternatives.",
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    } else {
      console.log("SUCCESS: Airbnb price extracted:", airbnbPrice, "per night");
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
          
          // Process visual matches - these are the key results with VISUAL CONFIRMATION
          const visualMatches = lensData.visual_matches || [];
          for (const match of visualMatches) {
            const url = match.link;
            if (!url) continue;
            if (url.toLowerCase().includes("airbnb.") || foundUrls.has(url)) continue;
            
            console.log("Checking visual match:", url.slice(0, 100));
            
            // Calculate confidence based on match position (earlier = more confident)
            const matchIndex = visualMatches.indexOf(match);
            const baseConfidence = Math.max(0.70, 0.98 - (matchIndex * 0.03)); // 98% for first, decreasing
            
            // Check if it's a known booking platform OR regional hotel site
            if (isBookingPlatform(url) || isRegionalHotelSite(url)) {
              foundUrls.add(url);
              const resultImages: string[] = [];
              if (match.thumbnail) resultImages.push(match.thumbnail);
              
              alternatives.push({
                platform_name: getPlatformName(url),
                listing_url: url,
                listing_title: match.title || match.source || null,
                price: null,
                confidence_score: baseConfidence, // Visual match confidence based on position
                image_url: match.thumbnail || null,
                images: resultImages.slice(0, 5),
                match_type: 'visual',
                source_airbnb_image: imageUrl, // Store the Airbnb image that matched
              });
              console.log("FOUND via Lens on platform:", getPlatformName(url), "confidence:", baseConfidence.toFixed(2), url.slice(0, 80));
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
                confidence_score: Math.max(0.65, baseConfidence - 0.05), // Slightly lower for direct sites
                image_url: match.thumbnail || null,
                images: resultImages.slice(0, 5),
                match_type: 'visual',
                source_airbnb_image: imageUrl, // Store the Airbnb image that matched
              });
              console.log("FOUND direct site via Lens:", url.slice(0, 80));
            }
          }
          
          // Also check knowledge graph for additional context - high confidence visual match
          if (lensData.knowledge_graph?.source?.link) {
            const kgUrl = lensData.knowledge_graph.source.link;
            if (!kgUrl.toLowerCase().includes("airbnb.") && !foundUrls.has(kgUrl)) {
              if (isBookingPlatform(kgUrl) || isDirectPropertySite(kgUrl) || isRegionalHotelSite(kgUrl)) {
                foundUrls.add(kgUrl);
                alternatives.push({
                  platform_name: getPlatformName(kgUrl),
                  listing_url: kgUrl,
                  listing_title: lensData.knowledge_graph.title || null,
                  price: null,
                  confidence_score: 0.95, // Knowledge graph = very high confidence visual match
                  image_url: lensData.knowledge_graph.thumbnail || null,
                  images: lensData.knowledge_graph.thumbnail ? [lensData.knowledge_graph.thumbnail] : [],
                  match_type: 'visual',
                  source_airbnb_image: imageUrl, // Store the Airbnb image that matched
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
              
              if (isBookingPlatform(url) || isDirectPropertySite(url) || isRegionalHotelSite(url)) {
                foundUrls.add(url);
                alternatives.push({
                  platform_name: isBookingPlatform(url) || isRegionalHotelSite(url) ? getPlatformName(url) : getPlatformName(url) + " (Direct)",
                  listing_url: url,
                  listing_title: result.title || result.snippet || null,
                  price: null,
                  confidence_score: 0.85, // Reverse image = visual confirmation
                  image_url: result.thumbnail || result.original || null,
                  images: [result.thumbnail, result.original].filter(Boolean).slice(0, 5),
                  match_type: 'visual',
                  source_airbnb_image: imageUrl, // Store the Airbnb image that matched
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
      
      // Multiple search strategies - expanded for better coverage
      const searchStrategies = [
        // Strategy 1: Exact property name + booking sites (including HolidayCheck explicitly)
        `"${cleanTitle.slice(0, 40)}" (booking.com OR tripadvisor OR holidaycheck OR agoda OR hrs) -airbnb`,
        // Strategy 2: Property name + location with broader hotel/guesthouse terms
        location.city ? `"${cleanTitle.slice(0, 30)}" ${location.city} (hotel OR guesthouse OR pension) -airbnb` : null,
        // Strategy 3: Site-specific searches for key platforms
        `${cleanTitle.slice(0, 30)} site:holidaycheck.de OR site:holidaycheck.com`,
        `${cleanTitle.slice(0, 30)} site:tripadvisor.com OR site:tripadvisor.ch OR site:tripadvisor.de`,
        // Strategy 4: Location + property type for regional sites
        location.city ? `${location.city} "${cleanTitle.slice(0, 25)}" (reviews OR booking) -airbnb -pinterest` : null,
        // Strategy 5: Direct site search across multiple platforms
        location.city ? `${cleanTitle.slice(0, 20)} ${location.city} site:booking.com OR site:hrs.de OR site:hotel.de` : null,
      ].filter(Boolean) as string[];
      
      for (const searchQuery of searchStrategies) {
        if (alternatives.length >= 10) break; // Stop if we have enough
        
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
            
            if (isBookingPlatform(url) || isRegionalHotelSite(url)) {
              foundUrls.add(url);
              alternatives.push({
                platform_name: getPlatformName(url),
                listing_url: url,
                listing_title: result.title || null,
                price: null,
                confidence_score: null, // TEXT MATCH = NO VISUAL CONFIRMATION = NO TRUST SCORE
                image_url: result.thumbnail || null,
                images: result.thumbnail ? [result.thumbnail] : [],
                match_type: 'text',
              });
              console.log("Text match found (no visual confirmation):", getPlatformName(url));
            } else if (isDirectPropertySite(url)) {
              foundUrls.add(url);
              alternatives.push({
                platform_name: getPlatformName(url) + " (Direct)",
                listing_url: url,
                listing_title: result.title || null,
                price: null,
                confidence_score: null, // TEXT MATCH = NO VISUAL CONFIRMATION = NO TRUST SCORE
                image_url: result.thumbnail || null,
                images: result.thumbnail ? [result.thumbnail] : [],
                match_type: 'text',
              });
              console.log("Direct site text match (no visual confirmation):", url.slice(0, 80));
            }
          }
          
          await new Promise(r => setTimeout(r, 300));
        } catch (e) {
          console.error("Text search error:", e);
        }
      }
    }

    console.log(`Total alternatives found: ${alternatives.length}`);

    // Sort by confidence (visual matches first, then by score) and limit results
    // Visual matches with high confidence come first, text matches (null confidence) come last
    alternatives.sort((a, b) => {
      // Visual matches always before text matches
      if (a.match_type === 'visual' && b.match_type === 'text') return -1;
      if (a.match_type === 'text' && b.match_type === 'visual') return 1;
      // Within same type, sort by confidence (null = lowest)
      const scoreA = a.confidence_score ?? 0;
      const scoreB = b.confidence_score ?? 0;
      return scoreB - scoreA;
    });
    const topAlternatives = alternatives.slice(0, 10);

    // Use filtered property images (no logos)
    const airbnbImageUrl = imageUrls.length > 0 ? imageUrls[0] : null;
    const airbnbImages = imageUrls.slice(0, 5);

    console.log("Results breakdown - Visual matches:", alternatives.filter(a => a.match_type === 'visual').length,
                "Text matches:", alternatives.filter(a => a.match_type === 'text').length);

    // Calculate nights for price comparison
    const nights = calculateNights(checkIn, checkOut);
    console.log(`Comparing prices for ${nights} nights: ${checkIn} to ${checkOut}`);

    // Step 4: Scrape prices from alternatives using Firecrawl (if available)
    let resultsWithPrices = topAlternatives;
    
    if (firecrawlApiKey && topAlternatives.length > 0) {
      console.log("Step 4: Scraping prices from alternatives...");
      
      // Scrape up to 5 top results for pricing (to avoid rate limits)
      const priceScrapePromises = topAlternatives.slice(0, 5).map(async (alt) => {
        const priceData = await scrapePriceFromListing(alt.listing_url, checkIn, checkOut, firecrawlApiKey);
        return {
          ...alt,
          price: priceData.perNightRate,
          total_price: priceData.totalPrice,
          per_night_rate: priceData.perNightRate,
        };
      });
      
      const pricedResults = await Promise.all(priceScrapePromises);
      
      // Merge priced results with remaining unpriced ones
      resultsWithPrices = [
        ...pricedResults,
        ...topAlternatives.slice(5),
      ];
      
      console.log("Price scraping complete. Results with prices:", pricedResults.filter(r => r.price).length);
    }

    // Calculate savings based on Airbnb price
    const resultsWithSavings = resultsWithPrices.map(alt => {
      let savingsAmount: number | null = null;
      let savingsPercentage: number | null = null;
      
      if (airbnbPrice && alt.price && alt.price < airbnbPrice) {
        savingsAmount = airbnbPrice - alt.price;
        savingsPercentage = Math.round((savingsAmount / airbnbPrice) * 100);
      }
      
      return {
        ...alt,
        original_price: airbnbPrice,
        savings_amount: savingsAmount,
        savings_percentage: savingsPercentage,
      };
    });

    // Sort by savings (best deals first), then by confidence
    resultsWithSavings.sort((a, b) => {
      // First, prioritize results with actual savings
      const savingsA = a.savings_percentage ?? 0;
      const savingsB = b.savings_percentage ?? 0;
      if (savingsA !== savingsB) return savingsB - savingsA;
      
      // Then by match type (visual first)
      if (a.match_type === 'visual' && b.match_type === 'text') return -1;
      if (a.match_type === 'text' && b.match_type === 'visual') return 1;
      
      // Finally by confidence
      const scoreA = a.confidence_score ?? 0;
      const scoreB = b.confidence_score ?? 0;
      return scoreB - scoreA;
    });

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
          match_type: r.match_type,
          source_airbnb_image: r.source_airbnb_image || null,
        }))
      );
    }

    await supabase.from("searches").update({ 
      status: "completed",
      airbnb_title: airbnbTitle,
      airbnb_price: airbnbPrice,
      airbnb_image_url: airbnbImageUrl,
      airbnb_images: airbnbImages,
      check_in_date: checkIn,
      check_out_date: checkOut,
      nights_count: nights,
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
        dates: { checkIn, checkOut, nights }
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
