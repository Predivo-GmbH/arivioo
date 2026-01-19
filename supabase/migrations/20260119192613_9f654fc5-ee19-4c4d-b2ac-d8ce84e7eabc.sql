-- Add confidence_score column to search_platforms for rejected candidates
-- This allows us to show the actual trust score for all candidates, including rejected ones

ALTER TABLE public.search_platforms 
ADD COLUMN IF NOT EXISTS confidence_score numeric(5,2) DEFAULT NULL;

-- Add comment for documentation
COMMENT ON COLUMN public.search_platforms.confidence_score IS 'AI verification confidence score (0-100). Stored for all candidates including rejected ones to show in testing UI.';