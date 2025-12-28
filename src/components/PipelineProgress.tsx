import React, { useState, useEffect, useMemo } from "react";
import { Check, Sparkles, Camera, Globe, Calendar, DollarSign, CheckCircle, Clock, AlertCircle } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { useStageTimings } from "@/hooks/useStageTimings";
import { 
  PIPELINE_STAGES, 
  getStageFromStatus, 
  formatTypicalTime,
  isCompletedStatus,
  type PipelineStageId,
  type PipelineStage 
} from "@/lib/pipelineStages";
import { PriceExtractionProgress, type PlatformExtractionStatus } from "@/components/PriceExtractionProgress";

// Icon mapping for pipeline stages
const stageIcons = {
  Sparkles,
  Camera,
  Globe,
  Calendar,
  DollarSign,
  CheckCircle,
} as const;

export interface ActivityItem {
  id: string;
  ts: number;
  message: string;
  detail?: string;
}

export interface PipelineProgressProps {
  /** Current backend status string */
  status: string | null | undefined;
  /** Whether the search is complete */
  isComplete: boolean;
  /** Whether the search failed */
  isFailed?: boolean;
  /** Error message if failed */
  errorMessage?: string;
  /** Start time of the search (timestamp ms) */
  startTime: number;
  /** Activity feed items from SSE events */
  activityFeed: ActivityItem[];
  /** Price extraction platforms for detailed progress */
  priceExtractionPlatforms?: PlatformExtractionStatus[];
  priceExtractionTotal?: number;
  priceExtractionCompleted?: number;
  /** Callbacks */
  onCancel?: () => void;
  onSkip?: () => void;
}

/**
 * Unified Pipeline Progress Component
 * 
 * Shows real-time progress through pipeline stages based on backend telemetry.
 * Displays data-driven typical time estimates from historical runs.
 */
