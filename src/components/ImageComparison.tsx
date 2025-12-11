import { useState } from "react";
import { ChevronLeft, ChevronRight, ImageIcon, ArrowLeftRight, Check, AlertCircle } from "lucide-react";

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
    <div className="bg-muted/30 rounded-2xl p-4 md:p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <ArrowLeftRight className="w-5 h-5 text-primary" />
          <span className="font-semibold text-foreground">Side-by-Side Photo Comparison</span>
        </div>
        <span className="text-xs text-muted-foreground px-2 py-1 bg-background rounded-full">
          Verify this is the same property
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6">
        {/* Airbnb Side */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full bg-[#FF5A5F]" />
            <span className="text-sm font-semibold text-foreground">Airbnb (Original)</span>
          </div>
          
          <div className="relative aspect-[4/3] rounded-xl overflow-hidden bg-muted shadow-medium">
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
                      className="absolute left-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-background/90 shadow-soft flex items-center justify-center hover:bg-background transition-colors"
                    >
                      <ChevronLeft className="w-5 h-5" />
                    </button>
                    <button
                      onClick={() => setAirbnbIndex((prev) => (prev === airbnbImages.length - 1 ? 0 : prev + 1))}
                      className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-background/90 shadow-soft flex items-center justify-center hover:bg-background transition-colors"
                    >
                      <ChevronRight className="w-5 h-5" />
                    </button>
                    <div className="absolute bottom-2 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-background/90 text-xs font-medium shadow-soft">
                      {airbnbIndex + 1} / {airbnbImages.length}
                    </div>
                  </>
                )}
              </>
            ) : (
              <div className="w-full h-full flex flex-col items-center justify-center gap-2">
                <ImageIcon className="w-10 h-10 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">No photos available</span>
              </div>
            )}
          </div>
          
          <p className="text-sm text-muted-foreground line-clamp-2">{airbnbTitle}</p>
        </div>

        {/* Alternative Side */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full bg-primary" />
            <span className="text-sm font-semibold text-foreground">{platformName}</span>
          </div>
          
          <div className="relative aspect-[4/3] rounded-xl overflow-hidden bg-muted shadow-medium">
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
                      className="absolute left-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-background/90 shadow-soft flex items-center justify-center hover:bg-background transition-colors"
                    >
                      <ChevronLeft className="w-5 h-5" />
                    </button>
                    <button
                      onClick={() => setAltIndex((prev) => (prev === alternativeImages.length - 1 ? 0 : prev + 1))}
                      className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-background/90 shadow-soft flex items-center justify-center hover:bg-background transition-colors"
                    >
                      <ChevronRight className="w-5 h-5" />
                    </button>
                    <div className="absolute bottom-2 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-background/90 text-xs font-medium shadow-soft">
                      {altIndex + 1} / {alternativeImages.length}
                    </div>
                  </>
                )}
              </>
            ) : (
              <div className="w-full h-full flex flex-col items-center justify-center gap-2">
                <AlertCircle className="w-10 h-10 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">No photos from this platform</span>
              </div>
            )}
          </div>
          
          <p className="text-sm text-muted-foreground line-clamp-2">{alternativeTitle || "Alternative Listing"}</p>
        </div>
      </div>

      {/* Footer tip */}
      {hasAirbnbImages && hasAltImages && (
        <div className="mt-4 pt-4 border-t border-border flex items-center justify-center gap-2">
          <Check className="w-4 h-4 text-success" />
          <span className="text-sm text-muted-foreground">
            Look for matching room layouts, furniture, and views to confirm it's the same property
          </span>
        </div>
      )}
    </div>
  );
}
