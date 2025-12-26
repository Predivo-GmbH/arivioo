import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Terminal status values - no platform should remain outside these after pipeline completes
const TERMINAL_STATUSES = [
  'success',                          // Price extracted
  'dates_not_applied',                // Phase A failed - dates not applied
  'no_availability_for_dates',        // Phase A - dates unavailable
  'blocked_captcha_or_bot',           // Blocked by anti-bot
  'blocked_rate_limit',               // Rate limited
  'render_failed',                    // Page didn't render
  'listing_unavailable',              // 404 or listing removed
  'price_not_found_after_dates_applied', // Phase B - no price found
  'total_not_available_pre_checkout', // Price only at payment step
  'validation_error',                 // Validation logic error
  'extraction_error',                 // Extraction logic error
  'failed_unknown',                   // Unknown failure
] as const;

type TerminalStatus = typeof TERMINAL_STATUSES[number];

interface PipelineRequest {
  searchId: string;
  requestedCheckIn: string;
  requestedCheckOut: string;
  occupancy?: {
    adults: number;
    children: number;
    rooms: number;
  };
}

interface PlatformResult {
  platform: string;
  extractionId: string;
  deepLink: string;
  phaseA: {
    datesValidated: boolean;
    detectedCheckIn: string | null;
    detectedCheckOut: string | null;
    status: string;
    strategyUsed: string | null;
    evidence: string | null;
  };
  phaseB: {
    ran: boolean;
    extractedPrice: number | null;
    currency: string | null;
    includesTaxesFees: boolean | null;
    finalStatus: string;
    evidence: string | null;
  };
}

// Helper to apply date parameters to deep link based on platform
function applyDatesToDeepLink(url: string, platform: string, checkIn: string, checkOut: string, adults: number): string {
  const urlObj = new URL(url);
  const lowerPlatform = platform.toLowerCase();
  
  // Platform-specific date parameter mappings
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
  } else if (lowerPlatform.includes('houfy')) {
    urlObj.searchParams.set('check_in', checkIn);
    urlObj.searchParams.set('check_out', checkOut);
  } else {
    // Generic fallback - try common patterns
    urlObj.searchParams.set('check_in', checkIn);
    urlObj.searchParams.set('check_out', checkOut);
    urlObj.searchParams.set('adults', adults.toString());
  }
  
  return urlObj.toString();
}

// Call validate-dates edge function with timeout
async function runPhaseA(
  supabaseUrl: string,
  supabaseKey: string,
  extractionId: string,
  deepLink: string,
  platformName: string,
  requestedCheckIn: string,
  requestedCheckOut: string
): Promise<{ success: boolean; result: any; error?: string }> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 45000); // 45s timeout
    
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
    // On timeout, return explicit failure
    if (errorMsg.includes('aborted')) {
      return { success: false, result: null, error: 'Phase A timeout - marking as render_failed' };
    }
    return { success: false, result: null, error: errorMsg };
  }
}

