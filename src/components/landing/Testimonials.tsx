import { Star, Quote } from "lucide-react";

const testimonials = [
  {
    name: "Sarah M.",
    location: "Austin, TX",
    avatar: "S",
    rating: 5,
    savings: "$340",
    quote: "I was skeptical at first, but Arivioo found the exact same beach house on the owner's direct site for $85 less per night. Over my 4-night stay, that's $340 back in my pocket!",
  },
  {
    name: "Marcus J.",
    location: "Chicago, IL",
    avatar: "M",
    rating: 5,
    savings: "$520",
    quote: "Used this for our family reunion rental. The AI found it listed on Vrbo for way less than Airbnb was charging. The whole process took less than a minute.",
  },
  {
    name: "Emily & David",
    location: "Seattle, WA",
    avatar: "E",
    rating: 5,
    savings: "$275",
    quote: "We book vacation rentals 4-5 times a year. Arivioo has become our first stop before any booking. It's already saved us over a thousand dollars this year alone.",
  },
  {
    name: "James T.",
    location: "Miami, FL",
    avatar: "J",
    rating: 5,
    savings: "$180",
    quote: "Found the same gorgeous cabin on the owner's website without the platform fees. Simple, fast, and the savings are real. Why didn't this exist sooner?",
  },
];

export function Testimonials() {
  return (
    <section className="py-20 md:py-28 bg-secondary/30">
      <div className="container px-4">
        <div className="text-center mb-12 md:mb-16">
          <h2 className="text-3xl md:text-4xl lg:text-5xl font-bold text-foreground mb-4">
            Travelers Are <span className="text-gradient">Saving Big</span>
          </h2>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
            Real savings from real travelers who found better deals with Arivioo.
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-6 max-w-5xl mx-auto">
          {testimonials.map((testimonial, index) => (
            <div
              key={index}
              className="bg-card rounded-2xl border border-border p-6 md:p-8 shadow-soft hover:shadow-medium transition-shadow duration-300"
            >
              {/* Quote Icon */}
              <Quote className="w-10 h-10 text-primary/20 mb-4" />

              {/* Testimonial Text */}
              <p className="text-foreground mb-6 leading-relaxed">
                "{testimonial.quote}"
              </p>

              {/* Author & Rating */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-full bg-gradient-primary flex items-center justify-center text-white font-bold text-lg">
                    {testimonial.avatar}
                  </div>
                  <div>
                    <p className="font-semibold text-foreground">{testimonial.name}</p>
                    <p className="text-sm text-muted-foreground">{testimonial.location}</p>
                  </div>
                </div>

                <div className="text-right">
                  <div className="flex items-center gap-0.5 mb-1 justify-end">
                    {[...Array(testimonial.rating)].map((_, i) => (
                      <Star key={i} className="w-4 h-4 fill-amber-400 text-amber-400" />
                    ))}
                  </div>
                  <p className="text-sm font-semibold text-success">
                    Saved {testimonial.savings}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Summary Stats */}
        <div className="mt-12 md:mt-16 flex flex-wrap justify-center gap-8 md:gap-16">
          <div className="text-center">
            <p className="text-3xl md:text-4xl font-bold text-foreground">$2.4M+</p>
            <p className="text-muted-foreground">Saved by travelers</p>
          </div>
          <div className="text-center">
            <p className="text-3xl md:text-4xl font-bold text-foreground">45,000+</p>
            <p className="text-muted-foreground">Searches completed</p>
          </div>
          <div className="text-center">
            <p className="text-3xl md:text-4xl font-bold text-foreground">4.9/5</p>
            <p className="text-muted-foreground">Average rating</p>
          </div>
        </div>
      </div>
    </section>
  );
}
