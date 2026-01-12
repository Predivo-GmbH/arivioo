-- Fix overly permissive RLS policy on provider_canary_checks (must be service role only)
ALTER TABLE public.provider_canary_checks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role can manage canary checks" ON public.provider_canary_checks;
CREATE POLICY "Service role can manage canary checks"
ON public.provider_canary_checks
FOR ALL
USING (
  (SELECT ((current_setting('request.jwt.claims', true))::json ->> 'role')) = 'service_role'
)
WITH CHECK (
  (SELECT ((current_setting('request.jwt.claims', true))::json ->> 'role')) = 'service_role'
);
