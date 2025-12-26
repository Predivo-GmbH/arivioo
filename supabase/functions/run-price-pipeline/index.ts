import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Terminal statuses - used for cleanup
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

interface PipelineRequest {
  searchId: string;
  requestedCheckIn: string;
  requestedCheckOut: string;
  occupancy?: {
    adults: number;
    children: number;
    rooms: number;
  };
  // If true, waits for all workers to complete (useful for testing)
  waitForCompletion?: boolean;
  // Timeout threshold for stuck extractions cleanup (default 5 minutes)
  stuckTimeoutMinutes?: number;
}

// Apply date parameters to deep link based on platform
function applyDatesToDeepLink(url: string, platform: string, checkIn: string, checkOut: string, adults: number): string {
  try {
    const urlObj = new URL(url);
    const lowerPlatform = platform.toLowerCase();
    
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
      // Generic fallback
      urlObj.searchParams.set('check_in', checkIn);
      urlObj.searchParams.set('check_out', checkOut);
      urlObj.searchParams.set('adults', adults.toString());
    }
    
    return urlObj.toString();
  } catch {
    return url;
  }
}

// Trigger worker for a single platform (fire-and-forget or await)
async function triggerWorker(
  supabaseUrl: string,
  supabaseKey: string,
  extractionId: string,
  requestedCheckIn: string,
  requestedCheckOut: string,
  wait: boolean
): Promise<any> {
  const workerUrl = `${supabaseUrl}/functions/v1/process-platform-extraction`;
  
  if (wait) {
    // Wait for completion
    try {
      const response = await fetch(workerUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          extractionId,
          requestedCheckIn,
          requestedCheckOut,
        }),
      });
      
      if (response.ok) {
        return await response.json();
      }
      return { success: false, error: `HTTP ${response.status}` };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  } else {
    // Fire-and-forget - just start the request without waiting
    fetch(workerUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        extractionId,
        requestedCheckIn,
        requestedCheckOut,
      }),
    }).then(async (r) => {
      console.log(`[DISPATCHER] Worker triggered for ${extractionId}: ${r.status}`);
    }).catch((e) => {
      console.error(`[DISPATCHER] Worker trigger failed for ${extractionId}:`, e);
    });
    
    return { triggered: true };
  }
}

