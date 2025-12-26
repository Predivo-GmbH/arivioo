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
] as const;

type TerminalStatus = typeof TERMINAL_STATUSES[number];

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
}

// Per-phase timeout (35 seconds for Phase A, 45 seconds for Phase B)
const PHASE_A_TIMEOUT = 35000;
const PHASE_B_TIMEOUT = 45000;

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
    };
    
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
      result.phaseA.evidence = 'Phase A exceeded 35 second timeout';
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
      result.phaseB.evidence = 'Phase B exceeded 45 second timeout';
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
