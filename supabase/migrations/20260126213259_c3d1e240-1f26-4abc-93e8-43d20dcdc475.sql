-- Create signup verification codes table
CREATE TABLE public.signup_verification_codes (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT NOT NULL,
  code TEXT NOT NULL,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  used BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.signup_verification_codes ENABLE ROW LEVEL SECURITY;

-- Only service role can manage these codes
CREATE POLICY "Service role can manage signup codes"
ON public.signup_verification_codes
FOR ALL
USING (((SELECT ((current_setting('request.jwt.claims'::text, true))::json ->> 'role'::text)) = 'service_role'::text))
WITH CHECK (((SELECT ((current_setting('request.jwt.claims'::text, true))::json ->> 'role'::text)) = 'service_role'::text));

-- Index for efficient lookups
CREATE INDEX idx_signup_codes_email ON public.signup_verification_codes(email);
CREATE INDEX idx_signup_codes_expires ON public.signup_verification_codes(expires_at);