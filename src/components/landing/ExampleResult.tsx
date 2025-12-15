import { useState, useRef, useEffect } from "react";
import { ExternalLink, Sparkles, Check, Calendar, Info, Shield, Lock, Move } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLastSuccessfulSearch } from "@/hooks/useLastSuccessfulSearch";
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
  
  // Date display
  const dates = useDynamic && dynamicData.check_in_date && dynamicData.check_out_date
    ? `${formatDate(dynamicData.check_in_date)}–${formatDate(dynamicData.check_out_date)}`
    : STATIC_DATA.dates;
  
  // Images - use source_airbnb_image and matched image from results if available
  const airbnbImages = useDynamic ? toStringArray(dynamicData.airbnb_images) : [];
  const airbnbImage = useDynamic && dynamicData.cheapestResult?.source_airbnb_image
    ? dynamicData.cheapestResult.source_airbnb_image
    : (airbnbImages[0] || STATIC_DATA.airbnbImage);
  const directImage = useDynamic && dynamicData.cheapestResult?.image_url
    ? dynamicData.cheapestResult.image_url
    : STATIC_DATA.directImage;
  
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
    <section className="py-20 md:py-32 bg-card">
      <div className="container px-4">
        <div className="text-center max-w-2xl mx-auto mb-16">
          <h2 className="text-3xl md:text-4xl font-bold text-foreground mb-4">
            See the Savings in Action
          </h2>
          <p className="text-lg text-muted-foreground">
            {useDynamic ? "A real comparison from a recent search" : "Here's what a typical Arivioo comparison looks like"}
          </p>
        </div>

        <div className="max-w-5xl mx-auto">
          <div className="bg-background rounded-3xl shadow-large border border-border overflow-hidden">
            {/* Header */}
            <div className="bg-secondary/50 px-6 py-4 border-b border-border">
              <div className="flex items-center justify-between flex-wrap gap-4">
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full bg-destructive/60" />
                  <div className="w-3 h-3 rounded-full bg-yellow-400/60" />
                  <div className="w-3 h-3 rounded-full bg-success/60" />
                  <span className="ml-4 text-sm text-muted-foreground">arivioo.com/results</span>
                </div>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Calendar className="w-4 h-4" />
                  <span>Comparing prices for {dates} ({nights} night{nights !== 1 ? 's' : ''})</span>
                </div>
              </div>
            </div>

            <div className="p-6 md:p-8">
              {/* Interactive Image Slider Comparison */}
              <div className="mb-8">
                <div 
                  ref={sliderRef}
                  className="relative aspect-[16/9] rounded-xl overflow-hidden cursor-ew-resize select-none bg-muted"
                  onMouseDown={() => setIsDragging(true)}
                  onTouchStart={() => setIsDragging(true)}
                >
                  {/* Alternative/Direct booking image (bottom layer) */}
                  <img
                    src={directImage}
                    alt={`${directPlatform} - same property`}
                    className="absolute inset-0 w-full h-full object-cover"
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
                    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-12 h-12 rounded-full bg-white shadow-lg flex items-center justify-center">
                      <Move className="w-6 h-6 text-muted-foreground" />
                    </div>
                  </div>
                  
                  {/* Labels */}
                  <div className="absolute top-4 left-4 px-4 py-2 rounded-full bg-[#FF5A5F] text-white text-sm font-medium shadow-md flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-white/80" />
                    Airbnb - ${airbnbGrandTotal}
                  </div>
                  <div className="absolute top-4 right-4 px-4 py-2 rounded-full bg-success text-white text-sm font-medium shadow-md flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-white/80" />
                    {directPlatform} - ${directTotal}
                  </div>
                  
                  {/* Drag instruction */}
                  <div className="absolute bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-full bg-background/90 text-sm font-medium shadow-md backdrop-blur-sm">
                    ↔ Drag to compare
                  </div>
                </div>
              </div>

              {/* Comparison Table */}
              <div className="overflow-x-auto mb-8">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left py-3 px-4 font-semibold text-foreground">Platform</th>
                      <th className="text-center py-3 px-4 font-semibold text-foreground">Trust Score</th>
                      <th className="text-right py-3 px-4 font-semibold text-foreground">Total ({nights} night{nights !== 1 ? 's' : ''})</th>
                      <th className="text-right py-3 px-4 font-semibold text-foreground">Per Night</th>
                      <th className="text-left py-3 px-4 font-semibold text-foreground">Key Differences</th>
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
                      <td className="py-4 px-4 text-muted-foreground">
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
                      <td className="py-4 px-4">
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

              {/* Savings Summary */}
              <div className="border-2 border-success/30 bg-success/5 rounded-2xl p-8 text-center">
                <p className="text-muted-foreground mb-3 text-lg">Your potential savings by booking direct</p>
                <div className="flex items-center justify-center gap-3 mb-3">
                  <p className="text-5xl font-bold text-success">${savings}</p>
                  <span className="text-success text-xl font-semibold">({savingsPercent}% off)</span>
                </div>
                <p className="text-muted-foreground mb-4">
                  Same property, same dates — just without the platform fees
                </p>
                <p className="text-sm text-muted-foreground">
                  <strong>Unlock fee:</strong> ${unlockFee.toFixed(2)} (10% of your savings) — Only pay when you save
                </p>
              </div>

              {/* Info note */}
              <div className="mt-6 flex items-start gap-3 p-5 bg-muted/30 rounded-2xl">
                <Info className="w-5 h-5 text-muted-foreground flex-shrink-0 mt-0.5" />
                <p className="text-sm text-muted-foreground">
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
