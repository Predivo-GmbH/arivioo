import { useState } from "react";
import { ArrowRight, Sparkles, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useNavigate } from "react-router-dom";

export function FinalCTA() {
  const [url, setUrl] = useState("");
  const navigate = useNavigate();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (url.trim()) {
      navigate(`/auth?redirect=/search&url=${encodeURIComponent(url)}`);
    } else {
      navigate("/auth");
    }
  };

  return (
    <section className="py-20 md:py-32 bg-gradient-primary relative overflow-hidden">
      {/* Background decoration */}
      <div className="absolute inset-0 opacity-10">
        <div className="absolute top-10 left-10 w-64 h-64 bg-white rounded-full blur-3xl" />
        <div className="absolute bottom-10 right-10 w-80 h-80 bg-white rounded-full blur-3xl" />
      </div>

      <div className="container px-4 relative z-10">
        <div className="max-w-3xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/20 text-white mb-8">
            <Sparkles className="w-4 h-4" />
            <span className="text-sm font-medium">Start saving today</span>
          </div>

          <h2 className="text-3xl md:text-5xl font-bold text-white mb-6">
            Ready to Find a Better Deal?
          </h2>
          <p className="text-lg md:text-xl text-white/90 mb-10">
            Start saving on your stays today. Paste your Airbnb link and see the savings for yourself.
          </p>

          <form onSubmit={handleSubmit} className="max-w-2xl mx-auto">
            <div className="flex flex-col sm:flex-row gap-3 p-2 bg-white/10 backdrop-blur-sm rounded-2xl border border-white/20">
              <Input
                type="url"
                placeholder="Paste your Airbnb listing URL..."
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                className="flex-1 h-14 text-lg border-0 bg-white/90 text-foreground placeholder:text-muted-foreground focus-visible:ring-0 focus-visible:ring-offset-0 px-4 rounded-xl"
              />
              <Button 
                type="submit" 
                size="lg" 
                className="h-14 px-8 text-lg font-semibold rounded-xl bg-white text-primary hover:bg-white/90 transition-colors"
              >
                Try Arivioo Now
                <ArrowRight className="w-5 h-5 ml-2" />
              </Button>
            </div>
          </form>

          <div className="mt-6 flex flex-wrap justify-center gap-4 text-sm text-white/80">
            <span className="flex items-center gap-1">
              <CheckCircle2 className="w-4 h-4" />
              Free to compare
            </span>
            <span className="flex items-center gap-1">
              <CheckCircle2 className="w-4 h-4" />
              No credit card required
            </span>
            <span className="flex items-center gap-1">
              <CheckCircle2 className="w-4 h-4" />
              Pay only when you save
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
