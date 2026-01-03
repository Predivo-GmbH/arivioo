/**
 * ACCESS FAILURE CLASSIFIER
 * 
 * Deterministic classification of access-layer failures.
 * Used to enforce hard stop behavior - NO fallback scrapers after rate limiting or bot blocking.
 * 
 * CANONICAL REFERENCE: All extraction pipelines must use this classifier.
 */

// Stable enum for access-layer failure classification
export type AccessFailureClass = 
  | 'RATE_LIMITED'      // HTTP 429, explicit rate limit messages
  | 'BOT_BLOCKED'       // CAPTCHA, WAF, "Are you human" challenges
  | 'NAVIGATION_FAILED' // DNS, connection errors, timeouts
  | 'PARSING_FAILED'    // Content received but couldn't parse
  | 'NONE';             // No access-layer failure detected

export interface AccessFailureResult {
  failureClass: AccessFailureClass;
  shouldAbortFallbacks: boolean;  // True if no more providers should be tried
  httpStatus: number | null;
  responseSize: number;
  evidence: string[];             // Human-readable evidence for diagnostics
}

/**
 * Classify access-layer failure from HTTP response and error context.
 * 
 * IMPORTANT: This function MUST be deterministic. Given the same inputs,
 * it must always return the same classification.
 */
export function classifyAccessFailure(
  httpStatus: number | null,
  responseBody: string | null,
  errorMessage: string | null
): AccessFailureResult {
  const result: AccessFailureResult = {
    failureClass: 'NONE',
    shouldAbortFallbacks: false,
    httpStatus,
    responseSize: responseBody?.length ?? 0,
    evidence: [],
  };

  const bodyLower = (responseBody ?? '').toLowerCase();
  const errorLower = (errorMessage ?? '').toLowerCase();
  const combinedLower = `${bodyLower} ${errorLower}`;

  // ============= RATE_LIMITED Detection (Highest Priority) =============
  // HTTP 429 is the canonical rate limit status
  if (httpStatus === 429) {
    result.failureClass = 'RATE_LIMITED';
    result.shouldAbortFallbacks = true;
    result.evidence.push('HTTP 429 Too Many Requests');
    return result;
  }

  // Explicit 429 indicators in body or error
  const rateLimitPatterns = [
    '429 too many requests',
    'too many requests',
    'rate limit exceeded',
    'rate limited',
    'request limit exceeded',
    'throttled',
    'slow down',
  ];

  for (const pattern of rateLimitPatterns) {
    if (combinedLower.includes(pattern)) {
      result.failureClass = 'RATE_LIMITED';
      result.shouldAbortFallbacks = true;
      result.evidence.push(`Rate limit pattern: "${pattern}"`);
      return result;
    }
  }

  // ============= BOT_BLOCKED Detection =============
  // CAPTCHA and human verification challenges
  const botBlockPatterns = [
    { pattern: 'captcha', label: 'CAPTCHA challenge' },
    { pattern: 'please complete the security check', label: 'Security check' },
    { pattern: 'verify you are human', label: 'Human verification' },
    { pattern: 'verify you\'re human', label: 'Human verification' },
    { pattern: 'are you a robot', label: 'Robot check' },
    { pattern: 'enable cookies', label: 'Cookie requirement' },
    { pattern: 'enable javascript', label: 'JavaScript requirement' },
    { pattern: 'access denied', label: 'Access denied' },
    { pattern: 'access to this page has been denied', label: 'Access denied' },
    { pattern: 'forbidden', label: 'Forbidden' },
    { pattern: 'cloudflare', label: 'Cloudflare protection' },
    { pattern: 'ray id', label: 'Cloudflare Ray ID' },
    { pattern: 'checking your browser', label: 'Browser check' },
    { pattern: 'just a moment', label: 'Cloudflare wait page' },
    { pattern: 'unusual traffic', label: 'Unusual traffic detection' },
    { pattern: 'automated access', label: 'Automated access block' },
    { pattern: 'bot detected', label: 'Bot detection' },
  ];

  for (const { pattern, label } of botBlockPatterns) {
    if (combinedLower.includes(pattern)) {
      result.failureClass = 'BOT_BLOCKED';
      result.shouldAbortFallbacks = true;
      result.evidence.push(label);
      // Don't return - collect all evidence
    }
  }

  if (result.failureClass === 'BOT_BLOCKED') {
    return result;
  }

  // HTTP 403/401 often indicate bot blocking
  if (httpStatus === 403 || httpStatus === 401) {
    result.failureClass = 'BOT_BLOCKED';
    result.shouldAbortFallbacks = true;
    result.evidence.push(`HTTP ${httpStatus} (likely bot block)`);
    return result;
  }

  // Very small HTML payload often indicates a block page
  if (responseBody && responseBody.length < 1000 && responseBody.length > 0) {
    // Only flag as blocked if it looks like HTML
    if (bodyLower.includes('<html') || bodyLower.includes('<!doctype')) {
      result.failureClass = 'BOT_BLOCKED';
      result.shouldAbortFallbacks = true;
      result.evidence.push(`Minimal HTML response (${responseBody.length} bytes) - likely block page`);
      return result;
    }
  }

  // ============= NAVIGATION_FAILED Detection =============
  const navigationFailPatterns = [
    'timeout',
    'timed out',
    'connection refused',
    'connection reset',
    'dns lookup failed',
    'network error',
    'fetch failed',
    'econnrefused',
    'enotfound',
    'etimedout',
    'socket hang up',
  ];

  for (const pattern of navigationFailPatterns) {
    if (combinedLower.includes(pattern)) {
      result.failureClass = 'NAVIGATION_FAILED';
      result.shouldAbortFallbacks = false; // Allow fallback for transient failures
      result.evidence.push(`Navigation failure: "${pattern}"`);
      return result;
    }
  }

  // HTTP 5xx server errors
  if (httpStatus && httpStatus >= 500 && httpStatus < 600) {
    result.failureClass = 'NAVIGATION_FAILED';
    result.shouldAbortFallbacks = false; // Server errors are transient
    result.evidence.push(`HTTP ${httpStatus} server error`);
    return result;
  }

  // ============= PARSING_FAILED Detection =============
  // Content was received but we couldn't parse it
  if (responseBody && responseBody.length > 1000) {
    // We have substantial content - if caller reports error, it's a parsing issue
    if (errorMessage && (
      errorLower.includes('parse') ||
      errorLower.includes('invalid') ||
      errorLower.includes('unexpected')
    )) {
      result.failureClass = 'PARSING_FAILED';
      result.shouldAbortFallbacks = false;
      result.evidence.push(`Parsing error: ${errorMessage.slice(0, 100)}`);
      return result;
    }
  }

  return result;
}

/**
 * Check if the failure class indicates an access-layer hard stop.
 * When this returns true, NO fallback providers should be attempted.
 */
export function isAccessLayerHardStop(failureClass: AccessFailureClass): boolean {
  return failureClass === 'RATE_LIMITED' || failureClass === 'BOT_BLOCKED';
}

/**
 * Map access failure class to terminal extraction status.
 */
export function accessFailureToTerminalStatus(failureClass: AccessFailureClass): string {
  switch (failureClass) {
    case 'RATE_LIMITED':
      return 'blocked_rate_limit';
    case 'BOT_BLOCKED':
      return 'blocked_captcha_or_bot';
    case 'NAVIGATION_FAILED':
      return 'render_failed';
    case 'PARSING_FAILED':
      return 'extraction_error';
    default:
      return 'extraction_error';
  }
}
