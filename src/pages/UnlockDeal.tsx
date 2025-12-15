import { useEffect, useState } from "react";
import { Link, useSearchParams, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { CheckCircle2, ExternalLink, ArrowLeft, Sparkles, Shield, Lock, PartyPopper } from "lucide-react";
import { celebrateSavings } from "@/lib/confetti";

export default function UnlockDeal() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [unlocked, setUnlocked] = useState(false);
  const [dealUrl, setDealUrl] = useState<string | null>(null);
  const [platformName, setPlatformName] = useState<string>("Direct Booking");
  const [savings, setSavings] = useState<number | null>(null);
  const [unlockFee, setUnlockFee] = useState<number | null>(null);

  const resultId = searchParams.get("resultId");
  const searchId = searchParams.get("searchId");

  useEffect(() => {
    // Fetch deal details
    const fetchDeal = async () => {
      if (!resultId) return;

      const { data, error } = await supabase
        .from("search_results")
        .select("listing_url, platform_name, savings_amount")
        .eq("id", resultId)
        .maybeSingle();

      if (data) {
        setDealUrl(data.listing_url);
        setPlatformName(data.platform_name);
        if (data.savings_amount) {
          setSavings(data.savings_amount);
          setUnlockFee(Math.round(data.savings_amount * 0.1 * 100) / 100);
        }
      }
    };

    fetchDeal();
  }, [resultId]);

  const handleUnlock = () => {
    // For development: immediately unlock and show success
    setUnlocked(true);
    celebrateSavings();
  };

  // Logo component
  function AriviooLogo() {
    return (
      <div className="flex items-center gap-2.5">
        <div className="w-8 h-8 bg-gradient-primary rounded-xl flex items-center justify-center shadow-soft">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="text-white">
            <path d="M12 2L4 7V17L12 22L20 17V7L12 2Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M12 22V12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M12 12L4 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M12 12L20 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
        <span className="font-bold text-xl text-foreground tracking-tight">Arivioo</span>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="container px-4 h-16 flex items-center justify-between">
          <button
            onClick={() => navigate(-1)}
            className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            <span className="hidden sm:inline">Back</span>
          </button>
          <Link to="/">
            <AriviooLogo />
          </Link>
        </div>
      </header>

      <main className="container px-4 py-12 md:py-20">
        <div className="max-w-lg mx-auto">
          {!unlocked ? (
            // Pre-unlock state
            <div className="bg-card rounded-2xl shadow-large border border-border p-8 text-center">
              <div className="w-16 h-16 mx-auto mb-6 rounded-full bg-success/10 flex items-center justify-center">
                <Lock className="w-8 h-8 text-success" />
              </div>
              
              <h1 className="text-2xl md:text-3xl font-bold text-foreground mb-3">
                Unlock Your Deal
              </h1>
              
              <p className="text-muted-foreground mb-6">
                You're about to unlock the best price for this property on <strong className="text-foreground">{platformName}</strong>.
              </p>

              {savings && unlockFee && (
                <div className="bg-success/5 border border-success/20 rounded-xl p-6 mb-6">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-muted-foreground">Your savings</span>
                    <span className="text-2xl font-bold text-success">€{Math.round(savings)}</span>
                  </div>
                  <div className="flex items-center justify-between border-t border-success/20 pt-3">
                    <span className="text-muted-foreground">Unlock fee (10%)</span>
                    <span className="text-lg font-semibold text-foreground">€{unlockFee.toFixed(2)}</span>
                  </div>
                </div>
              )}

              <div className="space-y-3 mb-8 text-left">
                <div className="flex items-start gap-3">
                  <Shield className="w-5 h-5 text-success mt-0.5" />
                  <span className="text-sm text-muted-foreground">Verified match with 90%+ confidence</span>
                </div>
                <div className="flex items-start gap-3">
                  <CheckCircle2 className="w-5 h-5 text-success mt-0.5" />
                  <span className="text-sm text-muted-foreground">Direct booking link to skip platform fees</span>
                </div>
                <div className="flex items-start gap-3">
                  <Sparkles className="w-5 h-5 text-success mt-0.5" />
                  <span className="text-sm text-muted-foreground">Only pay when you actually save money</span>
                </div>
              </div>

              <Button 
                size="lg" 
                className="w-full bg-success hover:bg-success/90 text-lg h-14"
                onClick={handleUnlock}
              >
                <Lock className="w-5 h-5 mr-2" />
                Unlock Deal {unlockFee ? `for €${unlockFee.toFixed(2)}` : ''}
              </Button>

              <p className="text-xs text-muted-foreground mt-4">
                By clicking unlock, you agree to pay the unlock fee via Stripe.
                <br />
                <span className="text-primary">(Development mode: No payment required)</span>
              </p>
            </div>
          ) : (
            // Post-unlock success state
            <div className="bg-card rounded-2xl shadow-large border border-border p-8 text-center animate-scale-in">
              <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-success/10 flex items-center justify-center animate-bounce">
                <PartyPopper className="w-10 h-10 text-success" />
              </div>
              
              <h1 className="text-2xl md:text-3xl font-bold text-foreground mb-3">
                Deal Unlocked! 🎉
              </h1>
              
              <p className="text-muted-foreground mb-6">
                Your exclusive booking link is ready. Click below to complete your booking on <strong className="text-foreground">{platformName}</strong>.
              </p>

              {savings && (
                <div className="inline-flex items-center gap-2 px-6 py-3 bg-success/10 text-success rounded-full font-bold text-lg mb-8">
                  <Sparkles className="w-5 h-5" />
                  You're saving €{Math.round(savings)}!
                </div>
              )}

              <Button 
                size="lg" 
                className="w-full bg-success hover:bg-success/90 text-lg h-14 mb-4"
                asChild
              >
                <a href={dealUrl || "#"} target="_blank" rel="noopener noreferrer">
                  Book Now on {platformName}
                  <ExternalLink className="w-5 h-5 ml-2" />
                </a>
              </Button>

              <p className="text-sm text-muted-foreground mb-6">
                You'll be redirected to the booking site. Make sure to verify all details before completing your reservation.
              </p>

              <Button variant="outline" asChild>
                <Link to="/dashboard">
                  Search Another Property
                </Link>
              </Button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
