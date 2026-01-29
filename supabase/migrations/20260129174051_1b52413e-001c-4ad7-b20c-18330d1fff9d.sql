-- Enable realtime for price_extractions table so frontend can receive live updates
ALTER PUBLICATION supabase_realtime ADD TABLE public.price_extractions;