import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

const faqs = [
  {
    question: "Is this legal?",
    answer: "Yes. Using Arivioo is completely legal. We're leveraging publicly available information (like listing photos and details) and search technology to find the same property on other sites. It's like doing a Google search or reverse image lookup, just automated for your convenience."
  },
  {
    question: "Does this work with any Airbnb listing?",
    answer: "In most cases, yes, especially for popular rentals. Many Airbnb hosts list their properties on multiple platforms (like Vrbo, Booking.com, or their own website). Arivioo shines in those cases. If a property is only on Airbnb and nowhere else, then there won't be an alternate listing to find – but that's relatively rare for high-demand rentals."
  },
  {
    question: "Can I trust the alternate listings?",
    answer: "Absolutely. If Arivioo shows you a listing on another site, it's the same property you saw on Airbnb, just on a different platform. We might direct you to well-known vacation rental sites or the property's official booking page. It's the same host/owner, just without the Airbnb middleman."
  },
  {
    question: "Does Arivioo take a cut or charge me?",
    answer: "No. Arivioo doesn't charge you anything, and we don't take a commission on bookings. Our service is free to use. We simply show you where you can get a better price, and you book it directly. There are no markups and no hidden fees from Arivioo."
  },
  {
    question: "What if the same listing isn't found elsewhere?",
    answer: "If we can't find the property on another site, it means that rental might truly be unique to Airbnb (or occasionally, it's just hard to match via the data available). In that case, we'll let you know that no cheaper alternative was found. The good news is that a huge number of Airbnb rentals are cross-listed on other platforms."
  },
  {
    question: "How long does the search take?",
    answer: "Our AI-powered search typically takes 30-60 seconds to scan multiple platforms and verify property matches. We show you a real-time progress indicator so you know exactly what's happening."
  }
];

export function FAQ() {
  return (
    <section className="py-20 md:py-32 bg-card">
      <div className="container px-4">
        <div className="text-center max-w-2xl mx-auto mb-12">
          <h2 className="text-3xl md:text-4xl font-bold text-foreground mb-4">
            Frequently Asked Questions
          </h2>
          <p className="text-lg text-muted-foreground">
            Got questions? We've got answers
          </p>
        </div>

        <div className="max-w-3xl mx-auto">
          <Accordion type="single" collapsible className="space-y-4">
            {faqs.map((faq, index) => (
              <AccordionItem 
                key={index} 
                value={`item-${index}`}
                className="bg-background rounded-xl border border-border px-6 shadow-soft"
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
  );
}
