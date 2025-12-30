-- Create table for storing confirmed Airbnb trip totals
CREATE TABLE public.airbnb_confirmed_totals (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  search_id UUID REFERENCES public.searches(id) ON DELETE CASCADE,
  run_id TEXT, -- For diagnostic test runs
  confirmed_total_amount NUMERIC NOT NULL,
  confirmed_currency TEXT NOT NULL DEFAULT 'USD',
  subtotal_nights_only NUMERIC, -- The scraped subtotal for context
  subtotal_nights_count INTEGER,
  confirmed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  confirmed_by UUID, -- User ID if user confirmation
  confirmation_source TEXT NOT NULL DEFAULT 'user' CHECK (confirmation_source IN ('user', 'diagnostic_test', 'automated')),
  confirmation_note TEXT,
  confirmation_text TEXT, -- Pasted "Total ..." line
  confirmation_attachment_url TEXT, -- Screenshot URL
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT unique_search_confirmation UNIQUE (search_id),
  CONSTRAINT unique_run_confirmation UNIQUE (run_id)
);

-- Enable RLS
ALTER TABLE public.airbnb_confirmed_totals ENABLE ROW LEVEL SECURITY;

-- Users can view their own confirmed totals (via search ownership)
CREATE POLICY "Users can view own confirmed totals"
ON public.airbnb_confirmed_totals
FOR SELECT
USING (
  search_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM searches 
    WHERE searches.id = airbnb_confirmed_totals.search_id 
    AND searches.user_id = auth.uid()
  )
);

-- Users can insert their own confirmations
CREATE POLICY "Users can insert own confirmations"
ON public.airbnb_confirmed_totals
FOR INSERT
WITH CHECK (
  search_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM searches 
    WHERE searches.id = airbnb_confirmed_totals.search_id 
    AND searches.user_id = auth.uid()
  )
);

-- Users can update their own confirmations
CREATE POLICY "Users can update own confirmations"
ON public.airbnb_confirmed_totals
FOR UPDATE
USING (
  search_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM searches 
    WHERE searches.id = airbnb_confirmed_totals.search_id 
    AND searches.user_id = auth.uid()
  )
);

-- Users can delete their own confirmations
CREATE POLICY "Users can delete own confirmations"
ON public.airbnb_confirmed_totals
FOR DELETE
USING (
  search_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM searches 
    WHERE searches.id = airbnb_confirmed_totals.search_id 
    AND searches.user_id = auth.uid()
  )
);

-- Service role can manage all confirmations (for diagnostics)
CREATE POLICY "Service role can manage all confirmations"
ON public.airbnb_confirmed_totals
FOR ALL
USING (true)
WITH CHECK (true);

-- Create trigger for updated_at
CREATE TRIGGER update_airbnb_confirmed_totals_updated_at
BEFORE UPDATE ON public.airbnb_confirmed_totals
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();