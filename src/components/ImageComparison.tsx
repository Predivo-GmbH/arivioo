import { useState, useRef, useEffect } from "react";
import { ChevronLeft, ChevronRight, ImageIcon, ArrowLeftRight, Check, AlertCircle, ZoomIn, Move } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ImageComparisonProps {
  airbnbImages: string[];
  alternativeImages: string[];
  airbnbTitle: string;
  alternativeTitle: string;
  platformName: string;
  sourceAirbnbImage?: string | null; // The specific Airbnb image that matched this result
}

// Get context-aware helper text based on image characteristics
const getComparisonHelperText = (imageUrl: string): string => {
  const url = imageUrl.toLowerCase();
  // Check for common exterior/outdoor indicators
  if (url.includes('exterior') || url.includes('outside') || url.includes('facade') || url.includes('building')) {
    return "Compare exterior architecture, windows, and building details to confirm it's the same property";
  }
  if (url.includes('pool') || url.includes('garden') || url.includes('terrace') || url.includes('balcony')) {
    return "Compare outdoor features like landscaping, pool shape, and terrace layout";
  }
  if (url.includes('view') || url.includes('landscape')) {
    return "Compare the view and surrounding landscape to verify the location";
  }
  // Default for interior shots
  return "Compare room layouts, furniture placement, and unique fixtures to confirm it's the same property";
};

