-- Add screenshot-top OCR proof fields for Airbnb booking-card baseline debug
ALTER TABLE public.airbnb_baseline_debug
  ADD COLUMN IF NOT EXISTS screenshot_top_base64 text,
  ADD COLUMN IF NOT EXISTS screenshot_top_sha256 text,
  ADD COLUMN IF NOT EXISTS screenshot_top_clip jsonb,
  ADD COLUMN IF NOT EXISTS scroll_y_at_capture integer,
  ADD COLUMN IF NOT EXISTS booking_card_ocr_matches jsonb,
  ADD COLUMN IF NOT EXISTS booking_card_visible_evidence_snippet text;

-- Helpful index for quick lookups by run
CREATE INDEX IF NOT EXISTS idx_airbnb_baseline_debug_run_id_created_at
  ON public.airbnb_baseline_debug (run_id, created_at DESC);