-- ============================================
-- PLATFORM COVERAGE VARIANTS
-- Tracks region/country-specific extraction logic requirements
-- ============================================

-- Create platform_coverage_variants table
CREATE TABLE IF NOT EXISTS public.platform_coverage_variants (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  
  -- Parent platform reference
  parent_adapter_id UUID REFERENCES public.platform_adapters(id) ON DELETE CASCADE,
  parent_platform_domain TEXT NOT NULL,
  
  -- Variant identification
  coverage_variant_key TEXT NOT NULL UNIQUE,
  detected_country TEXT,
  detected_locale TEXT,
  detected_tld TEXT,
  
  -- Extraction flow signature (stable indicators)
  extraction_flow_signature JSONB DEFAULT '{}'::jsonb,
  
  -- Coverage status
  variant_status TEXT NOT NULL DEFAULT 'needs_coverage',
  -- 'needs_coverage' = New variant, extraction logic not yet developed
  -- 'in_development' = Being worked on
  -- 'covered' = Has working extraction logic
  -- 'incompatible' = Cannot be covered (e.g., requires special login)
  
  variant_reason TEXT,
  
  -- Inherit tier from parent but track separately
  inherited_tier TEXT DEFAULT 'B',
  
  -- Detection metadata
  first_detected_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  detection_count INTEGER NOT NULL DEFAULT 1,
  
  -- Failure tracking for this variant
  total_attempts INTEGER NOT NULL DEFAULT 0,
  structural_failures INTEGER NOT NULL DEFAULT 0,
  transient_failures INTEGER NOT NULL DEFAULT 0,
  
  -- Sample URLs for debugging
  sample_urls JSONB DEFAULT '[]'::jsonb,
  
  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create index for fast variant lookup
CREATE INDEX IF NOT EXISTS idx_coverage_variants_key ON public.platform_coverage_variants(coverage_variant_key);
CREATE INDEX IF NOT EXISTS idx_coverage_variants_parent ON public.platform_coverage_variants(parent_adapter_id);
CREATE INDEX IF NOT EXISTS idx_coverage_variants_domain ON public.platform_coverage_variants(parent_platform_domain);
CREATE INDEX IF NOT EXISTS idx_coverage_variants_status ON public.platform_coverage_variants(variant_status);

-- Add variant tracking columns to price_extractions
ALTER TABLE public.price_extractions
ADD COLUMN IF NOT EXISTS detected_variant_key TEXT,
ADD COLUMN IF NOT EXISTS variant_mismatch BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS extraction_flow_signature JSONB;

-- Enable RLS
ALTER TABLE public.platform_coverage_variants ENABLE ROW LEVEL SECURITY;

-- RLS Policies: Only service role can manage variants
CREATE POLICY "Service role can manage coverage variants"
ON public.platform_coverage_variants
FOR ALL
USING (
  (SELECT (current_setting('request.jwt.claims'::text, true))::json ->> 'role') = 'service_role'
);

CREATE POLICY "Service role can read coverage variants"
ON public.platform_coverage_variants
FOR SELECT
USING (
  (SELECT (current_setting('request.jwt.claims'::text, true))::json ->> 'role') = 'service_role'
);

-- Create trigger for updated_at
CREATE TRIGGER update_coverage_variants_updated_at
BEFORE UPDATE ON public.platform_coverage_variants
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Add comments for documentation
COMMENT ON TABLE public.platform_coverage_variants IS 'Tracks region/country-specific extraction logic requirements for platforms';
COMMENT ON COLUMN public.platform_coverage_variants.coverage_variant_key IS 'Deterministic key: domain:country:flow_signature_hash';
COMMENT ON COLUMN public.platform_coverage_variants.extraction_flow_signature IS 'Stable indicators of booking/pricing flow structure';
COMMENT ON COLUMN public.platform_coverage_variants.variant_status IS 'needs_coverage | in_development | covered | incompatible';