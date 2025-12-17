-- Add columns to track which dates were used for price comparison
ALTER TABLE public.search_results 
ADD COLUMN IF NOT EXISTS price_check_in date,
ADD COLUMN IF NOT EXISTS price_check_out date,
ADD COLUMN IF NOT EXISTS dates_differ boolean DEFAULT false;