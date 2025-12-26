-- Add date application strategy and learned behavior columns to platform_adapters
ALTER TABLE public.platform_adapters 
ADD COLUMN IF NOT EXISTS date_application_strategy TEXT DEFAULT 'url_only' CHECK (date_application_strategy IN ('url_only', 'url_then_navigate', 'navigate_only')),
ADD COLUMN IF NOT EXISTS learned_navigation_steps JSONB DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS last_successful_strategy TEXT,
ADD COLUMN IF NOT EXISTS date_validation_required BOOLEAN DEFAULT true,
ADD COLUMN IF NOT EXISTS strategy_updated_at TIMESTAMP WITH TIME ZONE;

-- Add new extraction status values to price_extractions for explicit failures
-- (status is already text type, so we just document the new valid values)
COMMENT ON COLUMN public.price_extractions.extraction_status IS 
'Valid values: pending, running, success, dates_not_applied, no_availability_for_dates, price_not_found_after_dates_applied, blocked_captcha_or_bot, blocked_rate_limit, render_failed, failed_unknown';

-- Add date validation columns to price_extractions
ALTER TABLE public.price_extractions
ADD COLUMN IF NOT EXISTS dates_validated BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS detected_checkin TEXT,
ADD COLUMN IF NOT EXISTS detected_checkout TEXT,
ADD COLUMN IF NOT EXISTS date_validation_attempts INTEGER DEFAULT 0;

-- Add new pipeline job types for two-phase flow
COMMENT ON COLUMN public.pipeline_jobs.job_type IS 
'Valid values: search, validate_dates, extract_price, generate_adapter';

-- Add validation-specific fields to pipeline_jobs metadata support
COMMENT ON COLUMN public.pipeline_jobs.metadata IS 
'For validate_dates: {extraction_id, deep_link, platform_name, requested_checkin, requested_checkout, strategy_used, dates_detected}';

-- Create index for efficient pipeline_jobs queries
CREATE INDEX IF NOT EXISTS idx_pipeline_jobs_extraction_status 
ON public.pipeline_jobs(extraction_id, status) WHERE extraction_id IS NOT NULL;