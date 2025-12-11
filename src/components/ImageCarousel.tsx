import { useState } from "react";
import { 
  Carousel, 
  CarouselContent, 
  CarouselItem, 
  CarouselPrevious, 
  CarouselNext 
} from "@/components/ui/carousel";
import { ImageIcon, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface ImageCarouselProps {
  images: string[];
  alt: string;
  className?: string;
  aspectRatio?: "square" | "video" | "wide";
  showControls?: boolean;
  fallbackColor?: string;
}

export function ImageCarousel({ 
  images, 
  alt, 
  className,
  aspectRatio = "square",
  showControls = true,
  fallbackColor = "bg-primary/10"
}: ImageCarouselProps) {
  const [failedImages, setFailedImages] = useState<Set<number>>(new Set());
  const [currentIndex, setCurrentIndex] = useState(0);

  const validImages = images.filter((_, i) => !failedImages.has(i));
  const hasMultipleImages = validImages.length > 1;

  const handleImageError = (index: number) => {
    setFailedImages(prev => new Set([...prev, index]));
  };

  const aspectClasses = {
    square: "aspect-square",
    video: "aspect-video",
    wide: "aspect-[16/9]"
  };

  // If no valid images, show placeholder
  if (validImages.length === 0) {
    return (
      <div className={cn(
        "rounded-xl overflow-hidden flex items-center justify-center",
        fallbackColor,
        aspectClasses[aspectRatio],
        className
      )}>
        <ImageIcon className="w-8 h-8 text-muted-foreground" />
      </div>
    );
  }

  // Single image - no carousel needed
  if (!hasMultipleImages) {
    return (
      <div className={cn(
        "rounded-xl overflow-hidden",
        aspectClasses[aspectRatio],
        className
      )}>
        <img
          src={validImages[0]}
          alt={alt}
          className="w-full h-full object-cover"
          onError={() => handleImageError(0)}
        />
      </div>
    );
  }

  // Multiple images - use carousel
  return (
    <div className={cn("relative group", className)}>
      <Carousel 
        className="w-full"
        opts={{ loop: true }}
      >
        <CarouselContent className="-ml-0">
          {images.map((image, index) => (
            !failedImages.has(index) && (
              <CarouselItem key={index} className="pl-0">
                <div className={cn(
                  "rounded-xl overflow-hidden",
                  aspectClasses[aspectRatio]
                )}>
                  <img
                    src={image}
                    alt={`${alt} - Image ${index + 1}`}
                    className="w-full h-full object-cover"
                    onError={() => handleImageError(index)}
                  />
                </div>
              </CarouselItem>
            )
          ))}
        </CarouselContent>
        
        {showControls && hasMultipleImages && (
          <>
            <CarouselPrevious 
              className="left-2 h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity bg-background/80 hover:bg-background border-0"
            />
            <CarouselNext 
              className="right-2 h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity bg-background/80 hover:bg-background border-0"
            />
          </>
        )}
      </Carousel>
      
      {/* Dots indicator */}
      {hasMultipleImages && (
        <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex gap-1">
          {validImages.map((_, index) => (
            <div 
              key={index}
              className="w-1.5 h-1.5 rounded-full bg-white/60"
            />
          ))}
        </div>
      )}
    </div>
  );
}