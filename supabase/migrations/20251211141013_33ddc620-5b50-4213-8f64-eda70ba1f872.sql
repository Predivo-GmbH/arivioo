-- Add columns to store comparison dates on searches table
ALTER TABLE public.searches 
ADD COLUMN IF NOT EXISTS check_in_date date,
ADD COLUMN IF NOT EXISTS check_out_date date,
ADD COLUMN IF NOT EXISTS nights_count integer;

-- Add match_type column to search_results for differentiating visual vs text matches
ALTER TABLE public.search_results 
ADD COLUMN IF NOT EXISTS match_type text DEFAULT 'text';