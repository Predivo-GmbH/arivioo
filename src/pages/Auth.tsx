import { useEffect } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { ArrowLeft, Loader2 } from "lucide-react";

export default function Auth() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const redirectTo = searchParams.get("redirect") || "/dashboard";
  const urlParam = searchParams.get("url");

  useEffect(() => {
    const autoLogin = async () => {
      // Check if already logged in
      const { data: { session } } = await supabase.auth.getSession();
      
      if (session?.user) {
        const finalRedirect = urlParam ? `${redirectTo}?url=${encodeURIComponent(urlParam)}` : redirectTo;
        navigate(finalRedirect);
        return;
      }

      // Auto sign in anonymously for demo purposes
      const { error } = await supabase.auth.signInAnonymously();
      
      if (error) {
        console.error("Auto-login error:", error);
        // Still redirect even if there's an error
      }
      
      const finalRedirect = urlParam ? `${redirectTo}?url=${encodeURIComponent(urlParam)}` : redirectTo;
      navigate(finalRedirect);
    };

    autoLogin();
  }, [navigate, redirectTo, urlParam]);

  return (
    <div className="min-h-screen bg-gradient-warm flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <Link to="/" className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground mb-8 transition-colors">
          <ArrowLeft className="w-4 h-4" />
          Back to home
        </Link>

        <div className="bg-card rounded-2xl shadow-large border border-border p-8 text-center">
          <div className="w-12 h-12 bg-gradient-primary rounded-xl flex items-center justify-center mx-auto mb-4">
            <span className="text-white font-bold text-xl">A</span>
          </div>
          
          <Loader2 className="w-8 h-8 animate-spin text-primary mx-auto mb-4" />
          
          <h1 className="text-xl font-semibold text-foreground mb-2">
            Setting up your session...
          </h1>
          <p className="text-muted-foreground">
            You'll be redirected automatically
          </p>
        </div>
      </div>
    </div>
  );
}