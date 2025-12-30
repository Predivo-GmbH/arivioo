-- Add OCR proof + artifact columns for Airbnb booking-card screenshot OCR
ALTER TABLE public.airbnb_baseline_debug
  ADD COLUMN IF NOT EXISTS ocr_input_source_type text,
  ADD COLUMN IF NOT EXISTS ocr_input_image_sha256 text,
  ADD COLUMN IF NOT EXISTS booking_card_screenshot_sha256 text,
  ADD COLUMN IF NOT EXISTS booking_card_screenshot_base64 text,
  ADD COLUMN IF NOT EXISTS booking_card_screenshot_dimensions jsonb,
  ADD COLUMN IF NOT EXISTS booking_card_screenshot_bbox jsonb,
  ADD COLUMN IF NOT EXISTS booking_card_ocr_text_raw text,
  ADD COLUMN IF NOT EXISTS booking_card_ocr_text_normalized text,
  ADD COLUMN IF NOT EXISTS booking_card_ocr_matched_substring text;