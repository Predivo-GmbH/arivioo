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
 * Exception: Hotels.com Global Photo Comparison Bypass
 * 
 * Treat ALL Hotels.com results as valid even if photo comparison failed.
 * This allows testing the Hotels.com price extraction without the image
 * verification gate blocking it.
 * 
 * Added: 2026-01-24
 * Updated: 2026-01-24 - Changed from single-URL to global bypass
 * Reason: Testing Hotels.com price extraction across all searches
 * Remove when: User requests removal
 */
export const HOTELS_COM_GLOBAL_BYPASS_ENABLED = true;

/**
 * Exception: Booking.com Global Photo Comparison Bypass
 * 
 * Treat ALL Booking.com results as valid even if photo comparison failed.
 * This allows testing the Booking.com price extraction without the image
 * verification gate blocking it.
 * 
 * Added: 2026-01-25
 * Reason: Testing Booking.com price extraction across all searches
 * Remove when: User requests removal
 */
export const BOOKING_COM_GLOBAL_BYPASS_ENABLED = true;

/**
 * Check if Hotels.com bypass is active (always true when global bypass enabled)
 */
export function isHotelsComBypassUrl(airbnbUrl: string | null | undefined): boolean {
  // Global bypass - applies to ALL Airbnb URLs
  return HOTELS_COM_GLOBAL_BYPASS_ENABLED;
}

/**
 * Check if Booking.com bypass is active (always true when global bypass enabled)
 */
export function isBookingComBypassUrl(airbnbUrl: string | null | undefined): boolean {
  // Global bypass - applies to ALL Airbnb URLs
  return BOOKING_COM_GLOBAL_BYPASS_ENABLED;
}

/**
 * Check if a platform should bypass photo comparison rejection
 * When bypass is enabled, results are treated as valid regardless of confidence score
 */
export function shouldBypassPhotoRejection(
  airbnbUrl: string | null | undefined,
  platformName: string
): boolean {
  const normalizedPlatform = platformName.toLowerCase().replace(/[^a-z]/g, '');
  
  // Hotels.com bypass
  if (HOTELS_COM_GLOBAL_BYPASS_ENABLED) {
    if (normalizedPlatform === 'hotelscom' || normalizedPlatform === 'hotels') {
      return true;
    }
  }
  
  // Booking.com bypass
  if (BOOKING_COM_GLOBAL_BYPASS_ENABLED) {
    if (normalizedPlatform === 'bookingcom' || normalizedPlatform === 'booking') {
      return true;
    }
  }
  
  return false;
}
