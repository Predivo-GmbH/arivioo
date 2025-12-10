import { Shield, Lock, Eye } from "lucide-react";

export function Trust() {
  return (
    <section className="py-20 md:py-32 bg-gradient-warm">
      <div className="container px-4">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-3xl md:text-4xl font-bold text-foreground mb-4">
              Trust & Transparency
            </h2>
            <p className="text-lg text-muted-foreground">
              Your privacy and trust matter to us
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-6">
            <div className="bg-card rounded-2xl p-6 shadow-soft border border-border text-center">
              <div className="w-14 h-14 bg-primary/10 rounded-2xl flex items-center justify-center mx-auto mb-4">
                <Shield className="w-7 h-7 text-primary" />
              </div>
              <h3 className="text-lg font-bold text-foreground mb-2">Independent Service</h3>
              <p className="text-sm text-muted-foreground">
                Arivioo is not affiliated with, endorsed by, or connected to Airbnb in any way. We're an independent tool built to help travelers save money.
              </p>
            </div>

            <div className="bg-card rounded-2xl p-6 shadow-soft border border-border text-center">
              <div className="w-14 h-14 bg-primary/10 rounded-2xl flex items-center justify-center mx-auto mb-4">
                <Lock className="w-7 h-7 text-primary" />
              </div>
              <h3 className="text-lg font-bold text-foreground mb-2">Privacy First</h3>
              <p className="text-sm text-muted-foreground">
                Your searches are private. We don't store the links you paste or any personal booking info. All comparisons are performed on-the-fly.
              </p>
            </div>

            <div className="bg-card rounded-2xl p-6 shadow-soft border border-border text-center">
              <div className="w-14 h-14 bg-primary/10 rounded-2xl flex items-center justify-center mx-auto mb-4">
                <Eye className="w-7 h-7 text-primary" />
              </div>
              <h3 className="text-lg font-bold text-foreground mb-2">No Hidden Fees</h3>
              <p className="text-sm text-muted-foreground">
                Arivioo doesn't charge you anything and takes no commission on bookings. If you save $100, you keep all of it.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
