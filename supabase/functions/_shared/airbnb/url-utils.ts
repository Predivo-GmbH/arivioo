/**
 * Airbnb URL Utilities - Single Source of Truth
 * 
 * @module _shared/airbnb/url-utils
 * @description Canonical URL parsing and construction for Airbnb listings.
 * 
 * OWNERSHIP: This module owns all Airbnb URL manipulation logic.
 * CONSUMERS: search-alternatives, airbnb-baseline-test, airbnb-selftest, airbnb-diagnostic
 * 
 * DO NOT duplicate buildBookStaysUrl or URL parsing in individual edge functions.
 * Import from this module instead.
 */

export const MODULE_VERSION = "1.0.0";

/**
 * Result of parsing an Airbnb rooms URL into a book/stays URL.
 */
export interface BookStaysUrlResult {
  book_stays_url: string;
  room_id: string;
  check_in: string;
  check_out: string;
  adults: number;
  children: number;
}

/**
 * Parsed components of an Airbnb URL.
 */
export interface ParsedAirbnbUrl {
  roomId: string | null;
  checkIn: string | null;
  checkOut: string | null;
  adults: number;
  children: number;
  guests: number;
  isValid: boolean;
}

/**
 * Extracts the room ID from an Airbnb URL.
 * Handles various URL formats including /rooms/, /h/, and plus listings.
 * 
 * @param url - Airbnb URL
 * @returns Room ID or null if not found
 */
export function extractRoomId(url: string): string | null {
  // Match /rooms/XXXXXX pattern
  const roomsMatch = url.match(/\/rooms\/(\d+)/);
  if (roomsMatch) return roomsMatch[1];

  // Match /h/XXXXXX pattern (alternate format)
  const hMatch = url.match(/\/h\/(\d+)/);
  if (hMatch) return hMatch[1];

  // Match plus listings
  const plusMatch = url.match(/\/plus\/(\d+)/);
  if (plusMatch) return plusMatch[1];

  return null;
}

/**
 * Parses an Airbnb URL into its components.
 * 
 * @param url - Airbnb URL to parse
 * @returns Parsed URL components
 */
export function parseAirbnbUrl(url: string): ParsedAirbnbUrl {
  const result: ParsedAirbnbUrl = {
    roomId: null,
    checkIn: null,
    checkOut: null,
    adults: 1,
    children: 0,
    guests: 1,
    isValid: false,
  };

  try {
    const urlObj = new URL(url);
    
    result.roomId = extractRoomId(url);
    result.checkIn = urlObj.searchParams.get("check_in");
    result.checkOut = urlObj.searchParams.get("check_out");
    result.adults = parseInt(urlObj.searchParams.get("adults") || "1", 10) || 1;
    result.children = parseInt(urlObj.searchParams.get("children") || "0", 10) || 0;
    result.guests = parseInt(urlObj.searchParams.get("guests") || "1", 10) || 1;
    
    result.isValid = !!(result.roomId && result.checkIn && result.checkOut);
  } catch {
    // Invalid URL, return defaults
  }

  return result;
}

/**
 * Builds a book/stays checkout URL from a rooms URL.
 * The book/stays page shows the full price breakdown including taxes.
 * 
 * @param roomsUrl - Airbnb rooms URL with dates and guest count
 * @param guestCurrency - Currency code (default: USD)
 * @returns BookStaysUrlResult or null if URL cannot be parsed
 * 
 * @example
 * ```typescript
 * const result = buildBookStaysUrl(
 *   "https://www.airbnb.com/rooms/12345?check_in=2025-01-01&check_out=2025-01-05&adults=2"
 * );
 * // result.book_stays_url = "https://www.airbnb.com/book/stays/12345?..."
 * ```
 */
export function buildBookStaysUrl(
  roomsUrl: string,
  guestCurrency = "USD"
): BookStaysUrlResult | null {
  try {
    const parsed = parseAirbnbUrl(roomsUrl);
    
    if (!parsed.roomId || !parsed.checkIn || !parsed.checkOut) {
      console.log("buildBookStaysUrl: Missing required URL parameters");
      return null;
    }

    const bookStaysUrl = new URL(`https://www.airbnb.com/book/stays/${parsed.roomId}`);
    bookStaysUrl.searchParams.set("checkin", parsed.checkIn);
    bookStaysUrl.searchParams.set("checkout", parsed.checkOut);
    bookStaysUrl.searchParams.set("numberOfAdults", String(parsed.adults));
    bookStaysUrl.searchParams.set("numberOfChildren", String(parsed.children));
    bookStaysUrl.searchParams.set("numberOfInfants", "0");
    bookStaysUrl.searchParams.set("numberOfPets", "0");
    bookStaysUrl.searchParams.set("guestCurrency", guestCurrency);

    return {
      book_stays_url: bookStaysUrl.toString(),
      room_id: parsed.roomId,
      check_in: parsed.checkIn,
      check_out: parsed.checkOut,
      adults: parsed.adults,
      children: parsed.children,
    };
  } catch (e) {
    console.error("buildBookStaysUrl error:", e);
    return null;
  }
}

/**
 * Calculates the number of nights between check-in and check-out dates.
 * 
 * @param checkIn - Check-in date string (YYYY-MM-DD)
 * @param checkOut - Check-out date string (YYYY-MM-DD)
 * @returns Number of nights, or 0 if dates are invalid
 */
export function calculateNights(checkIn: string, checkOut: string): number {
  try {
    const inDate = new Date(checkIn);
    const outDate = new Date(checkOut);
    const diffMs = outDate.getTime() - inDate.getTime();
    const nights = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    return nights > 0 ? nights : 0;
  } catch {
    return 0;
  }
}

/**
 * Validates that a URL is a valid Airbnb listing URL.
 * Checks against allowlist of Airbnb domains.
 * 
 * @param url - URL to validate
 * @returns true if valid Airbnb URL
 */
export function isValidAirbnbUrl(url: string): boolean {
  const AIRBNB_DOMAINS = [
    "airbnb.com", "airbnb.co.uk", "airbnb.de", "airbnb.fr", "airbnb.es",
    "airbnb.it", "airbnb.pt", "airbnb.nl", "airbnb.be", "airbnb.at",
    "airbnb.ch", "airbnb.ie", "airbnb.com.au", "airbnb.co.nz", "airbnb.ca",
    "airbnb.com.br", "airbnb.com.mx", "airbnb.com.ar", "airbnb.cl",
    "airbnb.co.in", "airbnb.jp", "airbnb.co.kr", "airbnb.com.sg",
    "airbnb.com.hk", "airbnb.com.tw", "airbnb.co.id", "airbnb.com.my",
    "airbnb.co.th", "airbnb.com.ph", "airbnb.co.za", "airbnb.ae",
    "airbnb.pl", "airbnb.cz", "airbnb.dk", "airbnb.fi", "airbnb.no",
    "airbnb.se", "airbnb.gr", "airbnb.ru", "airbnb.com.tr", "airbnb.hu",
  ];

  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase().replace(/^www\./, "");
    return AIRBNB_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}
