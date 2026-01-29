import React from "react";
import { Loader2, CheckCircle, Clock, AlertTriangle, RefreshCw } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

/**
 * Search Progress Tracker
 * 
 * Displays transparent, real-time progress for price extraction:
 * - Completed X/N
 * - Running Y
 * - Retrying Z
 * - Skipped S
 * - Last update timestamp
 * - "Still working" message when stalled
 */

interface ProgressCounts {
  total: number;
  completed: number;
  running: number;
  retrying: number;
  skipped: number;
  failed: number;
}

interface SearchProgressTrackerProps {
  counts: ProgressCounts;
  lastProgressAt: Date | null;
  /** Show "still working" message threshold (ms) */
  noProgressThresholdMs?: number;
  /** Whether the search is finalized */
  isFinalized?: boolean;
}

export function SearchProgressTracker({
  counts,
  lastProgressAt,
  noProgressThresholdMs = 90000, // 90 seconds
  isFinalized = false,
}: SearchProgressTrackerProps) {
  const now = new Date();
  const timeSinceProgress = lastProgressAt 
    ? now.getTime() - lastProgressAt.getTime()
    : 0;
  
  const isStalled = !isFinalized && timeSinceProgress > noProgressThresholdMs;
  const allComplete = counts.completed + counts.skipped + counts.failed >= counts.total;
  
  // Format last update time
  const lastUpdateText = lastProgressAt
    ? formatDistanceToNow(lastProgressAt, { addSuffix: true, includeSeconds: true })
    : 'Unknown';
  
  // If finalized or all complete, show success state
  if (isFinalized || allComplete) {
    return (
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <CheckCircle className="w-4 h-4 text-green-500" />
          <span className="font-medium text-foreground">
            {counts.completed}/{counts.total} completed
          </span>
        </div>
        {counts.skipped > 0 && (
          <span className="text-xs">
            ({counts.skipped} skipped)
          </span>
        )}
      </div>
    );
  }
  
  return (
    <div className="space-y-2">
      {/* Main progress row */}
      <div className="flex flex-wrap items-center gap-3 text-sm">
        {/* Completed */}
        <div className="flex items-center gap-1.5">
          <CheckCircle className="w-4 h-4 text-green-500" />
          <span className="font-medium">
            {counts.completed}/{counts.total}
          </span>
        </div>
        
        {/* Running */}
        {counts.running > 0 && (
          <div className="flex items-center gap-1.5 text-blue-600 dark:text-blue-400">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span className="text-xs">{counts.running} running</span>
          </div>
        )}
        
        {/* Retrying */}
        {counts.retrying > 0 && (
          <div className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
            <RefreshCw className="w-3.5 h-3.5" />
            <span className="text-xs">{counts.retrying} retrying</span>
          </div>
        )}
        
        {/* Skipped */}
        {counts.skipped > 0 && (
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <Clock className="w-3.5 h-3.5" />
            <span className="text-xs">{counts.skipped} skipped</span>
          </div>
        )}
        
        {/* Failed */}
        {counts.failed > 0 && (
          <div className="flex items-center gap-1.5 text-red-500">
            <AlertTriangle className="w-3.5 h-3.5" />
            <span className="text-xs">{counts.failed} failed</span>
          </div>
        )}
        
        {/* Last update */}
        <span className="text-xs text-muted-foreground ml-auto">
          Last update: {lastUpdateText}
        </span>
      </div>
      
      {/* Stalled message */}
      {isStalled && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-sm">
          <Loader2 className="w-4 h-4 animate-spin text-amber-600" />
          <span className="text-amber-700 dark:text-amber-400">
            Still working—prioritizing high-priority platforms…
          </span>
          <span className="text-xs text-amber-600/70 ml-auto">
            Auto-recovery in progress
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Calculate progress counts from extraction statuses
 */
export function calculateProgressCounts(
  extractions: Array<{
    extraction_status?: string | null;
    tier_a_state?: string | null;
    extracted_price?: number | null;
  }>
): ProgressCounts {
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
    
    // Success states
    const successStatuses = ['success', 'success_total_stay', 'price_extracted', 'completed'];
    const soldOutStatuses = ['dates_unavailable', 'sold_out', 'unavailable_for_dates'];
    
    if (successStatuses.includes(status) || soldOutStatuses.includes(status) || hasPrice) {
      counts.completed++;
      continue;
    }
    
    // Retrying states (Tier A)
    if (tierState === 'pending_retry' || (tierState === 'running' && status !== 'running')) {
      counts.retrying++;
      continue;
    }
    
    // In-progress states
    const pendingStatuses = ['pending', 'queued', 'running', 'in_progress', 'started'];
    if (pendingStatuses.includes(status)) {
      counts.running++;
      continue;
    }
    
    // Skipped states
    const skippedStatuses = ['service_error', 'timeout', 'stalled_timeout'];
    if (skippedStatuses.includes(status) && tierState !== 'exhausted') {
      counts.skipped++;
      continue;
    }
    
    // Exhausted retries
    if (tierState === 'exhausted') {
      counts.failed++;
      continue;
    }
    
    // Other terminal states = failed
    if (status && !pendingStatuses.includes(status)) {
      counts.failed++;
      continue;
    }
    
    // Unknown = treat as running
    counts.running++;
  }
  
  return counts;
}
