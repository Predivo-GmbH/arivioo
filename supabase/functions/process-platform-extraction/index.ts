import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  detectVariant,
  buildFlowSignature,
  registerVariant,
  classifyFailureForVariant,
  type ExtractionFlowSignature,
  type VariantDetectionResult,
} from '../_shared/coverageVariantDetector.ts';
import { normalizeToAdapterDomain } from '../_shared/platformNameNormalizer.ts';
// Secure CORS - Domain allowlist
const ALLOWED_ORIGINS = [
  'https://lovable.dev',
  'https://www.lovable.dev',
  /^https:\/\/[a-zA-Z0-9-]+\.lovable\.app$/,
  /^https:\/\/[a-zA-Z0-9-]+\.lovableproject\.com$/,
  /^https:\/\/id-preview--[a-zA-Z0-9-]+\.lovable\.app$/,
  'https://arivioo.lovable.app',
  'https://arivioo.com',
  'https://www.arivioo.com',
];

function isOriginAllowed(origin: string | null): boolean {
  if (!origin) return false;
  return ALLOWED_ORIGINS.some(allowed => {
    if (typeof allowed === 'string') return origin === allowed;
    return allowed.test(origin);
  });
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Terminal status values - worker MUST end in one of these
const TERMINAL_STATUSES = [
  'success',
  'dates_not_applied',
  'no_availability_for_dates',
  'blocked_captcha_or_bot',
  'blocked_rate_limit',
  'render_failed',
  'listing_unavailable',
  'price_not_found_after_dates_applied',
  'total_not_available_pre_checkout',
  'validation_error',
  'extraction_error',
  'timeout',
  'platform_unsupported',  // Tier C platforms
] as const;

type TerminalStatus = typeof TERMINAL_STATUSES[number];

// Coverage tier definitions
type CoverageTier = 'A' | 'B' | 'C';

interface TierConfig {
  useDedicatedExtractor: boolean;
  attemptExtraction: boolean;
  failureReason?: string;
}

interface WorkerRequest {
  extractionId: string;
  requestedCheckIn: string;
  requestedCheckOut: string;
}

interface WorkerResult {
  extractionId: string;
  platform: string;
  phaseA: {
    ran: boolean;
    datesValidated: boolean;
    detectedCheckIn: string | null;
    detectedCheckOut: string | null;
    status: string;
    evidence: string | null;
  };
  phaseB: {
    ran: boolean;
    extractedPrice: number | null;
    currency: string | null;
    includesTaxesFees: boolean | null;
    status: string;
    evidence: string | null;
  };
  finalStatus: TerminalStatus;
  elapsedMs: number;
  extractorUsed: string;
}

// Per-phase timeout - increased to allow Firecrawl + Zyte fallback
const PHASE_A_TIMEOUT = 60000;  // 60s for Phase A (Firecrawl ~25s + Zyte ~25s + buffer)
const PHASE_B_TIMEOUT = 60000;  // 60s for Phase B
const DEDICATED_EXTRACTOR_TIMEOUT = 120000; // 120s for dedicated extractors (max reliability)

// Golden path platforms with dedicated extractors
const GOLDEN_PATH_PLATFORMS: Record<string, string> = {
  'hotels.com': 'extract-hotelscom',
  // Expedia has multiple domains (.com, .co.jp, etc.) and UI often labels it as just "Expedia".
  // We treat ANY Expedia platform label as Tier-A dedicated extractor.
  'expedia': 'extract-expedia',
  'agoda.com': 'extract-agoda',
  'vrbo.com': 'extract-vrbo',
  'airpaz.com': 'extract-airpaz',
  // Booking.com golden path: Firecrawl-first with Zyte/Browserless fallback
  // See docs/BOOKING_PRICE_EXTRACTION_WORKING_BASELINE.md
  'booking.com': 'extract-booking',
};

// ============= CRITICAL: Apply date params to deep link =============
// Some callers (search-alternatives) store raw listing_url without dates.
// This function ensures dates are ALWAYS applied before extraction.
function applyDatesToDeepLink(url: string, platform: string, checkIn: string, checkOut: string, adults: number): string {
  try {
    const urlObj = new URL(url);
    const lowerPlatform = platform.toLowerCase();
    
    // Check if dates are already applied (avoid double-adding)
    const hasCheckIn = urlObj.searchParams.has('checkin') || 
                       urlObj.searchParams.has('chkin') || 
                       urlObj.searchParams.has('checkIn') ||
                       urlObj.searchParams.has('startDate') ||
                       urlObj.searchParams.has('arrival');
    
    if (hasCheckIn) {
      console.log(`[WORKER] Deep link already has date params, skipping: ${url.slice(0, 100)}`);
      return url; // Already has dates
    }
    
    console.log(`[WORKER] Applying dates to deep link for ${platform}: ${checkIn} to ${checkOut}`);
    
    if (lowerPlatform.includes('vrbo')) {
      urlObj.searchParams.set('arrival', checkIn);
      urlObj.searchParams.set('departure', checkOut);
      urlObj.searchParams.set('adults', adults.toString());
    } else if (lowerPlatform.includes('expedia')) {
      urlObj.searchParams.set('chkin', checkIn);
      urlObj.searchParams.set('chkout', checkOut);
      urlObj.searchParams.set('adults', adults.toString());
    } else if (lowerPlatform.includes('agoda')) {
      urlObj.searchParams.set('checkIn', checkIn);
      urlObj.searchParams.set('checkOut', checkOut);
      urlObj.searchParams.set('adults', adults.toString());
    } else if (lowerPlatform.includes('booking')) {
      urlObj.searchParams.set('checkin', checkIn);
      urlObj.searchParams.set('checkout', checkOut);
      urlObj.searchParams.set('group_adults', adults.toString());
      urlObj.searchParams.set('no_rooms', '1');
    } else if (lowerPlatform.includes('hotels')) {
      urlObj.searchParams.set('chkin', checkIn);
      urlObj.searchParams.set('chkout', checkOut);
      urlObj.searchParams.set('adults', adults.toString());
    } else if (lowerPlatform.includes('airpaz')) {
      urlObj.searchParams.set('checkIn', checkIn);
      urlObj.searchParams.set('checkOut', checkOut);
    } else if (lowerPlatform.includes('houfy')) {
      urlObj.searchParams.set('check_in', checkIn);
      urlObj.searchParams.set('check_out', checkOut);
    } else {
      // Generic fallback
      urlObj.searchParams.set('checkin', checkIn);
      urlObj.searchParams.set('checkout', checkOut);
      urlObj.searchParams.set('adults', adults.toString());
    }
    
    return urlObj.toString();
  } catch (err) {
    console.error(`[WORKER] Error applying dates to deep link:`, err);
    return url;
  }
}

// Check if platform has a dedicated golden path extractor
function getDedicatedExtractor(platformName: string): string | null {
  const platformLower = (platformName || '').toLowerCase();

  // Explicit Expedia catch-all to prevent routing through generic extract-prices (Firecrawl/Zyte)
  // in manual search orchestration.
  if (platformLower.includes('expedia')) return 'extract-expedia';
  
  // VRBO catch-all - any vrbo domain uses dedicated extractor
  if (platformLower.includes('vrbo')) return 'extract-vrbo';
  
  // Airpaz catch-all - uses dedicated extractor
  if (platformLower.includes('airpaz')) return 'extract-airpaz';

  for (const [domain, extractor] of Object.entries(GOLDEN_PATH_PLATFORMS)) {
    if (platformLower.includes(domain) || platformLower === domain.split('.')[0]) {
      return extractor;
    }
  }
  return null;
}

// Lookup platform adapter to get coverage tier
async function getPlatformTier(
  supabaseClient: any,
  platformName: string
): Promise<{ tier: CoverageTier; reason: string | null; dedicatedExtractor: string | null }> {
  try {
    const platformLower = platformName.toLowerCase();
    
    console.log(`[WORKER] getPlatformTier: Looking up tier for platform="${platformName}" (lower="${platformLower}")`);
    
    // ----- STEP 1: Try EXACT match first (case-insensitive) -----
    // This avoids "Hotels.com" picking up "Ecohotels" due to ilike substring matching.
    const { data: exactAdapters, error: exactErr } = await supabaseClient
      .from('platform_adapters')
      .select('coverage_tier, tier_reason, dedicated_extractor, platform_domain, platform_name')
      .ilike('platform_name', platformLower)
      .limit(1);
    
    if (exactErr) {
      console.error(`[WORKER] getPlatformTier exact query error: ${JSON.stringify(exactErr)}`);
    }
    
    if (exactAdapters && exactAdapters.length > 0) {
      const adapter = exactAdapters[0];
      const result = {
        tier: (adapter.coverage_tier || 'B') as CoverageTier,
        reason: adapter.tier_reason,
        dedicatedExtractor: adapter.dedicated_extractor,
      };
      console.log(`[WORKER] getPlatformTier: EXACT match found - tier=${result.tier}, dedicatedExtractor=${result.dedicatedExtractor}`);
      return result;
    }
    
    // ----- STEP 2: Fallback to domain-based lookup -----
    // E.g. if platform_name doesn't match, check if platform_domain contains the value.
    const { data: domainAdapters, error: domainErr } = await supabaseClient
      .from('platform_adapters')
      .select('coverage_tier, tier_reason, dedicated_extractor, platform_domain, platform_name')
      .ilike('platform_domain', `%${platformLower}%`)
      .limit(1);
    
    if (domainErr) {
      console.error(`[WORKER] getPlatformTier domain query error: ${JSON.stringify(domainErr)}`);
    }
    
    if (domainAdapters && domainAdapters.length > 0) {
      const adapter = domainAdapters[0];
      const result = {
        tier: (adapter.coverage_tier || 'B') as CoverageTier,
        reason: adapter.tier_reason,
        dedicatedExtractor: adapter.dedicated_extractor,
      };
      console.log(`[WORKER] getPlatformTier: DOMAIN match found - tier=${result.tier}, dedicatedExtractor=${result.dedicatedExtractor}`);
      return result;
    }
    
    // Default to Tier B (best effort) for unknown platforms
    console.log(`[WORKER] getPlatformTier: No adapter found, defaulting to Tier B`);
    return { tier: 'B', reason: 'Platform not in adapter registry', dedicatedExtractor: null };
  } catch (error) {
    console.error(`[WORKER] Error looking up platform tier: ${error}`);
    return { tier: 'B', reason: 'Tier lookup failed', dedicatedExtractor: null };
  }
}

// Call a dedicated production extractor (combines Phase A + B)
async function runDedicatedExtractor(
  supabaseUrl: string,
  supabaseKey: string,
  extractorName: string,
  extractionId: string,
  deepLink: string,
  requestedCheckIn: string,
  requestedCheckOut: string,
  adults: number = 2
): Promise<{ success: boolean; result: any; error?: string; timedOut?: boolean }> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DEDICATED_EXTRACTOR_TIMEOUT);
    
    console.log(`[WORKER] Calling dedicated extractor: ${extractorName}`);
    
    // Some dedicated extractors have slightly different request shapes.
    // Keep this logic here (instead of inside extractors) so the worker owns orchestration.
    const payload: Record<string, any> = extractorName === 'extract-booking'
      ? {
          extractionId,
          url: deepLink,
          checkIn: requestedCheckIn,
          checkOut: requestedCheckOut,
          adults,
        }
      : {
          extractionId,
          url: deepLink,
          checkIn: requestedCheckIn,
          checkOut: requestedCheckOut,
          adults,
          requireValidation: true,
        };

    const response = await fetch(`${supabaseUrl}/functions/v1/${extractorName}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, result: null, error: `HTTP ${response.status}: ${errorText}` };
    }
    
    const result = await response.json();
    return { success: result.success, result };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    if (errorMsg.includes('aborted') || errorMsg.includes('timeout')) {
      return { success: false, result: null, error: 'Dedicated extractor timeout', timedOut: true };
    }
    return { success: false, result: null, error: errorMsg };
  }
}

function isBookingPlatform(platformName: string): boolean {
  const p = (platformName || '').toLowerCase();
  return p.includes('booking');
}

// Call validate-dates with timeout
async function runPhaseA(
  supabaseUrl: string,
  supabaseKey: string,
  extractionId: string,
  deepLink: string,
  platformName: string,
  requestedCheckIn: string,
  requestedCheckOut: string
): Promise<{ success: boolean; result: any; error?: string; timedOut?: boolean }> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PHASE_A_TIMEOUT);
    
    const response = await fetch(`${supabaseUrl}/functions/v1/validate-dates`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        extractionId,
        deepLink,
        platformName,
        requestedCheckIn,
        requestedCheckOut,
        strategy: 'url_then_navigate',
      }),
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, result: null, error: `HTTP ${response.status}: ${errorText}` };
    }
    
    const result = await response.json();
    return { success: true, result };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    if (errorMsg.includes('aborted') || errorMsg.includes('timeout')) {
      return { success: false, result: null, error: 'Phase A timeout', timedOut: true };
    }
    return { success: false, result: null, error: errorMsg };
  }
}

// Call extract-prices for single extraction with timeout
async function runPhaseB(
  supabaseUrl: string,
  supabaseKey: string,
  searchId: string,
  extractionId: string,
  searchResultId: string
): Promise<{ success: boolean; result: any; error?: string; timedOut?: boolean }> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PHASE_B_TIMEOUT);
    
    const response = await fetch(`${supabaseUrl}/functions/v1/extract-prices`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        searchId,
        resultIds: [searchResultId],
        requireValidation: true,
      }),
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, result: null, error: `HTTP ${response.status}: ${errorText}` };
    }
    
    const data = await response.json();
    const results = data.results || [];
    return { success: true, result: results[0] || null };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    if (errorMsg.includes('aborted') || errorMsg.includes('timeout')) {
      return { success: false, result: null, error: 'Phase B timeout', timedOut: true };
    }
    return { success: false, result: null, error: errorMsg };
  }
}

// Ensure the extraction has a terminal status - NEVER leave pending
async function ensureTerminalStatus(
  supabaseClient: any,
  extractionId: string,
  status: TerminalStatus,
  error: string
): Promise<void> {
  await supabaseClient
    .from('price_extractions')
    .update({
      extraction_status: status,
      extraction_error: error,
      updated_at: new Date().toISOString(),
    })
    .eq('id', extractionId);
}

// Normalized outcome types for gate_3 evaluation
const NORMALIZED_OUTCOME_TYPES = [
  'success',
  'blocked',
  'login_required',
  'reserve_required',
  'payment_flow_required',
  'dates_not_applied',
  'no_availability',
  'price_not_found',
  'render_failed',
  'timeout',
  'unknown',
] as const;

type NormalizedOutcome = typeof NORMALIZED_OUTCOME_TYPES[number];

// Blocking failure reasons that prevent promotion eligibility (gate_3)
const BLOCKING_FAILURE_REASONS: NormalizedOutcome[] = [
  'blocked',
  'login_required',
  'reserve_required',
  'payment_flow_required',
];

// Normalize extraction status to consistent outcome type for gate evaluation
function normalizeOutcome(status: string, extractionError: string | null = null): NormalizedOutcome {
  const statusLower = status.toLowerCase();
  const errorLower = (extractionError || '').toLowerCase();
  
  // Success case
  if (statusLower === 'success') {
    return 'success';
  }
  
  // Blocked cases
  if (
    statusLower.includes('blocked') ||
    statusLower.includes('captcha') ||
    statusLower.includes('bot') ||
    errorLower.includes('captcha') ||
    errorLower.includes('bot detected') ||
    errorLower.includes('rate limit')
  ) {
    return 'blocked';
  }
  
  // Login required
  if (
    statusLower.includes('login') ||
    errorLower.includes('login') ||
    errorLower.includes('sign in')
  ) {
    return 'login_required';
  }
  
  // Reserve required (inquiry-based pricing)
  if (
    statusLower.includes('reserve') ||
    statusLower.includes('inquiry') ||
    errorLower.includes('reserve') ||
    errorLower.includes('inquiry') ||
    errorLower.includes('request to book')
  ) {
    return 'reserve_required';
  }
  
  // Payment flow required (total only visible at checkout)
  if (
    statusLower.includes('payment') ||
    statusLower.includes('checkout') ||
    statusLower.includes('pre_checkout') ||
    statusLower.includes('total_not_available') ||
    errorLower.includes('payment') ||
    errorLower.includes('checkout')
  ) {
    return 'payment_flow_required';
  }
  
  // Dates not applied
  if (
    statusLower.includes('dates_not_applied') ||
    errorLower.includes('could not validate dates') ||
    errorLower.includes('dates not')
  ) {
    return 'dates_not_applied';
  }
  
  // No availability
  if (
    statusLower.includes('unavailable') ||
    statusLower.includes('sold_out') ||
    statusLower.includes('no_availability') ||
    errorLower.includes('sold out') ||
    errorLower.includes('unavailable') ||
    errorLower.includes('no availability')
  ) {
    return 'no_availability';
  }
  
  // Price not found
  if (
    statusLower.includes('price_not_found') ||
    statusLower.includes('not_found') ||
    errorLower.includes('no price found') ||
    errorLower.includes('no total prices')
  ) {
    return 'price_not_found';
  }
  
  // Render failed
  if (
    statusLower.includes('render_failed') ||
    statusLower.includes('render') ||
    errorLower.includes('render') ||
    errorLower.includes('firecrawl error') ||
    errorLower.includes('zyte error')
  ) {
    return 'render_failed';
  }
  
  // Timeout
  if (
    statusLower.includes('timeout') ||
    errorLower.includes('timeout')
  ) {
    return 'timeout';
  }
  
  // Platform unsupported maps to blocked for gate purposes
  if (statusLower.includes('unsupported')) {
    return 'blocked';
  }
  
  return 'unknown';
}

// Update platform adapter with evidence tracking (Tier B self-triaging)
async function updatePlatformEvidence(
  supabaseClient: any,
  platformName: string,
  status: TerminalStatus,
  isSuccess: boolean,
  datesValidated: boolean = false
): Promise<void> {
  const outcomeType = normalizeOutcome(status, null);
  const now = new Date().toISOString();
  
  try {
    // CRITICAL FIX: Use canonical domain matching to prevent false positives
    // (e.g., "Ecohotels" incorrectly matching "hotels.com")
    const canonicalDomain = normalizeToAdapterDomain(platformName);
    
    let adapters: any[] | null = null;
    
    if (canonicalDomain) {
      // Step 1: Exact domain match (preferred - prevents false positives)
      const { data: exactMatch } = await supabaseClient
        .from('platform_adapters')
        .select('id, coverage_tier, total_attempts, total_successes, total_failures, gate_1_passed, gate_2_passed, gate_3_passed, last_success_at, promotion_in_progress, platform_domain')
        .eq('platform_domain', canonicalDomain)
        .limit(1);
      
      if (exactMatch && exactMatch.length > 0) {
        adapters = exactMatch;
        console.log(`[WORKER] updatePlatformEvidence: EXACT domain match for ${platformName} → ${canonicalDomain}`);
      }
    }
    
    if (!adapters || adapters.length === 0) {
      // Step 2: Fallback to ilike query for unknown platforms (legacy behavior)
      // This ensures new/unknown platforms can still update stats
      const platformLower = platformName.toLowerCase();
      const { data: fuzzyMatch } = await supabaseClient
        .from('platform_adapters')
        .select('id, coverage_tier, total_attempts, total_successes, total_failures, gate_1_passed, gate_2_passed, gate_3_passed, last_success_at, promotion_in_progress, platform_domain')
        .or(`platform_name.ilike.${platformLower},platform_domain.ilike.${platformLower}`)
        .limit(1);
      
      adapters = fuzzyMatch;
      if (adapters && adapters.length > 0) {
        console.log(`[WORKER] updatePlatformEvidence: FUZZY match for ${platformName} → ${adapters[0].platform_domain}`);
      }
    }
    
    if (adapters && adapters.length > 0) {
      const adapter = adapters[0];
      const newTotalAttempts = (adapter.total_attempts || 0) + 1;
      const newTotalSuccesses = isSuccess ? (adapter.total_successes || 0) + 1 : (adapter.total_successes || 0);
      const newTotalFailures = isSuccess ? (adapter.total_failures || 0) : (adapter.total_failures || 0) + 1;
      
      const updates: Record<string, any> = {
        last_attempt_at: now,
        last_outcome_type: outcomeType,
        total_attempts: newTotalAttempts,
        total_successes: newTotalSuccesses,
        total_failures: newTotalFailures,
        updated_at: now,
      };
      
      if (isSuccess) {
        updates.last_success_at = now;
      } else {
        updates.last_failure_at = now;
      }
      
      // Only compute gates and scores for Tier B platforms that are NOT in promotion workflow
      // If promotion_in_progress is true, we lock the scoring to preserve the decision context
      if (adapter.coverage_tier === 'B' && !adapter.promotion_in_progress) {
        // Gate 1: Date Application Viability - dates_validated=true at least once
        const gate1Passed = adapter.gate_1_passed || datesValidated;
        updates.gate_1_passed = gate1Passed;
        
        // Gate 2: Price Presence - at least one successful extraction with price
        const gate2Passed = adapter.gate_2_passed || isSuccess;
        updates.gate_2_passed = gate2Passed;
        
        // Gate 3: Failure Quality - dominant failure reason is not blocking
        // Pass if last outcome is NOT a blocking reason (or is success)
        const gate3Passed = !BLOCKING_FAILURE_REASONS.includes(outcomeType);
        updates.gate_3_passed = gate3Passed;
        
        // Compute promotion score if all gates passed
        if (gate1Passed && gate2Passed && gate3Passed) {
          // Success rate (0-1) - weight 0.5
          const successRate = newTotalAttempts > 0 ? newTotalSuccesses / newTotalAttempts : 0;
          
          // Recency score (0-1) - weight 0.3
          // Score based on how recent the last success was (within 7 days = 1.0, 30 days = 0.5, older = 0.1)
          let recencyScore = 0.1;
          const lastSuccessAt = isSuccess ? new Date(now) : (adapter.last_success_at ? new Date(adapter.last_success_at) : null);
          if (lastSuccessAt) {
            const daysSinceSuccess = (new Date().getTime() - lastSuccessAt.getTime()) / (1000 * 60 * 60 * 24);
            if (daysSinceSuccess <= 7) recencyScore = 1.0;
            else if (daysSinceSuccess <= 30) recencyScore = 0.5;
          }
          
          // Stability score (0-1) - weight 0.2
          // Simple: if success rate >= 50% and gate 3 passed, score 1.0
          const stabilityScore = (successRate >= 0.5 && gate3Passed) ? 1.0 : 0.5;
          
          // Compute weighted score
          const promotionScore = (successRate * 0.5) + (recencyScore * 0.3) + (stabilityScore * 0.2);
          updates.promotion_score = Math.round(promotionScore * 1000) / 1000; // 3 decimal places
          updates.last_scored_at = now;
          
          // Generate candidate reason
          updates.promotion_candidate_reason = `Gates passed. Success rate: ${(successRate * 100).toFixed(0)}% (${newTotalSuccesses}/${newTotalAttempts}). Recent success: ${recencyScore >= 0.5 ? 'Yes' : 'No'}. Stable: ${stabilityScore >= 1.0 ? 'Yes' : 'No'}.`;
        } else {
          updates.promotion_score = 0;
          updates.promotion_candidate = false;
          
          // Generate reason for not being eligible
          const failedGates = [];
          if (!gate1Passed) failedGates.push('Gate 1 (dates never validated)');
          if (!gate2Passed) failedGates.push('Gate 2 (no successful price extraction)');
          if (!gate3Passed) failedGates.push(`Gate 3 (blocking failure: ${outcomeType})`);
          updates.promotion_candidate_reason = `Not eligible: ${failedGates.join(', ')}`;
        }
      }
      
      await supabaseClient
        .from('platform_adapters')
        .update(updates)
        .eq('id', adapter.id);
      
      console.log(`[WORKER] Updated platform evidence for ${platformName}: ${outcomeType}, gates: [${updates.gate_1_passed || false}, ${updates.gate_2_passed || false}, ${updates.gate_3_passed || false}]${adapter.promotion_in_progress ? ' (scoring locked - promotion in progress)' : ''}`);
      
      // Trigger promotion candidate nomination if this is a Tier B platform NOT in promotion workflow
      if (adapter.coverage_tier === 'B' && !adapter.promotion_in_progress) {
        await nominateSinglePromotionCandidate(supabaseClient);
      }
    }
  } catch (err) {
    console.error(`[WORKER] Failed to update platform evidence: ${err}`);
    // Non-blocking - don't fail the extraction for evidence tracking
  }
}

// Nominate exactly one promotion candidate from all eligible Tier B platforms
async function nominateSinglePromotionCandidate(supabaseClient: any): Promise<void> {
  try {
    // Clear all existing promotion candidates that are NOT in promotion workflow
    await supabaseClient
      .from('platform_adapters')
      .update({ promotion_candidate: false, promotion_status: 'none' })
      .eq('promotion_candidate', true)
      .eq('promotion_in_progress', false);
    
    // Find the highest-scoring eligible Tier B platform that is NOT in promotion workflow
    const { data: eligiblePlatforms } = await supabaseClient
      .from('platform_adapters')
      .select('id, platform_name, promotion_score, promotion_candidate_reason')
      .eq('coverage_tier', 'B')
      .eq('gate_1_passed', true)
      .eq('gate_2_passed', true)
      .eq('gate_3_passed', true)
      .eq('promotion_in_progress', false)
      .gt('promotion_score', 0)
      .order('promotion_score', { ascending: false })
      .limit(1);
    
    if (eligiblePlatforms && eligiblePlatforms.length > 0) {
      const candidate = eligiblePlatforms[0];
      await supabaseClient
        .from('platform_adapters')
        .update({
          promotion_candidate: true,
          promotion_status: 'nominated',
          promotion_candidate_reason: `Highest-scoring eligible platform (score: ${candidate.promotion_score}). ${candidate.promotion_candidate_reason || ''}`,
        })
        .eq('id', candidate.id);
      
      console.log(`[WORKER] Nominated promotion candidate: ${candidate.platform_name} (score: ${candidate.promotion_score})`);
    } else {
      console.log(`[WORKER] No eligible promotion candidates found`);
    }
  } catch (err) {
    console.error(`[WORKER] Failed to nominate promotion candidate: ${err}`);
  }
}

// ============= VARIANT DETECTION HELPER =============
// Called on structural extraction failures to detect and register new coverage variants
async function detectAndRegisterVariantOnFailure(
  supabaseClient: any,
  extractionId: string,
  originalUrl: string,
  finalResolvedUrl: string | null,
  terminalStatus: string,
  errorMessage: string | null,
  extractionMetadata: Record<string, any> | null
): Promise<void> {
  // Classify failure type
  const failureType = classifyFailureForVariant(terminalStatus, errorMessage, null);
  
  // Only register variants for structural failures
  if (failureType !== 'structural') {
    console.log(`[WORKER] Skipping variant detection for transient failure: ${terminalStatus}`);
    return;
  }
  
  // Build flow signature from extraction context
  const flowContext: ExtractionFlowSignature = buildFlowSignature({
    finalUrl: finalResolvedUrl || originalUrl,
    hasDrawerInteraction: extractionMetadata?.hasDrawerInteraction || extractionMetadata?.drawer_clicked || false,
    hasBreakdown: extractionMetadata?.breakdown_found || extractionMetadata?.has_breakdown || false,
    hasTotalBeforeCheckout: extractionMetadata?.total_visible_before_checkout || false,
    checkoutUrlPattern: extractionMetadata?.checkout_url_pattern,
    detectedCurrency: extractionMetadata?.currency || extractionMetadata?.detected_currency,
    bookingFlowType: extractionMetadata?.booking_flow_type,
  });
  
  // Detect variant
  const variantDetection = detectVariant(originalUrl, finalResolvedUrl, flowContext);
  
  console.log(`[WORKER] Detected variant: ${variantDetection.coverage_variant_key} (country=${variantDetection.detected_country})`);
  
  // Register variant
  const registration = await registerVariant(
    supabaseClient,
    variantDetection,
    originalUrl,
    failureType
  );
  
  if (registration.is_new) {
    console.log(`[WORKER] NEW coverage variant registered: ${registration.variant_key}`);
  }
  
  // Update extraction record with variant key
  await supabaseClient
    .from('price_extractions')
    .update({
      detected_variant_key: variantDetection.coverage_variant_key,
      variant_mismatch: registration.is_new,
      extraction_flow_signature: variantDetection.extraction_flow_signature,
    })
    .eq('id', extractionId);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();
  
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabaseClient = createClient(supabaseUrl, supabaseKey);
    
    const { extractionId, requestedCheckIn, requestedCheckOut } = await req.json() as WorkerRequest;
    
    console.log(`[WORKER] Starting for extraction ${extractionId}`);
    
    // Fetch extraction details
    const { data: extraction, error: fetchError } = await supabaseClient
      .from('price_extractions')
      .select('*, search_results(*)')
      .eq('id', extractionId)
      .single();
    
    if (fetchError || !extraction) {
      console.error(`[WORKER] Extraction not found: ${extractionId}`);
      return new Response(
        JSON.stringify({ success: false, error: 'Extraction not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    const platform = extraction.platform_name;
    const rawDeepLink = extraction.deep_link;
    const searchId = extraction.search_id;
    const searchResultId = extraction.search_result_id;
    const adults = extraction.assumed_adults || 2;
    
    // ============= CRITICAL FIX: Apply dates to deep link =============
    // Some callers (search-alternatives) store raw listing_url without dates.
    // Ensure dates are ALWAYS applied before extraction.
    const deepLink = applyDatesToDeepLink(rawDeepLink, platform, requestedCheckIn, requestedCheckOut, adults);
    
    // Update DB with proper deep link if it changed
    if (deepLink !== rawDeepLink) {
      console.log(`[WORKER] Updated deep_link with date params for ${platform}`);
      await supabaseClient
        .from('price_extractions')
        .update({ deep_link: deepLink })
        .eq('id', extractionId);
    }
    
    // ============= COVERAGE TIER ENFORCEMENT =============
    // Lookup platform's coverage tier from platform_adapters
    const tierInfo = await getPlatformTier(supabaseClient, platform);
    console.log(`[WORKER] Platform ${platform} is Tier ${tierInfo.tier}: ${tierInfo.reason || 'no reason'}`);
    
    // Get dedicated extractor (prefer DB value, fallback to hardcoded)
    const dedicatedExtractor = tierInfo.dedicatedExtractor || getDedicatedExtractor(platform);
    
    const result: WorkerResult = {
      extractionId,
      platform,
      phaseA: {
        ran: false,
        datesValidated: false,
        detectedCheckIn: null,
        detectedCheckOut: null,
        status: 'pending',
        evidence: null,
      },
      phaseB: {
        ran: false,
        extractedPrice: null,
        currency: null,
        includesTaxesFees: null,
        status: 'pending',
        evidence: null,
      },
      finalStatus: 'validation_error',
      elapsedMs: 0,
      extractorUsed: dedicatedExtractor || 'generic',
    };
    
    // ============= TIER C: SHORT-CIRCUIT UNSUPPORTED PLATFORMS =============
    if (tierInfo.tier === 'C') {
      console.log(`[WORKER] Tier C platform ${platform} - short-circuiting with unsupported status`);
      
      const unsupportedReason = tierInfo.reason || 'Platform classified as unsupported (Tier C)';
      result.phaseA.status = 'platform_unsupported';
      result.phaseA.evidence = unsupportedReason;
      result.finalStatus = 'platform_unsupported';
      
      // Update extraction with explicit unsupported status
      await supabaseClient
        .from('price_extractions')
        .update({
          extraction_status: 'platform_unsupported',
          extraction_error: unsupportedReason,
          extraction_metadata: {
            tier: 'C',
            tier_reason: unsupportedReason,
            short_circuited: true,
            short_circuited_at: new Date().toISOString(),
          },
          updated_at: new Date().toISOString(),
        })
        .eq('id', extractionId);
      
      result.elapsedMs = Date.now() - startTime;
      
      return new Response(
        JSON.stringify({ 
          success: false, 
          result,
          tier: 'C',
          tierReason: unsupportedReason,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    // ============= TIER A: GOLDEN PATH with dedicated extractor =============
    console.log(`[WORKER] Routing decision for ${platform}: tier=${tierInfo.tier}, dedicatedExtractor=${dedicatedExtractor}, willUseGoldenPath=${tierInfo.tier === 'A' && !!dedicatedExtractor}`);
    
    if (tierInfo.tier === 'A' && dedicatedExtractor) {
    console.log(`[PIPE_EXTRACT_START] search_id=${searchId} platform=${platform} extraction_id=${extractionId} extractor=${dedicatedExtractor}`);
    console.log(`[WORKER] *** USING GOLDEN PATH extractor: ${dedicatedExtractor} for ${platform} ***`);
      
      result.phaseA.ran = true;
      result.phaseB.ran = true;
      
      const extractorResponse = await runDedicatedExtractor(
        supabaseUrl,
        supabaseKey,
        dedicatedExtractor,
        extractionId,
        deepLink,
        requestedCheckIn,
        requestedCheckOut,
        extraction.assumed_adults || 2
      );
      
      if (extractorResponse.timedOut) {
        result.phaseA.status = 'timeout';
        result.phaseB.status = 'timeout';
        result.finalStatus = 'timeout';
        
        await ensureTerminalStatus(supabaseClient, extractionId, 'timeout', `${dedicatedExtractor} timeout`);
        
        result.elapsedMs = Date.now() - startTime;
        console.log(`[WORKER] ${dedicatedExtractor} timeout for ${platform}`);
        return new Response(
          JSON.stringify({ success: false, result }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      
      // Parse dedicated extractor response
      const extractorResult = extractorResponse.result;

      // Targeted return log (shape differs between Expedia and others)
      try {
        const rawStatus = extractorResult?.status || extractorResult?.finalStatus || 'unknown';
        const rawPrice = extractorResult?.price ?? extractorResult?.extractedPrice ?? extractorResult?.extracted_price ?? extractorResult?.phaseB?.extractedPrice ?? null;
        const rawCurrency = extractorResult?.currency ?? extractorResult?.phaseB?.currency ?? null;
        console.log(`[PIPE_EXTRACT_RETURN] search_id=${searchId} platform=${platform} extraction_id=${extractionId} extractor=${dedicatedExtractor} status=${rawStatus} price=${rawPrice ?? 'null'} currency=${rawCurrency ?? 'null'}`);
      } catch (_e) {
        // no-op
      }
      
      if (extractorResult) {
        // EXPEDIA-SPECIFIC: extract-expedia returns a flattened format
        // with 'price' (not extracted_price), 'status', 'success', 'structuralProof', etc.
        const isExpedia = dedicatedExtractor === 'extract-expedia';
        
        if (isExpedia) {
          // Expedia response format:
          // { success, status, price, currency, includesTaxesFees, structuralProof, providerUsed, ... }
          const expediaPrice = extractorResult.price ?? null;
          const expediaStatus = extractorResult.status || 'extraction_error';
          const expediaSuccess = extractorResult.success === true;
          const proof = extractorResult.structuralProof || {};
          
          // Phase A: dates are validated if success or offers page was reached
          result.phaseA.datesValidated = expediaSuccess || proof.offers_page_gate_passed || false;
          result.phaseA.status = result.phaseA.datesValidated ? 'success' : expediaStatus;
          
          // Phase B: price extraction
          result.phaseB.extractedPrice = expediaPrice;
          result.phaseB.currency = extractorResult.currency || 'USD';
          result.phaseB.includesTaxesFees = extractorResult.includesTaxesFees ?? null;
          result.phaseB.status = expediaStatus;
          result.phaseB.evidence = extractorResult.error || null;
          
          // Map Expedia terminal status directly - these are already canonical
          const expediaTerminalStatuses = [
            'success',
            'expedia_target_offer_not_found',
            'expedia_target_offer_mismatch',
            'expedia_dates_unavailable_for_target',
            'expedia_target_total_not_found',
            'expedia_offers_page_not_reached',
            'expedia_total_not_found_on_offers_page',
            'expedia_access_blocked',
            'property_id_not_found',
            'dates_unavailable',
            'blocked_captcha_or_bot',
            'blocked_rate_limit',
          ];
          
          if (expediaSuccess && expediaPrice) {
            result.finalStatus = 'success';
          } else if (expediaTerminalStatuses.includes(expediaStatus)) {
            // Trust Expedia's terminal status - map to our enums where possible
            if (expediaStatus.includes('unavailable') || expediaStatus.includes('dates_unavailable')) {
              result.finalStatus = 'no_availability_for_dates';
            } else if (expediaStatus.includes('blocked') || expediaStatus.includes('access_blocked')) {
              result.finalStatus = 'blocked_captcha_or_bot';
            } else if (expediaStatus.includes('not_found') || expediaStatus.includes('mismatch')) {
              result.finalStatus = 'price_not_found_after_dates_applied';
            } else {
              result.finalStatus = 'extraction_error';
            }
          } else {
            result.finalStatus = 'extraction_error';
          }
          
          // NOTE: extract-expedia already persisted to DB when extractionId was provided
          // We don't need to call ensureTerminalStatus as it would override the correct status
          console.log(`[WORKER] Expedia extraction: status=${expediaStatus}, price=${expediaPrice}, finalStatus=${result.finalStatus}`);
          
        } else {
          // Generic dedicated extractor response handling (non-Expedia)
          result.phaseA.datesValidated = extractorResult.phaseA?.datesValidated || extractorResult.dates_validated || false;
          result.phaseA.detectedCheckIn = extractorResult.phaseA?.detectedCheckIn || extractorResult.detected_checkin || null;
          result.phaseA.detectedCheckOut = extractorResult.phaseA?.detectedCheckOut || extractorResult.detected_checkout || null;
          result.phaseA.status = extractorResult.phaseA?.status || (result.phaseA.datesValidated ? 'success' : 'dates_not_applied');
          
          result.phaseB.extractedPrice = extractorResult.phaseB?.extractedPrice || extractorResult.extracted_price || null;
          result.phaseB.currency = extractorResult.phaseB?.currency || extractorResult.currency || null;
          result.phaseB.includesTaxesFees = extractorResult.phaseB?.includesTaxesFees ?? extractorResult.includes_taxes_fees ?? null;
          result.phaseB.status = extractorResult.phaseB?.status || extractorResult.status || 'extraction_error';
          result.phaseB.evidence = extractorResult.phaseB?.evidenceSnippet || extractorResult.evidence_snippet || null;
          
          if (extractorResult.success && result.phaseB.extractedPrice) {
            result.finalStatus = 'success';
          } else if (!result.phaseA.datesValidated) {
            const phaseAStatus = extractorResult.phaseA?.status || extractorResult.status || '';
            if (phaseAStatus.includes('sold_out') || phaseAStatus.includes('no_availability')) {
              result.finalStatus = 'no_availability_for_dates';
            } else if (phaseAStatus.includes('blocked') || phaseAStatus.includes('captcha')) {
              result.finalStatus = 'blocked_captcha_or_bot';
            } else {
              result.finalStatus = 'dates_not_applied';
            }
          } else {
            const phaseBStatus = extractorResult.phaseB?.status || extractorResult.status || '';
            if (phaseBStatus.includes('price_not_found') || phaseBStatus.includes('no_price')) {
              result.finalStatus = 'price_not_found_after_dates_applied';
            } else if (phaseBStatus.includes('blocked')) {
              result.finalStatus = 'blocked_captcha_or_bot';
            } else {
              result.finalStatus = 'extraction_error';
            }
          }
        }
      } else {
        // Extractor returned no result
        result.finalStatus = 'extraction_error';
        result.phaseA.status = 'extraction_error';
        result.phaseB.status = 'extraction_error';
        
        await ensureTerminalStatus(supabaseClient, extractionId, 'extraction_error', extractorResponse.error || 'No result from dedicated extractor');
      }
      
      result.elapsedMs = Date.now() - startTime;
      
      // Update platform evidence for Tier A (still track for monitoring)
      await updatePlatformEvidence(supabaseClient, platform, result.finalStatus, result.finalStatus === 'success', result.phaseA.datesValidated);
      
      // ============= VARIANT DETECTION ON FAILURE (Tier A) =============
      // Even Tier A platforms may have regional variants that require different logic
      if (result.finalStatus !== 'success') {
        try {
          await detectAndRegisterVariantOnFailure(
            supabaseClient,
            extractionId,
            deepLink,
            extractorResult?.finalResolvedUrl || extractorResult?.final_resolved_url || null,
            result.finalStatus,
            result.phaseB.evidence || result.phaseA.evidence || null,
            extractorResult?.extraction_metadata || extractorResult?.structuralProof || null
          );
        } catch (variantErr) {
          console.error('[WORKER] Variant detection failed (non-blocking):', variantErr);
        }
      }
      
      console.log(`[WORKER] ${dedicatedExtractor} complete for ${platform}: ${result.finalStatus} (${result.elapsedMs}ms)`);
      
      return new Response(
        JSON.stringify({ 
          success: result.finalStatus === 'success',
          result,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    // ============= TIER B: BEST EFFORT (Generic Path) =============
    // Tier B platforms use generic Phase A → Phase B flow
    console.log(`[WORKER] Tier B: Using GENERIC extraction path for ${platform}`);
    
    // ============= PHASE A: Date Validation =============
    console.log(`[WORKER] Phase A: ${platform}`);
    result.phaseA.ran = true;
    
    const phaseAResponse = await runPhaseA(
      supabaseUrl,
      supabaseKey,
      extractionId,
      deepLink,
      platform,
      requestedCheckIn,
      requestedCheckOut
    );
    
    if (phaseAResponse.timedOut) {
      // Timeout - ensure terminal status
      result.phaseA.status = 'timeout';
      result.phaseA.evidence = 'Phase A exceeded 60 second timeout';
      result.finalStatus = 'timeout';
      
      await ensureTerminalStatus(supabaseClient, extractionId, 'timeout', 'Phase A timeout');
      
      result.elapsedMs = Date.now() - startTime;
      console.log(`[WORKER] Phase A timeout for ${platform}`);
      return new Response(
        JSON.stringify({ success: false, result }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    if (!phaseAResponse.success || !phaseAResponse.result) {
      // Phase A call failed - mark with explicit failure
      const failureStatus: TerminalStatus = 'render_failed';
      result.phaseA.status = failureStatus;
      result.phaseA.evidence = phaseAResponse.error || 'Phase A call failed';
      result.finalStatus = failureStatus;
      
      await ensureTerminalStatus(supabaseClient, extractionId, failureStatus, phaseAResponse.error || 'Phase A call failed');
      
      result.elapsedMs = Date.now() - startTime;
      console.log(`[WORKER] Phase A failed for ${platform}: ${phaseAResponse.error}`);
      return new Response(
        JSON.stringify({ success: false, result }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    // Phase A completed - check results
    const phaseAResult = phaseAResponse.result;
    result.phaseA.datesValidated = phaseAResult.success === true;
    result.phaseA.detectedCheckIn = phaseAResult.detectedCheckIn || null;
    result.phaseA.detectedCheckOut = phaseAResult.detectedCheckOut || null;
    result.phaseA.status = phaseAResult.status || 'failed_unknown';
    result.phaseA.evidence = phaseAResult.error || null;
    
    if (!result.phaseA.datesValidated) {
      // Phase A determined dates not validated - map to terminal status
      const statusMap: Record<string, TerminalStatus> = {
        'dates_not_applied': 'dates_not_applied',
        'no_availability_for_dates': 'no_availability_for_dates',
        'blocked_captcha_or_bot': 'blocked_captcha_or_bot',
        'blocked_rate_limit': 'blocked_rate_limit',
        'render_failed': 'render_failed',
        'failed_unknown': 'validation_error',
      };
      
      const terminalStatus = statusMap[phaseAResult.status] || 'validation_error';
      result.finalStatus = terminalStatus;
      
      // validate-dates already updated the DB, but ensure terminal status
      await ensureTerminalStatus(supabaseClient, extractionId, terminalStatus, phaseAResult.error || `Phase A: ${phaseAResult.status}`);
      
      result.elapsedMs = Date.now() - startTime;
      console.log(`[WORKER] Phase A complete (not validated) for ${platform}: ${terminalStatus}`);
      return new Response(
        JSON.stringify({ success: false, result }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    // ============= PHASE B: Price Extraction (only if dates validated) =============
    console.log(`[WORKER] Phase B: ${platform} (dates validated)`);
    result.phaseB.ran = true;
    
    const phaseBResponse = await runPhaseB(
      supabaseUrl,
      supabaseKey,
      searchId,
      extractionId,
      searchResultId
    );
    
    if (phaseBResponse.timedOut) {
      // Timeout - ensure terminal status
      result.phaseB.status = 'timeout';
      result.phaseB.evidence = 'Phase B exceeded 60 second timeout';
      result.finalStatus = 'timeout';
      
      await ensureTerminalStatus(supabaseClient, extractionId, 'timeout', 'Phase B timeout');
      
      result.elapsedMs = Date.now() - startTime;
      console.log(`[WORKER] Phase B timeout for ${platform}`);
      return new Response(
        JSON.stringify({ success: false, result }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    // Fetch updated extraction from DB (extract-prices updates it)
    const { data: updatedExtraction } = await supabaseClient
      .from('price_extractions')
      .select('*')
      .eq('id', extractionId)
      .single();
    
    if (updatedExtraction) {
      result.phaseB.extractedPrice = updatedExtraction.extracted_price;
      result.phaseB.currency = updatedExtraction.currency;
      result.phaseB.includesTaxesFees = updatedExtraction.includes_taxes_fees;
      result.phaseB.status = updatedExtraction.extraction_status;
      result.phaseB.evidence = updatedExtraction.extraction_error;

      // ============= BOOKING.COM: TRY HARDER FALLBACK =============
      // If the generic path gets blocked, immediately escalate to the dedicated Booking extractor
      // (Zyte → Browserless) to maximize our chances of a pre-checkout total.
      if (
        isBookingPlatform(platform) &&
        (updatedExtraction.extraction_status === 'blocked_captcha_or_bot' ||
          updatedExtraction.extraction_status === 'render_failed' ||
          updatedExtraction.extraction_status === 'blocked_rate_limit')
      ) {
        console.log(`[WORKER] Booking.com blocked on generic path (${updatedExtraction.extraction_status}) - escalating to extract-booking`);

        const bookingFallback = await runDedicatedExtractor(
          supabaseUrl,
          supabaseKey,
          'extract-booking',
          extractionId,
          deepLink,
          requestedCheckIn,
          requestedCheckOut,
          extraction.assumed_adults || 2
        );

        if (!bookingFallback.timedOut) {
          const { data: afterFallback } = await supabaseClient
            .from('price_extractions')
            .select('*')
            .eq('id', extractionId)
            .single();

          if (afterFallback) {
            result.phaseB.extractedPrice = afterFallback.extracted_price;
            result.phaseB.currency = afterFallback.currency;
            result.phaseB.includesTaxesFees = afterFallback.includes_taxes_fees;
            result.phaseB.status = afterFallback.extraction_status;
            result.phaseB.evidence = afterFallback.extraction_error;
          } else {
            console.log('[WORKER] Booking fallback ran but could not re-fetch extraction row');
          }
        } else {
          console.log('[WORKER] Booking fallback timed out - keeping generic result');
        }
      }
      
      // Map to terminal status (use the latest phaseB fields, which may have been updated by fallback)
      const currentPhaseBStatus = (result.phaseB.status || 'failed_unknown') as string;
      const currentPrice = result.phaseB.extractedPrice;
      const isSuccess = currentPhaseBStatus === 'success' && !!currentPrice;
      
      if (isSuccess) {
        result.finalStatus = 'success';
      } else {
        // Map Phase B status to terminal
        const statusMap: Record<string, TerminalStatus> = {
          'price_not_found_after_dates_applied': 'price_not_found_after_dates_applied',
          'blocked_captcha_or_bot': 'blocked_captcha_or_bot',
          'blocked_rate_limit': 'blocked_rate_limit',
          'render_failed': 'render_failed',
          'failed_unknown': 'extraction_error',
          'pending': 'extraction_error', // Should not happen, but safety
        };
        
        result.finalStatus = statusMap[currentPhaseBStatus] || 'extraction_error';
        
        // Ensure DB has terminal status if still pending
        if (currentPhaseBStatus === 'pending') {
          await ensureTerminalStatus(supabaseClient, extractionId, 'extraction_error', 'Phase B completed without updating status');
        }
      }
    } else {
      // Could not fetch updated extraction
      result.phaseB.status = 'extraction_error';
      result.phaseB.evidence = 'Failed to fetch extraction after Phase B';
      result.finalStatus = 'extraction_error';
      
      await ensureTerminalStatus(supabaseClient, extractionId, 'extraction_error', 'Failed to fetch extraction after Phase B');
    }
    
    result.elapsedMs = Date.now() - startTime;
    
    // Update platform evidence for Tier B (critical for self-triaging)
    await updatePlatformEvidence(supabaseClient, platform, result.finalStatus, result.finalStatus === 'success', result.phaseA.datesValidated);
    
    // ============= VARIANT DETECTION ON FAILURE =============
    // If extraction failed structurally, detect and register coverage variant
    if (result.finalStatus !== 'success' && result.finalStatus !== 'timeout') {
      try {
        await detectAndRegisterVariantOnFailure(
          supabaseClient,
          extractionId,
          deepLink,
          updatedExtraction?.final_resolved_url || null,
          result.finalStatus,
          result.phaseB.evidence || result.phaseA.evidence || null,
          updatedExtraction?.extraction_metadata || null
        );
      } catch (variantErr) {
        console.error('[WORKER] Variant detection failed (non-blocking):', variantErr);
      }
    }
    
    console.log(`[WORKER] Complete for ${platform}: ${result.finalStatus} (${result.elapsedMs}ms)`);
    
    return new Response(
      JSON.stringify({ 
        success: result.finalStatus === 'success',
        result,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
    
  } catch (error) {
    console.error('[WORKER] Fatal error:', error);
    
    // Try to mark extraction as failed
    try {
      const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
      const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
      const supabaseClient = createClient(supabaseUrl, supabaseKey);
      const body = await req.clone().json();
      
      if (body.extractionId) {
        await ensureTerminalStatus(
          supabaseClient,
          body.extractionId,
          'extraction_error',
          error instanceof Error ? error.message : 'Unknown fatal error'
        );
      }
    } catch (e) {
      console.error('[WORKER] Failed to mark extraction as failed:', e);
    }
    
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
