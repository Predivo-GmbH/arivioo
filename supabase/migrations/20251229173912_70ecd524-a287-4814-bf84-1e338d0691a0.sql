-- Add ScrapingBee as an API provider with 1000 credit limit
INSERT INTO public.api_providers (
  name,
  display_name,
  auth_secret_name,
  plan_type,
  plan_limit,
  cost_per_request,
  is_active,
  supports_quota_api
) VALUES (
  'scrapingbee',
  'ScrapingBee',
  'SCRAPINGBEE_API_KEY',
  'monthly',
  1000,
  1,
  true,
  false
);