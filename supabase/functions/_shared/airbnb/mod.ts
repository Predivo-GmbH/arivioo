/**
 * Airbnb Utilities - Module Entry Point
 * 
 * @module _shared/airbnb
 * @description Re-exports all Airbnb-related utilities.
 * 
 * This is the single source of truth for all Airbnb extraction logic.
 */

// URL utilities
export {
  MODULE_VERSION as URL_UTILS_VERSION,
  buildBookStaysUrl,
  parseAirbnbUrl,
  extractRoomId,
  calculateNights,
  isValidAirbnbUrl,
  type BookStaysUrlResult,
  type ParsedAirbnbUrl,
} from "./url-utils.ts";

// Image extraction
export {
  MODULE_VERSION as IMAGE_EXTRACTION_VERSION,
  MUSCACHE_PATTERNS,
  JSON_IMAGE_PATTERNS,
  EXCLUDE_IMAGE_PATTERNS,
  canonicalizeImageUrl,
  isValidPropertyImage,
  extractAirbnbImages,
  extractListingTitle,
} from "./image-extraction.ts";

// Bot detection
export {
  MODULE_VERSION as BOT_DETECTION_VERSION,
  BOT_PATTERNS,
  sanitizeForBotDetection,
  detectBotIndicators,
  hasBotWall,
  isLoginRedirect,
} from "./bot-detection.ts";
