/**
 * Canonical Airbnb URL Normalizer - Edge Function Version
 * 
 * This module provides the SINGLE SOURCE OF TRUTH for transforming Airbnb room URLs
 * into their canonical book/stays checkout URLs for accurate price extraction.
 * 
 * GOLDEN PATH RULE: All URL normalization must go through this module.
 * No URL rewriting logic is allowed outside this shared module.
 * 
 * This file is duplicated from src/lib/airbnbUrlNormalizer.ts for Deno compatibility.
 * Keep both files in sync!
 */

export interface AirbnbUrlParams {
  roomId: string;
  checkIn: string;
  checkOut: string;
  numberOfAdults: number;
  numberOfChildren: number;
  numberOfInfants: number;
  numberOfPets: number;
  numberOfGuests: number;
  guestCurrency: string;
  nightsCount: number;
}

export interface NormalizationResult {
  success: true;
  bookStaysUrl: string;
  roomsUrl: string;
  params: AirbnbUrlParams;
  isAlreadyBookStays: boolean;
}

export interface NormalizationError {
  success: false;
  error: string;
  errorCode: 'INVALID_URL' | 'MISSING_ROOM_ID' | 'MISSING_DATES' | 'INVALID_DATES';
}

export type NormalizationOutcome = NormalizationResult | NormalizationError;

/**
 * Validates and parses a date string in YYYY-MM-DD format
 */
function parseDate(dateStr: string): Date | null {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const date = new Date(dateStr + 'T00:00:00Z');
  return isNaN(date.getTime()) ? null : date;
}

/**
 * Calculates nights between two dates
 */
