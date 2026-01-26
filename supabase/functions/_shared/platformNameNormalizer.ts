/**
 * Platform Name Normalizer
 * 
 * Maps platform names (from UI, extractions, etc.) to canonical adapter domains.
 * Uses EXACT domain matching to prevent false positives like:
 * - "Ecohotels" matching "hotels.com"
 * - "Booking.com" not matching "booking.com" due to case
 * 
 * The canonical form is the platform_domain in platform_adapters table.
 */

// Map of known platform variations to their canonical domain
const PLATFORM_ALIASES: Record<string, string> = {
  // Booking.com variations
  'booking': 'booking.com',
  'booking.com': 'booking.com',
  'bookingcom': 'booking.com',
  
  // Hotels.com variations
  'hotels': 'hotels.com',
  'hotels.com': 'hotels.com',
  'hotelscom': 'hotels.com',
  
  // Expedia variations (including regional)
  'expedia': 'expedia.com',
  'expedia.com': 'expedia.com',
  'expedia.co.jp': 'expedia.com',
  'expedia.co.uk': 'expedia.com',
  'expedia.de': 'expedia.com',
  'expedia.fr': 'expedia.com',
  'expedia.es': 'expedia.com',
  'expedia.it': 'expedia.com',
  'expedia.ca': 'expedia.com',
  'expedia.com.au': 'expedia.com',
  
  // VRBO variations
  'vrbo': 'vrbo.com',
  'vrbo.com': 'vrbo.com',
  
  // Agoda variations
  'agoda': 'agoda.com',
  'agoda.com': 'agoda.com',
  
  // Airpaz variations
  'airpaz': 'airpaz.com',
  'airpaz.com': 'airpaz.com',
  
  // Trip.com variations
  'trip': 'trip.com',
  'trip.com': 'trip.com',
  'ctrip': 'trip.com',
  'ctrip.com': 'trip.com',
  
  // Travelocity
  'travelocity': 'travelocity.com',
  'travelocity.com': 'travelocity.com',
  
  // Orbitz
  'orbitz': 'orbitz.com',
  'orbitz.com': 'orbitz.com',
  
  // Priceline
  'priceline': 'priceline.com',
  'priceline.com': 'priceline.com',
  
  // Kayak
  'kayak': 'kayak.com',
  'kayak.com': 'kayak.com',
  
  // Trivago
  'trivago': 'trivago.com',
  'trivago.com': 'trivago.com',
  
  // Hotwire
  'hotwire': 'hotwire.com',
  'hotwire.com': 'hotwire.com',
  
  // Hostelworld
  'hostelworld': 'hostelworld.com',
  'hostelworld.com': 'hostelworld.com',
  
  // HomeAway (now VRBO)
  'homeaway': 'homeaway.com',
  'homeaway.com': 'homeaway.com',
  
  // Vacasa
  'vacasa': 'vacasa.com',
  'vacasa.com': 'vacasa.com',
  
  // Sonder
  'sonder': 'sonder.com',
  'sonder.com': 'sonder.com',
  
  // Ecohotels (distinct from Hotels.com!)
  'ecohotels': 'ecohotels.com',
  'ecohotels.com': 'ecohotels.com',
  
  // HolidayCheck
  'holidaycheck': 'holidaycheck.com',
  'holidaycheck.com': 'holidaycheck.com',
  
  // Houfy
  'houfy': 'houfy.com',
  'houfy.com': 'houfy.com',
  
  // Evolve
  'evolve': 'evolve.com',
  'evolve.com': 'evolve.com',
  
  // GetARoom
  'getaroom': 'getaroom.com',
  'getaroom.com': 'getaroom.com',
  
  // StayForLong
  'stayforlong': 'stayforlong.com',
  'stayforlong.com': 'stayforlong.com',
  
  // HotelLook
  'hotellook': 'hotellook.com',
  'hotellook.com': 'hotellook.com',
  
  // ZenHotels
  'zenhotels': 'zenhotels.com',
  'zenhotels.com': 'zenhotels.com',
  
  // Momondo
  'momondo': 'momondo.com',
  'momondo.com': 'momondo.com',
  
  // Skyscanner
  'skyscanner': 'skyscanner.com',
  'skyscanner.com': 'skyscanner.com',
  
  // OYO
  'oyo': 'oyo.com',
  'oyo.com': 'oyo.com',
  'oyorooms': 'oyo.com',
  'oyorooms.com': 'oyo.com',
  
  // MakeMyTrip
  'makemytrip': 'makemytrip.com',
  'makemytrip.com': 'makemytrip.com',
  
  // Goibibo
  'goibibo': 'goibibo.com',
  'goibibo.com': 'goibibo.com',
  
  // Yatra
  'yatra': 'yatra.com',
  'yatra.com': 'yatra.com',
  
  // Cleartrip
  'cleartrip': 'cleartrip.com',
  'cleartrip.com': 'cleartrip.com',
  
  // HRS
  'hrs': 'hrs.com',
  'hrs.com': 'hrs.com',
  'hrs.de': 'hrs.com',
  
  // Hotel chains
  'marriott': 'marriott.com',
  'marriott.com': 'marriott.com',
  'hilton': 'hilton.com',
  'hilton.com': 'hilton.com',
  'hyatt': 'hyatt.com',
  'hyatt.com': 'hyatt.com',
  'ihg': 'ihg.com',
  'ihg.com': 'ihg.com',
  'wyndham': 'wyndham.com',
  'wyndham.com': 'wyndham.com',
  'bestwestern': 'bestwestern.com',
  'bestwestern.com': 'bestwestern.com',
  'choicehotels': 'choicehotels.com',
  'choicehotels.com': 'choicehotels.com',
  'radisson': 'radissonhotels.com',
  'radissonhotels': 'radissonhotels.com',
  'radissonhotels.com': 'radissonhotels.com',
  'accor': 'accor.com',
  'accor.com': 'accor.com',
};

