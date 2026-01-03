import React, { useState } from "react";
import { 
  CheckCircle, 
  Ban, 
  AlertCircle, 
  Clock, 
  ChevronDown, 
  ChevronUp,
  ExternalLink,
  Globe
} from "lucide-react";
import { cn } from "@/lib/utils";

interface ExtractionRecord {
  id: string;
  platform_name: string;
  extraction_status: string;
  extracted_price: number | null;
  extraction_error: string | null;
  deep_link?: string;
}

interface ExtractionStatusSummaryProps {
  extractions: ExtractionRecord[];
  isExtracting: boolean;
}

// Categorize extractions by outcome
type Category = 'verified' | 'unverified' | 'blocked' | 'failed' | 'pending';

interface CategoryConfig {
  label: string;
  icon: React.ReactNode;
  colorClass: string;
  bgClass: string;
  borderClass: string;
  dotClass: string;
}

const CATEGORY_CONFIG: Record<Category, CategoryConfig> = {
  verified: {
    label: 'Verified prices',
    icon: <CheckCircle className="w-4 h-4" />,
    colorClass: 'text-success',
    bgClass: 'bg-success/10',
    borderClass: 'border-success/20',
    dotClass: 'bg-success',
  },
  unverified: {
    label: 'Price fetched (unverified)',
    icon: <AlertCircle className="w-4 h-4" />,
    colorClass: 'text-amber-500',
    bgClass: 'bg-amber-500/10',
    borderClass: 'border-amber-500/20',
    dotClass: 'bg-amber-500',
  },
  blocked: {
    label: 'Blocked by platform',
    icon: <Ban className="w-4 h-4" />,
    colorClass: 'text-red-500',
    bgClass: 'bg-red-500/10',
    borderClass: 'border-red-500/20',
    dotClass: 'bg-red-500',
  },
  failed: {
    label: 'Extraction failed',
    icon: <AlertCircle className="w-4 h-4" />,
    colorClass: 'text-muted-foreground',
    bgClass: 'bg-muted/50',
    borderClass: 'border-border',
    dotClass: 'bg-muted-foreground',
  },
  pending: {
    label: 'In progress',
    icon: <Clock className="w-4 h-4" />,
    colorClass: 'text-primary',
    bgClass: 'bg-primary/10',
    borderClass: 'border-primary/20',
    dotClass: 'bg-primary animate-pulse',
  },
};

function categorizeExtraction(e: ExtractionRecord): Category {
  const status = e.extraction_status;
  
  if (status === 'pending' || status === 'running') {
    return 'pending';
  }
  
  if (status === 'blocked_captcha_or_bot' || status === 'blocked_captcha' || 
      status === 'blocked_rate_limit' || status === 'rate_limited_abort' || 
      status === 'bot_blocked_abort') {
    return 'blocked';
  }
  
  if (status === 'success' && e.extracted_price !== null) {
    // For now, treat all successful extractions as unverified
    // since we don't have structural proof in the basic extraction record
    return 'unverified';
  }
  
  return 'failed';
}

function getFailureReason(e: ExtractionRecord): string {
  const status = e.extraction_status;
  
  switch (status) {
    case 'blocked_captcha_or_bot':
    case 'blocked_captcha':
      return 'Bot detection';
    case 'blocked_rate_limit':
    case 'rate_limited_abort':
      return 'Rate limited';
    case 'bot_blocked_abort':
      return 'Access blocked';
    case 'render_failed':
      return 'Page failed to load';
    case 'dates_not_applied':
      return 'Dates not applied';
    case 'price_not_found':
      return 'Price not visible';
    case 'no_availability_for_dates':
      return 'Not available';
    default:
      return e.extraction_error?.slice(0, 30) || 'Unknown error';
  }
}

export function ExtractionStatusSummary({ 
  extractions, 
  isExtracting 
}: ExtractionStatusSummaryProps) {
  const [expandedCategory, setExpandedCategory] = useState<Category | null>(null);
  
  // Group extractions by category
  const grouped = extractions.reduce((acc, e) => {
    const cat = categorizeExtraction(e);
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(e);
    return acc;
  }, {} as Record<Category, ExtractionRecord[]>);
  
  // Order of display
  const categoryOrder: Category[] = ['verified', 'unverified', 'pending', 'blocked', 'failed'];
  const activeCategories = categoryOrder.filter(c => grouped[c]?.length > 0);
  
  if (extractions.length === 0) return null;
  
  return (
    <div className="mb-6 rounded-xl bg-muted/30 border border-border overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border/50 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {isExtracting ? (
            <>
              <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
              <span className="text-sm font-medium text-foreground">Fetching live prices...</span>
            </>
          ) : (
            <>
              <CheckCircle className="w-4 h-4 text-success" />
              <span className="text-sm font-medium text-foreground">Price extraction complete</span>
            </>
          )}
        </div>
        <span className="text-xs text-muted-foreground">
          {extractions.length} platform{extractions.length !== 1 ? 's' : ''}
        </span>
      </div>
      
      {/* Category rows */}
      <div className="divide-y divide-border/50">
        {activeCategories.map(category => {
          const config = CATEGORY_CONFIG[category];
          const items = grouped[category];
          const isExpanded = expandedCategory === category;
          
          return (
            <div key={category}>
              {/* Category header - clickable */}
              <button
                onClick={() => setExpandedCategory(isExpanded ? null : category)}
                className="w-full px-4 py-2.5 flex items-center justify-between hover:bg-muted/50 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <span className={cn("w-2 h-2 rounded-full", config.dotClass)} />
                  <span className={cn("text-sm font-medium", config.colorClass)}>
                    {items.length} {config.label.toLowerCase()}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {isExpanded ? (
                    <ChevronUp className="w-4 h-4 text-muted-foreground" />
                  ) : (
                    <ChevronDown className="w-4 h-4 text-muted-foreground" />
                  )}
                </div>
              </button>
              
              {/* Expanded content */}
              {isExpanded && (
                <div className={cn("px-4 pb-3 pt-1", config.bgClass)}>
                  <div className="space-y-2">
                    {items.map(e => (
                      <div 
                        key={e.id}
                        className={cn(
                          "flex items-center justify-between px-3 py-2 rounded-lg bg-background/80 border",
                          config.borderClass
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <Globe className="w-3.5 h-3.5 text-muted-foreground" />
                          <span className="text-sm font-medium text-foreground">
                            {e.platform_name}
                          </span>
                        </div>
                        <div className="flex items-center gap-3">
                          {category === 'unverified' && e.extracted_price !== null && (
                            <span className="text-sm text-foreground">
                              ${e.extracted_price.toLocaleString()}
                            </span>
                          )}
                          {(category === 'blocked' || category === 'failed') && (
                            <span className="text-xs text-muted-foreground">
                              {getFailureReason(e)}
                            </span>
                          )}
                          {e.deep_link && (
                            <a
                              href={e.deep_link}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-muted-foreground hover:text-foreground transition-colors"
                              onClick={(ev) => ev.stopPropagation()}
                            >
                              <ExternalLink className="w-3.5 h-3.5" />
                            </a>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
