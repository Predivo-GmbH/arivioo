import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { 
  Check, 
  Sparkles, 
  ArrowRight, 
  Calculator, 
  Shield, 
  Zap,
  Lock,
  Unlock
} from "lucide-react";
import { AriviooLogo, AriviooLogoStatic } from "@/components/AriviooLogo";

const pricingFaqs = [
  {
    question: "When do I get charged?",
    answer: "You only get charged when you choose to unlock the best deal. Searching and viewing all other alternatives is completely free. The 10% fee is charged only when you click to unlock and access the cheapest option we found."
  },
  {
    question: "How is the fee calculated?",
    answer: "The fee is 10% of the savings you'll make compared to the original Airbnb price. For example, if Airbnb costs $500 and we find it for $400 (saving you $100), your unlock fee is just $10. You still save $90!"
  },
  {
    question: "What if there are no savings?",
    answer: "If we can't find a cheaper alternative, you pay nothing. You only pay when we actually save you money. If the alternatives we find are the same price or higher than Airbnb, there's no fee."
  },
  {
    question: "What payment methods do you accept?",
    answer: "We accept all major credit cards (Visa, Mastercard, American Express) and PayPal. Payment is processed securely through Stripe."
  },
  {
    question: "Can I get a refund?",
    answer: "Once you unlock a deal, the fee is non-refundable as you've already received access to the information. However, we're confident you'll love the savings! If you encounter any issues, please contact our support team."
  },
  {
    question: "Do you take a commission on the actual booking?",
    answer: "No, absolutely not. We never take a commission on your booking. Once you unlock the deal, you book directly with the platform or host. We only charge the small unlock fee for finding the savings."
  },
  {
    question: "Why charge at all?",
    answer: "Running AI-powered searches across multiple platforms costs money. The 10% success fee allows us to keep the service free for searching while covering our costs only when we deliver real value to you."
  }
];

const examples = [
  {
    airbnbPrice: 600,
    alternativePrice: 450,
    savings: 150,
    fee: 15,
    netSavings: 135,
    platform: "Direct Booking",
    nights: 3
  },
  {
    airbnbPrice: 1200,
    alternativePrice: 980,
    savings: 220,
    fee: 22,
    netSavings: 198,
    platform: "Booking.com",
    nights: 5
  },
  {
    airbnbPrice: 350,
    alternativePrice: 280,
    savings: 70,
    fee: 7,
    netSavings: 63,
    platform: "Vrbo",
    nights: 2
  }
];

