import { useState, useEffect } from 'react';
import type { Json } from '@/integrations/supabase/types';

interface SearchResult {
  platform_name: string;
  price: number | null;
  confidence_score: number | null;
  image_url: string | null;
  source_airbnb_image?: string | null;
}

interface SuccessfulSearch {
  id: string;
  airbnb_title: string | null;
  airbnb_price: number | null;
  airbnb_image_url: string | null;
  airbnb_images: Json;
  check_in_date: string | null;
  check_out_date: string | null;
  nights_count: number | null;
  cheapestResult: SearchResult | null;
  potentialSavings: number | null;
  savingsPercentage: number | null;
}

export function useLastSuccessfulSearch() {
  const [data, setData] = useState<SuccessfulSearch | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchLastSuccessfulSearch = async () => {
      try {
        // Use edge function to bypass RLS and get global last successful search
        const response = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/get-last-success`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "apikey": import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
            },
          }
        );

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const result = await response.json();

        if (result.success && result.data) {
          setData(result.data as SuccessfulSearch);
        } else {
          setData(null);
        }
        setLoading(false);
      } catch (err) {
        console.error('Error fetching last successful search:', err);
        setError(err instanceof Error ? err.message : 'Failed to fetch');
        setLoading(false);
      }
    };

    fetchLastSuccessfulSearch();
  }, []);

  return { data, loading, error };
}
