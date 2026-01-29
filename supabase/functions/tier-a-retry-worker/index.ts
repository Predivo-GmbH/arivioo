import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  isTierAPlatform,
  classifyTierAFailure,
  calculateBackoffDelay,
  MAX_TIER_A_ATTEMPTS,
  getRetryExhaustedStatus,
  buildRetryExhaustedError,
} from '../_shared/tierARetryPolicy.ts';

/**
 * TIER-A RETRY WORKER
 * 
 * Server-driven worker that resumes Tier-A platform extractions (Agoda, Booking.com).
 * Runs on a cron schedule (every 5-10 seconds) to ensure retries progress to terminal states.
 * 
 * CANONICAL CONTRACT:
 * - Claims pending_retry extractions with atomic row-level locking
 * - Executes extraction via process-platform-extraction
 * - Transitions to: success | hard_terminal | exhausted | pending_retry (with backoff)
 * - Idempotent: Only one worker can claim an extraction at a time
 * 
 * FINALIZATION GATE:
 * - Searches CANNOT finalize while any Tier-A extraction is in pending_retry or running
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Maximum extractions to process per worker invocation
const BATCH_SIZE = 5;

// Lock timeout - if a job stays in 'running' for this long, it's considered stale
const STALE_RUNNING_TIMEOUT_MS = 120000; // 2 minutes

interface PendingRetryExtraction {
  id: string;
  search_id: string | null;
  platform_name: string;
  deep_link: string;
  tier_a_attempt_count: number;
  tier_a_last_transient_reason: string | null;
  tier_a_state: string;
  detected_checkin: string | null;
  detected_checkout: string | null;
  extraction_status: string | null;
  extracted_price: number | null;
}

// Success statuses that indicate extraction already succeeded - do not retry
const SUCCESS_EXTRACTION_STATUSES = new Set([
  'success',
  'success_total_stay',
  'price_extracted',
  'completed',
]);

/**
 * Claim a pending retry job atomically.
 * Uses UPDATE ... WHERE to ensure only one worker can claim the job.
 */
async function claimPendingJob(
  supabase: any,
  extractionId: string,
  currentAttemptCount: number
): Promise<boolean> {
  const now = new Date().toISOString();
  
  // Atomic claim: Update only if state is still 'pending_retry'
  const { data, error } = await supabase
    .from('price_extractions')
    .update({
      tier_a_state: 'running',
      tier_a_attempt_count: currentAttemptCount + 1,
      updated_at: now,
    })
    .eq('id', extractionId)
    .eq('tier_a_state', 'pending_retry')
    .select('id')
    .single();
  
  if (error || !data) {
    console.log(`[TIER_A_WORKER] Failed to claim job ${extractionId}: ${error?.message || 'already claimed'}`);
    return false;
  }
  
  console.log(`[TIER_A_WORKER] claimed extraction_id=${extractionId}`);
  return true;
}

/**
 * Execute extraction attempt via process-platform-extraction.
 */
async function executeExtraction(
  supabaseUrl: string,
  supabaseKey: string,
  extraction: PendingRetryExtraction,
  checkIn: string,
  checkOut: string
): Promise<{
  success: boolean;
  status: string | null;
  error: string | null;
  extractedPrice: number | null;
}> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 90000); // 90s timeout
    
    const response = await fetch(`${supabaseUrl}/functions/v1/process-platform-extraction`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        extractionId: extraction.id,
        requestedCheckIn: checkIn,
        requestedCheckOut: checkOut,
      }),
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        status: 'render_failed',
        error: `HTTP ${response.status}: ${errorText}`,
        extractedPrice: null,
      };
    }
    
    const result = await response.json();
    return {
      success: result.finalStatus === 'success' || result.phaseB?.extractedPrice > 0,
      status: result.finalStatus || null,
      error: result.error || null,
      extractedPrice: result.phaseB?.extractedPrice || null,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    if (errorMsg.includes('aborted') || errorMsg.includes('timeout')) {
      return { success: false, status: 'timeout', error: 'Worker timeout', extractedPrice: null };
    }
    return { success: false, status: 'render_failed', error: errorMsg, extractedPrice: null };
  }
}

