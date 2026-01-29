import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  MAX_TIER_A_ATTEMPTS,
  calculateBackoffDelay,
  getRetryExhaustedStatus,
  buildRetryExhaustedError,
} from '../_shared/tierARetryPolicy.ts';

/**
 * SKIP-STUCK-EXTRACTIONS WORKER
 * 
 * Tier-aware anti-stuck mechanism that detects and recovers stalled extractions.
 * Runs every minute via pg_cron to ensure searches never hang indefinitely.
 * 
 * KEY CONCEPTS:
 * - Heartbeat = updated_at changes OR state transition OR attempt_count increment
 * - "Stuck" = no heartbeat beyond tier-specific threshold
 * - Tier A: More patience, reschedule before exhausting
 * - Tier B/C: Skip faster to unblock finalization
 * 
 * TIER-BASED THRESHOLDS (configurable):
 * - Tier A: 4min running, 2min queue, 90s retry grace
 * - Tier B/C: 90s running, 45s queue, 30s retry grace
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// =============================================================================
// TIER-BASED THRESHOLDS (in milliseconds)
// =============================================================================

// Tier A (high priority - Agoda, Booking.com): Patient, retry first
const TIER_A_RUNNING_STALE_MS = 4 * 60 * 1000;      // 4 minutes
const TIER_A_QUEUE_STALE_MS = 2 * 60 * 1000;        // 2 minutes
const TIER_A_RETRY_OVERDUE_GRACE_MS = 90 * 1000;    // 90 seconds

// Tier B/C (lower priority): Aggressive skip
const TIER_LOW_RUNNING_STALE_MS = 90 * 1000;        // 90 seconds
const TIER_LOW_QUEUE_STALE_MS = 45 * 1000;          // 45 seconds
const TIER_LOW_RETRY_OVERDUE_GRACE_MS = 30 * 1000;  // 30 seconds

// Maximum extractions to process per worker invocation
const BATCH_SIZE = 30;

// =============================================================================
// TYPES
// =============================================================================

interface StuckExtraction {
  id: string;
  search_id: string | null;
  platform_name: string;
  extraction_status: string | null;
  tier_a_state: string | null;
  tier_a_attempt_count: number | null;
  tier_a_next_retry_at: string | null;
  updated_at: string;
  created_at: string;
  coverage_tier: string | null;
}

type StuckReason = 
  | 'running_stale'      // In running state with no heartbeat
  | 'queue_stale'        // In pending/queued and never started
  | 'retry_overdue';     // pending_retry past next_retry_at + grace

interface RecoveryAction {
  extraction_id: string;
  platform_name: string;
  tier: string;
  stuck_reason: StuckReason;
  action: 'reschedule' | 'exhaust' | 'terminal';
  new_status: string;
  error_message: string;
}

// =============================================================================
// TIER CLASSIFICATION
// =============================================================================

/**
 * Get coverage tier from platform_adapters or fall back to name-based detection
 */
function getEffectiveTier(extraction: StuckExtraction): 'A' | 'B' | 'C' {
  // If we have DB-driven tier, use it
  if (extraction.coverage_tier) {
    const tier = extraction.coverage_tier.toUpperCase();
    if (tier === 'A') return 'A';
    if (tier === 'B') return 'B';
    return 'C';
  }
  
  // Fallback: Name-based detection for Tier A
  const name = extraction.platform_name.toLowerCase();
  if (name.includes('agoda') || name.includes('booking')) {
    return 'A';
  }
  
  // Default to B for unknown platforms
  return 'B';
}

/**
 * Get tier-specific thresholds
 */
function getThresholds(tier: 'A' | 'B' | 'C'): {
  runningStaleMs: number;
  queueStaleMs: number;
  retryOverdueGraceMs: number;
} {
  if (tier === 'A') {
    return {
      runningStaleMs: TIER_A_RUNNING_STALE_MS,
      queueStaleMs: TIER_A_QUEUE_STALE_MS,
      retryOverdueGraceMs: TIER_A_RETRY_OVERDUE_GRACE_MS,
    };
  }
  
  // Tier B/C - aggressive
  return {
    runningStaleMs: TIER_LOW_RUNNING_STALE_MS,
    queueStaleMs: TIER_LOW_QUEUE_STALE_MS,
    retryOverdueGraceMs: TIER_LOW_RETRY_OVERDUE_GRACE_MS,
  };
}

// =============================================================================
// STUCK DETECTION (Heartbeat-based)
// =============================================================================

/**
 * Detect if an extraction is stuck based on heartbeat (updated_at) and state.
 * 
 * An extraction is STUCK only if:
 * - running AND no heartbeat for > RUNNING_STALE_THRESHOLD
 * - pending_retry AND now() > tier_a_next_retry_at + RETRY_OVERDUE_GRACE
 * - pending/queued AND not started for > QUEUE_STALE_THRESHOLD
 */
