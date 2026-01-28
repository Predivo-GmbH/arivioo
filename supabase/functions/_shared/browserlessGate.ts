/**
 * BROWSERLESS GLOBAL GATE
 * 
 * Provides coordination for Browserless API calls to prevent burst rate limiting.
 * 
 * ARCHITECTURE:
 * - Uses a simple request queue with delay-based rate limiting
 * - 429 handling with exponential backoff + jitter
 * - Explicit rate_limited classification (never conflated with other failures)
 * 
 * NOTE: For true distributed coordination across multiple Edge Function instances,
 * consider using Redis or Postgres advisory locks. This implementation provides
 * per-instance throttling which still significantly reduces 429 errors.
 * 
 * CANONICAL REFERENCE: All Browserless calls SHOULD route through this gate.
 */

// ============================================================================
// CONFIGURATION CONSTANTS
// ============================================================================

/** Minimum delay between Browserless calls (ms) */
export const MIN_DELAY_BETWEEN_CALLS_MS = 1500;

/** Backoff configuration for 429 retries */
export const BACKOFF_INITIAL_MS = 2000;
export const BACKOFF_MULTIPLIER = 2;
export const BACKOFF_MAX_MS = 20000;
export const MAX_RETRIES = 3;

/** Jitter range to prevent thundering herd (ms) */
export const JITTER_MIN_MS = 200;
export const JITTER_MAX_MS = 800;

// ============================================================================
// TYPES
// ============================================================================

export interface BrowserlessGateContext {
  requestId: string;
  platform?: string;
  searchId?: string;
  operation?: string;
}

export interface BrowserlessCallResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  isRateLimited: boolean;
  rateLimitReason?: 'browserless_429';
  attemptsMade: number;
  totalWaitMs: number;
  httpStatus?: number;
}

export interface BrowserlessRawResult {
  ok: boolean;
  status: number;
  body: string;
  error?: string;
}

// ============================================================================
// IN-PROCESS RATE LIMITER
// ============================================================================

/** Last successful Browserless call timestamp */
let lastCallTimestamp = 0;

/** Request queue for serialization */
const requestQueue: Array<{
  resolve: () => void;
  requestId: string;
}> = [];

let isProcessingQueue = false;

async function processQueue(): Promise<void> {
  if (isProcessingQueue) return;
  isProcessingQueue = true;
  
  while (requestQueue.length > 0) {
    const item = requestQueue.shift();
    if (!item) break;
    
    // Enforce minimum delay
    const now = Date.now();
    const timeSinceLastCall = now - lastCallTimestamp;
    if (timeSinceLastCall < MIN_DELAY_BETWEEN_CALLS_MS) {
      const waitTime = MIN_DELAY_BETWEEN_CALLS_MS - timeSinceLastCall;
      await new Promise(r => setTimeout(r, waitTime));
    }
    
    item.resolve();
  }
  
  isProcessingQueue = false;
}

