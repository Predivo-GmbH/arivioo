-- Create extraction_test_runs table for Admin Extraction Test Harness
CREATE TABLE public.extraction_test_runs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  admin_email TEXT NOT NULL,
  airbnb_url TEXT NOT NULL,
  expedia_url TEXT,
  request_params JSONB NOT NULL DEFAULT '{}',
  results_json JSONB,
  status TEXT NOT NULL DEFAULT 'pending',
  duration_ms INTEGER,
  error_message TEXT
);

-- Enable RLS
ALTER TABLE public.extraction_test_runs ENABLE ROW LEVEL SECURITY;

-- Only service role can access (admin-only via edge function)
-- No public policies needed since this is accessed via admin-dashboard with service role