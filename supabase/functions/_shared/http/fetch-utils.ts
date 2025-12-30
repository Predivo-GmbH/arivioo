/**
 * Fetch Utilities - Single Source of Truth
 * 
 * @module _shared/http/fetch-utils
 * @description Canonical fetch wrappers with timeout support.
 * 
 * OWNERSHIP: This module owns all fetch timeout/wrapper logic.
 * CONSUMERS: ALL edge functions that make HTTP requests.
 * 
 * DO NOT duplicate fetchWithTimeout in individual edge functions.
 * Import from this module instead.
 */

export const MODULE_VERSION = "1.0.0";

/**
 * Fetch with automatic timeout.
 * Aborts the request if it exceeds the specified timeout.
 * 
 * @param input - URL or Request object
 * @param init - Fetch init options
 * @param timeoutMs - Timeout in milliseconds (default: 12000)
 * @returns Promise resolving to Response
 * @throws Error if request times out
 * 
 * @example
 * ```typescript
 * const response = await fetchWithTimeout(
 *   "https://api.example.com/data",
 *   { method: "POST", body: JSON.stringify(data) },
 *   30_000
 * );
 * ```
 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 12_000
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Generic timeout wrapper for any async operation.
 * Prevents stuck processes by enforcing a maximum execution time.
 * 
 * @param operation - Async function to execute
 * @param timeoutMs - Maximum time to wait
 * @param fallback - Value to return if timeout occurs
 * @param operationName - Name for logging purposes
 * @returns Promise resolving to operation result or fallback
 * 
 * @example
 * ```typescript
 * const result = await withTimeout(
 *   () => expensiveOperation(),
 *   5000,
 *   { ok: false },
 *   "expensiveOperation"
 * );
 * ```
 */
export async function withTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  fallback: T,
  operationName: string
): Promise<T> {
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      console.log(`TIMEOUT: ${operationName} exceeded ${timeoutMs}ms - skipping`);
      resolve(fallback);
    }, timeoutMs);

    operation()
      .then((result) => {
        clearTimeout(timeoutId);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timeoutId);
        console.log(`ERROR in ${operationName}:`, error.message || error);
        resolve(fallback);
      });
  });
}

/**
 * Sleep utility for delays.
 * 
 * @param ms - Milliseconds to sleep
 * @returns Promise that resolves after the delay
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
