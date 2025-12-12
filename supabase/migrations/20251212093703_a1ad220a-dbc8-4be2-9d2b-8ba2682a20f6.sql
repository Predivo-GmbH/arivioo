-- Add source_airbnb_image column to store which Airbnb image was used for the visual match
ALTER TABLE public.search_results 
ADD COLUMN IF NOT EXISTS source_airbnb_image text;