/**
 * Canonical Pipeline Stages - Single Source of Truth
 * 
 * These stage definitions are shared between backend and frontend to ensure
 * consistency in progress tracking, telemetry, and UI display.
 * 
 * The stages represent the actual backend pipeline execution order.
 */

export type PipelineStageId = 
  | 'analyze_listing'
  | 'collect_photos'
  | 'find_matches'
  | 'validate_dates'
  | 'collect_prices'
  | 'finalize_results';

export type StageOutcome = 'running' | 'success' | 'partial' | 'failed' | 'skipped' | 'cancelled';

export interface PipelineStage {
  /** Unique identifier for the stage (used in DB telemetry) */
  id: PipelineStageId;
  /** Human-readable title for the UI */
  title: string;
  /** Description shown during the stage */
  description: string;
  /** Icon name (lucide-react icon) */
  icon: 'Sparkles' | 'Camera' | 'Globe' | 'Calendar' | 'DollarSign' | 'CheckCircle';
  /** Fallback typical time range if no telemetry data exists [p50, p80] in seconds */
  fallbackTypicalSeconds: [number, number];
  /** Backend status values that map to this stage (strings or regex patterns as strings) */
  backendStatuses: string[];
  /** Optional regex pattern for matching dynamic statuses */
  statusPattern?: string;
}

/**
 * Canonical pipeline stages in execution order.
 * 
 * Order rationale:
 * 1. Analyze listing - Parse Airbnb URL, extract metadata, determine dates
 * 2. Collect photos - Download property images from Airbnb
 * 3. Find matches - Visual search + text search to find property on other platforms
 * 4. Validate dates - Phase A: Apply dates to deep links, validate they took effect
 * 5. Collect prices - Phase B: Extract actual prices from each platform
 * 6. Finalize results - Compute best deal, sort, prepare for display
 */
/**
 * Canonical pipeline stages in execution order.
 * 
 * These map to real backend work and are the SINGLE SOURCE OF TRUTH for:
 * - Backend telemetry (search_stage_runs table)
 * - Frontend progress UI
 * - Timing estimates
 * 
 * Order rationale:
 * 1. Analyze listing - Parse Airbnb URL, extract metadata, determine dates
 * 2. Collect photos - Download property images from Airbnb
 * 3. Find matches - Visual search + text search to find property on other platforms
 * 4. Verify matches - AI verification of visual matches (≥90% confidence)
 * 5. Collect prices - Extract actual prices from each platform
 * 6. Finalize results - Compute best deal, sort, prepare for display
 */
export const PIPELINE_STAGES: readonly PipelineStage[] = [
  {
    id: 'analyze_listing',
    title: 'Analyzing Listing',
    description: 'Parsing Airbnb URL and extracting property details...',
    icon: 'Sparkles',
    fallbackTypicalSeconds: [5, 12],
    backendStatuses: ['pending', 'searching', 'extracting_price', 'scraping_airbnb_page', 'extracting_price_with_ai', 'scraping_airbnb'],
  },
  {
    id: 'collect_photos',
    title: 'Collecting Photos',
    description: 'Downloading property images for visual matching...',
    icon: 'Camera',
    fallbackTypicalSeconds: [3, 8],
    backendStatuses: ['extracting_photos', 'collecting_photos'],
  },
  {
    id: 'find_matches',
    title: 'Finding Matches',
    description: 'Searching platforms and verifying property matches...',
    icon: 'Globe',
    fallbackTypicalSeconds: [15, 35],
    // AI verification is part of finding matches, not a separate stage
    // This prevents oscillation between find_matches and validate_dates
    backendStatuses: ['searching_platforms', 'reverse_image_search_backup', 'validating_dates', 'phase_a'],
    statusPattern: '^searching_platforms_lens_|^text_search_|^ai_verifying_',
  },
  {
    id: 'validate_dates',
    title: 'Applying Dates',
    description: 'Setting your check-in/check-out dates on each platform...',
    icon: 'Calendar',
    fallbackTypicalSeconds: [8, 20],
    // Only explicit date validation statuses, not AI verification
    backendStatuses: ['applying_dates', 'date_validation'],
  },
  {
    id: 'collect_prices',
    title: 'Collecting Prices',
    description: 'Getting real-time prices for your exact dates...',
    icon: 'DollarSign',
    fallbackTypicalSeconds: [12, 30],
    backendStatuses: ['collecting_prices', 'comparing_prices', 'phase_b', 'extracting_prices'],
    statusPattern: '^scraping_price_',
  },
  {
    id: 'finalize_results',
    title: 'Finalizing Results',
    description: 'Computing savings and preparing your results...',
    icon: 'CheckCircle',
    fallbackTypicalSeconds: [2, 5],
    backendStatuses: ['finalizing', 'computing_savings', 'completed'],
  },
] as const;

