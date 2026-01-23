import React from "react";
import { Loader2, CheckCircle, Shield, TrendingDown } from "lucide-react";

/**
 * Search Phase Banner
 * 
 * Displays a contextual banner indicating the current phase of the search:
 * - Phase 1 (DISCOVERY_COMPLETE): Matches found, prices loading
 * - Phase 2 (COMPLETE): Final results ready with price rankings
 */

export type SearchPhaseType = "discovery_pricing" | "complete";

interface SearchPhaseBannerProps {
  phase: SearchPhaseType;
  matchCount?: number;
  cheaperCount?: number;
}

export function SearchPhaseBanner({ phase, matchCount, cheaperCount }: SearchPhaseBannerProps) {
  if (phase === "discovery_pricing") {
    return (
      <div className="mb-6 p-4 rounded-xl bg-primary/10 border border-primary/30">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center">
            <Loader2 className="w-5 h-5 text-primary animate-spin" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Shield className="w-4 h-4 text-primary" />
              {matchCount 
                ? `${matchCount} verified match${matchCount !== 1 ? "es" : ""} found`
                : "Matches found"}
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Fetching final prices from each platform… Rankings will appear once complete.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Phase 2: Complete
  return (
    <div className="mb-6 p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-emerald-500/20 flex items-center justify-center">
          <CheckCircle className="w-5 h-5 text-emerald-600" />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
            {cheaperCount && cheaperCount > 0 ? (
              <>
                <TrendingDown className="w-4 h-4 text-emerald-600" />
                {cheaperCount} cheaper alternative{cheaperCount !== 1 ? "s" : ""} found!
              </>
            ) : (
              "Final results ready"
            )}
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Rankings updated using final verified prices from all platforms.
          </p>
        </div>
      </div>
    </div>
  );
}
