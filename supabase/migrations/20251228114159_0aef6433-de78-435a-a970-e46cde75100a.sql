-- Add promotion eligibility columns to platform_adapters
ALTER TABLE public.platform_adapters
ADD COLUMN IF NOT EXISTS gate_1_passed BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS gate_2_passed BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS gate_3_passed BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS promotion_score NUMERIC DEFAULT 0,
ADD COLUMN IF NOT EXISTS last_scored_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS promotion_candidate BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS promotion_candidate_reason TEXT;

-- Add comments for documentation
COMMENT ON COLUMN public.platform_adapters.gate_1_passed IS 'Date Application Viability: dates_validated=true at least once';
COMMENT ON COLUMN public.platform_adapters.gate_2_passed IS 'Price Presence: at least one grounded price extraction with hallucination guard passed';
COMMENT ON COLUMN public.platform_adapters.gate_3_passed IS 'Failure Quality: dominant failure reason is not blocked/login/reserve/payment';
COMMENT ON COLUMN public.platform_adapters.promotion_score IS 'Computed score (0-1) based on success_rate, recency, stability';
COMMENT ON COLUMN public.platform_adapters.promotion_candidate IS 'True if this is the single highest-scoring eligible platform';
COMMENT ON COLUMN public.platform_adapters.promotion_candidate_reason IS 'Human-readable explanation of why this platform is/isnt a candidate';

-- Create index for quick promotion candidate lookup
CREATE INDEX IF NOT EXISTS idx_platform_adapters_promotion_candidate ON public.platform_adapters(promotion_candidate) WHERE promotion_candidate = true;