import { useEffect, useMemo, useState, useRef, useCallback } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, Loader2, Mail, KeyRound, Lock, CheckCircle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";

const getSafeRedirectPath = (raw: string | null): string => {
  const fallback = "/dashboard";
  if (!raw) return fallback;

  if (!raw.startsWith("/")) return fallback;
  if (raw.startsWith("//")) return fallback;
  if (raw.includes("\n") || raw.includes("\r")) return fallback;

  return raw;
};

type SignupStep = "email" | "code" | "password" | "success";

export default function Auth() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { toast } = useToast();

  const redirectTo = useMemo(
    () => getSafeRedirectPath(searchParams.get("redirect")),
    [searchParams]
  );
  const urlParam = searchParams.get("url");

  const [mode, setMode] = useState<"login" | "signup">("login");
  const [signupStep, setSignupStep] = useState<SignupStep>("email");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [code, setCode] = useState(["", "", "", "", "", ""]);
  const [verificationToken, setVerificationToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [codeExpiry, setCodeExpiry] = useState<number | null>(null);

  const codeInputRefs = useRef<(HTMLInputElement | null)[]>([]);

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

  // Countdown timers
  useEffect(() => {
    if (resendCooldown > 0) {
      const timer = setTimeout(() => setResendCooldown(resendCooldown - 1), 1000);
      return () => clearTimeout(timer);
    }
  }, [resendCooldown]);

  useEffect(() => {
    if (codeExpiry && codeExpiry > 0) {
      const timer = setTimeout(() => setCodeExpiry(codeExpiry - 1), 1000);
      return () => clearTimeout(timer);
    }
  }, [codeExpiry]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) return;

    setSubmitting(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (error) throw error;

      navigate(finalRedirect, { replace: true });
    } catch (err: any) {
      toast({
        title: "Sign in failed",
        description: err?.message || "Please check your credentials and try again.",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  const requestSignupCode = async (e?: React.FormEvent) => {
    e?.preventDefault();

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || !emailRegex.test(email)) {
      toast({
        title: "Invalid email",
        description: "Please enter a valid email address.",
        variant: "destructive",
      });
      return;
    }

    setSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke("request-signup-code", {
        body: { email },
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      setSignupStep("code");
      setResendCooldown(60);
      setCodeExpiry(15 * 60);
      setCode(["", "", "", "", "", ""]);

      setTimeout(() => codeInputRefs.current[0]?.focus(), 100);

      toast({
        title: "Check your inbox",
        description: "We've sent a 6-digit verification code to your email.",
      });
    } catch (err: any) {
      toast({
        title: "Failed to send code",
        description: err?.message || "Please try again.",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleCodeChange = useCallback((index: number, value: string) => {
    const digit = value.replace(/\D/g, "").slice(-1);

    setCode((prev) => {
      const newCode = [...prev];
      newCode[index] = digit;
      return newCode;
    });

    if (digit && index < 5) {
      codeInputRefs.current[index + 1]?.focus();
    }
  }, []);

  const handleCodeKeyDown = useCallback((index: number, e: React.KeyboardEvent) => {
    if (e.key === "Backspace" && !code[index] && index > 0) {
      codeInputRefs.current[index - 1]?.focus();
    }
  }, [code]);

  const handleCodePaste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault();
    const pastedData = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);

    if (pastedData.length === 6) {
      setCode(pastedData.split(""));
      codeInputRefs.current[5]?.focus();
    }
  }, []);

  const verifySignupCode = async (e?: React.FormEvent) => {
    e?.preventDefault();

    const fullCode = code.join("");
    if (fullCode.length !== 6) {
      toast({
        title: "Incomplete code",
        description: "Please enter all 6 digits.",
        variant: "destructive",
      });
      return;
    }

    setSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke("verify-signup-code", {
        body: { email, code: fullCode },
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      setVerificationToken(data.verificationToken);
      setSignupStep("password");

      toast({
        title: "Email verified",
        description: "Now set your password to complete signup.",
      });
    } catch (err: any) {
      toast({
        title: "Verification failed",
        description: err?.message || "Please try again.",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  const completeSignup = async (e: React.FormEvent) => {
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
      const { data, error } = await supabase.functions.invoke("complete-signup", {
        body: { email, verificationToken, password },
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      setSignupStep("success");

      toast({
        title: "Account created!",
        description: "You can now sign in with your new account.",
      });

      // Auto sign in after short delay
      setTimeout(async () => {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (!signInError) {
          navigate(finalRedirect, { replace: true });
        } else {
          setMode("login");
          setSignupStep("email");
        }
      }, 2000);
    } catch (err: any) {
      toast({
        title: "Failed to create account",
        description: err?.message || "Please try again.",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  // Auto-submit when all 6 digits are entered
  useEffect(() => {
    if (mode === "signup" && signupStep === "code" && code.every((d) => d !== "") && !submitting) {
      verifySignupCode();
    }
  }, [code, mode, signupStep]);

  const resetSignupFlow = () => {
    setSignupStep("email");
    setCode(["", "", "", "", "", ""]);
    setVerificationToken("");
    setPassword("");
    setConfirmPassword("");
    setResendCooldown(0);
    setCodeExpiry(null);
  };

  const renderSignupStepIndicator = () => (
    <div className="flex items-center justify-center gap-2 mb-6">
      {["email", "code", "password"].map((s) => (
        <div
          key={s}
          className={`w-2 h-2 rounded-full transition-all duration-300 ${
            signupStep === s || (signupStep === "success" && s === "password")
              ? "bg-primary w-4"
              : signupStep === "success" ||
                (signupStep === "password" && (s === "email" || s === "code")) ||
                (signupStep === "code" && s === "email")
              ? "bg-primary/50"
              : "bg-muted"
          }`}
        />
      ))}
    </div>
  );

  return (
    <div className="min-h-screen bg-gradient-warm flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <button
          onClick={() => {
            if (mode === "signup" && signupStep !== "email") {
              if (signupStep === "code") setSignupStep("email");
              else if (signupStep === "password") setSignupStep("code");
            } else {
              navigate("/");
            }
          }}
          className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground mb-8 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          {mode === "signup" && signupStep !== "email" ? "Back" : "Back to home"}
        </button>

        <div className="bg-card rounded-2xl shadow-large border border-border p-8">
          {/* Login Mode */}
          {mode === "login" && (
            <>
              <div className="w-12 h-12 bg-gradient-primary rounded-xl flex items-center justify-center mx-auto mb-4">
                <span className="text-white font-bold text-xl">A</span>
              </div>

              <h1 className="text-xl font-semibold text-foreground text-center mb-2">
                Sign in
              </h1>
              <p className="text-muted-foreground text-center mb-6">
                Sign in to access your dashboard.
              </p>

              <div className="grid grid-cols-2 gap-2 mb-6">
                <Button
                  type="button"
                  variant="default"
                  disabled={submitting}
                >
                  Sign in
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setMode("signup");
                    resetSignupFlow();
                  }}
                  disabled={submitting}
                >
                  Sign up
                </Button>
              </div>

              <form onSubmit={handleLogin} className="space-y-3">
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
                    autoComplete="current-password"
                    placeholder="Password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={8}
                  />
                  <Link
                    to="/reset-password"
                    className="text-sm text-primary hover:text-primary/80 mt-2 transition-colors inline-block"
                  >
                    Forgot password?
                  </Link>
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
                  ) : (
                    "Sign in"
                  )}
                </Button>
              </form>

              <p className="text-xs text-muted-foreground mt-4">
                Passwords must be at least 8 characters.
              </p>
            </>
          )}

          {/* Signup Mode */}
          {mode === "signup" && (
            <>
              {renderSignupStepIndicator()}

              {/* Step 1: Email */}
              {signupStep === "email" && (
                <>
                  <div className="w-12 h-12 bg-gradient-primary rounded-xl flex items-center justify-center mx-auto mb-4">
                    <Mail className="w-6 h-6 text-white" />
                  </div>
                  <h1 className="text-xl font-semibold text-foreground text-center mb-2">
                    Create your account
                  </h1>
                  <p className="text-muted-foreground text-center mb-6 text-sm">
                    Enter your email to get started. We'll send you a verification code.
                  </p>

                  <div className="grid grid-cols-2 gap-2 mb-6">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setMode("login")}
                      disabled={submitting}
                    >
                      Sign in
                    </Button>
                    <Button
                      type="button"
                      variant="default"
                      disabled={submitting}
                    >
                      Sign up
                    </Button>
                  </div>

                  <form onSubmit={requestSignupCode} className="space-y-4">
                    <Input
                      type="email"
                      autoComplete="email"
                      placeholder="Enter your email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                      autoFocus
                    />
                    <Button
                      type="submit"
                      className="w-full bg-gradient-primary hover:opacity-90"
                      disabled={submitting}
                    >
                      {submitting ? (
                        <span className="inline-flex items-center gap-2">
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Sending code...
                        </span>
                      ) : (
                        "Continue"
                      )}
                    </Button>
                  </form>
                </>
              )}

              {/* Step 2: OTP Code */}
              {signupStep === "code" && (
                <>
                  <div className="w-12 h-12 bg-gradient-primary rounded-xl flex items-center justify-center mx-auto mb-4">
                    <KeyRound className="w-6 h-6 text-white" />
                  </div>
                  <h1 className="text-xl font-semibold text-foreground text-center mb-2">
                    Verify your email
                  </h1>
                  <p className="text-muted-foreground text-center mb-6 text-sm">
                    Enter the 6-digit code sent to{" "}
                    <span className="font-medium text-foreground">{email}</span>
                  </p>

                  <form onSubmit={verifySignupCode} className="space-y-6">
                    <div className="flex justify-center gap-2" onPaste={handleCodePaste}>
                      {code.map((digit, index) => (
                        <input
                          key={index}
                          ref={(el) => (codeInputRefs.current[index] = el)}
                          type="text"
                          inputMode="numeric"
                          maxLength={1}
                          value={digit}
                          onChange={(e) => handleCodeChange(index, e.target.value)}
                          onKeyDown={(e) => handleCodeKeyDown(index, e)}
                          className="w-12 h-14 text-center text-xl font-semibold border border-border rounded-lg bg-background focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all"
                          autoFocus={index === 0}
                        />
                      ))}
                    </div>

                    {codeExpiry !== null && codeExpiry > 0 && (
                      <p className="text-center text-sm text-muted-foreground">
                        Code expires in{" "}
                        <span className="font-medium text-foreground">{formatTime(codeExpiry)}</span>
                      </p>
                    )}

                    <Button
                      type="submit"
                      className="w-full bg-gradient-primary hover:opacity-90"
                      disabled={submitting || code.some((d) => d === "")}
                    >
                      {submitting ? (
                        <span className="inline-flex items-center gap-2">
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Verifying...
                        </span>
                      ) : (
                        "Verify Code"
                      )}
                    </Button>

                    <div className="text-center">
                      <button
                        type="button"
                        onClick={() => requestSignupCode()}
                        disabled={resendCooldown > 0 || submitting}
                        className="text-sm text-primary hover:underline disabled:text-muted-foreground disabled:no-underline disabled:cursor-not-allowed"
                      >
                        {resendCooldown > 0 ? `Resend code in ${resendCooldown}s` : "Resend code"}
                      </button>
                    </div>
                  </form>
                </>
              )}

              {/* Step 3: Set Password */}
              {signupStep === "password" && (
                <>
                  <div className="w-12 h-12 bg-gradient-primary rounded-xl flex items-center justify-center mx-auto mb-4">
                    <Lock className="w-6 h-6 text-white" />
                  </div>
                  <h1 className="text-xl font-semibold text-foreground text-center mb-2">
                    Set your password
                  </h1>
                  <p className="text-muted-foreground text-center mb-6 text-sm">
                    Create a strong password to secure your account.
                  </p>

                  <form onSubmit={completeSignup} className="space-y-3">
                    <Input
                      type="password"
                      autoComplete="new-password"
                      placeholder="Password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      minLength={8}
                      autoFocus
                    />
                    <Input
                      type="password"
                      autoComplete="new-password"
                      placeholder="Confirm password"
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
                          Creating account...
                        </span>
                      ) : (
                        "Create Account"
                      )}
                    </Button>
                  </form>

                  <p className="text-xs text-muted-foreground mt-4 text-center">
                    Password must be at least 8 characters.
                  </p>
                </>
              )}

              {/* Step 4: Success */}
              {signupStep === "success" && (
                <div className="text-center">
                  <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-4">
                    <CheckCircle className="w-8 h-8 text-primary" />
                  </div>
                  <h1 className="text-xl font-semibold text-foreground mb-2">
                    Welcome to Arivioo!
                  </h1>
                  <p className="text-muted-foreground mb-6">
                    Your account has been created. Signing you in...
                  </p>
                  <Loader2 className="w-6 h-6 animate-spin mx-auto text-primary" />
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