/**
 * Normalize a platform name/domain to its canonical adapter domain.
 * 
 * Examples:
 *   - "Booking.com" → "booking.com"
 *   - "booking" → "booking.com"
 *   - "Hotels.com" → "hotels.com"
 *   - "Ecohotels" → "ecohotels.com" (NOT hotels.com!)
 *   - "expedia.co.jp" → "expedia.com"
 * 
 * @param platformNameOrDomain - The platform name or domain to normalize
 * @returns The canonical adapter domain, or null if unknown
 */
export function normalizeToAdapterDomain(platformNameOrDomain: string | null | undefined): string | null {
  if (!platformNameOrDomain) return null;
  
  // Step 1: Clean and lowercase
  const cleaned = platformNameOrDomain
    .toLowerCase()
    .trim()
    .replace(/^www\./, '');  // Remove www. prefix
  
  // Step 2: Try exact alias match
  if (PLATFORM_ALIASES[cleaned]) {
    return PLATFORM_ALIASES[cleaned];
  }
  
  // Step 3: Try without TLD (.com, .co.uk, etc.)
  const withoutTld = cleaned.replace(/\.(com|co\.uk|co\.jp|de|fr|es|it|ca|com\.au|net|org)$/i, '');
  if (PLATFORM_ALIASES[withoutTld]) {
    return PLATFORM_ALIASES[withoutTld];
  }
  
  // Step 4: If it looks like a domain, try to normalize it
  if (cleaned.includes('.')) {
    // Extract base domain for regional variants
    const parts = cleaned.split('.');
    if (parts.length >= 2) {
      const baseName = parts[0];
      if (PLATFORM_ALIASES[baseName]) {
        return PLATFORM_ALIASES[baseName];
      }
    }
  }
  
  // Step 5: Return null for unknown platforms (don't guess!)
  return null;
}

/**
 * Check if a platform name matches a specific adapter domain.
 * Uses exact normalization to prevent false positives.
 * 
 * Examples:
 *   - platformMatches("Booking.com", "booking.com") → true
 *   - platformMatches("Hotels.com", "hotels.com") → true
 *   - platformMatches("Ecohotels", "hotels.com") → FALSE (key distinction!)
 *   - platformMatches("expedia.co.jp", "expedia.com") → true
 */
export function platformMatches(platformName: string, adapterDomain: string): boolean {
  const normalizedPlatform = normalizeToAdapterDomain(platformName);
  const normalizedAdapter = adapterDomain.toLowerCase().trim();
  
  if (!normalizedPlatform) {
    // Unknown platform - try direct comparison as fallback
    const cleanedPlatform = platformName.toLowerCase().trim().replace(/^www\./, '');
    return cleanedPlatform === normalizedAdapter;
  }
  
  return normalizedPlatform === normalizedAdapter;
}

/**
 * Extract a list of all known canonical adapter domains.
 */
export function getKnownAdapterDomains(): string[] {
  return [...new Set(Object.values(PLATFORM_ALIASES))];
}
