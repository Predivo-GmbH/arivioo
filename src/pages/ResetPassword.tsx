import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, Loader2, CheckCircle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";

export default function ResetPassword() {
  const navigate = useNavigate();
  const { toast } = useToast();

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Check if we have a valid recovery session
  useEffect(() => {
    const checkSession = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      
      // If no session at all, user might have landed here without a valid token
      if (!session) {
        setError("Invalid or expired reset link. Please request a new password reset.");
      }
    };

    // Listen for auth state changes (recovery flow sets a session)
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") {
        // User came from a password recovery link - session is set
        setError(null);
      }
    });

    checkSession();

    return () => subscription.unsubscribe();
  }, []);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (password.length < 8) {
      toast({
        title: "Password too short",
        description: "Password must be at least 8 characters.",
        variant: "destructive",
      });
      return;
    }

    if (password !== confirmPassword) {
      toast({
        title: "Passwords don't match",
        description: "Please make sure both passwords are the same.",
        variant: "destructive",
      });
      return;
    }

    setSubmitting(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      
      if (error) throw error;

      setSuccess(true);
      toast({
        title: "Password updated",
        description: "Your password has been successfully changed.",
      });

      // Redirect to dashboard after a short delay
      setTimeout(() => {
        navigate("/dashboard", { replace: true });
      }, 2000);
    } catch (err: any) {
      toast({
        title: "Error updating password",
        description: err?.message || "Please try again.",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-warm flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <Link
          to="/auth"
          className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground mb-8 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to sign in
        </Link>

        <div className="bg-card rounded-2xl shadow-large border border-border p-8">
          <div className="w-12 h-12 bg-gradient-primary rounded-xl flex items-center justify-center mx-auto mb-4">
            <span className="text-white font-bold text-xl">A</span>
          </div>

          {success ? (
            <div className="text-center">
              <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-4">
                <CheckCircle className="w-8 h-8 text-primary" />
              </div>
              <h1 className="text-xl font-semibold text-foreground mb-2">
                Password Updated
              </h1>
              <p className="text-muted-foreground mb-4">
                Your password has been successfully changed. Redirecting you to the dashboard...
              </p>
            </div>
          ) : error ? (
            <div className="text-center">
              <h1 className="text-xl font-semibold text-foreground mb-2">
                Reset Link Expired
              </h1>
              <p className="text-muted-foreground mb-6">
                {error}
              </p>
              <Button asChild className="w-full">
                <Link to="/auth">Back to Sign In</Link>
              </Button>
            </div>
          ) : (
            <>
              <h1 className="text-xl font-semibold text-foreground text-center mb-2">
                Set New Password
              </h1>
              <p className="text-muted-foreground text-center mb-6">
                Enter your new password below.
              </p>

              <form onSubmit={onSubmit} className="space-y-3">
                <Input
                  type="password"
                  autoComplete="new-password"
                  placeholder="New password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                />
                <Input
                  type="password"
                  autoComplete="new-password"
                  placeholder="Confirm new password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  minLength={8}
                />

                <Button
                  type="submit"
                  className="w-full bg-gradient-primary hover:opacity-90"
                  disabled={submitting}
                >
                  {submitting ? (
                    <span className="inline-flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Updating...
                    </span>
                  ) : (
                    "Update Password"
                  )}
                </Button>
              </form>

              <p className="text-xs text-muted-foreground mt-4">
                Passwords must be at least 8 characters.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
