/**
 * TIER-A PLATFORM RETRY POLICY
 * 
 * Automatic retry system for Tier-A platforms (Agoda, Booking.com).
 * Treats transient navigation/extraction failures as retryable with bounded attempts.
 * 
 * CANONICAL CONTRACT:
 * - Max 4 attempts per platform per search
 * - Backoff: 2s, 5s, 10s with jitter (500-1500ms)
 * - Each retry MUST use fresh Browserless context (enforced by caller)
 * - Finalization is blocked while retries remain for transient failures
 * 
 * CLASSIFICATION:
 * - TRANSIENT: checkout_link_not_found, vat_excluded_checkout_failed, browserless_429, timeout, navigation_failed
 * - HARD_TERMINAL: sold_out, unavailable_for_dates, blocked, captcha, platform_blocked, invalid_url
 * - SUCCESS: success_total_stay, success
 */

// =============================================================================
// CONFIGURATION CONSTANTS
// =============================================================================

/** Maximum retry attempts for Tier-A platforms (including initial attempt) */
export const MAX_TIER_A_ATTEMPTS = 4;

/** Backoff delays in milliseconds (used after attempt 1, 2, 3) */
export const BACKOFF_DELAYS_MS = [2000, 5000, 10000];

/** Jitter range in milliseconds */
export const JITTER_MIN_MS = 500;
export const JITTER_MAX_MS = 1500;

// =============================================================================
// FAILURE CLASSIFICATION
// =============================================================================

export type FailureClassification = 'TRANSIENT' | 'HARD_TERMINAL' | 'SUCCESS';

/**
 * Status values that indicate SUCCESS - no retry needed, extraction complete
 */
const SUCCESS_STATUSES = new Set([
  'success',
  'success_total_stay',
  'price_extracted',
  'completed',
]);

/**
 * Status values that indicate HARD TERMINAL - no retry will help
 */
const HARD_TERMINAL_STATUSES = new Set([
  // Sold out / unavailable
  'sold_out',
  'dates_unavailable',
  'unavailable_for_dates',
  'expedia_dates_unavailable_for_target',
  
  // Explicit blocking
  'blocked',
  'blocked_captcha_or_bot',
  'bot_detected',
  'access_denied',
  'platform_blocked',
  'captcha',
  
  // Invalid input
  'validation_error',
  'invalid_url',
  'unsupported',
  
  // Quota exhaustion (distinct from rate limiting)
  'quota_error',
  'quota_exhausted',
]);

/**
 * Status values that indicate TRANSIENT failure - retry may help
 */
const TRANSIENT_STATUSES = new Set([
  // Agoda-specific transient failures
  'checkout_link_not_found',
  'checkout_page_not_reached',
  'hotel_page_not_reached',
  'total_price_not_found',
  
  // Booking-specific transient failures
  'vat_excluded_checkout_failed',
  'unverified', // Structural checks failed - may pass on retry
  
  // Generic transient failures
  'rate_limited',
  'blocked_rate_limit',
  'browserless_429',
  'timeout',
  'render_failed',
  'navigation_failed',
  'click_failed',
  'price_not_found',
  'page_not_reached',
  
  // Pending states (should not reach retry logic, but classify as transient)
  'pending',
  'running',
  'in_progress',
]);

/**
 * Error messages that indicate TRANSIENT failure (for cases where status is generic)
 */
const TRANSIENT_ERROR_PATTERNS = [
  /checkout.?link.?not.?found/i,
  /booking.?button.?not.?found/i,
  /no.?booking.?button/i,
  /navigation.?failed/i,
  /click.?failed/i,
  /timeout/i,
  /timed.?out/i,
  /rate.?limit/i,
  /429/i,
  /vat.*checkout.*fail/i,
  /checkout.*fail/i,
  /dom.*not.*found/i,
  /element.*not.*found/i,
];

/**
 * Error messages that indicate HARD TERMINAL failure
 */
const HARD_TERMINAL_ERROR_PATTERNS = [
  /sold.?out/i,
  /unavailable/i,
  /captcha/i,
  /blocked/i,
  /access.?denied/i,
  /invalid.?url/i,
  /quota/i,
];

/**
 * Classify an extraction outcome as TRANSIENT, HARD_TERMINAL, or SUCCESS
 * 
 * @param status - The extraction_status from price_extractions
 * @param errorMessage - Optional error message for additional context
 * @param extractedPrice - Optional extracted price (success indicator)
 */
