import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Allowed origins for CORS - restrict to Lovable app domains
const ALLOWED_ORIGINS = [
  'https://lovable.dev',
  'https://www.lovable.dev',
  /^https:\/\/[a-zA-Z0-9-]+\.lovable\.app$/,  // Any Lovable app subdomain
  /^https:\/\/[a-zA-Z0-9-]+\.lovableproject\.com$/,  // Any Lovable project subdomain
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

// Limit type for normalized quota model
type LimitType = 'known_limit' | 'unlimited' | 'unknown';

interface NormalizedQuota {
  limitType: LimitType;
  limitValue: number | null;
  usedCount: number;  // From our telemetry
  remainingCount: number | null;
  period: 'monthly' | 'daily' | 'unknown';
  resetAt: string | null;
  limitSource: 'provider_api' | 'configured' | 'inferred' | 'unknown';
}

async function fetchSerpApiQuota(): Promise<{ used: number; remaining: number; limit: number; resetAt?: string; error?: string }> {
  try {
    const apiKey = Deno.env.get('SERPAPI_API_KEY');
    if (!apiKey) {
      return { used: 0, remaining: 0, limit: 0, error: 'API key not configured' };
    }

    const response = await fetch(`https://serpapi.com/account.json?api_key=${apiKey}`);
    if (!response.ok) {
      return { used: 0, remaining: 0, limit: 0, error: `API returned ${response.status}` };
    }

    const data = await response.json();
    const limit = data.searches_per_month || 0;
    const remaining = data.plan_searches_left ?? 0;
    // Compute used correctly: limit - remaining, or use total_searches if available
    const used = data.total_searches_this_month ?? (limit - remaining);
    
    return {
      used,
      remaining,
      limit,
      resetAt: data.plan_billing_date
    };
  } catch (error: any) {
    console.error('[Admin Quotas] SerpAPI error:', error);
    return { used: 0, remaining: 0, limit: 0, error: error?.message || 'Unknown error' };
  }
}

async function estimateUsageFromLogs(supabase: any, providerNames: string[], periodDays: number = 30): Promise<{
  used: number;
  costUnits: number;
  requestCount: number;
  successCount: number;
  errorCount: number;
  avgDurationMs: number;
}> {
  const periodStart = new Date();
  periodStart.setDate(periodStart.getDate() - periodDays);

  const { data: logs } = await supabase
    .from('api_request_logs')
    .select('success, duration_ms, cost_units')
    .in('provider_name', providerNames)
    .gte('request_timestamp', periodStart.toISOString());

  const requestCount = logs?.length || 0;
  const successCount = logs?.filter((l: any) => l.success).length || 0;
  const errorCount = requestCount - successCount;
  const costUnits = logs?.reduce((sum: number, l: any) => sum + (l.cost_units || 1), 0) || 0;
  const durations = logs?.filter((l: any) => l.duration_ms).map((l: any) => l.duration_ms) || [];
  const avgDurationMs = durations.length > 0 ? Math.round(durations.reduce((a: number, b: number) => a + b, 0) / durations.length) : 0;

  return {
    used: requestCount,  // Use request count as "used"
    costUnits,
    requestCount,
    successCount,
    errorCount,
    avgDurationMs
  };
}

async function getUsageTrend(supabase: any, providerNames: string[], days: number): Promise<Array<{ date: string; requests: number; successes: number; errors: number }>> {
  const trend: Array<{ date: string; requests: number; successes: number; errors: number }> = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(today);
    day.setDate(day.getDate() - i);
    const nextDay = new Date(day);
    nextDay.setDate(nextDay.getDate() + 1);

    const { data: logs } = await supabase
      .from('api_request_logs')
      .select('success')
      .in('provider_name', providerNames)
      .gte('request_timestamp', day.toISOString())
      .lt('request_timestamp', nextDay.toISOString());

    trend.push({
      date: day.toISOString().split('T')[0],
      requests: logs?.length || 0,
      successes: logs?.filter((l: any) => l.success).length || 0,
      errors: logs?.filter((l: any) => !l.success).length || 0
    });
  }

  return trend;
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

  try {
    // GET ALL QUOTAS
    if (action === 'all' && req.method === 'GET') {
      // Get providers from database - exclude duplicates (firecrawl_1 is duplicate of firecrawl)
      const { data: providers } = await supabase
        .from('api_providers')
        .select('*')
        .eq('is_active', true)
        .not('name', 'eq', 'firecrawl_1'); // Filter out duplicate Firecrawl entry

      const quotas = await Promise.all(
        (providers || []).map(async (provider) => {
          // Get usage from our own telemetry (api_request_logs) - this is the single source of truth
          const thirtyDaysAgo = new Date();
          thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
          
          // For firecrawl, aggregate across both possible log names (firecrawl and firecrawl_1)
          let providerNamesToQuery = [provider.name];
          if (provider.name === 'firecrawl') {
            providerNamesToQuery = ['firecrawl', 'firecrawl_1'];
          }
          
          const { data: monthLogs } = await supabase
            .from('api_request_logs')
            .select('success, duration_ms, cost_units')
            .in('provider_name', providerNamesToQuery)
            .gte('request_timestamp', thirtyDaysAgo.toISOString());

          const telemetryUsed = monthLogs?.length || 0;
          const telemetryCostUnits = monthLogs?.reduce((sum: number, l: any) => sum + (l.cost_units || 1), 0) || 0;
          const successCount = monthLogs?.filter((l: any) => l.success).length || 0;
          
          // Initialize quota data with telemetry-based usage
          let quotaData: NormalizedQuota = {
            limitType: provider.plan_limit ? 'known_limit' : 'unknown',
            limitValue: provider.plan_limit,
            usedCount: telemetryUsed,  // Always use our telemetry
            remainingCount: provider.plan_limit ? provider.plan_limit - telemetryUsed : null,
            period: (provider.plan_type as 'monthly' | 'daily') || 'monthly',
            resetAt: null,
            limitSource: provider.plan_limit ? 'configured' : 'unknown'
          };

          // For SerpAPI, get real quota data from their API and reconcile
          if (provider.supports_quota_api && provider.name === 'serpapi') {
            const realQuota = await fetchSerpApiQuota();
            if (!realQuota.error) {
              quotaData = {
                limitType: realQuota.limit > 0 ? 'known_limit' : 'unlimited',
                limitValue: realQuota.limit,
                usedCount: realQuota.used,  // Use provider's used count for SerpAPI
                remainingCount: realQuota.remaining,
                period: 'monthly',
                resetAt: realQuota.resetAt || null,
                limitSource: 'provider_api'
              };
            }
          }

          // Get estimated usage from our logs for the stats section
          const estimated = await estimateUsageFromLogs(supabase, providerNamesToQuery, 30);

          // Get 7-day and 30-day trends
          const trend7Days = await getUsageTrend(supabase, providerNamesToQuery, 7);
          const trend30Days = await getUsageTrend(supabase, providerNamesToQuery, 30);

          // Get last 24h stats
          const yesterday = new Date();
          yesterday.setDate(yesterday.getDate() - 1);
          const { data: last24hLogs } = await supabase
            .from('api_request_logs')
            .select('success, duration_ms')
            .in('provider_name', providerNamesToQuery)
            .gte('request_timestamp', yesterday.toISOString());

          const last24hRequests = last24hLogs?.length || 0;
          const last24hErrors = last24hLogs?.filter((l: any) => !l.success).length || 0;
          const last24hDurations = last24hLogs?.filter((l: any) => l.duration_ms).map((l: any) => l.duration_ms) || [];
          const last24hAvgDuration = last24hDurations.length > 0 
            ? Math.round(last24hDurations.reduce((a: number, b: number) => a + b, 0) / last24hDurations.length)
            : 0;

          // Get latest snapshot
          const { data: latestSnapshot } = await supabase
            .from('api_quota_snapshots')
            .select('*')
            .eq('provider_id', provider.id)
            .order('created_at', { ascending: false })
            .limit(1)
            .single();

          // Count active keys for aggregated providers (like Firecrawl)
          let keysActive = 1;
          if (provider.name === 'firecrawl') {
            const key1 = Deno.env.get('FIRECRAWL_API_KEY_1');
            const key2 = Deno.env.get('FIRECRAWL_API_KEY');
            keysActive = (key1 ? 1 : 0) + (key2 && key2 !== key1 ? 1 : 0);
          }

          return {
            provider: {
              id: provider.id,
              name: provider.name,
              displayName: provider.display_name,
              planType: provider.plan_type,
              planLimit: quotaData.limitValue,
              costPerRequest: provider.cost_per_request,
              supportsQuotaApi: provider.supports_quota_api,
              keysActive: keysActive > 1 ? keysActive : undefined
            },
            quota: {
              used: quotaData.usedCount,
              remaining: quotaData.remainingCount,
              limit: quotaData.limitValue,
              limitType: quotaData.limitType,
              limitSource: quotaData.limitSource,
              resetAt: quotaData.resetAt,
              isEstimated: quotaData.limitSource !== 'provider_api'
            },
            estimated: {
              requestCount: estimated.requestCount,
              costUnits: estimated.costUnits,
              successRate: estimated.requestCount > 0 
                ? Math.round((estimated.successCount / estimated.requestCount) * 100) 
                : 100
            },
            last24h: {
              requests: last24hRequests,
              errors: last24hErrors,
              errorRate: last24hRequests > 0 ? Math.round((last24hErrors / last24hRequests) * 100) : 0,
              avgDurationMs: last24hAvgDuration
            },
            trends: {
              last7Days: trend7Days,
              last30Days: trend30Days
            },
            lastSnapshot: latestSnapshot
          };
        })
      );

      return new Response(
        JSON.stringify({ quotas }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // REFRESH QUOTA FOR A PROVIDER
    if (action === 'refresh' && req.method === 'POST') {
      const ip = req.headers.get('x-forwarded-for') || 'unknown';
      const userAgent = req.headers.get('user-agent') || 'unknown';
      const { providerId } = await req.json();

      if (!providerId) {
        return new Response(
          JSON.stringify({ error: 'Provider ID is required' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const { data: provider } = await supabase
        .from('api_providers')
        .select('*')
        .eq('id', providerId)
        .single();

      if (!provider) {
        return new Response(
          JSON.stringify({ error: 'Provider not found' }),
          { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      let quotaData: any = null;
      let isEstimated = true;

      // Try to get real quota data
      if (provider.supports_quota_api && provider.name === 'serpapi') {
        const realQuota = await fetchSerpApiQuota();
        if (!realQuota.error) {
          quotaData = {
            used: realQuota.used,
            remaining: realQuota.remaining,
            limit: realQuota.limit,
            resetAt: realQuota.resetAt
          };
          isEstimated = false;
        }
      }

      // If no real quota, estimate from logs
      if (!quotaData) {
        const estimated = await estimateUsageFromLogs(supabase, provider.name, 30);
        quotaData = {
          used: estimated.costUnits,
          remaining: provider.plan_limit ? provider.plan_limit - estimated.costUnits : null,
          limit: provider.plan_limit
        };
      }

      // Save snapshot
      const { data: snapshot, error: snapshotError } = await supabase
        .from('api_quota_snapshots')
        .insert({
          provider_id: provider.id,
          used: quotaData.used,
          remaining: quotaData.remaining,
          plan_limit: quotaData.limit,
          reset_at: quotaData.resetAt,
          is_estimated: isEstimated
        })
        .select()
        .single();

      if (snapshotError) {
        console.error('[Admin Quotas] Snapshot error:', snapshotError);
      }

      // Audit log
      await supabase.from('admin_audit_logs').insert({
        admin_user_id: authResult.admin.id,
        admin_email: authResult.admin.email,
        action: 'refresh_quota',
        resource_type: 'api_provider',
        resource_id: provider.id,
        new_values: { snapshot },
        ip_address: ip,
        user_agent: userAgent
      });

      return new Response(
        JSON.stringify({
          provider: provider.name,
          quota: quotaData,
          isEstimated,
          snapshot
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // UPDATE PROVIDER SETTINGS
    if (action === 'provider' && req.method === 'PATCH') {
      const ip = req.headers.get('x-forwarded-for') || 'unknown';
      const userAgent = req.headers.get('user-agent') || 'unknown';
      const { id, planLimit, costPerRequest } = await req.json();

      if (!id) {
        return new Response(
          JSON.stringify({ error: 'Provider ID is required' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const { data: oldProvider } = await supabase
        .from('api_providers')
        .select('*')
        .eq('id', id)
        .single();

      const { data: updatedProvider, error } = await supabase
        .from('api_providers')
        .update({
          plan_limit: planLimit,
          cost_per_request: costPerRequest
        })
        .eq('id', id)
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
        action: 'update_provider_settings',
        resource_type: 'api_provider',
        resource_id: id,
        old_values: oldProvider,
        new_values: updatedProvider,
        ip_address: ip,
        user_agent: userAgent
      });

      return new Response(
        JSON.stringify({ provider: updatedProvider }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // REQUEST LOGS
    if (action === 'logs' && req.method === 'GET') {
      const params = url.searchParams;
      const provider = params.get('provider');
      const startDate = params.get('startDate');
      const endDate = params.get('endDate');
      const page = parseInt(params.get('page') || '1');
      const limit = parseInt(params.get('limit') || '100');

      let query = supabase
        .from('api_request_logs')
        .select('*', { count: 'exact' });

      if (provider) query = query.eq('provider_name', provider);
      if (startDate) query = query.gte('request_timestamp', startDate);
      if (endDate) query = query.lte('request_timestamp', endDate);

      const { data: logs, count } = await query
        .order('request_timestamp', { ascending: false })
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
    console.error('[Admin Quotas] Error:', error);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
