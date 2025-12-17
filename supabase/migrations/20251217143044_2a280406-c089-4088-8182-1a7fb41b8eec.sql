-- Create table for launch notification email signups
CREATE TABLE public.launch_signups (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable Row Level Security
ALTER TABLE public.launch_signups ENABLE ROW LEVEL SECURITY;

-- Allow anonymous inserts (for email signup)
CREATE POLICY "Anyone can sign up for launch notifications" 
ON public.launch_signups 
FOR INSERT 
WITH CHECK (true);

-- Prevent public reads (admin only via service role)
CREATE POLICY "No public read access" 
ON public.launch_signups 
FOR SELECT 
USING (false);