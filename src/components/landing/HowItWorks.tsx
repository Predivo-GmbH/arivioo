import { Link2, Search, ArrowLeftRight } from "lucide-react";

const steps = [
  {
    icon: Link2,
    title: "Paste an Airbnb link",
    description: "Enter the URL of any Airbnb listing into Arivioo's search bar.",
  },
  {
    icon: Search,
    title: "AI-powered search",
    description: "Arivioo uses AI and reverse image matching to scour other rental platforms and websites for the exact same property.",
  },
  {
    icon: ArrowLeftRight,
    title: "Compare & save",
    description: "See the results side-by-side. Compare the Airbnb listing next to the matching listing on another site — often with a lower price.",
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className="py-20 md:py-32 bg-card">
      <div className="container px-4">
        <div className="text-center max-w-2xl mx-auto mb-16">
          <h2 className="text-3xl md:text-4xl font-bold text-foreground mb-4">
            How It Works
          </h2>
          <p className="text-lg text-muted-foreground">
            Three simple steps to start saving on your vacation rentals
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-8 max-w-5xl mx-auto">
          {steps.map((step, index) => (
            <div
              key={index}
              className="relative group"
            >
              {/* Connector line */}
              {index < steps.length - 1 && (
                <div className="hidden md:block absolute top-16 left-[60%] w-full h-0.5 bg-border" />
              )}
              
              <div className="relative bg-background rounded-2xl p-8 shadow-soft border border-border hover:shadow-medium transition-shadow">
                {/* Step number */}
                <div className="absolute -top-3 -left-3 w-8 h-8 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-sm font-bold">
                  {index + 1}
                </div>

                {/* Icon */}
                <div className="w-16 h-16 bg-primary/10 rounded-2xl flex items-center justify-center mb-6 group-hover:bg-primary/20 transition-colors">
                  <step.icon className="w-8 h-8 text-primary" />
                </div>

                <h3 className="text-xl font-bold text-foreground mb-3">
                  {step.title}
                </h3>
                <p className="text-muted-foreground leading-relaxed">
                  {step.description}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
