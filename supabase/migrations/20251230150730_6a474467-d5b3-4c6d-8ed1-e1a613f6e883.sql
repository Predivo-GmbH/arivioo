-- Add OCR visual reference fields to airbnb_baseline_debug table
-- These store the "ground truth" visible prices captured via screenshot + OCR

ALTER TABLE public.airbnb_baseline_debug
ADD COLUMN IF NOT EXISTS ocr_booking_card_amount_raw TEXT,
ADD COLUMN IF NOT EXISTS ocr_booking_card_amount_value NUMERIC,
ADD COLUMN IF NOT EXISTS ocr_booking_card_nights INTEGER,
ADD COLUMN IF NOT EXISTS ocr_booking_card_snippet TEXT,
ADD COLUMN IF NOT EXISTS ocr_breakdown_total_amount_raw TEXT,
ADD COLUMN IF NOT EXISTS ocr_breakdown_total_amount_value NUMERIC,
ADD COLUMN IF NOT EXISTS ocr_breakdown_total_snippet TEXT,
ADD COLUMN IF NOT EXISTS ocr_breakdown_taxes_amount_value NUMERIC,
ADD COLUMN IF NOT EXISTS breakdown_opened BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS ocr_validation_status TEXT,
ADD COLUMN IF NOT EXISTS ocr_mismatch_reason TEXT,
ADD COLUMN IF NOT EXISTS ocr_accepted_via TEXT;

-- Add index for querying validation status
CREATE INDEX IF NOT EXISTS idx_airbnb_baseline_debug_ocr_validation 
ON public.airbnb_baseline_debug(ocr_validation_status) 
WHERE ocr_validation_status IS NOT NULL;

COMMENT ON COLUMN public.airbnb_baseline_debug.ocr_booking_card_amount_raw IS 'Raw OCR text from booking card (e.g. "$2,214")';
COMMENT ON COLUMN public.airbnb_baseline_debug.ocr_booking_card_amount_value IS 'Parsed numeric value from booking card OCR';
COMMENT ON COLUMN public.airbnb_baseline_debug.ocr_booking_card_nights IS 'Number of nights from booking card OCR';
COMMENT ON COLUMN public.airbnb_baseline_debug.ocr_booking_card_snippet IS 'Evidence line from booking card (e.g. "$2,214 for 4 nights")';
COMMENT ON COLUMN public.airbnb_baseline_debug.ocr_breakdown_total_amount_raw IS 'Raw OCR text from breakdown total (e.g. "Total USD $2,213.34")';
COMMENT ON COLUMN public.airbnb_baseline_debug.ocr_breakdown_total_amount_value IS 'Parsed numeric value from breakdown total';
COMMENT ON COLUMN public.airbnb_baseline_debug.ocr_breakdown_total_snippet IS 'Evidence line from breakdown total';
COMMENT ON COLUMN public.airbnb_baseline_debug.ocr_breakdown_taxes_amount_value IS 'Parsed taxes amount from breakdown if available';
COMMENT ON COLUMN public.airbnb_baseline_debug.breakdown_opened IS 'Whether price breakdown modal was successfully opened';
COMMENT ON COLUMN public.airbnb_baseline_debug.ocr_validation_status IS 'Result of OCR validation: accepted, rejected, no_ocr_reference';
COMMENT ON COLUMN public.airbnb_baseline_debug.ocr_mismatch_reason IS 'Reason for rejection (e.g. provider_price_lower_than_visible_price)';
COMMENT ON COLUMN public.airbnb_baseline_debug.ocr_accepted_via IS 'Rule that accepted the price: breakdown_match, equal_baseline, higher_than_baseline';