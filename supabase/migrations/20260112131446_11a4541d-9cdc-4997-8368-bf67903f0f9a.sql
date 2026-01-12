-- Add finalization_error to searches for explicit finalization failure details
ALTER TABLE public.searches
ADD COLUMN IF NOT EXISTS finalization_error jsonb;

-- Authoritative matched platform set per search
CREATE TABLE IF NOT EXISTS public.search_platforms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  search_id uuid NOT NULL,
  platform_name text NOT NULL,
  listing_url text NOT NULL,
  listing_title text,
  image_url text,
  images jsonb NOT NULL DEFAULT '[]'::jsonb,
  match_type text,
  source_airbnb_image text,
  matched_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),

  -- Extraction linkage / terminal summary (optional, best-effort)
  extraction_id_latest uuid,
  extraction_status_terminal text,
  outcome_category text,
  last_error text,

  UNIQUE (search_id, platform_name)
);

CREATE INDEX IF NOT EXISTS idx_search_platforms_search_id ON public.search_platforms(search_id);

-- Keep updated_at fresh
DROP TRIGGER IF EXISTS trg_search_platforms_updated_at ON public.search_platforms;
CREATE TRIGGER trg_search_platforms_updated_at
BEFORE UPDATE ON public.search_platforms
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- RLS
ALTER TABLE public.search_platforms ENABLE ROW LEVEL SECURITY;

-- Users can view platforms for their own searches
DROP POLICY IF EXISTS "Users can view platforms of their own searches" ON public.search_platforms;
CREATE POLICY "Users can view platforms of their own searches"
ON public.search_platforms
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.searches s
    WHERE s.id = search_platforms.search_id
      AND s.user_id = auth.uid()
  )
);

-- Service role manages authoritative platform set
DROP POLICY IF EXISTS "Service role can manage search platforms" ON public.search_platforms;
CREATE POLICY "Service role can manage search platforms"
ON public.search_platforms
FOR ALL
USING (
  (SELECT ((current_setting('request.jwt.claims', true))::json ->> 'role')) = 'service_role'
)
WITH CHECK (
  (SELECT ((current_setting('request.jwt.claims', true))::json ->> 'role')) = 'service_role'
);
