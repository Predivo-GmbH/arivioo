-- Block all client-side inserts (only service role via edge function should insert)
CREATE POLICY "Prevent direct inserts to search results"
ON public.search_results FOR INSERT
WITH CHECK (false);

-- Block all updates (results should be immutable)
CREATE POLICY "Prevent updates to search results"
ON public.search_results FOR UPDATE
USING (false);

-- Allow users to delete results of their own searches
CREATE POLICY "Users can delete results of their own searches"
ON public.search_results FOR DELETE
USING (
  EXISTS (
    SELECT 1 FROM public.searches 
    WHERE searches.id = search_results.search_id 
    AND searches.user_id = auth.uid()
  )
);