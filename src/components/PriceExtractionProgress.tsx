import React from "react";
import { Check, Loader2, AlertCircle, Clock, Ban } from "lucide-react";
import { cn } from "@/lib/utils";

export interface PlatformExtractionStatus {
  platformName: string;
  status: 'pending' | 'running' | 'success' | 'blocked_captcha' | 'blocked_rate_limit' | 'dates_not_applied' | 'price_not_found' | 'failed_unknown';
  price: number | null;
  currency?: string;
  error?: string;
}

interface PriceExtractionProgressProps {
  platforms: PlatformExtractionStatus[];
  currentPlatform?: string;
  totalPlatforms: number;
  completedCount: number;
}

export function PriceExtractionProgress({
  platforms,
  currentPlatform,
  totalPlatforms,
  completedCount,
}: PriceExtractionProgressProps) {
  const getStatusIcon = (status: PlatformExtractionStatus['status']) => {
    switch (status) {
      case 'pending':
        return <Clock className="w-3.5 h-3.5 text-muted-foreground" />;
      case 'running':
        return <Loader2 className="w-3.5 h-3.5 text-primary animate-spin" />;
      case 'success':
        return <Check className="w-3.5 h-3.5 text-green-500" />;
      case 'blocked_captcha':
      case 'blocked_rate_limit':
        return <Ban className="w-3.5 h-3.5 text-amber-500" />;
      case 'dates_not_applied':
      case 'price_not_found':
      case 'failed_unknown':
        return <AlertCircle className="w-3.5 h-3.5 text-red-400" />;
      default:
        return <Clock className="w-3.5 h-3.5 text-muted-foreground" />;
    }
  };

  const getStatusLabel = (status: PlatformExtractionStatus['status']) => {
    switch (status) {
      case 'pending':
        return 'Waiting';
      case 'running':
        return 'Extracting...';
      case 'success':
        return 'Done';
      case 'blocked_captcha':
        return 'CAPTCHA';
      case 'blocked_rate_limit':
        return 'Rate limited';
      case 'dates_not_applied':
        return 'Dates failed';
      case 'price_not_found':
        return 'No price';
      case 'failed_unknown':
        return 'Failed';
      default:
        return 'Unknown';
    }
  };

  const successCount = platforms.filter(p => p.status === 'success').length;
  const failedCount = platforms.filter(p => ['blocked_captcha', 'blocked_rate_limit', 'dates_not_applied', 'price_not_found', 'failed_unknown'].includes(p.status)).length;
  const pendingCount = platforms.filter(p => p.status === 'pending' || p.status === 'running').length;

  return (
    <div className="space-y-4">
      {/* Summary bar */}
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">
          Collecting prices from {totalPlatforms} platforms...
        </span>
        <div className="flex items-center gap-3">
          {successCount > 0 && (
            <span className="text-green-500 flex items-center gap-1">
              <Check className="w-3.5 h-3.5" />
              {successCount} collected
            </span>
          )}
          {failedCount > 0 && (
            <span className="text-amber-500 flex items-center gap-1">
              <AlertCircle className="w-3.5 h-3.5" />
              {failedCount} unavailable
            </span>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
        <div 
          className="h-full bg-gradient-primary transition-all duration-500 ease-out"
          style={{ width: `${totalPlatforms > 0 ? (completedCount / totalPlatforms) * 100 : 0}%` }}
        />
      </div>

      {/* Platform list */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {platforms.map((platform) => (
          <div
            key={platform.platformName}
            className={cn(
              "flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-all",
              platform.status === 'running' && "bg-primary/10 border border-primary/20",
              platform.status === 'success' && "bg-green-500/10 border border-green-500/20",
              platform.status === 'pending' && "bg-muted/50",
              ['blocked_captcha', 'blocked_rate_limit', 'dates_not_applied', 'price_not_found', 'failed_unknown'].includes(platform.status) && "bg-red-500/10 border border-red-500/20"
            )}
          >
            {getStatusIcon(platform.status)}
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate">{platform.platformName}</div>
              <div className="text-xs text-muted-foreground">
                {platform.status === 'success' && platform.price 
                  ? `${platform.currency || '$'}${platform.price.toLocaleString()} total`
                  : getStatusLabel(platform.status)
                }
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
