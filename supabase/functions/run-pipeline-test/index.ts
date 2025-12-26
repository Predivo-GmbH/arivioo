import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Test endpoint to run the two-phase pipeline without auth
// This is for debugging purposes only

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !supabaseServiceKey) {
    return new Response(
      JSON.stringify({ error: 'Missing credentials' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const { searchId, extractionId, action } = await req.json();
    
    console.log(`[TEST-PIPELINE] Action: ${action}, SearchId: ${searchId}, ExtractionId: ${extractionId}`);

    // Action: validate - Run Phase A for a single extraction
    if (action === 'validate' && extractionId) {
      // Get extraction details
      const { data: extraction, error: fetchError } = await supabase
        .from('price_extractions')
        .select('*')
        .eq('id', extractionId)
        .single();

      if (fetchError || !extraction) {
        return new Response(
          JSON.stringify({ error: `Extraction not found: ${fetchError?.message}` }),
          { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Get search details for dates
      const { data: search } = await supabase
        .from('searches')
        .select('check_in_date, check_out_date')
        .eq('id', extraction.search_id)
        .single();

      // Call validate-dates
      const validateResponse = await fetch(`${supabaseUrl}/functions/v1/validate-dates`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${supabaseServiceKey}`,
        },
        body: JSON.stringify({
          extractionId: extraction.id,
          deepLink: extraction.deep_link,
          platformName: extraction.platform_name,
          requestedCheckIn: search?.check_in_date || '2026-01-04',
          requestedCheckOut: search?.check_out_date || '2026-01-08',
        }),
      });

      const result = await validateResponse.json();
      
      // Get updated extraction
      const { data: updated } = await supabase
        .from('price_extractions')
        .select('*')
        .eq('id', extractionId)
        .single();

      return new Response(
        JSON.stringify({ 
          action: 'validate',
          extractionId,
          result,
          updated,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Action: validate_all - Run Phase A for all extractions in a search
    if (action === 'validate_all' && searchId) {
      const { data: extractions } = await supabase
        .from('price_extractions')
        .select('id, platform_name, deep_link')
        .eq('search_id', searchId)
        .eq('extraction_status', 'pending');

      const { data: search } = await supabase
        .from('searches')
        .select('check_in_date, check_out_date')
        .eq('id', searchId)
        .single();

      const results: any[] = [];

      for (const extraction of (extractions || [])) {
        console.log(`[TEST-PIPELINE] Validating ${extraction.platform_name}...`);
        
        try {
          const validateResponse = await fetch(`${supabaseUrl}/functions/v1/validate-dates`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${supabaseServiceKey}`,
            },
            body: JSON.stringify({
              extractionId: extraction.id,
              deepLink: extraction.deep_link,
              platformName: extraction.platform_name,
              requestedCheckIn: search?.check_in_date || '2026-01-04',
              requestedCheckOut: search?.check_out_date || '2026-01-08',
            }),
          });

          const result = await validateResponse.json();
          results.push({
            platform: extraction.platform_name,
            result,
          });
        } catch (err) {
          results.push({
            platform: extraction.platform_name,
            error: err instanceof Error ? err.message : 'Unknown error',
          });
        }

        // Rate limit
        await new Promise(resolve => setTimeout(resolve, 1500));
      }

      // Get final state
      const { data: finalExtractions } = await supabase
        .from('price_extractions')
        .select('id, platform_name, extraction_status, dates_validated, detected_checkin, detected_checkout, extraction_error')
        .eq('search_id', searchId);

      return new Response(
        JSON.stringify({
          action: 'validate_all',
          searchId,
          results,
          finalState: finalExtractions,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Action: extract - Run Phase B for validated extractions
    if (action === 'extract' && searchId) {
      const extractResponse = await fetch(`${supabaseUrl}/functions/v1/extract-prices`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${supabaseServiceKey}`,
        },
        body: JSON.stringify({ searchId, requireValidation: true }),
      });

      const result = await extractResponse.json();

      // Get final state
      const { data: finalExtractions } = await supabase
        .from('price_extractions')
        .select('id, platform_name, extraction_status, dates_validated, extracted_price, currency, includes_taxes_fees, extraction_stage, extraction_error')
        .eq('search_id', searchId);

      return new Response(
        JSON.stringify({
          action: 'extract',
          searchId,
          result,
          finalState: finalExtractions,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Action: full_pipeline - Run complete Phase A + Phase B
    if (action === 'full_pipeline' && searchId) {
      const { data: extractions } = await supabase
        .from('price_extractions')
        .select('id, platform_name, deep_link')
        .eq('search_id', searchId)
        .eq('extraction_status', 'pending');

      const { data: search } = await supabase
        .from('searches')
        .select('check_in_date, check_out_date')
        .eq('id', searchId)
        .single();

      const phaseAResults: any[] = [];

      // Phase A: Validate all
      console.log(`[TEST-PIPELINE] Phase A: Validating ${extractions?.length || 0} extractions`);
      
      for (const extraction of (extractions || [])) {
        console.log(`[TEST-PIPELINE] Phase A: ${extraction.platform_name}`);
        
        try {
          const validateResponse = await fetch(`${supabaseUrl}/functions/v1/validate-dates`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${supabaseServiceKey}`,
            },
            body: JSON.stringify({
              extractionId: extraction.id,
              deepLink: extraction.deep_link,
              platformName: extraction.platform_name,
              requestedCheckIn: search?.check_in_date || '2026-01-04',
              requestedCheckOut: search?.check_out_date || '2026-01-08',
            }),
          });

          const result = await validateResponse.json();
          phaseAResults.push({ platform: extraction.platform_name, ...result });
        } catch (err) {
          phaseAResults.push({
            platform: extraction.platform_name,
            error: err instanceof Error ? err.message : 'Unknown error',
          });
        }

        await new Promise(resolve => setTimeout(resolve, 1500));
      }

      // Check how many passed Phase A
      const { data: validatedExtractions } = await supabase
        .from('price_extractions')
        .select('id, platform_name, dates_validated')
        .eq('search_id', searchId)
        .eq('dates_validated', true);

      console.log(`[TEST-PIPELINE] Phase A complete: ${validatedExtractions?.length || 0} validated`);

      // Phase B: Extract prices for validated only
      let phaseBResult: any = { skipped: true, reason: 'No validated extractions' };
      
      if (validatedExtractions && validatedExtractions.length > 0) {
        console.log(`[TEST-PIPELINE] Phase B: Extracting prices for ${validatedExtractions.length} validated extractions`);
        
        const extractResponse = await fetch(`${supabaseUrl}/functions/v1/extract-prices`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${supabaseServiceKey}`,
          },
          body: JSON.stringify({ searchId, requireValidation: true }),
        });

        phaseBResult = await extractResponse.json();
      }

      // Get final state
      const { data: finalExtractions } = await supabase
        .from('price_extractions')
        .select('id, platform_name, deep_link, extraction_status, dates_validated, detected_checkin, detected_checkout, extracted_price, currency, includes_taxes_fees, extraction_stage, extraction_error, provider_used')
        .eq('search_id', searchId);

      // Summary stats
      const summary = {
        totalPlatforms: finalExtractions?.length || 0,
        phaseAValidated: finalExtractions?.filter(e => e.dates_validated).length || 0,
        phaseBExtracted: finalExtractions?.filter(e => e.extracted_price !== null).length || 0,
        statusBreakdown: {} as Record<string, number>,
      };

      for (const e of (finalExtractions || [])) {
        summary.statusBreakdown[e.extraction_status] = (summary.statusBreakdown[e.extraction_status] || 0) + 1;
      }

      return new Response(
        JSON.stringify({
          action: 'full_pipeline',
          searchId,
          requestedDates: {
            checkIn: search?.check_in_date,
            checkOut: search?.check_out_date,
          },
          phaseA: {
            results: phaseAResults,
            validated: validatedExtractions?.length || 0,
          },
          phaseB: phaseBResult,
          finalState: finalExtractions,
          summary,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ 
        error: 'Invalid action. Use: validate, validate_all, extract, or full_pipeline',
        usage: {
          validate: '{ action: "validate", extractionId: "..." }',
          validate_all: '{ action: "validate_all", searchId: "..." }',
          extract: '{ action: "extract", searchId: "..." }',
          full_pipeline: '{ action: "full_pipeline", searchId: "..." }',
        }
      }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[TEST-PIPELINE] Error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