export function classifyTierAFailure(
  status: string | null | undefined,
  errorMessage: string | null | undefined,
  extractedPrice: number | null | undefined
): FailureClassification {
  const normalizedStatus = (status || '').toLowerCase().trim();
  const normalizedError = (errorMessage || '').toLowerCase();
  
  // CRITICAL: Check for TRANSIENT first before SUCCESS to handle cases like:
  // - status="unverified" with price - VAT/structural checks failed
  // - status has failed_checks indicating retryable issues
  
  // TRANSIENT: Known transient status takes priority (even if price exists)
  // This ensures "unverified" with price is still retried for proper verification
  if (TRANSIENT_STATUSES.has(normalizedStatus)) {
    return 'TRANSIENT';
  }
  
  // Check error message for transient VAT/checkout failures
  // These indicate the price was found but not properly verified
  const transientVatPatterns = [
    /vat.*checkout.*fail/i,
    /taxes.*fees.*not.*confirm/i,
    /taxes_fees_not_confirmed/i,
    /vat_excluded_checkout_failed/i,
    /checkout.*proof.*fail/i,
    /structural.*check.*fail/i,
    /failed_checks.*vat/i,
    /failed_checks.*taxes/i,
  ];
  
  for (const pattern of transientVatPatterns) {
    if (pattern.test(normalizedError)) {
      console.log(`[TIER_A_CLASSIFY] TRANSIENT due to VAT/checkout failure pattern in error: "${normalizedError.slice(0, 100)}"`);
      return 'TRANSIENT';
    }
  }
  
  // SUCCESS: Valid price extracted with explicit success status
  if (SUCCESS_STATUSES.has(normalizedStatus) && extractedPrice && extractedPrice > 0) {
    return 'SUCCESS';
  }
  
  // HARD_TERMINAL: Explicit terminal status
  if (HARD_TERMINAL_STATUSES.has(normalizedStatus)) {
    return 'HARD_TERMINAL';
  }
  
  // Check error patterns for HARD_TERMINAL
  for (const pattern of HARD_TERMINAL_ERROR_PATTERNS) {
    if (pattern.test(normalizedError)) {
      // But exclude rate limiting - that's transient
      if (/rate.?limit|429/i.test(normalizedError)) {
        return 'TRANSIENT';
      }
      return 'HARD_TERMINAL';
    }
  }
  
  // Check error patterns for TRANSIENT
  for (const pattern of TRANSIENT_ERROR_PATTERNS) {
    if (pattern.test(normalizedError)) {
      return 'TRANSIENT';
    }
  }
  
  // Unknown status with no price = TRANSIENT (give it another chance)
  if (!extractedPrice || extractedPrice <= 0) {
    return 'TRANSIENT';
  }
  
  // Has price but unknown status - still treat as TRANSIENT for Tier-A
  // because unknown status means we couldn't verify the price is truly comparable
  // (e.g., missing structural proof, VAT not confirmed)
  console.log(`[TIER_A_CLASSIFY] Unknown status "${normalizedStatus}" with price ${extractedPrice} - treating as TRANSIENT for verification`);
  return 'TRANSIENT';
}

/**
 * Check if a Tier-A extraction should be retried
 * 
 * @param status - Current extraction status
 * @param errorMessage - Current error message
 * @param extractedPrice - Current extracted price (if any)
 * @param currentAttempt - Current attempt number (1-indexed)
 */
export function shouldRetryTierA(
  status: string | null | undefined,
  errorMessage: string | null | undefined,
  extractedPrice: number | null | undefined,
  currentAttempt: number
): { shouldRetry: boolean; reason: string } {
  const classification = classifyTierAFailure(status, errorMessage, extractedPrice);
  
  if (classification === 'SUCCESS') {
    return { shouldRetry: false, reason: 'success' };
  }
  
  if (classification === 'HARD_TERMINAL') {
    return { shouldRetry: false, reason: `hard_terminal:${status}` };
  }
  
  // TRANSIENT - check if retries remain
  if (currentAttempt >= MAX_TIER_A_ATTEMPTS) {
    return { shouldRetry: false, reason: `retry_budget_exhausted:${currentAttempt}/${MAX_TIER_A_ATTEMPTS}` };
  }
  
  return { shouldRetry: true, reason: `transient:${status || 'unknown'}` };
}

/**
 * Calculate the backoff delay for a retry attempt
 * 
 * @param attemptNumber - The attempt number (1-indexed, next attempt to run)
 * @returns Delay in milliseconds (including jitter)
 */
export function calculateBackoffDelay(attemptNumber: number): number {
  // attemptNumber is 1-indexed, so attempt 2 uses BACKOFF_DELAYS_MS[0] = 2000ms
  const delayIndex = Math.min(attemptNumber - 1, BACKOFF_DELAYS_MS.length - 1);
  const baseDelay = BACKOFF_DELAYS_MS[delayIndex] || BACKOFF_DELAYS_MS[BACKOFF_DELAYS_MS.length - 1];
  
  // Add jitter
  const jitter = JITTER_MIN_MS + Math.random() * (JITTER_MAX_MS - JITTER_MIN_MS);
  
  return Math.round(baseDelay + jitter);
}