/**
 * Transition extraction to terminal state.
 */
async function transitionToTerminal(
  supabase: any,
  extractionId: string,
  terminalState: 'success' | 'hard_terminal' | 'exhausted',
  extractionStatus: string,
  error: string | null,
  extractedPrice: number | null
): Promise<void> {
  const now = new Date().toISOString();
  
  const updates: Record<string, any> = {
    tier_a_state: terminalState,
    tier_a_next_retry_at: null,
    updated_at: now,
  };
  
  // Only update extraction fields if we have new data
  if (extractionStatus) {
    updates.extraction_status = extractionStatus;
  }
  if (error) {
    updates.extraction_error = error;
  }
  if (extractedPrice && extractedPrice > 0) {
    updates.extracted_price = extractedPrice;
  }
  
  await supabase
    .from('price_extractions')
    .update(updates)
    .eq('id', extractionId);
  
  console.log(`[TIER_A_WORKER] ${terminalState} extraction_id=${extractionId} status=${extractionStatus}`);
}

/**
 * Schedule retry with backoff.
 */
async function scheduleRetry(
  supabase: any,
  extractionId: string,
  attemptCount: number,
  transientReason: string
): Promise<void> {
  const backoffMs = calculateBackoffDelay(attemptCount + 1);
  const nextRetryAt = new Date(Date.now() + backoffMs).toISOString();
  
  await supabase
    .from('price_extractions')
    .update({
      tier_a_state: 'pending_retry',
      tier_a_last_transient_reason: transientReason,
      tier_a_next_retry_at: nextRetryAt,
      updated_at: new Date().toISOString(),
    })
    .eq('id', extractionId);
  
  console.log(`[TIER_A_WORKER] scheduled next_retry_at=${nextRetryAt} backoffMs=${backoffMs} attempt=${attemptCount}/${MAX_TIER_A_ATTEMPTS}`);
}

/**
 * Get check-in/check-out dates from search or extraction.
 */
async function getDatesForExtraction(
  supabase: any,
  extraction: PendingRetryExtraction
): Promise<{ checkIn: string; checkOut: string } | null> {
  // First try extraction's detected dates
  if (extraction.detected_checkin && extraction.detected_checkout) {
    return {
      checkIn: extraction.detected_checkin,
      checkOut: extraction.detected_checkout,
    };
  }
  
  // Fall back to search dates
  if (extraction.search_id) {
    const { data: search } = await supabase
      .from('searches')
      .select('check_in_date, check_out_date')
      .eq('id', extraction.search_id)
      .single();
    
    if (search?.check_in_date && search?.check_out_date) {
      return {
        checkIn: search.check_in_date,
        checkOut: search.check_out_date,
      };
    }
  }
  
  return null;
}

/**
 * Process a single pending retry extraction.
 */
