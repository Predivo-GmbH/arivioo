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

// Use Lovable AI to compare two images and return similarity score (0-100)
async function compareImagesWithAI(
  airbnbImageUrl: string, 
  alternativeImageUrl: string
): Promise<{ score: number; isMatch: boolean; explanation: string }> {
  const lovableApiKey = Deno.env.get("LOVABLE_API_KEY");
  if (!lovableApiKey) {
    console.log("LOVABLE_API_KEY not available for AI image comparison");
    return { score: 0, isMatch: false, explanation: "AI comparison unavailable" };
  }
  
  try {
    const prompt = `You are an expert at comparing property photos to determine if they show the SAME physical property (room, house, apartment).

Compare these two property images and determine if they show the SAME property:

Image 1 (Airbnb): ${airbnbImageUrl}
Image 2 (Alternative): ${alternativeImageUrl}

Analyze:
1. Room layout and structure (walls, windows, doors, ceiling height)
2. Furniture placement and style (beds, sofas, tables, chairs)
3. Distinctive features (fireplaces, artwork, light fixtures, architectural details)
4. View from windows (if visible)
5. Floor type and pattern
6. Color scheme and decor elements

IMPORTANT RULES:
- Focus on STRUCTURAL elements that don't change (layout, windows, built-in features)
- Furniture position may vary slightly between photos
- Lighting and angle may differ
- Ignore watermarks, logos, or text overlays
- Return a CONSERVATIVE score - only high scores if you're certain it's the same place

Return a JSON response ONLY in this exact format:
{"score": NUMBER_0_TO_100, "isMatch": BOOLEAN, "explanation": "Brief reason"}

Where:
- score: 0-100 (100 = definitely same property, 0 = definitely different)
- isMatch: true only if score >= 90
- explanation: 1-2 sentence reason for your assessment`;

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${lovableApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { 
            role: "user", 
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: airbnbImageUrl } },
              { type: "image_url", image_url: { url: alternativeImageUrl } }
            ]
          }
        ],
        max_tokens: 200,
      }),
    });
    
    if (!response.ok) {
      console.error("Lovable AI image comparison failed:", response.status);
      return { score: 0, isMatch: false, explanation: "AI comparison request failed" };
    }
    
    const data = await response.json();
    const resultText = data.choices?.[0]?.message?.content?.trim();
    
    if (!resultText) {
      console.log("AI returned empty response for image comparison");
      return { score: 0, isMatch: false, explanation: "Empty AI response" };
    }
    
    // Parse JSON response
    try {
      // Extract JSON from response (may have markdown formatting)
      const jsonMatch = resultText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        const score = Number(parsed.score) || 0;
        return {
          score: Math.min(100, Math.max(0, score)),
          isMatch: score >= 90,
          explanation: parsed.explanation || "No explanation provided"
        };
      }
    } catch (parseError) {
      console.error("Failed to parse AI comparison response:", resultText);
    }
    
    return { score: 0, isMatch: false, explanation: "Failed to parse AI response" };
  } catch (error) {
    console.error("AI image comparison error:", error);
    return { score: 0, isMatch: false, explanation: "Comparison error" };
  }
}

