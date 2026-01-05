-- Create table for persistent admin login attempt tracking
CREATE TABLE IF NOT EXISTS public.admin_login_attempts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  ip_address TEXT NOT NULL,
  attempted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  was_successful BOOLEAN NOT NULL DEFAULT false,
  email_attempted TEXT,
  user_agent TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create indexes for efficient rate limit queries
CREATE INDEX idx_admin_login_attempts_ip_time ON admin_login_attempts(ip_address, attempted_at DESC);
CREATE INDEX idx_admin_login_attempts_email_time ON admin_login_attempts(email_attempted, attempted_at DESC);

-- Enable RLS
ALTER TABLE public.admin_login_attempts ENABLE ROW LEVEL SECURITY;

-- No SELECT policy for regular users - only service role can access
-- This table is only accessed by edge functions using service role key

-- Add comment for documentation
COMMENT ON TABLE public.admin_login_attempts IS 'Tracks admin login attempts for persistent rate limiting. Only accessible via service role.';