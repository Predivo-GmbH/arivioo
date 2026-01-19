import React from "react";
import { Link } from "react-router-dom";
import { Shield, Info, ExternalLink, ArrowLeftRight, Camera, Ban, Calendar, Lock, Check, CheckCircle, Sparkles, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ImageComparison } from "@/components/ImageComparison";
import { ExpediaDebugReveal } from "@/components/ExpediaDebugReveal";
import type { CanonicalPrice } from "@/lib/canonicalPrice";
import type { CategorizedResult } from "@/lib/resultCategorization";

export interface ResultRowResult {
  id: string;
  platform_name: string;
  listing_url: string;
  listing_title?: string | null;
  match_type?: string | null;
  confidence_score?: number | null;
  price?: number | null;
  images?: string[] | null;
  source_airbnb_image?: string | null;
  extraction_status?: string | null;
  extraction_error?: string | null;
  extraction_metadata?: any;
  canonical_price?: CanonicalPrice | null;
  dates_differ?: boolean | null;
  eligible_for_comparison?: boolean;
  // TWO-PASS IMAGE VERIFICATION: Authority status
  // is_authoritative = true means PASS 2 >= 90% (high trust, "Verified")
  // is_authoritative = false/undefined means PASS 1 passed but needs review
  is_authoritative?: boolean;
}

export type RowVariant = 
  | 'cheaper'          // Main results (cheaper than Airbnb)
  | 'more_expensive'   // More expensive than Airbnb
  | 'unverified'       // Price fetched but unverified
  | 'blocked'          // Blocked by platform
  | 'sold_out'         // Unavailable for dates
  | 'failed'           // Extraction failed
  | 'additional_issues'; // Unmapped outcomes

interface ResultRowProps {
  result: ResultRowResult;
  variant: RowVariant;
  // UI state
  isExpanded: boolean;
  onToggleExpand: (id: string) => void;
  // Context for display
  airbnbImages: string[];
  airbnbTitle: string;
  searchId?: string;
  currencySymbol: string;
  airbnbTotal?: number | null;
  // Optional: computed values for specific variants
  effectivePrice?: number | null;
  priceDiff?: number | null;
  isCheapest?: boolean;
  keyDifferences?: string[];
  failureDisplayText?: string;
  // Categorization for debug
  getResultCategorization?: (id: string) => CategorizedResult | null;
  // Columns config
  colSpan?: number;
  showKeyDifferencesColumn?: boolean;
}

// Helper to format price
const formatUSDPrice = (amount: number | null | undefined): string => {
  if (!amount || amount < 10) return '—';
  return Math.round(amount).toLocaleString('en-US');
};

// Helper to convert to string array
const toStringArray = (images: any): string[] => {
  if (!images) return [];
  if (Array.isArray(images)) return images.filter((img): img is string => typeof img === 'string' && img.length > 0);
  return [];
};