async function acquireSlot(requestId: string): Promise<number> {
  const startWait = Date.now();
  
  return new Promise((resolve) => {
    requestQueue.push({
      resolve: () => {
        const waitMs = Date.now() - startWait;
        resolve(waitMs);
      },
      requestId,
    });
    processQueue();
  });
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function generateRequestId(): string {
  return `br_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function getJitter(): number {
  return Math.floor(Math.random() * (JITTER_MAX_MS - JITTER_MIN_MS + 1)) + JITTER_MIN_MS;
}

function calculateBackoff(attempt: number): number {
  const base = BACKOFF_INITIAL_MS * Math.pow(BACKOFF_MULTIPLIER, attempt - 1);
  const capped = Math.min(base, BACKOFF_MAX_MS);
  return capped + getJitter();
}

/**
 * Check if a response indicates rate limiting (HTTP 429).
 */
export function is429Response(status: number, body: string): boolean {
  if (status === 429) return true;
  
  const bodyLower = (body || '').toLowerCase();
  return (
    bodyLower.includes('429 too many requests') ||
    bodyLower.includes('too many requests') ||
    (bodyLower.includes('openresty') && bodyLower.includes('too many'))
  );
}

/**
 * Check if error/body indicates bot blocking (not rate limiting).
 */
export function isBotBlocked(body: string): boolean {
  const lower = (body || '').toLowerCase();
  return (
    lower.includes('captcha') ||
    lower.includes('please verify') ||
    lower.includes('access denied') ||
    lower.includes('unusual traffic') ||
    lower.includes('bot detected')
  );
}

// ============================================================================
// MAIN GATE WRAPPER
// ============================================================================

/**
 * Execute a Browserless call through the gate with 429 handling.
 * 
 * @param fn - The actual Browserless fetch function
 * @param parseResult - Function to parse the raw result
 * @param context - Context for logging
 * @returns Result with rate limiting info
 */
export async function withBrowserlessGate<T>(
  fn: () => Promise<BrowserlessRawResult>,
  parseResult: (raw: BrowserlessRawResult) => T,
  context: Partial<BrowserlessGateContext> = {}
): Promise<BrowserlessCallResult<T>> {
  const fullContext: BrowserlessGateContext = {
    requestId: context.requestId || generateRequestId(),
    platform: context.platform,
    searchId: context.searchId,
    operation: context.operation,
  };
  
  const result: BrowserlessCallResult<T> = {
    success: false,
    isRateLimited: false,
    attemptsMade: 0,
    totalWaitMs: 0,
  };
  
  console.log(`[BROWSERLESS_GATE] acquire_start requestId=${fullContext.requestId} platform=${fullContext.platform || 'unknown'} searchId=${fullContext.searchId || 'none'}`);
  
  // Step 1: Acquire slot (enforces minimum delay between calls)
  const waitMs = await acquireSlot(fullContext.requestId);
  result.totalWaitMs = waitMs;
  
  console.log(`[BROWSERLESS_GATE] acquire_ok waitMs=${waitMs} requestId=${fullContext.requestId}`);
  
  try {
    // Step 2: Execute with retry logic for 429
    let lastError: string | undefined;
    let lastStatus: number | undefined;
    
    for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
      result.attemptsMade = attempt;
      
      console.log(`[BROWSERLESS] attempt=${attempt} platform=${fullContext.platform} searchId=${fullContext.searchId}`);
      
      try {
        const raw = await fn();
        lastStatus = raw.status;
        result.httpStatus = raw.status;
        
        // Check for 429
        if (is429Response(raw.status, raw.body)) {
          if (attempt <= MAX_RETRIES) {
            const backoffMs = calculateBackoff(attempt);
            console.log(`[BROWSERLESS] rate_limited attempt=${attempt} backoffMs=${backoffMs}`);
            result.totalWaitMs += backoffMs;
            await new Promise(r => setTimeout(r, backoffMs));
            continue;
          } else {
            // Max retries exceeded
            console.error(`[BROWSERLESS] terminal rate_limited reason=browserless_429 attempts=${attempt}`);
            result.isRateLimited = true;
            result.rateLimitReason = 'browserless_429';
            result.error = 'Rate limited after max retries (HTTP 429)';
            return result;
          }
        }
        
        // Check for other non-OK responses
        if (!raw.ok && raw.status !== 200) {
          lastError = raw.error || `HTTP ${raw.status}`;
          console.log(`[BROWSERLESS] attempt=${attempt} status=${raw.status} error=${lastError?.slice(0, 100)}`);
          
          // Don't retry on non-429 errors
          result.error = lastError;
          return result;
        }
        
        // Success - update last call timestamp
        lastCallTimestamp = Date.now();
        
        console.log(`[BROWSERLESS] attempt=${attempt} status=${raw.status} success=true`);
        result.success = true;
        result.data = parseResult(raw);
        return result;
        
      } catch (e) {
        lastError = e instanceof Error ? e.message : 'Unknown error';
        console.error(`[BROWSERLESS] attempt=${attempt} error=${lastError}`);
        result.error = lastError;
        
        // Don't retry on exceptions (likely timeout or network issue)
        return result;
      }
    }
    
    // Should not reach here, but safety fallback
    result.error = lastError || 'Max attempts exceeded';
    return result;
    
  } finally {
    console.log(`[BROWSERLESS_GATE] release requestId=${fullContext.requestId}`);
  }
}

// ============================================================================
// EXTRACTION STATUS HELPERS
// ============================================================================

/**
 * Convert a rate_limited gate result to terminal extraction status.
 */
export function rateLimitedToExtractionStatus(): {
  extraction_status: string;
  extraction_error: string;
  outcome_category: string;
} {
  return {
    extraction_status: 'rate_limited',
    extraction_error: 'Browserless rate limited (HTTP 429) after max retries',
    outcome_category: 'service_error',
  };
}

/**
 * Check if a BrowserlessCallResult indicates rate limiting.
 */
export function isGateRateLimited<T>(result: BrowserlessCallResult<T>): boolean {
  return result.isRateLimited === true && result.rateLimitReason === 'browserless_429';
}

// ============================================================================
// STANDALONE HELPERS FOR INCREMENTAL ADOPTION
// ============================================================================

/**
 * Wrap a simple Browserless fetch with rate limiting detection and backoff.
 * Use this when you don't want to fully refactor an existing extractor.
 * 
 * Returns the original result with additional rate limiting metadata.
 */
export async function browserlessFetchWithBackoff(
  fetchFn: () => Promise<Response>,
  context: Partial<BrowserlessGateContext> = {}
): Promise<{
  response: Response | null;
  isRateLimited: boolean;
  rateLimitReason?: 'browserless_429';
  attemptsMade: number;
  error?: string;
}> {
  const requestId = context.requestId || generateRequestId();
  const result = {
    response: null as Response | null,
    isRateLimited: false,
    rateLimitReason: undefined as 'browserless_429' | undefined,
    attemptsMade: 0,
    error: undefined as string | undefined,
  };
  
  console.log(`[BROWSERLESS_GATE] acquire_start requestId=${requestId} platform=${context.platform || 'unknown'}`);
  
  // Enforce minimum delay
  const waitMs = await acquireSlot(requestId);
  console.log(`[BROWSERLESS_GATE] acquire_ok waitMs=${waitMs} requestId=${requestId}`);
  
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    result.attemptsMade = attempt;
    
    console.log(`[BROWSERLESS] attempt=${attempt} platform=${context.platform}`);
    
    try {
      const response = await fetchFn();
      
      if (response.status === 429) {
        if (attempt <= MAX_RETRIES) {
          const backoffMs = calculateBackoff(attempt);
          console.log(`[BROWSERLESS] rate_limited attempt=${attempt} backoffMs=${backoffMs}`);
          await new Promise(r => setTimeout(r, backoffMs));
          continue;
        } else {
          console.error(`[BROWSERLESS] terminal rate_limited reason=browserless_429 attempts=${attempt}`);
          result.isRateLimited = true;
          result.rateLimitReason = 'browserless_429';
          result.error = 'Rate limited after max retries (HTTP 429)';
          result.response = response;
          return result;
        }
      }
      
      // Success or non-429 error
      lastCallTimestamp = Date.now();
      result.response = response;
      
      console.log(`[BROWSERLESS] attempt=${attempt} status=${response.status} success=${response.ok}`);
      console.log(`[BROWSERLESS_GATE] release requestId=${requestId}`);
      return result;
      
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      console.error(`[BROWSERLESS] attempt=${attempt} error=${msg}`);
      result.error = msg;
      
      console.log(`[BROWSERLESS_GATE] release requestId=${requestId}`);
      return result;
    }
  }
  
  console.log(`[BROWSERLESS_GATE] release requestId=${requestId}`);
  return result;
}

/**
 * Check response body for rate limiting patterns.
 * Call this after getting a response to detect 429 in body.
 */
export function checkBodyForRateLimiting(body: string): boolean {
  return is429Response(0, body);
}
