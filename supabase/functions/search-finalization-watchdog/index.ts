import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { finalizeAndCompleteSearch } from '../_shared/buildFinalSnapshot.ts';

/**
 * SEARCH-FINALIZATION-WATCHDOG
 * 
 * A background worker that enforces the critical invariant:
 *   status='completed' MUST imply finalised_at IS NOT NULL
 * 
 * This worker runs every minute via pg_cron and auto-repairs any violations.
 * 
 * INVARIANTS ENFORCED:
 * 1. status='completed' + finalised_at=NULL → Trigger forced finalization
 * 2. Searches stuck in 'searching'/'running' for >15min → Auto-timeout
 * 3. Searches with all terminal extractions but status!='completed' → Auto-complete
 * 
 * This is the PERMANENT FIX for stuck searches - no manual intervention needed.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Configuration
const COMPLETED_WITHOUT_SNAPSHOT_TIMEOUT_MS = 0; // Immediate - this is an invariant violation
const SEARCHING_STALE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes
const BATCH_SIZE = 10; // Process up to 10 violations per run

interface InvariantViolation {
  search_id: string;
  violation_type: 'completed_no_snapshot' | 'searching_stale' | 'extractions_terminal_but_not_completed';
  created_at: string;
  updated_at: string;
  status: string;
  finalised_at: string | null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();
  const results = {
    completed_no_snapshot_found: 0,
    completed_no_snapshot_repaired: 0,
    searching_stale_found: 0,
    searching_stale_repaired: 0,
    extractions_terminal_found: 0,
    extractions_terminal_repaired: 0,
    errors: [] as string[],
  };

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabase = createClient(supabaseUrl, supabaseKey);

    console.log('[FINALIZATION_WATCHDOG] Starting invariant check...');

    // ==========================================================================
    // INVARIANT 1: status='completed' + finalised_at=NULL
    // This is a CRITICAL violation - search claims complete but has no snapshot
    // ==========================================================================
    const { data: completedNoSnapshot, error: error1 } = await supabase
      .from('searches')
      .select('id, status, finalised_at, created_at, updated_at')
      .eq('status', 'completed')
      .is('finalised_at', null)
      .order('created_at', { ascending: true })
      .limit(BATCH_SIZE);

    if (error1) {
      console.error('[FINALIZATION_WATCHDOG] Error querying completed_no_snapshot:', error1);
      results.errors.push(`Query error: ${error1.message}`);
    } else if (completedNoSnapshot && completedNoSnapshot.length > 0) {
      results.completed_no_snapshot_found = completedNoSnapshot.length;
      console.log(`[FINALIZATION_WATCHDOG] Found ${completedNoSnapshot.length} searches with status=completed but no finalised_at`);

      for (const search of completedNoSnapshot) {
        try {
          console.log(`[FINALIZATION_WATCHDOG] Repairing search ${search.id} (completed without snapshot)`);
          
          // Call the shared finalization helper
          const result = await finalizeAndCompleteSearch({
            supabase,
            searchId: search.id,
          });

          if (result.success || result.alreadyFinalized) {
            results.completed_no_snapshot_repaired++;
            console.log(`[FINALIZATION_WATCHDOG] Repaired search ${search.id}: finalisedAt=${result.finalisedAt}, resultCount=${result.resultCount}`);
          } else {
            console.error(`[FINALIZATION_WATCHDOG] Failed to repair search ${search.id}: ${result.error}`);
            results.errors.push(`Repair failed for ${search.id}: ${result.error}`);
          }
        } catch (repairError) {
          const msg = repairError instanceof Error ? repairError.message : 'Unknown error';
          console.error(`[FINALIZATION_WATCHDOG] Exception repairing search ${search.id}:`, msg);
          results.errors.push(`Exception for ${search.id}: ${msg}`);
        }
      }
    }

    // ==========================================================================
    // INVARIANT 2: Searches stuck in 'searching' for too long
    // After 15 minutes, force-complete and finalize
    // ==========================================================================
    const staleThreshold = new Date(Date.now() - SEARCHING_STALE_THRESHOLD_MS).toISOString();
    
    const { data: searchingStale, error: error2 } = await supabase
      .from('searches')
      .select('id, status, finalised_at, created_at, updated_at')
      .in('status', ['searching', 'running', 'pending'])
      .lt('updated_at', staleThreshold)
      .is('finalised_at', null)
      .order('created_at', { ascending: true })
      .limit(BATCH_SIZE);

    if (error2) {
      console.error('[FINALIZATION_WATCHDOG] Error querying searching_stale:', error2);
      results.errors.push(`Query error: ${error2.message}`);
    } else if (searchingStale && searchingStale.length > 0) {
      results.searching_stale_found = searchingStale.length;
      console.log(`[FINALIZATION_WATCHDOG] Found ${searchingStale.length} searches stuck in searching/running/pending for >15min`);

      for (const search of searchingStale) {
        try {
          console.log(`[FINALIZATION_WATCHDOG] Auto-completing stale search ${search.id} (status=${search.status}, updated_at=${search.updated_at})`);
          
          // First, force all non-terminal extractions to service_error
          const { error: skipError } = await supabase
            .from('price_extractions')
            .update({
              extraction_status: 'service_error',
              extraction_error: 'Auto-skipped by watchdog: search stale timeout (>15min)',
              tier_a_state: null,
              tier_a_next_retry_at: null,
              updated_at: new Date().toISOString(),
            })
            .eq('search_id', search.id)
            .in('extraction_status', ['pending', 'queued', 'running', 'in_progress', 'started']);

          if (skipError) {
            console.error(`[FINALIZATION_WATCHDOG] Failed to skip extractions for ${search.id}:`, skipError);
          }

          // Now finalize
          const result = await finalizeAndCompleteSearch({
            supabase,
            searchId: search.id,
          });

          if (result.success || result.alreadyFinalized) {
            results.searching_stale_repaired++;
            console.log(`[FINALIZATION_WATCHDOG] Repaired stale search ${search.id}: finalisedAt=${result.finalisedAt}, resultCount=${result.resultCount}`);
          } else {
            console.error(`[FINALIZATION_WATCHDOG] Failed to repair stale search ${search.id}: ${result.error}`);
            results.errors.push(`Stale repair failed for ${search.id}: ${result.error}`);
          }
        } catch (repairError) {
          const msg = repairError instanceof Error ? repairError.message : 'Unknown error';
          console.error(`[FINALIZATION_WATCHDOG] Exception repairing stale search ${search.id}:`, msg);
          results.errors.push(`Stale exception for ${search.id}: ${msg}`);
        }
      }
    }

    // ==========================================================================
    // INVARIANT 3: All extractions terminal but search not completed
    // This means the pipeline finished but forgot to call finalization
    // ==========================================================================
    // Query searches that have extractions but aren't completed
    const { data: notCompletedSearches, error: error3 } = await supabase
      .from('searches')
      .select('id, status, finalised_at, created_at, updated_at')
      .in('status', ['searching', 'running', 'extracting_prices', 'pending'])
      .is('finalised_at', null)
      .gte('updated_at', staleThreshold) // Not stale (handled above)
      .order('created_at', { ascending: true })
      .limit(BATCH_SIZE * 2); // Check more since we filter below

    if (error3) {
      console.error('[FINALIZATION_WATCHDOG] Error querying not_completed:', error3);
      results.errors.push(`Query error: ${error3.message}`);
    } else if (notCompletedSearches && notCompletedSearches.length > 0) {
      // For each search, check if ALL extractions are terminal
      const NON_TERMINAL_STATUSES = ['pending', 'queued', 'running', 'in_progress', 'started'];
      const TIER_A_BLOCKING_STATES = ['pending_retry', 'running'];

      for (const search of notCompletedSearches) {
        try {
          // Check if any extractions are still non-terminal
          const { data: nonTerminalExtractions, error: checkError } = await supabase
            .from('price_extractions')
            .select('id, extraction_status, tier_a_state, platform_name')
            .eq('search_id', search.id)
            .or(
              `extraction_status.in.(${NON_TERMINAL_STATUSES.join(',')}),tier_a_state.in.(${TIER_A_BLOCKING_STATES.join(',')})`
            )
            .limit(1);

          if (checkError) {
            console.error(`[FINALIZATION_WATCHDOG] Error checking extractions for ${search.id}:`, checkError);
            continue;
          }

          // If there are no non-terminal extractions, all are terminal → can finalize
          if (!nonTerminalExtractions || nonTerminalExtractions.length === 0) {
            // Double-check there ARE extractions
            const { count: extractionCount } = await supabase
              .from('price_extractions')
              .select('id', { count: 'exact', head: true })
              .eq('search_id', search.id);

            if (extractionCount && extractionCount > 0) {
              results.extractions_terminal_found++;
              console.log(`[FINALIZATION_WATCHDOG] Search ${search.id} has all ${extractionCount} extractions terminal but status=${search.status}, triggering finalization`);

              const result = await finalizeAndCompleteSearch({
                supabase,
                searchId: search.id,
              });

              if (result.success || result.alreadyFinalized) {
                results.extractions_terminal_repaired++;
                console.log(`[FINALIZATION_WATCHDOG] Finalized search ${search.id}: finalisedAt=${result.finalisedAt}`);
              } else if (result.error?.includes('Tier-A retry in progress')) {
                // Expected - Tier-A is still retrying, this is fine
                console.log(`[FINALIZATION_WATCHDOG] Search ${search.id} waiting for Tier-A retries`);
              } else {
                console.error(`[FINALIZATION_WATCHDOG] Failed to finalize ${search.id}: ${result.error}`);
              }
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Unknown error';
          console.error(`[FINALIZATION_WATCHDOG] Error processing search ${search.id}:`, msg);
        }
      }
    }

    const durationMs = Date.now() - startTime;
    console.log(`[FINALIZATION_WATCHDOG] Completed in ${durationMs}ms:`, results);

    return new Response(
      JSON.stringify({
        success: true,
        durationMs,
        ...results,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[FINALIZATION_WATCHDOG] Fatal error:', error);
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error',
        ...results,
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
