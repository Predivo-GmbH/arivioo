-- Create notify_me_registrations table for tracking users awaiting notifications
CREATE TABLE public.notify_me_registrations (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT NOT NULL,
  email_hash TEXT GENERATED ALWAYS AS (encode(sha256(lower(email)::bytea), 'hex')) STORED,
  source_airbnb_url TEXT,
  source_airbnb_title TEXT,
  source_airbnb_price NUMERIC,
  search_id UUID REFERENCES public.searches(id) ON DELETE SET NULL,
  notification_status TEXT NOT NULL DEFAULT 'pending' CHECK (notification_status IN ('pending', 'sent', 'failed', 'disabled')),
  last_notified_at TIMESTAMP WITH TIME ZONE,
  notification_count INTEGER NOT NULL DEFAULT 0,
  last_notification_error TEXT,
  price_threshold_percentage NUMERIC DEFAULT 10,
  is_active BOOLEAN NOT NULL DEFAULT true,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create index for efficient lookups
CREATE INDEX idx_notify_me_email_hash ON public.notify_me_registrations(email_hash);
CREATE INDEX idx_notify_me_status ON public.notify_me_registrations(notification_status);
CREATE INDEX idx_notify_me_search ON public.notify_me_registrations(search_id);
CREATE INDEX idx_notify_me_created ON public.notify_me_registrations(created_at DESC);

-- Enable RLS
ALTER TABLE public.notify_me_registrations ENABLE ROW LEVEL SECURITY;

-- Block all public access - only accessible via service role
CREATE POLICY "No public access to notify_me_registrations"
ON public.notify_me_registrations
FOR ALL
USING (false);

-- Create trigger to update updated_at
CREATE TRIGGER update_notify_me_registrations_updated_at
BEFORE UPDATE ON public.notify_me_registrations
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Create notification_events table to track notification history
CREATE TABLE public.notification_events (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  registration_id UUID NOT NULL REFERENCES public.notify_me_registrations(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('registered', 'search_triggered', 'extraction_completed', 'price_found', 'notification_sent', 'notification_failed', 'user_disabled')),
  search_id UUID REFERENCES public.searches(id) ON DELETE SET NULL,
  extraction_id UUID REFERENCES public.price_extractions(id) ON DELETE SET NULL,
  platform_name TEXT,
  extracted_price NUMERIC,
  savings_amount NUMERIC,
  error_message TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create indexes for notification_events
CREATE INDEX idx_notification_events_registration ON public.notification_events(registration_id);
CREATE INDEX idx_notification_events_type ON public.notification_events(event_type);
CREATE INDEX idx_notification_events_created ON public.notification_events(created_at DESC);

-- Enable RLS on notification_events
ALTER TABLE public.notification_events ENABLE ROW LEVEL SECURITY;

-- Block all public access
CREATE POLICY "No public access to notification_events"
ON public.notification_events
FOR ALL
USING (false);

-- Add notify_me_registration_id to price_extractions for attribution
ALTER TABLE public.price_extractions 
ADD COLUMN IF NOT EXISTS notify_me_registration_id UUID REFERENCES public.notify_me_registrations(id) ON DELETE SET NULL;

-- Add notify_me_registration_id to api_request_logs for cost attribution
ALTER TABLE public.api_request_logs
ADD COLUMN IF NOT EXISTS notify_me_registration_id UUID REFERENCES public.notify_me_registrations(id) ON DELETE SET NULL;

-- Create index for notify_me attribution lookups
CREATE INDEX idx_price_extractions_notify_me ON public.price_extractions(notify_me_registration_id) WHERE notify_me_registration_id IS NOT NULL;
CREATE INDEX idx_api_request_logs_notify_me ON public.api_request_logs(notify_me_registration_id) WHERE notify_me_registration_id IS NOT NULL;