export function ImageComparison({
  airbnbImages,
  alternativeImages,
  airbnbTitle,
  alternativeTitle,
  platformName,
  sourceAirbnbImage,
}: ImageComparisonProps) {
  // Use the source image that matched if available, otherwise fall back to first image
  const referenceImage = sourceAirbnbImage || (airbnbImages.length > 0 ? airbnbImages[0] : null);
  const [altIndex, setAltIndex] = useState(0);
  const [sliderPosition, setSliderPosition] = useState(50);
  const [isDragging, setIsDragging] = useState(false);
  const [viewMode, setViewMode] = useState<'slider' | 'sideBySide'>('sideBySide');
  const [zoomedImage, setZoomedImage] = useState<string | null>(null);
  const sliderRef = useRef<HTMLDivElement>(null);

  const hasAirbnbImages = airbnbImages.length > 0;
  const hasAltImages = alternativeImages.length > 0;

  // Handle slider drag
  const handleMouseMove = (e: MouseEvent | TouchEvent) => {
    if (!isDragging || !sliderRef.current) return;
    
    const rect = sliderRef.current.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const x = clientX - rect.left;
    const percentage = Math.min(Math.max((x / rect.width) * 100, 5), 95);
    setSliderPosition(percentage);
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  useEffect(() => {
    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      window.addEventListener('touchmove', handleMouseMove);
      window.addEventListener('touchend', handleMouseUp);
      
      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
        window.removeEventListener('touchmove', handleMouseMove);
        window.removeEventListener('touchend', handleMouseUp);
      };
    }
  }, [isDragging]);

  if (!hasAirbnbImages && !hasAltImages) {
    return null;
  }

  return (
    <div className="bg-card rounded-2xl border border-border shadow-medium overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-muted/50 border-b border-border">
        <div className="flex items-center gap-2">
          <ArrowLeftRight className="w-5 h-5 text-primary" />
          <span className="font-semibold text-foreground">Photo Comparison</span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={viewMode === 'sideBySide' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setViewMode('sideBySide')}
            className="text-xs h-7 px-2"
          >
            Side by Side
          </Button>
          {hasAirbnbImages && hasAltImages && (
            <Button
              variant={viewMode === 'slider' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setViewMode('slider')}
              className="text-xs h-7 px-2"
            >
              Slider
            </Button>
          )}
        </div>
      </div>

      <div className="p-4 md:p-6">
        {viewMode === 'slider' && hasAirbnbImages && hasAltImages ? (
          // Slider Comparison View
          <div className="space-y-4">
            <div 
              ref={sliderRef}
              className="relative aspect-[16/10] rounded-xl overflow-hidden cursor-ew-resize select-none bg-muted"
              onMouseDown={() => setIsDragging(true)}
              onTouchStart={() => setIsDragging(true)}
            >
              {/* Alternative image (bottom layer) */}
              <img
                src={alternativeImages[altIndex]}
                alt={`${alternativeTitle} - ${platformName}`}
                className="absolute inset-0 w-full h-full object-cover"
                draggable={false}
                onError={(e) => {
                  const target = e.target as HTMLImageElement;
                  target.src = '/placeholder.svg';
                }}
              />
              
              {/* Airbnb image (top layer, clipped) - Always use first reference image */}
              <div 
                className="absolute inset-0 overflow-hidden"
                style={{ width: `${sliderPosition}%` }}
              >
                <img
                  src={referenceImage || '/placeholder.svg'}
                  alt={`${airbnbTitle} - Airbnb`}
                  className="absolute inset-0 w-full h-full object-cover"
                  style={{ 
                    width: sliderRef.current ? `${sliderRef.current.offsetWidth}px` : '100%',
                    maxWidth: 'none'
                  }}
                  draggable={false}
                  onError={(e) => {
                    const target = e.target as HTMLImageElement;
                    target.src = '/placeholder.svg';
                  }}
                />
              </div>
              
              {/* Slider handle */}
              <div 
                className="absolute top-0 bottom-0 w-1 bg-white shadow-lg cursor-ew-resize z-10"
                style={{ left: `${sliderPosition}%`, transform: 'translateX(-50%)' }}
              >
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-white shadow-lg flex items-center justify-center">
                  <Move className="w-5 h-5 text-muted-foreground" />
                </div>
              </div>
              
              {/* Labels */}
              <div className="absolute top-3 left-3 px-3 py-1.5 rounded-full bg-[#FF5A5F] text-white text-xs font-medium shadow-md flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-white/80" />
                Airbnb
              </div>
              <div className="absolute top-3 right-3 px-3 py-1.5 rounded-full bg-primary text-white text-xs font-medium shadow-md flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-white/80" />
                {platformName}
              </div>
              
              {/* Drag instruction */}
              <div className="absolute bottom-3 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full bg-background/90 text-xs font-medium shadow-md backdrop-blur-sm">
                Drag to compare
              </div>
            </div>
            
            {/* Image navigation - only for alternative images */}
            <div className="flex justify-center gap-4">
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">{platformName} photos:</span>
                <div className="flex gap-1">
                  {alternativeImages.map((_, i) => (
                    <button
                      key={i}
                      onClick={() => setAltIndex(i)}
                      className={`w-2 h-2 rounded-full transition-colors ${
                        i === altIndex ? 'bg-primary' : 'bg-muted-foreground/30'
                      }`}
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>
        ) : (
          // Side by Side View - Always use fixed reference image for Airbnb
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6">
            {/* Airbnb Side - Fixed reference image */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-3 h-3 rounded-full bg-[#FF5A5F]" />
                  <span className="text-sm font-semibold text-foreground">Airbnb (Reference)</span>
                </div>
                {referenceImage && (
                  <button
                    onClick={() => setZoomedImage(referenceImage)}
                    className="p-1.5 rounded-lg hover:bg-muted transition-colors"
                    title="Zoom in"
                  >
                    <ZoomIn className="w-4 h-4 text-muted-foreground" />
                  </button>
                )}
              </div>
              
              <div className="relative aspect-[4/3] rounded-xl overflow-hidden bg-muted shadow-soft group">
                {referenceImage ? (
                  <>
                    <img
                      src={referenceImage}
                      alt={`${airbnbTitle} - Reference Photo`}
                      className="w-full h-full object-cover cursor-zoom-in transition-transform duration-300 group-hover:scale-105"
                      onClick={() => setZoomedImage(referenceImage)}
                      onError={(e) => {
                        const target = e.target as HTMLImageElement;
                        target.src = '/placeholder.svg';
                      }}
                    />
                    {/* Fixed reference indicator */}
                    <div className="absolute bottom-2 left-2 px-2 py-1 rounded-full bg-[#FF5A5F]/90 text-white text-xs font-medium">
                      Reference Image
                    </div>
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
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-3 h-3 rounded-full bg-primary" />
                  <span className="text-sm font-semibold text-foreground">{platformName}</span>
                </div>
                {hasAltImages && (
                  <button
                    onClick={() => setZoomedImage(alternativeImages[altIndex])}
                    className="p-1.5 rounded-lg hover:bg-muted transition-colors"
                    title="Zoom in"
                  >
                    <ZoomIn className="w-4 h-4 text-muted-foreground" />
                  </button>
                )}
              </div>
              
              <div className="relative aspect-[4/3] rounded-xl overflow-hidden bg-muted shadow-soft group">
                {hasAltImages ? (
                  <>
                    <img
                      src={alternativeImages[altIndex]}
                      alt={`${alternativeTitle} - Photo ${altIndex + 1}`}
                      className="w-full h-full object-cover cursor-zoom-in transition-transform duration-300 group-hover:scale-105"
                      onClick={() => setZoomedImage(alternativeImages[altIndex])}
                      onError={(e) => {
                        const target = e.target as HTMLImageElement;
                        target.src = '/placeholder.svg';
                      }}
                    />
                    
                    {alternativeImages.length > 1 && (
                      <>
                        <button
                          onClick={() => setAltIndex((prev) => (prev === 0 ? alternativeImages.length - 1 : prev - 1))}
                          className="absolute left-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-background/90 shadow-soft flex items-center justify-center hover:bg-background transition-colors opacity-0 group-hover:opacity-100"
                        >
                          <ChevronLeft className="w-5 h-5" />
                        </button>
                        <button
                          onClick={() => setAltIndex((prev) => (prev === alternativeImages.length - 1 ? 0 : prev + 1))}
                          className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-background/90 shadow-soft flex items-center justify-center hover:bg-background transition-colors opacity-0 group-hover:opacity-100"
                        >
                          <ChevronRight className="w-5 h-5" />
                        </button>
                        <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex gap-1.5">
                          {alternativeImages.map((_, i) => (
                            <button
                              key={i}
                              onClick={() => setAltIndex(i)}
                              className={`w-2 h-2 rounded-full transition-all ${
                                i === altIndex 
                                  ? 'bg-white scale-125' 
                                  : 'bg-white/50 hover:bg-white/75'
                              }`}
                            />
                          ))}
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
        )}

        {/* Footer tip - Context-aware text */}
        {referenceImage && hasAltImages && (
          <div className="mt-4 pt-4 border-t border-border flex items-center justify-center gap-2">
            <Check className="w-4 h-4 text-success" />
            <span className="text-sm text-muted-foreground">
              {getComparisonHelperText(referenceImage)}
            </span>
          </div>
        )}
      </div>

      {/* Zoom Modal */}
      {zoomedImage && (
        <div 
          className="fixed inset-0 z-50 bg-background/90 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in"
          onClick={() => setZoomedImage(null)}
        >
          <div className="relative max-w-5xl max-h-[90vh] w-full">
            <img
              src={zoomedImage}
              alt="Zoomed view"
              className="w-full h-full object-contain rounded-lg shadow-large"
            />
            <button
              onClick={() => setZoomedImage(null)}
              className="absolute top-4 right-4 w-10 h-10 rounded-full bg-background shadow-medium flex items-center justify-center hover:bg-muted transition-colors"
            >
              ×
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