function detectStuckReason(
  extraction: StuckExtraction,
  now: Date
): StuckReason | null {
  const tier = getEffectiveTier(extraction);
  const thresholds = getThresholds(tier);
  
  const updatedAt = new Date(extraction.updated_at);
  const timeSinceUpdate = now.getTime() - updatedAt.getTime();
  
  const status = extraction.extraction_status?.toLowerCase() || '';
  const tierAState = extraction.tier_a_state?.toLowerCase() || '';
  
  // 1. Check for running state with no heartbeat
  if (status === 'running' || tierAState === 'running') {
    if (timeSinceUpdate > thresholds.runningStaleMs) {
      return 'running_stale';
    }
  }
  
  // 2. Check for pending_retry with overdue next_retry_at
  if (tierAState === 'pending_retry' && extraction.tier_a_next_retry_at) {
    const nextRetryAt = new Date(extraction.tier_a_next_retry_at);
    const overdueBy = now.getTime() - nextRetryAt.getTime();
    
    if (overdueBy > thresholds.retryOverdueGraceMs) {
      return 'retry_overdue';
    }
  }
  
  // 3. Check for pending/queued that never started
  const queuedStatuses = ['pending', 'queued', 'in_progress', 'started'];
  if (queuedStatuses.includes(status)) {
    if (timeSinceUpdate > thresholds.queueStaleMs) {
      return 'queue_stale';
    }
  }
  
  return null;
}

// =============================================================================
// RECOVERY ACTIONS
// =============================================================================

/**
 * Determine recovery action for a stuck extraction.
 * 
 * Tier A recovery order:
 * 1. If stuck AND attempts remain: reschedule (pending_retry)
 * 2. Only exhaust when attempts exhausted OR hard terminal detected
 * 
 * Tier B/C: Immediate terminal (service_error: stalled_timeout)
 */
function determineRecoveryAction(
  extraction: StuckExtraction,
  stuckReason: StuckReason
): RecoveryAction {
  const tier = getEffectiveTier(extraction);
  const attemptCount = extraction.tier_a_attempt_count || 0;
  
  // Tier B/C: Immediate terminal (aggressive skip)
  if (tier !== 'A') {
    return {
      extraction_id: extraction.id,
      platform_name: extraction.platform_name,
      tier,
      stuck_reason: stuckReason,
      action: 'terminal',
      new_status: 'service_error',
      error_message: `Lower-tier extraction auto-skipped after ${stuckReason} (tier=${tier})`,
    };
  }
  
  // Tier A: Check if we can reschedule
  if (attemptCount < MAX_TIER_A_ATTEMPTS) {
    return {
      extraction_id: extraction.id,
      platform_name: extraction.platform_name,
      tier,
      stuck_reason: stuckReason,
      action: 'reschedule',
      new_status: 'pending_retry',
      error_message: `Tier-A rescheduled after ${stuckReason} (attempt ${attemptCount + 1}/${MAX_TIER_A_ATTEMPTS})`,
    };
  }
  
  // Tier A: Attempts exhausted - mark as exhausted
  return {
    extraction_id: extraction.id,
    platform_name: extraction.platform_name,
    tier,
    stuck_reason: stuckReason,
    action: 'exhaust',
    new_status: getRetryExhaustedStatus(stuckReason),
    error_message: buildRetryExhaustedError(extraction.platform_name, stuckReason, attemptCount),
  };
}

/**
 * Execute recovery action on the database.
 */
async function executeRecoveryAction(
  supabase: any,
  action: RecoveryAction
): Promise<boolean> {
  const now = new Date().toISOString();
  
  if (action.action === 'reschedule') {
    // Reschedule Tier A: Set to pending_retry with backoff
    const attemptCount = action.error_message.match(/attempt (\d+)/)?.[1] || '1';
    const backoffMs = calculateBackoffDelay(parseInt(attemptCount, 10));
    const nextRetryAt = new Date(Date.now() + backoffMs).toISOString();
    
    const { error } = await supabase
      .from('price_extractions')
      .update({
        tier_a_state: 'pending_retry',
        tier_a_next_retry_at: nextRetryAt,
        tier_a_last_transient_reason: action.stuck_reason,
        extraction_error: action.error_message,
        updated_at: now,
      })
      .eq('id', action.extraction_id);
    
    if (error) {
      console.error(`[SKIP_STUCK] Failed to reschedule ${action.extraction_id}:`, error);
      return false;
    }
    
    console.log(`[SKIP_STUCK] Rescheduled tier=A extraction_id=${action.extraction_id} reason=${action.stuck_reason} next_retry_at=${nextRetryAt}`);
    return true;
  }
  
  // Terminal action (exhaust or terminal)
  const updates: Record<string, any> = {
    extraction_status: action.new_status,
    extraction_error: action.error_message,
    updated_at: now,
  };
  
  // For Tier A exhausted, also update tier_a_state
  if (action.action === 'exhaust') {
    updates.tier_a_state = 'exhausted';
    updates.tier_a_next_retry_at = null;
  }
  
  const { error } = await supabase
    .from('price_extractions')
    .update(updates)
    .eq('id', action.extraction_id);
  
  if (error) {
    console.error(`[SKIP_STUCK] Failed to transition ${action.extraction_id} to ${action.new_status}:`, error);
    return false;
  }
  
  console.log(`[SKIP_STUCK] ${action.action} tier=${action.tier} extraction_id=${action.extraction_id} new_status=${action.new_status} reason=${action.stuck_reason}`);
  return true;
}

