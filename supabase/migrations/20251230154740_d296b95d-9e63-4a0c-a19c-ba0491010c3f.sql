-- Add OCR validation columns to searches table for Airbnb baseline verification
ALTER TABLE public.searches
ADD COLUMN IF NOT EXISTS ocr_booking_card_amount numeric NULL,
ADD COLUMN IF NOT EXISTS ocr_booking_card_nights integer NULL,
ADD COLUMN IF NOT EXISTS ocr_breakdown_total_amount numeric NULL,
ADD COLUMN IF NOT EXISTS ocr_validation_status text NULL,
ADD COLUMN IF NOT EXISTS ocr_accepted_via text NULL,
ADD COLUMN IF NOT EXISTS ocr_mismatch_reason text NULL;

-- Add comment explaining OCR fields
COMMENT ON COLUMN public.searches.ocr_booking_card_amount IS 'OCR-extracted booking card subtotal (e.g. "$2,214 for 4 nights")';
COMMENT ON COLUMN public.searches.ocr_booking_card_nights IS 'Number of nights shown on booking card';
COMMENT ON COLUMN public.searches.ocr_breakdown_total_amount IS 'OCR-extracted breakdown total (e.g. "Total USD $2,213.34")';
COMMENT ON COLUMN public.searches.ocr_validation_status IS 'OCR validation result: accepted, rejected, no_ocr_data';
COMMENT ON COLUMN public.searches.ocr_accepted_via IS 'How OCR accepted the price: breakdown_total_match, equal_to_baseline, higher_than_baseline_includes_fees';
COMMENT ON COLUMN public.searches.ocr_mismatch_reason IS 'Reason for OCR rejection if status is rejected';