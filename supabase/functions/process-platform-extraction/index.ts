import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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
const DEDICATED_EXTRACTOR_TIMEOUT = 90000; // 90s for dedicated extractors (they handle both phases)

// Golden path platforms with dedicated extractors
const GOLDEN_PATH_PLATFORMS: Record<string, string> = {
  'hotels.com': 'extract-hotelscom',
  'expedia.com': 'extract-expedia',
};

// Check if platform has a dedicated golden path extractor
function getDedicatedExtractor(platformName: string): string | null {
  const platformLower = platformName.toLowerCase();
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
    
    // Query platform_adapters for coverage_tier
    const { data: adapters } = await supabaseClient
      .from('platform_adapters')
      .select('coverage_tier, tier_reason, dedicated_extractor, platform_domain')
      .or(`platform_name.ilike.%${platformLower}%,platform_domain.ilike.%${platformLower}%`)
      .limit(1);
    
    if (adapters && adapters.length > 0) {
      const adapter = adapters[0];
      return {
        tier: (adapter.coverage_tier || 'B') as CoverageTier,
        reason: adapter.tier_reason,
        dedicatedExtractor: adapter.dedicated_extractor,
      };
    }
    
    // Default to Tier B (best effort) for unknown platforms
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
    
    const response = await fetch(`${supabaseUrl}/functions/v1/${extractorName}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        extractionId,
        url: deepLink,
        checkIn: requestedCheckIn,
        checkOut: requestedCheckOut,
        adults,
        requireValidation: true,
      }),
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
    const deepLink = extraction.deep_link;
    const searchId = extraction.search_id;
    const searchResultId = extraction.search_result_id;
    
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
    if (tierInfo.tier === 'A' && dedicatedExtractor) {
      console.log(`[WORKER] Using GOLDEN PATH extractor: ${dedicatedExtractor} for ${platform}`);
      
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
      
      if (extractorResult) {
        // Phase A results
        result.phaseA.datesValidated = extractorResult.phaseA?.datesValidated || extractorResult.dates_validated || false;
        result.phaseA.detectedCheckIn = extractorResult.phaseA?.detectedCheckIn || extractorResult.detected_checkin || null;
        result.phaseA.detectedCheckOut = extractorResult.phaseA?.detectedCheckOut || extractorResult.detected_checkout || null;
        result.phaseA.status = extractorResult.phaseA?.status || (result.phaseA.datesValidated ? 'success' : 'dates_not_applied');
        
        // Phase B results
        result.phaseB.extractedPrice = extractorResult.phaseB?.extractedPrice || extractorResult.extracted_price || null;
        result.phaseB.currency = extractorResult.phaseB?.currency || extractorResult.currency || null;
        result.phaseB.includesTaxesFees = extractorResult.phaseB?.includesTaxesFees ?? extractorResult.includes_taxes_fees ?? null;
        result.phaseB.status = extractorResult.phaseB?.status || extractorResult.status || 'extraction_error';
        result.phaseB.evidence = extractorResult.phaseB?.evidenceSnippet || extractorResult.evidence_snippet || null;
        
        // Map to terminal status
        if (extractorResult.success && result.phaseB.extractedPrice) {
          result.finalStatus = 'success';
        } else if (!result.phaseA.datesValidated) {
          // Map Phase A failure
          const phaseAStatus = extractorResult.phaseA?.status || extractorResult.status || '';
          if (phaseAStatus.includes('sold_out') || phaseAStatus.includes('no_availability')) {
            result.finalStatus = 'no_availability_for_dates';
          } else if (phaseAStatus.includes('blocked') || phaseAStatus.includes('captcha')) {
            result.finalStatus = 'blocked_captcha_or_bot';
          } else {
            result.finalStatus = 'dates_not_applied';
          }
        } else {
          // Phase A passed but Phase B failed
          const phaseBStatus = extractorResult.phaseB?.status || extractorResult.status || '';
          if (phaseBStatus.includes('price_not_found') || phaseBStatus.includes('no_price')) {
            result.finalStatus = 'price_not_found_after_dates_applied';
          } else if (phaseBStatus.includes('blocked')) {
            result.finalStatus = 'blocked_captcha_or_bot';
          } else {
            result.finalStatus = 'extraction_error';
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
      
      // Map to terminal status
      const isSuccess = updatedExtraction.extraction_status === 'success' && updatedExtraction.extracted_price;
      
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
        
        result.finalStatus = statusMap[updatedExtraction.extraction_status] || 'extraction_error';
        
        // Ensure DB has terminal status if still pending
        if (updatedExtraction.extraction_status === 'pending') {
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
