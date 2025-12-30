/**
 * CORS Headers - Single Source of Truth
 * 
 * @module _shared/http/cors
 * @description Canonical CORS configuration for all edge functions.
 * 
 * OWNERSHIP: This module owns all CORS-related logic.
 * CONSUMERS: ALL edge functions that serve HTTP requests.
 * 
 * DO NOT duplicate corsHeaders in individual edge functions.
 * Import from this module instead.
 */

export const MODULE_VERSION = "1.0.0";

/**
 * Standard CORS headers for all edge functions.
 * Allows requests from any origin with standard Supabase headers.
 */
export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Extended CORS headers with additional methods.
 * Use when the endpoint supports PUT, DELETE, or PATCH.
 */
export const corsHeadersExtended: Record<string, string> = {
  ...corsHeaders,
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
};

/**
 * Handles CORS preflight requests.
 * Call this at the start of every edge function handler.
 * 
 * @param req - The incoming request
 * @returns Response for OPTIONS request, or null to continue processing
 * 
 * @example
 * ```typescript
 * const corsResponse = handleCorsPreFlight(req);
 * if (corsResponse) return corsResponse;
 * // ... continue with request handling
 * ```
 */
export function handleCorsPreFlight(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  return null;
}

/**
 * Creates a JSON response with CORS headers.
 * 
 * @param data - The data to serialize as JSON
 * @param status - HTTP status code (default: 200)
 * @returns Response with JSON body and CORS headers
 */
export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * Creates an error response with CORS headers.
 * 
 * @param message - Error message
 * @param status - HTTP status code (default: 500)
 * @returns Response with error JSON and CORS headers
 */
export function errorResponse(message: string, status = 500): Response {
  return jsonResponse({ success: false, error: message }, status);
}
