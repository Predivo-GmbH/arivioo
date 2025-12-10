import { ExternalLink, Sparkles, Check } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ExampleResult() {
  return (
    <section className="py-20 md:py-32 bg-card">
      <div className="container px-4">
        <div className="text-center max-w-2xl mx-auto mb-16">
          <h2 className="text-3xl md:text-4xl font-bold text-foreground mb-4">
            See the Difference
          </h2>
          <p className="text-lg text-muted-foreground">
            Here's what a typical Arivioo result looks like
          </p>
        </div>

        <div className="max-w-4xl mx-auto">
          <div className="bg-background rounded-3xl shadow-large border border-border overflow-hidden">
            {/* Header */}
            <div className="bg-secondary/50 px-6 py-4 border-b border-border">
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-destructive/60" />
                <div className="w-3 h-3 rounded-full bg-yellow-400/60" />
                <div className="w-3 h-3 rounded-full bg-success/60" />
                <span className="ml-4 text-sm text-muted-foreground">arivioo.com/results</span>
              </div>
            </div>

            <div className="p-6 md:p-8">
              {/* Comparison Grid */}
              <div className="grid md:grid-cols-2 gap-6">
                {/* Airbnb Panel */}
                <div className="rounded-2xl border border-border overflow-hidden">
                  <div className="bg-[#FF5A5F]/10 px-4 py-3 border-b border-border">
                    <span className="font-semibold text-[#FF5A5F]">Airbnb</span>
                  </div>
                  <div className="p-4">
                    <div className="aspect-[4/3] bg-muted rounded-xl mb-4 flex items-center justify-center">
                      <span className="text-muted-foreground text-sm">Property Image</span>
                    </div>
                    <h3 className="font-bold text-foreground mb-2">Cozy Lakeside Cottage</h3>
                    <p className="text-sm text-muted-foreground mb-3">2 guests · 1 bedroom · Lake view</p>
                    <div className="space-y-1 text-sm">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">$180 × 2 nights</span>
                        <span className="text-foreground">$360</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Cleaning fee</span>
                        <span className="text-foreground">$75</span>
                      </div>
                      <div className="flex justify-between text-destructive">
                        <span>Service fee (14%)</span>
                        <span>$61</span>
                      </div>
                      <div className="border-t border-border pt-2 mt-2">
                        <div className="flex justify-between font-bold">
                          <span className="text-foreground">Total</span>
                          <span className="text-foreground">$496</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Direct Booking Panel */}
                <div className="rounded-2xl border-2 border-success overflow-hidden ring-4 ring-success/20">
                  <div className="bg-success/10 px-4 py-3 border-b border-success/30 flex items-center justify-between">
                    <span className="font-semibold text-success">Direct Booking</span>
                    <div className="flex items-center gap-1 text-success text-sm font-medium">
                      <Sparkles className="w-4 h-4" />
                      Best Deal
                    </div>
                  </div>
                  <div className="p-4">
                    <div className="aspect-[4/3] bg-success/10 rounded-xl mb-4 flex items-center justify-center">
                      <span className="text-success text-sm font-medium">Same Property!</span>
                    </div>
                    <h3 className="font-bold text-foreground mb-2">Cozy Lakeside Cottage</h3>
                    <p className="text-sm text-muted-foreground mb-3">2 guests · 1 bedroom · Lake view</p>
                    <div className="space-y-1 text-sm">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">$145 × 2 nights</span>
                        <span className="text-foreground">$290</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Cleaning fee</span>
                        <span className="text-foreground">$75</span>
                      </div>
                      <div className="flex justify-between text-success">
                        <span className="flex items-center gap-1">
                          <Check className="w-3 h-3" />
                          No service fee
                        </span>
                        <span>$0</span>
                      </div>
                      <div className="border-t border-border pt-2 mt-2">
                        <div className="flex justify-between font-bold">
                          <span className="text-foreground">Total</span>
                          <span className="text-success text-xl">$365</span>
                        </div>
                      </div>
                    </div>
                    <Button className="w-full mt-4 bg-gradient-success hover:opacity-90">
                      Book Direct
                      <ExternalLink className="w-4 h-4 ml-2" />
                    </Button>
                  </div>
                </div>
              </div>

              {/* Savings Summary */}
              <div className="mt-8 bg-success/10 rounded-2xl p-6 text-center">
                <p className="text-muted-foreground mb-2">Your potential savings</p>
                <p className="text-4xl font-bold text-success mb-2">$131</p>
                <p className="text-sm text-muted-foreground">That's 26% off the Airbnb price!</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