function calculateNights(checkIn: Date, checkOut: Date): number {
  return Math.round((checkOut.getTime() - checkIn.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Extract room ID from Airbnb URL path
 * Handles both /rooms/<id> and /book/stays/<id> paths
 */
function extractRoomId(pathname: string): string | null {
  // Try /rooms/<id> first
  const roomsMatch = pathname.match(/\/rooms\/(\d+)/);
  if (roomsMatch) return roomsMatch[1];
  
  // Try /book/stays/<id>
  const bookStaysMatch = pathname.match(/\/book\/stays\/(\d+)/);
  if (bookStaysMatch) return bookStaysMatch[1];
  
  return null;
}

/**
 * Check if URL is already a book/stays URL
 */
function isBookStaysUrl(pathname: string): boolean {
  return /\/book\/stays\/\d+/.test(pathname);
}

/**
 * Normalizes an Airbnb URL to the canonical book/stays format.
 * 
 * This is the ONLY function that should be used for URL normalization.
 * 
 * @param inputUrl - The Airbnb URL (rooms or book/stays format)
 * @param options - Optional configuration
 * @returns NormalizationOutcome with either the normalized URL or an error
 */
export function normalizeAirbnbUrl(
  inputUrl: string,
  options: { guestCurrency?: string } = {}
): NormalizationOutcome {
  const { guestCurrency = 'USD' } = options;
  
  // Parse URL
  let parsed: URL;
  try {
    parsed = new URL(inputUrl);
  } catch {
    return { success: false, error: 'Invalid URL format', errorCode: 'INVALID_URL' };
  }
  
  // Extract room ID
  const roomId = extractRoomId(parsed.pathname);
  if (!roomId) {
    return { success: false, error: 'Could not extract room ID from URL', errorCode: 'MISSING_ROOM_ID' };
  }
  
  const alreadyBookStays = isBookStaysUrl(parsed.pathname);
  
  // Extract and validate dates
  // For book/stays URLs, use 'checkin'/'checkout'; for rooms, use 'check_in'/'check_out'
  let checkIn = parsed.searchParams.get('checkin') || parsed.searchParams.get('check_in') || '';
  let checkOut = parsed.searchParams.get('checkout') || parsed.searchParams.get('check_out') || '';
  
  if (!checkIn || !checkOut) {
    return { 
      success: false, 
      error: 'Missing required date parameters (check_in/check_out or checkin/checkout)', 
      errorCode: 'MISSING_DATES' 
    };
  }
  
  const checkInDate = parseDate(checkIn);
  const checkOutDate = parseDate(checkOut);
  
  if (!checkInDate || !checkOutDate) {
    return { 
      success: false, 
      error: 'Invalid date format. Expected YYYY-MM-DD', 
      errorCode: 'INVALID_DATES' 
    };
  }
  
  if (checkOutDate <= checkInDate) {
    return { 
      success: false, 
      error: 'Check-out date must be after check-in date', 
      errorCode: 'INVALID_DATES' 
    };
  }
  
  const nightsCount = calculateNights(checkInDate, checkOutDate);
  
  // Extract guest parameters
  // For book/stays: numberOfAdults, numberOfChildren, numberOfInfants, numberOfPets, numberOfGuests
  // For rooms: adults, children, infants, pets, guests
  const numberOfAdults = parseInt(
    parsed.searchParams.get('numberOfAdults') || 
    parsed.searchParams.get('adults') || 
    '1', 
    10
  ) || 1;
  
  const numberOfChildren = parseInt(
    parsed.searchParams.get('numberOfChildren') || 
    parsed.searchParams.get('children') || 
    '0', 
    10
  ) || 0;
  
  const numberOfInfants = parseInt(
    parsed.searchParams.get('numberOfInfants') || 
    parsed.searchParams.get('infants') || 
    '0', 
    10
  ) || 0;
  
  const numberOfPets = parseInt(
    parsed.searchParams.get('numberOfPets') || 
    parsed.searchParams.get('pets') || 
    '0', 
    10
  ) || 0;
  
  // Calculate numberOfGuests if not provided
  // Formula: numberOfGuests = numberOfAdults + numberOfChildren + numberOfInfants
  // Note: pets do NOT count as guests
  const existingGuests = parsed.searchParams.get('numberOfGuests') || parsed.searchParams.get('guests');
  const numberOfGuests = existingGuests 
    ? parseInt(existingGuests, 10) || (numberOfAdults + numberOfChildren + numberOfInfants)
    : numberOfAdults + numberOfChildren + numberOfInfants;
  
  // Build canonical book/stays URL with fixed parameter order
  const bookStaysUrl = new URL(`https://www.airbnb.com/book/stays/${roomId}`);
  
  // Set parameters in CANONICAL ORDER (important for caching and deduplication)
  bookStaysUrl.searchParams.set('numberOfGuests', String(numberOfGuests));
  bookStaysUrl.searchParams.set('numberOfAdults', String(numberOfAdults));
  bookStaysUrl.searchParams.set('checkin', checkIn);
  bookStaysUrl.searchParams.set('checkout', checkOut);
  bookStaysUrl.searchParams.set('guestCurrency', guestCurrency);
  bookStaysUrl.searchParams.set('productId', roomId);
  bookStaysUrl.searchParams.set('isWorkTrip', 'false');
  bookStaysUrl.searchParams.set('numberOfChildren', String(numberOfChildren));
  bookStaysUrl.searchParams.set('numberOfInfants', String(numberOfInfants));
  bookStaysUrl.searchParams.set('numberOfPets', String(numberOfPets));
  
  // Build canonical rooms URL (for fallback and title/image extraction)
  const roomsUrl = new URL(`https://www.airbnb.com/rooms/${roomId}`);
  roomsUrl.searchParams.set('check_in', checkIn);
  roomsUrl.searchParams.set('check_out', checkOut);
  roomsUrl.searchParams.set('adults', String(numberOfAdults));
  if (numberOfChildren > 0) roomsUrl.searchParams.set('children', String(numberOfChildren));
  if (numberOfInfants > 0) roomsUrl.searchParams.set('infants', String(numberOfInfants));
  if (numberOfPets > 0) roomsUrl.searchParams.set('pets', String(numberOfPets));
  
  const params: AirbnbUrlParams = {
    roomId,
    checkIn,
    checkOut,
    numberOfAdults,
    numberOfChildren,
    numberOfInfants,
    numberOfPets,
    numberOfGuests,
    guestCurrency,
    nightsCount,
  };
  
  return {
    success: true,
    bookStaysUrl: bookStaysUrl.toString(),
    roomsUrl: roomsUrl.toString(),
    params,
    isAlreadyBookStays: alreadyBookStays,
  };
}

/**
 * Quick validation check - returns true if URL can be normalized
 */
export function canNormalizeUrl(inputUrl: string): boolean {
  const result = normalizeAirbnbUrl(inputUrl);
  return result.success;
}

/**
 * Extract just the room ID from any Airbnb URL (rooms or book/stays)
 */
export function extractRoomIdFromUrl(inputUrl: string): string | null {
  try {
    const parsed = new URL(inputUrl);
    return extractRoomId(parsed.pathname);
  } catch {
    return null;
  }
}

// ============================================================================
// Edge Function HTTP Handler
// ============================================================================

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { url, guestCurrency } = await req.json();
    
    if (!url) {
      return new Response(
        JSON.stringify({ success: false, error: 'Missing required "url" parameter', errorCode: 'INVALID_URL' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const result = normalizeAirbnbUrl(url, { guestCurrency });
    
    return new Response(
      JSON.stringify(result),
      { 
        status: result.success ? 200 : 400, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ success: false, error: 'Invalid request body', errorCode: 'INVALID_URL' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
