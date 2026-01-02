-- Add unique constraint on search_result_id to support upsert operations
-- This enables generate-deep-links to correctly create/update price_extractions
ALTER TABLE public.price_extractions 
ADD CONSTRAINT price_extractions_search_result_id_key UNIQUE (search_result_id);