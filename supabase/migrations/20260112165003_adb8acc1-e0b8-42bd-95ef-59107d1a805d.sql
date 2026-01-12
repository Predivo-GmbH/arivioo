-- Fix: Add missing status values to searches_status_check constraint
-- The pipeline uses 'searching_platforms' status but it wasn't allowed by the constraint

ALTER TABLE public.searches DROP CONSTRAINT searches_status_check;

ALTER TABLE public.searches ADD CONSTRAINT searches_status_check 
CHECK (status = ANY (ARRAY[
  'pending'::text, 
  'searching'::text, 
  'searching_platforms'::text,
  'comparing_prices'::text,
  'extracting_price'::text,
  'scraping_airbnb_page'::text,
  'completed'::text, 
  'no_results'::text, 
  'error'::text,
  'finalization_failed'::text
])) NOT VALID;

-- Validate the constraint (will fail fast if existing data violates it)
ALTER TABLE public.searches VALIDATE CONSTRAINT searches_status_check;