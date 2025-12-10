-- Add a restrictive INSERT policy on search_results
-- This blocks all client-side inserts while allowing the backend service role to insert
-- (Service role key bypasses RLS, so backend can still insert results)
CREATE POLICY "Only backend service can insert search results"
ON public.search_results
FOR INSERT
WITH CHECK (false);