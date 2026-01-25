/**
 * Platform Name Utility
 * Converts domain names to friendly display names
 */

const DOMAIN_TO_NAME: Record<string, string> = {
  'vrbo.com': 'VRBO',
  'expedia.com': 'Expedia',
  'booking.com': 'Booking.com',
  'hotels.com': 'Hotels.com',
  'agoda.com': 'Agoda',
  'airpaz.com': 'Airpaz',
  'trip.com': 'Trip.com',
  'travelocity.com': 'Travelocity',
  'orbitz.com': 'Orbitz',
  'priceline.com': 'Priceline',
  'kayak.com': 'Kayak',
  'trivago.com': 'Trivago',
  'hotwire.com': 'Hotwire',
  'cheaptickets.com': 'CheapTickets',
  'holidaycheck.com': 'HolidayCheck',
  'hostelworld.com': 'Hostelworld',
  'hostels.com': 'Hostels.com',
  'homeaway.com': 'HomeAway',
  'vacasa.com': 'Vacasa',
  'sonder.com': 'Sonder',
  'marriott.com': 'Marriott',
  'hilton.com': 'Hilton',
  'hyatt.com': 'Hyatt',
  'ihg.com': 'IHG',
  'wyndham.com': 'Wyndham',
  'bestwestern.com': 'Best Western',
  'choicehotels.com': 'Choice Hotels',
  'radissonhotels.com': 'Radisson',
  'accor.com': 'Accor',
  'airbnb.com': 'Airbnb',
};

/**
 * Convert a domain name to a friendly display name
 */
export function getPlatformDisplayName(domain: string): string {
  if (!domain) return 'Unknown';
  
  const normalized = domain.toLowerCase().replace(/^www\./, '');
  
  // Check exact match first
  if (DOMAIN_TO_NAME[normalized]) {
    return DOMAIN_TO_NAME[normalized];
  }
  
  // Check if domain contains a known platform
  for (const [knownDomain, name] of Object.entries(DOMAIN_TO_NAME)) {
    if (normalized.includes(knownDomain.replace('.com', ''))) {
      return name;
    }
  }
  
  // Fallback: capitalize first letter and remove TLD
  const parts = normalized.split('.');
  if (parts.length > 0) {
    const name = parts[0];
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
