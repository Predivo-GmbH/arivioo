import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { 
  PIPELINE_STAGES, 
  getDefaultTimings, 
  type StageTiming, 
  type PipelineStageId 
} from "@/lib/pipelineStages";

interface UseStageTimingsOptions {
  /** How often to refresh (in ms). 0 disables polling. Default: 60000 (1 min) */
  refreshIntervalMs?: number;
}

export function useStageTimings(options: UseStageTimingsOptions = {}) {
  const { refreshIntervalMs = 60000 } = options;
  
  const [timings, setTimings] = useState<StageTiming[]>(getDefaultTimings());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  const fetchTimings = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;

    try {
      const { data: result, error: fnError } = await supabase.functions.invoke("get-stage-timings", {
        body: {},
      });

      if (fnError) throw fnError;

      if (result?.success && result.timings) {
        // Merge with defaults for any missing stages
        const merged = PIPELINE_STAGES.map(stage => {
          const fromServer = result.timings.find((t: StageTiming) => t.stageId === stage.id);
          if (fromServer && fromServer.sampleCount > 0) {
            return fromServer;
          }
          // Use fallback values
          return {
            stageId: stage.id,
            p50Seconds: stage.fallbackTypicalSeconds[0],
            p80Seconds: stage.fallbackTypicalSeconds[1],
            sampleCount: 0,
            lastUpdated: null,
          };
        });
        setTimings(merged);
      }

      setError(null);
      setLoading(false);
    } catch (err) {
      console.error("Error fetching stage timings:", err);
      setError(err instanceof Error ? err.message : "Failed to fetch");
      setLoading(false);
      // Keep using default/fallback timings on error
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    fetchTimings();

    let intervalId: number | undefined;
    if (refreshIntervalMs > 0) {
      intervalId = window.setInterval(fetchTimings, refreshIntervalMs);
    }

    return () => {
      if (intervalId) window.clearInterval(intervalId);
    };
  }, [fetchTimings, refreshIntervalMs]);

  const getTimingForStage = useCallback((stageId: PipelineStageId): StageTiming | undefined => {
    return timings.find(t => t.stageId === stageId);
  }, [timings]);

  return { timings, loading, error, refetch: fetchTimings, getTimingForStage };
}
