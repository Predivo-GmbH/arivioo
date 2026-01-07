-- Fix overly permissive RLS policies on three tables
-- Replace USING(true) WITH CHECK(true) with proper service_role validation

-- 1. Fix known_property_matches: Drop and recreate the "Service role can manage matches" policy
DROP POLICY IF EXISTS "Service role can manage matches" ON public.known_property_matches;

CREATE POLICY "Service role can manage matches"
ON public.known_property_matches
FOR ALL
USING (
  (SELECT (current_setting('request.jwt.claims'::text, true)::json ->> 'role')) = 'service_role'
)
WITH CHECK (
  (SELECT (current_setting('request.jwt.claims'::text, true)::json ->> 'role')) = 'service_role'
);

-- 2. Fix search_stage_stats: Drop and recreate the "Service role can manage stage stats" policy
DROP POLICY IF EXISTS "Service role can manage stage stats" ON public.search_stage_stats;

CREATE POLICY "Service role can manage stage stats"
ON public.search_stage_stats
FOR ALL
USING (
  (SELECT (current_setting('request.jwt.claims'::text, true)::json ->> 'role')) = 'service_role'
)
WITH CHECK (
  (SELECT (current_setting('request.jwt.claims'::text, true)::json ->> 'role')) = 'service_role'
);

-- 3. Fix airbnb_baseline_debug: Drop and recreate the "Service role can manage debug data" policy
DROP POLICY IF EXISTS "Service role can manage debug data" ON public.airbnb_baseline_debug;

CREATE POLICY "Service role can manage debug data"
ON public.airbnb_baseline_debug
FOR ALL
USING (
  (SELECT (current_setting('request.jwt.claims'::text, true)::json ->> 'role')) = 'service_role'
)
WITH CHECK (
  (SELECT (current_setting('request.jwt.claims'::text, true)::json ->> 'role')) = 'service_role'
);