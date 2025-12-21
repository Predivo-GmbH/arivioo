import { useEffect, useRef, useState } from "react";
import { ExternalLink, Sparkles, Check, Calendar, Info, Shield, Lock, Move } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useLastSuccessfulSearch } from "@/hooks/useLastSuccessfulSearch";
import { useImageAlignment } from "@/hooks/useImageAlignment";
import { getObjectPosition, getTransform } from "@/lib/imageAlignment";
import cottageView1 from "@/assets/cottage-view-1.jpg";
import cottageView2 from "@/assets/cottage-view-2.jpg";
import type { Json } from "@/integrations/supabase/types";

// Convert JSON to string array
const toStringArray = (json: Json | null | undefined): string[] => {
  if (!json) return [];
  if (Array.isArray(json)) {
    return json.filter((item): item is string => typeof item === 'string');
  }
  return [];
};

// Format date for display
const formatDate = (dateStr: string): string => {
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

// Static fallback data
const STATIC_DATA = {
  title: "Cozy Lakeside Cottage",
  airbnbPrice: 180,
  directPrice: 133,
  airbnbTotal: 540,
  directTotal: 399,
  nights: 3,
  savings: 141,
  savingsPercent: 26,
  unlockFee: 14.10,
  dates: "Jan 15–18, 2025",
  airbnbImage: cottageView1,
  directImage: cottageView2,
};

export function ExampleResult() {
  const [sliderPosition, setSliderPosition] = useState(50);
  const [isDragging, setIsDragging] = useState(false);
  const sliderRef = useRef<HTMLDivElement>(null);
  const autoAlignTriggeredRef = useRef(false);
  
  const { data: dynamicData, loading } = useLastSuccessfulSearch();

  // Use dynamic data if available, otherwise static
  const useDynamic = !loading && dynamicData !== null;
  
  // Extract values from dynamic data or use static
  const title = useDynamic ? (dynamicData.airbnb_title || STATIC_DATA.title) : STATIC_DATA.title;
  const airbnbPrice = useDynamic ? (dynamicData.airbnb_price || STATIC_DATA.airbnbPrice) : STATIC_DATA.airbnbPrice;
  const nights = useDynamic ? (dynamicData.nights_count || STATIC_DATA.nights) : STATIC_DATA.nights;
  const directPrice = useDynamic && dynamicData.cheapestResult?.price 
    ? dynamicData.cheapestResult.price 
    : STATIC_DATA.directPrice;
  
  // Calculate totals
  const airbnbTotal = airbnbPrice * nights;
  const serviceFee = Math.round(airbnbTotal * 0.14);
  const airbnbGrandTotal = airbnbTotal + serviceFee;
  const directTotal = directPrice * nights;
  const savings = useDynamic ? (dynamicData.potentialSavings || STATIC_DATA.savings) : STATIC_DATA.savings;
  const savingsPercent = useDynamic ? (dynamicData.savingsPercentage || STATIC_DATA.savingsPercent) : STATIC_DATA.savingsPercent;
  const unlockFee = Math.round(savings * 0.1 * 100) / 100;
  
  // Date display - use generic "X nights" for privacy when showing dynamic data
  const dates = useDynamic && dynamicData.nights_count
    ? `${dynamicData.nights_count} nights`
    : STATIC_DATA.dates;
  
  // Images - use source_airbnb_image and matched image from results if available
  const airbnbImages = useDynamic ? toStringArray(dynamicData.airbnb_images) : [];
  const airbnbImage = useDynamic && dynamicData.cheapestResult?.source_airbnb_image
    ? dynamicData.cheapestResult.source_airbnb_image
    : (airbnbImages[0] || STATIC_DATA.airbnbImage);
  const directImage = useDynamic && dynamicData.cheapestResult?.image_url
    ? dynamicData.cheapestResult.image_url
    : STATIC_DATA.directImage;

  const { alignment, autoAlign } = useImageAlignment(airbnbImage, directImage);

  useEffect(() => {
    if (!useDynamic) return;
    if (!airbnbImage || !directImage) return;
    if (autoAlignTriggeredRef.current) return;

    const isDefault = alignment.x === 0 && alignment.y === 0 && alignment.scale === 1;
    if (!isDefault) {
      autoAlignTriggeredRef.current = true;
      return;
    }

    autoAlignTriggeredRef.current = true;
    void autoAlign();
  }, [useDynamic, airbnbImage, directImage, alignment.x, alignment.y, alignment.scale, autoAlign]);
  
  // Confidence score
  const confidenceScore = useDynamic && dynamicData.cheapestResult?.confidence_score
    ? Math.round(dynamicData.cheapestResult.confidence_score * 100)
    : 98;
  
  // Platform name
  const directPlatform = useDynamic && dynamicData.cheapestResult?.platform_name
    ? dynamicData.cheapestResult.platform_name
    : "Direct Booking";

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

  return (
    <section className="py-12 sm:py-20 md:py-32 bg-card">
      <div className="container px-4">
        <div className="text-center max-w-2xl mx-auto mb-8 sm:mb-16">
          <h2 className="text-2xl sm:text-3xl md:text-4xl font-bold text-foreground mb-4">
            See the Savings in Action
          </h2>
          <p className="text-base sm:text-lg text-muted-foreground">
            {useDynamic ? "A real comparison from a recent search" : "Here's what a typical Arivioo comparison looks like"}
          </p>
        </div>

        <div className="max-w-5xl mx-auto">
          <div className="bg-background rounded-2xl sm:rounded-3xl shadow-large border border-border overflow-hidden">
            {/* Header */}
            <div className="bg-secondary/50 px-4 sm:px-6 py-3 sm:py-4 border-b border-border">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-4">
                <div className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 sm:w-3 sm:h-3 rounded-full bg-destructive/60" />
                  <div className="w-2.5 h-2.5 sm:w-3 sm:h-3 rounded-full bg-yellow-400/60" />
                  <div className="w-2.5 h-2.5 sm:w-3 sm:h-3 rounded-full bg-success/60" />
                  <span className="ml-2 sm:ml-4 text-xs sm:text-sm text-muted-foreground">arivioo.com/results</span>
                </div>
                <div className="flex items-center gap-2 text-xs sm:text-sm text-muted-foreground">
                  <Calendar className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                  <span>Comparing prices for {dates} ({nights} night{nights !== 1 ? 's' : ''})</span>
                </div>
              </div>
            </div>

            <div className="p-4 sm:p-6 md:p-8">
              {/* Interactive Image Slider Comparison */}
              <div className="mb-6 sm:mb-8">
                {loading ? (
                  <Skeleton className="aspect-[4/3] sm:aspect-[16/9] rounded-xl" />
                ) : (
                  <div 
                    ref={sliderRef}
                    className="relative aspect-[4/3] sm:aspect-[16/9] rounded-xl overflow-hidden cursor-ew-resize select-none bg-muted touch-none"
                    onMouseDown={() => setIsDragging(true)}
                    onTouchStart={() => setIsDragging(true)}
                  >
                    {/* Alternative/Direct booking image (bottom layer) */}
                    <img
                      src={directImage}
                      alt={`${directPlatform} - same property`}
                      className="absolute inset-0 w-full h-full object-cover"
                      style={{
                        objectPosition: getObjectPosition(alignment.x, alignment.y),
                        transform: getTransform(alignment.x, alignment.y, alignment.scale),
                        transformOrigin: "center",
                      }}
                      draggable={false}
                    />
                    
                    {/* Airbnb image (top layer, clipped) */}
                    <div 
                      className="absolute inset-0 overflow-hidden"
                      style={{ width: `${sliderPosition}%` }}
                    >
                      <img
                        src={airbnbImage}
                        alt="Airbnb listing view"
                        className="absolute inset-0 w-full h-full object-cover"
                        style={{ 
                          width: sliderRef.current ? `${sliderRef.current.offsetWidth}px` : '100%',
                          maxWidth: 'none'
                        }}
                        draggable={false}
                      />
                    </div>
                    
                    {/* Slider handle */}
                    <div 
                      className="absolute top-0 bottom-0 w-1 bg-white shadow-lg cursor-ew-resize z-10"
                      style={{ left: `${sliderPosition}%`, transform: 'translateX(-50%)' }}
                    >
                      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-10 h-10 sm:w-12 sm:h-12 rounded-full bg-white shadow-lg flex items-center justify-center">
                        <Move className="w-5 h-5 sm:w-6 sm:h-6 text-muted-foreground" />
                      </div>
                    </div>
                    
                    {/* Labels - Mobile optimized */}
                    <div className="absolute top-2 left-2 sm:top-4 sm:left-4 px-2 py-1 sm:px-4 sm:py-2 rounded-full bg-[#FF5A5F] text-white text-xs sm:text-sm font-medium shadow-md flex items-center gap-1 sm:gap-2">
                      <span className="w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full bg-white/80" />
                      <span className="hidden xs:inline">Airbnb</span> ${airbnbGrandTotal}
                    </div>
                    <div className="absolute top-2 right-2 sm:top-4 sm:right-4 px-2 py-1 sm:px-4 sm:py-2 rounded-full bg-success text-white text-xs sm:text-sm font-medium shadow-md flex items-center gap-1 sm:gap-2">
                      <span className="w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full bg-white/80" />
                      <span className="hidden xs:inline">{directPlatform}</span> ${directTotal}
                    </div>
                    
                    {/* Drag instruction */}
                    <div className="absolute bottom-2 left-1/2 -translate-x-1/2 px-3 py-1.5 sm:px-4 sm:py-2 rounded-full bg-background/90 text-xs sm:text-sm font-medium shadow-md backdrop-blur-sm">
                      ↔ Drag to compare
                    </div>
                  </div>
                )}
              </div>

              {/* Comparison Table - Mobile Responsive */}
              <div className="mb-6 sm:mb-8">
                {/* Mobile Card Layout */}
                <div className="block sm:hidden space-y-4">
                  {/* Airbnb Card */}
                  <div className="p-4 rounded-xl bg-[#FF5A5F]/5 border border-[#FF5A5F]/20">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-[#FF5A5F]" />
                        <span className="font-medium text-foreground">Airbnb</span>
                        <span className="text-xs text-muted-foreground">(Original)</span>
                      </div>
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-muted text-muted-foreground text-xs font-medium">
                        <Shield className="w-3 h-3" />
                        Baseline
                      </span>
                    </div>
                    <div className="flex items-end justify-between">
                      <div>
                        <p className="text-2xl font-bold text-foreground">${airbnbGrandTotal}</p>
                        <p className="text-sm text-muted-foreground">${airbnbPrice}/night</p>
                      </div>
                      <Button variant="outline" size="sm">View</Button>
                    </div>
                    <p className="text-xs text-muted-foreground mt-2">AirCover protection, ${serviceFee} service fee</p>
                  </div>

                  {/* Best Deal Card */}
                  <div className="p-4 rounded-xl bg-success/5 border-2 border-success/30">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="w-2 h-2 rounded-full bg-success" />
                        <span className="font-medium text-foreground">{directPlatform}</span>
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-success/20 text-success text-xs font-medium">
                          <Sparkles className="w-3 h-3" />
                          Best Deal
                        </span>
                      </div>
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-success/20 text-success text-xs font-medium">
                        <Shield className="w-3 h-3" />
                        {confidenceScore}%
                      </span>
                    </div>
                    <div className="flex items-end justify-between">
                      <div>
                        <p className="text-2xl font-bold text-success">${directTotal}</p>
                        <p className="text-sm text-success font-medium">${directPrice}/night</p>
                      </div>
                      <Button size="sm" className="bg-success hover:bg-success/90">
                        <Lock className="w-3 h-3 mr-1" />
                        Unlock
                      </Button>
                    </div>
                    <p className="text-xs text-success mt-2 flex items-center gap-1">
                      <Check className="w-3 h-3" />
                      No service fees, flexible dates
                    </p>
                  </div>
                </div>

                {/* Desktop Table Layout */}
                <div className="hidden sm:block overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="text-left py-3 px-4 font-semibold text-foreground">Platform</th>
                        <th className="text-center py-3 px-4 font-semibold text-foreground">Trust Score</th>
                        <th className="text-right py-3 px-4 font-semibold text-foreground">Total ({nights} night{nights !== 1 ? 's' : ''})</th>
                        <th className="text-right py-3 px-4 font-semibold text-foreground">Per Night</th>
                        <th className="text-left py-3 px-4 font-semibold text-foreground hidden lg:table-cell">Key Differences</th>
                        <th className="text-center py-3 px-4 font-semibold text-foreground">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {/* Airbnb row */}
                      <tr className="border-b border-border bg-[#FF5A5F]/5">
                        <td className="py-4 px-4">
                          <div className="flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full bg-[#FF5A5F]" />
                            <span className="font-medium text-foreground">Airbnb</span>
                            <span className="text-xs text-muted-foreground">(Original)</span>
                          </div>
                        </td>
                        <td className="py-4 px-4 text-center">
                          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-muted text-muted-foreground text-xs font-medium">
                            <Shield className="w-3 h-3" />
                            Baseline
                          </span>
                        </td>
                        <td className="py-4 px-4 text-right font-semibold text-foreground">${airbnbGrandTotal}</td>
                        <td className="py-4 px-4 text-right text-muted-foreground">${airbnbPrice}/night</td>
                        <td className="py-4 px-4 text-muted-foreground hidden lg:table-cell">
                          <span className="text-xs">AirCover protection, ${serviceFee} service fee, cleaning included</span>
                        </td>
                        <td className="py-4 px-4 text-center">
                          <Button variant="outline" size="sm">View</Button>
                        </td>
                      </tr>
                      
                      {/* Best deal row */}
                      <tr className="bg-success/5 border-2 border-success/30">
                        <td className="py-4 px-4">
                          <div className="flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full bg-success" />
                            <span className="font-medium text-foreground">{directPlatform}</span>
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-success/20 text-success text-xs font-medium">
                              <Sparkles className="w-3 h-3" />
                              Best Deal
                            </span>
                          </div>
                        </td>
                        <td className="py-4 px-4 text-center">
                          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-success/20 text-success text-xs font-medium">
                            <Shield className="w-3 h-3" />
                            {confidenceScore}%
                          </span>
                        </td>
                        <td className="py-4 px-4 text-right font-bold text-success text-lg">${directTotal}</td>
                        <td className="py-4 px-4 text-right text-success font-medium">${directPrice}/night</td>
                        <td className="py-4 px-4 hidden lg:table-cell">
                          <span className="text-xs text-success flex items-center gap-1">
                            <Check className="w-3 h-3" />
                            No service fees, flexible dates, direct host communication
                          </span>
                        </td>
                        <td className="py-4 px-4 text-center">
                          <Button size="sm" className="bg-success hover:bg-success/90">
                            <Lock className="w-3 h-3 mr-1" />
                            Unlock
                            <ExternalLink className="w-3 h-3 ml-1" />
                          </Button>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Savings Summary */}
              <div className="border-2 border-success/30 bg-success/5 rounded-xl sm:rounded-2xl p-4 sm:p-8 text-center">
                <p className="text-muted-foreground mb-2 sm:mb-3 text-base sm:text-lg">Your potential savings by booking direct</p>
                <div className="flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-3 mb-2 sm:mb-3">
                  <p className="text-3xl sm:text-5xl font-bold text-success">${savings}</p>
                  <span className="text-success text-lg sm:text-xl font-semibold">({savingsPercent}% off)</span>
                </div>
                <p className="text-sm sm:text-base text-muted-foreground mb-3 sm:mb-4">
                  Same property, same dates — just without the platform fees
                </p>
                <p className="text-xs sm:text-sm text-muted-foreground">
                  <strong>Unlock fee:</strong> ${unlockFee.toFixed(2)} (10% of your savings) — Only pay when you save
                </p>
              </div>

              {/* Info note */}
              <div className="mt-4 sm:mt-6 flex items-start gap-2 sm:gap-3 p-3 sm:p-5 bg-muted/30 rounded-xl sm:rounded-2xl">
                <Info className="w-4 h-4 sm:w-5 sm:h-5 text-muted-foreground flex-shrink-0 mt-0.5" />
                <p className="text-xs sm:text-sm text-muted-foreground">
                  <strong>AI-verified comparison:</strong> All matches are verified using AI image comparison with ≥90% confidence. 
                  Trust scores show how confident we are that listings show the same property. Always confirm details directly with the host before booking.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
