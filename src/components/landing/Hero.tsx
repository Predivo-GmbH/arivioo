import { useEffect, useRef, useState } from "react";
import { ArrowRight, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useNavigate } from "react-router-dom";
import { useLastSuccessfulSearch } from "@/hooks/useLastSuccessfulSearch";
import { useImageAlignment } from "@/hooks/useImageAlignment";
import { getObjectPosition, getTransform } from "@/lib/imageAlignment";
import { formatPrice } from "@/lib/utils";
import type { Json } from "@/integrations/supabase/types";

// Convert JSON to string array
const toStringArray = (json: Json | null | undefined): string[] => {
  if (!json) return [];
  if (Array.isArray(json)) {
    return json.filter((item): item is string => typeof item === 'string');
  }
  return [];
};

export function Hero() {
  const [url, setUrl] = useState("");
  const navigate = useNavigate();
  const { data: dynamicData, loading } = useLastSuccessfulSearch();

  // Only show comparison if we have REAL verified data with a price
  const hasVerifiedData = !loading && dynamicData !== null && dynamicData.cheapestResult?.price !== null;
  
  // Extract values only when we have verified data
  const title = hasVerifiedData ? (dynamicData.airbnb_title || "Vacation Rental") : "";
  const airbnbPrice = hasVerifiedData ? dynamicData.airbnb_price || 0 : 0;
  const directPrice = hasVerifiedData ? dynamicData.cheapestResult?.price || 0 : 0;
  
  // Calculate service fee (14%) for Airbnb
  const serviceFeeRate = 0.14;
  const serviceFee = Math.round(airbnbPrice * serviceFeeRate);
  const airbnbPriceWithFees = airbnbPrice + serviceFee;
  
  // Calculate real savings
  const savings = airbnbPriceWithFees - directPrice;

  // Images from verified data
  const airbnbImages = hasVerifiedData ? toStringArray(dynamicData.airbnb_images) : [];
  const airbnbImage = hasVerifiedData 
    ? (dynamicData.cheapestResult?.source_airbnb_image || dynamicData.airbnb_image_url || airbnbImages[0] || "")
    : "";
  const directImage = hasVerifiedData 
    ? (dynamicData.cheapestResult?.image_url || "")
    : "";

  // Align the direct image to the Airbnb reference image (persisted per pair)
  const { alignment, autoAlign, isAutoAligning } = useImageAlignment(airbnbImage, directImage);
  const autoAlignTriggeredRef = useRef(false);

  useEffect(() => {
    // Only auto-align when we have verified data with images
    if (!hasVerifiedData) return;
    if (!airbnbImage || !directImage) return;
    if (autoAlignTriggeredRef.current) return;

    // If user already adjusted alignment (persisted), alignment likely won't be default.
    // Otherwise do a single auto-align attempt.
    const isDefault = alignment.x === 0 && alignment.y === 0 && alignment.scale === 1;
    if (!isDefault) {
      autoAlignTriggeredRef.current = true;
      return;
    }

    autoAlignTriggeredRef.current = true;
    void autoAlign();
  }, [hasVerifiedData, airbnbImage, directImage, alignment.x, alignment.y, alignment.scale, autoAlign]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (url.trim()) {
      navigate(`/auth?redirect=/dashboard&url=${encodeURIComponent(url)}`);
    }
  };

  const scrollToHowItWorks = () => {
    document.getElementById("how-it-works")?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <section className="relative min-h-[90vh] flex items-center justify-center overflow-hidden">
      {/* Background decoration */}
      <div className="absolute inset-0 bg-gradient-warm" />
      <div className="absolute top-20 left-10 w-72 h-72 bg-primary/5 rounded-full blur-3xl" />
      <div className="absolute bottom-20 right-10 w-96 h-96 bg-success/5 rounded-full blur-3xl" />
      
      <div className="container relative z-10 px-4 py-20">
        <div className="max-w-4xl mx-auto text-center">
          {/* Badge */}
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary/10 text-primary mb-8 animate-fade-in">
            <Sparkles className="w-4 h-4" />
            <span className="text-sm font-medium">Save up to 30% on vacation rentals</span>
          </div>

          {/* Headline */}
          <h1 className="text-4xl md:text-6xl lg:text-7xl font-extrabold text-foreground mb-6 animate-fade-in" style={{ animationDelay: "0.1s" }}>
            Paste Your Airbnb Link.
            <br />
            <span className="text-gradient">Save on Your Stay.</span>
          </h1>

          {/* Subheadline */}
          <p className="text-lg md:text-xl text-muted-foreground max-w-2xl mx-auto mb-10 animate-fade-in" style={{ animationDelay: "0.2s" }}>
            Arivioo finds your listing across the web — and shows you where it's cheaper to book direct.
          </p>

          {/* Search Form */}
          <form onSubmit={handleSubmit} className="max-w-2xl mx-auto mb-8 animate-fade-in" style={{ animationDelay: "0.3s" }}>
            <div className="flex flex-col sm:flex-row gap-3 p-2 bg-card rounded-2xl shadow-large border border-border">
              <Input
                type="url"
                placeholder="Paste your Airbnb listing URL here..."
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                className="flex-1 h-14 text-lg border-0 bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 px-4"
              />
              <Button 
                type="submit" 
                size="lg" 
                className="h-14 px-8 text-lg font-semibold rounded-xl bg-gradient-primary hover:opacity-90 transition-opacity"
              >
                Try It Now
                <ArrowRight className="w-5 h-5 ml-2" />
              </Button>
            </div>
          </form>

          {/* Secondary CTA */}
          <button
            onClick={scrollToHowItWorks}
            className="text-muted-foreground hover:text-foreground transition-colors underline-offset-4 hover:underline animate-fade-in"
            style={{ animationDelay: "0.4s" }}
          >
            See how it works ↓
          </button>

          {/* Mockup Preview - Only show when we have REAL verified data */}
          {hasVerifiedData && (
          <div className="mt-16 animate-fade-in" style={{ animationDelay: "0.5s" }}>
            <div className="relative max-w-3xl mx-auto">
              <div className="bg-card rounded-2xl shadow-large border border-border p-6 md:p-8">
                <div className="grid md:grid-cols-2 gap-6">
                  {/* Airbnb Card */}
                  <div className="bg-secondary/50 rounded-xl p-4">
                    {loading ? (
                      <>
                        <Skeleton className="aspect-video rounded-lg mb-4" />
                        <Skeleton className="h-3 w-20 mb-2" />
                        <Skeleton className="h-5 w-40 mb-1" />
                        <Skeleton className="h-8 w-24" />
                        <Skeleton className="h-4 w-28 mt-1" />
                      </>
                    ) : (
                      <>
                        <div className="aspect-video rounded-lg mb-4 overflow-hidden">
                          <img 
                            src={airbnbImage} 
                            alt={`Airbnb listing - ${title}`}
                            className="w-full h-full object-cover"
                          />
                        </div>
                        <p className="text-xs text-muted-foreground mb-2 flex items-center gap-1">
                          <span className="w-2 h-2 rounded-full bg-[#FF5A5F]" />
                          Airbnb listing
                        </p>
                        <h3 className="font-semibold text-foreground mb-1 truncate">{title}</h3>
                        <p className="text-2xl font-bold text-foreground">${airbnbPrice}<span className="text-sm font-normal text-muted-foreground">/night</span></p>
                        <p className="text-sm text-muted-foreground mt-1">+ ${serviceFee} service fees</p>
                      </>
                    )}
                  </div>

                  {/* Direct Booking Card */}
                  <div className="bg-success/10 rounded-xl p-4 ring-2 ring-success/30">
                    {loading ? (
                      <>
                        <Skeleton className="aspect-video rounded-lg mb-4" />
                        <Skeleton className="h-3 w-24 mb-2" />
                        <Skeleton className="h-5 w-40 mb-1" />
                        <Skeleton className="h-8 w-24" />
                        <Skeleton className="h-4 w-20 mt-1" />
                      </>
                    ) : (
                      <>
                        <div className="aspect-video rounded-lg mb-4 overflow-hidden">
                          <img 
                            src={directImage} 
                            alt={`Same property - visual match verified`}
                            className="w-full h-full object-cover"
                            style={{
                              objectPosition: getObjectPosition(alignment.x, alignment.y),
                              transform: getTransform(alignment.x, alignment.y, alignment.scale),
                              transformOrigin: "center",
                              transition: isAutoAligning ? "none" : undefined,
                            }}
                          />
                        </div>
                        <p className="text-xs text-success mb-2 flex items-center gap-1 font-medium">
                          <span className="w-2 h-2 rounded-full bg-success" />
                          AI-verified match!
                        </p>
                        <h3 className="font-semibold text-foreground mb-1 truncate">{title}</h3>
                        <p className="text-2xl font-bold text-success">${directPrice}<span className="text-sm font-normal text-muted-foreground">/night</span></p>
                        <p className="text-sm text-success mt-1 font-medium">No service fees!</p>
                      </>
                    )}
                  </div>
                </div>

                {/* Savings Badge */}
                <div className="mt-6 flex flex-col items-center gap-2">
                  <div className="inline-flex items-center gap-2 px-6 py-3 bg-gradient-success text-success-foreground rounded-full font-bold text-lg">
                    <Sparkles className="w-5 h-5" />
                    Save ${formatPrice(savings)} per night!
                  </div>
                </div>
              </div>
            </div>
          </div>
          )}
        </div>
      </div>
    </section>
  );
}
