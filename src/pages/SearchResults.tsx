import React, { useState, useEffect, useRef } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import { ImageComparison } from "@/components/ImageComparison";
import { quickCelebration } from "@/lib/confetti";
import { 
  ArrowLeft, 
  ExternalLink, 
  Search, 
  Sparkles, 
  AlertCircle,
  TrendingDown,
  Calendar,
  Info,
  Shield,
  Lock,
  Camera,
  Globe,
  DollarSign,
  Check,
  ArrowLeftRight
} from "lucide-react";
import type { User } from "@supabase/supabase-js";
import type { Json } from "@/integrations/supabase/types";

interface SearchResult {
  id: string;
  platform_name: string;
  listing_url: string;
  listing_title: string | null;
  price: number | null;
  original_price: number | null;
  savings_amount: number | null;
  savings_percentage: number | null;
  confidence_score: number | null;
  image_url: string | null;
  images: Json;
  match_type?: string;
  source_airbnb_image?: string | null; // The Airbnb image that matched this result
}

interface SearchData {
  id: string;
  airbnb_url: string;
  airbnb_title: string | null;
  airbnb_price: number | null;
  airbnb_image_url: string | null;
  airbnb_images: Json;
  status: string;
  created_at: string;
  check_in_date?: string | null;
  check_out_date?: string | null;
  nights_count?: number | null;
}

// Step-based loading messages that progress linearly
const loadingSteps = [
  {
    id: "extracting",
    icon: Camera,
    title: "Extracting Property Photos",
    description: "Downloading clean property images from the Airbnb listing...",
    statuses: ["searching", "pending", "extracting_photos"]
  },
  {
    id: "searching",
    icon: Globe,
    title: "Searching Across Platforms",
    description: "Running reverse image search on Booking.com, Vrbo, Agoda, and 10+ other sites...",
    statuses: ["searching_platforms"]
  },
  {
    id: "comparing",
    icon: DollarSign,
    title: "Comparing Prices",
    description: "Analyzing prices and calculating potential savings for your dates...",
    statuses: ["comparing_prices"]
  }
];

// Helper to convert Json to string array
const toStringArray = (json: Json | null | undefined): string[] => {
  if (!json) return [];
  if (Array.isArray(json)) {
    return json.filter((item): item is string => typeof item === 'string');
  }
  return [];
};

// Extract dates from Airbnb URL if present
const extractDatesFromUrl = (url: string): { checkIn: string | null; checkOut: string | null } => {
  try {
    const urlObj = new URL(url);
    const checkIn = urlObj.searchParams.get('check_in');
    const checkOut = urlObj.searchParams.get('check_out');
    return { checkIn, checkOut };
  } catch {
    return { checkIn: null, checkOut: null };
  }
};