/**
 * Get stage by ID
 */
export function getStageById(id: PipelineStageId): PipelineStage | undefined {
  return PIPELINE_STAGES.find(s => s.id === id);
}

/**
 * Get the current stage based on backend status
 */
export function getStageFromStatus(status: string | null | undefined): PipelineStage | undefined {
  if (!status) return PIPELINE_STAGES[0];
  
  for (const stage of PIPELINE_STAGES) {
    // Check exact matches
    if (stage.backendStatuses.includes(status)) {
      return stage;
    }
    // Check pattern match if defined
    if (stage.statusPattern) {
      const regex = new RegExp(stage.statusPattern);
      if (regex.test(status)) {
        return stage;
      }
    }
  }
  
  // Default to first stage if unknown status
  return PIPELINE_STAGES[0];
}

/**
 * Get stage index from status
 */
export function getStageIndexFromStatus(status: string | null | undefined): number {
  const stage = getStageFromStatus(status);
  if (!stage) return 0;
  return PIPELINE_STAGES.findIndex(s => s.id === stage.id);
}

/**
 * Terminal search statuses - once a search reaches one of these, results should be frozen.
 * These represent final states where no further pipeline work will occur.
 */
export const TERMINAL_STATUSES = [
  'completed',           // Success - all platforms processed
  'done',                // Alias for completed
  'error',               // Fatal pipeline error
  'failed',              // Fatal pipeline error (legacy)
  'cancelled',           // User cancelled the search
  'price_unavailable',   // No prices could be extracted but search finished
  'dates_unavailable',   // The listing is not available for the requested dates
] as const;

export type TerminalStatus = typeof TERMINAL_STATUSES[number];

/**
 * Check if a status indicates completion (alias for isTerminalStatus)
 */
export function isCompletedStatus(status: string | null | undefined): boolean {
  return isTerminalStatus(status);
}

/**
 * Check if a status is terminal (search is done, no more updates expected).
 * Once a search reaches a terminal status:
 * - Polling should stop
 * - Results should be frozen
 * - UI should display the final snapshot
 */
export function isTerminalStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * Format typical time range for display
 */
export function formatTypicalTime(p50Seconds: number | null, p80Seconds: number | null): string {
  if (p50Seconds === null || p80Seconds === null) {
    return 'Calculating...';
  }
  
  const formatTime = (seconds: number): string => {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    const minutes = Math.floor(seconds / 60);
    const secs = Math.round(seconds % 60);
    return secs > 0 ? `${minutes}m ${secs}s` : `${minutes}m`;
  };
  
  // If times are close, show single value
  if (Math.abs(p80Seconds - p50Seconds) < 3) {
    return `~${formatTime(p50Seconds)}`;
  }
  
  return `${formatTime(p50Seconds)}–${formatTime(p80Seconds)}`;
}

/**
 * Stage timing data from telemetry
 */
export interface StageTiming {
  stageId: PipelineStageId;
  p50Seconds: number | null;
  p80Seconds: number | null;
  sampleCount: number;
  lastUpdated: string | null;
}

/**
 * Default timings using fallback values
 */
export function getDefaultTimings(): StageTiming[] {
  return PIPELINE_STAGES.map(stage => ({
    stageId: stage.id,
    p50Seconds: stage.fallbackTypicalSeconds[0],
    p80Seconds: stage.fallbackTypicalSeconds[1],
    sampleCount: 0,
    lastUpdated: null,
  }));
}
