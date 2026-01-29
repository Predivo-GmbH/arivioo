import React from "react";
import { Loader2, RefreshCw, CheckCircle, XCircle, Clock, AlertTriangle } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Extraction Status Chip
 * 
 * Displays a compact, transparent status indicator for each platform's extraction.
 * Shows: Fetching | Retrying (x/y) | Done | Skipped | Failed
 */

export type ExtractionChipStatus = 
  | 'fetching'
  | 'retrying'
  | 'done'
  | 'skipped'
  | 'failed';

interface ExtractionStatusChipProps {
  status: ExtractionChipStatus;
  attemptCount?: number;
  maxAttempts?: number;
  /** Brief reason for failure/skip */
  reason?: string;
  /** Platform name for tooltip context */
  platformName?: string;
}

export function ExtractionStatusChip({
  status,
  attemptCount,
  maxAttempts = 4,
  reason,
  platformName,
}: ExtractionStatusChipProps) {
  const getChipContent = () => {
    switch (status) {
      case 'fetching':
        return {
          icon: <Loader2 className="w-3 h-3 animate-spin" />,
          label: 'Fetching',
          className: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
          tooltip: `Fetching price from ${platformName || 'platform'}...`,
        };
        
      case 'retrying':
        const attempt = attemptCount ?? 1;
        return {
          icon: <RefreshCw className="w-3 h-3" />,
          label: `Retrying ${attempt}/${maxAttempts}`,
          className: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
          tooltip: `Retrying extraction (attempt ${attempt} of ${maxAttempts})`,
        };
        
      case 'done':
        return {
          icon: <CheckCircle className="w-3 h-3" />,
          label: 'Done',
          className: 'bg-green-500/10 text-green-600 dark:text-green-400',
          tooltip: 'Price successfully extracted',
        };
        
      case 'skipped':
        return {
          icon: <Clock className="w-3 h-3" />,
          label: 'Skipped',
          className: 'bg-muted text-muted-foreground',
          tooltip: reason || 'Platform skipped (slow/unresponsive)',
        };
        
      case 'failed':
        return {
          icon: <XCircle className="w-3 h-3" />,
          label: 'Failed',
          className: 'bg-red-500/10 text-red-600 dark:text-red-400',
          tooltip: reason || 'Extraction failed',
        };
        
      default:
        return {
          icon: <AlertTriangle className="w-3 h-3" />,
          label: 'Unknown',
          className: 'bg-muted text-muted-foreground',
          tooltip: 'Unknown status',
        };
    }
  };
  
  const { icon, label, className, tooltip } = getChipContent();
  
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span 
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium cursor-help ${className}`}
          >
            {icon}
            {label}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[200px]">
          <p className="text-xs">{tooltip}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * Helper to derive ExtractionChipStatus from extraction data
 */
export function deriveChipStatus(
  extractionStatus: string | null | undefined,
  tierAState: string | null | undefined,
  tierAAttemptCount: number | null | undefined,
  hasPrice: boolean
): { status: ExtractionChipStatus; attemptCount?: number; reason?: string } {
  const status = (extractionStatus || '').toLowerCase();
  const tierState = (tierAState || '').toLowerCase();
  
  // Success states
  const successStatuses = ['success', 'success_total_stay', 'price_extracted', 'completed'];
  if (successStatuses.includes(status) || hasPrice) {
    return { status: 'done' };
  }
  
  // Retrying states
  if (tierState === 'pending_retry' || tierState === 'running') {
    return { 
      status: 'retrying', 
      attemptCount: tierAAttemptCount ?? 1,
    };
  }
  
  // In-progress states
  const pendingStatuses = ['pending', 'queued', 'running', 'in_progress', 'started'];
  if (pendingStatuses.includes(status)) {
    return { status: 'fetching' };
  }
  
  // Skipped (stalled/timeout)
  const skippedStatuses = ['service_error', 'timeout', 'stalled_timeout'];
  if (skippedStatuses.includes(status)) {
    return { status: 'skipped', reason: 'Slow/unresponsive' };
  }
  
  // Hard failures
  const hardFailStatuses = ['blocked', 'access_denied', 'captcha', 'bot_detected', 'rate_limited'];
  if (hardFailStatuses.includes(status)) {
    return { status: 'failed', reason: 'Access blocked' };
  }
  
  // Sold out / unavailable
  const soldOutStatuses = ['dates_unavailable', 'sold_out', 'unavailable_for_dates'];
  if (soldOutStatuses.includes(status)) {
    return { status: 'done' };  // Terminal but not failed - it's a valid outcome
  }
  
  // Exhausted retries
  if (tierState === 'exhausted') {
    return { status: 'failed', reason: 'Retries exhausted' };
  }
  
  // Default: treat any other terminal status as failed
  if (status && !pendingStatuses.includes(status)) {
    return { status: 'failed', reason: status };
  }
  
  // Unknown/empty - assume fetching
  return { status: 'fetching' };
}
