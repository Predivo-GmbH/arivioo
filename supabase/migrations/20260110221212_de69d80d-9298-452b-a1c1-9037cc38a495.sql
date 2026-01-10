-- Add activity_log column to searches table to persist frontend activity feed
ALTER TABLE public.searches 
ADD COLUMN IF NOT EXISTS activity_log JSONB DEFAULT NULL;

-- Add comment for documentation
COMMENT ON COLUMN public.searches.activity_log IS 'Frontend activity feed events captured during SSE streaming, persisted for admin diagnostics';