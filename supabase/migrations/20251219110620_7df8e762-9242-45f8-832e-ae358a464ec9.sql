-- Create platform_adapters table to store adapter configurations
CREATE TABLE public.platform_adapters (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  platform_name TEXT NOT NULL UNIQUE,
  platform_domain TEXT NOT NULL,
  deep_link_template TEXT NOT NULL,
  date_format TEXT NOT NULL DEFAULT 'YYYY-MM-DD',
  requires_occupancy BOOLEAN NOT NULL DEFAULT true,
  occupancy_params JSONB,
  price_selectors JSONB,
  validation_rules JSONB,
  reliability_score DECIMAL(3,2) DEFAULT 0.5,
  is_active BOOLEAN NOT NULL DEFAULT true,
  is_ai_generated BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create price_extractions table to store extracted prices
CREATE TABLE public.price_extractions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  search_result_id UUID REFERENCES public.search_results(id) ON DELETE CASCADE,
  search_id UUID REFERENCES public.searches(id) ON DELETE CASCADE,
  platform_name TEXT NOT NULL,
  deep_link TEXT NOT NULL,
  extracted_price DECIMAL(12,2),
  currency TEXT DEFAULT 'USD',
  price_type TEXT NOT NULL DEFAULT 'UNKNOWN',
  includes_taxes_fees BOOLEAN DEFAULT false,
  occupancy_assumed BOOLEAN DEFAULT true,
  assumed_adults INTEGER DEFAULT 2,
  assumed_children INTEGER DEFAULT 0,
  assumed_rooms INTEGER DEFAULT 1,
  extraction_status TEXT NOT NULL DEFAULT 'pending',
  extraction_error TEXT,
  extraction_metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create blocked_platforms table for platforms that can't be scraped
CREATE TABLE public.blocked_platforms (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  domain TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL,
  blocked_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.platform_adapters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.price_extractions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blocked_platforms ENABLE ROW LEVEL SECURITY;

-- Platform adapters are public read (system-wide config)
CREATE POLICY "Platform adapters are readable by all" 
ON public.platform_adapters 
FOR SELECT 
USING (true);

-- Price extractions follow parent search permissions
CREATE POLICY "Price extractions are viewable by search owner" 
ON public.price_extractions 
FOR SELECT 
USING (EXISTS (
  SELECT 1 FROM public.searches 
  WHERE searches.id = price_extractions.search_id 
  AND searches.user_id = auth.uid()
));

-- Blocked platforms are public read
CREATE POLICY "Blocked platforms are readable by all" 
ON public.blocked_platforms 
FOR SELECT 
USING (true);

-- Add updated_at triggers
CREATE TRIGGER update_platform_adapters_updated_at
BEFORE UPDATE ON public.platform_adapters
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_price_extractions_updated_at
BEFORE UPDATE ON public.price_extractions
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Insert default platform adapters for known booking platforms
INSERT INTO public.platform_adapters (platform_name, platform_domain, deep_link_template, date_format, requires_occupancy, occupancy_params, price_selectors) VALUES
('booking.com', 'booking.com', 'https://www.booking.com/hotel/{property_id}.html?checkin={checkin}&checkout={checkout}&group_adults={adults}&group_children={children}&no_rooms={rooms}', 'YYYY-MM-DD', true, '{"adults_param": "group_adults", "children_param": "group_children", "rooms_param": "no_rooms"}', '{"price": "[data-testid=\"price-and-discounted-price\"]", "total": ".bui-price-display__value"}'),
('expedia.com', 'expedia.com', 'https://www.expedia.com/Hotel-Search?destination={property_id}&startDate={checkin}&endDate={checkout}&adults={adults}&children={children}&rooms={rooms}', 'MM/DD/YYYY', true, '{"adults_param": "adults", "children_param": "children", "rooms_param": "rooms"}', '{"price": "[data-test-id=\"price\"]", "total": ".uitk-type-500"}'),
('hotels.com', 'hotels.com', 'https://www.hotels.com/ho{property_id}/?chkin={checkin}&chkout={checkout}&adults={adults}&children={children}', 'YYYY-MM-DD', true, '{"adults_param": "adults", "children_param": "children"}', '{"price": "[data-test-id=\"price\"]"}'),
('vrbo.com', 'vrbo.com', 'https://www.vrbo.com/{property_id}?arrival={checkin}&departure={checkout}&adults={adults}&children={children}', 'YYYY-MM-DD', true, '{"adults_param": "adults", "children_param": "children"}', '{"price": "[data-stid=\"price-summary\"]"}'),
('agoda.com', 'agoda.com', 'https://www.agoda.com/hotel/{property_id}?checkIn={checkin}&checkOut={checkout}&adults={adults}&children={children}&rooms={rooms}', 'YYYY-MM-DD', true, '{"adults_param": "adults", "children_param": "children", "rooms_param": "rooms"}', '{"price": "[data-element-name=\"final-price\"]"}'),
('tripadvisor.com', 'tripadvisor.com', 'https://www.tripadvisor.com/Hotel-{property_id}?checkin={checkin}&checkout={checkout}&adults={adults}', 'YYYY/MM/DD', true, '{"adults_param": "adults"}', '{"price": ".prw_rup"}'),
('hostelworld.com', 'hostelworld.com', 'https://www.hostelworld.com/st/hostels/p/{property_id}?dateFrom={checkin}&dateTo={checkout}&guests={adults}', 'YYYY-MM-DD', true, '{"adults_param": "guests"}', '{"price": ".price-wrapper"}'),
('hrs.com', 'hrs.com', 'https://www.hrs.com/hotel/{property_id}?arrivalDate={checkin}&departureDate={checkout}&adults={adults}&children={children}', 'YYYY-MM-DD', true, '{"adults_param": "adults", "children_param": "children"}', '{"price": ".rate-price"}'),
('holidaycheck.de', 'holidaycheck.de', 'https://www.holidaycheck.de/hi/{property_id}?checkin={checkin}&checkout={checkout}&adults={adults}&children={children}', 'YYYY-MM-DD', true, '{"adults_param": "adults", "children_param": "children"}', '{"price": ".price-value"}');

-- Insert some known non-booking platforms to block
INSERT INTO public.blocked_platforms (domain, reason) VALUES
('cntraveller.com', 'Travel magazine - no direct booking'),
('afar.com', 'Travel magazine - no direct booking'),
('lonelyplanet.com', 'Travel guide - no direct booking'),
('trivago.com', 'Price comparison aggregator - no direct booking'),
('kayak.com', 'Price comparison aggregator - no direct booking'),
('skyscanner.com', 'Price comparison aggregator - no direct booking'),
('google.com/travel', 'Search aggregator - no direct booking'),
('yelp.com', 'Review site - no direct booking'),
('zillow.com', 'Real estate - not vacation rental'),
('trulia.com', 'Real estate - not vacation rental'),
('redfin.com', 'Real estate - not vacation rental'),
('realtor.com', 'Real estate - not vacation rental'),
('pinterest.com', 'Social media - no direct booking'),
('instagram.com', 'Social media - no direct booking'),
('facebook.com', 'Social media - no direct booking'),
('twitter.com', 'Social media - no direct booking'),
('youtube.com', 'Video platform - no direct booking');