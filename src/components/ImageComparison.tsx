import { useState } from "react";
import { ChevronLeft, ChevronRight, Check, X, ImageIcon, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface ImageComparisonProps {
  airbnbImages: string[];
  alternativeImages: string[];
  airbnbTitle: string;
  alternativeTitle: string;
  platformName: string;
}

export function ImageComparison({
  airbnbImages,
  alternativeImages,
  airbnbTitle,
  alternativeTitle,
  platformName,
}: ImageComparisonProps) {
  const [airbnbIndex, setAirbnbIndex] = useState(0);
  const [altIndex, setAltIndex] = useState(0);

  const hasAirbnbImages = airbnbImages.length > 0;
  const hasAltImages = alternativeImages.length > 0;

  if (!hasAirbnbImages && !hasAltImages) {
    return null;
  }

  return (
    <div className="bg-card rounded-xl border border-border p-4 mb-4">
      <div className="flex items-center gap-2 mb-4">
        <span className="text-sm font-medium text-foreground">Visual Comparison</span>
        <ArrowRight className="w-4 h-4 text-muted-foreground" />
        <span className="text-sm text-muted-foreground">Compare photos side-by-side</span>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {/* Airbnb Side */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-[#FF5A5F]" />
            <span className="text-xs font-medium text-foreground">Airbnb</span>
          </div>
          
          <div className="relative aspect-[4/3] rounded-lg overflow-hidden bg-muted">
            {hasAirbnbImages ? (
              <>
                <img
                  src={airbnbImages[airbnbIndex]}
                  alt={`${airbnbTitle} - Photo ${airbnbIndex + 1}`}
                  className="w-full h-full object-cover"
                  onError={(e) => {
                    const target = e.target as HTMLImageElement;
                    target.src = '/placeholder.svg';
                  }}
                />
                
                {airbnbImages.length > 1 && (
                  <>
                    <button
                      onClick={() => setAirbnbIndex((prev) => (prev === 0 ? airbnbImages.length - 1 : prev - 1))}
                      className="absolute left-1 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-background/80 flex items-center justify-center hover:bg-background transition-colors"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => setAirbnbIndex((prev) => (prev === airbnbImages.length - 1 ? 0 : prev + 1))}
                      className="absolute right-1 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-background/80 flex items-center justify-center hover:bg-background transition-colors"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </button>
                    <div className="absolute bottom-1 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-full bg-background/80 text-xs">
                      {airbnbIndex + 1}/{airbnbImages.length}
                    </div>
                  </>
                )}
              </>
            ) : (
              <div className="w-full h-full flex items-center justify-center">
                <ImageIcon className="w-8 h-8 text-muted-foreground" />
              </div>
            )}
          </div>
          
          <p className="text-xs text-muted-foreground line-clamp-1">{airbnbTitle}</p>
        </div>

        {/* Alternative Side */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-primary" />
            <span className="text-xs font-medium text-foreground">{platformName}</span>
          </div>
          
          <div className="relative aspect-[4/3] rounded-lg overflow-hidden bg-muted">
            {hasAltImages ? (
              <>
                <img
                  src={alternativeImages[altIndex]}
                  alt={`${alternativeTitle} - Photo ${altIndex + 1}`}
                  className="w-full h-full object-cover"
                  onError={(e) => {
                    const target = e.target as HTMLImageElement;
                    target.src = '/placeholder.svg';
                  }}
                />
                
                {alternativeImages.length > 1 && (
                  <>
                    <button
                      onClick={() => setAltIndex((prev) => (prev === 0 ? alternativeImages.length - 1 : prev - 1))}
                      className="absolute left-1 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-background/80 flex items-center justify-center hover:bg-background transition-colors"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => setAltIndex((prev) => (prev === alternativeImages.length - 1 ? 0 : prev + 1))}
                      className="absolute right-1 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-background/80 flex items-center justify-center hover:bg-background transition-colors"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </button>
                    <div className="absolute bottom-1 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-full bg-background/80 text-xs">
                      {altIndex + 1}/{alternativeImages.length}
                    </div>
                  </>
                )}
              </>
            ) : (
              <div className="w-full h-full flex items-center justify-center">
                <ImageIcon className="w-8 h-8 text-muted-foreground" />
              </div>
            )}
          </div>
          
          <p className="text-xs text-muted-foreground line-clamp-1">{alternativeTitle || "Alternative Listing"}</p>
        </div>
      </div>

      {hasAirbnbImages && hasAltImages && (
        <div className="mt-3 pt-3 border-t border-border flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <span>Compare the images to verify this is the same property</span>
        </div>
      )}
    </div>
  );
}
