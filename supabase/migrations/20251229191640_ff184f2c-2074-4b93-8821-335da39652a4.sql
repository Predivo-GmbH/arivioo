-- Add currency column to searches table to store the detected currency from Airbnb
ALTER TABLE public.searches 
ADD COLUMN airbnb_currency TEXT DEFAULT 'USD';