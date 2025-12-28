-- Create search_stage_runs table to store timing telemetry for each pipeline stage
CREATE TABLE public.search_stage_runs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  search_id UUID NOT NULL REFERENCES public.searches(id) ON DELETE CASCADE,
  stage_name TEXT NOT NULL,
  started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  finished_at TIMESTAMP WITH TIME ZONE,
  duration_ms INTEGER GENERATED ALWAYS AS (
    CASE WHEN finished_at IS NOT NULL 
    THEN EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000 
    ELSE NULL END
  ) STORED,
  outcome_status TEXT NOT NULL DEFAULT 'running' CHECK (outcome_status IN ('running', 'success', 'partial', 'failed', 'skipped', 'cancelled')),
  error_message TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create indexes for efficient querying
CREATE INDEX idx_search_stage_runs_search_id ON public.search_stage_runs(search_id);
CREATE INDEX idx_search_stage_runs_stage_name ON public.search_stage_runs(stage_name);
CREATE INDEX idx_search_stage_runs_started_at ON public.search_stage_runs(started_at DESC);
CREATE INDEX idx_search_stage_runs_outcome_status ON public.search_stage_runs(outcome_status);

-- Composite index for typical time calculations (stage + outcome + duration)
CREATE INDEX idx_search_stage_runs_stats ON public.search_stage_runs(stage_name, outcome_status, duration_ms) 
  WHERE outcome_status IN ('success', 'partial');

-- Enable RLS
ALTER TABLE public.search_stage_runs ENABLE ROW LEVEL SECURITY;

-- Allow all operations for service role (edge functions)
CREATE POLICY "Service role can manage stage runs"
ON public.search_stage_runs
FOR ALL
USING (true)
WITH CHECK (true);

-- Users can view their own search stage runs
CREATE POLICY "Users can view own search stage runs"
ON public.search_stage_runs
FOR SELECT
USING (
  search_id IN (
    SELECT id FROM public.searches WHERE user_id = auth.uid()
  )
);

-- Create daily aggregates table for fast UI lookups
CREATE TABLE public.search_stage_stats (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  stage_name TEXT NOT NULL,
  computed_date DATE NOT NULL DEFAULT CURRENT_DATE,
  sample_count INTEGER NOT NULL DEFAULT 0,
  p50_duration_ms INTEGER,
  p80_duration_ms INTEGER,
  avg_duration_ms INTEGER,
  min_duration_ms INTEGER,
  max_duration_ms INTEGER,
  success_rate NUMERIC(5,2),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(stage_name, computed_date)
);

-- Index for fast lookups
CREATE INDEX idx_search_stage_stats_stage_date ON public.search_stage_stats(stage_name, computed_date DESC);

-- Enable RLS
ALTER TABLE public.search_stage_stats ENABLE ROW LEVEL SECURITY;

-- Public read access for stats (used by UI for typical times)
CREATE POLICY "Anyone can read stage stats"
ON public.search_stage_stats
FOR SELECT
USING (true);

-- Service role can manage stats
CREATE POLICY "Service role can manage stage stats"
ON public.search_stage_stats
FOR ALL
USING (true)
WITH CHECK (true);

-- Add trigger for updated_at
CREATE TRIGGER update_search_stage_stats_updated_at
BEFORE UPDATE ON public.search_stage_stats
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();