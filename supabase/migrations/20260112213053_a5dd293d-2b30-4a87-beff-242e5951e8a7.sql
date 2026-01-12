
-- Alter confidence_score columns to support 0-100 scale (integers)
-- The ImageGate now uses a 0-100 integer scale for confidence scores

-- Fix search_results.confidence_score
ALTER TABLE public.search_results 
ALTER COLUMN confidence_score TYPE numeric(5,2);

-- Also check and fix price_extractions.confidence_score if needed
ALTER TABLE public.price_extractions 
ALTER COLUMN confidence_score TYPE numeric(5,2);