export default function Pricing() {
  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card">
        <div className="container px-4 h-16 flex items-center justify-between">
          <Link to="/" className="flex items-center">
            <AriviooLogo size="md" />
          </Link>
          <Button asChild className="bg-gradient-primary hover:opacity-90">
            <Link to="/auth">Get Started</Link>
          </Button>
        </div>
      </header>

      <main>
        {/* Hero Section */}
        <section className="py-16 md:py-24 bg-gradient-warm">
          <div className="container px-4">
            <div className="max-w-3xl mx-auto text-center">
              <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary/10 text-primary mb-6">
                <Sparkles className="w-4 h-4" />
                <span className="text-sm font-medium">Simple, Fair Pricing</span>
              </div>
              
              <h1 className="text-4xl md:text-5xl font-bold text-foreground mb-6">
                Pay Only When You <span className="text-gradient">Save</span>
              </h1>
              
              <p className="text-lg md:text-xl text-muted-foreground mb-8">
                Arivioo is free to use. We only charge a small fee when we find you a better deal — 
                and you keep 90% of the savings.
              </p>

              <div className="inline-flex items-center gap-4 p-6 bg-card rounded-2xl border border-border shadow-large">
                <div className="text-left">
                  <p className="text-sm text-muted-foreground mb-1">Success Fee</p>
                  <p className="text-4xl font-bold text-foreground">10%</p>
                  <p className="text-sm text-muted-foreground">of your savings</p>
                </div>
                <div className="w-px h-16 bg-border" />
                <div className="text-left">
                  <p className="text-sm text-muted-foreground mb-1">You Keep</p>
                  <p className="text-4xl font-bold text-success">90%</p>
                  <p className="text-sm text-muted-foreground">of your savings</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* How It Works */}
        <section className="py-16 md:py-24 bg-card">
          <div className="container px-4">
            <div className="max-w-4xl mx-auto">
              <div className="text-center mb-12">
                <h2 className="text-3xl md:text-4xl font-bold text-foreground mb-4">
                  How Our Pricing Works
                </h2>
                <p className="text-lg text-muted-foreground">
                  A simple, transparent model that aligns our success with yours
                </p>
              </div>

              <div className="grid md:grid-cols-3 gap-6 mb-12">
                <div className="bg-background rounded-2xl p-6 border border-border text-center">
                  <div className="w-14 h-14 bg-primary/10 rounded-2xl flex items-center justify-center mx-auto mb-4">
                    <Zap className="w-7 h-7 text-primary" />
                  </div>
                  <h3 className="text-lg font-bold text-foreground mb-2">Search Free</h3>
                  <p className="text-sm text-muted-foreground">
                    Paste any Airbnb link and search for alternatives across all platforms. Always free.
                  </p>
                </div>

                <div className="bg-background rounded-2xl p-6 border border-border text-center">
                  <div className="w-14 h-14 bg-primary/10 rounded-2xl flex items-center justify-center mx-auto mb-4">
                    <Unlock className="w-7 h-7 text-primary" />
                  </div>
                  <h3 className="text-lg font-bold text-foreground mb-2">View Alternatives Free</h3>
                  <p className="text-sm text-muted-foreground">
                    See all alternatives we find — prices, platforms, and match scores. All free to view.
                  </p>
                </div>

                <div className="bg-background rounded-2xl p-6 border border-border text-center">
                  <div className="w-14 h-14 bg-success/10 rounded-2xl flex items-center justify-center mx-auto mb-4">
                    <Lock className="w-7 h-7 text-success" />
                  </div>
                  <h3 className="text-lg font-bold text-foreground mb-2">Unlock Best Deal</h3>
                  <p className="text-sm text-muted-foreground">
                    Pay 10% of savings to unlock and access the cheapest option. You keep the rest!
                  </p>
                </div>
              </div>

              {/* Visual Flow */}
              <div className="bg-muted/30 rounded-2xl p-6 md:p-8">
                <div className="flex flex-col md:flex-row items-center justify-center gap-4 md:gap-8">
                  <div className="text-center">
                    <div className="w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-2">
                      <span className="text-primary font-bold">1</span>
                    </div>
                    <p className="text-sm font-medium text-foreground">Search</p>
                    <p className="text-xs text-muted-foreground">Free</p>
                  </div>
                  
                  <ArrowRight className="w-6 h-6 text-muted-foreground rotate-90 md:rotate-0" />
                  
                  <div className="text-center">
                    <div className="w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-2">
                      <span className="text-primary font-bold">2</span>
                    </div>
                    <p className="text-sm font-medium text-foreground">Compare</p>
                    <p className="text-xs text-muted-foreground">Free</p>
                  </div>
                  
                  <ArrowRight className="w-6 h-6 text-muted-foreground rotate-90 md:rotate-0" />
                  
                  <div className="text-center">
                    <div className="w-12 h-12 bg-success/10 rounded-full flex items-center justify-center mx-auto mb-2">
                      <span className="text-success font-bold">3</span>
                    </div>
                    <p className="text-sm font-medium text-foreground">Unlock Best</p>
                    <p className="text-xs text-success font-medium">10% of savings</p>
                  </div>
                  
                  <ArrowRight className="w-6 h-6 text-muted-foreground rotate-90 md:rotate-0" />
                  
                  <div className="text-center">
                    <div className="w-12 h-12 bg-success/10 rounded-full flex items-center justify-center mx-auto mb-2">
                      <span className="text-success font-bold">4</span>
                    </div>
                    <p className="text-sm font-medium text-foreground">Book Direct</p>
                    <p className="text-xs text-success font-medium">Keep 90%!</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Real Examples */}
        <section className="py-16 md:py-24 bg-background">
          <div className="container px-4">
            <div className="max-w-4xl mx-auto">
              <div className="text-center mb-12">
                <div className="inline-flex items-center gap-2 mb-4">
                  <Calculator className="w-6 h-6 text-primary" />
                  <h2 className="text-3xl md:text-4xl font-bold text-foreground">
                    Real Savings Examples
                  </h2>
                </div>
                <p className="text-lg text-muted-foreground">
                  See how much you could save with Arivioo
                </p>
              </div>

              <div className="grid md:grid-cols-3 gap-6">
                {examples.map((example, index) => (
                  <div key={index} className="bg-card rounded-2xl border border-border overflow-hidden">
                    <div className="bg-muted/30 px-6 py-3 border-b border-border">
                      <p className="text-sm font-medium text-foreground">
                        {example.nights}-Night Stay
                      </p>
                    </div>
                    <div className="p-6 space-y-4">
                      <div className="flex justify-between items-center">
                        <span className="text-sm text-muted-foreground">Airbnb Price</span>
                        <span className="font-semibold text-foreground">${example.airbnbPrice}</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-sm text-muted-foreground">{example.platform}</span>
                        <span className="font-semibold text-success">${example.alternativePrice}</span>
                      </div>
                      <div className="border-t border-border pt-4">
                        <div className="flex justify-between items-center mb-2">
                          <span className="text-sm text-muted-foreground">Total Savings</span>
                          <span className="font-semibold text-foreground">${example.savings}</span>
                        </div>
                        <div className="flex justify-between items-center mb-2">
                          <span className="text-sm text-muted-foreground">Arivioo Fee (10%)</span>
                          <span className="text-sm text-muted-foreground">-${example.fee}</span>
                        </div>
                        <div className="flex justify-between items-center pt-2 border-t border-border">
                          <span className="text-sm font-medium text-foreground">You Keep</span>
                          <span className="text-xl font-bold text-success">${example.netSavings}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* What's Included */}
        <section className="py-16 md:py-24 bg-card">
          <div className="container px-4">
            <div className="max-w-4xl mx-auto">
              <div className="text-center mb-12">
                <h2 className="text-3xl md:text-4xl font-bold text-foreground mb-4">
                  What's Included
                </h2>
                <p className="text-lg text-muted-foreground">
                  Everything you need to find the best deal
                </p>
              </div>

              <div className="grid md:grid-cols-2 gap-8">
                <div className="bg-background rounded-2xl p-6 border border-border">
                  <h3 className="text-xl font-bold text-foreground mb-4 flex items-center gap-2">
                    <Sparkles className="w-5 h-5 text-primary" />
                    Always Free
                  </h3>
                  <ul className="space-y-3">
                    {[
                      "Unlimited searches",
                      "AI-powered image matching",
                      "Cross-platform price comparison",
                      "View all alternatives found",
                      "Trust score for each match",
                      "Price breakdown with fees",
                    ].map((item, index) => (
                      <li key={index} className="flex items-center gap-3 text-sm text-muted-foreground">
                        <Check className="w-4 h-4 text-success flex-shrink-0" />
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="bg-success/5 rounded-2xl p-6 border border-success/20">
                  <h3 className="text-xl font-bold text-foreground mb-4 flex items-center gap-2">
                    <Shield className="w-5 h-5 text-success" />
                    With Unlock (10% of savings)
                  </h3>
                  <ul className="space-y-3">
                    {[
                      "Direct link to the cheapest option",
                      "Full booking details revealed",
                      "Host contact information",
                      "Priority support",
                      "Booking confirmation tips",
                      "Keep 90% of your savings",
                    ].map((item, index) => (
                      <li key={index} className="flex items-center gap-3 text-sm text-muted-foreground">
                        <Check className="w-4 h-4 text-success flex-shrink-0" />
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section className="py-16 md:py-24 bg-background">
          <div className="container px-4">
            <div className="max-w-3xl mx-auto">
              <div className="text-center mb-12">
                <h2 className="text-3xl md:text-4xl font-bold text-foreground mb-4">
                  Pricing FAQ
                </h2>
                <p className="text-lg text-muted-foreground">
                  Common questions about our pricing model
                </p>
              </div>

              <Accordion type="single" collapsible className="space-y-4">
                {pricingFaqs.map((faq, index) => (
                  <AccordionItem 
                    key={index} 
                    value={`item-${index}`}
                    className="bg-card rounded-xl border border-border px-6 shadow-soft"
                  >
                    <AccordionTrigger className="text-left font-semibold text-foreground hover:no-underline py-5">
                      {faq.question}
                    </AccordionTrigger>
                    <AccordionContent className="text-muted-foreground pb-5 leading-relaxed">
                      {faq.answer}
                    </AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="py-16 md:py-24 bg-gradient-primary">
          <div className="container px-4">
            <div className="max-w-3xl mx-auto text-center">
              <h2 className="text-3xl md:text-4xl font-bold text-white mb-4">
                Ready to Start Saving?
              </h2>
              <p className="text-lg text-white/90 mb-8">
                Try Arivioo for free. You only pay when we find you a better deal.
              </p>
              <Button 
                asChild 
                size="lg" 
                className="bg-white text-primary hover:bg-white/90 h-14 px-8 text-lg font-semibold"
              >
                <Link to="/auth">
                  Get Started Free
                  <ArrowRight className="w-5 h-5 ml-2" />
                </Link>
              </Button>
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="py-8 bg-card border-t border-border">
        <div className="container px-4 text-center">
          <Link to="/" className="flex items-center gap-2 justify-center mb-4">
            <AriviooLogoStatic size="sm" />
          </Link>
          <p className="text-sm text-muted-foreground">
            © {new Date().getFullYear()} Arivioo. All rights reserved.
          </p>
        </div>
      </footer>
    </div>
  );
}
