-- Fix: Service role policies should actually check for service role, not allow everyone
-- Currently these policies have USING(true) which allows ALL users including anonymous

-- Fix search_stage_runs - Drop the overly permissive service role policy
DROP POLICY IF EXISTS "Service role can manage stage runs" ON public.search_stage_runs;

-- Create a proper service role policy that actually checks for service role
CREATE POLICY "Service role can manage stage runs" 
ON public.search_stage_runs 
FOR ALL 
USING (
  (SELECT (current_setting('request.jwt.claims'::text, true)::json ->> 'role')) = 'service_role'
)
WITH CHECK (
  (SELECT (current_setting('request.jwt.claims'::text, true)::json ->> 'role')) = 'service_role'
);

-- Fix airbnb_confirmed_totals - Drop the overly permissive service role policy
DROP POLICY IF EXISTS "Service role can manage all confirmations" ON public.airbnb_confirmed_totals;

-- Create a proper service role policy that actually checks for service role
CREATE POLICY "Service role can manage all confirmations" 
ON public.airbnb_confirmed_totals 
FOR ALL 
USING (
  (SELECT (current_setting('request.jwt.claims'::text, true)::json ->> 'role')) = 'service_role'
)
WITH CHECK (
  (SELECT (current_setting('request.jwt.claims'::text, true)::json ->> 'role')) = 'service_role'
);