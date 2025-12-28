-- Add Tier B evidence tracking columns to platform_adapters
ALTER TABLE public.platform_adapters
ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS last_outcome_type TEXT,
ADD COLUMN IF NOT EXISTS total_attempts INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS total_successes INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS total_failures INTEGER NOT NULL DEFAULT 0;

-- Add computed promotion readiness fields (read-only derived)
COMMENT ON COLUMN public.platform_adapters.last_outcome_type IS 'Last extraction outcome: success, dates_not_applied, no_availability, price_not_found, blocked, login_required, reserve_required';
COMMENT ON COLUMN public.platform_adapters.total_attempts IS 'Cumulative count of extraction attempts';
COMMENT ON COLUMN public.platform_adapters.total_successes IS 'Cumulative count of successful extractions';
COMMENT ON COLUMN public.platform_adapters.total_failures IS 'Cumulative count of failed extractions';

-- Create index for Tier B platform lookup
CREATE INDEX IF NOT EXISTS idx_platform_adapters_tier_b ON public.platform_adapters(coverage_tier) WHERE coverage_tier = 'B';