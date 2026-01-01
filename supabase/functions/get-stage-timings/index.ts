import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Secure CORS - Domain allowlist
const ALLOWED_ORIGINS = [
  'https://lovable.dev',
  'https://www.lovable.dev',
  /^https:\/\/[a-zA-Z0-9-]+\.lovable\.app$/,
  /^https:\/\/[a-zA-Z0-9-]+\.lovableproject\.com$/,
  /^https:\/\/id-preview--[a-zA-Z0-9-]+\.lovable\.app$/,
  'https://arivioo.lovable.app',
  'https://arivioo.com',
  'https://www.arivioo.com',
];

function isOriginAllowed(origin: string | null): boolean {
  if (!origin) return false;
  return ALLOWED_ORIGINS.some(allowed => {
    if (typeof allowed === 'string') return origin === allowed;
    return allowed.test(origin);
  });
}

function getCorsHeaders(request: Request): Record<string, string> {
  const requestOrigin = request.headers.get('origin');
  const origin = requestOrigin ?? '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Vary': 'Origin',
  };
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Canonical pipeline stages - must match frontend definitions
 */
const PIPELINE_STAGES = [
  'analyze_listing',
  'collect_photos',
  'find_matches',
  'validate_dates',
  'collect_prices',
  'finalize_results',
] as const;

type StageName = typeof PIPELINE_STAGES[number];

interface StageTimingResult {
  stageId: StageName;
  p50Seconds: number | null;
  p80Seconds: number | null;
  sampleCount: number;
  lastUpdated: string | null;
}

/**
 * Calculate robust percentile with IQR-based outlier removal
 * 
 * Algorithm:
 * 1. Filter to successful/partial runs only
 * 2. Calculate Q1, Q3, IQR
 * 3. Remove outliers outside [Q1 - 1.5*IQR, Q3 + 1.5*IQR]
 * 4. If too few samples remain (<10), fallback to simple percentile
 * 5. Return p50 and p80 from filtered data
 */
function calculateRobustPercentiles(durations: number[]): { p50: number | null; p80: number | null } {
  if (durations.length === 0) {
    return { p50: null, p80: null };
  }

  // Sort ascending
  const sorted = [...durations].sort((a, b) => a - b);
  
  // Simple percentile function
  const percentile = (arr: number[], p: number): number => {
    const idx = (p / 100) * (arr.length - 1);
    const lower = Math.floor(idx);
    const upper = Math.ceil(idx);
    if (lower === upper) return arr[lower];
    return arr[lower] + (idx - lower) * (arr[upper] - arr[lower]);
  };

  // If we have fewer than 10 samples, just use simple percentiles
  if (sorted.length < 10) {
    return {
      p50: percentile(sorted, 50),
      p80: percentile(sorted, 80),
    };
  }

  // Calculate IQR for outlier removal
  const q1 = percentile(sorted, 25);
  const q3 = percentile(sorted, 75);
  const iqr = q3 - q1;
  const lowerBound = q1 - 1.5 * iqr;
  const upperBound = q3 + 1.5 * iqr;

  // Filter outliers
  const filtered = sorted.filter(d => d >= lowerBound && d <= upperBound);

  // If too few remain after filtering, use simple percentiles on full data
  if (filtered.length < 10) {
    return {
      p50: percentile(sorted, 50),
      p80: percentile(sorted, 80),
    };
  }

  return {
    p50: percentile(filtered, 50),
    p80: percentile(filtered, 80),
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // First, try to get cached stats from search_stage_stats (updated daily)
    const today = new Date().toISOString().split('T')[0];
    const { data: cachedStats } = await supabase
      .from('search_stage_stats')
      .select('*')
      .eq('computed_date', today);

    // If we have cached stats for all stages, return them
    if (cachedStats && cachedStats.length === PIPELINE_STAGES.length) {
      const timings: StageTimingResult[] = PIPELINE_STAGES.map(stageId => {
        const cached = cachedStats.find((s: any) => s.stage_name === stageId);
        return {
          stageId,
          p50Seconds: cached?.p50_duration_ms ? cached.p50_duration_ms / 1000 : null,
          p80Seconds: cached?.p80_duration_ms ? cached.p80_duration_ms / 1000 : null,
          sampleCount: cached?.sample_count || 0,
          lastUpdated: cached?.updated_at || null,
        };
      });

      return new Response(JSON.stringify({ success: true, timings, cached: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Otherwise, calculate from raw telemetry data
    const timings: StageTimingResult[] = [];

    for (const stageId of PIPELINE_STAGES) {
      // Get the most recent 200 successful/partial runs for this stage
      const { data: runs } = await supabase
        .from('search_stage_runs')
        .select('duration_ms, finished_at')
        .eq('stage_name', stageId)
        .in('outcome_status', ['success', 'partial'])
        .not('duration_ms', 'is', null)
        .order('started_at', { ascending: false })
        .limit(200);

      if (!runs || runs.length === 0) {
        timings.push({
          stageId,
          p50Seconds: null,
          p80Seconds: null,
          sampleCount: 0,
          lastUpdated: null,
        });
        continue;
      }

      const durations = runs.map((r: any) => r.duration_ms);
      const { p50, p80 } = calculateRobustPercentiles(durations);

      timings.push({
        stageId,
        p50Seconds: p50 ? Math.round(p50) / 1000 : null,
        p80Seconds: p80 ? Math.round(p80) / 1000 : null,
        sampleCount: runs.length,
        lastUpdated: runs[0]?.finished_at || null,
      });

      // Update the cached stats for this stage
      if (p50 !== null && p80 !== null) {
        await supabase
          .from('search_stage_stats')
          .upsert({
            stage_name: stageId,
            computed_date: today,
            sample_count: runs.length,
            p50_duration_ms: Math.round(p50),
            p80_duration_ms: Math.round(p80),
            avg_duration_ms: Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
            min_duration_ms: Math.min(...durations),
            max_duration_ms: Math.max(...durations),
            success_rate: 100, // Only counting successful runs
            updated_at: new Date().toISOString(),
          }, {
            onConflict: 'stage_name,computed_date',
          });
      }
    }

    return new Response(JSON.stringify({ success: true, timings, cached: false }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error calculating stage timings:", error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