export function ResultRow({
  result,
  variant,
  isExpanded,
  onToggleExpand,
  airbnbImages,
  airbnbTitle,
  searchId,
  currencySymbol,
  airbnbTotal,
  effectivePrice,
  priceDiff,
  isCheapest = false,
  keyDifferences = [],
  failureDisplayText,
  getResultCategorization,
  colSpan = 4,
  showKeyDifferencesColumn = false,
}: ResultRowProps) {
  const resultImages = toStringArray(result.images);
  
  // Determine accent color based on variant
  const getAccentColor = () => {
    switch (variant) {
      case 'cheaper':
        return isCheapest ? 'bg-success' : 'bg-blue-500';
      case 'more_expensive':
        return 'bg-muted-foreground';
      case 'unverified':
        return 'bg-amber-500';
      case 'blocked':
        return 'bg-red-500';
      case 'sold_out':
        return 'bg-orange-500';
      case 'failed':
        return 'bg-muted-foreground';
      case 'additional_issues':
        return 'bg-amber-500';
      default:
        return 'bg-muted-foreground';
    }
  };

  // Render platform name cell
  const renderPlatformCell = () => {
    const accentColor = getAccentColor();
    
    // Determine image verification authority status
    // is_authoritative = true → PASS 2 >= 90% (high trust)
    // is_authoritative = false/undefined → PASS 1 passed but needs review
    const isAuthoritative = result.is_authoritative === true;
    const needsReview = result.is_authoritative === false;
    
    return (
      <td className="py-4 px-4">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`w-2 h-2 rounded-full ${accentColor}`} />
          <span className="font-medium text-foreground">{result.platform_name}</span>
          
          {/* Best Deal badge for cheapest */}
          {variant === 'cheaper' && isCheapest && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-success/20 text-success text-xs font-medium">
              <Sparkles className="w-3 h-3" />
              Best Deal
            </span>
          )}
          
          {/* TWO-PASS IMAGE VERIFICATION BADGES */}
          {/* Authoritative badge (PASS 2 >= 90%): High trust, verified match */}
          {isAuthoritative && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-green-500/10 text-green-600 text-[10px] font-medium cursor-help">
                    <CheckCircle className="w-2.5 h-2.5" />
                    Verified
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-[200px] text-center">
                  <p className="text-xs">High-confidence match. Photos verified as the same property through multiple checks.</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          
          {/* Needs Review badge (PASS 1 passed, PASS 2 < 90%): Discovered but lower confidence */}
          {needsReview && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 text-[10px] font-medium cursor-help">
                    <AlertTriangle className="w-2.5 h-2.5" />
                    Needs Review
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-[200px] text-center">
                  <p className="text-xs">Likely match based on photo analysis. We recommend comparing photos before booking.</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          
          {/* Blocked badge */}
          {variant === 'blocked' && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-500/10 text-red-600 text-[10px] font-medium">
              <Ban className="w-2.5 h-2.5" />
              Blocked
            </span>
          )}
        </div>
      </td>
    );
  };

  // Render trust score cell
  const renderTrustScoreCell = () => {
    const hasVisualMatch = result.match_type === "visual" && result.confidence_score;
    const score = result.confidence_score ? Math.min(100, Math.round(result.confidence_score)) : null;
    
    // Color variations based on variant
    const getScoreStyle = () => {
      if (!hasVisualMatch) {
        // Text match fallback
        if (variant === 'cheaper') {
          return 'bg-amber-500/10 text-amber-600 dark:text-amber-400';
        }
        return 'bg-amber-500/10 text-amber-600';
      }
      
      // Visual match with score - use consistent styling across all variants
      if (score && score >= 90) {
        return 'bg-success/20 text-success';
      }
      if (score && score >= 75) {
        return 'bg-green-500/10 text-green-600';
      }
      return 'bg-amber-500/10 text-amber-600';
    };
    
    return (
      <td className="py-4 px-4 text-center">
        {hasVisualMatch ? (
          <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${getScoreStyle()}`}>
            <Shield className="w-3 h-3" />
            {score}%
          </span>
        ) : (
          <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${getScoreStyle()}`}>
            <Info className="w-3 h-3" />
            Text
          </span>
        )}
      </td>
    );
  };

  // Render price/status cell
  const renderPriceCell = () => {
    switch (variant) {
      case 'cheaper':
        return (
          <td className={`py-4 px-4 text-right font-semibold ${isCheapest ? 'text-success text-lg' : 'text-foreground'}`}>
            {result.price && result.price >= 10 ? `${currencySymbol}${Math.round(result.price)}` : '—'}
          </td>
        );
        
      case 'more_expensive':
        return (
          <td className="py-4 px-4 text-right">
            <div className="flex flex-col items-end gap-0.5">
              <span className="font-semibold text-foreground">
                {currencySymbol}{formatUSDPrice(effectivePrice)}
              </span>
              {priceDiff !== undefined && priceDiff !== null && (
                <span className="text-xs text-muted-foreground">
                  (+{currencySymbol}{formatUSDPrice(priceDiff)})
                </span>
              )}
              <ExpediaDebugReveal
                platformName={result.platform_name}
                canonicalPrice={result.canonical_price || null}
                categorization={getResultCategorization?.(result.id) || null}
                extractionMetadata={result.extraction_metadata}
                airbnbTotal={airbnbTotal}
              />
            </div>
          </td>
        );
        
      case 'unverified':
        return (
          <td className="py-4 px-4 text-right">
            <div className="flex flex-col items-end gap-0.5">
              <span className="text-sm font-medium text-foreground">
                {currencySymbol}{formatUSDPrice(effectivePrice)}
              </span>
              <span className="text-xs text-amber-600">{failureDisplayText}</span>
              <ExpediaDebugReveal
                platformName={result.platform_name}
                canonicalPrice={result.canonical_price || null}
                categorization={getResultCategorization?.(result.id) || null}
                extractionMetadata={result.extraction_metadata}
                airbnbTotal={airbnbTotal}
              />
            </div>
          </td>
        );
        
      case 'blocked':
        return (
          <td className="py-4 px-4 text-right text-muted-foreground">
            <span className="text-sm text-red-500">{failureDisplayText}</span>
          </td>
        );
        
      case 'sold_out':
        return (
          <td className="py-4 px-4 text-right text-muted-foreground">
            <span className="text-sm text-orange-600">{failureDisplayText}</span>
          </td>
        );
        
      case 'failed':
        return (
          <td className="py-4 px-4 text-right text-muted-foreground">
            <span className="text-sm">{failureDisplayText}</span>
          </td>
        );
        
      case 'additional_issues':
        const errorDetail = result.extraction_status || result.extraction_error || 'Unknown issue';
        return (
          <td className="py-4 px-4 text-right text-muted-foreground">
            <div className="flex flex-col items-end gap-0.5">
              <span className="text-sm text-amber-600">Outcome not classified</span>
              <span className="text-[10px] text-muted-foreground/70 font-mono truncate max-w-[150px]" title={errorDetail}>
                {errorDetail}
              </span>
            </div>
          </td>
        );
        
      default:
        return <td className="py-4 px-4 text-right">—</td>;
    }
  };

  // Render key differences column (only for main results)
  const renderKeyDifferencesCell = () => {
    if (!showKeyDifferencesColumn) return null;
    
    return (
      <td className="py-4 px-4 hidden lg:table-cell">
        <div className="flex flex-col gap-1">
          <span className={`text-xs ${isCheapest ? 'text-success flex items-center gap-1' : 'text-muted-foreground'}`}>
            {isCheapest && <Check className="w-3 h-3" />}
            {keyDifferences.slice(0, 2).join(', ')}
          </span>
          {result.dates_differ && (
            <span className="text-[10px] text-amber-600 dark:text-amber-400">
              *Original dates unavailable
            </span>
          )}
        </div>
      </td>
    );
  };

  // Render action cell
  const renderActionCell = () => {
    const renderViewButton = () => {
      // Special case: cheapest result gets unlock button
      if (variant === 'cheaper' && isCheapest && searchId) {
        return (
          <Button size="sm" className="bg-success hover:bg-success/90" asChild>
            <Link to={`/unlock?resultId=${result.id}&searchId=${searchId}`}>
              <Lock className="w-3 h-3 mr-1" />
              Unlock
              <ExternalLink className="w-3 h-3 ml-1" />
            </Link>
          </Button>
        );
      }
      
      // Regular view button
      const buttonText = variant === 'cheaper' && !isCheapest ? 'View Free' : 'View';
      
      return (
        <Button variant="outline" size="sm" asChild>
          <a href={result.listing_url} target="_blank" rel="noopener noreferrer">
            {buttonText} <ExternalLink className="w-3 h-3 ml-1" />
          </a>
        </Button>
      );
    };
    
    return (
      <td className="py-4 px-4 text-center">
        <div className="flex flex-col gap-1.5 items-center">
          {renderViewButton()}
          <button
            onClick={() => onToggleExpand(result.id)}
            className={`text-xs px-2 py-1 rounded transition-colors flex items-center gap-1 ${
              isExpanded ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-primary'
            }`}
          >
            <ArrowLeftRight className="w-3 h-3" />
            {isExpanded ? 'Hide' : 'Photos'}
          </button>
        </div>
      </td>
    );
  };

  // Render photo comparison row
  const renderPhotoComparisonRow = () => {
    if (!isExpanded) return null;
    
    const hasPhotos = resultImages.length > 0 || airbnbImages.length > 0 || result.source_airbnb_image;
    
    return (
      <tr className="border-b border-border/50">
        <td colSpan={colSpan} className="p-4 bg-muted/30">
          {hasPhotos ? (
            <ImageComparison
              airbnbImages={airbnbImages}
              alternativeImages={resultImages}
              airbnbTitle={airbnbTitle}
              alternativeTitle={result.listing_title || "Alternative Listing"}
              platformName={result.platform_name}
              sourceAirbnbImage={result.source_airbnb_image}
            />
          ) : (
            <div className="text-center py-6 text-muted-foreground">
              <Camera className="w-8 h-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">No photos available for comparison</p>
            </div>
          )}
        </td>
      </tr>
    );
  };

  // Get row styling
  const getRowClassName = () => {
    if (variant === 'cheaper' && isCheapest) {
      return 'bg-success/5 border-2 border-success/30';
    }
    if (variant === 'cheaper') {
      return 'border-b border-border hover:bg-muted/50';
    }
    return 'border-b border-border/50 hover:bg-muted/30';
  };

  return (
    <React.Fragment>
      <tr className={getRowClassName()}>
        {renderPlatformCell()}
        {renderTrustScoreCell()}
        {renderPriceCell()}
        {renderKeyDifferencesCell()}
        {renderActionCell()}
      </tr>
      {renderPhotoComparisonRow()}
    </React.Fragment>
  );
}
