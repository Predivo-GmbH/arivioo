-- Add RLS policies for extraction_test_runs table (admin-only access)
-- This table stores test run data created by admin users

-- Policy for service role to have full access
CREATE POLICY "Service role can manage extraction test runs" 
ON public.extraction_test_runs
FOR ALL 
USING (
  (SELECT (current_setting('request.jwt.claims', true)::json->>'role')) = 'service_role'
)
WITH CHECK (
  (SELECT (current_setting('request.jwt.claims', true)::json->>'role')) = 'service_role'
);

-- Block all public access (restrictive policy)
CREATE POLICY "No public access to extraction test runs"
ON public.extraction_test_runs
FOR ALL
USING (false);