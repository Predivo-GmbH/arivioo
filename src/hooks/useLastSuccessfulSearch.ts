import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { Json } from '@/integrations/supabase/types';

interface SearchResult {
  id: string;
  platform_name: string;
  listing_url: string;
  listing_title: string | null;
  price: number | null;
  confidence_score: number | null;
  image_url: string | null;
  images: Json;
  match_type?: string;
  source_airbnb_image?: string | null;
  savings_percentage?: number | null;
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
  results: SearchResult[];
  cheapestResult: SearchResult | null;
  potentialSavings: number | null;
  savingsPercentage: number | null;
}

// Convert JSON to string array
const toStringArray = (json: Json | null | undefined): string[] => {
  if (!json) return [];
  if (Array.isArray(json)) {
    return json.filter((item): item is string => typeof item === 'string');
  }
  return [];
};

export function useLastSuccessfulSearch() {
  const [data, setData] = useState<SuccessfulSearch | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchLastSuccessfulSearch = async () => {
      try {
        // Find the most recent successful search with visual matches (≥90% confidence)
        const { data: searches, error: searchError } = await supabase
          .from('searches')
          .select('*')
          .eq('status', 'completed')
          .not('airbnb_price', 'is', null)
          .order('created_at', { ascending: false })
          .limit(10);

        if (searchError) throw searchError;

        // Find a search that has good visual matches
        for (const search of searches || []) {
          const { data: results, error: resultsError } = await supabase
            .from('search_results')
            .select('*')
            .eq('search_id', search.id)
            .eq('match_type', 'visual')
            .gte('confidence_score', 0.90) // Only ≥90% confidence
            .not('price', 'is', null)
            .order('price', { ascending: true });

          if (resultsError) continue;

          // Need at least one valid visual match with price
          if (results && results.length > 0) {
            const cheapestResult = results[0] as SearchResult;
            const airbnbTotal = search.airbnb_price && search.nights_count 
              ? search.airbnb_price * search.nights_count 
              : null;
            const cheapestTotal = cheapestResult.price && search.nights_count
              ? cheapestResult.price * search.nights_count
              : null;
            
            // Add service fee estimate (14%)
            const airbnbWithFees = airbnbTotal ? airbnbTotal * 1.14 : null;
            
            const potentialSavings = airbnbWithFees && cheapestTotal 
              ? Math.round(airbnbWithFees - cheapestTotal)
              : null;
            const savingsPercentage = airbnbWithFees && potentialSavings && potentialSavings > 0
              ? Math.round((potentialSavings / airbnbWithFees) * 100)
              : null;

            // Only use if there are actual savings
            if (potentialSavings && potentialSavings > 0) {
              setData({
                id: search.id,
                airbnb_title: search.airbnb_title,
                airbnb_price: search.airbnb_price,
                airbnb_image_url: search.airbnb_image_url,
                airbnb_images: search.airbnb_images,
                check_in_date: search.check_in_date,
                check_out_date: search.check_out_date,
                nights_count: search.nights_count,
                results: results as SearchResult[],
                cheapestResult,
                potentialSavings,
                savingsPercentage,
              });
              setLoading(false);
              return;
            }
          }
        }

        // No successful search with savings found
        setData(null);
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
