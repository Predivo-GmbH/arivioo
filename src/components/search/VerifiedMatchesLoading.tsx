import React from "react";
import { Shield, Loader2, ExternalLink, Info, Clock, Check, AlertTriangle, RefreshCw, Ban, Wifi, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Json } from "@/integrations/supabase/types";
import { format } from "date-fns";

/**
 * Phase 1 UI Component: Verified Matches (Prices Loading)
 * 
 * Displays verified image matches while prices are still being extracted.
 * This component is shown after image verification completes but before
 * finalization (price extraction) is complete.
 * 
 * NOW WITH LIVE PROGRESS: Shows per-platform extraction status that updates
 * in real-time via Supabase realtime subscriptions + polling fallback.
 */

export interface VerifiedMatchLoadingItem {
  id: string;
  platform_name: string;
  listing_url: string;
  listing_title: string | null;
  confidence_score: number | null;
  images: Json;
  match_type?: string;
  source_airbnb_image?: string | null;
  // MATCH_ONLY status if already determined
  extraction_status?: string | null;
  outcome_category?: string | null;
}

export interface ExtractionStatusInfo {
  platform_name: string;
  extraction_status: string | null;
  extracted_price: number | null;
  currency: string | null;
  tier_a_state: string | null;
  tier_a_attempt_count: number | null;
}

interface VerifiedMatchesLoadingProps {
  results: VerifiedMatchLoadingItem[];
  pricingProgress?: {
    completed: number;
    total: number;
  };
  /** Live extraction statuses from realtime hook */
  extractionStatuses?: ExtractionStatusInfo[];
  /** Last update timestamp */
  lastUpdateAt?: Date | null;
  /** Realtime connection status */
  isConnected?: boolean;
}

const toStringArray = (json: Json | null | undefined): string[] => {
  if (!json) return [];
  if (Array.isArray(json)) {
    return json.filter((item): item is string => typeof item === "string");
  }
  return [];
};

// Get display info for extraction status - detailed states for real-time updates
function getStatusDisplay(extraction: ExtractionStatusInfo | undefined): {
  icon: React.ReactNode;
  text: string;
  color: string;
  badge?: string;
} {
  // No extraction record yet = Queued (waiting to start)
  if (!extraction) {
    return {
      icon: <Clock className="w-3.5 h-3.5" />,
      text: "Queued",
      color: "text-muted-foreground",
      badge: "queued",
    };
  }

  const status = (extraction.extraction_status || "").toLowerCase();
  const tierState = (extraction.tier_a_state || "").toLowerCase();
  const hasPrice = extraction.extracted_price && extraction.extracted_price > 0;
  const attempts = extraction.tier_a_attempt_count || 0;

  // Success states - show actual price
  if (hasPrice || status.includes("success") || status === "completed") {
    const price = extraction.extracted_price;
    const currency = extraction.currency || "$";
    const displayPrice = price ? `${currency}${Math.round(price).toLocaleString()}` : "Done";
    return {
      icon: <Check className="w-3.5 h-3.5" />,
      text: displayPrice,
      color: "text-green-600 dark:text-green-400",
      badge: "done",
    };
  }

  // Sold out / unavailable - these are terminal "done" states, not errors
  if (["dates_unavailable", "sold_out", "unavailable_for_dates"].includes(status)) {
    return {
      icon: <AlertTriangle className="w-3.5 h-3.5" />,
      text: "Sold Out",
      color: "text-amber-600 dark:text-amber-400",
      badge: "sold_out",
    };
  }

  // Retrying states - show attempt counter
  if (tierState === "pending_retry") {
    return {
      icon: <RefreshCw className="w-3.5 h-3.5" />,
      text: `Retry ${attempts}/4`,
      color: "text-amber-600 dark:text-amber-400",
      badge: "retrying",
    };
  }

  // Active retry in progress
  if (tierState === "running" && attempts > 0) {
    return {
      icon: <RefreshCw className="w-3.5 h-3.5 animate-spin" />,
      text: `Retrying (${attempts}/4)`,
      color: "text-amber-600 dark:text-amber-400",
      badge: "retrying",
    };
  }

  // Currently fetching - actively running
  if (["running", "in_progress", "started"].includes(status)) {
    return {
      icon: <Loader2 className="w-3.5 h-3.5 animate-spin" />,
      text: "Fetching…",
      color: "text-primary",
      badge: "fetching",
    };
  }

  // Queued but not yet started
  if (["pending", "queued"].includes(status) || status === "") {
    return {
      icon: <Clock className="w-3.5 h-3.5" />,
      text: "Queued",
      color: "text-muted-foreground",
      badge: "queued",
    };
  }

  // Blocked/failed states
  if (["blocked", "captcha", "bot_detected", "rate_limited"].includes(status)) {
    return {
      icon: <Ban className="w-3.5 h-3.5" />,
      text: "Blocked",
      color: "text-red-500",
      badge: "blocked",
    };
  }

  // Skipped / service error / timeout
  if (["service_error", "timeout", "stalled_timeout", "platform_unsupported"].includes(status)) {
    return {
      icon: <Clock className="w-3.5 h-3.5" />,
      text: "Skipped",
      color: "text-muted-foreground",
      badge: "skipped",
    };
  }

  // Exhausted retries
  if (tierState === "exhausted") {
    return {
      icon: <AlertTriangle className="w-3.5 h-3.5" />,
      text: "Failed",
      color: "text-red-500",
      badge: "failed",
    };
  }

  // Unknown terminal status = treat as failed
  if (status && !["pending", "queued", "running", "in_progress", "started", ""].includes(status)) {
    return {
      icon: <AlertTriangle className="w-3.5 h-3.5" />,
      text: "Failed",
      color: "text-red-500",
      badge: "failed",
    };
  }

  // Default fallback = still fetching
  return {
    icon: <Loader2 className="w-3.5 h-3.5 animate-spin" />,
    text: "Fetching…",
    color: "text-muted-foreground",
    badge: "fetching",
  };
}