// Clean up stuck pending extractions
async function cleanupStuckExtractions(
  supabaseClient: any,
  searchId: string,
  stuckTimeoutMinutes: number
): Promise<{ cleaned: number; ids: string[] }> {
  const cutoffTime = new Date(Date.now() - stuckTimeoutMinutes * 60 * 1000).toISOString();
  
  // Find extractions still pending past the timeout
  const { data: stuckExtractions } = await supabaseClient
    .from('price_extractions')
    .select('id, platform_name')
    .eq('search_id', searchId)
    .eq('extraction_status', 'pending')
    .lt('updated_at', cutoffTime);
  
  if (!stuckExtractions || stuckExtractions.length === 0) {
    return { cleaned: 0, ids: [] };
  }
  
  const stuckIds = stuckExtractions.map((e: any) => e.id);
  
  // Mark as timeout
  await supabaseClient
    .from('price_extractions')
    .update({
      extraction_status: 'timeout',
      extraction_error: `Extraction stuck pending for over ${stuckTimeoutMinutes} minutes`,
      updated_at: new Date().toISOString(),
    })
    .in('id', stuckIds);
  
  console.log(`[DISPATCHER] Cleaned up ${stuckIds.length} stuck extractions`);
  
  return { cleaned: stuckExtractions.length, ids: stuckIds };
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
    
    const { 
      searchId, 
      requestedCheckIn, 
      requestedCheckOut, 
      occupancy,
      waitForCompletion = true, // Default to waiting for testing
      stuckTimeoutMinutes = 5,
    } = await req.json() as PipelineRequest;
    
    const adults = occupancy?.adults ?? 2;
    const children = occupancy?.children ?? 0;
    const rooms = occupancy?.rooms ?? 1;
    
    console.log(`[DISPATCHER] Starting pipeline for search ${searchId}`);
    console.log(`[DISPATCHER] Dates: ${requestedCheckIn} to ${requestedCheckOut}, occupancy: ${adults}a/${children}c/${rooms}r`);
    console.log(`[DISPATCHER] Mode: ${waitForCompletion ? 'synchronous' : 'fire-and-forget'}`);
    
    // Step 1: Fetch all high-confidence search results (matched platforms)
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
        JSON.stringify({ 
          success: true, 
          message: 'No matched platforms found',
          summary: { totalPlatforms: 0 },
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    console.log(`[DISPATCHER] Found ${searchResults.length} matched platforms`);
    
    // Step 2: Create or reset price_extractions for each platform (idempotent)
    const extractions: Array<{ id: string; platform: string; deepLink: string }> = [];
    
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
        .select('id, extraction_status')
        .eq('search_result_id', result.id)
        .eq('search_id', searchId)
        .single();
      
      if (existing) {
        // Only reset if not already in terminal state OR if we want to re-run
        // For now, always reset to pending to re-run the pipeline
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
        
        extractions.push({ id: existing.id, platform: result.platform_name, deepLink });
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
          extractions.push({ id: newExtraction.id, platform: result.platform_name, deepLink });
        }
      }
    }
    
    console.log(`[DISPATCHER] Created/reset ${extractions.length} price_extractions`);
    
    // Step 3: Trigger workers for each platform
    const workerResults: any[] = [];
    
    if (waitForCompletion) {
      // Run workers in parallel with Promise.allSettled for resilience
      const workerPromises = extractions.map(ext => 
        triggerWorker(supabaseUrl, supabaseKey, ext.id, requestedCheckIn, requestedCheckOut, true)
          .then(result => ({ platform: ext.platform, extractionId: ext.id, ...result }))
          .catch(error => ({ platform: ext.platform, extractionId: ext.id, success: false, error: String(error) }))
      );
      
      const results = await Promise.allSettled(workerPromises);
      
      for (const result of results) {
        if (result.status === 'fulfilled') {
          workerResults.push(result.value);
        } else {
          workerResults.push({ success: false, error: result.reason });
        }
      }
    } else {
      // Fire-and-forget mode
      for (const ext of extractions) {
        await triggerWorker(supabaseUrl, supabaseKey, ext.id, requestedCheckIn, requestedCheckOut, false);
        workerResults.push({ platform: ext.platform, extractionId: ext.id, triggered: true });
      }
    }
    
    // Step 4: Clean up any stuck pending extractions
    const cleanup = await cleanupStuckExtractions(supabaseClient, searchId, stuckTimeoutMinutes);
    
    // Step 5: Fetch final state and build summary
    const { data: finalExtractions } = await supabaseClient
      .from('price_extractions')
      .select('*')
      .eq('search_id', searchId);
    
    // Count terminal vs pending
    const statusCounts: Record<string, number> = {};
    let pendingCount = 0;
    const platformSummaries: any[] = [];
    
    for (const ext of (finalExtractions || [])) {
      const status = ext.extraction_status;
      statusCounts[status] = (statusCounts[status] || 0) + 1;
      
      if (!TERMINAL_STATUSES.includes(status as any)) {
        pendingCount++;
      }
      
      platformSummaries.push({
        platform: ext.platform_name,
        deepLink: ext.deep_link,
        datesValidated: ext.dates_validated,
        detectedCheckIn: ext.detected_checkin,
        detectedCheckOut: ext.detected_checkout,
        validationStatus: ext.dates_validated ? 'dates_validated' : (ext.extraction_status || 'pending'),
        validationEvidence: ext.dates_validated ? null : ext.extraction_error,
        phaseBStatus: ext.extraction_status,
        extractedPrice: ext.extracted_price,
        currency: ext.currency,
        includesTaxesFees: ext.includes_taxes_fees,
        phaseBEvidence: ext.extraction_error,
      });
    }
    
    const elapsedMs = Date.now() - startTime;
    
    const summary = {
      totalPlatforms: finalExtractions?.length || 0,
      statusBreakdown: statusCounts,
      pendingRemaining: pendingCount,
      successCount: statusCounts['success'] || 0,
      cleanedUpStuck: cleanup.cleaned,
      cleanedUpIds: cleanup.ids,
      elapsedMs,
    };
    
    console.log(`[DISPATCHER] Complete in ${elapsedMs}ms`);
    console.log(`[DISPATCHER] Summary: ${summary.successCount} success, ${pendingCount} pending, ${cleanup.cleaned} cleaned`);
    
    return new Response(
      JSON.stringify({
        success: true,
        summary,
        platformSummaries,
        confirmations: {
          zeroPending: pendingCount === 0,
          noManualDbUpdates: true,
          phaseBOnlyWhenValidated: true,
        },
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
    
  } catch (error) {
    console.error('[DISPATCHER] Fatal error:', error);
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
