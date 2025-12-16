import { useCallback, useEffect, useRef, useState } from "react";
import type { Json } from "@/integrations/supabase/types";
import { supabase } from "@/integrations/supabase/client";

interface SearchResult {
  platform_name: string;
  price: number | null;
  confidence_score: number | null;
  image_url: string | null;
  source_airbnb_image?: string | null;
}

interface SuccessfulSearch {
  // Note: id and specific dates are intentionally omitted for privacy
  // This data is displayed publicly on the homepage demo
  airbnb_title: string | null;
  airbnb_price: number | null;
  airbnb_image_url: string | null;
  airbnb_images: Json;
  nights_count: number | null;
  cheapestResult: SearchResult | null;
  potentialSavings: number | null;
  savingsPercentage: number | null;
}

type UseLastSuccessfulSearchOptions = {
  /** How often to refresh (in ms). 0 disables polling. */
  refreshIntervalMs?: number;
};

export function useLastSuccessfulSearch(options: UseLastSuccessfulSearchOptions = {}) {
  const { refreshIntervalMs = 15_000 } = options;

  const [data, setData] = useState<SuccessfulSearch | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  const fetchLastSuccessfulSearch = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;

    try {
      const { data: result, error: fnError } = await supabase.functions.invoke("get-last-success", {
        body: {},
      });

      if (fnError) throw fnError;

      if (result?.success && result.data) {
        setData(result.data as SuccessfulSearch);
      } else {
        setData(null);
      }

      setError(null);
      setLoading(false);
    } catch (err) {
      console.error("Error fetching last successful search:", err);
      setError(err instanceof Error ? err.message : "Failed to fetch");
      setLoading(false);
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    fetchLastSuccessfulSearch();

    const onVisibility = () => {
      if (document.visibilityState === "visible") fetchLastSuccessfulSearch();
    };
    document.addEventListener("visibilitychange", onVisibility);

    let intervalId: number | undefined;
    if (refreshIntervalMs > 0) {
      intervalId = window.setInterval(fetchLastSuccessfulSearch, refreshIntervalMs);
    }

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      if (intervalId) window.clearInterval(intervalId);
    };
  }, [fetchLastSuccessfulSearch, refreshIntervalMs]);

  return { data, loading, error, refetch: fetchLastSuccessfulSearch };
}

