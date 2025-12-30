/**
 * Provider Request Logging - Single Source of Truth
 * 
 * @module _shared/logging/provider-logs
 * @description Canonical API request logging for quota management.
 * 
 * OWNERSHIP: This module owns all provider request logging logic.
 * CONSUMERS: search-alternatives, all extraction edge functions
 * 
 * DO NOT duplicate logProviderRequest in individual edge functions.
 * Import from this module instead.
 */

export const MODULE_VERSION = "1.0.0";

/**
 * Supported provider names for logging.
 */
export type ProviderName = "firecrawl" | "zyte" | "browserless" | "serpapi" | "lovable_ai";

/**
 * Parameters for logging a provider request.
 */
export interface ProviderLogParams {
  /** Supabase client instance */
  supabase: any;
  /** Provider name */
  provider: ProviderName;
  /** Type of endpoint called (e.g., "airbnb_scrape", "image_search") */
  endpointType: string;
  /** Associated search ID (optional) */
  searchId?: string;
  /** Associated extraction ID (optional) */
  extractionId?: string;
  /** Request URL (will be truncated to 500 chars) */
  url?: string;
  /** Whether the request succeeded */
  success: boolean;
  /** HTTP status code */
  httpStatus?: number;
  /** Request duration in milliseconds */
  durationMs?: number;
  /** Error message (will be truncated to 500 chars) */
  errorMessage?: string;
  /** Correlation ID for tracking related requests */
  correlationId?: string;
  /** Cost in units (default: 1) */
  costUnits?: number;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Logs a provider API request to the api_request_logs table.
 * This is used for quota management and debugging.
 * 
 * This function is fire-and-forget - it catches all errors internally
 * to prevent logging failures from breaking the main flow.
 * 
 * @param params - Request details to log
 * 
 * @example
 * ```typescript
 * await logProviderRequest({
 *   supabase,
 *   provider: "firecrawl",
 *   endpointType: "airbnb_scrape",
 *   searchId: "abc-123",
 *   url: "https://airbnb.com/rooms/12345",
 *   success: true,
 *   httpStatus: 200,
 *   durationMs: 1500,
 * });
 * ```
 */
export async function logProviderRequest(params: ProviderLogParams): Promise<void> {
  try {
    await params.supabase.from("api_request_logs").insert({
      provider_name: params.provider,
      endpoint_type: params.endpointType,
      search_id: params.searchId || null,
      extraction_id: params.extractionId || null,
      request_url: params.url?.slice(0, 500) || null,
      success: params.success,
      response_status: params.httpStatus || null,
      duration_ms: params.durationMs || null,
      error_message: params.errorMessage?.slice(0, 500) || null,
      correlation_id: params.correlationId || null,
      cost_units: params.costUnits ?? 1,
      metadata: params.metadata || null,
    });
    
    console.log(
      `[ProviderLog] ${params.provider}/${params.endpointType} - ` +
      `success:${params.success} ${params.durationMs ? `(${params.durationMs}ms)` : ""}`
    );
  } catch (e) {
    // Don't let logging failures break the main flow
    console.error("[ProviderLog] Failed to log request:", e);
  }
}

/**
 * Creates a logging function bound to a specific search.
 * Useful when making multiple requests for the same search.
 * 
 * @param supabase - Supabase client
 * @param searchId - Search ID to bind
 * @returns Bound logging function
 */
export function createSearchLogger(supabase: any, searchId: string) {
  return (params: Omit<ProviderLogParams, "supabase" | "searchId">) =>
    logProviderRequest({ ...params, supabase, searchId });
}
