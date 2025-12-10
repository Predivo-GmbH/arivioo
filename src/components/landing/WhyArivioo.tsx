import { DollarSign, BadgePercent, MessageSquare, Heart } from "lucide-react";

const benefits = [
  {
    icon: DollarSign,
    title: "Lower prices for the same stay",
    description: "Many rentals are cheaper on other sites or the owner's direct website. A two-night stay might cost $690 on Airbnb but under $470 when booked directly.",
  },
  {
    icon: BadgePercent,
    title: "Fewer platform fees",
    description: "Airbnb adds roughly 14–16% in service fees for guests. By booking directly, you avoid those extra charges and pay only for the lodging.",
  },
  {
    icon: MessageSquare,
    title: "Direct booking flexibility",
    description: "No middleman means more direct communication and flexibility. Coordinate with the host for special requests, better cancellation terms, or extended stay discounts.",
  },
  {
    icon: Heart,
    title: "More money to the host",
    description: "Major platforms often take 8–20% of each booking. More of what you pay goes straight to your host, potentially encouraging better rates or perks.",
  },
];

export function WhyArivioo() {
  return (
    <section className="py-20 md:py-32 bg-gradient-warm">
      <div className="container px-4">
        <div className="text-center max-w-2xl mx-auto mb-16">
          <h2 className="text-3xl md:text-4xl font-bold text-foreground mb-4">
            Why Use Arivioo?
          </h2>
          <p className="text-lg text-muted-foreground">
            Skip the middleman and keep more money in your pocket
          </p>
        </div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6 max-w-6xl mx-auto">
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
      </div>
    </section>
  );
}
