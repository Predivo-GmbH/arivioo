-- Create table for persistent rate limiting (bypass password attempts)
CREATE TABLE public.bypass_password_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ip_address TEXT NOT NULL,
    attempted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    was_successful BOOLEAN NOT NULL DEFAULT false,
    user_agent TEXT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Index for efficient IP-based lookups
CREATE INDEX idx_bypass_attempts_ip_time ON public.bypass_password_attempts (ip_address, attempted_at DESC);

-- Index for cleanup of old records
CREATE INDEX idx_bypass_attempts_created ON public.bypass_password_attempts (created_at);

-- Enable RLS
ALTER TABLE public.bypass_password_attempts ENABLE ROW LEVEL SECURITY;

-- No public access - only service role can read/write
-- Service role policies for internal edge function access
CREATE POLICY "Service role can insert attempts" 
ON public.bypass_password_attempts 
FOR INSERT 
TO authenticated, anon
WITH CHECK (false);

CREATE POLICY "Service role can select attempts" 
ON public.bypass_password_attempts 
FOR SELECT 
TO authenticated, anon
USING (false);

-- Allow service role full access (edge functions use service role key)
COMMENT ON TABLE public.bypass_password_attempts IS 'Persistent rate limiting for bypass password. Only accessible via service role in edge functions.';