async function processPendingExtraction(
  supabase: any,
  supabaseUrl: string,
  supabaseKey: string,
  extraction: PendingRetryExtraction
): Promise<void> {
  const attemptCount = extraction.tier_a_attempt_count || 0;
  
  // ============= INVARIANT GUARD: Hard MAX cap =============
  // tier_a_attempt_count must NEVER exceed MAX_TIER_A_ATTEMPTS
  // If it does, this is a bug - log error and force exhausted state
  if (attemptCount > MAX_TIER_A_ATTEMPTS) {
    console.error(`[TIER_A_WORKER] CRITICAL INVARIANT VIOLATION: extraction_id=${extraction.id} has tier_a_attempt_count=${attemptCount} which exceeds MAX=${MAX_TIER_A_ATTEMPTS}. Forcing exhausted state.`);
    
    await transitionToTerminal(
      supabase,
      extraction.id,
      'exhausted',
      getRetryExhaustedStatus(extraction.tier_a_last_transient_reason),
      buildRetryExhaustedError(extraction.platform_name, extraction.tier_a_last_transient_reason, attemptCount),
      null
    );
    return;
  }
  
  // ============= GUARD: Already at MAX - do not retry, exhaust immediately =============
  // This prevents incrementing beyond MAX during claim
  if (attemptCount >= MAX_TIER_A_ATTEMPTS) {
    console.log(`[TIER_A_WORKER] extraction_id=${extraction.id} already at MAX attempts (${attemptCount}/${MAX_TIER_A_ATTEMPTS}). Transitioning to exhausted.`);
    
    await transitionToTerminal(
      supabase,
      extraction.id,
      'exhausted',
      getRetryExhaustedStatus(extraction.tier_a_last_transient_reason),
      buildRetryExhaustedError(extraction.platform_name, extraction.tier_a_last_transient_reason, attemptCount),
      null
    );
    return;
  }
  
  // ============= GUARD: Check if extraction already succeeded =============
  // This prevents retrying extractions that succeeded but weren't properly marked
  const extractionStatus = extraction.extraction_status?.toLowerCase() || '';
  const hasPrice = extraction.extracted_price && extraction.extracted_price > 0;
  
  if (SUCCESS_EXTRACTION_STATUSES.has(extractionStatus) || hasPrice) {
    console.log(`[TIER_A_WORKER] INVARIANT VIOLATION: extraction_id=${extraction.id} already succeeded (status=${extractionStatus}, price=${extraction.extracted_price}) but tier_a_state was pending_retry`);
    
    // Fix the state - transition to success
    await transitionToTerminal(
      supabase,
      extraction.id,
      'success',
      extractionStatus || 'success',
      null,
      extraction.extracted_price
    );
    return;
  }
  
  console.log(`[TIER_A_WORKER] attempt=${attemptCount + 1}/${MAX_TIER_A_ATTEMPTS} reason=${extraction.tier_a_last_transient_reason} extraction_id=${extraction.id}`);
  
  // Claim the job atomically
  const claimed = await claimPendingJob(supabase, extraction.id, attemptCount);
  if (!claimed) {
    return; // Another worker already claimed it
  }
  
  // Get dates for extraction
  const dates = await getDatesForExtraction(supabase, extraction);
  if (!dates) {
    console.error(`[TIER_A_WORKER] No dates found for extraction ${extraction.id}`);
    await transitionToTerminal(
      supabase,
      extraction.id,
      'hard_terminal',
      'validation_error',
      'No check-in/check-out dates available for retry',
      null
    );
    return;
  }
  
  // Execute extraction
  const result = await executeExtraction(
    supabaseUrl,
    supabaseKey,
    extraction,
    dates.checkIn,
    dates.checkOut
  );
  
  // Classify the result
  const classification = classifyTierAFailure(
    result.status,
    result.error,
    result.extractedPrice
  );
  
  const newAttemptCount = attemptCount + 1;
  
  // Determine next state
  if (classification === 'SUCCESS') {
    await transitionToTerminal(
      supabase,
      extraction.id,
      'success',
      result.status || 'success',
      null,
      result.extractedPrice
    );
  } else if (classification === 'HARD_TERMINAL') {
    await transitionToTerminal(
      supabase,
      extraction.id,
      'hard_terminal',
      result.status || 'extraction_error',
      result.error,
      null
    );
  } else if (newAttemptCount >= MAX_TIER_A_ATTEMPTS) {
    // Exhausted retry budget
    const exhaustedStatus = getRetryExhaustedStatus(result.status);
    const exhaustedError = buildRetryExhaustedError(
      extraction.platform_name,
      result.status,
      newAttemptCount
    );
    
    await transitionToTerminal(
      supabase,
      extraction.id,
      'exhausted',
      exhaustedStatus,
      exhaustedError,
      null
    );
    
    console.log(`[TIER_A_WORKER] exhausted extraction_id=${extraction.id} after ${newAttemptCount} attempts`);
  } else {
    // Schedule next retry
    await scheduleRetry(
      supabase,
      extraction.id,
      newAttemptCount,
      result.status || 'unknown'
    );
  }
}

