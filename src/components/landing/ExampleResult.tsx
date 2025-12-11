import { ExternalLink, Sparkles, Check, Calendar, Info } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ExampleResult() {
  return (
    <section className="py-20 md:py-32 bg-card">
      <div className="container px-4">
        <div className="text-center max-w-2xl mx-auto mb-16">
          <h2 className="text-3xl md:text-4xl font-bold text-foreground mb-4">
            See the Savings in Action
          </h2>
          <p className="text-lg text-muted-foreground">
            Here's what a typical Arivioo comparison looks like
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
                  <span>Comparing prices for Jan 15–18, 2025 (3 nights)</span>
                </div>
              </div>
            </div>

            <div className="p-6 md:p-8">
              {/* Comparison Table */}
              <div className="overflow-x-auto mb-8">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left py-3 px-4 font-semibold text-foreground">Platform</th>
                      <th className="text-right py-3 px-4 font-semibold text-foreground">Total (3 nights)</th>
                      <th className="text-right py-3 px-4 font-semibold text-foreground">Per Night</th>
                      <th className="text-left py-3 px-4 font-semibold text-foreground">Key Differences</th>
                      <th className="text-center py-3 px-4 font-semibold text-foreground">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b border-border bg-[#FF5A5F]/5">
                      <td className="py-4 px-4">
                        <div className="flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full bg-[#FF5A5F]" />
                          <span className="font-medium text-foreground">Airbnb</span>
                          <span className="text-xs text-muted-foreground">(Original)</span>
                        </div>
                      </td>
                      <td className="py-4 px-4 text-right font-semibold text-foreground">$540</td>
                      <td className="py-4 px-4 text-right text-muted-foreground">$180/night</td>
                      <td className="py-4 px-4 text-muted-foreground">
                        <span className="text-xs">AirCover protection, $45 service fee, cleaning included</span>
                      </td>
                      <td className="py-4 px-4 text-center">
                        <Button variant="outline" size="sm">View</Button>
                      </td>
                    </tr>
                    <tr className="border-b border-border">
                      <td className="py-4 px-4">
                        <div className="flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full bg-blue-500" />
                          <span className="font-medium text-foreground">Booking.com</span>
                        </div>
                      </td>
                      <td className="py-4 px-4 text-right font-semibold text-foreground">$495</td>
                      <td className="py-4 px-4 text-right text-muted-foreground">$165/night</td>
                      <td className="py-4 px-4 text-muted-foreground">
                        <span className="text-xs">Free cancellation until 5 days before, breakfast included</span>
                      </td>
                      <td className="py-4 px-4 text-center">
                        <Button variant="outline" size="sm">View</Button>
                      </td>
                    </tr>
                    <tr className="bg-success/5 border-2 border-success/30">
                      <td className="py-4 px-4">
                        <div className="flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full bg-success" />
                          <span className="font-medium text-foreground">Direct Booking</span>
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-success/20 text-success text-xs font-medium">
                            <Sparkles className="w-3 h-3" />
                            Best Deal
                          </span>
                        </div>
                      </td>
                      <td className="py-4 px-4 text-right font-bold text-success text-lg">$399</td>
                      <td className="py-4 px-4 text-right text-success font-medium">$133/night</td>
                      <td className="py-4 px-4">
                        <span className="text-xs text-success flex items-center gap-1">
                          <Check className="w-3 h-3" />
                          No service fees, flexible dates, direct host communication
                        </span>
                      </td>
                      <td className="py-4 px-4 text-center">
                        <Button size="sm" className="bg-success hover:bg-success/90">
                          Book Now
                          <ExternalLink className="w-3 h-3 ml-1" />
                        </Button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* Savings Summary */}
              <div className="bg-success/10 rounded-2xl p-6 text-center">
                <p className="text-muted-foreground mb-2">Your potential savings by booking direct</p>
                <div className="flex items-center justify-center gap-4 mb-2">
                  <p className="text-4xl font-bold text-success">$141</p>
                  <span className="text-success text-lg font-semibold">(26% off)</span>
                </div>
                <p className="text-sm text-muted-foreground">
                  Same property, same dates — just without the platform fees
                </p>
              </div>

              {/* Info note */}
              <div className="mt-6 flex items-start gap-3 p-4 bg-muted/30 rounded-xl">
                <Info className="w-5 h-5 text-muted-foreground flex-shrink-0 mt-0.5" />
                <p className="text-xs text-muted-foreground">
                  <strong>Fair comparison methodology:</strong> All prices shown include total costs with fees and taxes for identical dates. 
                  We verify listings using photo matching and location data. Always confirm details directly with the host before booking.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}