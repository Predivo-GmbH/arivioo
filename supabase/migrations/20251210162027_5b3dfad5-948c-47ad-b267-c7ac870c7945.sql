-- Drop the existing RESTRICTIVE DELETE policy
DROP POLICY IF EXISTS "Users can delete their own profile" ON public.profiles;

-- Recreate as PERMISSIVE policy so users can delete their own profile
CREATE POLICY "Users can delete their own profile"
ON public.profiles
AS PERMISSIVE
FOR DELETE
USING (auth.uid() = user_id);