-- Fix: Restrict api_quota_snapshots to service role only (was publicly readable)
-- Drop the overly permissive policy
DROP POLICY IF EXISTS "Quota snapshots are readable" ON public.api_quota_snapshots;

-- Create a restrictive policy for service role only
CREATE POLICY "Service role can read quota snapshots" 
ON public.api_quota_snapshots 
FOR SELECT 
USING (
  (SELECT (current_setting('request.jwt.claims'::text, true)::json ->> 'role')) = 'service_role'
);

-- Fix: Protect notify_me_registrations records without search_id
-- First, drop existing SELECT policy
DROP POLICY IF EXISTS "Users can view own notifications" ON public.notify_me_registrations;

-- Create a more secure policy that requires authentication and properly handles null search_id
CREATE POLICY "Users can view own notifications" 
ON public.notify_me_registrations 
FOR SELECT 
USING (
  -- Must be authenticated
  auth.uid() IS NOT NULL
  AND (
    -- Case 1: Has search_id - verify ownership through searches table
    (search_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM searches 
      WHERE searches.id = notify_me_registrations.search_id 
      AND searches.user_id = auth.uid()
    ))
    -- Case 2: No search_id - service role only (edge functions) 
    OR (search_id IS NULL AND (SELECT (current_setting('request.jwt.claims'::text, true)::json ->> 'role')) = 'service_role')
  )
);

-- Also update DELETE policy to be consistent
DROP POLICY IF EXISTS "Users can delete own notifications" ON public.notify_me_registrations;

CREATE POLICY "Users can delete own notifications" 
ON public.notify_me_registrations 
FOR DELETE 
USING (
  auth.uid() IS NOT NULL
  AND (
    (search_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM searches 
      WHERE searches.id = notify_me_registrations.search_id 
      AND searches.user_id = auth.uid()
    ))
    OR (search_id IS NULL AND (SELECT (current_setting('request.jwt.claims'::text, true)::json ->> 'role')) = 'service_role')
  )
);

-- Update UPDATE policy as well
DROP POLICY IF EXISTS "Users can update own notification settings" ON public.notify_me_registrations;

CREATE POLICY "Users can update own notification settings" 
ON public.notify_me_registrations 
FOR UPDATE 
USING (
  auth.uid() IS NOT NULL
  AND (
    (search_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM searches 
      WHERE searches.id = notify_me_registrations.search_id 
      AND searches.user_id = auth.uid()
    ))
    OR (search_id IS NULL AND (SELECT (current_setting('request.jwt.claims'::text, true)::json ->> 'role')) = 'service_role')
  )
)
WITH CHECK (
  auth.uid() IS NOT NULL
  AND (
    (search_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM searches 
      WHERE searches.id = notify_me_registrations.search_id 
      AND searches.user_id = auth.uid()
    ))
    OR (search_id IS NULL AND (SELECT (current_setting('request.jwt.claims'::text, true)::json ->> 'role')) = 'service_role')
  )
);