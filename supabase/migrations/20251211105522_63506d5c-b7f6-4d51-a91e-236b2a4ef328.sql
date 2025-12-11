-- Add columns to store multiple images as JSON arrays
ALTER TABLE public.searches 
ADD COLUMN IF NOT EXISTS airbnb_images jsonb DEFAULT '[]'::jsonb;

ALTER TABLE public.search_results
ADD COLUMN IF NOT EXISTS images jsonb DEFAULT '[]'::jsonb;