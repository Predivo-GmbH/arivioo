-- Drop the overly permissive public read policy on platform_adapters
DROP POLICY IF EXISTS "Platform adapters are readable by all" ON public.platform_adapters;

-- Create a restrictive policy that only allows service role access
-- This protects proprietary scraping strategies from public exposure
CREATE POLICY "Service role can read platform adapters"
ON public.platform_adapters FOR SELECT
USING (
  (SELECT current_setting('request.jwt.claims', true)::json->>'role') = 'service_role'
);