-- Add image columns to store listing images
ALTER TABLE public.searches 
ADD COLUMN IF NOT EXISTS airbnb_image_url text;

ALTER TABLE public.search_results
ADD COLUMN IF NOT EXISTS image_url text;