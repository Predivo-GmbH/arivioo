-- Remove the public read policy on api_providers table
DROP POLICY IF EXISTS "API providers are readable" ON public.api_providers;