// Use Lovable AI to extract Airbnb price from scraped content
async function extractAirbnbPriceWithAI(content: string, nights: number): Promise<number | null> {
  const lovableApiKey = Deno.env.get("LOVABLE_API_KEY");
  if (!lovableApiKey) {
    console.log("LOVABLE_API_KEY not available for AI price extraction");
    return null;
  }
  
  try {
    const prompt = `You are analyzing text scraped from an Airbnb listing page.
The stay is for exactly ${nights} night(s).

From the content below, determine the actual price PER NIGHT for the selected stay.

Rules:
- If the page directly shows a per-night amount (e.g. "€176 per night" or "176 CHF/night"), use that.
- If only a total price for the entire stay is shown (e.g. "Total before taxes: €352" for ${nights} nights), compute the per-night price by dividing the total by ${nights}.
- Ignore service fees, cleaning fees, taxes and security deposits when they are listed separately.
- Ignore crossed-out / discounted "original" prices and use the final price actually charged.

Content:
${content.slice(0, 8000)}

Return ONLY a single number representing the final price per night in the listing's currency (e.g., "125" for €125/night).
If you cannot find a reliable per-night price, return "null".
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
async function scrapePriceFromListing(
  url: string,
  checkIn: string,
  checkOut: string,
  firecrawlApiKey: string,
): Promise<{ price: number | null; totalPrice: number | null; perNightRate: number | null }> {
  const nights = calculateNights(checkIn, checkOut);

  const normalizeNumber = (raw: string): number | null => {
    // Handles: 1,234.56 | 1.234,56 | 1234 | 1 234 | 1’234
    let s = raw
      .replace(/\u00a0/g, " ")
      .replace(/[\s’']/g, "")
      .trim();

    // If both separators exist, decide decimal by the last occurrence
    const lastComma = s.lastIndexOf(",");
    const lastDot = s.lastIndexOf(".");

    if (lastComma !== -1 && lastDot !== -1) {
      if (lastComma > lastDot) {
        // 1.234,56 => remove dots as thousands, comma as decimal
        s = s.replace(/\./g, "").replace(/,/g, ".");
      } else {
        // 1,234.56 => remove commas as thousands
        s = s.replace(/,/g, "");
      }
    } else if (lastComma !== -1 && lastDot === -1) {
      // If comma looks like decimal separator (two digits after), convert to dot
      const decimals = s.slice(lastComma + 1);
      if (decimals.length === 2) s = s.replace(/,/g, ".");
      else s = s.replace(/,/g, "");
    } else {
      // Only dot or none: keep dot as decimal, but remove thousands-style dots like 1.234 (no decimals)
      const dotParts = s.split(".");
      if (dotParts.length === 2 && dotParts[1].length === 3) {
        s = s.replace(/\./g, "");
      }
    }

    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    return n;
  };

  const tryExtract = (content: string): { extracted: number | null; isPerNight: boolean } => {
    const currency = String.raw`(?:\$|€|£|CHF|USD|EUR|GBP|ZAR|AUD|CAD|NZD|SEK|NOK|DKK|PLN|CZK|HUF|R\$|R)`;
    const amount = String.raw`(\d{1,3}(?:[\s,.’]\d{3})*(?:[\.,]\d{2})?|\d{2,6})`;

    const patterns: Array<{ re: RegExp; perNight: boolean }> = [
      // Per-night
      { re: new RegExp(String.raw`(?:from\s*)?${currency}\s*${amount}\s*(?:per\s*night|/night|night)`, "i"), perNight: true },
      { re: new RegExp(String.raw`(?:per\s*night|/night|night)\s*(?:from\s*)?${currency}\s*${amount}`, "i"), perNight: true },
      { re: new RegExp(String.raw`(?:from\s*)?${amount}\s*${currency}\s*(?:per\s*night|/night|night)`, "i"), perNight: true },

      // Total
      { re: new RegExp(String.raw`total[:\s]*${currency}\s*${amount}`, "i"), perNight: false },
      { re: new RegExp(String.raw`${currency}\s*${amount}\s*total`, "i"), perNight: false },
      { re: new RegExp(String.raw`total[:\s]*${amount}\s*${currency}`, "i"), perNight: false },

      // Generic fallback (useful for Booking/TripAdvisor text blocks)
      { re: new RegExp(String.raw`${currency}\s*${amount}`, "i"), perNight: false },
      { re: new RegExp(String.raw`${amount}\s*${currency}`, "i"), perNight: false },
    ];

    for (const p of patterns) {
      const m = content.match(p.re);
      if (!m) continue;
      const raw = m[1];
      const parsed = raw ? normalizeNumber(raw) : null;
      if (!parsed || parsed <= 0 || parsed >= 50000) continue;
      return { extracted: parsed, isPerNight: p.perNight };
    }

    return { extracted: null, isPerNight: false };
  };

  const fetchFirecrawl = async (opts: { formats: ("markdown" | "html")[]; onlyMainContent: boolean; waitFor: number }) => {
    const urlWithDates = addDatesToUrl(url, checkIn, checkOut);
    console.log("Scraping price from:", urlWithDates.slice(0, 160));

    const resp = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${firecrawlApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: urlWithDates,
        formats: opts.formats,
        onlyMainContent: opts.onlyMainContent,
        waitFor: opts.waitFor,
      }),
    });

    if (!resp.ok) {
      console.log("Firecrawl request failed:", resp.status);
      return { markdown: "", html: "" };
    }

    const data = await resp.json();
    const markdown: string = data.data?.markdown || data.markdown || "";
    const html: string = data.data?.html || data.html || "";
    return { markdown, html };
  };

  try {
    // Pass 1: Fast scrape
    const first = await fetchFirecrawl({ formats: ["markdown"], onlyMainContent: true, waitFor: 3500 });
    let content = first.markdown || "";

    let { extracted, isPerNight } = tryExtract(content);

    // Pass 2: Booking.com / TripAdvisor often hide price outside "main" content.
    if (!extracted) {
      const lower = url.toLowerCase();
      const needsDeepScrape = lower.includes("booking.com") || lower.includes("tripadvisor.");
      if (needsDeepScrape) {
        const second = await fetchFirecrawl({ formats: ["markdown", "html"], onlyMainContent: false, waitFor: 6500 });
        const htmlText = (second.html || "").replace(/<script[\s\S]*?<\/script>/gi, " ")
          .replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ");

        content = [second.markdown || "", htmlText].join("\n");
        ({ extracted, isPerNight } = tryExtract(content));
      }
    }

    if (!extracted) return { price: null, totalPrice: null, perNightRate: null };

    if (isPerNight) {
      console.log("Extracted price:", extracted, "(per night)");
      return { price: extracted, totalPrice: extracted * nights, perNightRate: extracted };
    }

    const perNight = Math.round(extracted / nights);
    console.log("Extracted price:", extracted, "(total)");
    return { price: perNight, totalPrice: extracted, perNightRate: perNight };
  } catch (error) {
    console.error("Price scraping error:", error);
    return { price: null, totalPrice: null, perNightRate: null };
  }
}

function isLikelyPropertyImage(url: string): boolean {
  const u = url.toLowerCase();
  if (!u.startsWith("http")) return false;
  if (!/\.(jpg|jpeg|png|webp)(\?|$)/i.test(u)) return false;
  const exclude = ["logo", "favicon", "sprite", "icon", "avatar", "profile", "brand", "placeholder", "analytics", "doubleclick"]; 
  if (exclude.some((k) => u.includes(k))) return false;
  return true;
}

// For some platforms (Booking/TripAdvisor), Lens thumbnails can be too small/cropped and cause false negatives.
// This scrapes the page to pull a higher-quality image for AI verification.
async function scrapeBestImageFromListing(url: string, firecrawlApiKey: string): Promise<string | null> {
  try {
    const response = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${firecrawlApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        formats: ["html"],
        onlyMainContent: false,
        waitFor: 2500,
      }),
    });

    if (!response.ok) return null;
    const data = await response.json();
    const html: string = data.data?.html || data.html || "";
    if (!html) return null;

    // Prefer OG images
    const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/i)
      || html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["'][^>]*>/i);
    if (ogMatch?.[1] && isLikelyPropertyImage(ogMatch[1])) return ogMatch[1];

    // Fallback: first few img src candidates
    const imgMatches = [...html.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi)].slice(0, 40);
    for (const m of imgMatches) {
      const src = m[1];
      if (src && isLikelyPropertyImage(src)) return src;
    }

    return null;
  } catch (e) {
    console.error("scrapeBestImageFromListing error:", e);
    return null;
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
    let firecrawlMarkdown = "";
    let firecrawlHtml = "";
    let directHtml = "";


    // Step 1: Fetch Airbnb page and extract property data using Firecrawl for JS rendering
    console.log("Step 1: Extracting property data from Airbnb...");
    
    let imageUrls: string[] = [];
    
    // Use Firecrawl if available (handles JS-rendered content like prices)
    if (firecrawlApiKey) {
      await supabase.from("searches").update({ status: "scraping_airbnb_page" }).eq("id", searchId);
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

          // Keep copies for potential AI-based price extraction later
          firecrawlMarkdown = markdown;
          firecrawlHtml = rawHtml || html;

          
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

          const canonicalizeMuscacheUrl = (url: string) => {
            const cleaned = url.replace(/\\u002F/g, "/").replace(/\\/g, "");
            // Remove query params like ?im_w=1200 to dedupe correctly
            return cleaned.split("?")[0];
          };

          let allImageUrls: string[] = [];
          const htmlContent = rawHtml || html;

          for (const pattern of imagePatterns) {
            const matches = htmlContent.match(pattern) || [];
            allImageUrls.push(...matches);
          }

          // Also check markdown for image URLs
          const markdownImageMatches = markdown.match(/https:\/\/a0\.muscache\.com\/im\/pictures\/[^\s\)"\]]+/gi) || [];
          allImageUrls.push(...markdownImageMatches);

          const uniqueBases = [...new Set(allImageUrls.map(canonicalizeMuscacheUrl))];

          imageUrls = uniqueBases
            .filter(isValidPropertyImage)
            .map((base) => `${base}?im_w=1200`)
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
          directHtml = html;
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

            const canonicalizeMuscacheUrl = (url: string) => {
              const cleaned = url.replace(/\\u002F/g, "/").replace(/\\/g, "");
              return cleaned.split("?")[0];
            };

            let allImageUrls: string[] = [];

            for (const pattern of imagePatterns) {
              const matches = html.match(pattern) || [];
              allImageUrls.push(...matches);
            }

            const jsonMatches = html.match(/"pictureUrl"\s*:\s*"([^"]+)"/g) || [];
            for (const match of jsonMatches) {
              const urlMatch = match.match(/"pictureUrl"\s*:\s*"([^"]+)"/);
              if (urlMatch && urlMatch[1]) {
                allImageUrls.push(urlMatch[1].replace(/\\u002F/g, "/"));
              }
            }

            const uniqueBases = [...new Set(allImageUrls.map(canonicalizeMuscacheUrl))];

            imageUrls = uniqueBases
              .filter(isValidPropertyImage)
              .map((base) => `${base}?im_w=1200`)
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
      await supabase.from("searches").update({ status: "extracting_price_with_ai" }).eq("id", searchId);
      console.log("Attempting AI-based price extraction...");
      
      // Prefer previously scraped content before making another network call
      let contentForAI = "";
      if (firecrawlMarkdown) {
        contentForAI = firecrawlMarkdown;
      } else if (firecrawlHtml) {
        contentForAI = firecrawlHtml;
      } else if (directHtml) {
        contentForAI = directHtml;
      } else if (firecrawlApiKey) {
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
        await supabase.from("searches").update({ status: "extracting_price_with_ai" }).eq("id", searchId);
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

    // EARLY TERMINATION: If no images found, we can't do visual search - abort early
    if (imageUrls.length === 0) {
      console.warn("FATAL: No property images found - aborting comparison");
      const nights = calculateNights(checkIn, checkOut);

      await supabase.from("searches").update({
        status: "completed",
        airbnb_title: airbnbTitle,
        airbnb_price: airbnbPrice,
        airbnb_image_url: null,
        airbnb_images: [],
        check_in_date: checkIn,
        check_out_date: checkOut,
        nights_count: nights,
      }).eq("id", searchId);

      return new Response(
        JSON.stringify({
          success: true,
          results: [],
          airbnb: {
            title: airbnbTitle,
            price: airbnbPrice,
            url: search.airbnb_url,
            imageUrl: null,
            images: [],
          },
          dates: { checkIn, checkOut, nights },
          message: "Could not extract property images for visual search.",
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Update status to step 2
    await supabase.from("searches").update({ 
      status: "searching_platforms" 
    }).eq("id", searchId);

    // Step 2: Use Google Lens for visual matching (much better than reverse image search)
    // CRITICAL: Track time and AI comparison budget to avoid timeout
    const searchStartTime = Date.now();
    const MAX_SEARCH_TIME_MS = 120000; // 2 minute limit for visual search phase (better coverage)
    const MAX_AI_COMPARISONS = 45; // More AI comparisons to capture more platforms
    const TARGET_VISUAL_MATCHES = 12; // Target more matches before stopping
    let aiComparisonCount = 0;

    const isTimeBudgetExceeded = () => {
      const elapsed = Date.now() - searchStartTime;
      if (elapsed > MAX_SEARCH_TIME_MS) {
        console.log(`TIME BUDGET EXCEEDED: ${elapsed}ms > ${MAX_SEARCH_TIME_MS}ms`);
        return true;
      }
      return false;
    };

    const isAIBudgetExceeded = () => {
      if (aiComparisonCount >= MAX_AI_COMPARISONS) {
        console.log(`AI COMPARISON BUDGET EXCEEDED: ${aiComparisonCount} >= ${MAX_AI_COMPARISONS}`);
        return true;
      }
      return false;
    };

    const hasEnoughMatches = () => {
      const visualCount = alternatives.filter(a => a.match_type === 'visual').length;
      if (visualCount >= TARGET_VISUAL_MATCHES) {
        console.log(`ENOUGH MATCHES FOUND: ${visualCount} >= ${TARGET_VISUAL_MATCHES}`);
        return true;
      }
      return false;
    };

    if (imageUrls.length > 0) {
      console.log("Step 2: Running Google Lens visual matching...");
      console.log(`Budget: ${MAX_AI_COMPARISONS} AI comparisons, ${MAX_SEARCH_TIME_MS}ms time, target ${TARGET_VISUAL_MATCHES} matches`);
      
      // Use up to 5 images for Lens (better recall) but still bounded by budgets
      const lensImages = imageUrls.slice(0, 5);

      for (let idx = 0; idx < lensImages.length; idx++) {
        const imageUrl = lensImages[idx];
        // Check budgets before starting new image
        if (isTimeBudgetExceeded() || hasEnoughMatches()) break;

        // Update status so the UI can show *exactly* what we're doing
        await supabase
          .from("searches")
          .update({ status: `searching_platforms_lens_${idx + 1}_of_${lensImages.length}` })
          .eq("id", searchId);

        try {
          console.log("Google Lens searching:", imageUrl.slice(0, 80));

          // Use Google Lens engine - MUCH better at finding same place across sites
          const lensResponse = await fetch(
            `https://serpapi.com/search.json?engine=google_lens&url=${encodeURIComponent(imageUrl)}&api_key=${serpApiKey}`,
          );

          if (!lensResponse.ok) {
            console.log("Lens search failed:", lensResponse.status);
            continue;
          }

          const lensData = await lensResponse.json();

          // Log what we got
          console.log(
            "Lens results - visual_matches:",
            lensData.visual_matches?.length || 0,
            "knowledge_graph:",
            lensData.knowledge_graph ? "yes" : "no",
            "text_results:",
            lensData.text_results?.length || 0,
          );

          // Process visual matches - these are the key results with VISUAL CONFIRMATION
          // Prioritize likely booking-platform domains first to spend the AI budget where it matters.
          const visualMatchesRaw = (lensData.visual_matches || []).slice(0, 15);

          const urlPriority = (u: string | null | undefined) => {
            if (!u) return 0;
            const lower = u.toLowerCase();
            if (lower.includes("booking.com")) return 100;
            if (lower.includes("tripadvisor.")) return 95;
            if (isBookingPlatform(u)) return 80;
            if (isRegionalHotelSite(u)) return 70;
            if (isDirectPropertySite(u)) return 60;
            return 0;
          };

          const visualMatches = visualMatchesRaw
            .slice()
            .sort((a: any, b: any) => urlPriority(b.link) - urlPriority(a.link));

          for (const match of visualMatches) {
            // Check budgets before each comparison
            if (isTimeBudgetExceeded() || isAIBudgetExceeded() || hasEnoughMatches()) break;

            const url = match.link;
            if (!url) continue;
            if (url.toLowerCase().includes("airbnb.") || foundUrls.has(url)) continue;

            // Quick filter: only check booking platforms and direct sites
            if (!isBookingPlatform(url) && !isRegionalHotelSite(url) && !isDirectPropertySite(url)) {
              continue;
            }

            console.log("Checking visual match:", url.slice(0, 100));

            // Get thumbnail/image URL from the match for AI comparison
            const matchImageUrl = match.thumbnail || match.original || null;

            if (!matchImageUrl) {
              console.log("No image available for AI comparison, skipping:", url.slice(0, 60));
              continue;
            }

            // Use AI to compare images and get similarity score
            const platformSlug = getPlatformName(url).toLowerCase().replace(/[^a-z0-9]/g, "_");
            await supabase.from("searches").update({ status: `ai_verifying_${platformSlug}` }).eq("id", searchId);
            console.log(`Running AI comparison ${aiComparisonCount + 1}/${MAX_AI_COMPARISONS}...`);
            aiComparisonCount++;
            let aiComparison = await compareImagesWithAI(imageUrl, matchImageUrl);
            console.log(
              `AI result: score=${aiComparison.score}, isMatch=${aiComparison.isMatch}, reason: ${aiComparison.explanation}`,
            );

            // Some platforms provide tiny/cropped thumbnails -> if we fail, retry with a high-res image from the page.
            if (
              !aiComparison.isMatch &&
              firecrawlApiKey &&
              (url.toLowerCase().includes("booking.com") || url.toLowerCase().includes("tripadvisor.")) &&
              !isAIBudgetExceeded() &&
              !isTimeBudgetExceeded()
            ) {
              console.log("Retrying AI match with scraped high-res image for:", url.slice(0, 80));
              const betterImage = await scrapeBestImageFromListing(url, firecrawlApiKey);
              if (betterImage) {
                console.log(`Running AI comparison ${aiComparisonCount + 1}/${MAX_AI_COMPARISONS} (hi-res retry)...`);
                aiComparisonCount++;
                aiComparison = await compareImagesWithAI(imageUrl, betterImage);
                console.log(
                  `AI retry result: score=${aiComparison.score}, isMatch=${aiComparison.isMatch}, reason: ${aiComparison.explanation}`,
                );

                // If it matches on retry, use the better image for display
                if (aiComparison.isMatch) {
                  match.thumbnail = betterImage;
                }
              }
            }

            // ONLY include matches with ≥90% AI confidence
            if (!aiComparison.isMatch) {
              console.log("AI rejected match (score < 90%):", url.slice(0, 60));
              continue;
            }

            // Use AI-verified confidence score (converted to 0-1 scale)
            const verifiedConfidence = aiComparison.score / 100;

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
                confidence_score: verifiedConfidence, // AI-verified confidence
                image_url: match.thumbnail || null,
                images: resultImages.slice(0, 5),
                match_type: "visual",
                source_airbnb_image: imageUrl, // Store the Airbnb image that matched
              });
              console.log(
                "✓ AI-VERIFIED match on platform:",
                getPlatformName(url),
                "confidence:",
                (verifiedConfidence * 100).toFixed(0) + "%",
              );
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
                confidence_score: verifiedConfidence, // AI-verified confidence
                image_url: match.thumbnail || null,
                images: resultImages.slice(0, 5),
                match_type: "visual",
                source_airbnb_image: imageUrl, // Store the Airbnb image that matched
              });
              console.log("✓ AI-VERIFIED direct site match:", url.slice(0, 80));
            }
          }

          // Also check knowledge graph for additional context - requires AI verification too
          if (!isTimeBudgetExceeded() && !isAIBudgetExceeded() && !hasEnoughMatches()) {
            if (lensData.knowledge_graph?.source?.link) {
              const kgUrl = lensData.knowledge_graph.source.link;
              const kgImage = lensData.knowledge_graph.thumbnail;

              if (!kgUrl.toLowerCase().includes("airbnb.") && !foundUrls.has(kgUrl) && kgImage) {
                if (isBookingPlatform(kgUrl) || isDirectPropertySite(kgUrl) || isRegionalHotelSite(kgUrl)) {
                  // AI verify knowledge graph match too
                  console.log(`Running AI comparison ${aiComparisonCount + 1}/${MAX_AI_COMPARISONS} (knowledge graph)...`);
                  aiComparisonCount++;
                  const kgComparison = await compareImagesWithAI(imageUrl, kgImage);

                  if (kgComparison.isMatch) {
                    foundUrls.add(kgUrl);
                    alternatives.push({
                      platform_name: getPlatformName(kgUrl),
                      listing_url: kgUrl,
                      listing_title: lensData.knowledge_graph.title || null,
                      price: null,
                      confidence_score: kgComparison.score / 100, // AI-verified
                      image_url: kgImage,
                      images: [kgImage],
                      match_type: "visual",
                      source_airbnb_image: imageUrl,
                    });
                    console.log("✓ AI-VERIFIED knowledge graph match:", kgUrl.slice(0, 80));
                  }
                }
              }
            }
          }

          // Small delay between searches to avoid rate limiting
          await new Promise((r) => setTimeout(r, 300));
        } catch (e) {
          console.error("Lens search error:", e);
        }
      }
      // If Lens didn't find enough and we still have budget, try reverse image search as backup
      if (alternatives.length < 3 && !isTimeBudgetExceeded() && !isAIBudgetExceeded()) {
        await supabase.from("searches").update({ status: "reverse_image_search_backup" }).eq("id", searchId);
        console.log("Running reverse image search as backup...");
        
        for (const imageUrl of imageUrls.slice(0, 2)) {
          // Check budgets before each image
          if (isTimeBudgetExceeded() || isAIBudgetExceeded() || hasEnoughMatches()) break;

          try {
            console.log("Reverse searching:", imageUrl.slice(0, 80));
            
            const reverseResponse = await fetch(
              `https://serpapi.com/search.json?engine=google_reverse_image&image_url=${encodeURIComponent(imageUrl)}&api_key=${serpApiKey}`
            );
            
            if (!reverseResponse.ok) continue;
            
            const reverseData = await reverseResponse.json();
            console.log("Reverse results - image:", reverseData.image_results?.length || 0);
            
            // LIMIT results to check
            const allResults = [
              ...(reverseData.image_results || []),
              ...(reverseData.inline_images || []),
              ...(reverseData.organic_results || []),
            ].slice(0, 8);
            
            for (const result of allResults) {
              // Check budgets before each comparison
              if (isTimeBudgetExceeded() || isAIBudgetExceeded() || hasEnoughMatches()) break;

              const url = result.link || result.source;
              if (!url) continue;
              if (url.toLowerCase().includes("airbnb.") || foundUrls.has(url)) continue;
              
              const resultImage = result.thumbnail || result.original;
              if (!resultImage) continue;
              
              if (isBookingPlatform(url) || isDirectPropertySite(url) || isRegionalHotelSite(url)) {
                // AI verify reverse image match
                console.log(`Running AI comparison ${aiComparisonCount + 1}/${MAX_AI_COMPARISONS} (reverse)...`);
                aiComparisonCount++;
                const reverseComparison = await compareImagesWithAI(imageUrl, resultImage);
                
                if (!reverseComparison.isMatch) {
                  console.log("AI rejected reverse image match (score < 90%):", url.slice(0, 60));
                  continue;
                }
                
                foundUrls.add(url);
                alternatives.push({
                  platform_name: isBookingPlatform(url) || isRegionalHotelSite(url) ? getPlatformName(url) : getPlatformName(url) + " (Direct)",
                  listing_url: url,
                  listing_title: result.title || result.snippet || null,
                  price: null,
                  confidence_score: reverseComparison.score / 100, // AI-verified confidence
                  image_url: resultImage,
                  images: [result.thumbnail, result.original].filter(Boolean).slice(0, 5),
                  match_type: 'visual',
                  source_airbnb_image: imageUrl,
                });
                console.log("✓ AI-VERIFIED reverse image match:", url.slice(0, 80));
              }
            }
            
            await new Promise(r => setTimeout(r, 200));
          } catch (e) {
            console.error("Reverse search error:", e);
          }
        }
      }
    }

    console.log(`Search phase complete. AI comparisons used: ${aiComparisonCount}/${MAX_AI_COMPARISONS}, Time: ${Date.now() - searchStartTime}ms`);

    // EARLY TERMINATION: If no visual matches found after image search, skip expensive text search
    // Text matches are unverified anyway, so there's little value in showing them
    const visualMatchCount = alternatives.filter(a => a.match_type === 'visual').length;
    console.log(`Visual search complete: found ${visualMatchCount} AI-verified matches`);
    
    if (visualMatchCount === 0) {
      console.log("No visual matches found - skipping text search and completing early");
      
      const nights = calculateNights(checkIn, checkOut);
      const airbnbImageUrl = imageUrls.length > 0 ? imageUrls[0] : null;
      const airbnbImages = imageUrls.slice(0, 5);

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

      return new Response(
        JSON.stringify({
          success: true,
          results: [],
          airbnb: {
            title: airbnbTitle,
            price: airbnbPrice,
            url: search.airbnb_url,
            imageUrl: airbnbImageUrl,
            images: airbnbImages,
          },
          dates: { checkIn, checkOut, nights },
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Update status to step 3
    await supabase.from("searches").update({ 
      status: "comparing_prices" 
    }).eq("id", searchId);

    // Step 3: Multi-strategy text search if we still need more results (only if we have some visual matches)
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
    // Run SEQUENTIALLY so users can see each platform being scraped in real-time
    let resultsWithPrices = topAlternatives;
    
    if (firecrawlApiKey && topAlternatives.length > 0) {
      await supabase.from("searches").update({ status: "comparing_prices" }).eq("id", searchId);
      console.log("Step 4: Scraping prices from alternatives...");
      
      const pricedResults: typeof topAlternatives = [];

      // Scrape a bit more than 5, but prioritize Booking.com + TripAdvisor if present.
      const prioritized = [...topAlternatives].sort((a, b) => {
        const score = (p: string) => {
          const l = p.toLowerCase();
          if (l.includes("booking")) return 2;
          if (l.includes("tripadvisor")) return 2;
          return 0;
        };
        return score(b.platform_name) - score(a.platform_name);
      });

      const toScrape = prioritized.slice(0, 8);

      for (let i = 0; i < toScrape.length; i++) {
        const alt = toScrape[i];
        // Update status for each platform being scraped - now visible because sequential
        const platformSlug = alt.platform_name.toLowerCase().replace(/[^a-z0-9]/g, "_");
        await supabase.from("searches").update({
          status: `scraping_price_${platformSlug}_${i + 1}_of_${toScrape.length}`
        }).eq("id", searchId);
        console.log(`Scraping price ${i + 1}/${toScrape.length} from ${alt.platform_name}...`);

        const priceData = await scrapePriceFromListing(alt.listing_url, checkIn, checkOut, firecrawlApiKey);
        pricedResults.push({
          ...alt,
          price: priceData.perNightRate,
          total_price: priceData.totalPrice,
          per_night_rate: priceData.perNightRate,
        });
      }
      
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
