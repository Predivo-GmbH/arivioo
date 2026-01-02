import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Allowed origins for CORS - restrict to Lovable app domains
const ALLOWED_ORIGINS = [
  'https://lovable.dev',
  'https://www.lovable.dev',
  'https://arivioo.com',
  'https://www.arivioo.com',
  /^https:\/\/[a-zA-Z0-9-]+\.lovable\.app$/,  // Any Lovable app subdomain
  /^https:\/\/[a-zA-Z0-9-]+\.lovableproject\.com$/,  // Any Lovable project subdomain
  /^https:\/\/id-preview--[a-zA-Z0-9-]+\.lovable\.app$/,  // Lovable preview domains
];

function isOriginAllowed(origin: string | null): boolean {
  if (!origin) return false;
  return ALLOWED_ORIGINS.some(allowed => {
    if (typeof allowed === 'string') {
      return origin === allowed;
    }
    return allowed.test(origin);
  });
}

function getCorsHeaders(requestOrigin: string | null): Record<string, string> {
  const origin = requestOrigin && isOriginAllowed(requestOrigin) ? requestOrigin : '';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin',
  };
}

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
  const origin = req.headers.get('origin');
  const corsHeaders = getCorsHeaders(origin);
  
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
  
  console.log('[Admin Dashboard] Request:', { method: req.method, action, pathname: url.pathname });

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

    // SYSTEM HEALTH - returns health indicators for all dashboard sections
    if (action === 'system-health' && req.method === 'GET') {
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      const fourHoursAgo = new Date(now.getTime() - 4 * 60 * 60 * 1000);
      
      // Check pipeline health (search_stage_runs)
      const { data: recentStageRuns } = await supabase
        .from('search_stage_runs')
        .select('finished_at')
        .order('finished_at', { ascending: false })
        .limit(1);
      
      const lastPipelineActivity = recentStageRuns?.[0]?.finished_at;
      const pipelineLastUpdate = lastPipelineActivity ? new Date(lastPipelineActivity) : null;
      const pipelineHealthy = pipelineLastUpdate && pipelineLastUpdate > oneHourAgo;
      const pipelineStale = pipelineLastUpdate && pipelineLastUpdate <= oneHourAgo && pipelineLastUpdate > fourHoursAgo;
      
      // Check extractions health
      const { data: recentExtractions } = await supabase
        .from('price_extractions')
        .select('updated_at')
        .order('updated_at', { ascending: false })
        .limit(1);
      
      const lastExtractionActivity = recentExtractions?.[0]?.updated_at;
      const extractionLastUpdate = lastExtractionActivity ? new Date(lastExtractionActivity) : null;
      const extractionHealthy = extractionLastUpdate && extractionLastUpdate > oneHourAgo;
      const extractionStale = extractionLastUpdate && extractionLastUpdate <= oneHourAgo && extractionLastUpdate > fourHoursAgo;
      
      // Check platform adapters health
      const { data: recentAdapterUpdates } = await supabase
        .from('platform_adapters')
        .select('updated_at')
        .order('updated_at', { ascending: false })
        .limit(1);
      
      const lastAdapterUpdate = recentAdapterUpdates?.[0]?.updated_at;
      const adapterLastUpdate = lastAdapterUpdate ? new Date(lastAdapterUpdate) : null;
      
      // Check searches health
      const { data: recentSearches } = await supabase
        .from('searches')
        .select('created_at')
        .order('created_at', { ascending: false })
        .limit(1);
      
      const lastSearchActivity = recentSearches?.[0]?.created_at;
      const searchLastUpdate = lastSearchActivity ? new Date(lastSearchActivity) : null;
      const searchHealthy = searchLastUpdate && searchLastUpdate > oneHourAgo;
      
      // Check tier coverage - count platforms per tier
      const { data: tierCounts } = await supabase
        .from('platform_adapters')
        .select('coverage_tier');
      
      const tierA = tierCounts?.filter(p => p.coverage_tier === 'A').length || 0;
      const tierB = tierCounts?.filter(p => p.coverage_tier === 'B').length || 0;
      const tierC = tierCounts?.filter(p => p.coverage_tier === 'C').length || 0;
      const totalPlatforms = tierCounts?.length || 0;
      
      // Determine platform health based on tier coverage
      // Healthy: at least 1 Tier A platform
      // Stale: no Tier A platforms but some Tier B
      // Not updating: no platforms at all
      const platformHealthy = tierA > 0;
      const platformStale = tierA === 0 && tierB > 0;
      const platformCritical = totalPlatforms === 0;
      
      const alerts: any[] = [];
      
      // Pipeline alerts
      if (!pipelineHealthy) {
        alerts.push({
          section: 'pipeline',
          severity: pipelineStale ? 'warning' : 'critical',
          message: `Pipeline data has not updated since ${pipelineLastUpdate?.toISOString() || 'unknown'}`,
          staleDuration: pipelineLastUpdate ? Math.round((now.getTime() - pipelineLastUpdate.getTime()) / 60000) : null,
        });
      }
      
      // Extraction alerts
      if (!extractionHealthy) {
        alerts.push({
          section: 'extractions',
          severity: extractionStale ? 'warning' : 'critical',
          message: `Extraction data has not updated since ${extractionLastUpdate?.toISOString() || 'unknown'}`,
          staleDuration: extractionLastUpdate ? Math.round((now.getTime() - extractionLastUpdate.getTime()) / 60000) : null,
        });
      }
      
      // Platform tier alerts
      if (platformCritical) {
        alerts.push({
          section: 'platforms',
          severity: 'critical',
          message: 'No platforms configured in any tier. Platform coverage is completely empty.',
          staleDuration: null,
        });
      } else if (tierA === 0) {
        alerts.push({
          section: 'platforms',
          severity: 'warning',
          message: `No Tier A platforms available. All ${tierB} platforms are in Tier B (best effort only).`,
          staleDuration: null,
        });
      }
      
      return new Response(
        JSON.stringify({
          timestamp: now.toISOString(),
          sections: {
            pipeline: {
              status: pipelineHealthy ? 'healthy' : (pipelineStale ? 'stale' : 'not_updating'),
              lastActivity: lastPipelineActivity,
              staleSince: !pipelineHealthy && pipelineLastUpdate ? pipelineLastUpdate.toISOString() : null,
            },
            extractions: {
              status: extractionHealthy ? 'healthy' : (extractionStale ? 'stale' : 'not_updating'),
              lastActivity: lastExtractionActivity,
              staleSince: !extractionHealthy && extractionLastUpdate ? extractionLastUpdate.toISOString() : null,
            },
            platforms: {
              status: platformCritical ? 'not_updating' : (platformHealthy ? 'healthy' : 'stale'),
              lastActivity: lastAdapterUpdate,
              tierCounts: { A: tierA, B: tierB, C: tierC, total: totalPlatforms },
            },
            searches: {
              status: searchHealthy ? 'healthy' : 'stale',
              lastActivity: lastSearchActivity,
            },
          },
          alerts,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // PIPELINE STATUS - Now uses search_stage_runs as primary source
    if (action === 'pipeline' && req.method === 'GET') {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      // Get recent stage runs (canonical telemetry source)
      const { data: stageRuns } = await supabase
        .from('search_stage_runs')
        .select('*')
        .gte('started_at', today.toISOString())
        .order('started_at', { ascending: false })
        .limit(500);
      
      // Get recent searches for additional context
      const { data: searches } = await supabase
        .from('searches')
        .select('id, status, created_at, updated_at')
        .gte('created_at', today.toISOString())
        .order('created_at', { ascending: false })
        .limit(100);
      
      // Count by outcome status
      const statusCounts: Record<string, number> = {
        queued: 0,
        running: 0,
        completed: 0,
        failed: 0
      };
      
      // Map stage run outcomes to pipeline statuses
      stageRuns?.forEach(run => {
        if (!run.finished_at) {
          statusCounts.running++;
        } else if (run.outcome_status === 'success' || run.outcome_status === 'partial') {
          statusCounts.completed++;
        } else if (run.outcome_status === 'failed' || run.outcome_status === 'timeout') {
          statusCounts.failed++;
        }
      });
      
      // Add queued from searches that are still 'searching'
      const searchingCount = searches?.filter(s => s.status === 'searching').length || 0;
      statusCounts.queued = searchingCount;
      
      // Get recent errors from stage runs
      const recentErrors = stageRuns
        ?.filter(r => r.outcome_status === 'failed' || r.outcome_status === 'timeout')
        .slice(0, 50)
        .map(r => ({
          id: r.id,
          jobType: r.stage_name,
          error: r.outcome_status === 'timeout' ? 'Stage timed out' : 'Stage failed',
          errorCategory: r.outcome_status,
          searchId: r.search_id,
          createdAt: r.started_at,
          stageName: r.stage_name,
          durationMs: r.duration_ms,
        }));
      
      // Health indicator
      const lastActivity = stageRuns?.[0]?.started_at;
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      const isHealthy = lastActivity && new Date(lastActivity) > oneHourAgo;

      return new Response(
        JSON.stringify({
          counts: statusCounts,
          totalRetries: 0, // Stage runs don't track retries the same way
          recentErrors,
          health: {
            status: isHealthy ? 'healthy' : 'stale',
            lastActivity,
            message: isHealthy ? 'Pipeline is active' : `No activity since ${lastActivity || 'unknown'}`,
          },
          meta: {
            source: 'search_stage_runs',
            todaySearches: searches?.length || 0,
            todayStageRuns: stageRuns?.length || 0,
          }
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

      // Build query
      let query = supabase
        .from('price_extractions')
        .select('*, searches(airbnb_url, airbnb_title)', { count: 'exact' });

      if (platform) query = query.eq('platform_name', platform);
      if (status) query = query.eq('extraction_status', status);
      if (provider) query = query.eq('provider_used', provider);
      if (startDate) query = query.gte('created_at', startDate);
      if (endDate) query = query.lte('created_at', endDate);

      const { data: extractions, count, error: queryError } = await query
        .order('created_at', { ascending: false })
        .range((page - 1) * limit, page * limit - 1);

      // Check for query errors explicitly
      if (queryError) {
        console.error('[Admin Dashboard] Extractions query error:', queryError);
        return new Response(
          JSON.stringify({
            error: 'query_failed',
            message: queryError.message,
            extractions: [],
            total: 0,
            health: {
              status: 'error',
              lastRecordAt: null,
              message: `Database query failed: ${queryError.message}`,
            }
          }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Get the most recent extraction timestamp for health check
      const { data: latestExtraction } = await supabase
        .from('price_extractions')
        .select('created_at, updated_at')
        .order('created_at', { ascending: false })
        .limit(1);

      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      const fourHoursAgo = new Date(now.getTime() - 4 * 60 * 60 * 1000);
      
      const lastRecordAt = latestExtraction?.[0]?.created_at || null;
      const lastRecordDate = lastRecordAt ? new Date(lastRecordAt) : null;
      
      let healthStatus: 'healthy' | 'stale' | 'not_updating' | 'empty' = 'empty';
      let healthMessage = 'No extraction records found';
      
      if (lastRecordDate) {
        if (lastRecordDate > oneHourAgo) {
          healthStatus = 'healthy';
          healthMessage = 'Extractions are updating normally';
        } else if (lastRecordDate > fourHoursAgo) {
          healthStatus = 'stale';
          const minutesAgo = Math.round((now.getTime() - lastRecordDate.getTime()) / 60000);
          healthMessage = `No new extractions for ${minutesAgo} minutes`;
        } else {
          healthStatus = 'not_updating';
          const hoursAgo = Math.round((now.getTime() - lastRecordDate.getTime()) / 3600000);
          healthMessage = `Extractions stopped ${hoursAgo} hours ago - investigate generate-deep-links and price extraction pipeline`;
        }
      }

      console.log(`[Admin Dashboard] Extractions: ${count} total, health=${healthStatus}, lastRecord=${lastRecordAt}`);

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
          totalPages: Math.ceil((count || 0) / limit),
          health: {
            status: healthStatus,
            lastRecordAt,
            message: healthMessage,
            queriedAt: now.toISOString(),
          }
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

    // NOTIFY ME - OVERVIEW STATS
    if (action === 'notify-me-stats' && (req.method === 'GET' || req.method === 'POST')) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const sevenDaysAgo = new Date(today);
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      const thirtyDaysAgo = new Date(today);
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      // Total registrations from launch_signups (the original notify-me table)
      const { count: totalRegistrations } = await supabase
        .from('launch_signups')
        .select('*', { count: 'exact', head: true });

      // Registrations today
      const { count: registrationsToday } = await supabase
        .from('launch_signups')
        .select('*', { count: 'exact', head: true })
        .gte('created_at', today.toISOString());

      // Registrations last 7 days
      const { count: registrationsWeek } = await supabase
        .from('launch_signups')
        .select('*', { count: 'exact', head: true })
        .gte('created_at', sevenDaysAgo.toISOString());

      // Registrations last 30 days
      const { count: registrationsMonth } = await supabase
        .from('launch_signups')
        .select('*', { count: 'exact', head: true })
        .gte('created_at', thirtyDaysAgo.toISOString());

      // Extended tracking data from notify_me_registrations
      const { data: statusCounts } = await supabase
        .from('notify_me_registrations')
        .select('notification_status');

      const statusBreakdown: Record<string, number> = {
        pending: totalRegistrations || 0, // All launch_signups are pending by default
        sent: 0,
        failed: 0,
        disabled: 0
      };
      statusCounts?.forEach(r => {
        if (statusBreakdown[r.notification_status] !== undefined) {
          statusBreakdown[r.notification_status]++;
          // Reduce pending count for each tracked registration
          if (r.notification_status !== 'pending') {
            statusBreakdown.pending = Math.max(0, statusBreakdown.pending - 1);
          }
        }
      });

      // Total notifications sent
      const { count: notificationsSent } = await supabase
        .from('notification_events')
        .select('*', { count: 'exact', head: true })
        .eq('event_type', 'notification_sent');

      // Failed notifications
      const { count: notificationsFailed } = await supabase
        .from('notification_events')
        .select('*', { count: 'exact', head: true })
        .eq('event_type', 'notification_failed');

      // Extractions triggered by notify-me
      const { count: notifyMeExtractions } = await supabase
        .from('price_extractions')
        .select('*', { count: 'exact', head: true })
        .not('notify_me_registration_id', 'is', null);

      // Successful extractions from notify-me
      const { count: notifyMeSuccesses } = await supabase
        .from('price_extractions')
        .select('*', { count: 'exact', head: true })
        .not('notify_me_registration_id', 'is', null)
        .eq('extraction_status', 'success');

      // Daily registration trend from launch_signups
      const { data: dailyRegistrations } = await supabase
        .from('launch_signups')
        .select('created_at')
        .gte('created_at', sevenDaysAgo.toISOString());

      const dailyTrend: Record<string, number> = {};
      for (let i = 0; i < 7; i++) {
        const day = new Date(today);
        day.setDate(day.getDate() - i);
        dailyTrend[day.toISOString().split('T')[0]] = 0;
      }
      dailyRegistrations?.forEach(r => {
        const dayStr = r.created_at.split('T')[0];
        if (dailyTrend[dayStr] !== undefined) {
          dailyTrend[dayStr]++;
        }
      });

      return new Response(
        JSON.stringify({
          registrations: {
            total: totalRegistrations || 0,
            active: totalRegistrations || 0, // All are active in launch_signups
            today: registrationsToday || 0,
            last7Days: registrationsWeek || 0,
            last30Days: registrationsMonth || 0
          },
          notifications: {
            pending: statusBreakdown.pending,
            sent: notificationsSent || 0,
            failed: notificationsFailed || 0,
            disabled: statusBreakdown.disabled
          },
          extractions: {
            triggered: notifyMeExtractions || 0,
            successful: notifyMeSuccesses || 0,
            successRate: notifyMeExtractions ? Math.round(((notifyMeSuccesses || 0) / notifyMeExtractions) * 100) : 0
          },
          dailyTrend: Object.entries(dailyTrend)
            .map(([date, count]) => ({ date, registrations: count }))
            .sort((a, b) => a.date.localeCompare(b.date))
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // NOTIFY ME - LIST REGISTRATIONS (uses launch_signups as primary source)
    if (action === 'notify-me-list' && (req.method === 'GET' || req.method === 'POST')) {
      const params = url.searchParams;
      const status = params.get('status');
      const startDate = params.get('startDate');
      const endDate = params.get('endDate');
      const page = parseInt(params.get('page') || '1');
      const limit = parseInt(params.get('limit') || '50');

      // Query launch_signups as the primary source
      let query = supabase
        .from('launch_signups')
        .select('*', { count: 'exact' });

      if (startDate) query = query.gte('created_at', startDate);
      if (endDate) query = query.lte('created_at', endDate);

      const { data: signups, count } = await query
        .order('created_at', { ascending: false })
        .range((page - 1) * limit, page * limit - 1);

      // Enrich with data from notify_me_registrations if available
      const enrichedRegistrations = await Promise.all(
        (signups || []).map(async (signup) => {
          // Check if there's extended tracking data
          const { data: extendedData } = await supabase
            .from('notify_me_registrations')
            .select('*, searches(airbnb_title, airbnb_url, status)')
            .eq('email', signup.email)
            .single();

          // Mask email for privacy (show first 3 chars + domain)
          const emailParts = signup.email.split('@');
          const maskedEmail = emailParts[0].slice(0, 3) + '***@' + emailParts[1];

          // Default status is pending unless we have extended tracking
          let notificationStatus = 'pending';
          let extractionCount = 0;
          let lastExtraction = null;

          if (extendedData) {
            notificationStatus = extendedData.notification_status || 'pending';
            
            const { count: extCount } = await supabase
              .from('price_extractions')
              .select('*', { count: 'exact', head: true })
              .eq('notify_me_registration_id', extendedData.id);
            extractionCount = extCount || 0;

            const { data: lastExt } = await supabase
              .from('price_extractions')
              .select('extraction_status, created_at, extracted_price, platform_name')
              .eq('notify_me_registration_id', extendedData.id)
              .order('created_at', { ascending: false })
              .limit(1)
              .single();
            
            if (lastExt) {
              lastExtraction = {
                status: lastExt.extraction_status,
                createdAt: lastExt.created_at,
                price: lastExt.extracted_price,
                platform: lastExt.platform_name
              };
            }
          }

          // Filter by status if specified
          if (status && notificationStatus !== status) {
            return null;
          }

          return {
            id: signup.id,
            email: maskedEmail,
            emailHash: null,
            sourceAirbnbUrl: extendedData?.source_airbnb_url || null,
            sourceAirbnbTitle: extendedData?.source_airbnb_title || null,
            sourceAirbnbPrice: extendedData?.source_airbnb_price || null,
            searchId: extendedData?.search_id || null,
            searchStatus: extendedData?.searches?.status || null,
            searchTitle: extendedData?.searches?.airbnb_title || null,
            notificationStatus,
            lastNotifiedAt: extendedData?.last_notified_at || null,
            notificationCount: extendedData?.notification_count || 0,
            priceThreshold: extendedData?.price_threshold_percentage || 10,
            isActive: extendedData?.is_active ?? true,
            createdAt: signup.created_at,
            extractionCount,
            lastExtraction
          };
        })
      );

      // Filter out nulls (from status filter)
      const filteredRegistrations = enrichedRegistrations.filter(r => r !== null);

      return new Response(
        JSON.stringify({
          registrations: filteredRegistrations,
          total: status ? filteredRegistrations.length : count,
          page,
          limit,
          totalPages: Math.ceil((status ? filteredRegistrations.length : (count || 0)) / limit)
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // NOTIFY ME - GET SINGLE REGISTRATION DETAIL (uses launch_signups as primary)
    if (action === 'notify-me-detail' && (req.method === 'GET' || req.method === 'POST')) {
      const params = url.searchParams;
      const id = params.get('id');

      if (!id) {
        return new Response(
          JSON.stringify({ error: 'Registration ID is required' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // First try to get from launch_signups
      const { data: signup, error: signupError } = await supabase
        .from('launch_signups')
        .select('*')
        .eq('id', id)
        .single();

      if (signupError || !signup) {
        return new Response(
          JSON.stringify({ error: 'Registration not found' }),
          { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Get extended data if available
      const { data: extendedData } = await supabase
        .from('notify_me_registrations')
        .select('*, searches(*)')
        .eq('email', signup.email)
        .single();

      // Get timeline events if we have extended data
      let events: any[] = [];
      let extractions: any[] = [];
      let apiUsage: Record<string, { requests: number; cost: number; successes: number }> = {};

      if (extendedData) {
        const { data: eventsData } = await supabase
          .from('notification_events')
          .select('*')
          .eq('registration_id', extendedData.id)
          .order('created_at', { ascending: false });
        events = eventsData || [];

        const { data: extractionsData } = await supabase
          .from('price_extractions')
          .select('*')
          .eq('notify_me_registration_id', extendedData.id)
          .order('created_at', { ascending: false });
        extractions = extractionsData || [];

        const { data: apiLogs } = await supabase
          .from('api_request_logs')
          .select('provider_name, cost_units, success, created_at')
          .eq('notify_me_registration_id', extendedData.id);

        apiLogs?.forEach(log => {
          if (!apiUsage[log.provider_name]) {
            apiUsage[log.provider_name] = { requests: 0, cost: 0, successes: 0 };
          }
          apiUsage[log.provider_name].requests++;
          apiUsage[log.provider_name].cost += parseFloat(log.cost_units || '0');
          if (log.success) apiUsage[log.provider_name].successes++;
        });
      }

      // Log admin access
      const ip = req.headers.get('x-forwarded-for') || 'unknown';
      const userAgent = req.headers.get('user-agent') || 'unknown';
      await supabase.from('admin_audit_logs').insert({
        admin_user_id: authResult.admin.id,
        admin_email: authResult.admin.email,
        action: 'view_notify_me_user',
        resource_type: 'launch_signup',
        resource_id: id,
        ip_address: ip,
        user_agent: userAgent
      });

      return new Response(
        JSON.stringify({
          registration: {
            id: signup.id,
            email: signup.email,
            sourceAirbnbUrl: extendedData?.source_airbnb_url || null,
            sourceAirbnbTitle: extendedData?.source_airbnb_title || null,
            sourceAirbnbPrice: extendedData?.source_airbnb_price || null,
            searchId: extendedData?.search_id || null,
            search: extendedData?.searches || null,
            notificationStatus: extendedData?.notification_status || 'pending',
            lastNotifiedAt: extendedData?.last_notified_at || null,
            notificationCount: extendedData?.notification_count || 0,
            lastNotificationError: extendedData?.last_notification_error || null,
            priceThreshold: extendedData?.price_threshold_percentage || 10,
            isActive: extendedData?.is_active ?? true,
            metadata: extendedData?.metadata || {},
            createdAt: signup.created_at,
            updatedAt: extendedData?.updated_at || signup.created_at
          },
          events: events.map(e => ({
            id: e.id,
            type: e.event_type,
            searchId: e.search_id,
            extractionId: e.extraction_id,
            platform: e.platform_name,
            price: e.extracted_price,
            savings: e.savings_amount,
            error: e.error_message,
            metadata: e.metadata,
            createdAt: e.created_at
          })),
          extractions: extractions.map(e => ({
            id: e.id,
            platform: e.platform_name,
            status: e.extraction_status,
            price: e.extracted_price,
            currency: e.currency,
            provider: e.provider_used,
            error: e.extraction_error,
            createdAt: e.created_at
          })),
          apiUsage
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // NOTIFY ME - UPDATE REGISTRATION
    if (action === 'notify-me-update' && req.method === 'PATCH') {
      const ip = req.headers.get('x-forwarded-for') || 'unknown';
      const userAgent = req.headers.get('user-agent') || 'unknown';
      const { id, ...updates } = await req.json();

      if (!id) {
        return new Response(
          JSON.stringify({ error: 'Registration ID is required' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Only allow specific fields to be updated
      const allowedUpdates: Record<string, any> = {};
      if (updates.is_active !== undefined) allowedUpdates.is_active = updates.is_active;
      if (updates.notification_status) allowedUpdates.notification_status = updates.notification_status;
      if (updates.price_threshold_percentage) allowedUpdates.price_threshold_percentage = updates.price_threshold_percentage;

      const { data: oldReg } = await supabase
        .from('notify_me_registrations')
        .select('*')
        .eq('id', id)
        .single();

      const { data: updatedReg, error } = await supabase
        .from('notify_me_registrations')
        .update(allowedUpdates)
        .eq('id', id)
        .select()
        .single();

      if (error) {
        return new Response(
          JSON.stringify({ error: error.message }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Log the event
      if (updates.notification_status === 'disabled' || updates.is_active === false) {
        await supabase.from('notification_events').insert({
          registration_id: id,
          event_type: 'user_disabled',
          metadata: { admin_action: true, admin_email: authResult.admin.email }
        });
      }

      // Audit log
      await supabase.from('admin_audit_logs').insert({
        admin_user_id: authResult.admin.id,
        admin_email: authResult.admin.email,
        action: 'update_notify_me_user',
        resource_type: 'notify_me_registration',
        resource_id: id,
        old_values: oldReg,
        new_values: updatedReg,
        ip_address: ip,
        user_agent: userAgent
      });

      return new Response(
        JSON.stringify({ registration: updatedReg }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // NOTIFY ME - QUOTA ATTRIBUTION
    if (action === 'notify-me-quota' && (req.method === 'GET' || req.method === 'POST')) {
      const params = url.searchParams;
      const days = parseInt(params.get('days') || '30');
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);

      // Get all API requests in period
      const { data: allRequests } = await supabase
        .from('api_request_logs')
        .select('provider_name, cost_units, notify_me_registration_id')
        .gte('created_at', startDate.toISOString());

      // Calculate attribution
      const providers: Record<string, { total: number; notifyMe: number; other: number; totalCost: number; notifyMeCost: number }> = {};
      
      allRequests?.forEach(req => {
        if (!providers[req.provider_name]) {
          providers[req.provider_name] = { total: 0, notifyMe: 0, other: 0, totalCost: 0, notifyMeCost: 0 };
        }
        const cost = parseFloat(req.cost_units || '0');
        providers[req.provider_name].total++;
        providers[req.provider_name].totalCost += cost;
        
        if (req.notify_me_registration_id) {
          providers[req.provider_name].notifyMe++;
          providers[req.provider_name].notifyMeCost += cost;
        } else {
          providers[req.provider_name].other++;
        }
      });

      // Calculate totals
      let totalRequests = 0;
      let totalNotifyMe = 0;
      let totalCost = 0;
      let notifyMeCost = 0;

      Object.values(providers).forEach(p => {
        totalRequests += p.total;
        totalNotifyMe += p.notifyMe;
        totalCost += p.totalCost;
        notifyMeCost += p.notifyMeCost;
      });

      return new Response(
        JSON.stringify({
          period: {
            days,
            startDate: startDate.toISOString()
          },
          totals: {
            requests: totalRequests,
            notifyMeRequests: totalNotifyMe,
            notifyMePercentage: totalRequests > 0 ? Math.round((totalNotifyMe / totalRequests) * 100) : 0,
            estimatedCost: totalCost,
            notifyMeCost,
            notifyMeCostPercentage: totalCost > 0 ? Math.round((notifyMeCost / totalCost) * 100) : 0
          },
          byProvider: Object.entries(providers).map(([name, data]) => ({
            provider: name,
            totalRequests: data.total,
            notifyMeRequests: data.notifyMe,
            otherRequests: data.other,
            notifyMePercentage: data.total > 0 ? Math.round((data.notifyMe / data.total) * 100) : 0,
            estimatedCost: data.totalCost,
            notifyMeCost: data.notifyMeCost
          }))
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // NOTIFY ME - NOTIFICATION HEALTH
    if (action === 'notify-me-health' && (req.method === 'GET' || req.method === 'POST')) {
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      // Pending queue size
      const { count: pendingCount } = await supabase
        .from('notify_me_registrations')
        .select('*', { count: 'exact', head: true })
        .eq('notification_status', 'pending')
        .eq('is_active', true);

      // Get failed notifications with reasons
      const { data: failedEvents } = await supabase
        .from('notification_events')
        .select('error_message, created_at, registration_id')
        .eq('event_type', 'notification_failed')
        .gte('created_at', sevenDaysAgo.toISOString());

      // Group failures by reason
      const failureReasons: Record<string, number> = {};
      failedEvents?.forEach(e => {
        const reason = e.error_message || 'unknown';
        failureReasons[reason] = (failureReasons[reason] || 0) + 1;
      });

      // Calculate average time from extraction to notification
      const { data: sentEvents } = await supabase
        .from('notification_events')
        .select('registration_id, created_at, metadata')
        .eq('event_type', 'notification_sent')
        .gte('created_at', sevenDaysAgo.toISOString())
        .limit(100);

      // Get registrations with retry info
      const { data: failedRegistrations } = await supabase
        .from('notify_me_registrations')
        .select('id, email, notification_status, last_notification_error, notification_count, last_notified_at')
        .eq('notification_status', 'failed')
        .order('updated_at', { ascending: false })
        .limit(20);

      return new Response(
        JSON.stringify({
          queue: {
            pendingCount: pendingCount || 0
          },
          failures: {
            totalLast7Days: failedEvents?.length || 0,
            byReason: failureReasons,
            recentFailures: failedRegistrations?.map(r => ({
              id: r.id,
              email: r.email.split('@')[0].slice(0, 3) + '***@' + r.email.split('@')[1],
              error: r.last_notification_error,
              retryCount: r.notification_count,
              lastAttempt: r.last_notified_at
            }))
          },
          performance: {
            notificationsSentLast7Days: sentEvents?.length || 0
          }
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // NOTIFY ME - RETRY NOTIFICATION
    if (action === 'notify-me-retry' && req.method === 'POST') {
      const ip = req.headers.get('x-forwarded-for') || 'unknown';
      const userAgent = req.headers.get('user-agent') || 'unknown';
      const { id } = await req.json();

      if (!id) {
        return new Response(
          JSON.stringify({ error: 'Registration ID is required' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Reset to pending status
      const { error } = await supabase
        .from('notify_me_registrations')
        .update({
          notification_status: 'pending',
          last_notification_error: null
        })
        .eq('id', id);

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
        action: 'retry_notification',
        resource_type: 'notify_me_registration',
        resource_id: id,
        ip_address: ip,
        user_agent: userAgent
      });

      return new Response(
        JSON.stringify({ success: true }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // NOTIFY ME - SEED DEMO DATA
    if (action === 'notify-me-seed' && req.method === 'POST') {
      const ip = req.headers.get('x-forwarded-for') || 'unknown';
      const userAgent = req.headers.get('user-agent') || 'unknown';

      // Check if demo data already exists
      const { count: existingCount } = await supabase
        .from('notify_me_registrations')
        .select('*', { count: 'exact', head: true })
        .ilike('email', '%demo-user%');

      if ((existingCount || 0) > 0) {
        return new Response(
          JSON.stringify({ success: false, message: 'Demo data already exists' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Sample Airbnb URLs and titles for demo
      const demoListings = [
        { url: 'https://www.airbnb.com/rooms/12345678', title: 'Cozy Beach House in Malibu', price: 450 },
        { url: 'https://www.airbnb.com/rooms/23456789', title: 'Modern Loft Downtown NYC', price: 320 },
        { url: 'https://www.airbnb.com/rooms/34567890', title: 'Mountain Cabin with Hot Tub', price: 275 },
        { url: 'https://www.airbnb.com/rooms/45678901', title: 'Oceanfront Villa in Miami', price: 890 },
        { url: 'https://www.airbnb.com/rooms/56789012', title: 'Charming Cottage in Vermont', price: 185 },
      ];

      const statuses = ['pending', 'sent', 'failed', 'pending', 'pending'];
      const registrations: any[] = [];

      // Create demo registrations
      for (let i = 0; i < 5; i++) {
        const listing = demoListings[i];
        const daysAgo = Math.floor(Math.random() * 30);
        const createdAt = new Date();
        createdAt.setDate(createdAt.getDate() - daysAgo);

        const { data: reg, error: regError } = await supabase
          .from('notify_me_registrations')
          .insert({
            email: `demo-user-${i + 1}@example.com`,
            source_airbnb_url: listing.url,
            source_airbnb_title: listing.title,
            source_airbnb_price: listing.price,
            notification_status: statuses[i],
            notification_count: statuses[i] === 'sent' ? 1 : (statuses[i] === 'failed' ? 2 : 0),
            last_notified_at: statuses[i] === 'sent' ? new Date().toISOString() : null,
            last_notification_error: statuses[i] === 'failed' ? 'Email delivery failed: recipient mailbox full' : null,
            price_threshold_percentage: 10 + (i * 5),
            is_active: statuses[i] !== 'failed',
            created_at: createdAt.toISOString()
          })
          .select()
          .single();

        if (regError) {
          console.error('Error creating demo registration:', regError);
          continue;
        }

        registrations.push(reg);

        // Create events for each registration
        const events = [
          { type: 'registered', createdAt: createdAt }
        ];

        // Add more events based on status
        if (statuses[i] === 'sent') {
          const searchTriggeredAt = new Date(createdAt);
          searchTriggeredAt.setHours(searchTriggeredAt.getHours() + 1);
          events.push({ type: 'search_triggered', createdAt: searchTriggeredAt });
          
          const extractionAt = new Date(searchTriggeredAt);
          extractionAt.setMinutes(extractionAt.getMinutes() + 5);
          events.push({ type: 'extraction_completed', createdAt: extractionAt });
          
          const priceFoundAt = new Date(extractionAt);
          priceFoundAt.setMinutes(priceFoundAt.getMinutes() + 1);
          events.push({ type: 'price_found', createdAt: priceFoundAt });
          
          const notificationSentAt = new Date(priceFoundAt);
          notificationSentAt.setMinutes(notificationSentAt.getMinutes() + 2);
          events.push({ type: 'notification_sent', createdAt: notificationSentAt });
        } else if (statuses[i] === 'failed') {
          const searchTriggeredAt = new Date(createdAt);
          searchTriggeredAt.setHours(searchTriggeredAt.getHours() + 1);
          events.push({ type: 'search_triggered', createdAt: searchTriggeredAt });
          
          const failedAt = new Date(searchTriggeredAt);
          failedAt.setMinutes(failedAt.getMinutes() + 10);
          events.push({ type: 'notification_failed', createdAt: failedAt });
        } else if (statuses[i] === 'pending' && i > 2) {
          const searchTriggeredAt = new Date(createdAt);
          searchTriggeredAt.setHours(searchTriggeredAt.getHours() + 2);
          events.push({ type: 'search_triggered', createdAt: searchTriggeredAt });
        }

        // Insert events
        for (const event of events) {
          await supabase.from('notification_events').insert({
            registration_id: reg.id,
            event_type: event.type,
            platform_name: event.type === 'price_found' ? 'Booking.com' : null,
            extracted_price: event.type === 'price_found' ? Math.round(listing.price * 0.85) : null,
            savings_amount: event.type === 'price_found' ? Math.round(listing.price * 0.15) : null,
            error_message: event.type === 'notification_failed' ? 'Email delivery failed: recipient mailbox full' : null,
            created_at: event.createdAt.toISOString()
          });
        }
      }

      // Audit log
      await supabase.from('admin_audit_logs').insert({
        admin_user_id: authResult.admin.id,
        admin_email: authResult.admin.email,
        action: 'seed_demo_data',
        resource_type: 'notify_me_registration',
        new_values: { registrations_created: registrations.length },
        ip_address: ip,
        user_agent: userAgent
      });

      console.log('[Admin Dashboard] Seeded demo data:', { count: registrations.length });

      return new Response(
        JSON.stringify({ success: true, count: registrations.length }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // RECENT SEARCHES (for admin debug)
    if (action === 'recent-searches' && req.method === 'GET') {
      const { data: recentSearches } = await supabase
        .from('searches')
        .select('id, airbnb_url, airbnb_title, check_in_date, check_out_date, status, created_at')
        .order('created_at', { ascending: false })
        .limit(20);

      // Get platform counts for each search
      const searchIds = recentSearches?.map(s => s.id) || [];
      const { data: extractionCounts } = await supabase
        .from('price_extractions')
        .select('search_id')
        .in('search_id', searchIds);

      const countMap = new Map<string, number>();
      extractionCounts?.forEach(e => {
        countMap.set(e.search_id, (countMap.get(e.search_id) || 0) + 1);
      });

      const enrichedSearches = recentSearches?.map(s => ({
        id: s.id,
        airbnbUrl: s.airbnb_url,
        airbnbTitle: s.airbnb_title,
        checkInDate: s.check_in_date,
        checkOutDate: s.check_out_date,
        status: s.status,
        createdAt: s.created_at,
        platformCount: countMap.get(s.id) || 0
      })) || [];

      return new Response(
        JSON.stringify({ success: true, searches: enrichedSearches }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // SEARCH DEBUG VIEW
    if (action === 'search-debug' && req.method === 'POST') {
      const { searchId, airbnbUrl } = await req.json();

      if (!searchId && !airbnbUrl) {
        return new Response(
          JSON.stringify({ success: false, error: 'Either searchId or airbnbUrl is required' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Find the search - prioritize most recent
      let searchQuery = supabase.from('searches').select('*');
      if (searchId) {
        searchQuery = searchQuery.eq('id', searchId);
      } else {
        // Match by URL (partial match for flexibility)
        searchQuery = searchQuery.ilike('airbnb_url', `%${airbnbUrl}%`);
      }
      
      const { data: searches, error: searchError } = await searchQuery
        .order('created_at', { ascending: false })
        .limit(1);

      if (searchError || !searches || searches.length === 0) {
        return new Response(
          JSON.stringify({ 
            success: false, 
            error: 'No search found for this Airbnb URL. Run search-alternatives first to create a search.',
            notFound: true
          }),
          { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const search = searches[0];

      // Get all price_extractions for this search
      const { data: extractions } = await supabase
        .from('price_extractions')
        .select('*')
        .eq('search_id', search.id)
        .order('platform_name');

      // Get platform_adapters for coverage tier info
      const { data: adapters } = await supabase
        .from('platform_adapters')
        .select('platform_name, platform_domain, coverage_tier, coverage_status, dedicated_extractor');

      // Helper to classify failure
      const classifyFailure = (extraction: any): { category: string; humanReason: string } => {
        const error = extraction.extraction_error || '';
        const metadata = extraction.extraction_metadata || {};
        const status = extraction.extraction_status;

        // Provider errors
        if (error.includes('Zyte error: 400') || error.includes('Zyte 400')) {
          return { category: 'provider_error', humanReason: 'Provider rejected request (Zyte 400)' };
        }
        if (error.includes('Zyte timeout') || error.includes('Zyte error: 5')) {
          return { category: 'provider_error', humanReason: 'Provider timeout or server error' };
        }
        if (error.includes('Firecrawl error: 403') || error.includes('Firecrawl: 403')) {
          return { category: 'blocked', humanReason: 'Blocked by platform (403 Forbidden)' };
        }
        if (error.includes('Firecrawl error: 5') || error.includes('Firecrawl timeout')) {
          return { category: 'provider_error', humanReason: 'Firecrawl server error or timeout' };
        }

        // Bot/CAPTCHA
        if (status === 'blocked_captcha_or_bot' || error.toLowerCase().includes('captcha') || error.toLowerCase().includes('bot')) {
          return { category: 'blocked', humanReason: 'Blocked by CAPTCHA or bot detection' };
        }

        // Dates not applied
        if (status === 'dates_not_applied') {
          return { category: 'dates_not_applied', humanReason: 'Could not apply requested dates to URL' };
        }

        // Sold out / unavailable
        if (status === 'sold_out' || status === 'no_availability_for_dates' || error.toLowerCase().includes('sold out') || error.toLowerCase().includes('unavailable')) {
          return { category: 'sold_out', humanReason: 'Property unavailable for these dates' };
        }

        // Tier C / unsupported
        if (status === 'platform_unsupported' || metadata.short_circuited || metadata.tier === 'C') {
          return { category: 'unsupported', humanReason: metadata.tier_reason || 'Platform not supported (Tier C)' };
        }

        // Render failed
        if (status === 'render_failed') {
          return { category: 'render_failed', humanReason: 'Page failed to render properly' };
        }

        // Generic price not found
        if (status === 'price_not_found' || status === 'price_not_found_after_dates_applied') {
          // Check if Phase A ran
          if (metadata.phaseA && metadata.phaseA.ran === false) {
            return { category: 'fetch_failed', humanReason: 'Could not fetch page content' };
          }
          return { category: 'price_not_visible', humanReason: 'Price not visible on page (may require interaction)' };
        }

        // Default
        if (status === 'failed') {
          return { category: 'unknown', humanReason: error || 'Extraction failed (unknown reason)' };
        }

        return { category: 'unknown', humanReason: error || 'Unknown status' };
      };

      // Map extractions with tier info and failure classification
      const enrichedExtractions = extractions?.map(e => {
        // Try to find adapter by matching domain
        const platformDomain = e.platform_name.toLowerCase().replace(/\s+/g, '');
        const adapter = adapters?.find(a => 
          a.platform_domain.includes(platformDomain) || 
          a.platform_name.toLowerCase().replace(/\s+/g, '') === platformDomain ||
          e.platform_name.toLowerCase().includes(a.platform_domain.split('.')[0])
        );

        const failureInfo = e.extraction_status !== 'success' ? classifyFailure(e) : null;

        return {
          id: e.id,
          platformName: e.platform_name,
          coverageTier: adapter?.coverage_tier || 'B',
          coverageStatus: adapter?.coverage_status || 'unknown',
          dedicatedExtractor: adapter?.dedicated_extractor || null,
          deepLink: e.deep_link,
          checkIn: e.detected_checkin,
          checkOut: e.detected_checkout,
          datesValidated: e.dates_validated || false,
          extractionStatus: e.extraction_status,
          extractedPrice: e.extracted_price,
          currency: e.currency || 'USD',
          includesTaxesFees: e.includes_taxes_fees,
          extractionError: e.extraction_error,
          failureCategory: failureInfo?.category || null,
          failureReason: failureInfo?.humanReason || null,
          evidenceSnippets: e.evidence_snippets,
          providerUsed: e.provider_used,
          lastAttemptAt: e.updated_at,
          priceType: e.price_type,
          pageContentHash: e.page_content_hash,
          extractionMetadata: e.extraction_metadata
        };
      }) || [];

      console.log('[Admin Dashboard] Search debug:', { 
        searchId: search.id, 
        extractionsCount: enrichedExtractions.length 
      });

      return new Response(
        JSON.stringify({
          success: true,
          search: {
            id: search.id,
            airbnbUrl: search.airbnb_url,
            airbnbTitle: search.airbnb_title,
            airbnbPrice: search.airbnb_price,
            checkInDate: search.check_in_date,
            checkOutDate: search.check_out_date,
            nightsCount: search.nights_count,
            status: search.status,
            createdAt: search.created_at
          },
          extractions: enrichedExtractions
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // DEBUG BUNDLES - Get persisted Airbnb baseline debug data
    if (action === 'debug-bundles' && req.method === 'GET') {
      const params = url.searchParams;
      const searchId = params.get('searchId');
      const runId = params.get('runId');
      const limit = parseInt(params.get('limit') || '100');

      let query = supabase
        .from('airbnb_baseline_debug')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (searchId) {
        query = query.eq('search_id', searchId);
      }

      if (runId) {
        query = query.eq('run_id', runId);
      }

      const { data: debugBundles, error: debugError } = await query;

      if (debugError) {
        console.error('[Admin Dashboard] Debug bundles error:', debugError);
        return new Response(
          JSON.stringify({ error: debugError.message }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Group by run_id
      const byRunId: Record<string, any[]> = {};
      debugBundles?.forEach((bundle: any) => {
        if (!byRunId[bundle.run_id]) {
          byRunId[bundle.run_id] = [];
        }
        byRunId[bundle.run_id].push({
          id: bundle.id,
          runNumber: bundle.run_number,
          provider: bundle.provider,
          providerOrder: bundle.provider_order,
          status: bundle.status,
          durationMs: bundle.duration_ms,
          extractedPrice: bundle.status?.startsWith('total_price_') ? bundle.extracted_price : null,
          currency: bundle.currency,
          includesTaxesFees: bundle.includes_taxes_fees,
          evidenceSnippet: bundle.evidence_snippet,
          candidatesSummary: bundle.candidates_summary,
          rejectedReason: bundle.rejected_reason,
          airbnbUrl: bundle.airbnb_url,
          checkInDate: bundle.check_in_date,
          checkOutDate: bundle.check_out_date,
          nightsCount: bundle.nights_count,
          createdAt: bundle.created_at,
          // OCR validation fields
          ocrBookingCardAmountValue: bundle.ocr_booking_card_amount_value,
          ocrBookingCardSnippet: bundle.ocr_booking_card_snippet,
          ocrBreakdownTotalAmountValue: bundle.ocr_breakdown_total_amount_value,
          ocrBreakdownTotalSnippet: bundle.ocr_breakdown_total_snippet,
          ocrValidationStatus: bundle.ocr_validation_status,
          ocrAcceptedVia: bundle.ocr_accepted_via,
          ocrMismatchReason: bundle.ocr_mismatch_reason,
        });
      });

      // Sort each run's bundles by provider_order
      Object.keys(byRunId).forEach(runId => {
        byRunId[runId].sort((a, b) => a.providerOrder - b.providerOrder);
      });

      return new Response(
        JSON.stringify({
          success: true,
          debugBundles: byRunId,
          totalBundles: debugBundles?.length || 0,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // DEBUG BUNDLES HISTORY - Get recent run IDs
    if (action === 'debug-history' && req.method === 'GET') {
      const params = url.searchParams;
      const limit = parseInt(params.get('limit') || '20');

      // Get distinct run_ids with their first bundle's metadata
      const { data: recentBundles, error: historyError } = await supabase
        .from('airbnb_baseline_debug')
        .select('run_id, airbnb_url, check_in_date, check_out_date, nights_count, created_at')
        .order('created_at', { ascending: false })
        .limit(limit * 3); // Fetch more to dedupe

      if (historyError) {
        return new Response(
          JSON.stringify({ error: historyError.message }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Dedupe by run_id, keep first occurrence
      const seen = new Set<string>();
      const uniqueRuns: any[] = [];
      recentBundles?.forEach((bundle: any) => {
        if (!seen.has(bundle.run_id)) {
          seen.add(bundle.run_id);
          uniqueRuns.push({
            runId: bundle.run_id,
            airbnbUrl: bundle.airbnb_url,
            checkInDate: bundle.check_in_date,
            checkOutDate: bundle.check_out_date,
            nightsCount: bundle.nights_count,
            createdAt: bundle.created_at,
          });
        }
      });

      return new Response(
        JSON.stringify({
          success: true,
          history: uniqueRuns.slice(0, limit),
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // CONFIRM DIAGNOSTIC TOTAL - Manual confirmation for testing
    if (action === 'confirm-diagnostic-total' && req.method === 'POST') {
      const ip = req.headers.get('x-forwarded-for') || 'unknown';
      const userAgent = req.headers.get('user-agent') || 'unknown';
      const body = await req.json();
      const {
        run_id,
        confirmed_total_amount,
        confirmed_currency,
        subtotal_nights_only,
        subtotal_nights_count,
        confirmation_note,
      } = body;

      if (!run_id || typeof confirmed_total_amount !== 'number') {
        return new Response(
          JSON.stringify({ error: 'run_id and confirmed_total_amount are required' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Upsert the diagnostic confirmation
      const { data, error } = await supabase
        .from('airbnb_confirmed_totals')
        .upsert({
          run_id,
          confirmed_total_amount,
          confirmed_currency: confirmed_currency || 'USD',
          subtotal_nights_only,
          subtotal_nights_count,
          confirmation_source: 'diagnostic_test',
          confirmation_note,
          confirmed_at: new Date().toISOString(),
        }, {
          onConflict: 'run_id',
        })
        .select()
        .single();

      if (error) {
        return new Response(
          JSON.stringify({ error: error.message }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Log audit entry
      await supabase.from('admin_audit_logs').insert({
        admin_user_id: authResult.admin.id,
        admin_email: authResult.admin.email,
        action: 'confirm_diagnostic_total',
        resource_type: 'airbnb_confirmed_totals',
        resource_id: run_id,
        new_values: { confirmed_total_amount, confirmed_currency },
        ip_address: ip,
        user_agent: userAgent,
      });

      return new Response(
        JSON.stringify({ success: true, data }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // CLEAR DIAGNOSTIC TOTAL
    if (action === 'clear-diagnostic-total' && req.method === 'POST') {
      const ip = req.headers.get('x-forwarded-for') || 'unknown';
      const userAgent = req.headers.get('user-agent') || 'unknown';
      const body = await req.json();
      const { run_id } = body;

      if (!run_id) {
        return new Response(
          JSON.stringify({ error: 'run_id is required' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const { error } = await supabase
        .from('airbnb_confirmed_totals')
        .delete()
        .eq('run_id', run_id);

      if (error) {
        return new Response(
          JSON.stringify({ error: error.message }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Log audit entry
      await supabase.from('admin_audit_logs').insert({
        admin_user_id: authResult.admin.id,
        admin_email: authResult.admin.email,
        action: 'clear_diagnostic_total',
        resource_type: 'airbnb_confirmed_totals',
        resource_id: run_id,
        ip_address: ip,
        user_agent: userAgent,
      });

      return new Response(
        JSON.stringify({ success: true }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // GET DIAGNOSTIC CONFIRMATION
    if (action === 'get-diagnostic-confirmation' && req.method === 'GET') {
      const params = url.searchParams;
      const runId = params.get('runId');

      if (!runId) {
        return new Response(
          JSON.stringify({ error: 'runId is required' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const { data, error } = await supabase
        .from('airbnb_confirmed_totals')
        .select('*')
        .eq('run_id', runId)
        .maybeSingle();

      if (error) {
        return new Response(
          JSON.stringify({ error: error.message }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      return new Response(
        JSON.stringify({ confirmation: data }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // PLATFORM COVERAGE - Golden path endpoint for platform adapters
    // This is the authoritative source for platform coverage data
    if (action === 'platform-coverage' && req.method === 'GET') {
      console.log('[Admin Dashboard] Platform Coverage: Fetching platform adapters via service role');
      
      // Fetch all platform adapters using service role (bypasses RLS)
      const { data: adaptersData, error: adaptersError, count } = await supabase
        .from('platform_adapters')
        .select('*', { count: 'exact' })
        .order('coverage_tier', { ascending: true })
        .order('platform_name', { ascending: true });
      
      if (adaptersError) {
        console.error('[Admin Dashboard] Platform Coverage: Query error', adaptersError);
        return new Response(
          JSON.stringify({ 
            error: adaptersError.message,
            errorCode: adaptersError.code,
            source: 'admin-dashboard/platform-coverage',
            queryFailed: true,
          }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      
      // Count tiers for verification
      const tierA = adaptersData?.filter(p => p.coverage_tier === 'A').length || 0;
      const tierB = adaptersData?.filter(p => p.coverage_tier === 'B').length || 0;
      const tierC = adaptersData?.filter(p => p.coverage_tier === 'C').length || 0;
      
      console.log('[Admin Dashboard] Platform Coverage: Retrieved', {
        total: adaptersData?.length || 0,
        tierA,
        tierB,
        tierC,
      });
      
      // Fetch recent pipeline runs from price_extractions for context
      const { data: extractionsData, error: extractionsError } = await supabase
        .from('price_extractions')
        .select(`
          id,
          search_id,
          platform_name,
          extraction_status,
          extracted_price,
          dates_validated,
          extraction_error,
          updated_at,
          searches!inner(airbnb_url)
        `)
        .order('updated_at', { ascending: false })
        .limit(100);
      
      // Group by search_id to form pipeline runs
      const runsMap = new Map<string, any>();
      for (const ext of extractionsData || []) {
        const searchId = ext.search_id;
        if (!searchId) continue;
        
        if (!runsMap.has(searchId)) {
          runsMap.set(searchId, {
            search_id: searchId,
            airbnb_url: (ext.searches as any)?.airbnb_url || 'Unknown',
            run_timestamp: ext.updated_at,
            platforms: [],
            summary: { successes: 0, failures: 0, unsupported: 0 },
          });
        }
        
        const run = runsMap.get(searchId)!;
        const isSuccess = ext.extraction_status === 'success';
        const isUnsupported = ['blocked_captcha_or_bot', 'render_failed', 'listing_unavailable'].includes(ext.extraction_status || '');
        
        run.platforms.push({
          platform_name: ext.platform_name || 'Unknown',
          status: ext.extraction_status || 'unknown',
          extracted_price: ext.extracted_price,
          dates_validated: ext.dates_validated || false,
          error: ext.extraction_error,
        });
        
        if (isSuccess) run.summary.successes++;
        else if (isUnsupported) run.summary.unsupported++;
        else run.summary.failures++;
      }
      
      const pipelineRuns = Array.from(runsMap.values())
        .sort((a, b) => new Date(b.run_timestamp).getTime() - new Date(a.run_timestamp).getTime())
        .slice(0, 20);
      
      return new Response(
        JSON.stringify({
          success: true,
          platforms: adaptersData || [],
          pipelineRuns,
          meta: {
            source: 'admin-dashboard/platform-coverage',
            supabaseProjectRef: Deno.env.get('SUPABASE_URL')?.match(/https:\/\/([^.]+)\./)?.[1] || 'unknown',
            queryMethod: 'service_role',
            totalCount: count,
            tierCounts: { A: tierA, B: tierB, C: tierC },
            fetchedAt: new Date().toISOString(),
          },
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // BASELINE INFO - Get current active baseline
    if (action === 'baseline' && req.method === 'GET') {
      const { data: baseline, error: baselineError } = await supabase
        .from('system_baselines')
        .select('baseline_name, baseline_version, declared_at, declared_by, git_commit_hash, deployment_id, is_active, expectations, notes')
        .eq('is_active', true)
        .single();

      if (baselineError && baselineError.code !== 'PGRST116') {
        console.error('[Admin Dashboard] Baseline fetch error:', baselineError);
        return new Response(
          JSON.stringify({ error: 'Failed to fetch baseline' }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      return new Response(
        JSON.stringify(baseline || null),
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
