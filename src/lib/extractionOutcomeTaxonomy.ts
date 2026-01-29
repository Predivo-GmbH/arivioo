/**
 * Extraction Outcome Taxonomy
 * 
 * CANONICAL SOURCE OF TRUTH for mapping extraction statuses to user-facing categories.
 * This module is shared by both Admin Dashboard and Frontend Search Results to ensure
 * consistent messaging across the entire application.
 * 
 * === OUTCOME CATEGORIES ===
 * A) PRICE_VERIFIED        - Price available and structurally verified
 * B) PRICE_UNVERIFIED      - Price available but not verified for dates
 * C) UNAVAILABLE_FOR_DATES - Found but sold out / unavailable for selected dates
 * D) REQUIRES_ACTION       - Found but needs user interaction (login, consent, confirmation)
 * E) ACCESS_BLOCKED        - Found but blocked by bot detection or rate limiting
 * F) PRICE_NOT_FOUND       - Found but couldn't extract price (unknown layout, missing element)
 * G) SERVICE_ERROR         - True internal error (non-2xx, timeout, provider failure)
 * H) PLATFORM_UNSUPPORTED  - Tier C / blocked platform
 * 
 * === USAGE ===
 * import { classifyOutcome, OUTCOME_DISPLAY } from '@/lib/extractionOutcomeTaxonomy';
 * const outcome = classifyOutcome(extractionStatus, extractionError, metadata);
 * const display = OUTCOME_DISPLAY[outcome.category];
 */

export type OutcomeCategory =
  | 'price_verified'
  | 'price_unverified'
  | 'unavailable_for_dates'
  | 'requires_action'
  | 'access_blocked'
  | 'price_not_found'
  | 'service_error'
  | 'platform_unsupported';

export interface OutcomeClassification {
  category: OutcomeCategory;
  /** Internal reason code for logging/debugging */
  reasonCode: string;
  /** Whether this is a terminal state (no retry possible) */
  isTerminal: boolean;
  /** Optional marker from extraction metadata (e.g., "sold out", "minimum stay") */
  marker?: string;
}

export interface OutcomeDisplay {
  /** User-facing label (short, friendly) */
  userLabel: string;
  /** User-facing message (detailed, helpful) */
  userMessage: string;
  /** Admin-facing label (technical but readable) */
  adminLabel: string;
  /** Icon suggestion for UI */
  iconType: 'calendar' | 'lock' | 'alert' | 'info' | 'error' | 'check' | 'warning';
  /** Severity for styling */
  severity: 'success' | 'warning' | 'error' | 'info' | 'muted';
}

// ============================================================================
// OUTCOME DISPLAY CONFIGURATION
// ============================================================================

export const OUTCOME_DISPLAY: Record<OutcomeCategory, OutcomeDisplay> = {
  price_verified: {
    userLabel: 'Verified',
    userMessage: 'Price verified for your dates including all taxes and fees.',
    adminLabel: 'Price Verified',
    iconType: 'check',
    severity: 'success',
  },
  price_unverified: {
    userLabel: 'Manual check recommended',
    userMessage: 'Price found but could not be verified for your exact dates.',
    adminLabel: 'Price Unverified',
    iconType: 'warning',
    severity: 'warning',
  },
  unavailable_for_dates: {
    userLabel: 'Not available for these dates',
    userMessage: 'Found on platform, but not available for your selected dates.',
    adminLabel: 'Unavailable for Dates',
    iconType: 'calendar',
    severity: 'info',
  },
  requires_action: {
    userLabel: 'Manual check needed',
    userMessage: 'Found, but the site requires a confirmation step to view the final price.',
    adminLabel: 'Requires User Action',
    iconType: 'info',
    severity: 'warning',
  },
  access_blocked: {
    userLabel: 'Temporarily blocked',
    userMessage: 'Found, but the site blocked automated access. Try again later.',
    adminLabel: 'Access Blocked',
    iconType: 'lock',
    severity: 'error',
  },
  price_not_found: {
    userLabel: 'Price not visible',
    userMessage: 'Found, but the price couldn\'t be read on the page.',
    adminLabel: 'Price Not Found',
    iconType: 'alert',
    severity: 'muted',
  },
  service_error: {
    userLabel: 'Temporary error',
    userMessage: 'Temporary error while retrieving the price.',
    adminLabel: 'Service Error',
    iconType: 'error',
    severity: 'error',
  },
  platform_unsupported: {
    userLabel: 'Platform not supported',
    userMessage: 'This platform is not currently supported for price comparison.',
    adminLabel: 'Platform Unsupported (Tier C)',
    iconType: 'info',
    severity: 'muted',
  },
};

// ============================================================================
// STATUS MAPPING RULES
// ============================================================================

