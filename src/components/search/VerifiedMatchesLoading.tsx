import React from "react";
import { Shield, Loader2, ExternalLink, Info, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Json } from "@/integrations/supabase/types";

/**
 * Phase 1 UI Component: Verified Matches (Prices Loading)
 * 
 * Displays verified image matches while prices are still being extracted.
 * This component is shown after image verification completes but before
 * finalization (price extraction) is complete.
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

interface VerifiedMatchesLoadingProps {
  results: VerifiedMatchLoadingItem[];
  pricingProgress?: {
    completed: number;
    total: number;
  };
}

const toStringArray = (json: Json | null | undefined): string[] => {
  if (!json) return [];
  if (Array.isArray(json)) {
    return json.filter((item): item is string => typeof item === "string");
  }
  return [];
};

export function VerifiedMatchesLoading({ results, pricingProgress }: VerifiedMatchesLoadingProps) {
  if (results.length === 0) return null;

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
          <div className="flex items-center gap-2">
            <Loader2 className="w-4 h-4 text-primary animate-spin" />
            <span className="text-xs text-muted-foreground">
              {pricingProgress
                ? `Fetching prices (${pricingProgress.completed}/${pricingProgress.total})…`
                : "Fetching prices…"}
            </span>
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

                  {/* Price placeholder */}
                  <td className="py-3 px-4 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <Loader2 className="w-3.5 h-3.5 text-muted-foreground animate-spin" />
                      <span className="text-sm text-muted-foreground italic">Fetching price…</span>
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
