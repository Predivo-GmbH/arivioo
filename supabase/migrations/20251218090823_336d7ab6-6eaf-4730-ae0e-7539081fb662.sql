-- Add opt-in flag for public demo rendering
ALTER TABLE public.searches
ADD COLUMN IF NOT EXISTS public_demo_ok boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_searches_public_demo_ok_created_at
ON public.searches (public_demo_ok, created_at DESC);

-- Create access_grants table to replace client-side localStorage gate
CREATE TABLE IF NOT EXISTS public.access_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  granted_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.access_grants ENABLE ROW LEVEL SECURITY;

-- Users can view only their own currently-valid grant
DROP POLICY IF EXISTS "Users can view their own access grant" ON public.access_grants;
CREATE POLICY "Users can view their own access grant"
ON public.access_grants
FOR SELECT
USING (auth.uid() = user_id AND granted_until > now());

-- Prevent client-side inserts/updates/deletes (must be done via backend function after password verification)
DROP POLICY IF EXISTS "Prevent inserts to access grants" ON public.access_grants;
CREATE POLICY "Prevent inserts to access grants"
ON public.access_grants
FOR INSERT
WITH CHECK (false);

DROP POLICY IF EXISTS "Prevent updates to access grants" ON public.access_grants;
CREATE POLICY "Prevent updates to access grants"
ON public.access_grants
FOR UPDATE
USING (false);

DROP POLICY IF EXISTS "Prevent deletes to access grants" ON public.access_grants;
CREATE POLICY "Prevent deletes to access grants"
ON public.access_grants
FOR DELETE
USING (false);

-- Trigger for updated_at
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'set_access_grants_updated_at'
  ) THEN
    CREATE TRIGGER set_access_grants_updated_at
    BEFORE UPDATE ON public.access_grants
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();
  END IF;
END $$;