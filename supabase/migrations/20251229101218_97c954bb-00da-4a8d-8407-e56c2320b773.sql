-- Revoke direct public INSERT on launch_signups
-- Signups now go through the submit-launch-signup edge function with rate limiting
DROP POLICY IF EXISTS "Anyone can sign up for launch notifications" ON public.launch_signups;