export function PipelineProgress({
  status,
  isComplete,
  isFailed = false,
  errorMessage,
  startTime,
  activityFeed,
  priceExtractionPlatforms = [],
  priceExtractionTotal = 0,
  priceExtractionCompleted = 0,
  onCancel,
  onSkip,
}: PipelineProgressProps) {
  const [elapsedMs, setElapsedMs] = useState(0);
  const { timings, getTimingForStage } = useStageTimings({ refreshIntervalMs: 60000 });

  // Update elapsed time every 250ms
  useEffect(() => {
    if (isComplete) return;
    
    const interval = setInterval(() => {
      setElapsedMs(Date.now() - startTime);
    }, 250);
    
    return () => clearInterval(interval);
  }, [startTime, isComplete]);

  // Determine current stage from backend status
  const currentStage = useMemo(() => {
    if (isComplete) return null;
    return getStageFromStatus(status);
  }, [status, isComplete]);

  const currentStageIndex = useMemo(() => {
    if (!currentStage) return -1;
    return PIPELINE_STAGES.findIndex(s => s.id === currentStage.id);
  }, [currentStage]);

  // Calculate total estimated time from telemetry
  const totalEstimatedTime = useMemo(() => {
    let totalP50 = 0;
    let totalP80 = 0;
    let hasData = false;

    for (const stage of PIPELINE_STAGES) {
      const timing = getTimingForStage(stage.id);
      if (timing && timing.sampleCount > 0) {
        totalP50 += timing.p50Seconds || stage.fallbackTypicalSeconds[0];
        totalP80 += timing.p80Seconds || stage.fallbackTypicalSeconds[1];
        hasData = true;
      } else {
        totalP50 += stage.fallbackTypicalSeconds[0];
        totalP80 += stage.fallbackTypicalSeconds[1];
      }
    }

    return { p50: totalP50, p80: totalP80, hasData };
  }, [timings, getTimingForStage]);

  // Calculate estimated remaining time
  const estimatedRemaining = useMemo(() => {
    if (isComplete || currentStageIndex < 0) return null;

    let remainingP50 = 0;
    let remainingP80 = 0;

    // Add time for remaining stages (including partial time for current stage)
    for (let i = currentStageIndex; i < PIPELINE_STAGES.length; i++) {
      const stage = PIPELINE_STAGES[i];
      const timing = getTimingForStage(stage.id);
      
      if (timing && timing.sampleCount > 0) {
        remainingP50 += timing.p50Seconds || stage.fallbackTypicalSeconds[0];
        remainingP80 += timing.p80Seconds || stage.fallbackTypicalSeconds[1];
      } else {
        remainingP50 += stage.fallbackTypicalSeconds[0];
        remainingP80 += stage.fallbackTypicalSeconds[1];
      }
    }

    return { p50: remainingP50, p80: remainingP80 };
  }, [currentStageIndex, isComplete, getTimingForStage]);

  // Format elapsed time
  const formatElapsed = (ms: number): string => {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes}m ${secs}s`;
  };

  // Get stage status
  const getStageStatus = (stageIndex: number): 'completed' | 'active' | 'pending' | 'failed' => {
    if (isFailed && stageIndex === currentStageIndex) return 'failed';
    if (isComplete) return 'completed';
    if (stageIndex < currentStageIndex) return 'completed';
    if (stageIndex === currentStageIndex) return 'active';
    return 'pending';
  };

  // Get live activity message based on status
  const getLiveActivity = (): { message: string; detail?: string } => {
    if (!status) return { message: "Starting search…" };

    // Map backend statuses to user-friendly messages
    if (status === "extracting_photos") {
      return { message: "Extracting property photos", detail: "Downloading clean property images from the Airbnb listing" };
    }
    if (status === "scraping_airbnb_page") {
      return { message: "Loading Airbnb listing", detail: "Capturing page content including dynamic price data" };
    }
    if (status === "extracting_price_with_ai") {
      return { message: "Extracting Airbnb price", detail: "Using AI to find the exact price for your dates" };
    }
    if (status.startsWith("searching_platforms_lens_")) {
      const m = status.match(/searching_platforms_lens_(\d+)_of_(\d+)/);
      if (m) {
        return { 
          message: `Searching for matches (image ${m[1]} of ${m[2]})`, 
          detail: "Running AI reverse image search across Booking.com, Vrbo, TripAdvisor, and more" 
        };
      }
      return { message: "Searching for matches", detail: "Running AI reverse image search" };
    }
    if (status === "searching_platforms") {
      return { message: "Searching for matches", detail: "Running AI reverse image search across booking sites" };
    }
    if (status.startsWith("ai_verifying_")) {
      const platform = status.replace("ai_verifying_", "").replace(/_/g, " ");
      const formattedPlatform = platform.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      return { message: `Verifying match on ${formattedPlatform}`, detail: "AI is comparing property photos to confirm it's the same place" };
    }
    if (status === "comparing_prices") {
      return { message: "Collecting prices", detail: "Preparing to scrape prices from matched platforms" };
    }
    if (status.startsWith("scraping_price_")) {
      const parts = status.replace("scraping_price_", "");
      const indexMatch = parts.match(/_(\d+)_of_(\d+)$/);
      let platform = parts.replace(/_\d+_of_\d+$/, "").replace(/_/g, " ");
      const formattedPlatform = platform.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      
      if (indexMatch) {
        return { 
          message: `Getting price from ${formattedPlatform} (${indexMatch[1]}/${indexMatch[2]})`, 
          detail: "Scraping the listing page to find the exact price for your dates" 
        };
      }
      return { message: `Getting price from ${formattedPlatform}`, detail: "Scraping the listing page to find the exact price" };
    }
    if (status === "validating_dates" || status === "phase_a") {
      return { message: "Applying your dates", detail: "Setting check-in/check-out on each platform" };
    }
    if (status === "extracting_prices" || status === "phase_b") {
      return { message: "Extracting prices", detail: "Getting real-time prices from each platform" };
    }
    if (status === "finalizing" || status === "computing_savings") {
      return { message: "Finalizing results", detail: "Computing savings and preparing your results" };
    }
    if (status === "completed") {
      return { message: "Search complete" };
    }

    return { message: status.replace(/_/g, " ") };
  };

  const activity = getLiveActivity();

  return (
    <div className="max-w-xl mx-auto py-8 animate-fade-in">
      {/* Header with overall progress */}
      <div className="text-center mb-8">
        <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-primary/10 flex items-center justify-center">
          {isFailed ? (
            <AlertCircle className="w-10 h-10 text-destructive" />
          ) : (
            <Sparkles className="w-10 h-10 text-primary animate-pulse" />
          )}
        </div>
        
        <h2 className="text-2xl font-bold text-foreground mb-2">
          {isFailed ? "Search Failed" : isComplete ? "Search Complete" : "Finding Better Deals"}
        </h2>

        {isFailed && errorMessage && (
          <p className="text-destructive mb-4">{errorMessage}</p>
        )}

        {!isComplete && !isFailed && (
          <>
            {/* Time info */}
            <div className="flex items-center justify-center gap-4 text-sm text-muted-foreground mb-4">
              <div className="flex items-center gap-1.5">
                <Clock className="w-4 h-4" />
                <span>Elapsed: <span className="font-medium text-foreground">{formatElapsed(elapsedMs)}</span></span>
              </div>
              
              {estimatedRemaining && totalEstimatedTime.hasData && (
                <div className="flex items-center gap-1.5">
                  <span>Remaining: <span className="font-medium text-foreground">
                    {formatTypicalTime(estimatedRemaining.p50, estimatedRemaining.p80)}
                  </span></span>
                </div>
              )}
              
              {!totalEstimatedTime.hasData && (
                <div className="text-muted-foreground/70">
                  <span>Estimating time…</span>
                </div>
              )}
            </div>

            {/* Overall progress bar */}
            <div className="max-w-md mx-auto mb-6">
              <div className="h-2 bg-muted rounded-full overflow-hidden">
                <div 
                  className="h-full bg-primary rounded-full transition-all duration-500"
                  style={{ 
                    width: `${Math.min(100, ((currentStageIndex + 0.5) / PIPELINE_STAGES.length) * 100)}%` 
                  }}
                />
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                Stage {currentStageIndex + 1} of {PIPELINE_STAGES.length}
              </p>
            </div>
          </>
        )}
      </div>

      {/* Stage list */}
      <div className="space-y-1 mb-6">
        {PIPELINE_STAGES.map((stage, index) => {
          const StepIcon = stageIcons[stage.icon];
          const stageStatus = getStageStatus(index);
          const timing = getTimingForStage(stage.id);
          const hasTelemetry = timing && timing.sampleCount > 0;
          const typicalTime = hasTelemetry 
            ? formatTypicalTime(timing.p50Seconds, timing.p80Seconds)
            : formatTypicalTime(stage.fallbackTypicalSeconds[0], stage.fallbackTypicalSeconds[1]);
          
          return (
            <div key={stage.id} className="relative flex">
              {/* Left column with circle and line */}
              <div className="flex flex-col items-center mr-4">
                {/* Circle */}
                <div className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 transition-all duration-300 ${
                  stageStatus === 'completed' 
                    ? 'bg-primary text-primary-foreground' 
                    : stageStatus === 'active' 
                    ? 'bg-primary/10 text-primary border-2 border-primary' 
                    : stageStatus === 'failed'
                    ? 'bg-destructive/10 text-destructive border-2 border-destructive'
                    : 'bg-muted text-muted-foreground'
                }`}>
                  {stageStatus === 'completed' ? (
                    <Check className="w-4 h-4" />
                  ) : stageStatus === 'failed' ? (
                    <AlertCircle className="w-4 h-4" />
                  ) : (
                    <StepIcon className="w-4 h-4" />
                  )}
                </div>
                
                {/* Connecting line */}
                {index < PIPELINE_STAGES.length - 1 && (
                  <div className={`w-0.5 flex-1 min-h-[1.5rem] transition-colors duration-300 ${
                    stageStatus === 'completed' ? 'bg-primary' : 'bg-muted'
                  }`} />
                )}
              </div>
              
              {/* Right column with content */}
              <div className={`flex-1 pb-4 ${index === PIPELINE_STAGES.length - 1 ? 'pb-0' : ''}`}>
                <div className={`p-3 rounded-lg transition-all duration-300 ${
                  stageStatus === 'active' ? 'bg-primary/5 border border-primary/20' : ''
                }`}>
                  <div className="flex items-center justify-between mb-1">
                    <h3 className={`font-medium text-sm transition-colors ${
                      stageStatus === 'active' ? 'text-foreground' 
                      : stageStatus === 'completed' ? 'text-foreground' 
                      : stageStatus === 'failed' ? 'text-destructive'
                      : 'text-muted-foreground'
                    }`}>
                      {stage.title}
                      {stageStatus === 'completed' && <span className="text-primary ml-2">✓</span>}
                    </h3>
                    
                    {/* Typical time badge */}
                    {stageStatus === 'pending' && (
                      <span className={`text-xs px-2 py-0.5 rounded-full ${
                        hasTelemetry 
                          ? 'bg-muted text-muted-foreground' 
                          : 'bg-muted/50 text-muted-foreground/70'
                      }`}>
                        {hasTelemetry ? `Typical: ${typicalTime}` : `Est: ${typicalTime}`}
                      </span>
                    )}
                  </div>
                  
                  {/* Description for active stage */}
                  {stageStatus === 'active' && (
                    <p className="text-xs text-muted-foreground mb-2">
                      {stage.description}
                    </p>
                  )}
                  
                  {/* Price extraction detailed progress */}
                  {stageStatus === 'active' && stage.id === 'collect_prices' && priceExtractionPlatforms.length > 0 && (
                    <div className="mt-2">
                      <PriceExtractionProgress
                        platforms={priceExtractionPlatforms}
                        totalPlatforms={priceExtractionTotal}
                        completedCount={priceExtractionCompleted}
                      />
                    </div>
                  )}
                  
                  {/* Active stage progress indicator */}
                  {stageStatus === 'active' && (stage.id !== 'collect_prices' || priceExtractionPlatforms.length === 0) && (
                    <div className="relative h-1.5 bg-muted rounded-full overflow-hidden">
                      <div
                        className="absolute inset-0 pointer-events-none"
                        aria-hidden="true"
                      >
                        <div
                          className="h-full w-1/3 opacity-60 animate-[loading-sweep_1.25s_ease-in-out_infinite]"
                          style={{
                            backgroundImage:
                              'linear-gradient(90deg, transparent, hsl(var(--primary) / 0.35), transparent)',
                          }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Live activity card */}
      {!isComplete && !isFailed && (
        <div className="mx-auto max-w-md rounded-xl border-2 border-primary/30 bg-primary/5 p-4 text-left shadow-sm mb-6">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
            <p className="text-xs font-medium text-primary uppercase tracking-wide">Live Activity</p>
          </div>
          <p className="text-base font-semibold text-foreground leading-relaxed">{activity.message}</p>
          {activity.detail && (
            <p className="text-sm text-muted-foreground mt-1">{activity.detail}</p>
          )}

          {/* Activity feed */}
          {activityFeed.length > 0 && (
            <div className="mt-4 rounded-lg border border-border bg-card/60">
              <ScrollArea className="h-24">
                <div className="p-3 space-y-2">
                  {activityFeed
                    .slice()
                    .reverse()
                    .map((item) => (
                      <div 
                        key={item.id} 
                        className="text-xs animate-in fade-in slide-in-from-top-2 duration-300"
                      >
                        <p className="text-foreground/90">{item.message}</p>
                        {item.detail && (
                          <p className="text-muted-foreground mt-0.5">{item.detail}</p>
                        )}
                      </div>
                    ))}
                </div>
              </ScrollArea>
            </div>
          )}
        </div>
      )}

      {/* Action buttons */}
      {!isComplete && !isFailed && (
        <div className="flex items-center justify-center gap-3">
          {onCancel && (
            <Button variant="outline" onClick={onCancel}>
              Cancel
            </Button>
          )}
          {onSkip && (
            <Button variant="ghost" onClick={onSkip}>
              Skip this step
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
