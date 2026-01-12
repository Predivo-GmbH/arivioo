-- Use a CTE to identify and delete duplicates, keeping only the row with the lowest id per (search_id, listing_url)
WITH duplicates_sr AS (
  SELECT id, 
         ROW_NUMBER() OVER (PARTITION BY search_id, listing_url ORDER BY id) as rn
  FROM public.search_results
)
DELETE FROM public.search_results 
WHERE id IN (SELECT id FROM duplicates_sr WHERE rn > 1);

-- Same for search_platforms
WITH duplicates_sp AS (
  SELECT id, 
         ROW_NUMBER() OVER (PARTITION BY search_id, listing_url ORDER BY id) as rn
  FROM public.search_platforms
)
DELETE FROM public.search_platforms 
WHERE id IN (SELECT id FROM duplicates_sp WHERE rn > 1);

-- Now add unique constraint on search_results for upsert operations
CREATE UNIQUE INDEX IF NOT EXISTS search_results_search_id_listing_url_key 
ON public.search_results (search_id, listing_url);

-- Add unique constraint on search_platforms for upsert operations by listing_url
CREATE UNIQUE INDEX IF NOT EXISTS search_platforms_search_id_listing_url_key 
ON public.search_platforms (search_id, listing_url);