// Format date for display
const formatDate = (dateStr: string): string => {
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

// Calculate nights between dates
const calculateNights = (checkIn: string, checkOut: string): number => {
  const start = new Date(checkIn);
  const end = new Date(checkOut);
  const diffTime = Math.abs(end.getTime() - start.getTime());
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
};

// Get current step index based on status
const getCurrentStepIndex = (status: string): number => {
  for (let i = loadingSteps.length - 1; i >= 0; i--) {
    if (loadingSteps[i].statuses.includes(status)) {
      return i;
    }
  }
  return 0;
};

// Logo component for consistency
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

export default function SearchResults() {
  const { searchId } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  
  const [user, setUser] = useState<User | null>(null);
  const [search, setSearch] = useState<SearchData | null>(null);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchPhase, setSearchPhase] = useState<'thinking' | 'animating' | 'done'>('thinking');
  const [currentStep, setCurrentStep] = useState(-1); // -1 = thinking phase
  const [stepProgress, setStepProgress] = useState(0);
  const [expandedComparison, setExpandedComparison] = useState<string | null>(null);
  const [thinkingElapsedMs, setThinkingElapsedMs] = useState(0);
  const [hasCelebrated, setHasCelebrated] = useState(false);
  const [activityFeed, setActivityFeed] = useState<Array<{ ts: number; message: string; detail?: string }>>([]);

  const searchTriggeredRef = useRef(false);
  const searchStartTimeRef = useRef<number>(0);
  const actualDurationRef = useRef<number>(0);
  const animationFrameRef = useRef<number | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const lastActivityKeyRef = useRef<string>("");
  const tickerScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      setUser(session?.user ?? null);
      if (!session?.user) navigate("/auth");
    });

    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      if (!session?.user) navigate("/auth");
    });

    return () => subscription.unsubscribe();
  }, [navigate]);

  // Fetch search data and trigger search
  useEffect(() => {
    if (!searchId || !user) return;
    if (searchTriggeredRef.current) return;

    const fetchAndSearch = async () => {
      searchTriggeredRef.current = true;

      // Fetch search record
      const { data: searchData, error: searchError } = await supabase
        .from("searches")
        .select("*")
        .eq("id", searchId)
        .single();

      if (searchError || !searchData) {
        toast({ title: "Error", description: "Search not found", variant: "destructive" });
        navigate("/dashboard");
        return;
      }

      setSearch(searchData as SearchData);
      setCurrentStep(getCurrentStepIndex(searchData.status));

      // If search is already completed, fetch results
      if (searchData.status === "completed") {
        const { data: resultsData } = await supabase
          .from("search_results")
          .select("*")
          .eq("search_id", searchId)
          .order("savings_percentage", { ascending: false, nullsFirst: false });

        setResults((resultsData || []) as SearchResult[]);
        setLoading(false);
        return;
      }

      // If status is 'searching' or 'pending', trigger the search with SSE streaming
      if (searchData.status === "searching" || searchData.status === "pending") {
        try {
          // Reset to thinking phase
          setSearchPhase("thinking");
          setCurrentStep(-1);
          setStepProgress(0);
          setThinkingElapsedMs(0);
          setActivityFeed([]);
          lastActivityKeyRef.current = "";

          // Start timer + allow cancel
          searchStartTimeRef.current = Date.now();
          abortControllerRef.current?.abort();
          abortControllerRef.current = new AbortController();

          const startedAt = Date.now();

          // Get session for auth header
          const { data: { session } } = await supabase.auth.getSession();
          const authToken = session?.access_token;

          if (!authToken) {
            throw new Error("Not authenticated");
          }

          // Use SSE streaming for real-time progress
          const response = await fetch(
            `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/search-alternatives`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${authToken}`,
              },
              body: JSON.stringify({ searchId, stream: true }),
              signal: abortControllerRef.current.signal,
            }
          );

          if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error || `HTTP ${response.status}`);
          }

          const reader = response.body?.getReader();
          const decoder = new TextDecoder();

          if (!reader) {
            throw new Error("No response stream");
          }

          let buffer = "";
          let searchComplete = false;

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            // Parse SSE events from buffer
            const lines = buffer.split("\n");
            buffer = lines.pop() || ""; // Keep incomplete line in buffer

            let eventType = "";
            let eventData = "";

            for (const line of lines) {
              if (line.startsWith("event: ")) {
                eventType = line.slice(7).trim();
              } else if (line.startsWith("data: ")) {
                eventData = line.slice(6).trim();

                if (eventType && eventData) {
                  try {
                    const data = JSON.parse(eventData);

                    if (eventType === "progress") {
                      // Add to activity feed
                      setActivityFeed((prev) => {
                        const key = `${data.step}__${data.detail ?? ""}`;
                        if (prev.some(p => `${p.message}__${p.detail ?? ""}` === key)) return prev;
                        const next = [...prev, { ts: data.timestamp || Date.now(), message: data.step, detail: data.detail }];
                        return next.slice(-12); // Keep last 12 messages
                      });
                    } else if (eventType === "complete") {
                      searchComplete = true;
                      actualDurationRef.current = Date.now() - startedAt;

                      if (data.success === false) {
                        throw new Error(data.error || "Search failed");
                      }

                      // Refresh search and results from DB
                      const { data: updatedSearch } = await supabase
                        .from("searches")
                        .select("*")
                        .eq("id", searchId)
                        .single();

                      const { data: resultsData } = await supabase
                        .from("search_results")
                        .select("*")
                        .eq("search_id", searchId)
                        .order("savings_percentage", { ascending: false, nullsFirst: false });

                      setSearch(updatedSearch as SearchData);
                      setResults((resultsData || []) as SearchResult[]);
                      setSearchPhase("animating");
                    } else if (eventType === "error") {
                      throw new Error(data.message || "Search failed");
                    }
                  } catch (parseError) {
                    console.error("Failed to parse SSE data:", parseError);
                  }
                }

                eventType = "";
                eventData = "";
              }
            }
          }

          // If stream ended without complete event, fetch results anyway
          if (!searchComplete) {
            const { data: updatedSearch } = await supabase
              .from("searches")
              .select("*")
              .eq("id", searchId)
              .single();

            const { data: resultsData } = await supabase
              .from("search_results")
              .select("*")
              .eq("search_id", searchId)
              .order("savings_percentage", { ascending: false, nullsFirst: false });

            setSearch(updatedSearch as SearchData);
            setResults((resultsData || []) as SearchResult[]);
            actualDurationRef.current = Date.now() - startedAt;
            setSearchPhase("animating");
          }
        } catch (error: any) {
          // User cancelled
          if (error?.name === "AbortError") {
            toast({ title: "Search cancelled", description: "No worries — you can try again anytime." });
            navigate("/dashboard");
            return;
          }

          console.error("Search error:", error);
          toast({
            title: "Search Error",
            description: error.message || "Failed to search for alternatives",
            variant: "destructive",
          });

          if (animationFrameRef.current) {
            cancelAnimationFrame(animationFrameRef.current);
            animationFrameRef.current = null;
          }
          setLoading(false);
        }
      }
    };

    fetchAndSearch();
  }, [searchId, user, navigate, toast]);

  // Thinking phase timer (improves UX + makes "stuck" feel less scary)
  useEffect(() => {
    if (!loading || searchPhase !== "thinking") return;

    const startedAt = searchStartTimeRef.current || Date.now();
    const id = window.setInterval(() => {
      setThinkingElapsedMs(Date.now() - startedAt);
    }, 250);

    return () => window.clearInterval(id);
  }, [loading, searchPhase]);

  const getLiveActivity = (status?: string | null): { message: string; detail?: string } => {
    if (!status) return { message: "Starting search…" };

    // Extracting phase
    if (status === "extracting_photos") {
      return { message: "Extracting property photos", detail: "Downloading clean property images from the Airbnb listing" };
    }
    if (status === "scraping_airbnb_page") {
      return { message: "Loading Airbnb listing", detail: "Capturing page content including dynamic price data" };
    }
    if (status === "extracting_price_with_ai") {
      return { message: "Extracting Airbnb price", detail: "Using AI to find the exact price for your dates" };
    }

    // Reverse image search phase
    if (status.startsWith("searching_platforms_lens_")) {
      const m = status.match(/searching_platforms_lens_(\d+)_of_(\d+)/);
      if (m) {
        return { 
          message: `Searching for matches (image ${m[1]} of ${m[2]})`, 
          detail: "Running AI reverse image search across Booking.com, Vrbo, TripAdvisor, and more" 
        };
      }
      return { message: "Searching for matches", detail: "Running AI reverse image search" };
    }
    if (status === "searching_platforms") {
      return { message: "Searching for matches", detail: "Running AI reverse image search across booking sites" };
    }

    // AI verification
    if (status.startsWith("ai_verifying_")) {
      const platform = status.replace("ai_verifying_", "").replace(/_/g, " ");
      const formattedPlatform = platform.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      return { message: `Verifying match on ${formattedPlatform}`, detail: "AI is comparing property photos to confirm it's the same place" };
    }

    // Reverse image backup
    if (status === "reverse_image_search_backup") {
      return { message: "Running backup search", detail: "Trying alternative image search methods" };
    }

    // Price comparison - now includes index
    if (status === "comparing_prices") {
      return { message: "Collecting prices", detail: "Preparing to scrape prices from matched platforms" };
    }
    if (status.startsWith("scraping_price_")) {
      const parts = status.replace("scraping_price_", "");
      const indexMatch = parts.match(/_(\d+)_of_(\d+)$/);
      let platform = parts.replace(/_\d+_of_\d+$/, "").replace(/_/g, " ");
      const formattedPlatform = platform.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      
      if (indexMatch) {
        return { 
          message: `Getting price from ${formattedPlatform} (${indexMatch[1]}/${indexMatch[2]})`, 
          detail: "Scraping the listing page to find the exact price for your dates" 
        };
      }
      return { message: `Getting price from ${formattedPlatform}`, detail: "Scraping the listing page to find the exact price" };
    }

    // Text search fallback
    if (status.startsWith("text_search_")) {
      return { message: "Running text search", detail: "Searching by property name as a fallback" };
    }

    // Completed states
    if (status === "completed") return { message: "Search complete" };
    if (status === "price_unavailable") {
      return { message: "Price unavailable", detail: "Could not extract the Airbnb price for your dates" };
    }

    // Generic fallback
    if (status === "searching" || status === "pending") return { message: "Starting search…" };

    return { message: status.replace(/_/g, " ") };
  };

  // Ticker-style live activity feed: append a line whenever backend status meaningfully changes
  useEffect(() => {
    if (!loading) return;
    if (searchPhase !== "thinking") return;

    const activity = getLiveActivity(search?.status);
    const key = `${activity.message}__${activity.detail ?? ""}`;
    if (!activity.message) return;
    if (key === lastActivityKeyRef.current) return;

    lastActivityKeyRef.current = key;
    setActivityFeed((prev) => {
      const next = [...prev, { ts: Date.now(), message: activity.message, detail: activity.detail }];
      return next.slice(-8);
    });
  }, [loading, searchPhase, search?.status]);

  // Auto-scroll ticker feed when new items are added
  useEffect(() => {
    if (tickerScrollRef.current && activityFeed.length > 0) {
      tickerScrollRef.current.scrollTop = 0; // Scroll to top since we reverse the list
    }
  }, [activityFeed.length]);

  // Animate through all steps evenly when search completes
  useEffect(() => {
    if (searchPhase !== 'animating') return;
    
    const STEP_COUNT = loadingSteps.length;
    // Minimum 1.5s per step, use actual duration evenly split
    const timePerStep = Math.max(actualDurationRef.current / STEP_COUNT, 1500);
    const TOTAL_ANIMATION = timePerStep * STEP_COUNT;
    
    const startTime = Date.now();
    
    // Use a ref to track animation state without causing re-renders
    let currentAnimStep = 0;
    let currentAnimProgress = 0;
    
    const animate = () => {
      const elapsed = Date.now() - startTime;
      const totalProgress = Math.min(elapsed / TOTAL_ANIMATION, 1);
      
      // Calculate overall progress as a continuous value from 0 to 300 (for 3 steps)
      const continuousProgress = totalProgress * STEP_COUNT * 100;
      
      // Determine which step we're on
      const stepIndex = Math.min(Math.floor(continuousProgress / 100), STEP_COUNT - 1);
      
      // Calculate progress within current step (0-100)
      const progressInStep = continuousProgress - (stepIndex * 100);
      
      // Only update state if values changed
      if (stepIndex !== currentAnimStep) {
        currentAnimStep = stepIndex;
        setCurrentStep(stepIndex);
      }
      
      // Update progress continuously for smooth animation
      currentAnimProgress = Math.min(progressInStep, 100);
      setStepProgress(currentAnimProgress);
      
      if (totalProgress < 1) {
        animationFrameRef.current = requestAnimationFrame(animate);
      } else {
        // Complete
        setCurrentStep(STEP_COUNT - 1);
        setStepProgress(100);
        setSearchPhase('done');
        setTimeout(() => {
          setLoading(false);
        }, 400);
      }
    };
    
    // Start animation
    setCurrentStep(0);
    setStepProgress(0);
    animationFrameRef.current = requestAnimationFrame(animate);
    
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [searchPhase]);

  // Celebrate when results are shown
  useEffect(() => {
    if (!loading && results.length > 0 && !hasCelebrated) {
      setHasCelebrated(true);
      // Small delay for UX
      setTimeout(() => quickCelebration(), 300);
    }
  }, [loading, results.length, hasCelebrated]);

  if (!user) return null;
  const airbnbImages = toStringArray(search?.airbnb_images);

  // Use dates from database first (these are the actual comparison dates used)
  const dbCheckIn = search?.check_in_date;
  const dbCheckOut = search?.check_out_date;
  const dbNights = search?.nights_count;
  
  const urlDates = search?.airbnb_url ? extractDatesFromUrl(search.airbnb_url) : { checkIn: null, checkOut: null };
  const checkIn = dbCheckIn || urlDates.checkIn;
  const checkOut = dbCheckOut || urlDates.checkOut;
  const hasValidDates = checkIn && checkOut;
  const nights = dbNights || (hasValidDates ? calculateNights(checkIn!, checkOut!) : null);

  // Calculate totals - use original_price from results if airbnb_price not available
  const referencePrice = search?.airbnb_price || (results.length > 0 ? results[0].original_price : null);
  const airbnbTotal = referencePrice && nights ? referencePrice * nights : null;
  const estimatedServiceFee = airbnbTotal ? Math.round(airbnbTotal * 0.14) : null;
  const airbnbGrandTotal = airbnbTotal && estimatedServiceFee ? airbnbTotal + estimatedServiceFee : null;

  // Filter and sort results with price validation
  // - Always keep visually verified matches (even if price is missing or outside our "reasonable" range)
  // - Keep text-only matches only when they have a valid price
  const validResults = results.filter((r) => {
    const isVisual = r.match_type === "visual";

    // Visual matches are the core value: show them even if price scraping failed or looks odd.
    if (isVisual) return true;

    const hasValidPrice = !!r.price && r.price >= 10; // Min €10/night for any real accommodation
    if (!hasValidPrice) return false;

    const totalPrice = nights ? r.price! * nights : r.price!;

    // If we have a reference price, validate against it for text-only results
    if (airbnbGrandTotal) {
      const minReasonable = airbnbGrandTotal * 0.2;
      const maxReasonable = airbnbGrandTotal * 2.0;
      return totalPrice >= minReasonable && totalPrice <= maxReasonable;
    }

    return true;
  });
  
  // Sort by price descending (most expensive first), treating invalid prices (< €10) as no price
  const sortedByPrice = [...validResults].sort((a, b) => {
    const priceA = a.price && a.price >= 10 ? a.price : 0;
    const priceB = b.price && b.price >= 10 ? b.price : 0;
    return priceB - priceA;
  });

  // Show more than 1 result: up to 6 alternatives, while ensuring the cheapest is included
  const MAX_ALTERNATIVES = 6;
  let displayResults: SearchResult[] = sortedByPrice.slice(0, MAX_ALTERNATIVES);

  // Only consider valid prices (≥ €10) when finding cheapest
  const resultsWithValidPrices = sortedByPrice.filter(r => r.price && r.price >= 10);
  const cheapestOverall = resultsWithValidPrices.length
    ? resultsWithValidPrices.reduce((min, r) => (r.price! < min.price!) ? r : min, resultsWithValidPrices[0])
    : null;

  if (cheapestOverall && !displayResults.some((r) => r.id === cheapestOverall.id)) {
    // Replace last slot with the cheapest so the Unlock CTA always has something real
    if (displayResults.length === MAX_ALTERNATIVES) {
      displayResults = [...displayResults.slice(0, MAX_ALTERNATIVES - 1), cheapestOverall];
    } else {
      displayResults = [...displayResults, cheapestOverall];
    }
  }

  // Find cheapest result for unlock button (only valid prices)
  const cheapestResult = resultsWithValidPrices.length > 0
    ? resultsWithValidPrices.reduce((min, r) => (r.price! < min.price!) ? r : min, resultsWithValidPrices[0])
    : null;

  // Calculate potential savings
  const cheapestTotalPrice = cheapestResult?.price && nights ? cheapestResult.price * nights : null;
  const potentialSavings = airbnbGrandTotal && cheapestTotalPrice ? airbnbGrandTotal - cheapestTotalPrice : null;


  // Helper to generate key differences based on platform
  const getKeyDifferences = (result: SearchResult): string[] => {
    const differences: string[] = [];
    const isDirect = result.platform_name.includes("(Direct)");
    
    if (isDirect) {
      differences.push("No platform booking fees");
      differences.push("Book directly with owner");
    }
    
    if (result.platform_name.toLowerCase().includes("booking")) {
      differences.push("Free cancellation usually available");
      differences.push("Breakfast may be included");
    } else if (result.platform_name.toLowerCase().includes("vrbo")) {
      differences.push("Similar to Airbnb policies");
      differences.push("May have lower service fees");
    } else if (result.platform_name.toLowerCase().includes("agoda")) {
      differences.push("Often includes breakfast");
      differences.push("Pay at property options");
    }
    
    if (result.match_type === 'visual') {
      differences.push("✓ Photo verified match");
    }
    
    return differences.length > 0 ? differences : ["Verify booking terms on site"];
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="container px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link to="/dashboard" className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors">
              <ArrowLeft className="w-4 h-4" />
              <span className="hidden sm:inline">Back to Dashboard</span>
            </Link>
          </div>
          <Link to="/">
            <AriviooLogo />
          </Link>
        </div>
      </header>

      <main className="container px-4 py-8 md:py-12">
        {loading ? (
          <div className="max-w-xl mx-auto py-12">
            {/* Thinking Phase - Shows while search is running */}
            {searchPhase === 'thinking' && (
              <div className="text-center py-8 animate-fade-in">
                <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-primary/10 flex items-center justify-center">
                  <Sparkles className="w-10 h-10 text-primary animate-pulse" />
                </div>
                <h2 className="text-2xl font-bold text-foreground mb-2">
                  Analyzing Your Listing
                </h2>

                <p className="text-muted-foreground mb-6 max-w-md mx-auto">
                  Searching across platforms and visually verifying matches with your photos.
                </p>

                {/* Pulsing progress indicator */}
                <div className="max-w-xs mx-auto">
                  <div className="h-2 bg-muted rounded-full overflow-hidden">
                    <div className="h-full bg-primary/60 rounded-full animate-pulse" style={{ width: '100%' }} />
                  </div>
                </div>

                <div className="mt-6 space-y-3">
                  <p className="text-sm text-muted-foreground">
                    Elapsed: <span className="font-medium text-foreground">{Math.floor(thinkingElapsedMs / 1000)}s</span> · Typical: 30–60s
                  </p>

                  {/* Live activity card - always visible with message + detail */}
                  {(() => {
                    const activity = getLiveActivity(search?.status);
                    return (
                      <div className="mx-auto max-w-md rounded-xl border-2 border-primary/30 bg-primary/5 p-4 text-left shadow-sm">
                        <div className="flex items-center gap-2 mb-2">
                          <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                          <p className="text-xs font-medium text-primary uppercase tracking-wide">Live Activity</p>
                        </div>
                        <p className="text-base font-semibold text-foreground leading-relaxed">{activity.message}</p>
                        {activity.detail && (
                          <p className="text-sm text-muted-foreground mt-1">{activity.detail}</p>
                        )}

                        {/* Ticker feed */}
                        {activityFeed.length > 0 && (
                          <div className="mt-4 rounded-lg border border-border bg-card/60">
                            <ScrollArea className="h-32">
                              <div ref={tickerScrollRef} className="p-3 space-y-2">
                                {activityFeed
                                  .slice()
                                  .reverse()
                                  .map((item, idx) => (
                                    <div key={`${item.ts}-${idx}`} className="text-sm">
                                      <p className="text-foreground/90">{item.message}</p>
                                      {item.detail && (
                                        <p className="text-xs text-muted-foreground mt-0.5">{item.detail}</p>
                                      )}
                                    </div>
                                  ))}
                              </div>
                            </ScrollArea>
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {thinkingElapsedMs >= 12000 && (
                    <div className="mx-auto max-w-md rounded-xl border border-border bg-card p-4 text-left">
                      <p className="text-sm font-medium text-foreground mb-2">What we’re doing right now</p>
                      <ul className="text-sm text-muted-foreground space-y-1 list-disc pl-5">
                        <li>Extracting clean property photos</li>
                        <li>Running reverse image searches across multiple sites</li>
                        <li>Verifying matches (≥ 90% confidence)</li>
                      </ul>
                      {thinkingElapsedMs >= 45000 && (
                        <p className="text-sm text-muted-foreground mt-3">
                          If this feels stuck, you can cancel and try again.
                        </p>
                      )}
                    </div>
                  )}

                  <div className="flex items-center justify-center gap-3">
                    <Button
                      variant="outline"
                      onClick={() => {
                        abortControllerRef.current?.abort();
                      }}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => {
                        toast({ title: "Still working", description: "We’ll keep searching — this can take up to a minute." });
                      }}
                    >
                      Why is this taking time?
                    </Button>
                  </div>
                </div>
              </div>
            )}
            
            {/* Step Progress Indicator - Shows after search completes */}
            {searchPhase === 'animating' && (
              <div className="mb-12 animate-fade-in">
                {loadingSteps.map((step, index) => {
                  const StepIcon = step.icon;
                  const isActive = index === currentStep;
                  const isCompleted = index < currentStep;
                  
                  return (
                    <div key={step.id} className="relative flex">
                      {/* Left column with circle and line */}
                      <div className="flex flex-col items-center mr-4">
                        {/* Circle */}
                        <div className={`w-12 h-12 rounded-full flex items-center justify-center flex-shrink-0 transition-all duration-300 ${
                          isCompleted 
                            ? 'bg-primary text-primary-foreground' 
                            : isActive 
                            ? 'bg-primary/10 text-primary border-2 border-primary' 
                            : 'bg-muted text-muted-foreground'
                        }`}>
                          {isCompleted ? (
                            <Check className="w-5 h-5" />
                          ) : isActive ? (
                            <div className="relative">
                              <StepIcon className="w-5 h-5" />
                            </div>
                          ) : (
                            <StepIcon className="w-5 h-5" />
                          )}
                        </div>
                        
                        {/* Connecting line */}
                        {index < loadingSteps.length - 1 && (
                          <div className={`w-0.5 flex-1 min-h-[2rem] transition-colors duration-300 ${
                            isCompleted ? 'bg-primary' : 'bg-muted'
                          }`} />
                        )}
                      </div>
                      
                      {/* Right column with content */}
                      <div className={`flex-1 pb-8 ${index === loadingSteps.length - 1 ? 'pb-0' : ''}`}>
                        <div className={`p-4 rounded-xl transition-all duration-300 ${
                          isActive ? 'bg-primary/5 border border-primary/20' : ''
                        }`}>
                          <h3 className={`font-semibold mb-1 transition-colors ${
                            isActive ? 'text-foreground' : isCompleted ? 'text-foreground' : 'text-muted-foreground'
                          }`}>
                            {step.title}
                            {isCompleted && <span className="text-primary ml-2 text-sm">✓</span>}
                          </h3>
                          <p className={`text-sm transition-colors mb-3 ${
                            isActive ? 'text-muted-foreground' : 'text-muted-foreground/60'
                          }`}>
                            {step.description}
                          </p>
                          
                          {/* Progress bar for active step */}
                          {isActive && (
                            <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                              <div 
                                className="h-full bg-primary rounded-full"
                                style={{ width: `${stepProgress}%`, transition: 'width 50ms linear' }}
                              />
                            </div>
                          )}
                          
                          {/* Completed progress bar */}
                          {isCompleted && (
                            <div className="h-1.5 bg-primary/20 rounded-full overflow-hidden">
                              <div className="h-full bg-primary rounded-full w-full" />
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
                
                <div className="text-center mt-8">
                  <p className="text-sm text-muted-foreground">
                    Preparing your results...
                  </p>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="max-w-5xl mx-auto">
            {/* Clean Results Container */}
            <div className="bg-card rounded-2xl shadow-large border border-border overflow-hidden">
              <div className="p-6 md:p-8">
                {/* Single Hero Image */}
                {airbnbImages.length > 0 && (
                  <div className="mb-6">
                    <div className="aspect-[21/9] rounded-xl overflow-hidden">
                      <img 
                        src={airbnbImages[0]} 
                        alt={search?.airbnb_title || "Property"}
                        className="w-full h-full object-cover"
                        loading="eager"
                      />
                    </div>
                  </div>
                )}

                <h1 className="text-xl md:text-2xl font-bold text-foreground mb-4">
                  {search?.airbnb_title || "Price Comparison Results"}
                </h1>

                {/* Date Range Notice */}
                {hasValidDates && (
                  <div className="mb-6 flex items-center gap-2 text-sm text-muted-foreground">
                    <Calendar className="w-4 h-4" />
                    <span>Comparing prices for {formatDate(checkIn!)} – {formatDate(checkOut!)} ({nights} {nights === 1 ? 'night' : 'nights'})</span>
                  </div>
                )}

                {/* Require Airbnb baseline price before showing comparison */}
                {(search?.status === "price_unavailable") || (search?.status === "completed" && !search?.airbnb_price) ? (
                  <div className="py-12 text-center">
                    <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-amber-500/10 flex items-center justify-center">
                      <AlertCircle className="w-8 h-8 text-amber-500" />
                    </div>
                    <h3 className="text-xl font-semibold text-foreground mb-2">
                      Price Comparison Unavailable
                    </h3>
                    <p className="text-muted-foreground mb-6 max-w-md mx-auto">
                      We couldn't fetch the Airbnb price for your dates, so we can't calculate savings or compare alternatives fairly.
                    </p>
                    <p className="text-sm text-muted-foreground mb-6">
                      Please try again in a moment or search with different dates or another listing.
                    </p>
                    <Button asChild>
                      <Link to="/dashboard">
                        <Search className="w-4 h-4 mr-2" />
                        Try Another Search
                      </Link>
                    </Button>
                  </div>
                ) : results.length === 0 ? (
                  <div className="py-12 text-center">
                    <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-muted flex items-center justify-center">
                      <AlertCircle className="w-8 h-8 text-muted-foreground" />
                    </div>
                    <h3 className="text-xl font-semibold text-foreground mb-2">
                      No Alternative Listings Found
                    </h3>
                    <p className="text-muted-foreground mb-6 max-w-md mx-auto">
                      We couldn't find this property on Booking.com, Vrbo, or other platforms using photo matching and property details. 
                      It might be exclusive to Airbnb or listed under a different name elsewhere.
                    </p>
                    <p className="text-sm text-muted-foreground mb-6">
                      This means Airbnb is likely your best option for this property!
                    </p>
                    <Button asChild>
                      <Link to="/dashboard">
                        <Search className="w-4 h-4 mr-2" />
                        Try Another Search
                      </Link>
                    </Button>
                  </div>
                ) : (
                  <>
                    {/* Comparison Table - Matching ExampleResult layout */}
                    <div className="overflow-x-auto mb-8">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-border">
                            <th className="text-left py-3 px-4 font-semibold text-foreground">Platform</th>
                            <th className="text-center py-3 px-4 font-semibold text-foreground">Trust Score</th>
                            <th className="text-right py-3 px-4 font-semibold text-foreground">Total ({nights || 1} nights)</th>
                            <th className="text-right py-3 px-4 font-semibold text-foreground">Per Night</th>
                            <th className="text-left py-3 px-4 font-semibold text-foreground hidden lg:table-cell">Key Differences</th>
                            <th className="text-center py-3 px-4 font-semibold text-foreground">Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {/* Airbnb Original Row - Show estimated price when actual not available */}
                          <tr className="border-b border-border bg-[#FF5A5F]/5">
                            <td className="py-4 px-4">
                              <div className="flex items-center gap-2">
                                <span className="w-2 h-2 rounded-full bg-[#FF5A5F]" />
                                <span className="font-medium text-foreground">Airbnb</span>
                                <span className="text-xs text-muted-foreground">(Original)</span>
                              </div>
                            </td>
                            <td className="py-4 px-4 text-center">
                              <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-muted text-muted-foreground text-xs font-medium">
                                <Shield className="w-3 h-3" />
                                Baseline
                              </span>
                            </td>
                            <td className="py-4 px-4 text-right font-semibold text-foreground">
                              {search?.airbnb_price ? (
                                `€${Math.round(search.airbnb_price * (nights || 1) * 1.14)}`
                              ) : (
                                <div className="flex justify-end">
                                  <div className="h-5 w-16 bg-muted animate-pulse rounded" />
                                </div>
                              )}
                            </td>
                            <td className="py-4 px-4 text-right text-muted-foreground">
                              {search?.airbnb_price ? (
                                `€${search.airbnb_price}/night`
                              ) : (
                                <div className="flex justify-end">
                                  <div className="h-4 w-14 bg-muted animate-pulse rounded" />
                                </div>
                              )}
                            </td>
                            <td className="py-4 px-4 text-muted-foreground hidden lg:table-cell">
                              <span className="text-xs">AirCover protection, ~14% service fee, cleaning fee may apply</span>
                            </td>
                            <td className="py-4 px-4 text-center">
                              <Button variant="outline" size="sm" asChild>
                                <a href={search?.airbnb_url} target="_blank" rel="noopener noreferrer">View</a>
                              </Button>
                            </td>
                          </tr>

                          {/* Alternative Results */}
                          {displayResults.map((result) => {
                            const isCheapest = cheapestResult && result.id === cheapestResult.id;
                            const isDirect = result.platform_name.includes("(Direct)");
                            const totalPrice = result.price && nights ? result.price * nights : null;
                            const keyDiffs = getKeyDifferences(result);
                            const resultImages = toStringArray(result.images);
                            const isExpanded = expandedComparison === result.id;
                            
                            return (
                              <React.Fragment key={result.id}>
                                <tr 
                                  className={isCheapest 
                                    ? 'bg-success/5 border-2 border-success/30' 
                                    : 'border-b border-border hover:bg-muted/50'
                                  }
                                >
                                  <td className="py-4 px-4">
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <span className={`w-2 h-2 rounded-full ${
                                        isCheapest ? 'bg-success' : isDirect ? 'bg-amber-500' : 'bg-blue-500'
                                      }`} />
                                      <span className="font-medium text-foreground">{result.platform_name}</span>
                                      {isCheapest && (
                                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-success/20 text-success text-xs font-medium">
                                          <Sparkles className="w-3 h-3" />
                                          Best Deal
                                        </span>
                                      )}
                                    </div>
                                  </td>
                                  <td className="py-4 px-4 text-center">
                                    {result.confidence_score !== null && result.confidence_score !== undefined ? (
                                      <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${
                                        result.confidence_score >= 0.9 
                                          ? 'bg-success/20 text-success' 
                                          : 'bg-primary/20 text-primary'
                                      }`}>
                                        <Shield className="w-3 h-3" />
                                        {Math.round(result.confidence_score * 100)}%
                                      </span>
                                    ) : (
                                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 text-xs font-medium">
                                        <Info className="w-3 h-3" />
                                        Text
                                      </span>
                                    )}
                                  </td>
                                  <td className={`py-4 px-4 text-right font-semibold ${isCheapest ? 'text-success text-lg' : 'text-foreground'}`}>
                                    {result.price && result.price >= 10 && totalPrice ? `€${totalPrice}` : '—'}
                                  </td>
                                  <td className={`py-4 px-4 text-right ${isCheapest ? 'text-success font-medium' : 'text-muted-foreground'}`}>
                                    {result.price && result.price >= 10 ? `€${result.price}/night` : '—'}
                                  </td>
                                  <td className="py-4 px-4 hidden lg:table-cell">
                                    <span className={`text-xs ${isCheapest ? 'text-success flex items-center gap-1' : 'text-muted-foreground'}`}>
                                      {isCheapest && <Check className="w-3 h-3" />}
                                      {keyDiffs.slice(0, 2).join(', ')}
                                    </span>
                                  </td>
                                  <td className="py-4 px-4 text-center">
                                    <div className="flex flex-col gap-1.5 items-center">
                                      {isCheapest ? (
                                        <Button size="sm" className="bg-success hover:bg-success/90" asChild>
                                          <Link to={`/unlock?resultId=${result.id}&searchId=${searchId}`}>
                                            <Lock className="w-3 h-3 mr-1" />
                                            Unlock
                                            <ExternalLink className="w-3 h-3 ml-1" />
                                          </Link>
                                        </Button>
                                      ) : (
                                        <Button variant="outline" size="sm" asChild>
                                          <a href={result.listing_url} target="_blank" rel="noopener noreferrer">View Free</a>
                                        </Button>
                                      )}
                                      {resultImages.length > 0 && airbnbImages.length > 0 && (
                                        <button
                                          onClick={() => setExpandedComparison(isExpanded ? null : result.id)}
                                          className={`text-xs px-2 py-1 rounded transition-colors flex items-center gap-1 ${
                                            isExpanded 
                                              ? 'bg-primary/10 text-primary' 
                                              : 'text-muted-foreground hover:text-primary'
                                          }`}
                                        >
                                          <ArrowLeftRight className="w-3 h-3" />
                                          {isExpanded ? 'Hide' : 'Photos'}
                                        </button>
                                      )}
                                    </div>
                                  </td>
                                </tr>
                                {/* Inline Photo Comparison - appears directly below the row */}
                                {isExpanded && resultImages.length > 0 && (
                                  <tr className="border-b border-border">
                                    <td colSpan={6} className="p-4 bg-muted/30">
                                      <ImageComparison
                                        airbnbImages={airbnbImages}
                                        alternativeImages={resultImages}
                                        airbnbTitle={search?.airbnb_title || "Airbnb Listing"}
                                        alternativeTitle={result.listing_title || "Alternative Listing"}
                                        platformName={result.platform_name}
                                        sourceAirbnbImage={result.source_airbnb_image}
                                      />
                                    </td>
                                  </tr>
                                )}
                              </React.Fragment>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>

                    {/* Mobile Cards View for Key Differences */}
                    <div className="lg:hidden space-y-4 mb-8">
                      {displayResults.map((result) => {
                        const resultImages = toStringArray(result.images);
                        const isCheapest = cheapestResult && result.id === cheapestResult.id;
                        const isExpanded = expandedComparison === result.id;
                        const keyDiffs = getKeyDifferences(result);
                        
                        return (
                          <div key={`mobile-${result.id}`} className={`border rounded-xl p-4 ${
                            isCheapest ? 'border-success/50 bg-success/5' : 'border-border'
                          }`}>
                            <p className="text-xs font-medium text-muted-foreground mb-2">Key Differences:</p>
                            <div className="flex flex-wrap gap-2 mb-3">
                              {keyDiffs.map((diff, i) => (
                                <span key={i} className={`text-xs px-2 py-1 rounded ${
                                  diff.startsWith('✓') ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground'
                                }`}>
                                  {diff}
                                </span>
                              ))}
                            </div>
                            
                            {/* Photo Comparison Toggle */}
                            <button
                              onClick={() => setExpandedComparison(isExpanded ? null : result.id)}
                              className="text-sm text-primary hover:underline flex items-center gap-1"
                            >
                              <ArrowLeftRight className="w-4 h-4" />
                              {isExpanded ? 'Hide photo comparison' : 'Compare photos'}
                            </button>
                            
                            {isExpanded && (
                              <div className="mt-4 pt-4 border-t border-border animate-fade-in">
                                <ImageComparison
                                  airbnbImages={airbnbImages}
                                  alternativeImages={resultImages}
                                  airbnbTitle={search?.airbnb_title || "Airbnb Listing"}
                                  alternativeTitle={result.listing_title || "Alternative Listing"}
                                  platformName={result.platform_name}
                                />
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    {/* Savings Summary - Matching design reference */}
                    {cheapestResult && cheapestResult.price && (
                      <div className="border-2 border-success/30 bg-success/5 rounded-2xl p-8 text-center mb-8">
                        <p className="text-muted-foreground mb-3 text-lg">Your potential savings by booking direct</p>
                        <div className="flex items-center justify-center gap-3 mb-3">
                          {!search?.airbnb_price ? (
                            <div className="flex items-center gap-3">
                              <div className="h-12 w-28 bg-muted animate-pulse rounded" />
                              <div className="h-8 w-20 bg-muted animate-pulse rounded" />
                            </div>
                          ) : potentialSavings && potentialSavings > 0 ? (
                            <>
                              <p className="text-5xl font-bold text-success">€{Math.round(potentialSavings)}</p>
                              <span className="text-success text-xl font-semibold">
                                ({airbnbGrandTotal ? Math.round((potentialSavings / airbnbGrandTotal) * 100) : '~'}% off)
                              </span>
                            </>
                          ) : (
                            <p className="text-3xl font-bold text-success">
                              Best price: €{cheapestResult.price && nights ? cheapestResult.price * nights : cheapestResult.price}/total
                            </p>
                          )}
                        </div>
                        <p className="text-muted-foreground mb-4">
                          {!search?.airbnb_price 
                            ? "Calculating savings..."
                            : "Same property, same dates — just without the platform fees"
                          }
                        </p>
                        {search?.airbnb_price && potentialSavings && potentialSavings > 0 && (
                          <p className="text-sm text-muted-foreground">
                            <strong>Unlock fee:</strong> €{(potentialSavings * 0.1).toFixed(2)} (10% of your savings) — Only pay when you save
                          </p>
                        )}
                      </div>
                    )}

                    {/* Methodology note */}
                    <div className="flex items-start gap-3 p-5 bg-muted/30 rounded-2xl">
                      <Info className="w-5 h-5 text-muted-foreground flex-shrink-0 mt-0.5" />
                      <p className="text-sm text-muted-foreground">
                        <strong>Fair comparison methodology:</strong> All prices shown include total costs with fees and taxes for identical dates. 
                        Trust scores are based on image matching accuracy. We verify listings using photo matching and location data. 
                        Always confirm details directly with the host before booking.
                      </p>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Try another search */}
            <div className="text-center mt-8">
              <Button variant="outline" asChild>
                <Link to="/dashboard">
                  <Search className="w-4 h-4 mr-2" />
                  Search Another Property
                </Link>
              </Button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
