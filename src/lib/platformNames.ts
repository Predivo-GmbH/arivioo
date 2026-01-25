/**
 * Platform Name Utility
 * Converts domain names to friendly display names
 * 
 * IMPORTANT: Use exact domain matches only to avoid incorrect mappings
 * (e.g., "ecohotels.com" should NOT match "hotels.com")
 */

const DOMAIN_TO_NAME: Record<string, string> = {
  // Major OTAs
  'vrbo.com': 'VRBO',
  'expedia.com': 'Expedia',
  'booking.com': 'Booking',
  'hotels.com': 'Hotels',
  'agoda.com': 'Agoda',
  'trip.com': 'Trip',
  'travelocity.com': 'Travelocity',
  'orbitz.com': 'Orbitz',
  'priceline.com': 'Priceline',
  'kayak.com': 'Kayak',
  'trivago.com': 'Trivago',
  'hotwire.com': 'Hotwire',
  'cheaptickets.com': 'CheapTickets',
  
  // Specialty / Niche platforms
  'airpaz.com': 'Airpaz',
  'holidaycheck.com': 'HolidayCheck',
  'hostelworld.com': 'Hostelworld',
  'hostels.com': 'Hostels',
  'homeaway.com': 'HomeAway',
  'vacasa.com': 'Vacasa',
  'sonder.com': 'Sonder',
  'ecohotels.com': 'Ecohotels',
  'getaroom.com': 'Getaroom',
  'stayforlong.com': 'StayForLong',
  'hotellook.com': 'Hotellook',
  'zenhotels.com': 'ZenHotels',
  'roomdi.com': 'Roomdi',
  'destinia.com': 'Destinia',
  'momondo.com': 'Momondo',
  'skyscanner.com': 'Skyscanner',
  'hoteopia.com': 'Hoteopia',
  'laterooms.com': 'LateRooms',
  'ratestogo.com': 'RatesToGo',
  'hotelscombined.com': 'HotelsCombined',
  'otel.com': 'Otel',
  'oyo.com': 'OYO',
  'oyorooms.com': 'OYO',
  'makemytrip.com': 'MakeMyTrip',
  'goibibo.com': 'Goibibo',
  'yatra.com': 'Yatra',
  'cleartrip.com': 'Cleartrip',
  'hrs.com': 'HRS',
  'hrs.de': 'HRS',
  
  // Hotel chains
  'marriott.com': 'Marriott',
  'hilton.com': 'Hilton',
  'hyatt.com': 'Hyatt',
  'ihg.com': 'IHG',
  'wyndham.com': 'Wyndham',
  'bestwestern.com': 'Best Western',
  'choicehotels.com': 'Choice Hotels',
  'radissonhotels.com': 'Radisson',
  'accor.com': 'Accor',
  
  // Vacation rentals
  'airbnb.com': 'Airbnb',
  'flipkey.com': 'FlipKey',
  'hometogo.com': 'HomeToGo',
  'tripping.com': 'Tripping',
  'houfy.com': 'Houfy',
  'evolve.com': 'Evolve',
  
  // Regional platforms
  'ctrip.com': 'Ctrip',
  'meituan.com': 'Meituan',
  'fliggy.com': 'Fliggy',
  'jalan.net': 'Jalan',
  'rakutentravel.com': 'Rakuten Travel',
  'ikkyu.com': 'Ikkyu',
  'despegar.com': 'Despegar',
  'decolar.com': 'Decolar',
};

/**
 * Convert a domain name to a friendly display name
 * Uses EXACT matching only to prevent incorrect associations
 */
export function getPlatformDisplayName(domain: string): string {
  if (!domain) return 'Unknown';
  
  const normalized = domain.toLowerCase().replace(/^www\./, '');
  
  // Check exact match first (primary method)
  if (DOMAIN_TO_NAME[normalized]) {
    return DOMAIN_TO_NAME[normalized];
  }
  
  // Handle subdomains: try parent domain (e.g., "m.booking.com" → "booking.com")
  const parts = normalized.split('.');
  if (parts.length > 2) {
    const parentDomain = parts.slice(-2).join('.');
    if (DOMAIN_TO_NAME[parentDomain]) {
      return DOMAIN_TO_NAME[parentDomain];
    }
  }
  
  // Fallback: capitalize first letter and format nicely
  // Remove TLD and capitalize each word
  if (parts.length > 0) {
    const name = parts[0];
    // Handle camelCase or single word
    return name.charAt(0).toUpperCase() + name.slice(1);
  }
  
  return domain;
}

/**
 * Get country display name from country code
 */
export function getCountryDisplayName(code: string | null): string {
  if (!code) return 'Unknown';
  
  const COUNTRY_NAMES: Record<string, string> = {
    'US': 'United States',
    'CA': 'Canada',
    'GB': 'United Kingdom',
    'DE': 'Germany',
    'FR': 'France',
    'ES': 'Spain',
    'IT': 'Italy',
    'NL': 'Netherlands',
    'AU': 'Australia',
    'NZ': 'New Zealand',
    'ZA': 'South Africa',
    'JP': 'Japan',
    'KR': 'South Korea',
    'MX': 'Mexico',
    'BR': 'Brazil',
    'AR': 'Argentina',
    'IN': 'India',
    'SG': 'Singapore',
    'HK': 'Hong Kong',
    'EU': 'Europe',
  };
  
  return COUNTRY_NAMES[code.toUpperCase()] || code.toUpperCase();
}
