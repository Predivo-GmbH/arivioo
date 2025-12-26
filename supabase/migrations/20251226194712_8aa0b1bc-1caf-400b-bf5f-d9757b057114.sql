-- Add explicit SELECT blocking policy to api_providers table
CREATE POLICY "No public read access to api_providers"
ON public.api_providers
FOR SELECT
USING (false);