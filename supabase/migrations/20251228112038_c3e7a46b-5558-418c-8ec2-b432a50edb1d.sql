-- Add coverage_tier column with A/B/C semantics
ALTER TABLE public.platform_adapters 
ADD COLUMN IF NOT EXISTS coverage_tier TEXT DEFAULT 'B' CHECK (coverage_tier IN ('A', 'B', 'C'));

-- Add tier_reason column for human-readable explanation
ALTER TABLE public.platform_adapters 
ADD COLUMN IF NOT EXISTS tier_reason TEXT;

-- Add tier_updated_at for tracking when tier changed
ALTER TABLE public.platform_adapters 
ADD COLUMN IF NOT EXISTS tier_updated_at TIMESTAMP WITH TIME ZONE DEFAULT now();

-- Set Hotels.com to Tier A (Supported)
UPDATE public.platform_adapters 
SET coverage_tier = 'A',
    tier_reason = 'Production-proven extractor, dates apply via URL, total visible pre-payment, repeatability verified (3/3)',
    tier_updated_at = now(),
    coverage_status = 'supported'
WHERE platform_domain = 'hotels.com';

-- Set Expedia to Tier A (Supported)
UPDATE public.platform_adapters 
SET coverage_tier = 'A',
    tier_reason = 'Production-proven extractor, dates apply via URL, total visible pre-payment, repeatability verified (3/3)',
    tier_updated_at = now(),
    coverage_status = 'supported'
WHERE platform_domain = 'expedia.com';

-- Set Vrbo to Tier C (Unsupported)
UPDATE public.platform_adapters 
SET coverage_tier = 'C',
    tier_reason = 'Network blocked (403 by Firecrawl and Zyte) - no viable extraction path',
    tier_updated_at = now(),
    coverage_status = 'blocked',
    is_active = false
WHERE platform_domain = 'vrbo.com';

-- All other platforms remain Tier B (Best Effort / Attempted)
UPDATE public.platform_adapters 
SET coverage_tier = 'B',
    tier_reason = 'Awaiting Golden Path Contract evaluation',
    tier_updated_at = now()
WHERE coverage_tier IS NULL OR (coverage_tier = 'B' AND tier_reason IS NULL);