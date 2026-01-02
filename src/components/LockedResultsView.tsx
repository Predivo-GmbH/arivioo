import React from 'react';
import { Lock, Mail, Check, Search, Calendar, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Link } from 'react-router-dom';

interface LockedResultsViewProps {
  searchId: string;
  status: string;
  isComplete: boolean;
  resultCount: number;
  checkInDate: string | null;
  checkOutDate: string | null;
  nightsCount: number | null;
  lockedReason?: string;
  onUnlockRequest?: () => void;
}

// Format date for display
const formatDate = (dateStr: string): string => {
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

export function LockedResultsView({
  searchId,
  status,
  isComplete,
  resultCount,
  checkInDate,
  checkOutDate,
  nightsCount,
  lockedReason = 'email_verification_required',
  onUnlockRequest,
}: LockedResultsViewProps) {
  const hasValidDates = checkInDate && checkOutDate;

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 w-full border-b border-border bg-card/80 backdrop-blur-sm">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between">
          <Link to="/dashboard" className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-gradient-primary rounded-xl flex items-center justify-center shadow-soft">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="text-white">
                <path d="M12 2L4 7V17L12 22L20 17V7L12 2Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M12 22V12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M12 12L4 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M12 12L20 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <span className="font-bold text-xl text-foreground tracking-tight">Arivioo</span>
          </Link>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 max-w-3xl">
        {/* Status indicator */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            {isComplete ? (
              <div className="w-10 h-10 rounded-full bg-success/10 flex items-center justify-center">
                <Check className="w-5 h-5 text-success" />
              </div>
            ) : (
              <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                <Search className="w-5 h-5 text-primary animate-pulse" />
              </div>
            )}
            <div>
              <h1 className="text-xl font-semibold text-foreground">
                {isComplete ? 'Results Ready' : 'Search In Progress'}
              </h1>
              <p className="text-sm text-muted-foreground">
                {isComplete 
                  ? `Found ${resultCount} alternative ${resultCount === 1 ? 'listing' : 'listings'}`
                  : 'Searching for alternatives...'}
              </p>
            </div>
          </div>

          {/* Date range if available */}
          {hasValidDates && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground mt-4 pl-[52px]">
              <Calendar className="w-4 h-4" />
              <span>
                {formatDate(checkInDate)} – {formatDate(checkOutDate)}
                {nightsCount && ` (${nightsCount} ${nightsCount === 1 ? 'night' : 'nights'})`}
              </span>
            </div>
          )}
        </div>

        {/* Locked content card */}
        <div className="rounded-2xl border border-border bg-card overflow-hidden">
          {/* Visual placeholder for results */}
          <div className="p-6 space-y-4">
            {/* Placeholder rows - blurred/locked effect */}
            {[1, 2, 3].map((i) => (
              <div key={i} className="relative">
                <div className="flex items-center gap-4 p-4 rounded-xl bg-muted/30 border border-border/50">
                  {/* Platform placeholder */}
                  <div className="w-12 h-12 rounded-lg bg-muted animate-pulse" />
                  
                  {/* Content placeholder */}
                  <div className="flex-1 space-y-2">
                    <div className="h-4 w-32 bg-muted rounded animate-pulse" />
                    <div className="h-3 w-48 bg-muted/70 rounded animate-pulse" />
                  </div>
                  
                  {/* Price placeholder */}
                  <div className="text-right space-y-1">
                    <div className="h-5 w-20 bg-muted rounded animate-pulse" />
                    <div className="h-3 w-16 bg-muted/70 rounded animate-pulse" />
                  </div>
                </div>
                
                {/* Blur overlay */}
                <div className="absolute inset-0 bg-background/60 backdrop-blur-sm rounded-xl" />
              </div>
            ))}
          </div>

          {/* Lock overlay */}
          <div className="border-t border-border bg-muted/30 p-8 text-center">
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-primary/10 flex items-center justify-center">
              <Lock className="w-8 h-8 text-primary" />
            </div>
            
            <h2 className="text-xl font-semibold text-foreground mb-2">
              Results Are Locked
            </h2>
            
            <p className="text-muted-foreground mb-6 max-w-md mx-auto">
              {lockedReason === 'email_verification_required' 
                ? 'Enter your email to unlock price comparisons and see how much you could save.'
                : lockedReason === 'not_owner'
                ? 'You don\'t have permission to view these results.'
                : 'Verify your email to access the full comparison results.'}
            </p>

            {lockedReason === 'email_verification_required' && (
              <div className="space-y-4">
                {/* Email unlock CTA - placeholder for future implementation */}
                <Button 
                  size="lg" 
                  className="gap-2"
                  onClick={onUnlockRequest}
                >
                  <Mail className="w-4 h-4" />
                  Unlock Results
                </Button>
                
                <p className="text-xs text-muted-foreground">
                  We'll send you a magic link. No password needed.
                </p>
              </div>
            )}

            {lockedReason === 'not_owner' && (
              <Button asChild variant="outline">
                <Link to="/dashboard">
                  <Search className="w-4 h-4 mr-2" />
                  Start Your Own Search
                </Link>
              </Button>
            )}
          </div>
        </div>

        {/* Trust indicators */}
        <div className="mt-8 flex flex-wrap justify-center gap-6 text-xs text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <Check className="w-3.5 h-3.5 text-success" />
            <span>No spam, ever</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Check className="w-3.5 h-3.5 text-success" />
            <span>One-click unsubscribe</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Check className="w-3.5 h-3.5 text-success" />
            <span>Free to use</span>
          </div>
        </div>
      </main>
    </div>
  );
}
