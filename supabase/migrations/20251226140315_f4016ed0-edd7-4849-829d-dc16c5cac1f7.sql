-- Add api_error column to searches table for storing detailed error information
ALTER TABLE public.searches ADD COLUMN IF NOT EXISTS api_error text;

-- Add api_error_code column for categorizing errors
ALTER TABLE public.searches ADD COLUMN IF NOT EXISTS api_error_code text;