// =============================================================================
// MAIN WORKER
// =============================================================================

async function findStuckExtractions(supabase: any): Promise<StuckExtraction[]> {
  // Calculate the oldest threshold (Tier A running = 4min)
  const oldestThreshold = new Date(Date.now() - TIER_A_RUNNING_STALE_MS).toISOString();
  
  // Query extractions that might be stuck
  // We fetch a broader set and filter in code for accurate tier-based thresholds
  const { data, error } = await supabase
    .from('price_extractions')
    .select(`
      id,
      search_id,
      platform_name,
      extraction_status,
      tier_a_state,
      tier_a_attempt_count,
      tier_a_next_retry_at,
      updated_at,
      created_at
    `)
    .or(`
      extraction_status.in.(pending,queued,running,in_progress,started),
      tier_a_state.in.(running,pending_retry)
    `)
    .lte('updated_at', oldestThreshold)
    .limit(BATCH_SIZE * 2);  // Fetch extra since we'll filter by tier
  
  if (error) {
    console.error('[SKIP_STUCK] Failed to query extractions:', error);
    return [];
  }
  
  return data || [];
}

async function enrichWithTiers(
  supabase: any,
  extractions: StuckExtraction[]
): Promise<StuckExtraction[]> {
  if (extractions.length === 0) return [];
  
  // Get unique platform names
  const platformNames = [...new Set(extractions.map(e => e.platform_name))];
  
  // Fetch coverage_tier from platform_adapters
  const { data: adapters, error } = await supabase
    .from('platform_adapters')
    .select('platform_name, coverage_tier')
    .in('platform_name', platformNames);
  
  if (error) {
    console.warn('[SKIP_STUCK] Failed to fetch platform adapters:', error);
    // Continue with name-based fallback
    return extractions;
  }
  
  // Build lookup map
  const tierMap = new Map<string, string>();
  adapters?.forEach((a: any) => {
    tierMap.set(a.platform_name.toLowerCase(), a.coverage_tier);
  });
  
  // Enrich extractions
  return extractions.map(e => ({
    ...e,
    coverage_tier: tierMap.get(e.platform_name.toLowerCase()) || null,
  }));
}

async function updateSearchProgress(
  supabase: any,
  searchIds: Set<string>
): Promise<void> {
  if (searchIds.size === 0) return;
  
  const now = new Date().toISOString();
  
  // Update last_progress_at for affected searches
  const { error } = await supabase
    .from('searches')
    .update({ last_progress_at: now })
    .in('id', [...searchIds])
    .is('finalised_at', null);  // Only unfinalised searches
  
  if (error) {
    console.warn('[SKIP_STUCK] Failed to update search progress:', error);
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  
  const startTime = Date.now();
  
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabase = createClient(supabaseUrl, supabaseKey);
    
    console.log('[SKIP_STUCK] Starting worker invocation');
    
    // Step 1: Find potentially stuck extractions
    const rawExtractions = await findStuckExtractions(supabase);
    console.log(`[SKIP_STUCK] Found ${rawExtractions.length} potentially stuck extractions`);
    
    if (rawExtractions.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          processed: 0,
          rescheduled: 0,
          terminated: 0,
          durationMs: Date.now() - startTime,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    // Step 2: Enrich with DB-driven tiers
    const enrichedExtractions = await enrichWithTiers(supabase, rawExtractions);
    
    // Step 3: Detect stuck extractions using heartbeat-based logic
    const now = new Date();
    const recoveryActions: RecoveryAction[] = [];
    const affectedSearchIds = new Set<string>();
    
    for (const extraction of enrichedExtractions) {
      const stuckReason = detectStuckReason(extraction, now);
      
      if (stuckReason) {
        const action = determineRecoveryAction(extraction, stuckReason);
        recoveryActions.push(action);
        
        if (extraction.search_id) {
          affectedSearchIds.add(extraction.search_id);
        }
      }
    }
    
    console.log(`[SKIP_STUCK] Detected ${recoveryActions.length} stuck extractions`);
    
    // Step 4: Execute recovery actions
    let rescheduled = 0;
    let terminated = 0;
    
    for (const action of recoveryActions.slice(0, BATCH_SIZE)) {
      const success = await executeRecoveryAction(supabase, action);
      
      if (success) {
        if (action.action === 'reschedule') {
          rescheduled++;
        } else {
          terminated++;
        }
      }
    }
    
    // Step 5: Update search-level progress heartbeat
    await updateSearchProgress(supabase, affectedSearchIds);
    
    const durationMs = Date.now() - startTime;
    console.log(`[SKIP_STUCK] Completed: rescheduled=${rescheduled} terminated=${terminated} durationMs=${durationMs}`);
    
    return new Response(
      JSON.stringify({
        success: true,
        processed: recoveryActions.length,
        rescheduled,
        terminated,
        durationMs,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
    
  } catch (error) {
    console.error('[SKIP_STUCK] Fatal error:', error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
