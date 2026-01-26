-- Fix security issue: Remove public access to known_property_matches
-- This table contains proprietary property matching data that should be internal-only

DROP POLICY IF EXISTS "Anyone can view known matches" ON public.known_property_matches;

-- Replace with service_role only access for SELECT
CREATE POLICY "Service role can read known matches"
ON public.known_property_matches
FOR SELECT
USING ((SELECT ((current_setting('request.jwt.claims'::text, true))::json ->> 'role'::text)) = 'service_role'::text);


-- Fix security issue: Remove public access to blocked_platforms
-- This table contains platform blocking strategy that should be internal-only

DROP POLICY IF EXISTS "Blocked platforms are readable by all" ON public.blocked_platforms;

-- Replace with service_role only access for SELECT
CREATE POLICY "Service role can read blocked platforms"
ON public.blocked_platforms
FOR SELECT
USING ((SELECT ((current_setting('request.jwt.claims'::text, true))::json ->> 'role'::text)) = 'service_role'::text);

-- Also add service_role policies for INSERT/UPDATE/DELETE on blocked_platforms
-- so admin dashboard can manage them via edge functions
CREATE POLICY "Service role can manage blocked platforms"
ON public.blocked_platforms
FOR ALL
USING ((SELECT ((current_setting('request.jwt.claims'::text, true))::json ->> 'role'::text)) = 'service_role'::text)
WITH CHECK ((SELECT ((current_setting('request.jwt.claims'::text, true))::json ->> 'role'::text)) = 'service_role'::text);