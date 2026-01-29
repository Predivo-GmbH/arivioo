-- Add Tier-A retry state columns to price_extractions
-- These columns persist retry state across edge function executions

ALTER TABLE public.price_extractions
ADD COLUMN tier_a_attempt_count integer DEFAULT 0,
ADD COLUMN tier_a_last_transient_reason text,
ADD COLUMN tier_a_next_retry_at timestamp with time zone,
ADD COLUMN tier_a_state text;

-- Add check constraint for tier_a_state values
ALTER TABLE public.price_extractions
ADD CONSTRAINT tier_a_state_check CHECK (
  tier_a_state IS NULL OR 
  tier_a_state IN ('pending_retry', 'running', 'success', 'hard_terminal', 'exhausted')
);

-- Create index for efficient lookup of pending retries
CREATE INDEX idx_price_extractions_tier_a_pending 
ON public.price_extractions (tier_a_next_retry_at, tier_a_state)
WHERE tier_a_state = 'pending_retry';

-- Add comment for documentation
COMMENT ON COLUMN public.price_extractions.tier_a_attempt_count IS 'Number of extraction attempts for Tier-A platforms (Agoda, Booking). Max 4.';
COMMENT ON COLUMN public.price_extractions.tier_a_last_transient_reason IS 'Last transient failure reason that triggered a retry (e.g., checkout_link_not_found, vat_excluded_checkout_failed)';
COMMENT ON COLUMN public.price_extractions.tier_a_next_retry_at IS 'Scheduled time for next retry attempt. Used by orchestrator to resume retries.';
COMMENT ON COLUMN public.price_extractions.tier_a_state IS 'Tier-A retry state machine: pending_retry, running, success, hard_terminal, exhausted. NULL for non-Tier-A platforms.';