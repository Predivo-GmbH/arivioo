import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";

const getSafeRedirectPath = (raw: string | null): string => {
  const fallback = "/dashboard";
  if (!raw) return fallback;

  // Only allow app-internal paths. Prevents open redirects.
  if (!raw.startsWith("/")) return fallback;
  if (raw.startsWith("//")) return fallback;
  if (raw.includes("\n") || raw.includes("\r")) return fallback;

  return raw;
};

export default function Auth() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { toast } = useToast();

  const redirectTo = useMemo(
    () => getSafeRedirectPath(searchParams.get("redirect")),
    [searchParams]
  );
  const urlParam = searchParams.get("url");

  const [mode, setMode] = useState<"login" | "signup" | "forgot">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [resetEmailSent, setResetEmailSent] = useState(false);

  const finalRedirect = useMemo(() => {
    return urlParam
      ? `${redirectTo}?url=${encodeURIComponent(urlParam)}`
      : redirectTo;
  }, [redirectTo, urlParam]);

  useEffect(() => {
    const checkExistingSession = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (session?.user) {
        navigate(finalRedirect, { replace: true });
      }
    };

    checkExistingSession();
  }, [navigate, finalRedirect]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    if (mode !== "forgot" && !password) return;

    setSubmitting(true);
    try {
      if (mode === "forgot") {
        const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
          redirectTo: `${window.location.origin}/reset-password`,
        });
        if (error) throw error;

        setResetEmailSent(true);
        toast({
          title: "Reset email sent",
          description: "Check your inbox for the password reset link.",
        });
        return;
      }

      if (mode === "login") {
        const { error } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (error) throw error;

        navigate(finalRedirect, { replace: true });
        return;
      }

      const { error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
      });
      if (error) throw error;

      toast({
        title: "Account created",
        description: "You're now signed in.",
      });

      navigate(finalRedirect, { replace: true });
    } catch (err: any) {
      toast({
        title: mode === "forgot" ? "Error sending reset email" : "Authentication error",
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
          to="/"
          className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground mb-8 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to home
        </Link>

        <div className="bg-card rounded-2xl shadow-large border border-border p-8">
          <div className="w-12 h-12 bg-gradient-primary rounded-xl flex items-center justify-center mx-auto mb-4">
            <span className="text-white font-bold text-xl">A</span>
          </div>

          {mode === "forgot" ? (
            resetEmailSent ? (
              <div className="text-center">
                <h1 className="text-xl font-semibold text-foreground mb-2">
                  Check your email
                </h1>
                <p className="text-muted-foreground mb-6">
                  We've sent a password reset link to <strong>{email}</strong>. Click the link in the email to set a new password.
                </p>
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => {
                    setMode("login");
                    setResetEmailSent(false);
                  }}
                >
                  Back to Sign In
                </Button>
              </div>
            ) : (
              <>
                <h1 className="text-xl font-semibold text-foreground text-center mb-2">
                  Forgot your password?
                </h1>
                <p className="text-muted-foreground text-center mb-6">
                  Enter your email and we'll send you a reset link.
                </p>

                <form onSubmit={onSubmit} className="space-y-3">
                  <Input
                    type="email"
                    autoComplete="email"
                    placeholder="Email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />

                  <Button
                    type="submit"
                    className="w-full bg-gradient-primary hover:opacity-90"
                    disabled={submitting}
                  >
                    {submitting ? (
                      <span className="inline-flex items-center gap-2">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Sending...
                      </span>
                    ) : (
                      "Send Reset Link"
                    )}
                  </Button>
                </form>

                <button
                  type="button"
                  onClick={() => setMode("login")}
                  className="w-full text-sm text-muted-foreground hover:text-foreground mt-4 transition-colors"
                >
                  Back to Sign In
                </button>
              </>
            )
          ) : (
            <>
              <h1 className="text-xl font-semibold text-foreground text-center mb-2">
                {mode === "login" ? "Sign in" : "Create your account"}
              </h1>
              <p className="text-muted-foreground text-center mb-6">
                {mode === "login"
                  ? "Sign in to access your dashboard."
                  : "Create an account to save searches and view results."}
              </p>

              <div className="grid grid-cols-2 gap-2 mb-6">
                <Button
                  type="button"
                  variant={mode === "login" ? "default" : "outline"}
                  onClick={() => setMode("login")}
                  disabled={submitting}
                >
                  Sign in
                </Button>
                <Button
                  type="button"
                  variant={mode === "signup" ? "default" : "outline"}
                  onClick={() => setMode("signup")}
                  disabled={submitting}
                >
                  Sign up
                </Button>
              </div>

              <form onSubmit={onSubmit} className="space-y-3">
                <Input
                  type="email"
                  autoComplete="email"
                  placeholder="Email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
                <div>
                  <Input
                    type="password"
                    autoComplete={mode === "login" ? "current-password" : "new-password"}
                    placeholder="Password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={8}
                  />
                  {mode === "login" && (
                    <button
                      type="button"
                      onClick={() => setMode("forgot")}
                      className="text-sm text-primary hover:text-primary/80 mt-2 transition-colors"
                    >
                      Forgot password?
                    </button>
                  )}
                </div>

                <Button
                  type="submit"
                  className="w-full bg-gradient-primary hover:opacity-90"
                  disabled={submitting}
                >
                  {submitting ? (
                    <span className="inline-flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Please wait
                    </span>
                  ) : mode === "login" ? (
                    "Sign in"
                  ) : (
                    "Sign up"
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