export function VerifiedMatchesLoading({ 
  results, 
  pricingProgress,
  extractionStatuses,
  lastUpdateAt,
  isConnected,
}: VerifiedMatchesLoadingProps) {
  if (results.length === 0) return null;

  // Build lookup map for extraction statuses by platform name
  const statusMap = new Map<string, ExtractionStatusInfo>();
  if (extractionStatuses) {
    for (const es of extractionStatuses) {
      // Use lowercase platform name for case-insensitive matching
      statusMap.set(es.platform_name.toLowerCase(), es);
    }
  }

  // Format last update time
  const lastUpdateTime = lastUpdateAt ? format(lastUpdateAt, "HH:mm:ss") : "--:--:--";

  return (
    <div className="rounded-xl border border-primary/30 bg-primary/5 overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 bg-primary/10 border-b border-primary/20">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-full bg-primary/20 flex items-center justify-center">
              <Shield className="w-3.5 h-3.5 text-primary" />
            </div>
            <span className="text-sm font-medium text-foreground">
              {results.length} verified match{results.length !== 1 ? "es" : ""} found
            </span>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <Loader2 className="w-4 h-4 text-primary animate-spin" />
              <span className="text-xs text-muted-foreground">
                {pricingProgress
                  ? `Fetching prices (${pricingProgress.completed}/${pricingProgress.total})…`
                  : "Fetching prices…"}
              </span>
            </div>
            {/* Live update indicator */}
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground border-l border-border/50 pl-3">
              {isConnected ? (
                <Wifi className="w-3 h-3 text-green-500" />
              ) : (
                <WifiOff className="w-3 h-3 text-amber-500" />
              )}
              <span>Updated: {lastUpdateTime}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Info banner */}
      <div className="px-4 py-2 bg-muted/30 border-b border-border/50 flex items-center gap-2">
        <Clock className="w-3.5 h-3.5 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">
          Some platforms take up to 2–3 minutes to load final prices
        </span>
      </div>

      {/* Results table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border/50 bg-muted/20">
              <th className="text-left py-2 px-4 text-xs font-medium text-muted-foreground">Platform</th>
              <th className="text-center py-2 px-4 text-xs font-medium text-muted-foreground">Trust Score</th>
              <th className="text-right py-2 px-4 text-xs font-medium text-muted-foreground">Price</th>
              <th className="text-center py-2 px-4 text-xs font-medium text-muted-foreground">Action</th>
            </tr>
          </thead>
          <tbody>
            {results.map((result) => {
              const score = typeof result.confidence_score === "number" 
                ? Math.min(100, Math.round(result.confidence_score)) 
                : null;
              const isVisualMatch = result.match_type === "visual" && score !== null;

              // Get live extraction status for this platform
              const extraction = statusMap.get(result.platform_name.toLowerCase());
              const statusDisplay = getStatusDisplay(extraction);

              return (
                <tr key={result.id} className="border-b border-border/30 hover:bg-muted/20 transition-colors">
                  {/* Platform name */}
                  <td className="py-3 px-4">
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-primary/60" />
                      <span className="font-medium text-foreground">{result.platform_name}</span>
                    </div>
                  </td>

                  {/* Trust score */}
                  <td className="py-3 px-4 text-center">
                    {isVisualMatch ? (
                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-green-500/10 text-green-600 text-xs font-medium">
                        <Shield className="w-3 h-3" />
                        {score}%
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-amber-500/10 text-amber-600 text-xs font-medium">
                        <Info className="w-3 h-3" />
                        Text
                      </span>
                    )}
                  </td>

                  {/* Live price status */}
                  <td className="py-3 px-4 text-right">
                    <div className={`flex items-center justify-end gap-2 ${statusDisplay.color}`}>
                      {statusDisplay.icon}
                      <span className="text-sm font-medium">{statusDisplay.text}</span>
                    </div>
                  </td>

                  {/* Action */}
                  <td className="py-3 px-4 text-center">
                    <Button variant="outline" size="sm" asChild>
                      <a href={result.listing_url} target="_blank" rel="noopener noreferrer">
                        View <ExternalLink className="w-3 h-3 ml-1" />
                      </a>
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
