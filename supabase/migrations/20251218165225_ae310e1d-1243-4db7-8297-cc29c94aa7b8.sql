-- Add heartbeat + robust skip flag to searches
ALTER TABLE public.searches
ADD COLUMN IF NOT EXISTS last_progress_at TIMESTAMPTZ NULL,
ADD COLUMN IF NOT EXISTS skip_requested BOOLEAN NOT NULL DEFAULT false;

-- Index for watchdog / admin queries
CREATE INDEX IF NOT EXISTS idx_searches_last_progress_at ON public.searches (last_progress_at);