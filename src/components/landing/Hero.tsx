import { useState } from "react";
import { ArrowRight, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useNavigate } from "react-router-dom";
import cottageView1 from "@/assets/cottage-view-1.jpg";
import cottageView2 from "@/assets/cottage-view-2.jpg";

export function Hero() {
  const [url, setUrl] = useState("");
  const navigate = useNavigate();

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

          {/* Mockup Preview with Real Images */}
          <div className="mt-16 animate-fade-in" style={{ animationDelay: "0.5s" }}>
            <div className="relative max-w-3xl mx-auto">
              <div className="bg-card rounded-2xl shadow-large border border-border p-6 md:p-8">
                <div className="grid md:grid-cols-2 gap-6">
                  {/* Airbnb Card */}
                  <div className="bg-secondary/50 rounded-xl p-4">
                    <div className="aspect-video rounded-lg mb-4 overflow-hidden">
                      <img 
                        src={cottageView1} 
                        alt="Airbnb listing photo - Cozy Lakeside Cottage"
                        className="w-full h-full object-cover"
                      />
                    </div>
                    <p className="text-xs text-muted-foreground mb-2 flex items-center gap-1">
                      <span className="w-2 h-2 rounded-full bg-[#FF5A5F]" />
                      Airbnb listing
                    </p>
                    <h3 className="font-semibold text-foreground mb-1">Cozy Lakeside Cottage</h3>
                    <p className="text-2xl font-bold text-foreground">$180<span className="text-sm font-normal text-muted-foreground">/night</span></p>
                    <p className="text-sm text-muted-foreground mt-1">+ $45 service fees</p>
                  </div>

                  {/* Direct Booking Card */}
                  <div className="bg-success/10 rounded-xl p-4 ring-2 ring-success/30">
                    <div className="aspect-video rounded-lg mb-4 overflow-hidden">
                      <img 
                        src={cottageView2} 
                        alt="Same property from direct booking site - slightly different angle"
                        className="w-full h-full object-cover"
                      />
                    </div>
                    <p className="text-xs text-success mb-2 flex items-center gap-1 font-medium">
                      <span className="w-2 h-2 rounded-full bg-success" />
                      Visual match found!
                    </p>
                    <h3 className="font-semibold text-foreground mb-1">Cozy Lakeside Cottage</h3>
                    <p className="text-2xl font-bold text-success">$145<span className="text-sm font-normal text-muted-foreground">/night</span></p>
                    <p className="text-sm text-success mt-1 font-medium">No service fees!</p>
                  </div>
                </div>

                {/* Savings Badge */}
                <div className="mt-6 flex justify-center">
                  <div className="inline-flex items-center gap-2 px-6 py-3 bg-gradient-success text-success-foreground rounded-full font-bold text-lg">
                    <Sparkles className="w-5 h-5" />
                    Save $80 per night!
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