/**
 * Clean up stale 'running' jobs that may have been orphaned.
 */
async function cleanupStaleRunningJobs(supabase: any): Promise<number> {
  const staleThreshold = new Date(Date.now() - STALE_RUNNING_TIMEOUT_MS).toISOString();
  
  // Find running jobs that have been running too long
  const { data: staleJobs, error } = await supabase
    .from('price_extractions')
    .select('id, tier_a_attempt_count, platform_name')
    .eq('tier_a_state', 'running')
    .lt('updated_at', staleThreshold);
  
  if (error || !staleJobs || staleJobs.length === 0) {
    return 0;
  }
  
  console.log(`[TIER_A_WORKER] Found ${staleJobs.length} stale running jobs to recover`);
  
  for (const job of staleJobs) {
    const newAttemptCount = (job.tier_a_attempt_count || 0);
    
    if (newAttemptCount >= MAX_TIER_A_ATTEMPTS) {
      // Exhausted - mark as terminal
      await transitionToTerminal(
        supabase,
        job.id,
        'exhausted',
        'service_error',
        `Stale running job recovered after ${newAttemptCount} attempts`,
        null
      );
    } else {
      // Re-schedule for retry
      await scheduleRetry(supabase, job.id, newAttemptCount, 'stale_running_recovery');
    }
  }
  
  return staleJobs.length;
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
    
    console.log('[TIER_A_WORKER] Starting worker invocation');
    
    // Step 1: Clean up stale running jobs
    const recoveredCount = await cleanupStaleRunningJobs(supabase);
    
    // Step 2: Find pending retries that are ready
    const now = new Date().toISOString();
    
    const { data: pendingExtractions, error: fetchError } = await supabase
      .from('price_extractions')
      .select(`
        id,
        search_id,
        platform_name,
        deep_link,
        tier_a_attempt_count,
        tier_a_last_transient_reason,
        tier_a_state,
        detected_checkin,
        detected_checkout,
        extraction_status,
        extracted_price
      `)
      .eq('tier_a_state', 'pending_retry')
      .lte('tier_a_next_retry_at', now)
      .order('tier_a_next_retry_at', { ascending: true })
      .limit(BATCH_SIZE);
    
    if (fetchError) {
      console.error(`[TIER_A_WORKER] Error fetching pending extractions: ${fetchError.message}`);
      return new Response(
        JSON.stringify({ success: false, error: fetchError.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    const pendingCount = pendingExtractions?.length || 0;
    console.log(`[TIER_A_WORKER] Found ${pendingCount} pending retries to process`);
    
    if (pendingCount === 0 && recoveredCount === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          processed: 0,
          recovered: 0,
          durationMs: Date.now() - startTime,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    // Step 3: Process each pending extraction
    let processedCount = 0;
    for (const extraction of (pendingExtractions || [])) {
      try {
        await processPendingExtraction(
          supabase,
          supabaseUrl,
          supabaseKey,
          extraction as PendingRetryExtraction
        );
        processedCount++;
      } catch (err) {
        console.error(`[TIER_A_WORKER] Error processing extraction ${extraction.id}: ${err}`);
        // Continue with other extractions
      }
    }
    
    const durationMs = Date.now() - startTime;
    console.log(`[TIER_A_WORKER] Completed: processed=${processedCount}, recovered=${recoveredCount}, durationMs=${durationMs}`);
    
    return new Response(
      JSON.stringify({
        success: true,
        processed: processedCount,
        recovered: recoveredCount,
        durationMs,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
    
  } catch (error) {
    console.error('[TIER_A_WORKER] Fatal error:', error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
