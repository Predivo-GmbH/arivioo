-- Add authoritative coverage status fields to platform_adapters
ALTER TABLE public.platform_adapters 
ADD COLUMN IF NOT EXISTS coverage_status TEXT DEFAULT 'unknown' CHECK (coverage_status IN ('supported', 'unsupported', 'inquiry_based', 'reserve_required', 'blocked', 'unknown')),
ADD COLUMN IF NOT EXISTS coverage_reason TEXT,
ADD COLUMN IF NOT EXISTS dedicated_extractor TEXT,
ADD COLUMN IF NOT EXISTS retry_policy TEXT DEFAULT 'standard' CHECK (retry_policy IN ('standard', 'disabled', 'manual_only')),
ADD COLUMN IF NOT EXISTS next_review TEXT DEFAULT 'auto',
ADD COLUMN IF NOT EXISTS last_success_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS last_failure_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS proven_deterministic BOOLEAN DEFAULT false;

-- Update Hotels.com to supported status
UPDATE public.platform_adapters 
SET coverage_status = 'supported',
    coverage_reason = 'Production-proven golden path extractor',
    dedicated_extractor = 'extract-hotelscom',
    reliability_score = 1.0,
    proven_deterministic = true,
    retry_policy = 'standard',
    next_review = 'auto'
WHERE platform_domain = 'hotels.com';

-- Update Expedia to supported status  
UPDATE public.platform_adapters 
SET coverage_status = 'supported',
    coverage_reason = 'Production-proven golden path extractor',
    dedicated_extractor = 'extract-expedia',
    reliability_score = 1.0,
    proven_deterministic = true,
    retry_policy = 'standard',
    next_review = 'auto'
WHERE platform_domain = 'expedia.com';

-- Update Vrbo to unsupported/blocked status
UPDATE public.platform_adapters 
SET coverage_status = 'blocked',
    coverage_reason = 'Network blocked (403 Firecrawl + Zyte)',
    dedicated_extractor = NULL,
    reliability_score = 0.0,
    proven_deterministic = false,
    retry_policy = 'disabled',
    next_review = 'manual_only',
    is_active = false
WHERE platform_domain = 'vrbo.com';

-- Set other platforms to unknown (pending evaluation)
UPDATE public.platform_adapters 
SET coverage_status = 'unknown',
    coverage_reason = 'Not yet evaluated against Golden Path Contract'
WHERE coverage_status IS NULL OR coverage_status = 'unknown';