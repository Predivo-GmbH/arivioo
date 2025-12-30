-- Create table to persist Airbnb baseline debug bundles
CREATE TABLE public.airbnb_baseline_debug (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  search_id UUID REFERENCES public.searches(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  run_number INTEGER NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  
  -- Provider info
  provider TEXT NOT NULL,
  provider_order INTEGER NOT NULL,
  
  -- Result status
  status TEXT NOT NULL,
  duration_ms INTEGER,
  
  -- Price data (only if total extracted)
  extracted_price NUMERIC,
  currency TEXT,
  includes_taxes_fees BOOLEAN,
  
  -- Evidence and debug
  evidence_snippet TEXT,
  candidates_summary JSONB DEFAULT '[]'::jsonb,
  rejected_reason TEXT,
  
  -- Content hash for dedup
  content_hash TEXT,
  
  -- Metadata
  airbnb_url TEXT,
  check_in_date DATE,
  check_out_date DATE,
  nights_count INTEGER
);

-- Enable RLS
ALTER TABLE public.airbnb_baseline_debug ENABLE ROW LEVEL SECURITY;

-- Service role can manage debug data
CREATE POLICY "Service role can manage debug data"
ON public.airbnb_baseline_debug
FOR ALL
USING (true)
WITH CHECK (true);

-- Admin read access via edge function (no direct client access needed)
CREATE POLICY "No public access to debug data"
ON public.airbnb_baseline_debug
FOR SELECT
USING (false);

-- Index for efficient lookups
CREATE INDEX idx_airbnb_baseline_debug_search_id ON public.airbnb_baseline_debug(search_id);
CREATE INDEX idx_airbnb_baseline_debug_run_id ON public.airbnb_baseline_debug(run_id);
CREATE INDEX idx_airbnb_baseline_debug_created_at ON public.airbnb_baseline_debug(created_at DESC);