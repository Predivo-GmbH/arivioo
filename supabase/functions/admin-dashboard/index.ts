import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

async function verifyAdminSession(supabase: any, token: string): Promise<{ valid: boolean; admin?: any; error?: string }> {
  if (!token) {
    return { valid: false, error: 'No token provided' };
  }

  const { data: session, error } = await supabase
    .from('admin_sessions')
    .select('*, admin_users(*)')
    .eq('session_token', token)
    .gt('expires_at', new Date().toISOString())
    .single();

  if (error || !session) {
    return { valid: false, error: 'Invalid or expired session' };
  }

  if (!session.admin_users.is_active) {
    return { valid: false, error: 'Account is disabled' };
  }

  return { valid: true, admin: session.admin_users };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  // Verify admin session
  const authHeader = req.headers.get('authorization');
  const token = authHeader?.replace('Bearer ', '');
  const authResult = await verifyAdminSession(supabase, token || '');

  if (!authResult.valid) {
    return new Response(
      JSON.stringify({ error: authResult.error }),
      { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const url = new URL(req.url);
  const action = url.pathname.split('/').pop();

  try {
    // SYSTEM HEALTH OVERVIEW
    if (action === 'health' && req.method === 'GET') {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const sevenDaysAgo = new Date(today);
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      const thirtyDaysAgo = new Date(today);
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      // Get search counts
      const { data: searchesToday } = await supabase
        .from('searches')
        .select('id', { count: 'exact' })
        .gte('created_at', today.toISOString());

      const { data: searchesWeek } = await supabase
        .from('searches')
        .select('id', { count: 'exact' })
        .gte('created_at', sevenDaysAgo.toISOString());

      // Get extraction counts
      const { data: extractionsToday } = await supabase
        .from('price_extractions')
        .select('id', { count: 'exact' })
        .gte('created_at', today.toISOString());

      const { data: extractionsWeek } = await supabase
        .from('price_extractions')
        .select('id', { count: 'exact' })
        .gte('created_at', sevenDaysAgo.toISOString());

      // Get extraction success/failure rates
      const { data: extractionStats } = await supabase
        .from('price_extractions')
        .select('extraction_status, created_at')
        .gte('created_at', sevenDaysAgo.toISOString());

      const successCount = extractionStats?.filter(e => e.extraction_status === 'success').length || 0;
      const failureCount = extractionStats?.filter(e => e.extraction_status === 'failed').length || 0;
      const totalCount = extractionStats?.length || 1;

      // Get platform adapter counts
      const { data: activeAdapters } = await supabase
        .from('platform_adapters')
        .select('id', { count: 'exact' })
        .eq('is_active', true);

      const { data: inactiveAdapters } = await supabase
        .from('platform_adapters')
        .select('id', { count: 'exact' })
        .eq('is_active', false);

      const { data: newAdapters } = await supabase
        .from('platform_adapters')
        .select('id', { count: 'exact' })
        .gte('created_at', thirtyDaysAgo.toISOString());

      // Get blocked platforms
      const { data: blockedPlatforms } = await supabase
        .from('blocked_platforms')
        .select('reason');

      const blockedReasons: Record<string, number> = {};
      blockedPlatforms?.forEach(bp => {
        blockedReasons[bp.reason] = (blockedReasons[bp.reason] || 0) + 1;
      });

      // Calculate average extraction duration from metadata
      const { data: completedExtractions } = await supabase
        .from('price_extractions')
        .select('extraction_metadata')
        .eq('extraction_status', 'success')
        .gte('created_at', sevenDaysAgo.toISOString())
        .limit(100);

      let avgDuration = 0;
      if (completedExtractions && completedExtractions.length > 0) {
        const durations = completedExtractions
          .map(e => e.extraction_metadata?.duration_ms)
          .filter(d => typeof d === 'number');
        if (durations.length > 0) {
          avgDuration = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
        }
      }

      // Daily breakdown for charts
      const dailyStats: Record<string, { searches: number; extractions: number; successes: number; failures: number }> = {};
      for (let i = 0; i < 7; i++) {
        const day = new Date(today);
        day.setDate(day.getDate() - i);
        const dayStr = day.toISOString().split('T')[0];
        dailyStats[dayStr] = { searches: 0, extractions: 0, successes: 0, failures: 0 };
      }

      extractionStats?.forEach(e => {
        const dayStr = e.created_at.split('T')[0];
        if (dailyStats[dayStr]) {
          dailyStats[dayStr].extractions++;
          if (e.extraction_status === 'success') dailyStats[dayStr].successes++;
          if (e.extraction_status === 'failed') dailyStats[dayStr].failures++;
        }
      });

      return new Response(
        JSON.stringify({
          searches: {
            today: searchesToday?.length || 0,
            last7Days: searchesWeek?.length || 0
          },
          extractions: {
            today: extractionsToday?.length || 0,
            last7Days: extractionsWeek?.length || 0,
            successRate: totalCount > 0 ? Math.round((successCount / totalCount) * 100) : 0,
            failureRate: totalCount > 0 ? Math.round((failureCount / totalCount) * 100) : 0,
            avgDurationMs: avgDuration
          },
          platforms: {
            active: activeAdapters?.length || 0,
            inactive: inactiveAdapters?.length || 0,
            newLast30Days: newAdapters?.length || 0
          },
          blockedPlatforms: {
            total: blockedPlatforms?.length || 0,
            byReason: blockedReasons
          },
          dailyStats: Object.entries(dailyStats)
            .map(([date, stats]) => ({ date, ...stats }))
            .sort((a, b) => a.date.localeCompare(b.date))
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // PIPELINE STATUS
    if (action === 'pipeline' && req.method === 'GET') {
      const { data: jobs } = await supabase
        .from('pipeline_jobs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100);

      const statusCounts: Record<string, number> = {
        queued: 0,
        running: 0,
        completed: 0,
        failed: 0
      };

      jobs?.forEach(job => {
        if (statusCounts[job.status] !== undefined) {
          statusCounts[job.status]++;
        }
      });

      const recentErrors = jobs
        ?.filter(j => j.status === 'failed')
        .slice(0, 50)
        .map(j => ({
          id: j.id,
          jobType: j.job_type,
          error: j.error_message,
          errorCategory: j.error_category,
          searchId: j.search_id,
          createdAt: j.created_at
        }));

      return new Response(
        JSON.stringify({
          counts: statusCounts,
          totalRetries: jobs?.reduce((sum, j) => sum + j.retry_count, 0) || 0,
          recentErrors
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // PRICE EXTRACTIONS
    if (action === 'extractions' && req.method === 'GET') {
      const params = url.searchParams;
      const platform = params.get('platform');
      const status = params.get('status');
      const provider = params.get('provider');
      const startDate = params.get('startDate');
      const endDate = params.get('endDate');
      const page = parseInt(params.get('page') || '1');
      const limit = parseInt(params.get('limit') || '50');

      let query = supabase
        .from('price_extractions')
        .select('*, searches(airbnb_url, airbnb_title)', { count: 'exact' });

      if (platform) query = query.eq('platform_name', platform);
      if (status) query = query.eq('extraction_status', status);
      if (provider) query = query.eq('provider_used', provider);
      if (startDate) query = query.gte('created_at', startDate);
      if (endDate) query = query.lte('created_at', endDate);

      const { data: extractions, count } = await query
        .order('created_at', { ascending: false })
        .range((page - 1) * limit, page * limit - 1);

      return new Response(
        JSON.stringify({
          extractions: extractions?.map(e => ({
            id: e.id,
            platformName: e.platform_name,
            deepLink: e.deep_link,
            status: e.extraction_status,
            extractedPrice: e.extracted_price,
            currency: e.currency,
            includesTaxesFees: e.includes_taxes_fees,
            providerUsed: e.provider_used,
            finalResolvedUrl: e.final_resolved_url,
            extractionStage: e.extraction_stage,
            confidenceScore: e.confidence_score,
            error: e.extraction_error,
            evidenceSnippets: e.evidence_snippets,
            metadata: e.extraction_metadata,
            assumedAdults: e.assumed_adults,
            assumedChildren: e.assumed_children,
            assumedRooms: e.assumed_rooms,
            priceType: e.price_type,
            createdAt: e.created_at,
            searchId: e.search_id,
            airbnbUrl: e.searches?.airbnb_url,
            airbnbTitle: e.searches?.airbnb_title
          })),
          total: count,
          page,
          limit,
          totalPages: Math.ceil((count || 0) / limit)
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // PLATFORM ADAPTERS
    if (action === 'adapters' && req.method === 'GET') {
      const { data: adapters } = await supabase
        .from('platform_adapters')
        .select('*')
        .order('platform_name');

      // Get success rates for each adapter
      const adapterStats = await Promise.all(
        (adapters || []).map(async (adapter) => {
          const sevenDaysAgo = new Date();
          sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

          const { data: extractions } = await supabase
            .from('price_extractions')
            .select('extraction_status, created_at')
            .eq('platform_name', adapter.platform_name)
            .gte('created_at', sevenDaysAgo.toISOString());

          const total = extractions?.length || 0;
          const successes = extractions?.filter(e => e.extraction_status === 'success').length || 0;

          // Get last successful extraction
          const { data: lastSuccess } = await supabase
            .from('price_extractions')
            .select('created_at')
            .eq('platform_name', adapter.platform_name)
            .eq('extraction_status', 'success')
            .order('created_at', { ascending: false })
            .limit(1)
            .single();

          // Get failure reasons
          const { data: failures } = await supabase
            .from('price_extractions')
            .select('extraction_error')
            .eq('platform_name', adapter.platform_name)
            .eq('extraction_status', 'failed')
            .gte('created_at', sevenDaysAgo.toISOString())
            .limit(50);

          const failureReasons: Record<string, number> = {};
          failures?.forEach(f => {
            const reason = f.extraction_error || 'unknown';
            failureReasons[reason] = (failureReasons[reason] || 0) + 1;
          });

          return {
            ...adapter,
            stats: {
              totalLast7Days: total,
              successRate: total > 0 ? Math.round((successes / total) * 100) : 0,
              lastSuccessAt: lastSuccess?.created_at,
              failureReasons
            }
          };
        })
      );

      return new Response(
        JSON.stringify({ adapters: adapterStats }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // UPDATE ADAPTER
    if (action === 'adapters' && req.method === 'PATCH') {
      const ip = req.headers.get('x-forwarded-for') || 'unknown';
      const userAgent = req.headers.get('user-agent') || 'unknown';
      const { id, ...updates } = await req.json();

      if (!id) {
        return new Response(
          JSON.stringify({ error: 'Adapter ID is required' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Get current values for audit log
      const { data: oldAdapter } = await supabase
        .from('platform_adapters')
        .select('*')
        .eq('id', id)
        .single();

      const { data: updatedAdapter, error } = await supabase
        .from('platform_adapters')
        .update(updates)
        .eq('id', id)
        .select()
        .single();

      if (error) {
        return new Response(
          JSON.stringify({ error: error.message }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Audit log
      await supabase.from('admin_audit_logs').insert({
        admin_user_id: authResult.admin.id,
        admin_email: authResult.admin.email,
        action: 'update_adapter',
        resource_type: 'platform_adapter',
        resource_id: id,
        old_values: oldAdapter,
        new_values: updatedAdapter,
        ip_address: ip,
        user_agent: userAgent
      });

      return new Response(
        JSON.stringify({ adapter: updatedAdapter }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // BLOCKED PLATFORMS
    if (action === 'blocked' && req.method === 'GET') {
      const { data: blocked } = await supabase
        .from('blocked_platforms')
        .select('*')
        .order('blocked_at', { ascending: false });

      return new Response(
        JSON.stringify({ blockedPlatforms: blocked }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ADD BLOCKED PLATFORM
    if (action === 'blocked' && req.method === 'POST') {
      const ip = req.headers.get('x-forwarded-for') || 'unknown';
      const userAgent = req.headers.get('user-agent') || 'unknown';
      const { domain, reason } = await req.json();

      if (!domain || !reason) {
        return new Response(
          JSON.stringify({ error: 'Domain and reason are required' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const { data: newBlocked, error } = await supabase
        .from('blocked_platforms')
        .insert({ domain, reason })
        .select()
        .single();

      if (error) {
        return new Response(
          JSON.stringify({ error: error.message }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      await supabase.from('admin_audit_logs').insert({
        admin_user_id: authResult.admin.id,
        admin_email: authResult.admin.email,
        action: 'block_platform',
        resource_type: 'blocked_platform',
        resource_id: newBlocked.id,
        new_values: newBlocked,
        ip_address: ip,
        user_agent: userAgent
      });

      return new Response(
        JSON.stringify({ blockedPlatform: newBlocked }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // UNBLOCK PLATFORM
    if (action === 'unblock' && req.method === 'POST') {
      const ip = req.headers.get('x-forwarded-for') || 'unknown';
      const userAgent = req.headers.get('user-agent') || 'unknown';
      const { id } = await req.json();

      const { data: oldBlocked } = await supabase
        .from('blocked_platforms')
        .select('*')
        .eq('id', id)
        .single();

      const { error } = await supabase
        .from('blocked_platforms')
        .delete()
        .eq('id', id);

      if (error) {
        return new Response(
          JSON.stringify({ error: error.message }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      await supabase.from('admin_audit_logs').insert({
        admin_user_id: authResult.admin.id,
        admin_email: authResult.admin.email,
        action: 'unblock_platform',
        resource_type: 'blocked_platform',
        resource_id: id,
        old_values: oldBlocked,
        ip_address: ip,
        user_agent: userAgent
      });

      return new Response(
        JSON.stringify({ success: true }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // AUDIT LOGS
    if (action === 'audit-logs' && req.method === 'GET') {
      const params = url.searchParams;
      const page = parseInt(params.get('page') || '1');
      const limit = parseInt(params.get('limit') || '50');

      const { data: logs, count } = await supabase
        .from('admin_audit_logs')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range((page - 1) * limit, page * limit - 1);

      return new Response(
        JSON.stringify({
          logs,
          total: count,
          page,
          limit,
          totalPages: Math.ceil((count || 0) / limit)
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ error: 'Not found' }),
      { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[Admin Dashboard] Error:', error);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
