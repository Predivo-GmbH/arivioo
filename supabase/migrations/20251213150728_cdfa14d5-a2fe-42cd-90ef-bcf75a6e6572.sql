-- Drop the overly restrictive INSERT policy that blocks all insertions
DROP POLICY IF EXISTS "Only backend service can insert search results" ON public.search_results;

-- The service role key used by edge functions bypasses RLS entirely,
-- so we don't need an explicit INSERT policy. Users cannot insert directly
-- because there's no permissive INSERT policy for authenticated users.