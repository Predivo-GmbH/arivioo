ALTER TABLE public.airbnb_baseline_debug
ADD COLUMN IF NOT EXISTS click_log text,
ADD COLUMN IF NOT EXISTS raw_matched_string text;

CREATE INDEX IF NOT EXISTS idx_airbnb_baseline_debug_run_id ON public.airbnb_baseline_debug (run_id);
CREATE INDEX IF NOT EXISTS idx_airbnb_baseline_debug_provider_created_at ON public.airbnb_baseline_debug (provider, created_at DESC);