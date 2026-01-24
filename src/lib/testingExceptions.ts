/**
 * Testing Exceptions Module
 * 
 * Contains temporary exceptions for specific URLs/scenarios for testing purposes.
 * These exceptions should be removed once testing is complete.
 */

// ============================================================================
// ACTIVE TESTING EXCEPTIONS
// ============================================================================

/**
 * Exception: Hotels.com Photo Comparison Bypass
 * 
 * For this specific Airbnb URL, treat Hotels.com results as valid even if
 * photo comparison failed. This allows testing the Hotels.com price extraction
 * without the image verification gate blocking it.
 * 
 * Added: 2026-01-24
 * Reason: Testing Hotels.com price extraction fix
 * Remove when: User requests removal
 */
export const HOTELS_COM_BYPASS_AIRBNB_URL = 'https://www.airbnb.com/rooms/1411591824436140561';

/**
 * Check if a given Airbnb URL matches the Hotels.com bypass exception
 */
export function isHotelsComBypassUrl(airbnbUrl: string | null | undefined): boolean {
  if (!airbnbUrl) return false;
  
  try {
    const url = new URL(airbnbUrl);
    // Extract the room ID path to match regardless of query params
    const roomIdMatch = url.pathname.match(/\/rooms\/(\d+)/);
    if (!roomIdMatch) return false;
    
    const targetUrl = new URL(HOTELS_COM_BYPASS_AIRBNB_URL);
    const targetRoomIdMatch = targetUrl.pathname.match(/\/rooms\/(\d+)/);
    if (!targetRoomIdMatch) return false;
    
    return roomIdMatch[1] === targetRoomIdMatch[1];
  } catch {
    return false;
  }
}

/**
 * Check if a platform should bypass photo comparison rejection for a given Airbnb URL
 */
export function shouldBypassPhotoRejection(
  airbnbUrl: string | null | undefined,
  platformName: string
): boolean {
  if (!isHotelsComBypassUrl(airbnbUrl)) return false;
  
  // Only Hotels.com is bypassed for this exception
  const normalizedPlatform = platformName.toLowerCase().replace(/[^a-z]/g, '');
  return normalizedPlatform === 'hotelscom' || normalizedPlatform === 'hotels';
}
