-- Add finalisation marker and persisted snapshot to searches table
-- This ensures deterministic results after completion

-- Add finalised_at timestamp (null = not finalised, set = final snapshot is ready)
ALTER TABLE public.searches 
ADD COLUMN IF NOT EXISTS finalised_at TIMESTAMP WITH TIME ZONE DEFAULT NULL;

-- Add persisted final results snapshot (JSONB)
-- This stores the authoritative dataset used by the frontend after completion
ALTER TABLE public.searches 
ADD COLUMN IF NOT EXISTS final_results_snapshot JSONB DEFAULT NULL;

-- Add index on finalised_at for efficient lookups
CREATE INDEX IF NOT EXISTS idx_searches_finalised_at ON public.searches(finalised_at) 
WHERE finalised_at IS NOT NULL;

-- Add comment for documentation
COMMENT ON COLUMN public.searches.finalised_at IS 'Timestamp when the final results snapshot was persisted. Once set, the snapshot is immutable.';
COMMENT ON COLUMN public.searches.final_results_snapshot IS 'Persisted authoritative results used for deterministic display. Set once when search is finalised.';