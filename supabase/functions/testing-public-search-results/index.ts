import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// TESTING-ONLY: hard restrict to a single known search ID to avoid any data exposure.
const ALLOWED_SEARCH_ID = 'ad29e42c-1e5c-4190-b446-6b104fc795b1'

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

    if (searchId !== ALLOWED_SEARCH_ID) {
      return new Response(
        JSON.stringify({ success: false, error: 'Not eligible for testing public view' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

    const { data: search, error: searchErr } = await serviceClient
      .from('searches')
      .select('id, airbnb_url, airbnb_title, airbnb_price, airbnb_currency, airbnb_image_url, airbnb_images, status, created_at, check_in_date, check_out_date, nights_count, finalised_at, final_results_snapshot')
      .eq('id', searchId)
      .single()

    if (searchErr || !search) {
      return new Response(
        JSON.stringify({ success: false, error: 'Search not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    return new Response(
      JSON.stringify({
        success: true,
        search,
        snapshot: (search as any).final_results_snapshot ?? null,
      }),
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
