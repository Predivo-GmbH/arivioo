import { useState, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { Json } from '@/integrations/supabase/types';

/**
 * Persisted final snapshot structure
 * Contains all data needed for deterministic UI rendering
 */
export interface FinalResultRow {
  id: string;
  platform_name: string;
  listing_url: string;
  listing_title: string | null;
  price: number | null;
  original_price: number | null;
  savings_amount: number | null;
  savings_percentage: number | null;
  confidence_score: number | null;
  image_url: string | null;
  images: Json;
  match_type?: string;
  source_airbnb_image?: string | null;
  price_check_in?: string | null;
  price_check_out?: string | null;
  dates_differ?: boolean;
  // Categorization data
  coverage_tier?: 'A' | 'B' | 'C' | null;
  is_tier_c_blocked?: boolean;
  extraction_status?: string | null;
  extraction_error?: string | null;
  outcome_category?: string | null;
  outcome_label?: string | null;
  // Canonical price model
  canonical_price?: Record<string, unknown> | null;
  price_type?: string;
  price_type_label?: string;
  is_total_price?: boolean;
  // Bucket categorization
  result_bucket?: string | null;
  relative_position?: string | null;
  savings_computed?: number | null;
}

export interface FinalSnapshot {
  version: number;
  generated_at: string;
  search_id: string;
  results: FinalResultRow[];
}

interface UseFinalizedSnapshotResult {
  /**
   * Fetch the finalized snapshot with bounded retry + timeout.
   * Returns null if not yet finalized or on failure.
   */
  fetchFinalizedSnapshot: (searchId: string) => Promise<FinalSnapshot | null>;
  
  /**
   * Check if a search is finalized (has finalised_at set)
   */
  isSearchFinalized: (searchId: string) => Promise<{ finalized: boolean; finalisedAt: string | null }>;
  
  /**
   * Loading state
   */
  isLoading: boolean;
  
  /**
   * Error state (set after all retries exhausted)
   */
  error: string | null;
  
  /**
   * Retry count for UI feedback
   */
  retryCount: number;
}

const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 8000;
const TOTAL_TIMEOUT_MS = 30000;

export function useFinalizedSnapshot(): UseFinalizedSnapshotResult {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  const isSearchFinalized = useCallback(async (searchId: string): Promise<{ finalized: boolean; finalisedAt: string | null }> => {
    try {
      const { data, error: queryError } = await supabase
        .from('searches')
        .select('finalised_at')
        .eq('id', searchId)
        .single();

      if (queryError || !data) {
        console.error('[FinalizedSnapshot] Failed to check finalization:', queryError);
        return { finalized: false, finalisedAt: null };
      }

      const finalisedAt = (data as any).finalised_at as string | null;
      return { finalized: !!finalisedAt, finalisedAt };
    } catch (e) {
      console.error('[FinalizedSnapshot] isSearchFinalized error:', e);
      return { finalized: false, finalisedAt: null };
    }
  }, []);

  const fetchFinalizedSnapshot = useCallback(async (searchId: string): Promise<FinalSnapshot | null> => {
    // Abort any previous request
    abortControllerRef.current?.abort();
    abortControllerRef.current = new AbortController();
    
    setIsLoading(true);
    setError(null);
    setRetryCount(0);

    const startTime = Date.now();
    let attempt = 0;
    let backoffMs = INITIAL_BACKOFF_MS;

    while (attempt < MAX_RETRIES) {
      // Check total timeout
      if (Date.now() - startTime > TOTAL_TIMEOUT_MS) {
        console.error('[FinalizedSnapshot] Total timeout exceeded');
        setError('Loading took too long. Please try again.');
        setIsLoading(false);
        return null;
      }

      attempt++;
      setRetryCount(attempt);

      try {
        console.log(`[FinalizedSnapshot] Attempt ${attempt}/${MAX_RETRIES} for search ${searchId}`);

        const { data, error: queryError } = await supabase
          .from('searches')
          .select('finalised_at, final_results_snapshot')
          .eq('id', searchId)
          .single();

        if (queryError) {
          throw new Error(`Database error: ${queryError.message}`);
        }

        if (!data) {
          throw new Error('Search not found');
        }

        // Type cast to access new columns
        const searchData = data as any;
        const finalisedAt = searchData.finalised_at as string | null;
        const snapshot = searchData.final_results_snapshot as FinalSnapshot | null;

        // Not yet finalized - this is expected during pipeline execution
        if (!finalisedAt) {
          console.log('[FinalizedSnapshot] Search not yet finalized, waiting...');
          
          // Wait with backoff before next attempt
          await new Promise(resolve => setTimeout(resolve, backoffMs));
          backoffMs = Math.min(backoffMs * 1.5, MAX_BACKOFF_MS);
          continue;
        }

        // Finalized but no snapshot (legacy search without snapshot persistence)
        if (!snapshot) {
          console.warn('[FinalizedSnapshot] Finalized but no snapshot - falling back to live fetch');
          setIsLoading(false);
          return null; // Caller should fall back to fetchEnrichedResults
        }

        console.log(`[FinalizedSnapshot] Successfully loaded snapshot with ${snapshot.results?.length || 0} results`);
        setIsLoading(false);
        return snapshot;

      } catch (e) {
        console.error(`[FinalizedSnapshot] Attempt ${attempt} failed:`, e);
        
        if (attempt >= MAX_RETRIES) {
          const errorMsg = e instanceof Error ? e.message : 'Unknown error';
          setError(`Failed to load results: ${errorMsg}`);
          setIsLoading(false);
          return null;
        }

        // Wait with backoff before next attempt
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        backoffMs = Math.min(backoffMs * 1.5, MAX_BACKOFF_MS);
      }
    }

    setError('Maximum retries exceeded. Please refresh the page.');
    setIsLoading(false);
    return null;
  }, []);

  return {
    fetchFinalizedSnapshot,
    isSearchFinalized,
    isLoading,
    error,
    retryCount,
  };
}
