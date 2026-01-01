-- Drop the blanket denial policy
DROP POLICY IF EXISTS "No public access to notify_me_registrations" ON notify_me_registrations;

-- Allow users to view their own notification registrations (via search ownership)
CREATE POLICY "Users can view own notifications"
ON notify_me_registrations FOR SELECT
USING (
  search_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM searches 
    WHERE searches.id = notify_me_registrations.search_id 
    AND searches.user_id = auth.uid()
  )
);

-- Allow users to update their own notification settings (price threshold, is_active)
CREATE POLICY "Users can update own notification settings"
ON notify_me_registrations FOR UPDATE
USING (
  search_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM searches 
    WHERE searches.id = notify_me_registrations.search_id 
    AND searches.user_id = auth.uid()
  )
)
WITH CHECK (
  search_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM searches 
    WHERE searches.id = notify_me_registrations.search_id 
    AND searches.user_id = auth.uid()
  )
);

-- Allow users to delete/unsubscribe their own notifications
CREATE POLICY "Users can delete own notifications"
ON notify_me_registrations FOR DELETE
USING (
  search_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM searches 
    WHERE searches.id = notify_me_registrations.search_id 
    AND searches.user_id = auth.uid()
  )
);