/**
 * Status codes that indicate dates unavailable / sold out
 * These are NOT errors - they are valid terminal states
 */
const UNAVAILABLE_STATUSES = new Set([
  'dates_unavailable',
  'sold_out',
  'no_availability_for_dates',
  'expedia_dates_unavailable_for_target',
]);

/**
 * Status codes that indicate access was blocked (bot/CAPTCHA - hard block)
 */
const BLOCKED_STATUSES = new Set([
  'blocked_captcha_or_bot',
  'blocked_captcha',
  'bot_blocked_abort',
  'expedia_access_blocked',
]);

/**
 * Status codes that indicate temporary rate limiting (service_error, NOT blocked)
 * Rate limiting is transient and should be distinguished from hard bot blocks.
 */
const RATE_LIMITED_STATUSES = new Set([
  'rate_limited',
  'rate_limited_abort',
  'blocked_rate_limit',
  'browserless_429',
]);

/**
 * Status codes that indicate a service/infrastructure error
 * Includes retry budget exhaustion which maps to service_error
 */
const SERVICE_ERROR_STATUSES = new Set([
  'service_error',
  'timeout',
  'retry_budget_exhausted',
]);

/**
 * Status codes that indicate price could not be found on page
 * NOTE: checkout_link_not_found is categorized here because:
 * - The listing WAS found (verified via image matching)
 * - But we couldn't navigate to/find the checkout link to extract the price
 * - This is a "price not found" scenario, not a render failure or block
 */
const PRICE_NOT_FOUND_STATUSES = new Set([
  'price_not_found',
  'price_not_found_after_dates_applied',
  'checkout_link_not_found',           // Agoda: could not find /book/ link on hotel page
  'total_price_not_found',             // Agoda: checkout page reached but no price
  'checkout_page_not_reached',         // Agoda: could not navigate to checkout page
  'hotel_page_not_reached',            // Agoda: could not reach hotel page at all
  'page_not_reached',                  // Generic: page navigation failed
  'navigation_failed',                 // Generic: navigation failure
  'expedia_target_offer_not_found',
  'expedia_target_offer_mismatch',
  'expedia_target_total_not_found',
  'expedia_total_not_found',
  'expedia_total_not_found_on_offers_page',
  'property_id_not_found',
]);

/**
 * Status codes that indicate page rendering/loading failed
 */
const RENDER_FAILED_STATUSES = new Set([
  'render_failed',
  'expedia_offers_page_not_reached',
  'offers_page_not_loaded',
  'checkout_not_reached',
]);

/**
 * Status codes that indicate user action is required
 */
const REQUIRES_ACTION_STATUSES = new Set([
  'needs_user_confirmation',
  'subtotal_rejected',
  'dates_not_applied',
  'date_application_failed',
]);

/**
 * Status codes that indicate platform is unsupported
 */
const UNSUPPORTED_STATUSES = new Set([
  'platform_unsupported',
  'blocked',
]);

// ============================================================================
// CLASSIFICATION FUNCTION
// ============================================================================

/**
 * Classify an extraction outcome into a canonical category
 * 
 * @param extractionStatus - The extraction_status field from price_extractions
 * @param extractionError - The extraction_error field (optional)
 * @param metadata - Additional metadata (e.g., unavailability_marker, coverage_tier)
 * @returns OutcomeClassification with category, reasonCode, and terminal flag
 */
