/**
 * HTTP Utilities - Module Entry Point
 * 
 * @module _shared/http
 * @description Re-exports all HTTP utilities.
 */

export {
  MODULE_VERSION as CORS_MODULE_VERSION,
  corsHeaders,
  corsHeadersExtended,
  handleCorsPreFlight,
  jsonResponse,
  errorResponse,
} from "./cors.ts";

export {
  MODULE_VERSION as FETCH_MODULE_VERSION,
  fetchWithTimeout,
  withTimeout,
  sleep,
} from "./fetch-utils.ts";
