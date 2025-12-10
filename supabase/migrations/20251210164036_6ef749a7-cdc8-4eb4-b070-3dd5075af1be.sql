-- Fix profiles table: Convert all RESTRICTIVE policies to PERMISSIVE
DROP POLICY IF EXISTS "Users can view their own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can insert their own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can update their own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can delete their own profile" ON public.profiles;

CREATE POLICY "Users can view their own profile" ON public.profiles AS PERMISSIVE FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert their own profile" ON public.profiles AS PERMISSIVE FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update their own profile" ON public.profiles AS PERMISSIVE FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete their own profile" ON public.profiles AS PERMISSIVE FOR DELETE USING (auth.uid() = user_id);

-- Fix searches table: Convert all RESTRICTIVE policies to PERMISSIVE and add DELETE
DROP POLICY IF EXISTS "Users can view their own searches" ON public.searches;
DROP POLICY IF EXISTS "Users can insert their own searches" ON public.searches;
DROP POLICY IF EXISTS "Users can update their own searches" ON public.searches;

CREATE POLICY "Users can view their own searches" ON public.searches AS PERMISSIVE FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert their own searches" ON public.searches AS PERMISSIVE FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update their own searches" ON public.searches AS PERMISSIVE FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete their own searches" ON public.searches AS PERMISSIVE FOR DELETE USING (auth.uid() = user_id);

-- Fix search_results table: Convert SELECT to PERMISSIVE (INSERT stays restrictive for backend-only)
DROP POLICY IF EXISTS "Users can view results of their own searches" ON public.search_results;
DROP POLICY IF EXISTS "Only backend service can insert search results" ON public.search_results;

CREATE POLICY "Users can view results of their own searches" ON public.search_results AS PERMISSIVE FOR SELECT USING (EXISTS (SELECT 1 FROM searches WHERE searches.id = search_results.search_id AND searches.user_id = auth.uid()));
CREATE POLICY "Only backend service can insert search results" ON public.search_results AS RESTRICTIVE FOR INSERT WITH CHECK (false);