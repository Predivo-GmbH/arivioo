import { DollarSign, BadgePercent, MessageSquare, Heart, AlertCircle } from "lucide-react";

const benefits = [
  {
    icon: DollarSign,
    title: "Lower prices for the same stay",
    description: "Many rentals are cheaper on other sites or the owner's direct website. A two-night stay might cost $690 on Airbnb but under $470 when booked directly.",
  },
  {
    icon: BadgePercent,
    title: "Avoid platform fees",
    description: "Airbnb adds roughly 14–16% in service fees for guests. By booking directly, you avoid those extra charges and pay only for the lodging.",
  },
  {
    icon: MessageSquare,
    title: "Direct booking benefits",
    description: "No middleman means more flexibility. Coordinate with the host for special requests, better cancellation terms, or extended stay discounts.",
  },
  {
    icon: Heart,
    title: "Support your host directly",
    description: "Major platforms often take 8–20% of each booking. More of what you pay goes straight to your host, potentially encouraging better rates.",
  },
];

const stats = [
  { value: "30%", label: "Average savings on direct bookings" },
  { value: "14-16%", label: "Airbnb service fee you can avoid" },
  { value: "85%", label: "Of properties are cross-listed" },
];

export function WhyArivioo() {
  return (
    <section id="why-arivioo" className="py-20 md:py-32 bg-gradient-warm">
      <div className="container px-4">
        <div className="text-center max-w-3xl mx-auto mb-16">
          <h2 className="text-3xl md:text-4xl font-bold text-foreground mb-4">
            Why Compare Before You Book?
          </h2>
          <p className="text-lg text-muted-foreground">
            The same vacation rental is often listed on multiple platforms at different price points. 
            Skip the middleman fees and keep more money in your pocket.
          </p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-4 max-w-2xl mx-auto mb-16">
          {stats.map((stat, index) => (
            <div key={index} className="text-center">
              <p className="text-3xl md:text-4xl font-bold text-primary mb-1">{stat.value}</p>
              <p className="text-xs md:text-sm text-muted-foreground">{stat.label}</p>
            </div>
          ))}
        </div>

        {/* Benefits Grid */}
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6 max-w-6xl mx-auto mb-12">
          {benefits.map((benefit, index) => (
            <div
              key={index}
              className="bg-card rounded-2xl p-6 shadow-soft border border-border hover:shadow-medium transition-all hover:-translate-y-1"
            >
              <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center mb-4">
                <benefit.icon className="w-6 h-6 text-primary" />
              </div>
              <h3 className="text-lg font-bold text-foreground mb-2">
                {benefit.title}
              </h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                {benefit.description}
              </p>
            </div>
          ))}
        </div>

        {/* Disclaimer */}
        <div className="max-w-3xl mx-auto">
          <div className="bg-card/50 rounded-xl p-4 flex items-start gap-3 border border-border">
            <AlertCircle className="w-5 h-5 text-muted-foreground flex-shrink-0 mt-0.5" />
            <p className="text-sm text-muted-foreground">
              <strong className="text-foreground">How it works:</strong> We search publicly available listing data and images. 
              Arivioo is not affiliated with Airbnb or any booking platform. We help you find the best price, 
              but always verify the listing details before booking.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}