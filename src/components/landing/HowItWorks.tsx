import { Link2, Search, ArrowLeftRight, Image, Calendar, ShieldCheck } from "lucide-react";

const steps = [
  {
    icon: Link2,
    title: "Paste Your Airbnb Link",
    description: "Enter the URL of any Airbnb listing. We'll extract the property photos, title, location, and pricing details.",
    detail: "Include dates in your URL for accurate comparison"
  },
  {
    icon: Image,
    title: "AI Image Recognition",
    description: "We extract distinctive property photos and run reverse image searches across the web to find the same property on other platforms.",
    detail: "Visual matching technology"
  },
  {
    icon: Search,
    title: "Cross-Platform Search",
    description: "Our AI scours Booking.com, Vrbo, Expedia, HomeAway, and direct booking sites to find matching listings.",
    detail: "Checks title, location & host details"
  },
  {
    icon: ArrowLeftRight,
    title: "Compare & Save",
    description: "See all listings side-by-side with total prices including all fees. We highlight the best deal for your dates.",
    detail: "Same dates, fair comparison"
  },
];

const platforms = [
  "Booking.com",
  "Vrbo",
  "Expedia",
  "Hotels.com",
  "HomeAway",
  "TripAdvisor",
  "Agoda",
  "Direct Sites"
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className="py-20 md:py-32 bg-card">
      <div className="container px-4">
        <div className="text-center max-w-3xl mx-auto mb-16">
          <h2 className="text-3xl md:text-4xl font-bold text-foreground mb-4">
            How Arivioo Finds You Better Deals
          </h2>
          <p className="text-lg text-muted-foreground">
            Many vacation rental hosts list the same property on multiple platforms — often at different prices due to varying fees. 
            We find those cross-listings so you can book smarter.
          </p>
        </div>

        {/* Steps Grid */}
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6 max-w-6xl mx-auto mb-16">
          {steps.map((step, index) => (
            <div
              key={index}
              className="relative group"
            >
              <div className="relative bg-background rounded-2xl p-6 shadow-soft border border-border hover:shadow-medium transition-shadow h-full">
                {/* Step number */}
                <div className="absolute -top-3 -left-3 w-8 h-8 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-sm font-bold">
                  {index + 1}
                </div>

                {/* Icon */}
                <div className="w-14 h-14 bg-primary/10 rounded-2xl flex items-center justify-center mb-5 group-hover:bg-primary/20 transition-colors">
                  <step.icon className="w-7 h-7 text-primary" />
                </div>

                <h3 className="text-lg font-bold text-foreground mb-2">
                  {step.title}
                </h3>
                <p className="text-sm text-muted-foreground leading-relaxed mb-3">
                  {step.description}
                </p>
                <p className="text-xs text-primary font-medium">
                  {step.detail}
                </p>
              </div>
            </div>
          ))}
        </div>

        {/* Platforms we search */}
        <div className="max-w-4xl mx-auto">
          <div className="bg-background rounded-2xl border border-border p-6 md:p-8">
            <div className="text-center mb-6">
              <h3 className="text-lg font-semibold text-foreground mb-2">
                Platforms We Search
              </h3>
              <p className="text-sm text-muted-foreground">
                We find your property across all major booking platforms and direct rental sites
              </p>
            </div>
            <div className="flex flex-wrap justify-center gap-3">
              {platforms.map((platform, index) => (
                <span 
                  key={index}
                  className="px-4 py-2 bg-muted/50 rounded-full text-sm font-medium text-muted-foreground"
                >
                  {platform}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* Key methodology points */}
        <div className="max-w-4xl mx-auto mt-12 grid md:grid-cols-3 gap-6">
          <div className="text-center p-6">
            <Calendar className="w-8 h-8 text-primary mx-auto mb-3" />
            <h4 className="font-semibold text-foreground mb-2">Same Dates Comparison</h4>
            <p className="text-sm text-muted-foreground">
              We use identical check-in/check-out dates across all platforms for a fair price comparison.
            </p>
          </div>
          <div className="text-center p-6">
            <ShieldCheck className="w-8 h-8 text-primary mx-auto mb-3" />
            <h4 className="font-semibold text-foreground mb-2">Total Price Included</h4>
            <p className="text-sm text-muted-foreground">
              We capture the full cost including service fees, cleaning fees, and taxes — not just the base rate.
            </p>
          </div>
          <div className="text-center p-6">
            <Image className="w-8 h-8 text-primary mx-auto mb-3" />
            <h4 className="font-semibold text-foreground mb-2">Visual Verification</h4>
            <p className="text-sm text-muted-foreground">
              We match property photos to verify it's the exact same listing, not just a similar one.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
