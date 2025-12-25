-- Add new columns to platform_adapters for Firecrawl-first extraction pipeline
-- These replace reliance on deep_link_template as primary mechanism

ALTER TABLE public.platform_adapters 
ADD COLUMN IF NOT EXISTS url_parameter_rules JSONB DEFAULT NULL,
ADD COLUMN IF NOT EXISTS navigation_hints JSONB DEFAULT NULL,
ADD COLUMN IF NOT EXISTS extraction_schema_overrides JSONB DEFAULT NULL;

-- Add comment explaining the new columns
COMMENT ON COLUMN public.platform_adapters.url_parameter_rules IS 'Rules for modifying existing URLs to set/replace checkin, checkout, adults, children, rooms parameters';
COMMENT ON COLUMN public.platform_adapters.navigation_hints IS 'Keywords/patterns for navigating to pricing pages: availability, reserve, select room, price details, taxes and fees';
COMMENT ON COLUMN public.platform_adapters.extraction_schema_overrides IS 'Platform-specific extraction hints for Firecrawl schema-based extraction';

-- Add provider_used column to price_extractions to track which provider succeeded
ALTER TABLE public.price_extractions
ADD COLUMN IF NOT EXISTS provider_used TEXT DEFAULT NULL,
ADD COLUMN IF NOT EXISTS evidence_snippets JSONB DEFAULT NULL,
ADD COLUMN IF NOT EXISTS final_resolved_url TEXT DEFAULT NULL,
ADD COLUMN IF NOT EXISTS page_content_hash TEXT DEFAULT NULL,
ADD COLUMN IF NOT EXISTS extraction_stage TEXT DEFAULT NULL,
ADD COLUMN IF NOT EXISTS confidence_score NUMERIC DEFAULT NULL;

-- Add comment explaining new columns
COMMENT ON COLUMN public.price_extractions.provider_used IS 'Extraction provider used: firecrawl or zyte';
COMMENT ON COLUMN public.price_extractions.evidence_snippets IS 'Short snippets from page that mention price and/or dates';
COMMENT ON COLUMN public.price_extractions.final_resolved_url IS 'Final URL after any navigation/redirects';
COMMENT ON COLUMN public.price_extractions.page_content_hash IS 'Hash of returned page content for debugging';
COMMENT ON COLUMN public.price_extractions.extraction_stage IS 'Stage where price was extracted: LISTING_PAGE, ROOMS_PAGE, CHECKOUT_REVIEW, UNKNOWN';
COMMENT ON COLUMN public.price_extractions.confidence_score IS 'Confidence based on date match, total vs partial, taxes flag';