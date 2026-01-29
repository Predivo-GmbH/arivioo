import { useEffect, useState, useRef, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';

/**
 * Extraction Progress Realtime Hook
 * 
 * Provides live updates for price extraction progress using:
 * 1. Supabase Realtime subscription (primary - instant updates)
 * 2. Fallback polling (every 3s) when realtime fails
 * 
 * This ensures the UI NEVER gets stuck showing stale progress.
 */

export interface ExtractionProgress {
  id: string;
  platform_name: string;
  extraction_status: string | null;
  extracted_price: number | null;
  currency: string | null;
  tier_a_state: string | null;
  tier_a_attempt_count: number | null;
  updated_at: string;
}

export interface ProgressCounts {
  total: number;
  completed: number;
  running: number;
  retrying: number;
  skipped: number;
  failed: number;
}

interface UseExtractionProgressRealtimeOptions {
  searchId: string | undefined;
  enabled: boolean;
  onProgressUpdate?: (extractions: ExtractionProgress[]) => void;
}

// Canonical status classifications
const SUCCESS_STATUSES = new Set([
  'success', 
  'success_total_stay', 
  'price_extracted', 
  'completed',
  'dates_unavailable',
  'sold_out',
  'unavailable_for_dates',
]);

const RUNNING_STATUSES = new Set([
  'pending', 
  'queued', 
  'running', 
  'in_progress', 
  'started',
]);

const SKIPPED_STATUSES = new Set([
  'service_error',
  'timeout',
  'stalled_timeout',
  'platform_unsupported',
]);

const FAILED_STATUSES = new Set([
  'blocked',
  'captcha',
  'bot_detected',
  'rate_limited',
  'error',
  'render_failed',
]);

export function calculateProgressCounts(extractions: ExtractionProgress[]): ProgressCounts {
  const counts: ProgressCounts = {
    total: extractions.length,
    completed: 0,
    running: 0,
    retrying: 0,
    skipped: 0,
    failed: 0,
  };

  for (const e of extractions) {
    const status = (e.extraction_status || '').toLowerCase();
    const tierState = (e.tier_a_state || '').toLowerCase();
    const hasPrice = e.extracted_price && e.extracted_price > 0;

    // Success: has terminal success status or has a price
    if (SUCCESS_STATUSES.has(status) || hasPrice) {
      counts.completed++;
      continue;
    }

    // Retrying: tier A pending_retry or running retry
    if (tierState === 'pending_retry' || tierState === 'running') {
      counts.retrying++;
      continue;
    }

    // Running: in-progress statuses
    if (RUNNING_STATUSES.has(status)) {
      counts.running++;
      continue;
    }

    // Exhausted retries
    if (tierState === 'exhausted') {
      counts.failed++;
      continue;
    }

    // Skipped: service errors, timeouts
    if (SKIPPED_STATUSES.has(status)) {
      counts.skipped++;
      continue;
    }

    // Failed: blocked, captcha, etc.
    if (FAILED_STATUSES.has(status)) {
      counts.failed++;
      continue;
    }

    // Unknown status with no price = still running
    if (!status || status === '') {
      counts.running++;
      continue;
    }

    // Catch-all: treat as failed
    counts.failed++;
  }

  return counts;
}

export function useExtractionProgressRealtime({
  searchId,
  enabled,
  onProgressUpdate,
}: UseExtractionProgressRealtimeOptions) {
  const [extractions, setExtractions] = useState<ExtractionProgress[]>([]);
  const [lastUpdateAt, setLastUpdateAt] = useState<Date | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  
  const queryClient = useQueryClient();
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const pollIntervalRef = useRef<number | null>(null);
  const lastFetchRef = useRef<number>(0);

  // Fetch extractions from DB
  const fetchExtractions = useCallback(async () => {
    if (!searchId) return;

    try {
      const { data, error } = await supabase
        .from('price_extractions')
        .select('id, platform_name, extraction_status, extracted_price, currency, tier_a_state, tier_a_attempt_count, updated_at')
        .eq('search_id', searchId);

      if (error) {
        console.error('[ExtractionRealtime] Fetch error:', error);
        return;
      }

      if (data) {
        const typed = data as ExtractionProgress[];
        setExtractions(typed);
        setLastUpdateAt(new Date());
        lastFetchRef.current = Date.now();
        onProgressUpdate?.(typed);
      }
    } catch (e) {
      console.error('[ExtractionRealtime] Fetch exception:', e);
    }
  }, [searchId, onProgressUpdate]);

  // Set up realtime subscription
  useEffect(() => {
    if (!searchId || !enabled) {
      // Clean up if disabled
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
      if (pollIntervalRef.current) {
        window.clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      return;
    }

    console.log('[ExtractionRealtime] Setting up subscription for search:', searchId);

    // Initial fetch
    fetchExtractions();

    // Set up realtime channel
    const channel = supabase
      .channel(`extraction_progress:${searchId}`)
      .on(
        'postgres_changes',
        {
          event: '*', // Listen to all events (INSERT, UPDATE, DELETE)
          schema: 'public',
          table: 'price_extractions',
          filter: `search_id=eq.${searchId}`,
        },
        (payload) => {
          console.log('[ExtractionRealtime] Received change:', payload.eventType);
          setLastUpdateAt(new Date());
          // Refetch all extractions to ensure consistency
          fetchExtractions();
        }
      )
      .subscribe((status, err) => {
        console.log('[ExtractionRealtime] Channel status:', status, err);
        if (status === 'SUBSCRIBED') {
          setIsConnected(true);
          setConnectionError(null);
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          setIsConnected(false);
          setConnectionError(err?.message || 'Connection failed');
        } else if (status === 'CLOSED') {
          setIsConnected(false);
        }
      });

    channelRef.current = channel;

    // Fallback polling - runs regardless of realtime status
    // This ensures we don't get stuck even if realtime fails silently
    pollIntervalRef.current = window.setInterval(() => {
      const timeSinceFetch = Date.now() - lastFetchRef.current;
      // Only poll if it's been more than 2 seconds since last fetch
      // This avoids redundant fetches when realtime is working
      if (timeSinceFetch > 2000) {
        console.log('[ExtractionRealtime] Polling fallback fetch');
        fetchExtractions();
      }
    }, 3000);

    return () => {
      console.log('[ExtractionRealtime] Cleaning up subscription');
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
      if (pollIntervalRef.current) {
        window.clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [searchId, enabled, fetchExtractions]);

  // Calculate progress counts
  const progressCounts = calculateProgressCounts(extractions);

  // Check if all extractions are terminal
  const isAllTerminal = extractions.length > 0 && 
    progressCounts.running === 0 && 
    progressCounts.retrying === 0;

  return {
    extractions,
    progressCounts,
    lastUpdateAt,
    isConnected,
    connectionError,
    isAllTerminal,
    refetch: fetchExtractions,
  };
}
