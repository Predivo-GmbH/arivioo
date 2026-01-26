-- Create table for password reset codes
CREATE TABLE public.password_reset_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  code TEXT NOT NULL,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  used BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Index for fast lookup by email and code
CREATE INDEX idx_password_reset_codes_email ON public.password_reset_codes(email);
CREATE INDEX idx_password_reset_codes_lookup ON public.password_reset_codes(email, code) WHERE used = false;

-- Enable RLS
ALTER TABLE public.password_reset_codes ENABLE ROW LEVEL SECURITY;

-- Only service role can access (edge functions use service role)
CREATE POLICY "Service role can manage reset codes"
ON public.password_reset_codes
FOR ALL
USING ((SELECT ((current_setting('request.jwt.claims'::text, true))::json ->> 'role'::text)) = 'service_role')
WITH CHECK ((SELECT ((current_setting('request.jwt.claims'::text, true))::json ->> 'role'::text)) = 'service_role');

-- Auto-cleanup old codes (optional: create a cron job or let them accumulate)
-- Codes older than 24 hours can be cleaned up periodically