export function classifyOutcome(
  extractionStatus: string | null,
  extractionError: string | null = null,
  metadata: {
    coverageTier?: string | null;
    unavailabilityMarker?: string | null;
    priceStatus?: 'verified' | 'unverified' | 'unavailable' | null;
    hasPrice?: boolean;
  } = {}
): OutcomeClassification {
  const rawStatus = extractionStatus?.toLowerCase() || '';
  const error = extractionError?.toLowerCase() || '';

  // Some backends persist a generic status like "extraction_error" but embed the real terminal
  // outcome inside the error payload (e.g. HTTP 422 JSON with { status: "dates_unavailable" }).
  // This is classification-only: we do NOT change extraction logic; we just decode meaning.
  const parseEmbeddedStatus = (
    err: string | null
  ): { embeddedStatus: string | null; embeddedMarker: string | null } => {
    if (!err) return { embeddedStatus: null, embeddedMarker: null };

    // Try to parse JSON substring in strings like: "HTTP 422: {...}" or plain "{...}".
    try {
      const start = err.indexOf('{');
      const end = err.lastIndexOf('}');
      if (start >= 0 && end > start) {
        const jsonStr = err.slice(start, end + 1);
        const parsed = JSON.parse(jsonStr);
        const embeddedStatus = typeof parsed?.status === 'string' ? parsed.status.toLowerCase() : null;
        const embeddedMarker =
          typeof parsed?.structuralProof?.unavailability_marker === 'string'
            ? parsed.structuralProof.unavailability_marker
            : null;
        return { embeddedStatus, embeddedMarker };
      }
    } catch {
      // ignore
    }

    // Heuristic fallbacks for non-JSON errors
    if (err.toLowerCase().includes('dates unavailable')) return { embeddedStatus: 'dates_unavailable', embeddedMarker: 'sold out' };
    if (err.toLowerCase().includes('sold out')) return { embeddedStatus: 'dates_unavailable', embeddedMarker: 'sold out' };

    return { embeddedStatus: null, embeddedMarker: null };
  };

  const { embeddedStatus, embeddedMarker } = parseEmbeddedStatus(extractionError);
  const status = (embeddedStatus && (rawStatus === 'extraction_error' || rawStatus === 'internal_error' || rawStatus === 'validation_error'))
    ? embeddedStatus
    : rawStatus;

  // Prefer explicit marker passed by caller; fall back to embedded marker.
  const unavailabilityMarker = metadata.unavailabilityMarker ?? embeddedMarker;

  // 1. Platform unsupported (Tier C)
  if (metadata.coverageTier === 'C' || UNSUPPORTED_STATUSES.has(status)) {
    return {
      category: 'platform_unsupported',
      reasonCode: status || 'tier_c',
      isTerminal: true,
    };
  }

  // 2. Success states - check verification status
  // success_total_stay is the VRBO golden path success status - treat as verified
  if (status === 'success' || status === 'price_extracted' || status === 'success_total_stay') {
    if (metadata.priceStatus === 'verified' || status === 'success_total_stay') {
      return {
        category: 'price_verified',
        reasonCode: status === 'success_total_stay' ? 'vrbo_total_verified' : 'success_verified',
        isTerminal: true,
      };
    }
    // Success but unverified
    if (metadata.hasPrice !== false) {
      return {
        category: 'price_unverified',
        reasonCode: 'success_unverified',
        isTerminal: true,
      };
    }
  }

  // 2b. Unverified status - price found but not TOTAL_PROVEN (Booking.com gate)
  // Maps to price_unverified which renders in not_comparable bucket
  if (status === 'unverified') {
    return {
      category: 'price_unverified',
      reasonCode: 'total_not_proven',
      isTerminal: true,
    };
  }

  // 3. Dates unavailable / sold out (NOT an error)
  if (UNAVAILABLE_STATUSES.has(status) || (unavailabilityMarker && unavailabilityMarker.toLowerCase().includes('sold out'))) {
    return {
      category: 'unavailable_for_dates',
      reasonCode: status || 'dates_unavailable',
      isTerminal: true,
      marker: unavailabilityMarker || undefined,
    };
  }

  // 4. Service errors (timeout, retry exhaustion)
  if (SERVICE_ERROR_STATUSES.has(status)) {
    return {
      category: 'service_error',
      reasonCode: status,
      isTerminal: true,
    };
  }

  // 4a. Rate limited (service_error - temporary, NOT hard block)
  if (RATE_LIMITED_STATUSES.has(status)) {
    return {
      category: 'service_error',
      reasonCode: 'rate_limited',
      isTerminal: true,
    };
  }
  // Also check error message for rate limit indicators
  if (error.includes('rate limit') || error.includes('429')) {
    return {
      category: 'service_error',
      reasonCode: 'rate_limited',
      isTerminal: true,
    };
  }

  // 4b. Access blocked (bot/CAPTCHA - hard block)
  if (BLOCKED_STATUSES.has(status)) {
    return {
      category: 'access_blocked',
      reasonCode: status,
      isTerminal: true,
    };
  }
  // Also check error message for block indicators
  if (error.includes('captcha') || error.includes('bot') || error.includes('blocked')) {
    return {
      category: 'access_blocked',
      reasonCode: 'error_blocked',
      isTerminal: true,
    };
  }

  // 5. Requires user action
  if (REQUIRES_ACTION_STATUSES.has(status)) {
    return {
      category: 'requires_action',
      reasonCode: status,
      isTerminal: false,
    };
  }

  // 6. Price not found on page
  if (PRICE_NOT_FOUND_STATUSES.has(status)) {
    return {
      category: 'price_not_found',
      reasonCode: status,
      isTerminal: true,
    };
  }

  // 7. Render/page load failed
  if (RENDER_FAILED_STATUSES.has(status)) {
    return {
      category: 'service_error',
      reasonCode: status,
      isTerminal: true,
    };
  }

  // 8. Provider errors (timeouts, 4xx/5xx)
  if (error.includes('timeout') || error.includes('timed out')) {
    return {
      category: 'service_error',
      reasonCode: 'timeout',
      isTerminal: false,
    };
  }
  if (error.includes('zyte error') || error.includes('firecrawl error') || error.includes('provider')) {
    return {
      category: 'service_error',
      reasonCode: 'provider_error',
      isTerminal: false,
    };
  }
  if (error.includes('500') || error.includes('502') || error.includes('503') || error.includes('504')) {
    return {
      category: 'service_error',
      reasonCode: 'server_error',
      isTerminal: false,
    };
  }

  // 9. Validation errors
  if (status === 'validation_error' || status === 'internal_error') {
    return {
      category: 'service_error',
      reasonCode: status,
      isTerminal: true,
    };
  }

  // 10. Pending/not attempted
  if (status === 'pending' || status === 'not_attempted' || !status) {
    return {
      category: 'price_not_found',
      reasonCode: status || 'unknown',
      isTerminal: false,
    };
  }

  // Fallback for unknown statuses
  return {
    category: 'service_error',
    reasonCode: status || 'unknown',
    isTerminal: true,
  };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get user-friendly display text for an outcome
 */
export function getOutcomeUserLabel(outcome: OutcomeClassification): string {
  const display = OUTCOME_DISPLAY[outcome.category];
  
  // Add specific marker for unavailable dates (e.g., "Sold out for these dates")
  if (outcome.category === 'unavailable_for_dates' && outcome.marker) {
    const marker = outcome.marker.toLowerCase();
    if (marker.includes('sold out')) {
      return 'Sold out for these dates';
    }
    if (marker.includes('minimum stay')) {
      return 'Minimum stay not met';
    }
    if (marker.includes('maximum stay')) {
      return 'Maximum stay exceeded';
    }
  }
  
  return display.userLabel;
}

/**
 * Get admin-friendly display text for an outcome
 */
export function getOutcomeAdminLabel(outcome: OutcomeClassification): string {
  const display = OUTCOME_DISPLAY[outcome.category];
  
  // Add specific marker for unavailable dates
  if (outcome.category === 'unavailable_for_dates' && outcome.marker) {
    const marker = outcome.marker.toLowerCase();
    if (marker.includes('sold out')) {
      return 'Sold Out for Dates';
    }
    if (marker.includes('minimum stay')) {
      return 'Minimum Stay Not Met';
    }
  }
  
  return display.adminLabel;
}

/**
 * Get full user-facing message for an outcome
 */
export function getOutcomeUserMessage(outcome: OutcomeClassification, platformName?: string): string {
  const platform = platformName || 'this platform';
  
  switch (outcome.category) {
    case 'unavailable_for_dates':
      if (outcome.marker?.toLowerCase().includes('sold out')) {
        return `Found on ${platform}, but sold out for your selected dates.`;
      }
      if (outcome.marker?.toLowerCase().includes('minimum stay')) {
        return `Found on ${platform}, but minimum stay requirement not met.`;
      }
      return `Found on ${platform}, but not available for your selected dates.`;
    
    case 'access_blocked':
      return `Found on ${platform}, but the site blocked automated access. Try viewing directly.`;
    
    case 'price_not_found':
      return `Found on ${platform}, but the price couldn't be read on the page. Try viewing directly.`;
    
    case 'requires_action':
      return `Found on ${platform}, but requires confirmation to see the final price.`;
    
    case 'service_error':
      return `Temporary error while checking ${platform}. Try again later.`;
    
    default:
      return OUTCOME_DISPLAY[outcome.category].userMessage;
  }
}

// ============================================================================
// LEGACY COMPATIBILITY EXPORTS
// ============================================================================

/**
 * Legacy failure category labels for backward compatibility
 * Maps old category names to new taxonomy
 */
export const FAILURE_CATEGORY_LABELS: Record<string, string> = {
  // Map old categories to new user labels
  'provider_error': 'Temporary error',
  'blocked': 'Temporarily blocked',
  'rate_limited': 'Temporarily blocked',
  'dates_not_applied': 'Manual check needed',
  'sold_out': 'Not available for these dates',
  'unsupported': 'Platform not supported',
  'render_failed': 'Temporary error',
  'price_not_visible': 'Price not visible',
  'unknown': 'Manual check needed',
  // Direct status mappings
  'dates_unavailable': 'Not available for these dates',
  'blocked_captcha_or_bot': 'Temporarily blocked',
  'blocked_rate_limit': 'Temporarily blocked',
  'expedia_dates_unavailable_for_target': 'Not available for these dates',
  'expedia_access_blocked': 'Temporarily blocked',
  'expedia_target_offer_not_found': 'Price not visible',
  'expedia_target_total_not_found': 'Price not visible',
  // Agoda-specific statuses (checkout discovery failures)
  'checkout_link_not_found': 'Price not visible',
  'total_price_not_found': 'Price not visible',
  'checkout_page_not_reached': 'Price not visible',
  'missing_checkout_link': 'Price not visible',
};
