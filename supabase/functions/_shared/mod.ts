/**
 * Shared Modules - Main Entry Point
 * 
 * @module _shared
 * @description Single source of truth for all shared utilities.
 * 
 * This is the canonical import point for shared logic across edge functions.
 * All shared concerns are defined here and must be imported by consumers.
 * 
 * DO NOT duplicate any of this logic in individual edge functions.
 * 
 * @example
 * ```typescript
 * import {
 *   corsHeaders,
 *   handleCorsPreFlight,
 *   buildBookStaysUrl,
 *   detectBotIndicators,
 *   logProviderRequest,
 * } from "../_shared/mod.ts";
 * ```
 */

// HTTP utilities
export {
  corsHeaders,
  corsHeadersExtended,
  handleCorsPreFlight,
  jsonResponse,
  errorResponse,
  fetchWithTimeout,
  withTimeout,
  sleep,
} from "./http/mod.ts";

// Airbnb utilities
export {
  // URL utilities
  buildBookStaysUrl,
  parseAirbnbUrl,
  extractRoomId,
  calculateNights,
  isValidAirbnbUrl,
  type BookStaysUrlResult,
  type ParsedAirbnbUrl,
  // Image extraction
  MUSCACHE_PATTERNS,
  isValidPropertyImage,
  extractAirbnbImages,
  extractListingTitle,
  canonicalizeImageUrl,
  // Bot detection
  detectBotIndicators,
  hasBotWall,
  isLoginRedirect,
  sanitizeForBotDetection,
} from "./airbnb/mod.ts";

// Logging utilities
export {
  logProviderRequest,
  createSearchLogger,
  type ProviderName,
  type ProviderLogParams,
} from "./logging/mod.ts";

// Shared types
export {
  type AirbnbProvider,
  type AirbnbBaselineStatus,
  type AirbnbScrapeResult,
  type OcrVisualReference,
  type AirbnbBaselineExtraction,
  type PriceCandidate,
  type CandidateType,
  type OcrValidationResult,
  type AlternativeResult,
} from "./types/mod.ts";

/**
 * Module version for debugging.
 * Log this when troubleshooting to verify correct module version is loaded.
 */
export const SHARED_MODULES_VERSION = "1.0.0";
