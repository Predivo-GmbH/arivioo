import { useState, useRef, useEffect, useCallback } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, Loader2, CheckCircle, Mail, KeyRound, Lock } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";

type Step = "email" | "code" | "password" | "success";

export default function ResetPassword() {
  const navigate = useNavigate();
  const { toast } = useToast();

  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState(["", "", "", "", "", ""]);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [verificationToken, setVerificationToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [codeExpiry, setCodeExpiry] = useState<number | null>(null);
  const codeInputRefs = useRef<(HTMLInputElement | null)[]>([]);

  // Clear any legacy Supabase recovery tokens from URL hash to prevent auto-login
  useEffect(() => {
    if (window.location.hash && window.location.hash.includes("access_token")) {
      // Sign out any auto-logged-in session from recovery link
      supabase.auth.signOut();
      // Clear the hash
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  // Countdown timer for resend cooldown
  useEffect(() => {
    if (resendCooldown > 0) {
      const timer = setTimeout(() => setResendCooldown(resendCooldown - 1), 1000);
      return () => clearTimeout(timer);
    }
  }, [resendCooldown]);

  // Countdown timer for code expiry
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

  const requestCode = async (e?: React.FormEvent) => {
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
      const { data, error } = await supabase.functions.invoke("request-password-reset", {
        body: { email },
      });

      if (error) throw error;

      setStep("code");
      setResendCooldown(60);
      setCodeExpiry(15 * 60); // 15 minutes
      setCode(["", "", "", "", "", ""]);
      
      // Focus first input after transition
      setTimeout(() => codeInputRefs.current[0]?.focus(), 100);

      toast({
        title: "Check your inbox",
        description: "If an account exists with this email, you'll receive a 6-digit code shortly.",
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
    // Only allow digits
    const digit = value.replace(/\D/g, "").slice(-1);
    
    setCode((prev) => {
      const newCode = [...prev];
      newCode[index] = digit;
      return newCode;
    });

    // Auto-advance to next input
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

  const verifyCode = async (e?: React.FormEvent) => {
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
      const { data, error } = await supabase.functions.invoke("verify-reset-code", {
        body: { email, code: fullCode },
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      setVerificationToken(data.verificationToken);
      setStep("password");

      toast({
        title: "Code verified",
        description: "Now set your new password.",
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

  const resetPassword = async (e: React.FormEvent) => {
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
      const { data, error } = await supabase.functions.invoke("reset-password-with-code", {
        body: { email, verificationToken, newPassword: password },
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      setStep("success");

      toast({
        title: "Password updated",
        description: "You can now sign in with your new password.",
      });

      // Redirect after delay
      setTimeout(() => navigate("/auth", { replace: true }), 3000);
    } catch (err: any) {
      toast({
        title: "Failed to reset password",
        description: err?.message || "Please try again.",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  // Auto-submit when all 6 digits are entered
  useEffect(() => {
    if (step === "code" && code.every((d) => d !== "") && !submitting) {
      verifyCode();
    }
  }, [code, step]);

  const renderStepIndicator = () => (
    <div className="flex items-center justify-center gap-2 mb-6">
      {["email", "code", "password"].map((s, i) => (
        <div
          key={s}
          className={`w-2 h-2 rounded-full transition-all duration-300 ${
            step === s || (step === "success" && s === "password")
              ? "bg-primary w-4"
              : step === "success" || 
                (step === "password" && (s === "email" || s === "code")) ||
                (step === "code" && s === "email")
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
        {step !== "success" && (
          <button
            onClick={() => {
              if (step === "email") {
                navigate("/auth");
              } else if (step === "code") {
                setStep("email");
              } else if (step === "password") {
                setStep("code");
              }
            }}
            className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground mb-8 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            {step === "email" ? "Back to sign in" : "Back"}
          </button>
        )}

        <div className="bg-card rounded-2xl shadow-large border border-border p-8 animate-fade-in">
          {renderStepIndicator()}

          {/* Step 1: Email */}
          {step === "email" && (
            <>
              <div className="w-12 h-12 bg-gradient-primary rounded-xl flex items-center justify-center mx-auto mb-4">
                <Mail className="w-6 h-6 text-white" />
              </div>
              <h1 className="text-xl font-semibold text-foreground text-center mb-2">
                Forgot your password?
              </h1>
              <p className="text-muted-foreground text-center mb-6 text-sm">
                Enter your email and we'll send you a 6-digit code to reset your password.
              </p>

              <form onSubmit={requestCode} className="space-y-4">
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
                      Sending...
                    </span>
                  ) : (
                    "Send Reset Code"
                  )}
                </Button>
              </form>
            </>
          )}

          {/* Step 2: OTP Code */}
          {step === "code" && (
            <>
              <div className="w-12 h-12 bg-gradient-primary rounded-xl flex items-center justify-center mx-auto mb-4">
                <KeyRound className="w-6 h-6 text-white" />
              </div>
              <h1 className="text-xl font-semibold text-foreground text-center mb-2">
                Enter verification code
              </h1>
              <p className="text-muted-foreground text-center mb-6 text-sm">
                We sent a 6-digit code to <span className="font-medium text-foreground">{email}</span>
              </p>

              <form onSubmit={verifyCode} className="space-y-6">
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
                    Code expires in <span className="font-medium text-foreground">{formatTime(codeExpiry)}</span>
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
                    onClick={() => requestCode()}
                    disabled={resendCooldown > 0 || submitting}
                    className="text-sm text-primary hover:underline disabled:text-muted-foreground disabled:no-underline disabled:cursor-not-allowed"
                  >
                    {resendCooldown > 0 ? `Resend code in ${resendCooldown}s` : "Resend code"}
                  </button>
                </div>
              </form>
            </>
          )}

          {/* Step 3: New Password */}
          {step === "password" && (
            <>
              <div className="w-12 h-12 bg-gradient-primary rounded-xl flex items-center justify-center mx-auto mb-4">
                <Lock className="w-6 h-6 text-white" />
              </div>
              <h1 className="text-xl font-semibold text-foreground text-center mb-2">
                Set new password
              </h1>
              <p className="text-muted-foreground text-center mb-6 text-sm">
                Create a strong password for your account.
              </p>

              <form onSubmit={resetPassword} className="space-y-3">
                <Input
                  type="password"
                  autoComplete="new-password"
                  placeholder="New password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                  autoFocus
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

              <p className="text-xs text-muted-foreground mt-4 text-center">
                Password must be at least 8 characters.
              </p>
            </>
          )}

          {/* Step 4: Success */}
          {step === "success" && (
            <div className="text-center">
              <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-4">
                <CheckCircle className="w-8 h-8 text-primary" />
              </div>
              <h1 className="text-xl font-semibold text-foreground mb-2">
                Password Updated!
              </h1>
              <p className="text-muted-foreground mb-6">
                Your password has been successfully changed. Redirecting you to sign in...
              </p>
              <Button asChild className="w-full">
                <Link to="/auth">Go to Sign In</Link>
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