/**
 * Create a structured log entry for retry events
 */
export function logRetryEvent(
  platform: 'agoda' | 'booking',
  searchId: string | null,
  extractionId: string | null,
  attemptNumber: number,
  status: string | null,
  classification: FailureClassification,
  action: 'retry_scheduled' | 'retry_starting' | 'retry_budget_exhausted' | 'hard_terminal' | 'success',
  delayMs?: number
): void {
  const logData = {
    platform,
    searchId: searchId || 'unknown',
    extractionId: extractionId || 'unknown',
    attempt: attemptNumber,
    maxAttempts: MAX_TIER_A_ATTEMPTS,
    status,
    classification,
    action,
    delayMs,
  };
  
  console.log(`[TIER_A_RETRY] ${JSON.stringify(logData)}`);
}

/**
 * Helper to determine if a platform is Tier-A (eligible for automatic retry)
 */
export function isTierAPlatform(platformName: string): boolean {
  const normalized = platformName.toLowerCase();
  return normalized.includes('agoda') || normalized.includes('booking');
}

/**
 * Get the final status when retry budget is exhausted
 * Maps the last transient failure to an appropriate terminal status
 */
export function getRetryExhaustedStatus(lastStatus: string | null): string {
  // Map to service_error to indicate infrastructure/transient issue
  // This is distinct from hard terminal statuses
  return 'service_error';
}

/**
 * Build error message for retry budget exhaustion
 */
export function buildRetryExhaustedError(
  platform: string,
  lastStatus: string | null,
  attempts: number
): string {
  return `Tier-A retry budget exhausted: ${platform} failed after ${attempts} attempts (last_status=${lastStatus || 'unknown'})`;
}

// =============================================================================
// ASYNC RETRY EXECUTOR
// =============================================================================

export interface RetryExecutorOptions<T> {
  platform: 'agoda' | 'booking';
  searchId: string | null;
  extractionId: string | null;
  /**
   * The extraction function to execute.
   * Must return an object with { status, error, extractedPrice } at minimum.
   */
  execute: () => Promise<T>;
  /**
   * Extract the relevant fields from the result for classification
   */
  getResultFields: (result: T) => {
    status: string | null;
    error: string | null;
    extractedPrice: number | null;
  };
}

/**
 * Execute a Tier-A extraction with automatic retries
 * 
 * This wrapper handles the retry loop, backoff delays, and logging.
 * The caller is responsible for ensuring each execution uses a fresh Browserless context.
 */
export async function executeWithTierARetry<T>(
  options: RetryExecutorOptions<T>
): Promise<{ result: T; attempts: number; exhaustedBudget: boolean }> {
  const { platform, searchId, extractionId, execute, getResultFields } = options;
  
  let lastResult: T | null = null;
  let attempts = 0;
  
  while (attempts < MAX_TIER_A_ATTEMPTS) {
    attempts++;
    
    if (attempts > 1) {
      // Calculate and apply backoff delay
      const delayMs = calculateBackoffDelay(attempts);
      logRetryEvent(platform, searchId, extractionId, attempts, null, 'TRANSIENT', 'retry_starting', delayMs);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    
    // Execute the extraction
    const result = await execute();
    lastResult = result;
    
    // Classify the result
    const { status, error, extractedPrice } = getResultFields(result);
    const classification = classifyTierAFailure(status, error, extractedPrice);
    
    // Check if we should retry
    const { shouldRetry, reason } = shouldRetryTierA(status, error, extractedPrice, attempts);
    
    if (!shouldRetry) {
      if (classification === 'SUCCESS') {
        logRetryEvent(platform, searchId, extractionId, attempts, status, classification, 'success');
      } else if (classification === 'HARD_TERMINAL') {
        logRetryEvent(platform, searchId, extractionId, attempts, status, classification, 'hard_terminal');
      } else {
        logRetryEvent(platform, searchId, extractionId, attempts, status, classification, 'retry_budget_exhausted');
      }
      
      return {
        result,
        attempts,
        exhaustedBudget: classification === 'TRANSIENT' && attempts >= MAX_TIER_A_ATTEMPTS,
      };
    }
    
    // Schedule retry
    logRetryEvent(platform, searchId, extractionId, attempts, status, classification, 'retry_scheduled', calculateBackoffDelay(attempts + 1));
  }
  
  // Should not reach here, but handle gracefully
  return {
    result: lastResult!,
    attempts,
    exhaustedBudget: true,
  };
}
