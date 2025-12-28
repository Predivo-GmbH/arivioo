-- Add promotion lifecycle fields to platform_adapters
ALTER TABLE public.platform_adapters 
ADD COLUMN IF NOT EXISTS promotion_status TEXT DEFAULT 'none' CHECK (promotion_status IN ('none', 'nominated', 'in_progress', 'promoted', 'rejected')),
ADD COLUMN IF NOT EXISTS promotion_in_progress BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS promotion_started_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS promotion_started_by TEXT,
ADD COLUMN IF NOT EXISTS promotion_source_score NUMERIC,
ADD COLUMN IF NOT EXISTS promotion_snapshot JSONB,
ADD COLUMN IF NOT EXISTS promotion_notes TEXT,
ADD COLUMN IF NOT EXISTS promotion_decision_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS promotion_decision_by TEXT;

-- Update nominated candidates to have 'nominated' status
UPDATE public.platform_adapters 
SET promotion_status = 'nominated' 
WHERE promotion_candidate = true AND promotion_status = 'none';

-- Create index for promotion workflow queries
CREATE INDEX IF NOT EXISTS idx_platform_adapters_promotion_status ON public.platform_adapters(promotion_status);
CREATE INDEX IF NOT EXISTS idx_platform_adapters_promotion_in_progress ON public.platform_adapters(promotion_in_progress) WHERE promotion_in_progress = true;