// Call extract-prices edge function for Phase B
async function runPhaseB(
  supabaseUrl: string,
  supabaseKey: string,
  searchId: string,
  resultIds: string[]
): Promise<{ success: boolean; results: any[]; error?: string }> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s timeout
    
    const response = await fetch(`${supabaseUrl}/functions/v1/extract-prices`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        searchId,
        resultIds,
        requireValidation: true,
      }),
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, results: [], error: `HTTP ${response.status}: ${errorText}` };
    }
    
    const data = await response.json();
    return { success: true, results: data.results || [] };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, results: [], error: errorMsg };
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
    
    const supabaseClient = createClient(supabaseUrl, supabaseKey);
    
    const { searchId, requestedCheckIn, requestedCheckOut, occupancy } = await req.json() as PipelineRequest;
    
    const adults = occupancy?.adults ?? 2;
    const children = occupancy?.children ?? 0;
    const rooms = occupancy?.rooms ?? 1;
    
    console.log(`[PIPELINE] Starting for search ${searchId}, dates: ${requestedCheckIn} to ${requestedCheckOut}`);
    
    // Step 1: Fetch all search results for this search (matched platforms)
    const { data: searchResults, error: fetchError } = await supabaseClient
      .from('search_results')
      .select('id, platform_name, listing_url, confidence_score')
      .eq('search_id', searchId)
      .gte('confidence_score', 0.90)
      .order('confidence_score', { ascending: false });
    
    if (fetchError) {
      throw new Error(`Failed to fetch search results: ${fetchError.message}`);
    }
    
    if (!searchResults || searchResults.length === 0) {
      return new Response(
        JSON.stringify({ success: true, message: 'No matched platforms found', results: [] }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    console.log(`[PIPELINE] Found ${searchResults.length} matched platforms`);
    
    // Step 2: Create or update price_extractions for each platform
    const extractionIds: Map<string, { id: string; deepLink: string; platform: string }> = new Map();
    
    for (const result of searchResults) {
      const deepLink = applyDatesToDeepLink(
        result.listing_url,
        result.platform_name,
        requestedCheckIn,
        requestedCheckOut,
        adults
      );
      
      // Check for existing extraction
      const { data: existing } = await supabaseClient
        .from('price_extractions')
        .select('id')
        .eq('search_result_id', result.id)
        .eq('search_id', searchId)
        .single();
      
      if (existing) {
        // Reset to pending for re-run
        await supabaseClient
          .from('price_extractions')
          .update({
            extraction_status: 'pending',
            dates_validated: false,
            detected_checkin: null,
            detected_checkout: null,
            extracted_price: null,
            extraction_error: null,
            deep_link: deepLink,
            occupancy_assumed: true,
            assumed_adults: adults,
            assumed_children: children,
            assumed_rooms: rooms,
            updated_at: new Date().toISOString(),
          })
          .eq('id', existing.id);
        
        extractionIds.set(result.id, { id: existing.id, deepLink, platform: result.platform_name });
      } else {
        // Create new extraction
        const { data: newExtraction } = await supabaseClient
          .from('price_extractions')
          .insert({
            search_id: searchId,
            search_result_id: result.id,
            platform_name: result.platform_name,
            deep_link: deepLink,
            extraction_status: 'pending',
            occupancy_assumed: true,
            assumed_adults: adults,
            assumed_children: children,
            assumed_rooms: rooms,
          })
          .select()
          .single();
        
        if (newExtraction) {
          extractionIds.set(result.id, { id: newExtraction.id, deepLink, platform: result.platform_name });
        }
      }
    }
    
    console.log(`[PIPELINE] Created/updated ${extractionIds.size} price_extractions`);
    
    // Step 3: Run Phase A (validate-dates) for each platform
    // This is the ONLY way dates_validated can become true
    const phaseAResults: Map<string, PlatformResult> = new Map();
    const validatedResultIds: string[] = [];
    
    for (const [resultId, extraction] of extractionIds) {
      console.log(`[PIPELINE] Phase A: ${extraction.platform}`);
      
      const phaseAResponse = await runPhaseA(
        supabaseUrl,
        supabaseKey,
        extraction.id,
        extraction.deepLink,
        extraction.platform,
        requestedCheckIn,
        requestedCheckOut
      );
      
      const platformResult: PlatformResult = {
        platform: extraction.platform,
        extractionId: extraction.id,
        deepLink: extraction.deepLink,
        phaseA: {
          datesValidated: false,
          detectedCheckIn: null,
          detectedCheckOut: null,
          status: 'failed_unknown',
          strategyUsed: null,
          evidence: null,
        },
        phaseB: {
          ran: false,
          extractedPrice: null,
          currency: null,
          includesTaxesFees: null,
          finalStatus: 'pending',
          evidence: null,
        },
      };
      
      if (phaseAResponse.success && phaseAResponse.result) {
        const r = phaseAResponse.result;
        platformResult.phaseA = {
          datesValidated: r.success === true,
          detectedCheckIn: r.detectedCheckIn || null,
          detectedCheckOut: r.detectedCheckOut || null,
          status: r.status || 'failed_unknown',
          strategyUsed: r.strategyUsed || null,
          evidence: r.error || null,
        };
        
        if (r.success) {
          validatedResultIds.push(resultId);
        }
      } else {
        // Phase A call failed entirely - mark as render_failed
        platformResult.phaseA.status = 'render_failed';
        platformResult.phaseA.evidence = phaseAResponse.error || 'Phase A call failed';
        
        // Update DB with failure status
        await supabaseClient
          .from('price_extractions')
          .update({
            extraction_status: 'render_failed',
            extraction_error: phaseAResponse.error || 'Phase A timeout or network error',
            dates_validated: false,
          })
          .eq('id', extraction.id);
      }
      
      phaseAResults.set(extraction.id, platformResult);
    }
    
    console.log(`[PIPELINE] Phase A complete: ${validatedResultIds.length}/${extractionIds.size} validated`);
    
    // Step 4: Run Phase B (extract-prices) ONLY for validated platforms
    // Phase B MUST NOT run if dates_validated=false - this is enforced by requireValidation=true
    if (validatedResultIds.length > 0) {
      console.log(`[PIPELINE] Running Phase B for ${validatedResultIds.length} validated platforms`);
      
      const phaseBResponse = await runPhaseB(supabaseUrl, supabaseKey, searchId, validatedResultIds);
      
      if (!phaseBResponse.success) {
        console.error(`[PIPELINE] Phase B failed: ${phaseBResponse.error}`);
      }
    } else {
      console.log(`[PIPELINE] Skipping Phase B - no validated platforms`);
    }
    
    // Step 5: Fetch final state and ensure no pending statuses remain
    const { data: finalExtractions } = await supabaseClient
      .from('price_extractions')
      .select('*')
      .eq('search_id', searchId);
    
    const results: PlatformResult[] = [];
    let pendingCount = 0;
    
    for (const extraction of (finalExtractions || [])) {
      const existing = phaseAResults.get(extraction.id);
      
      // Check if status is terminal
      const isTerminal = TERMINAL_STATUSES.includes(extraction.extraction_status as TerminalStatus);
      
      if (!isTerminal) {
        pendingCount++;
        // Force terminal status for any remaining pending
        console.log(`[PIPELINE] Forcing terminal status for ${extraction.platform_name}`);
        await supabaseClient
          .from('price_extractions')
          .update({
            extraction_status: 'validation_error',
            extraction_error: 'Pipeline completed without reaching terminal status',
          })
          .eq('id', extraction.id);
      }
      
      const finalResult: PlatformResult = existing || {
        platform: extraction.platform_name,
        extractionId: extraction.id,
        deepLink: extraction.deep_link,
        phaseA: {
          datesValidated: extraction.dates_validated,
          detectedCheckIn: extraction.detected_checkin,
          detectedCheckOut: extraction.detected_checkout,
          status: extraction.dates_validated ? 'dates_validated' : extraction.extraction_status,
          strategyUsed: extraction.extraction_metadata?.strategy_used || null,
          evidence: extraction.extraction_error,
        },
        phaseB: {
          ran: extraction.dates_validated && extraction.extraction_status !== 'pending',
          extractedPrice: extraction.extracted_price,
          currency: extraction.currency,
          includesTaxesFees: extraction.includes_taxes_fees,
          finalStatus: extraction.extraction_status,
          evidence: extraction.extraction_error,
        },
      };
      
      // Update Phase B info from final extraction
      finalResult.phaseB = {
        ran: extraction.dates_validated === true && extraction.extraction_status !== 'pending',
        extractedPrice: extraction.extracted_price,
        currency: extraction.currency,
        includesTaxesFees: extraction.includes_taxes_fees,
        finalStatus: extraction.extraction_status,
        evidence: extraction.extraction_error,
      };
      
      results.push(finalResult);
    }
    
    // Summary statistics
    const successCount = results.filter(r => r.phaseB.finalStatus === 'success').length;
    const validatedCount = results.filter(r => r.phaseA.datesValidated).length;
    const failureBreakdown: Record<string, number> = {};
    
    for (const r of results) {
      if (r.phaseB.finalStatus !== 'success') {
        failureBreakdown[r.phaseB.finalStatus] = (failureBreakdown[r.phaseB.finalStatus] || 0) + 1;
      }
    }
    
    const elapsedMs = Date.now() - startTime;
    
    console.log(`[PIPELINE] Complete in ${elapsedMs}ms: ${successCount} success, ${validatedCount} validated, ${pendingCount} forced terminal`);
    
    return new Response(
      JSON.stringify({
        success: true,
        summary: {
          totalPlatforms: results.length,
          phasaAValidated: validatedCount,
          phaseBSuccess: successCount,
          pendingForced: pendingCount,
          elapsedMs,
          failureBreakdown,
        },
        results,
        confirmations: {
          zeroPending: pendingCount === 0 || `${pendingCount} forced to terminal`,
          noManualDbUpdates: true,
          phaseBOnlyWhenValidated: true,
        },
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
    
  } catch (error) {
    console.error('[PIPELINE] Fatal error:', error);
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
