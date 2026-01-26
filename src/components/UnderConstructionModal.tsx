import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Rocket, Mail, Lock, Eye, EyeOff, CheckCircle } from "lucide-react";
import { AriviooLogo } from "@/components/AriviooLogo";

interface UnderConstructionModalProps {
  onAccessGranted: () => void;
}

export const UnderConstructionModal = ({ onAccessGranted }: UnderConstructionModalProps) => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPasswordField, setShowPasswordField] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isEmailSubmitted, setIsEmailSubmitted] = useState(false);
  const [isCheckingAccess, setIsCheckingAccess] = useState(true);


  useEffect(() => {
    // Check if user is authenticated - authenticated users get automatic access
    const checkAccessGrant = async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        
        if (user) {
          // Authenticated users automatically get access - no need to check access_grants
          console.log('Authenticated user found, granting access');
          onAccessGranted();
          return;
        }
      } catch (error) {
        console.error('Error checking auth:', error);
      } finally {
        setIsCheckingAccess(false);
      }
    };

    checkAccessGrant();
  }, [onAccessGranted]);

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    // Client-side validation
    const trimmedEmail = email.toLowerCase().trim();
    if (!trimmedEmail || !trimmedEmail.includes("@") || trimmedEmail.length > 255) {
      toast.error("Please enter a valid email address");
      return;
    }

    // Basic email format check
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(trimmedEmail)) {
      toast.error("Please enter a valid email address");
      return;
    }

    setIsSubmitting(true);
    
    try {
      // Use edge function instead of direct insert for rate limiting & server-side validation
      const { data, error } = await supabase.functions.invoke('submit-launch-signup', {
        body: { email: trimmedEmail }
      });

      if (error) {
        throw error;
      }

      if (!data?.success) {
        if (data?.error) {
          toast.error(data.error);
        } else {
          toast.error("Something went wrong. Please try again.");
        }
        return;
      }

      if (data.message === 'already_registered') {
        toast.info("You're already on the list! We'll notify you when we launch.");
      } else {
        // Send email notification (optional, don't fail if it errors)
        try {
          await supabase.functions.invoke('send-notify-me-email', {
            body: { email: trimmedEmail }
          });
        } catch (emailError) {
          console.error("Error sending notification email:", emailError);
        }
        
        toast.success("You're on the list! We'll notify you when we launch.");
      }
      
      setIsEmailSubmitted(true);
    } catch (error: any) {
      console.error("Error saving email:", error);
      if (error?.message?.includes('429') || error?.context?.status === 429) {
        toast.error("Too many attempts. Please try again later.");
      } else {
        toast.error("Something went wrong. Please try again.");
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!password) {
      toast.error("Please enter a password");
      return;
    }

    setIsSubmitting(true);
    
    try {
      // First, ensure user is signed in (anonymously if needed)
      let userId: string | undefined;
      
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        userId = user.id;
      } else {
        // Sign in anonymously to get a user ID for access grant
        const { data: anonData, error: anonError } = await supabase.auth.signInAnonymously();
        if (anonError) {
          console.error('Error signing in anonymously:', anonError);
        } else {
          userId = anonData.user?.id;
        }
      }

      // Verify password and create server-side access grant
      const { data, error } = await supabase.functions.invoke('verify-bypass-password', {
        body: { password, userId }
      });

      if (error) {
        throw error;
      }

      if (data?.valid) {
        toast.success("Access granted!");
        onAccessGranted();
      } else {
        toast.error("Invalid password");
        setPassword("");
      }
    } catch (error: any) {
      console.error("Error verifying password:", error);
      toast.error("Unable to verify password. Please try again.");
      setPassword("");
    } finally {
      setIsSubmitting(false);
    }
  };

  // Show loading while checking access
  if (isCheckingAccess) {
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-gradient-to-br from-background via-background to-primary/5">
        <div className="w-8 h-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-gradient-to-br from-background via-background to-primary/5">
      {/* Animated background elements */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-primary/10 rounded-full blur-3xl animate-pulse" />
        <div className="absolute bottom-1/4 right-1/4 w-80 h-80 bg-accent/10 rounded-full blur-3xl animate-pulse delay-1000" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-gradient-to-r from-primary/5 to-accent/5 rounded-full blur-3xl" />
      </div>

      <div className="relative w-full max-w-md mx-4 p-8 bg-card/80 backdrop-blur-xl border border-border/50 rounded-3xl shadow-2xl">
        {/* Logo/Brand */}
        <div className="flex items-center justify-center mb-6">
          <AriviooLogo size="lg" />
        </div>

        {/* Rocket Icon */}
        <div className="flex justify-center mb-6">
          <div className="relative">
            <div className="absolute inset-0 bg-primary/20 rounded-full blur-xl animate-pulse" />
            <div className="relative w-20 h-20 bg-gradient-to-br from-primary to-primary/80 rounded-full flex items-center justify-center">
              <Rocket className="w-10 h-10 text-primary-foreground animate-bounce" />
            </div>
          </div>
        </div>

        {/* Headline */}
        <h1 className="text-2xl md:text-3xl font-bold text-center mb-3 text-foreground">
          We're getting ready to launch!
        </h1>
        
        {/* Subtext */}
        <p className="text-muted-foreground text-center mb-8">
          Something amazing is coming. Be the first to know when we go live and start saving on vacation rentals.
        </p>

        {/* Email Form */}
        {!isEmailSubmitted ? (
          <form onSubmit={handleEmailSubmit} className="space-y-4 mb-6">
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
              <Input
                type="email"
                placeholder="Enter your email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="pl-10 h-12 bg-background/50 border-border/50 focus:border-primary rounded-xl"
                disabled={isSubmitting}
              />
            </div>
            <Button 
              type="submit" 
              className="w-full h-12 bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl font-semibold text-base transition-all hover:scale-[1.02] active:scale-[0.98]"
              disabled={isSubmitting}
            >
              {isSubmitting ? (
                <span className="flex items-center gap-2">
                  <div className="w-4 h-4 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
                  Signing up...
                </span>
              ) : (
                "Notify Me"
              )}
            </Button>
          </form>
        ) : (
          <div className="mb-6 p-4 bg-success/10 border border-success/20 rounded-xl flex items-center gap-3">
            <CheckCircle className="w-6 h-6 text-success flex-shrink-0" />
            <p className="text-sm text-foreground">
              Thanks! We'll email you when Arivioo launches.
            </p>
          </div>
        )}

        {/* Divider */}
        <div className="relative mb-6">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-border/50" />
          </div>
        </div>


        {/* Authorized Access Toggle */}
        <div className="text-center">
          {!showPasswordField ? (
            <button
              onClick={() => setShowPasswordField(true)}
              className="text-sm text-muted-foreground hover:text-foreground transition-colors underline-offset-4 hover:underline"
            >
              Authorized access
            </button>
          ) : (
            <form onSubmit={handlePasswordSubmit} className="space-y-3">
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  type={showPassword ? "text" : "password"}
                  placeholder="Enter password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="pl-9 pr-10 h-10 bg-background/50 border-border/50 focus:border-primary rounded-lg text-sm"
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setShowPasswordField(false);
                    setPassword("");
                  }}
                  className="flex-1 text-muted-foreground"
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  className="flex-1 bg-primary/10 hover:bg-primary/20 text-primary"
                >
                  Unlock
                </Button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
