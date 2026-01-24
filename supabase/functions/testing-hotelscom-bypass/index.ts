import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function normalizePlatformName(p: string) {
  return (p || '').toLowerCase().replace(/[^a-z]/g, '')
}

function isBypassAirbnbUrl(airbnbUrl: string) {
  try {
    const u = new URL(airbnbUrl)
    const m = u.pathname.match(/\/rooms\/(\d+)/)
    return m?.[1] === '1411591824436140561'
  } catch {
    return false
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return new Response(
        JSON.stringify({ success: false, error: 'Server not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const body = await req.json().catch(() => null)
    const searchId = body?.searchId as string | undefined
    if (!searchId) {
      return new Response(
        JSON.stringify({ success: false, error: 'searchId is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    // TESTING-ONLY: This endpoint is intentionally public (verify_jwt=false),
    // but it is hard-restricted to a single Airbnb room ID to avoid general abuse.
    // It uses service-role to read required search data and trigger extraction.
    const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

    const { data: search, error: searchErr } = await serviceClient
      .from('searches')
      .select('id, airbnb_url, check_in_date, check_out_date')
      .eq('id', searchId)
      .maybeSingle()

    if (searchErr || !search) {
      return new Response(
        JSON.stringify({ success: false, error: 'Search not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    if (!search.airbnb_url || !isBypassAirbnbUrl(search.airbnb_url)) {
      return new Response(
        JSON.stringify({ success: false, error: 'Not eligible for testing bypass' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const checkIn = search.check_in_date
    const checkOut = search.check_out_date
    if (!checkIn || !checkOut) {
      return new Response(
        JSON.stringify({ success: false, error: 'Search dates missing' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    // Find the Hotels.com candidate in search_platforms
    const { data: candidates, error: candErr } = await serviceClient
      .from('search_platforms')
      .select('id, platform_name, listing_url')
      .eq('search_id', searchId)

    if (candErr) {
      return new Response(
        JSON.stringify({ success: false, error: `Failed to load candidates: ${candErr.message}` }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const hotels = (candidates || []).find((c: any) => {
      const n = normalizePlatformName(c.platform_name)
      return n === 'hotelscom' || n === 'hotels'
    })

    if (!hotels?.listing_url) {
      return new Response(
        JSON.stringify({ success: false, error: 'Hotels.com candidate not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    // Create (or reuse) a price_extractions row for Hotels.com
    const { data: existing } = await serviceClient
      .from('price_extractions')
      .select('id, extraction_status')
      .eq('search_id', searchId)
      .eq('platform_name', 'Hotels.com')
      .order('created_at', { ascending: false })
      .limit(1)

    let extractionId = existing?.[0]?.id as string | undefined

    if (!extractionId) {
      const { data: inserted, error: insErr } = await serviceClient
        .from('price_extractions')
        .insert({
          search_id: searchId,
          platform_name: 'Hotels.com',
          deep_link: hotels.listing_url,
          extraction_status: 'pending',
          price_type: 'UNKNOWN',
          dates_validated: false,
        })
        .select('id')
        .single()

      if (insErr || !inserted?.id) {
        return new Response(
          JSON.stringify({ success: false, error: `Failed to create extraction: ${insErr?.message || 'unknown'}` }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        )
      }
      extractionId = inserted.id

      await serviceClient
        .from('search_platforms')
        .update({
          extraction_id_latest: extractionId,
          extraction_status_terminal: null,
          last_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', hotels.id)
    }

    // IMPORTANT (testing-only): do NOT route through process-platform-extraction here,
    // because tier lookup may incorrectly short-circuit Hotels.com as Tier C.
    // Call the dedicated extractor directly.
    const extractorResp = await fetch(`${SUPABASE_URL}/functions/v1/extract-hotelscom`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        extractionId,
        url: hotels.listing_url,
        checkIn,
        checkOut,
        adults: 1,
        requireValidation: true,
      }),
    })

    const extractorText = await extractorResp.text()

    let parsed: any = null
    try {
      parsed = extractorText ? JSON.parse(extractorText) : null
    } catch {
      parsed = { raw: extractorText }
    }

    // Normalize response to always 200 for frontend use
    if (!extractorResp.ok) {
      return new Response(
        JSON.stringify({
          success: false,
          error: `Extractor failed: HTTP ${extractorResp.status}`,
          extractionId,
          extractor: parsed,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    return new Response(
      JSON.stringify({ success: true, extractionId, extractor: parsed }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error'
    return new Response(
      JSON.stringify({ success: false, error: msg }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }
})
