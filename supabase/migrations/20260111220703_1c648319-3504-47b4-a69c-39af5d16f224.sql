-- Create table to track canary check history for provider capability monitoring
CREATE TABLE public.provider_canary_checks (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  provider TEXT NOT NULL,
  canary_url TEXT NOT NULL,
  check_in_date TEXT NOT NULL,
  check_out_date TEXT NOT NULL,
  nights_count INTEGER NOT NULL,
  
  -- Result
  passed BOOLEAN NOT NULL,
  extraction_status TEXT,
  extracted_price NUMERIC,
  currency TEXT DEFAULT 'USD',
  evidence_snippet TEXT,
  failure_reason TEXT,
  
  -- Metadata
  duration_ms INTEGER,
  checks_detail JSONB,
  
  -- Timestamps
  checked_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Index for querying by provider and time
CREATE INDEX idx_provider_canary_checks_provider_time ON public.provider_canary_checks (provider, checked_at DESC);

-- Index for finding recent failures
CREATE INDEX idx_provider_canary_checks_failures ON public.provider_canary_checks (provider, passed, checked_at DESC) WHERE passed = false;

-- Enable RLS
ALTER TABLE public.provider_canary_checks ENABLE ROW LEVEL SECURITY;

-- Allow service role full access (edge functions use service role)
CREATE POLICY "Service role can manage canary checks"
ON public.provider_canary_checks
FOR ALL
USING (true)
WITH CHECK (true);

-- Add comment
COMMENT ON TABLE public.provider_canary_checks IS 'Tracks provider canary check results for regression monitoring';