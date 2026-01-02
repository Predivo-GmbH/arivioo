-- Create table for storing canonical stable baselines
CREATE TABLE public.system_baselines (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  baseline_name TEXT NOT NULL UNIQUE,
  baseline_version TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  declared_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  declared_by TEXT,
  git_commit_hash TEXT,
  deployment_id TEXT,
  is_active BOOLEAN NOT NULL DEFAULT false,
  expectations JSONB NOT NULL,
  notes TEXT,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Only one baseline can be active at a time
CREATE UNIQUE INDEX idx_system_baselines_active ON public.system_baselines (is_active) WHERE is_active = true;

-- Enable RLS (admin-only access via edge function)
ALTER TABLE public.system_baselines ENABLE ROW LEVEL SECURITY;

-- No direct public access - all access via admin edge function
CREATE POLICY "No direct access to baselines"
ON public.system_baselines
FOR ALL
USING (false);

-- Insert the initial canonical baseline
INSERT INTO public.system_baselines (
  baseline_name,
  baseline_version,
  declared_at,
  declared_by,
  is_active,
  expectations,
  notes
) VALUES (
  'search-results-stable-v1',
  '1.0.0',
  now(),
  'system',
  true,
  '{
    "search": {
      "completes_successfully": true,
      "progress_stages_monotonic": true,
      "stages_count": 6
    },
    "results": {
      "render_correctly": true,
      "photo_comparison_present": true,
      "comparison_summary_shown": true,
      "summary_logic_correct": true
    },
    "access_control": {
      "locked_unlocked_works": true,
      "admin_bypass_works": true
    },
    "admin": {
      "dashboard_shows_live_data": true,
      "price_extractions_visible": true,
      "health_monitoring_active": true
    },
    "known_issues": []
  }',
  'Initial canonical baseline recorded after stabilization of search flow, monotonic progress, modal management, and admin instrumentation.'
);