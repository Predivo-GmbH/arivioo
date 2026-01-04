-- Add derived_request column to store parsed values from Airbnb URL
-- and constructed values for Expedia
ALTER TABLE public.extraction_test_runs
ADD COLUMN IF NOT EXISTS derived_request jsonb DEFAULT '{}'::jsonb;

-- Add index for faster lookups on recent runs
CREATE INDEX IF NOT EXISTS idx_extraction_test_runs_created_at 
ON public.extraction_test_runs(created_at DESC);

-- Add index on admin_email for filtering
CREATE INDEX IF NOT EXISTS idx_extraction_test_runs_admin_email 
ON public.extraction_test_runs(admin_email);