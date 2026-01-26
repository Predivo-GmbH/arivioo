import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { normalizeToAdapterDomain } from '../_shared/platformNameNormalizer.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

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

// Map extraction_status to normalized outcome type
function normalizeOutcome(status: string, extractionError: string | null): NormalizedOutcome {
  const statusLower = status.toLowerCase();
  const errorLower = (extractionError || '').toLowerCase();
  
  // Success cases - include all success variants (success, success_total_stay, completed, etc.)
  if (
    statusLower === 'success' ||
    statusLower.startsWith('success_') ||
    statusLower === 'completed'
  ) {
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
  
  // Payment flow required
  if (
    statusLower.includes('payment') ||
    statusLower.includes('checkout') ||
    statusLower.includes('pre_checkout') ||
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
  
  return 'unknown';
}

interface PlatformStats {
  platformName: string;
  platformDomain: string;
  totalAttempts: number;
  totalSuccesses: number;
  totalFailures: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastAttemptAt: string | null;
  lastOutcomeType: NormalizedOutcome;
  outcomeCounts: Record<NormalizedOutcome, number>;
  dominantFailureReason: NormalizedOutcome | null;
  anyDatesValidated: boolean;
  anyGroundedSuccess: boolean;
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
    
    console.log('[BACKFILL] Starting platform evidence backfill from historical price_extractions');
    
    // Get all platform adapters
    const { data: adapters, error: adapterError } = await supabaseClient
      .from('platform_adapters')
      .select('id, platform_name, platform_domain, coverage_tier');
    
    if (adapterError) {
      throw new Error(`Failed to fetch adapters: ${adapterError.message}`);
    }
    
    console.log(`[BACKFILL] Found ${adapters?.length || 0} platform adapters`);
    
    // Get all price extractions grouped by platform
    const { data: extractions, error: extractionError } = await supabaseClient
      .from('price_extractions')
      .select('platform_name, extraction_status, extraction_error, dates_validated, confidence_score, created_at, page_content_hash')
      .order('created_at', { ascending: false });
    
    if (extractionError) {
      throw new Error(`Failed to fetch extractions: ${extractionError.message}`);
    }
    
    console.log(`[BACKFILL] Found ${extractions?.length || 0} price extractions`);
    
    // Build stats per platform
    const platformStats: Map<string, PlatformStats> = new Map();
    
    // Initialize stats from adapters
    for (const adapter of adapters || []) {
      const key = adapter.platform_domain.toLowerCase();
      platformStats.set(key, {
        platformName: adapter.platform_name,
        platformDomain: adapter.platform_domain,
        totalAttempts: 0,
        totalSuccesses: 0,
        totalFailures: 0,
        lastSuccessAt: null,
        lastFailureAt: null,
        lastAttemptAt: null,
        lastOutcomeType: 'unknown',
        outcomeCounts: {
          success: 0,
          blocked: 0,
          login_required: 0,
          reserve_required: 0,
          payment_flow_required: 0,
          dates_not_applied: 0,
          no_availability: 0,
          price_not_found: 0,
          render_failed: 0,
          timeout: 0,
          unknown: 0,
        },
        dominantFailureReason: null,
        anyDatesValidated: false,
        anyGroundedSuccess: false,
      });
    }
    
    // Process extractions
    for (const extraction of extractions || []) {
      const platformName = extraction.platform_name?.toLowerCase() || '';
      
      // CRITICAL FIX: Use canonical domain normalization to prevent false positives
      // (e.g., "Ecohotels" incorrectly matching "hotels.com")
      const canonicalDomain = normalizeToAdapterDomain(platformName);
      
      let matchingKey: string | null = null;
      
      if (canonicalDomain) {
        // Step 1: Exact canonical domain match (preferred)
        if (platformStats.has(canonicalDomain)) {
          matchingKey = canonicalDomain;
        }
      }
      
      if (!matchingKey) {
        // Step 2: Try exact platform name match (case-insensitive)
        for (const [key, stats] of platformStats) {
          if (
            platformName === key ||
            platformName === stats.platformName.toLowerCase() ||
            platformName === stats.platformDomain.toLowerCase()
          ) {
            matchingKey = key;
            break;
          }
        }
      }
      
      if (!matchingKey) {
        // Skip extractions for platforms not in our adapter registry
        // Don't use fuzzy matching to prevent false positives
        console.log(`[BACKFILL] Skipping extraction for unknown platform: ${extraction.platform_name} (no canonical match)`);
        continue;
      }
      
      const stats = platformStats.get(matchingKey)!;
      const normalizedOutcome = normalizeOutcome(extraction.extraction_status, extraction.extraction_error);
      const isSuccess = normalizedOutcome === 'success';
      
      stats.totalAttempts++;
      stats.outcomeCounts[normalizedOutcome]++;
      
      if (isSuccess) {
        stats.totalSuccesses++;
        if (!stats.lastSuccessAt) {
          stats.lastSuccessAt = extraction.created_at;
        }
        // Check for grounded success (confidence >= 0.8 indicates hallucination guard passed)
        if (extraction.confidence_score !== null && extraction.confidence_score >= 0.8) {
          stats.anyGroundedSuccess = true;
        }
      } else {
        stats.totalFailures++;
        if (!stats.lastFailureAt) {
          stats.lastFailureAt = extraction.created_at;
        }
      }
      
      // Track last attempt and outcome (extractions are ordered desc, so first match is most recent)
      if (!stats.lastAttemptAt) {
        stats.lastAttemptAt = extraction.created_at;
        stats.lastOutcomeType = normalizedOutcome;
      }
      
      // Track dates validation
      if (extraction.dates_validated) {
        stats.anyDatesValidated = true;
      }
    }
    
    // Compute dominant failure reason and gates for each platform
    const updates: Array<{
      adapterId: string;
      platformName: string;
      updates: Record<string, any>;
    }> = [];
    
    for (const adapter of adapters || []) {
      const key = adapter.platform_domain.toLowerCase();
      const stats = platformStats.get(key);
      
      if (!stats || stats.totalAttempts === 0) {
        console.log(`[BACKFILL] No extractions found for ${adapter.platform_name}`);
        continue;
      }
      
      // Find dominant failure reason (most common non-success outcome)
      let maxFailureCount = 0;
      let dominantFailure: NormalizedOutcome = 'unknown';
      
      for (const [outcome, count] of Object.entries(stats.outcomeCounts)) {
        if (outcome !== 'success' && count > maxFailureCount) {
          maxFailureCount = count;
          dominantFailure = outcome as NormalizedOutcome;
        }
      }
      
      stats.dominantFailureReason = dominantFailure;
      
      // Compute gates
      const gate1Passed = stats.anyDatesValidated;
      const gate2Passed = stats.anyGroundedSuccess || stats.totalSuccesses > 0;
      const gate3Passed = !BLOCKING_FAILURE_REASONS.includes(dominantFailure);
      
      // Compute promotion score if all gates passed (only for Tier B)
      let promotionScore = 0;
      let promotionCandidateReason = '';
      
      if (adapter.coverage_tier === 'B') {
        if (gate1Passed && gate2Passed && gate3Passed) {
          // Success rate (0-1) - weight 0.5
          const successRate = stats.totalAttempts > 0 ? stats.totalSuccesses / stats.totalAttempts : 0;
          
          // Recency score (0-1) - weight 0.3
          let recencyScore = 0.1;
          if (stats.lastSuccessAt) {
            const daysSinceSuccess = (Date.now() - new Date(stats.lastSuccessAt).getTime()) / (1000 * 60 * 60 * 24);
            if (daysSinceSuccess <= 7) recencyScore = 1.0;
            else if (daysSinceSuccess <= 30) recencyScore = 0.5;
          }
          
          // Stability score (0-1) - weight 0.2
          const stabilityScore = (successRate >= 0.5 && gate3Passed) ? 1.0 : 0.5;
          
          promotionScore = (successRate * 0.5) + (recencyScore * 0.3) + (stabilityScore * 0.2);
          promotionScore = Math.round(promotionScore * 1000) / 1000;
          
          promotionCandidateReason = `Gates passed. Success rate: ${(successRate * 100).toFixed(0)}% (${stats.totalSuccesses}/${stats.totalAttempts}). Recent success: ${recencyScore >= 0.5 ? 'Yes' : 'No'}. Stable: ${stabilityScore >= 1.0 ? 'Yes' : 'No'}.`;
        } else {
          const failedGates = [];
          if (!gate1Passed) failedGates.push('Gate 1 (dates never validated)');
          if (!gate2Passed) failedGates.push('Gate 2 (no successful price extraction)');
          if (!gate3Passed) failedGates.push(`Gate 3 (blocking failure: ${dominantFailure})`);
          promotionCandidateReason = `Not eligible: ${failedGates.join(', ')}`;
        }
      }
      
      // Compute coverage_status based on evidence
      // - 'supported': Has at least 1 success and no blocking failures
      // - 'blocked': Dominant failure is blocking (bot detection, login required, etc.)
      // - 'unsupported': Has blocking failures that prevent extraction
      // - 'unknown': No attempts or no clear signal
      let coverageStatus = 'unknown';
      if (stats.totalSuccesses > 0) {
        // Has successful extractions - mark as supported
        coverageStatus = 'supported';
      } else if (stats.totalAttempts > 0) {
        // Has attempts but no successes - check why
        if (BLOCKING_FAILURE_REASONS.includes(dominantFailure)) {
          coverageStatus = dominantFailure === 'blocked' ? 'blocked' : 'unsupported';
        } else if (stats.totalAttempts >= 3) {
          // Multiple attempts, no success, but not blocked - might be an extraction issue
          coverageStatus = 'unknown';
        }
      }
      
      updates.push({
        adapterId: adapter.id,
        platformName: adapter.platform_name,
        updates: {
          total_attempts: stats.totalAttempts,
          total_successes: stats.totalSuccesses,
          total_failures: stats.totalFailures,
          last_success_at: stats.lastSuccessAt,
          last_failure_at: stats.lastFailureAt,
          last_attempt_at: stats.lastAttemptAt,
          last_outcome_type: stats.lastOutcomeType,
          gate_1_passed: gate1Passed,
          gate_2_passed: gate2Passed,
          gate_3_passed: gate3Passed,
          coverage_status: coverageStatus,
          promotion_score: promotionScore,
          last_scored_at: new Date().toISOString(),
          promotion_candidate: false, // Will be set by nomination logic
          promotion_candidate_reason: promotionCandidateReason,
          updated_at: new Date().toISOString(),
        },
      });
      
      console.log(`[BACKFILL] ${adapter.platform_name}: attempts=${stats.totalAttempts}, successes=${stats.totalSuccesses}, gates=[${gate1Passed}, ${gate2Passed}, ${gate3Passed}], score=${promotionScore}`);
    }
    
    // Apply updates
    for (const update of updates) {
      const { error: updateError } = await supabaseClient
        .from('platform_adapters')
        .update(update.updates)
        .eq('id', update.adapterId);
      
      if (updateError) {
        console.error(`[BACKFILL] Failed to update ${update.platformName}: ${updateError.message}`);
      }
    }
    
    // Nominate single promotion candidate
    // Clear all existing nominations first
    await supabaseClient
      .from('platform_adapters')
      .update({ promotion_candidate: false })
      .eq('promotion_candidate', true);
    
    // Find highest-scoring eligible Tier B platform
    const { data: eligiblePlatforms } = await supabaseClient
      .from('platform_adapters')
      .select('id, platform_name, promotion_score, promotion_candidate_reason')
      .eq('coverage_tier', 'B')
      .eq('gate_1_passed', true)
      .eq('gate_2_passed', true)
      .eq('gate_3_passed', true)
      .gt('promotion_score', 0)
      .order('promotion_score', { ascending: false })
      .limit(2);
    
    let nominatedCandidate: { id: string; platform_name: string; promotion_score: number; promotion_candidate_reason: string | null } | null = null;
    let runnerUp: { id: string; platform_name: string; promotion_score: number; promotion_candidate_reason: string | null } | null = null;

    if (eligiblePlatforms && eligiblePlatforms.length > 0) {
      nominatedCandidate = eligiblePlatforms[0];
      if (eligiblePlatforms.length > 1) {
        runnerUp = eligiblePlatforms[1];
      }
      
      await supabaseClient
        .from('platform_adapters')
        .update({
          promotion_candidate: true,
          promotion_candidate_reason: `Highest-scoring eligible platform (score: ${nominatedCandidate.promotion_score}). ${nominatedCandidate.promotion_candidate_reason || ''}`,
        })
        .eq('id', nominatedCandidate.id);
      
      console.log(`[BACKFILL] Nominated promotion candidate: ${nominatedCandidate.platform_name} (score: ${nominatedCandidate.promotion_score})`);
    } else {
      console.log(`[BACKFILL] No eligible promotion candidates found`);
    }
    
    const elapsedMs = Date.now() - startTime;
    
    const result = {
      success: true,
      elapsedMs,
      summary: {
        adaptersProcessed: adapters?.length || 0,
        extractionsProcessed: extractions?.length || 0,
        updatesApplied: updates.length,
        nominatedCandidate: nominatedCandidate?.platform_name || null,
        nominatedScore: nominatedCandidate?.promotion_score || null,
        runnerUp: runnerUp?.platform_name || null,
        runnerUpScore: runnerUp?.promotion_score || null,
      },
      platformDetails: updates.map(u => ({
        platform: u.platformName,
        attempts: u.updates.total_attempts,
        successes: u.updates.total_successes,
        failures: u.updates.total_failures,
        gates: [u.updates.gate_1_passed, u.updates.gate_2_passed, u.updates.gate_3_passed],
        promotionScore: u.updates.promotion_score,
        isCandidate: u.platformName === nominatedCandidate?.platform_name,
      })),
    };
    
    console.log(`[BACKFILL] Completed in ${elapsedMs}ms`);
    
    return new Response(JSON.stringify(result, null, 2), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
    
  } catch (error) {
    console.error(`[BACKFILL] Error: ${error}`);
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error',
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    );
  }
});
