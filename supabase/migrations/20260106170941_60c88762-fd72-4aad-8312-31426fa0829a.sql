-- Add explicit restrictive SELECT policy for admin_login_attempts table
-- This ensures no public access to sensitive authentication data
CREATE POLICY "No public access to login attempts"
ON public.admin_login_attempts
FOR SELECT
USING (false);