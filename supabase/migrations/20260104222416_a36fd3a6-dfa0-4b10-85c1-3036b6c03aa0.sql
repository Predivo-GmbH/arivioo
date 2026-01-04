-- Create a table to cache known platform matches for Airbnb properties
-- This ensures consistent results across searches for the same property
CREATE TABLE public.known_property_matches (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  airbnb_room_id TEXT NOT NULL,
  platform_name TEXT NOT NULL,
  platform_url TEXT NOT NULL,
  listing_title TEXT,
  first_found_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  last_verified_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  match_count INTEGER NOT NULL DEFAULT 1,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  
  -- Unique constraint: one entry per airbnb property + platform URL
  CONSTRAINT unique_airbnb_platform_match UNIQUE (airbnb_room_id, platform_url)
);

-- Index for fast lookups by airbnb_room_id
CREATE INDEX idx_known_matches_airbnb_room ON public.known_property_matches(airbnb_room_id);

-- Index for platform filtering
CREATE INDEX idx_known_matches_platform ON public.known_property_matches(platform_name);

-- Enable RLS (public read, service role write)
ALTER TABLE public.known_property_matches ENABLE ROW LEVEL SECURITY;

-- Allow public read access (these are non-sensitive property matches)
CREATE POLICY "Anyone can view known matches"
ON public.known_property_matches
FOR SELECT
USING (true);

-- Only service role can insert/update (edge functions)
CREATE POLICY "Service role can manage matches"
ON public.known_property_matches
FOR ALL
USING (true)
WITH CHECK (true);

-- Trigger for updated_at
CREATE TRIGGER update_known_property_matches_updated_at
BEFORE UPDATE ON public.known_property_matches
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();