import React, { useState, useEffect, useRef } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import { ImageComparison } from "@/components/ImageComparison";
import { quickCelebration } from "@/lib/confetti";
import { PriceExtractionProgress, type PlatformExtractionStatus } from "@/components/PriceExtractionProgress";
import { PipelineProgress, type ActivityItem } from "@/components/PipelineProgress";
import { useEnrichedSearchResults, FAILURE_CATEGORY_LABELS } from "@/hooks/useEnrichedSearchResults";
import { PIPELINE_STAGES, getStageIndexFromStatus, isCompletedStatus } from "@/lib/pipelineStages";
import { AirbnbTotalConfirmation } from "@/components/AirbnbTotalConfirmation";
import { AirbnbTotalConfirmationModal } from "@/components/AirbnbTotalConfirmationModal";
import { TerminalErrorPanel } from "@/components/TerminalErrorPanel";
import { 
  ArrowLeft, 
  ExternalLink, 
  Search, 
  Sparkles,
  AlertCircle,
  TrendingDown,
  TrendingUp,
  Calendar,
  Info,
  Shield,
  Lock,
  Camera,
  Globe,
  DollarSign,
  Check,
  CheckCircle,
  ArrowLeftRight,
  ChevronDown,
  ChevronUp,
  Ban,
  AlertTriangle
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
  source_airbnb_image?: string | null;
  price_check_in?: string | null;
  price_check_out?: string | null;
  dates_differ?: boolean;
  // Tier enrichment
  coverage_tier?: 'A' | 'B' | 'C' | null;
  is_tier_c_blocked?: boolean;
  failure_category?: string | null;
  failure_reason?: string | null;
  // Price verification metadata
  price_status?: 'verified' | 'unverified' | 'unavailable';
  price_source?: 'extracted' | 'scraped' | 'none';
  price_verified_at?: string | null;
  eligible_for_comparison?: boolean;
  verification_failures?: string[];
}

interface PriceExtraction {
  id: string;
  search_result_id: string;
  platform_name: string;
  extraction_status: string;
  extracted_price: number | null;
  extraction_error: string | null;
  deep_link?: string;
}

interface SearchData {
  id: string;
  airbnb_url: string;
  airbnb_title: string | null;
  airbnb_price: number | null;
  airbnb_currency?: string | null;
  airbnb_image_url: string | null;
  airbnb_images: Json;
  status: string;
  created_at: string;
  check_in_date?: string | null;
  check_out_date?: string | null;
  nights_count?: number | null;
  api_error?: string | null;
  api_error_code?: string | null;
  // OCR validation fields
  ocr_booking_card_amount?: number | null;
  ocr_booking_card_nights?: number | null;
  ocr_breakdown_total_amount?: number | null;
  ocr_validation_status?: string | null;
  ocr_accepted_via?: string | null;
  ocr_mismatch_reason?: string | null;
}

// Helper to get currency symbol
const getCurrencySymbol = (currency: string | null | undefined): string => {
  switch (currency) {
    case 'EUR': return '€';
    case 'GBP': return '£';
    case 'CHF': return 'CHF ';
    case 'AUD': return 'A$';
    case 'CAD': return 'C$';
    case 'USD':
    default: return '$';
  }
};

// Note: stageIcons are now in PipelineProgress component

// Resolve the effective error code used for UX branching.
// IMPORTANT: dates_unavailable is terminal and must override any "needs confirmation" UX.
// Maps backend error codes to terminal UX types for consistent friendly messaging.
const resolveSearchErrorCode = (s: SearchData | null): string | null => {
  if (!s) return null;

  // Get the raw error code from preferred fields
  let rawCode: string | null = null;
  
  // Preferred explicit field
  if (s.api_error_code) {
    rawCode = s.api_error_code;
  }

  // Sometimes we store structured JSON in api_error
  if (!rawCode && s.api_error) {
    try {
      const parsed = JSON.parse(s.api_error);
      const code = parsed?.code || parsed?.error_code || parsed?.api_error_code;
      if (typeof code === 'string' && code.length > 0) rawCode = code;
    } catch {
      // Check if the error message itself contains hints for terminal states
      const errLower = s.api_error.toLowerCase();
      if (errLower.includes('timeout') || errLower.includes('timed out')) {
        rawCode = 'provider_timeout';
      } else if (errLower.includes('429') || errLower.includes('rate limit')) {
        rawCode = 'rate_limited';
      } else if (errLower.includes('blocked') || errLower.includes('captcha') || errLower.includes('bot')) {
        rawCode = 'bot_detected';
      }
    }
  }

  if (!rawCode) return null;
  
  // Normalize common error codes to terminal UX types
  const codeMap: Record<string, string> = {
    // Explicit terminal states
    'dates_unavailable': 'dates_unavailable',
    'rate_limited': 'rate_limited',
    'airbnb_total_not_visible': 'airbnb_total_not_visible',
    'provider_timeout': 'provider_timeout',
    'bot_detected': 'bot_detected',
    // Access-layer hard-stop aborts (pipeline stopped before fallbacks)
    'rate_limited_abort': 'rate_limited',
    'bot_blocked_abort': 'bot_detected',
    'blocked_rate_limit': 'rate_limited',
    'blocked_captcha_or_bot': 'bot_detected',
    // Map common variants
    'airbnb_blocked': 'bot_detected',
    'airbnb_blocked_or_captcha': 'bot_detected',
    'airbnb_timeout': 'provider_timeout',
    'airbnb_dates_not_applied': 'airbnb_total_not_visible',
    'airbnb_price_element_missing': 'airbnb_total_not_visible',
  };
  
  return codeMap[rawCode] || rawCode;
};

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

// Use getStageIndexFromStatus from pipelineStages lib

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
  const { fetchEnrichedResults } = useEnrichedSearchResults();
  
  const [user, setUser] = useState<User | null>(null);
  const [search, setSearch] = useState<SearchData | null>(null);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [priceExtractions, setPriceExtractions] = useState<PriceExtraction[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchPhase, setSearchPhase] = useState<'thinking' | 'animating' | 'done'>('thinking');
  const [currentStep, setCurrentStep] = useState(-1); // -1 = thinking phase
  const [stepProgress, setStepProgress] = useState(0);
  const [expandedComparison, setExpandedComparison] = useState<string | null>(null);
  const [thinkingElapsedMs, setThinkingElapsedMs] = useState(0);
  const [hasCelebrated, setHasCelebrated] = useState(false);
  const [activityFeed, setActivityFeed] = useState<Array<{ ts: number; message: string; detail?: string; id: string }>>([]);
  const [showMoreExpensive, setShowMoreExpensive] = useState(false);
  const [showNoPriceMatches, setShowNoPriceMatches] = useState(false);
  const [showUnverifiedPrices, setShowUnverifiedPrices] = useState(false);
  const [showBlockedPlatforms, setShowBlockedPlatforms] = useState(false);
  const [showFailedExtractions, setShowFailedExtractions] = useState(false);
  const [streamDisconnected, setStreamDisconnected] = useState(false);
  const [extractingPrices, setExtractingPrices] = useState(false);
  const [priceExtractionPlatforms, setPriceExtractionPlatforms] = useState<PlatformExtractionStatus[]>([]);
  const [priceExtractionTotal, setPriceExtractionTotal] = useState(0);
  const [priceExtractionCompleted, setPriceExtractionCompleted] = useState(0);
  
  // Monotonic stage tracking - prevents UI from jumping backwards
  const [highestStageIndex, setHighestStageIndex] = useState(-1);
  
  // User confirmation state for Airbnb total
  const [confirmedTotal, setConfirmedTotal] = useState<{
    confirmed_total_amount: number;
    confirmed_currency: string;
    confirmation_source: string;
    confirmed_at: string;
  } | null>(null);
  const [subtotalInfo, setSubtotalInfo] = useState<{
    amount: number | null;
    nights: number | null;
    currency: string;
  } | null>(null);
  const [showConfirmationModal, setShowConfirmationModal] = useState(false);
  const [runSeq, setRunSeq] = useState(0);

  const searchTriggeredRef = useRef(false);
  const searchStartTimeRef = useRef<number>(0);
  const actualDurationRef = useRef<number>(0);
  const animationFrameRef = useRef<number | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const abortReasonRef = useRef<"cancel" | "skip" | null>(null);
  const lastProgressAtRef = useRef<number>(Date.now());
  const autoSkipRequestedRef = useRef(false);
  const skipInFlightRef = useRef(false);
  const seenActivityKeysRef = useRef<Set<string>>(new Set());
  const tickerScrollRef = useRef<HTMLDivElement | null>(null);
  const activityIdCounterRef = useRef(0);
  const heartbeatIntervalRef = useRef<number | null>(null);
  const highestStageIndexRef = useRef(-1); // Ref for use in SSE handler

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

      const searchRecord = searchData as SearchData;
      const resolvedErrorCode = resolveSearchErrorCode(searchRecord);

      // PROOF LOG: show what we will branch on
      console.log('[SearchResults] resolvedErrorCode (initial load):', {
        status: searchRecord.status,
        api_error_code: searchRecord.api_error_code,
        resolvedErrorCode,
      });

      setSearch(searchRecord);
      setCurrentStep(getStageIndexFromStatus(searchRecord.status));

      // Handle dates_required status
      if (searchRecord.status === "dates_required") {
        toast({
          title: "Dates Required",
          description: "Please include check-in and check-out dates in your Airbnb URL to compare prices.",
          variant: "destructive",
        });
        navigate("/dashboard");
        return;
      }

      // Terminal UX: dates unavailable
      if (resolvedErrorCode === 'dates_unavailable') {
        setSearchPhase("done");
        setLoading(false);
        setShowConfirmationModal(false);
        return;
      }

      // If the search has already failed, show the error state immediately.
      if (searchRecord.status === 'error') {
        setSearchPhase("done");
        setLoading(false);
        return;
      }

      // If search needs user confirmation, show the modal
      if (searchRecord.status === "needs_user_confirmation") {
        // Parse subtotal info from api_error JSON
        try {
          const errorData = JSON.parse(searchRecord.api_error || '{}');
          if (errorData.subtotal_nights_only) {
            setSubtotalInfo({
              amount: errorData.subtotal_nights_only,
              nights: errorData.subtotal_nights_count || null,
              currency: errorData.subtotal_currency || searchRecord.airbnb_currency || 'USD',
            });
          }
        } catch {}
        setSearchPhase("done");
        setLoading(false);
        setShowConfirmationModal(true);
        return;
      }

      // If search is already completed, fetch enriched results
      if (searchRecord.status === "completed") {
        const enrichedResults = await fetchEnrichedResults(searchId);
        setResults(enrichedResults as unknown as SearchResult[]);
        setSearchPhase("done");
        setLoading(false);
        return;
      }

      // If status is 'searching' or 'pending', trigger the search with SSE streaming
      if (searchRecord.status === "searching" || searchRecord.status === "pending") {
        try {
          // Reset to thinking phase
          setSearchPhase("thinking");
          setCurrentStep(-1);
          setStepProgress(0);
          setThinkingElapsedMs(0);
          setActivityFeed([]);
          seenActivityKeysRef.current.clear();
          activityIdCounterRef.current = 0;
          lastProgressAtRef.current = Date.now();
          autoSkipRequestedRef.current = false;
          skipInFlightRef.current = false;
          // Reset monotonic stage tracking for new search
          setHighestStageIndex(-1);
          highestStageIndexRef.current = -1;

          // Start timer + allow cancel/skip
          searchStartTimeRef.current = Date.now();
          abortReasonRef.current = null;
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
              // Check for simulation mode in URL params
              body: JSON.stringify({ 
                searchId, 
                stream: true,
                // For testing fallback chain: ?simulate_browserless_fail=true
                simulateBrowserlessFail: new URLSearchParams(window.location.search).get('simulate_browserless_fail') === 'true',
              }),
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
                      lastProgressAtRef.current = Date.now();
                      autoSkipRequestedRef.current = false;

                      // Update search status in real-time if backend sends it (with monotonic guard)
                      if (data.status) {
                        const newStageIndex = getStageIndexFromStatus(data.status);
                        const currentHighest = highestStageIndexRef.current;
                        
                        // Only accept status updates that move forward (or stay same)
                        if (newStageIndex >= currentHighest) {
                          highestStageIndexRef.current = newStageIndex;
                          setHighestStageIndex(newStageIndex);
                          setSearch((prev) => (prev ? { ...prev, status: data.status } : prev));
                        }
                        // Silently ignore regressions from progress events
                      }

                      // If backend confirms a proven Airbnb total, ensure the confirmation modal is closed.
                      // Check for airbnbPrice in any progress event payload (defensive guard)
                      if (typeof data.airbnbPrice === "number" && data.airbnbPrice > 0) {
                        setSearch((prev) =>
                          prev
                            ? {
                                ...prev,
                                airbnb_price: data.airbnbPrice,
                                airbnb_currency: data.airbnbCurrency ?? prev.airbnb_currency,
                              }
                            : prev
                        );
                        // Auto-close modal when we have a valid price (unless explicitly needs_user_confirmation)
                        if (!data.baseline_status || data.baseline_status !== "needs_user_confirmation") {
                          setSubtotalInfo(null);
                          setShowConfirmationModal(false);
                        }
                      }

                      // Add to activity feed with dedup
                      const key = `${data.step}__${data.detail ?? ""}`;
                      if (!seenActivityKeysRef.current.has(key)) {
                        seenActivityKeysRef.current.add(key);
                        activityIdCounterRef.current += 1;
                        const newItem = {
                          ts: data.timestamp || Date.now(),
                          message: data.step,
                          detail: data.detail,
                          id: `activity-${activityIdCounterRef.current}`,
                        };
                        setActivityFeed((prev) => [...prev, newItem].slice(-12));
                      }
                    } else if (eventType === "status_update") {
                      // Dedicated status update event with monotonic stage guard
                      if (data.status) {
                        const newStageIndex = getStageIndexFromStatus(data.status);
                        const currentHighest = highestStageIndexRef.current;
                        
                        // Only accept status updates that move forward (or stay same)
                        if (newStageIndex >= currentHighest) {
                          highestStageIndexRef.current = newStageIndex;
                          setHighestStageIndex(newStageIndex);
                          setSearch((prev) => prev ? { ...prev, status: data.status } : prev);
                        } else {
                          // Log ignored regression for debugging
                          console.log('[MonotonicGuard] Ignored stage regression:', {
                            currentStatus: data.status,
                            newStageIndex,
                            currentHighest,
                            rejectedStage: PIPELINE_STAGES[newStageIndex]?.title,
                            activeStage: PIPELINE_STAGES[currentHighest]?.title,
                          });
                        }
                      }
                    } else if (eventType === "price_extraction_start") {
                      // Starting price extraction phase
                      setCurrentStep(3); // "Collecting Prices" step
                      setExtractingPrices(true);
                      setPriceExtractionTotal(data.totalPlatforms || 0);
                      setPriceExtractionCompleted(0);
                      setPriceExtractionPlatforms(
                        (data.platforms || []).map((p: string) => ({
                          platformName: p,
                          status: 'pending' as const,
                          price: null,
                        }))
                      );
                    } else if (eventType === "price_extraction_progress") {
                      // Update individual platform status
                      setPriceExtractionPlatforms((prev) => {
                        const updated = [...prev];
                        const idx = updated.findIndex(p => p.platformName === data.platformName);
                        if (idx >= 0) {
                          updated[idx] = {
                            ...updated[idx],
                            status: data.status,
                            price: data.price,
                            currency: data.currency,
                            error: data.error,
                          };
                        }
                        return updated;
                      });
                      // Update completed count
                      if (data.status !== 'pending' && data.status !== 'running') {
                        setPriceExtractionCompleted((prev) => prev + 1);
                      }
                    } else if (eventType === "price_extraction_complete") {
                      // Price extraction phase complete
                      setExtractingPrices(false);
                      setPriceExtractionCompleted(data.totalExtracted || priceExtractionTotal);
                    } else if (eventType === "needs_confirmation") {
                      // Subtotal found but no proven total - show modal for user to confirm.
                      // NOTE: Some providers may emit this event before a later successful baseline;
                      // we will auto-close the modal as soon as we receive a proven total.
                      setSubtotalInfo({
                        amount: data.subtotal_nights_only || null,
                        nights: data.subtotal_nights_count || null,
                        currency: data.subtotal_currency || "USD",
                      });
                      setShowConfirmationModal(true);
                      // Continue to complete event which will set the status
                    } else if (eventType === "complete") {
                      searchComplete = true;
                      actualDurationRef.current = Date.now() - startedAt;

                      // DEFENSIVE: If complete payload contains a valid airbnb price, 
                      // close any confirmation modal - the search succeeded with a price
                      const completeAirbnbPrice = data.airbnb?.price;
                      if (typeof completeAirbnbPrice === "number" && completeAirbnbPrice > 0) {
                        setSearch((prev) =>
                          prev
                            ? { ...prev, airbnb_price: completeAirbnbPrice }
                            : prev
                        );
                        setSubtotalInfo(null);
                        setShowConfirmationModal(false);
                      }

                      // Handle needs_user_confirmation - show modal for user input
                      // But only if we don't already have a valid price
                      if (data.needs_user_confirmation && !completeAirbnbPrice) {
                        setSubtotalInfo({
                          amount: data.subtotal_nights_only || null,
                          nights: data.subtotal_nights_count || null,
                          currency: data.subtotal_currency || 'USD',
                        });
                        setShowConfirmationModal(true);
                        // Fetch search to get the updated status
                        const { data: updatedSearch } = await supabase
                          .from("searches")
                          .select("*")
                          .eq("id", searchId)
                          .single();
                        setSearch(updatedSearch as SearchData);
                        setSearchPhase("done");
                        setLoading(false);
                        return;
                      }

                      if (data.success === false) {
                        throw new Error(data.error || "Search failed");
                      }

                      // Success path: ensure the confirmation modal is closed
                      setSubtotalInfo(null);
                      setShowConfirmationModal(false);

                      // Refresh search and results from DB
                      const { data: updatedSearch } = await supabase
                        .from("searches")
                        .select("*")
                        .eq("id", searchId)
                        .single();

                      const enrichedResults = await fetchEnrichedResults(searchId);

                      setSearch(updatedSearch as SearchData);
                      setResults(enrichedResults as unknown as SearchResult[]);
                      setSearchPhase("done");
                      setLoading(false);
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

             // Handle needs_user_confirmation status - not an error
             if (updatedSearch?.status === "needs_user_confirmation") {
               // Parse subtotal info from api_error JSON
               try {
                 const errorData = JSON.parse(updatedSearch.api_error || '{}');
                 if (errorData.subtotal_nights_only) {
                   setSubtotalInfo({
                     amount: errorData.subtotal_nights_only,
                     nights: errorData.subtotal_nights_count || null,
                     currency: errorData.subtotal_currency || 'USD',
                   });
                 }
               } catch {}
               setSearch(updatedSearch as SearchData);
               setSearchPhase("done");
               setLoading(false);
               return;
             }

             // Handle terminal failure states (DB constraint only allows 'error', not 'failed')
             if (updatedSearch?.status === "error") {
               const errorMessage = updatedSearch.api_error || "Search failed unexpectedly";
               toast({
                 title: "Search Failed",
                 description: errorMessage,
                 variant: "destructive",
               });
               setSearch(updatedSearch as SearchData);
               setSearchPhase("done");
               setLoading(false);
               return;
             }

             // Handle dates_required status
             if (updatedSearch?.status === "dates_required") {
               toast({
                 title: "Dates Required",
                 description: "Please include check-in and check-out dates in your Airbnb URL to compare prices.",
                 variant: "destructive",
               });
               navigate("/dashboard");
               return;
             }

             // If the backend is still running, keep the user in the loading state
             if (updatedSearch && updatedSearch.status !== "completed" && updatedSearch.status !== "price_unavailable") {
               setSearch(updatedSearch as SearchData);
               setSearchPhase("thinking");
               return;
             }

             const enrichedResults = await fetchEnrichedResults(searchId);

             // Close any open modals since search is complete
             setShowConfirmationModal(false);
             setSubtotalInfo(null);
             
             setSearch(updatedSearch as SearchData);
             setResults(enrichedResults as unknown as SearchResult[]);
             actualDurationRef.current = Date.now() - startedAt;
             setSearchPhase("done");
             setLoading(false);
           }
        } catch (error: any) {
          // Cancel/skip via AbortController
          if (error?.name === "AbortError") {
            const reason = abortReasonRef.current;
            abortReasonRef.current = null;

            if (reason === "cancel") {
              toast({ title: "Search cancelled", description: "No worries — you can try again anytime." });
              navigate("/dashboard");
              return;
            }

            // Skip: do not navigate away; we'll re-sync from DB below.
            if (reason === "skip") {
              // Allow a moment for the backend to notice the skip flag
              await new Promise((r) => setTimeout(r, 250));

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

              // If we already have completion, move on; otherwise stay in thinking (polling will continue).
              if (updatedSearch?.status === "completed" || updatedSearch?.status === "price_unavailable") {
                actualDurationRef.current = Math.max(0, Date.now() - (searchStartTimeRef.current || Date.now()));
                setSearchPhase("animating");
              } else {
                setSearchPhase("thinking");
              }
              return;
            }

            // Default: treat as cancel
            toast({ title: "Search cancelled", description: "No worries — you can try again anytime." });
            navigate("/dashboard");
            return;
          }
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
  }, [searchId, user, navigate, toast, runSeq, fetchEnrichedResults]);

  // Thinking phase timer (improves UX + makes "stuck" feel less scary)
  useEffect(() => {
    if (!loading || searchPhase !== "thinking") return;

    const startedAt = searchStartTimeRef.current || Date.now();
    const id = window.setInterval(() => {
      setThinkingElapsedMs(Date.now() - startedAt);
    }, 250);

    return () => window.clearInterval(id);
  }, [loading, searchPhase]);

  const requestCancelSearch = async () => {
    if (!searchId) return;

    try {
      // Call backend to set cancelled status
      const { data, error } = await supabase.functions.invoke("cancel-search", {
        body: { searchId },
      });

      if (error) {
        console.error("Cancel error:", error);
      }

      // Abort the SSE stream
      abortReasonRef.current = "cancel";
      abortControllerRef.current?.abort();

      toast({ 
        title: "Search cancelled", 
        description: "No worries — you can try again anytime." 
      });
      navigate("/dashboard");
    } catch (e: any) {
      // Even if backend call fails, still abort and navigate
      abortReasonRef.current = "cancel";
      abortControllerRef.current?.abort();
      navigate("/dashboard");
    }
  };

  const requestSkipCurrentStep = async (mode: "manual" | "auto") => {
    if (!searchId || skipInFlightRef.current) return;
    skipInFlightRef.current = true;

    try {
      const { data, error } = await supabase.functions.invoke("request-skip-step", {
        body: { searchId },
      });

      if (error) {
        throw error;
      }

      if (!data?.ok) {
        throw new Error(data?.error || "Failed to request skip");
      }

      toast({
        title: mode === "manual" ? "Skipping…" : "Taking too long",
        description: mode === "manual" ? "Skipping the current step" : "Automatically skipping the current step",
      });

      // IMPORTANT: Do NOT abort the SSE stream here.
      // Aborting causes the UI to lose progress events and can trigger repeated auto-skips.
      // The backend will observe `skip_requested` and advance to the next phase.
    } catch (e: any) {
      toast({
        title: "Could not skip",
        description: e?.message || "Skip request failed",
        variant: "destructive",
      });
    } finally {
      // prevent rapid re-tries
      window.setTimeout(() => {
        skipInFlightRef.current = false;
      }, 10_000);
    }
  };

  // Backend heartbeat polling - detect stalls even if SSE stream disconnects
  useEffect(() => {
    if (!loading || searchPhase !== "thinking" || !searchId) return;

    const pollHeartbeat = async () => {
      try {
        const { data } = await supabase
          .from("searches")
          .select("*")
          .eq("id", searchId)
          .single();

        if (!data) return;

        // Keep local UI in sync with backend status so the stepper advances even if SSE is silent
        // IMPORTANT: Apply a monotonic guard so we never move backwards in the UI.
        setSearch((prev) => {
          const merged = prev ? ({ ...prev, ...data } as SearchData) : (data as SearchData);

          if (!data.status) return merged;

          const newStageIndex = getStageIndexFromStatus(data.status);
          const currentHighest = highestStageIndexRef.current;

          if (newStageIndex >= currentHighest) {
            highestStageIndexRef.current = newStageIndex;
            setHighestStageIndex(newStageIndex);
            return merged;
          }

          // Preserve the previous status to prevent regressions like:
          // Analyzing Listing -> Verifying Matches -> Analyzing Listing
          console.log('[MonotonicGuard] Ignored stage regression (heartbeat):', {
            incomingStatus: data.status,
            newStageIndex,
            currentHighest,
            rejectedStage: PIPELINE_STAGES[newStageIndex]?.title,
            activeStage: PIPELINE_STAGES[currentHighest]?.title,
          });

          return prev ? ({ ...merged, status: prev.status } as SearchData) : merged;
        });

        // Handle terminal failure states
        if (data.status === "error") {
          const errorMessage = data.api_error || "Search failed unexpectedly";
          toast({
            title: "Search Failed",
            description: errorMessage,
            variant: "destructive",
          });
          setSearchPhase("done");
          setLoading(false);
          return;
        }

        // Handle cancelled status
        if (data.status === "cancelled") {
          toast({
            title: "Search Cancelled",
            description: "This search was cancelled.",
          });
          navigate("/dashboard");
          return;
        }

        // If search is done, update state
        if (["completed", "price_unavailable", "dates_required"].includes(data.status)) {
          // Fetch final results
          const enrichedResults = await fetchEnrichedResults(searchId);

          // CRITICAL: Update search state with latest data before transitioning
          // This ensures the UI sees the correct status and closes any modals
          setSearch(data as SearchData);
          setResults(enrichedResults as unknown as SearchResult[]);
          
          // Close any open modals since search is complete
          setShowConfirmationModal(false);
          setSubtotalInfo(null);
          
          actualDurationRef.current = Date.now() - (searchStartTimeRef.current || Date.now());
          setSearchPhase("done");
          setLoading(false);
          return;
        }

        // Check backend heartbeat for stall detection
        if (data.last_progress_at) {
          const lastHeartbeat = new Date(data.last_progress_at).getTime();
          const sinceHeartbeat = Date.now() - lastHeartbeat;

          // If backend hasn't updated in 45 seconds, auto-skip ONCE
          if (sinceHeartbeat > 45_000 && !autoSkipRequestedRef.current && !skipInFlightRef.current) {
            autoSkipRequestedRef.current = true;
            void requestSkipCurrentStep("auto");
          }
        }
      } catch (e) {
        console.error("Heartbeat poll error:", e);
      }
    };

    heartbeatIntervalRef.current = window.setInterval(pollHeartbeat, 5000);
    pollHeartbeat(); // Initial check

    return () => {
      if (heartbeatIntervalRef.current) {
        window.clearInterval(heartbeatIntervalRef.current);
        heartbeatIntervalRef.current = null;
      }
    };
  }, [loading, searchPhase, searchId]);

  // Stream connection indicator (UI only)
  useEffect(() => {
    if (!loading || searchPhase !== "thinking") return;

    const id = window.setInterval(() => {
      const sinceProgress = Date.now() - lastProgressAtRef.current;
      setStreamDisconnected(sinceProgress > 10_000);
    }, 1000);

    return () => window.clearInterval(id);
  }, [loading, searchPhase]);

  // Reconnect / re-run the search pipeline for this searchId
  const reconnectToSearch = async () => {
    if (!searchId || !user) return;

    toast({ title: "Reconnecting...", description: "Re-attaching to your search" });

    // Reset state
    searchTriggeredRef.current = false;
    setStreamDisconnected(false);
    autoSkipRequestedRef.current = false;
    skipInFlightRef.current = false;
    lastProgressAtRef.current = Date.now();
    seenActivityKeysRef.current.clear();

    // Trigger the fetch+SSE effect again
    setLoading(true);
    setSearchPhase("thinking");
    setRunSeq((s) => s + 1);
  };

  // Helper to get activity message for the feed (used by SSE handler)
  const getActivityMessage = (status: string): { message: string; detail?: string } => {
    if (status === "extracting_photos") {
      return { message: "Extracting property photos", detail: "Downloading clean property images" };
    }
    if (status === "scraping_airbnb_page") {
      return { message: "Loading Airbnb listing", detail: "Capturing page content" };
    }
    if (status.startsWith("searching_platforms_lens_")) {
      const m = status.match(/searching_platforms_lens_(\d+)_of_(\d+)/);
      if (m) {
        return { message: `Searching for matches (image ${m[1]} of ${m[2]})` };
      }
      return { message: "Searching for matches" };
    }
    if (status.startsWith("ai_verifying_")) {
      const platform = status.replace("ai_verifying_", "").replace(/_/g, " ");
      return { message: `Verifying match on ${platform.charAt(0).toUpperCase() + platform.slice(1)}` };
    }
    if (status.startsWith("scraping_price_")) {
      const parts = status.replace("scraping_price_", "");
      const indexMatch = parts.match(/_(\d+)_of_(\d+)$/);
      let platform = parts.replace(/_\d+_of_\d+$/, "").replace(/_/g, " ");
      if (indexMatch) {
        return { message: `Getting price from ${platform} (${indexMatch[1]}/${indexMatch[2]})` };
      }
      return { message: `Getting price from ${platform}` };
    }
    return { message: status.replace(/_/g, " ") };
  };

  // Activity feed from backend status changes
  useEffect(() => {
    if (!loading || !search?.status) return;

    const activity = getActivityMessage(search.status);
    const key = `${activity.message}__${activity.detail ?? ""}`;
    if (seenActivityKeysRef.current.has(key)) return;

    seenActivityKeysRef.current.add(key);
    activityIdCounterRef.current += 1;
    const newItem = { 
      ts: Date.now(), 
      message: activity.message, 
      detail: activity.detail,
      id: `activity-${activityIdCounterRef.current}`
    };
    setActivityFeed((prev) => [...prev, newItem].slice(-8));
  }, [loading, search?.status]);

  // Celebrate when results are shown
  useEffect(() => {
    if (!loading && results.length > 0 && !hasCelebrated) {
      setHasCelebrated(true);
      // Small delay for UX
      setTimeout(() => quickCelebration(), 300);
    }
  }, [loading, results.length, hasCelebrated]);

  // Poll for price extraction status when search is done
  useEffect(() => {
    if (loading || !searchId) return;
    
    const fetchExtractionStatus = async () => {
      const { data } = await supabase
        .from('price_extractions')
        .select('id, search_result_id, platform_name, extraction_status, extracted_price, extraction_error, deep_link')
        .eq('search_id', searchId);
      
      if (data) {
        setPriceExtractions(data as PriceExtraction[]);
        
        // Check if any extractions are still in progress
        const inProgress = data.some(e => e.extraction_status === 'pending' || e.extraction_status === 'running');
        setExtractingPrices(inProgress);
        
        // Update results with extracted prices
        if (data.length > 0) {
          setResults(prev => prev.map(r => {
            const extraction = data.find(e => e.search_result_id === r.id);
            if (extraction?.extracted_price && (!r.price || r.price < 10)) {
              return { ...r, price: extraction.extracted_price };
            }
            return r;
          }));
        }
      }
    };
    
    // Initial fetch
    fetchExtractionStatus();
    
    // Poll every 5 seconds if extractions are in progress
    const pollInterval = setInterval(() => {
      if (extractingPrices) {
        fetchExtractionStatus();
      }
    }, 5000);
    
    return () => clearInterval(pollInterval);
  }, [loading, searchId, extractingPrices]);

  // Fetch confirmed Airbnb total if exists
  useEffect(() => {
    if (!searchId) return;
    
    const fetchConfirmation = async () => {
      const { data } = await supabase
        .from('airbnb_confirmed_totals')
        .select('confirmed_total_amount, confirmed_currency, confirmation_source, confirmed_at, subtotal_nights_only, subtotal_nights_count')
        .eq('search_id', searchId)
        .maybeSingle();
      
      if (data) {
        setConfirmedTotal(data);
        // If we have subtotal info from the confirmation, set it
        if (data.subtotal_nights_only) {
          setSubtotalInfo({
            amount: data.subtotal_nights_only,
            nights: data.subtotal_nights_count,
            currency: data.confirmed_currency || 'USD',
          });
        }
      }
    };
    
    fetchConfirmation();
  }, [searchId]);

  // Also try to get subtotal from api_error if status suggests subtotal only
  useEffect(() => {
    if (!search || subtotalInfo) return;
    
    // Parse subtotal from api_error if it contains subtotal info
    if (search.api_error && search.api_error.includes('Subtotal')) {
      const match = search.api_error.match(/\$?([\d,]+(?:\.\d+)?)\s*for\s*(\d+)\s*nights?/i);
      if (match) {
        setSubtotalInfo({
          amount: parseFloat(match[1].replace(/,/g, '')),
          nights: parseInt(match[2], 10),
          currency: search.airbnb_currency || 'USD',
        });
      }
    }
    
    // Also try parsing JSON from api_error
    if (search.api_error) {
      try {
        const errorData = JSON.parse(search.api_error);
        if (errorData.subtotal_nights_only) {
          setSubtotalInfo({
            amount: errorData.subtotal_nights_only,
            nights: errorData.subtotal_nights_count || null,
            currency: errorData.subtotal_currency || search.airbnb_currency || 'USD',
          });
        }
      } catch {}
    }
  }, [search, subtotalInfo]);

  // Show confirmation modal ONLY when we truly have subtotal-only state
  useEffect(() => {
    if (!search) return;

    const resolvedErrorCode = resolveSearchErrorCode(search);

    const shouldShow =
      resolvedErrorCode !== 'dates_unavailable' &&
      search.status === "needs_user_confirmation" &&
      !confirmedTotal &&
      search.airbnb_price == null;

    if (shouldShow) {
      setShowConfirmationModal(true);
      return;
    }

    // Otherwise, never keep this modal open
    if (showConfirmationModal) setShowConfirmationModal(false);
    if (subtotalInfo) setSubtotalInfo(null);
  }, [search, confirmedTotal, showConfirmationModal, subtotalInfo]);

  // Handle confirmation callbacks
  const handleTotalConfirmed = (amount: number, currency: string) => {
    setConfirmedTotal({
      confirmed_total_amount: amount,
      confirmed_currency: currency,
      confirmation_source: 'user',
      confirmed_at: new Date().toISOString(),
    });
    // Update search's airbnb_price locally for UI consistency
    setSearch(prev => prev ? { ...prev, airbnb_price: amount, airbnb_currency: currency } : prev);
  };

  const handleTotalCleared = () => {
    setConfirmedTotal(null);
  };

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

  // airbnb_price is TOTAL price for the entire stay (not per-night)
  // result.price from alternatives is also TOTAL price
  // Use confirmed total if available, otherwise use extracted price
  const airbnbTotal = confirmedTotal?.confirmed_total_amount || search?.airbnb_price || (results.length > 0 ? results[0].original_price : null);
  const currencySymbol = getCurrencySymbol(confirmedTotal?.confirmed_currency || search?.airbnb_currency);
  
  // Check if we only have a subtotal (needs confirmation)
  const hasSubtotalOnly = search?.status === 'needs_user_confirmation' || 
    (search?.status === 'completed' && !search?.airbnb_price && !confirmedTotal);
  // Use nights count as subtotal context when we don't have the actual subtotal stored
  const displaySubtotal = subtotalInfo?.amount || null;

  // CRITICAL: Filter out Tier C (blocked) platforms from price comparisons
  // They should NEVER show prices or be marked as "Best Deal"
  const supportedResults = results.filter((r) => !r.is_tier_c_blocked);
  const tierCResults = results.filter((r) => r.is_tier_c_blocked);

  // CRITICAL: A match MUST have comparison photos to be considered valid
  // Results without photos cannot be verified and must not be shown as "matches"
  const hasComparisonPhotos = (result: SearchResult): boolean => {
    const resultImages = toStringArray(result.images);
    // Must have at least one alternative image AND at least one Airbnb image for comparison
    return resultImages.length > 0 && airbnbImages.length > 0;
  };

  // =========================================
  // VERIFIED vs UNVERIFIED PRICE GROUPING
  // =========================================
  // CRITICAL: Only eligible_for_comparison === true can be used for numeric comparisons
  // This prevents false savings claims from unverified/scraped prices
  
  const resultsWithPhotos = supportedResults.filter(hasComparisonPhotos);
  
  // VERIFIED: Prices that passed all verification checks (extraction success, dates validated, taxes included)
  const verifiedResults = resultsWithPhotos.filter((r) => 
    r.eligible_for_comparison === true && r.price && r.price >= 10
  );
  
  // UNVERIFIED: Platforms found but prices not verified (scraped, extraction failed, dates not applied, etc.)
  // Still shown but NOT used for comparison logic
  const unverifiedResults = resultsWithPhotos.filter((r) => 
    r.eligible_for_comparison !== true
  );
  
  // Categorize unverified results by extraction outcome
  const categorizeResult = (r: SearchResult): 'price_unverified' | 'blocked' | 'failed' => {
    // Check if blocked by platform (Tier C or blocked status)
    if (r.is_tier_c_blocked || r.failure_category === 'blocked_captcha_or_bot' || 
        r.failure_category === 'rate_limited_abort' || r.failure_category === 'bot_blocked_abort') {
      return 'blocked';
    }
    // Has a price but it's unverified
    if (r.price && r.price > 0 && r.price_status === 'unverified') {
      return 'price_unverified';
    }
    // Everything else is a failed extraction
    return 'failed';
  };
  
  const unverifiedWithPrice = unverifiedResults.filter(r => categorizeResult(r) === 'price_unverified');
  const blockedResults = unverifiedResults.filter(r => categorizeResult(r) === 'blocked');
  const failedResults = unverifiedResults.filter(r => categorizeResult(r) === 'failed');
  
  // For backward compatibility: resultsWithPrices = verified only now
  // This ensures all savings calculations use only trusted prices
  const resultsWithPrices = verifiedResults;
  const resultsWithoutPrices = unverifiedResults;

  // Sort verified results by price descending
  const sortedByPrice = [...verifiedResults].sort((a, b) => (b.price ?? 0) - (a.price ?? 0));

  // Separate verified results into cheaper (savings) and more expensive (no savings)
  // ONLY verified prices are used for this comparison
  const cheaperResults = sortedByPrice.filter((r) => {
    if (!airbnbTotal) return true;
    return r.price! < airbnbTotal;
  });

  // More expensive verified alternatives for collapsed section
  const moreExpensiveResults = sortedByPrice.filter((r) => {
    if (!airbnbTotal) return false;
    return r.price! >= airbnbTotal;
  });

  // For backward compatibility, validResults = verified results with prices
  const validResults = verifiedResults;

  // Show up to 10 cheaper verified alternatives, while ensuring the cheapest is included
  const MAX_ALTERNATIVES = 10;
  let displayResults: SearchResult[] = cheaperResults.slice(0, MAX_ALTERNATIVES);

  // Only consider verified prices when finding cheapest
  const resultsWithValidPrices = cheaperResults;
  const cheapestOverall = resultsWithValidPrices.length
    ? resultsWithValidPrices.reduce(
        (min, r) => (r.price! < min.price! ? r : min),
        resultsWithValidPrices[0]
      )
    : null;

  if (cheapestOverall && !displayResults.some((r) => r.id === cheapestOverall.id)) {
    // Replace last slot with the cheapest so the Unlock CTA always has something real
    if (displayResults.length === MAX_ALTERNATIVES) {
      displayResults = [...displayResults.slice(0, MAX_ALTERNATIVES - 1), cheapestOverall];
    } else {
      displayResults = [...displayResults, cheapestOverall];
    }
  }

  // Find cheapest verified result for unlock button
  const cheapestResult = resultsWithValidPrices.length > 0
    ? resultsWithValidPrices.reduce(
        (min, r) => (r.price! < min.price! ? r : min),
        resultsWithValidPrices[0]
      )
    : null;

  // Calculate potential savings - ONLY from verified prices
  const cheapestTotal = cheapestResult?.price || null;
  const potentialSavings = airbnbTotal && cheapestTotal ? airbnbTotal - cheapestTotal : null;

  // ========================================
  // CANONICAL RESULT STATE COMPUTATION
  // ========================================
  // Define mutually exclusive outcome states for consistent messaging
  // UPDATED: Now uses verified results for comparison states
  type ResultState = 
    | 'no_platforms_found'           // No other platforms found at all
    | 'cheaper_found'                // Found cheaper verified alternatives
    | 'no_cheaper_found'             // Found verified platforms but none cheaper
    | 'prices_unavailable';          // Found platforms but no verified prices

  const computeResultState = (): ResultState => {
    // Total valid matches (with photos)
    const totalMatchesWithPhotos = resultsWithPhotos.length;
    
    if (totalMatchesWithPhotos === 0) {
      return 'no_platforms_found';
    }
    
    // Cheaper verified results exist
    if (cheaperResults.length > 0) {
      return 'cheaper_found';
    }
    
    // Have verified platforms with prices (just not cheaper)
    if (moreExpensiveResults.length > 0) {
      return 'no_cheaper_found';
    }
    
    // Have platforms but no verified prices available
    return 'prices_unavailable';
  };

  const resultState = computeResultState();

  // Get counts for display
  const comparedPlatformsCount = verifiedResults.length;  // Only verified platforms count as "compared"
  const platformsWithoutPricesCount = unverifiedResults.length;  // Unverified = manual check recommended


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

  // Get human-readable failure reason for display
  // Updated to include verification failure reasons
  const getFailureDisplay = (result: SearchResult): { text: string; isTierC: boolean; isTierA: boolean; isUnverified: boolean } => {
    const isTierC = result.is_tier_c_blocked === true;
    const isTierA = result.coverage_tier === 'A';
    const isUnverified = result.price_status === 'unverified';
    
    if (isTierC) {
      return { text: 'Platform not supported', isTierC: true, isTierA: false, isUnverified: false };
    }
    
    // If we have a price but it's unverified, show why
    if (isUnverified && result.price && result.price > 0) {
      const failures = result.verification_failures || [];
      if (failures.includes('scraped_not_extracted')) {
        return { text: 'Price not verified for dates', isTierC: false, isTierA, isUnverified: true };
      }
      if (failures.includes('dates_not_validated')) {
        return { text: 'Dates could not be confirmed', isTierC: false, isTierA, isUnverified: true };
      }
      if (failures.includes('taxes_fees_not_included')) {
        return { text: 'May not include all fees', isTierC: false, isTierA, isUnverified: true };
      }
      if (failures.includes('low_confidence')) {
        return { text: 'Low extraction confidence', isTierC: false, isTierA, isUnverified: true };
      }
      return { text: 'Price not verified', isTierC: false, isTierA, isUnverified: true };
    }
    
    if (result.failure_reason) {
      return { 
        text: FAILURE_CATEGORY_LABELS[result.failure_category || ''] || result.failure_reason, 
        isTierC: false, 
        isTierA,
        isUnverified: false
      };
    }
    
    return { text: 'Price unavailable', isTierC: false, isTierA, isUnverified: false };
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
          <PipelineProgress
            status={search?.status}
            isComplete={false}
            isFailed={search?.status === 'error'}
            errorMessage={search?.status === 'error' ? (search?.api_error || 'Search failed. Please try again.') : undefined}
            startTime={searchStartTimeRef.current || Date.now()}
            activityFeed={activityFeed}
            priceExtractionPlatforms={priceExtractionPlatforms}
            priceExtractionTotal={priceExtractionTotal}
            priceExtractionCompleted={priceExtractionCompleted}
            stableStageIndex={highestStageIndex}
            onCancel={requestCancelSearch}
            onSkip={() => requestSkipCurrentStep("manual")}
          />
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
                  <div className="mb-4 flex items-center gap-2 text-sm text-muted-foreground">
                    <Calendar className="w-4 h-4" />
                    <span>Comparing prices for {formatDate(checkIn!)} – {formatDate(checkOut!)} ({nights} {nights === 1 ? 'night' : 'nights'})</span>
                  </div>
                )}

                {/* OCR Validation Status Indicator */}
                {search?.ocr_validation_status && (
                  <div className={`mb-4 flex items-center gap-2 text-sm px-3 py-2 rounded-lg border ${
                    search.ocr_validation_status === 'accepted' 
                      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-700' 
                      : 'bg-amber-500/10 border-amber-500/30 text-amber-700'
                  }`}>
                    {search.ocr_validation_status === 'accepted' ? (
                      <>
                        <CheckCircle className="w-4 h-4" />
                        <span>
                          Price verified via visual OCR
                          {search.ocr_accepted_via && (
                            <span className="text-xs opacity-75 ml-1">
                              ({search.ocr_accepted_via === 'breakdown_match' ? 'matches breakdown total' : 
                                search.ocr_accepted_via === 'equal_baseline' ? 'matches booking card' :
                                search.ocr_accepted_via === 'higher_than_baseline' ? 'includes taxes/fees' :
                                search.ocr_accepted_via.replace(/_/g, ' ')})
                            </span>
                          )}
                        </span>
                      </>
                    ) : (
                      <>
                        <AlertTriangle className="w-4 h-4" />
                        <span>
                          OCR validation: {search.ocr_mismatch_reason?.replace(/_/g, ' ') || 'mismatch detected'}
                        </span>
                      </>
                    )}
                  </div>
                )}


                {/* Handle dates unavailable - listing not bookable for selected dates */}
                {(() => {
                  const resolvedErrorCode = resolveSearchErrorCode(search);
                  // PROOF LOG: Show exactly what fields we're checking
                  console.log('[SearchResults] resolvedErrorCode (render):', {
                    resolvedErrorCode,
                    api_error_code: search?.api_error_code,
                    status: search?.status,
                    api_error: search?.api_error,
                  });
                  return null;
                })()}

                {/* Handle all terminal error states with unified TerminalErrorPanel */}
                {(() => {
                  const errorCode = resolveSearchErrorCode(search);
                  const terminalTypes = ["dates_unavailable", "rate_limited", "airbnb_total_not_visible", "provider_timeout", "bot_detected"];
                  
                  if (errorCode && terminalTypes.includes(errorCode)) {
                    return (
                      <TerminalErrorPanel
                        type={errorCode as "dates_unavailable" | "rate_limited" | "airbnb_total_not_visible" | "provider_timeout" | "bot_detected"}
                        airbnbUrl={search?.airbnb_url}
                        checkIn={checkIn}
                        checkOut={checkOut}
                        nights={nights}
                        apiErrorCode={search?.api_error_code}
                        apiError={search?.api_error}
                      />
                    );
                  }
                  
                  // Generic error state (for truly unknown errors)
                  if (search?.status === "error") {
                    return (
                      <div className="py-12 text-center">
                        <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-destructive/10 flex items-center justify-center">
                          <AlertCircle className="w-8 h-8 text-destructive" />
                        </div>
                        <h3 className="text-xl font-semibold text-foreground mb-2">
                          Something Went Wrong
                        </h3>
                        <p className="text-muted-foreground mb-4 max-w-md mx-auto">
                          We encountered an unexpected error while searching for alternatives. Please try again.
                        </p>
                        <details className="mb-6 text-left max-w-md mx-auto">
                          <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                            Show technical details
                          </summary>
                          <div className="mt-2 p-3 bg-muted/50 rounded-lg text-xs text-muted-foreground font-mono">
                            {search?.api_error_code && <div>Error code: {search.api_error_code}</div>}
                            {search?.api_error && <div className="mt-1">Message: {search.api_error}</div>}
                          </div>
                        </details>
                        <Button asChild>
                          <Link to="/dashboard">
                            <Search className="w-4 h-4 mr-2" />
                            Try Another Search
                          </Link>
                        </Button>
                      </div>
                    );
                  }
                  
                  return null;
                })()}
                
                {/* User needs to confirm the Airbnb trip total (only when we do NOT have a verified total) */}
                {(search?.status === "needs_user_confirmation" && !confirmedTotal && search?.airbnb_price == null && !resolveSearchErrorCode(search)) && (
                  <div className="py-8">
                    <AirbnbTotalConfirmation
                      searchId={searchId!}
                      subtotalAmount={subtotalInfo?.amount ?? null}
                      subtotalNights={subtotalInfo?.nights || nights}
                      subtotalCurrency={subtotalInfo?.currency || search?.airbnb_currency || 'USD'}
                      existingConfirmation={confirmedTotal}
                      onConfirmed={handleTotalConfirmed}
                      onCleared={handleTotalCleared}
                    />
                  </div>
                )}

                {/* Price comparison unavailable - no terminal error, but no price either */}
                {((search?.status === "price_unavailable") || (search?.status === "completed" && !search?.airbnb_price && !confirmedTotal)) && !resolveSearchErrorCode(search) && (
                  <div className="py-12 text-center">
                    <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-amber-500/10 flex items-center justify-center">
                      <AlertCircle className="w-8 h-8 text-amber-500" />
                    </div>
                    <h3 className="text-xl font-semibold text-foreground mb-2">
                      Price Comparison Unavailable
                    </h3>
                    <p className="text-muted-foreground mb-4 max-w-md mx-auto">
                      {search?.api_error || "We couldn't read the total price Airbnb shows for those dates."}
                    </p>
                    {search?.api_error_code && (
                      <p className="text-xs text-muted-foreground/70 mb-4">
                        Reason: {search.api_error_code === 'airbnb_blocked' ? 'Airbnb blocked the request' :
                                 search.api_error_code === 'airbnb_timeout' ? 'Request timed out' :
                                 search.api_error_code === 'airbnb_price_element_missing' ? 'Price element not found on page' :
                                 search.api_error_code === 'provider_error' ? 'Scraping service error' :
                                 search.api_error_code}
                      </p>
                    )}
                    
                    {/* Show confirmation option as fallback */}
                    <div className="max-w-lg mx-auto mb-6">
                      <AirbnbTotalConfirmation
                        searchId={searchId!}
                        subtotalAmount={subtotalInfo?.amount ?? null}
                        subtotalNights={subtotalInfo?.nights ?? nights}
                        subtotalCurrency={subtotalInfo?.currency || search?.airbnb_currency || 'USD'}
                        existingConfirmation={confirmedTotal}
                        onConfirmed={handleTotalConfirmed}
                        onCleared={handleTotalCleared}
                      />
                    </div>
                    
                    <Button variant="outline" asChild>
                      <Link to="/dashboard">
                        <Search className="w-4 h-4 mr-2" />
                        Try Another Search
                      </Link>
                    </Button>
                  </div>
                )}

                {/* No alternatives found (no valid photo-verified matches) */}
                {(search?.status === "completed" && resultState === 'no_platforms_found' && (search?.airbnb_price || confirmedTotal)) && (
                  <>
                    {/* No alternatives found, but still show Airbnb baseline */}
                    <div className="mb-6 p-4 rounded-xl bg-muted/40 border border-border">
                      <h3 className="text-lg font-semibold text-foreground mb-1">No Alternative Listings Found</h3>
                      <p className="text-sm text-muted-foreground">
                        We checked other booking platforms but did not find this property listed elsewhere with verifiable photos. This is currently the only available offer.
                      </p>
                    </div>

                    <div className="overflow-x-auto mb-8">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-border">
                            <th className="text-left py-3 px-4 font-semibold text-foreground">Platform</th>
                            <th className="text-center py-3 px-4 font-semibold text-foreground">Trust Score</th>
                            <th className="text-right py-3 px-4 font-semibold text-foreground">Total ({nights || 1} nights)</th>
                            <th className="text-left py-3 px-4 font-semibold text-foreground hidden lg:table-cell">Key Differences</th>
                            <th className="text-center py-3 px-4 font-semibold text-foreground">Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr className="bg-primary/5 border-2 border-primary/20">
                            <td className="py-4 px-4">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="w-2 h-2 rounded-full bg-primary" />
                                <span className="font-medium text-foreground">Airbnb</span>
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary/15 text-primary text-xs font-medium">
                                  <Sparkles className="w-3 h-3" />
                                  Baseline
                                </span>
                              </div>
                            </td>
                            <td className="py-4 px-4 text-center">
                              <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-muted text-muted-foreground text-xs font-medium">
                                <Shield className="w-3 h-3" />
                                Baseline
                              </span>
                            </td>
                            <td className="py-4 px-4 text-right">
                              {airbnbTotal ? (
                                <span className="font-semibold text-foreground text-lg">{currencySymbol}{Math.round(airbnbTotal)}</span>
                              ) : hasSubtotalOnly && displaySubtotal ? (
                                <div className="flex flex-col items-end gap-0.5">
                                  <span className="font-semibold text-amber-600 text-lg">{currencySymbol}{Math.round(displaySubtotal)}*</span>
                                  <span className="text-[10px] text-amber-500">+ taxes/fees</span>
                                </div>
                              ) : (
                                <span className="font-semibold text-foreground text-lg">—</span>
                              )}
                            </td>
                            <td className="py-4 px-4 text-muted-foreground hidden lg:table-cell">
                              {hasSubtotalOnly && !confirmedTotal ? (
                                <span className="text-xs text-amber-600">*Subtotal only – taxes/fees not included</span>
                              ) : (
                                <span className="text-xs">AirCover protection, service fee, cleaning fee may apply</span>
                              )}
                            </td>
                            <td className="py-4 px-4 text-center">
                              <Button size="sm" asChild>
                                <a href={search?.airbnb_url} target="_blank" rel="noopener noreferrer">
                                  View on Airbnb <ExternalLink className="w-3 h-3 ml-1" />
                                </a>
                              </Button>
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>

                    <Button asChild>
                      <Link to="/dashboard">
                        <Search className="w-4 h-4 mr-2" />
                        Try Another Search
                      </Link>
                    </Button>
                  </>
                )}

                {/* Alternatives exist but none are cheaper than Airbnb */}
                {(search?.status === "completed" && displayResults.length === 0 && (resultState === 'no_cheaper_found' || resultState === 'prices_unavailable') && (search?.airbnb_price || confirmedTotal)) && (
                  /* Alternatives exist but none are cheaper than Airbnb - use same table layout */
                  <>
                    {/* Success/Info banner - varies by result state */}
                    <div className={`mb-6 p-4 rounded-xl flex items-center gap-3 ${
                      resultState === 'no_cheaper_found' 
                        ? 'bg-green-500/10 border border-green-500/20' 
                        : 'bg-muted/40 border border-border'
                    }`}>
                      <div className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${
                        resultState === 'no_cheaper_found' 
                          ? 'bg-green-500/20' 
                          : 'bg-muted'
                      }`}>
                        {resultState === 'no_cheaper_found' ? (
                          <CheckCircle className="w-5 h-5 text-green-500" />
                        ) : (
                          <Info className="w-5 h-5 text-muted-foreground" />
                        )}
                      </div>
                      <div>
                        {resultState === 'no_cheaper_found' ? (
                          <>
                            <h3 className="font-semibold text-foreground">Airbnb Has the Best Price</h3>
                            <p className="text-sm text-muted-foreground">
                              We compared {comparedPlatformsCount} other platform{comparedPlatformsCount !== 1 ? "s" : ""}, 
                              but none offered a lower price. You're already getting the best deal!
                            </p>
                          </>
                        ) : (
                          <>
                            <h3 className="font-semibold text-foreground">Property Found on Other Platforms</h3>
                            <p className="text-sm text-muted-foreground">
                              We found this property on {platformsWithoutPricesCount} other platform{platformsWithoutPricesCount !== 1 ? "s" : ""}, 
                              but prices were not available for comparison.
                            </p>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Comparison Table - Same layout as normal results */}
                    <div className="overflow-x-auto mb-8">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-border">
                            <th className="text-left py-3 px-4 font-semibold text-foreground">Platform</th>
                            <th className="text-center py-3 px-4 font-semibold text-foreground">Trust Score</th>
                            <th className="text-right py-3 px-4 font-semibold text-foreground">Total ({nights || 1} nights)</th>
                            <th className="text-left py-3 px-4 font-semibold text-foreground hidden lg:table-cell">Key Differences</th>
                            <th className="text-center py-3 px-4 font-semibold text-foreground">Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {/* Airbnb Row - Highlighted as Best Deal */}
                          <tr className="bg-success/5 border-2 border-success/30">
                            <td className="py-4 px-4">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="w-2 h-2 rounded-full bg-success" />
                                <span className="font-medium text-foreground">Airbnb</span>
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-success/20 text-success text-xs font-medium">
                                  <Sparkles className="w-3 h-3" />
                                  Best Deal
                                </span>
                              </div>
                            </td>
                            <td className="py-4 px-4 text-center">
                              <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-muted text-muted-foreground text-xs font-medium">
                                <Shield className="w-3 h-3" />
                                Baseline
                              </span>
                            </td>
                            <td className="py-4 px-4 text-right">
                              {airbnbTotal ? (
                                <span className="font-semibold text-success text-lg">{currencySymbol}{Math.round(airbnbTotal)}</span>
                              ) : hasSubtotalOnly && displaySubtotal ? (
                                <div className="flex flex-col items-end gap-0.5">
                                  <span className="font-semibold text-amber-600 text-lg">{currencySymbol}{Math.round(displaySubtotal)}*</span>
                                  <span className="text-[10px] text-amber-500">+ taxes/fees</span>
                                </div>
                              ) : (
                                <span className="font-semibold text-success text-lg">—</span>
                              )}
                            </td>
                            <td className="py-4 px-4 text-muted-foreground hidden lg:table-cell">
                              {hasSubtotalOnly && !confirmedTotal ? (
                                <span className="text-xs text-amber-600">*Subtotal only – confirm below</span>
                              ) : (
                                <span className="text-xs">Baseline price from Airbnb for these dates</span>
                              )}
                            </td>
                            <td className="py-4 px-4 text-center">
                              <Button size="sm" asChild>
                                <a href={search?.airbnb_url} target="_blank" rel="noopener noreferrer">
                                  Book <ExternalLink className="w-3 h-3 ml-1" />
                                </a>
                              </Button>
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>

                    {/* Collapsible more expensive alternatives */}
                    {moreExpensiveResults.length > 0 && (
                      <div className="border-t border-border/50 pt-6">
                        <button
                          onClick={() => setShowMoreExpensive(!showMoreExpensive)}
                          className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4"
                        >
                          {showMoreExpensive ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                          <span>View {moreExpensiveResults.length} more expensive alternative{moreExpensiveResults.length !== 1 ? "s" : ""}</span>
                        </button>
                        
                        {showMoreExpensive && (
                          <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                              <tbody>
                                {moreExpensiveResults.map((result) => {
                                  const alternativeTotal = result.price || 0;
                                  const priceDiff = Math.round(alternativeTotal - (airbnbTotal || 0));
                                  return (
                                    <tr key={result.id} className="border-b border-border/50 hover:bg-muted/30">
                                      <td className="py-4 px-4">
                                        <div className="flex items-center gap-2">
                                          <span className="w-2 h-2 rounded-full bg-amber-500" />
                                          <span className="font-medium text-foreground">{result.platform_name}</span>
                                        </div>
                                      </td>
                                      <td className="py-4 px-4 text-center">
                                        {result.match_type === "visual" && result.confidence_score ? (
                                          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-green-500/10 text-green-600 text-xs font-medium">
                                            <Shield className="w-3 h-3" />
                                            {Math.round(result.confidence_score)}%
                                          </span>
                                        ) : (
                                          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-amber-500/10 text-amber-600 text-xs font-medium">
                                            <Info className="w-3 h-3" />
                                            Text
                                          </span>
                                        )}
                                      </td>
                                      <td className="py-4 px-4 text-right">
                                        <span className="font-semibold text-foreground">{currencySymbol}{Math.round(alternativeTotal)}</span>
                                        <span className="text-amber-600 text-xs ml-2">(+{currencySymbol}{priceDiff})</span>
                                      </td>
                                      <td className="py-4 px-4 hidden lg:table-cell">
                                        <span className="text-xs text-muted-foreground">May have different terms</span>
                                      </td>
                                      <td className="py-4 px-4 text-center">
                                        <Button variant="outline" size="sm" asChild>
                                          <a href={result.listing_url} target="_blank" rel="noopener noreferrer">
                                            View <ExternalLink className="w-3 h-3 ml-1" />
                                          </a>
                                        </Button>
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Categorized Platform Results */}
                    {resultsWithoutPrices.length > 0 && (
                      <div className="mt-6 pt-6 border-t border-border/50 space-y-6">
                        
                        {/* Category 1: Price fetched but unverified */}
                        {unverifiedWithPrice.length > 0 && (
                          <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 overflow-hidden">
                            <button
                              onClick={() => setShowUnverifiedPrices(!showUnverifiedPrices)}
                              className="w-full px-4 py-3 flex items-center justify-between hover:bg-amber-500/10 transition-colors"
                            >
                              <div className="flex items-center gap-2">
                                <span className="w-2 h-2 rounded-full bg-amber-500" />
                                <AlertCircle className="w-4 h-4 text-amber-500" />
                                <span className="text-sm font-medium text-foreground">
                                  {unverifiedWithPrice.length} price{unverifiedWithPrice.length !== 1 ? 's' : ''} fetched (unverified)
                                </span>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="text-xs text-muted-foreground">Manual check recommended</span>
                                {showUnverifiedPrices ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
                              </div>
                            </button>
                            
                            {showUnverifiedPrices && (
                              <div className="border-t border-amber-500/20">
                                <table className="w-full text-sm">
                                  <tbody>
                                    {unverifiedWithPrice.map((result) => {
                                      const resultImages = toStringArray(result.images);
                                      const isExpanded = expandedComparison === result.id;
                                      const failureDisplay = getFailureDisplay(result);
                                      
                                      return (
                                        <React.Fragment key={result.id}>
                                          <tr className="border-b border-border/50 hover:bg-muted/30">
                                            <td className="py-4 px-4">
                                              <div className="flex items-center gap-2">
                                                <span className="w-2 h-2 rounded-full bg-amber-500" />
                                                <span className="font-medium text-foreground">{result.platform_name}</span>
                                              </div>
                                            </td>
                                            <td className="py-4 px-4 text-center">
                                              {result.match_type === "visual" && result.confidence_score ? (
                                                <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-green-500/10 text-green-600 text-xs font-medium">
                                                  <Shield className="w-3 h-3" />
                                                  {Math.round(result.confidence_score * 100)}%
                                                </span>
                                              ) : (
                                                <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-amber-500/10 text-amber-600 text-xs font-medium">
                                                  <Info className="w-3 h-3" />
                                                  Text
                                                </span>
                                              )}
                                            </td>
                                            <td className="py-4 px-4 text-right">
                                              <div className="flex flex-col items-end gap-0.5">
                                                <span className="text-sm font-medium text-foreground">
                                                  ${result.price?.toLocaleString()}
                                                </span>
                                                <span className="text-xs text-amber-600">{failureDisplay.text}</span>
                                              </div>
                                            </td>
                                            <td className="py-4 px-4 text-center">
                                              <div className="flex flex-col gap-1.5 items-center">
                                                <Button variant="outline" size="sm" asChild>
                                                  <a href={result.listing_url} target="_blank" rel="noopener noreferrer">
                                                    View <ExternalLink className="w-3 h-3 ml-1" />
                                                  </a>
                                                </Button>
                                                <button
                                                  onClick={() => setExpandedComparison(isExpanded ? null : result.id)}
                                                  className={`text-xs px-2 py-1 rounded transition-colors flex items-center gap-1 ${isExpanded ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-primary'}`}
                                                >
                                                  <ArrowLeftRight className="w-3 h-3" />
                                                  {isExpanded ? 'Hide' : 'Photos'}
                                                </button>
                                              </div>
                                            </td>
                                          </tr>
                                          {isExpanded && (
                                            <tr className="border-b border-border/50">
                                              <td colSpan={4} className="p-4 bg-muted/30">
                                                {resultImages.length > 0 || airbnbImages.length > 0 ? (
                                                  <ImageComparison airbnbImages={airbnbImages} alternativeImages={resultImages} airbnbTitle={search?.airbnb_title || "Airbnb Listing"} alternativeTitle={result.listing_title || "Alternative Listing"} platformName={result.platform_name} sourceAirbnbImage={result.source_airbnb_image} />
                                                ) : (
                                                  <div className="text-center py-6 text-muted-foreground">
                                                    <Camera className="w-8 h-8 mx-auto mb-2 opacity-50" />
                                                    <p className="text-sm">No photos available for comparison</p>
                                                  </div>
                                                )}
                                              </td>
                                            </tr>
                                          )}
                                        </React.Fragment>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </div>
                        )}
                        
                        {/* Category 2: Blocked by platform */}
                        {blockedResults.length > 0 && (
                          <div className="rounded-xl border border-red-500/20 bg-red-500/5 overflow-hidden">
                            <button
                              onClick={() => setShowBlockedPlatforms(!showBlockedPlatforms)}
                              className="w-full px-4 py-3 flex items-center justify-between hover:bg-red-500/10 transition-colors"
                            >
                              <div className="flex items-center gap-2">
                                <span className="w-2 h-2 rounded-full bg-red-500" />
                                <Ban className="w-4 h-4 text-red-500" />
                                <span className="text-sm font-medium text-foreground">
                                  {blockedResults.length} platform{blockedResults.length !== 1 ? 's' : ''} blocked access
                                </span>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="text-xs text-muted-foreground">Bot detection or rate limit</span>
                                {showBlockedPlatforms ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
                              </div>
                            </button>
                            
                            {showBlockedPlatforms && (
                              <div className="border-t border-red-500/20">
                                <table className="w-full text-sm">
                                  <tbody>
                                    {blockedResults.map((result) => {
                                      const resultImages = toStringArray(result.images);
                                      const isExpanded = expandedComparison === result.id;
                                      const failureDisplay = getFailureDisplay(result);
                                      
                                      return (
                                        <React.Fragment key={result.id}>
                                          <tr className="border-b border-border/50 hover:bg-muted/30">
                                            <td className="py-4 px-4">
                                              <div className="flex items-center gap-2">
                                                <span className="w-2 h-2 rounded-full bg-red-500" />
                                                <span className="font-medium text-foreground">{result.platform_name}</span>
                                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-500/10 text-red-600 text-[10px] font-medium">
                                                  <Ban className="w-2.5 h-2.5" />
                                                  Blocked
                                                </span>
                                              </div>
                                            </td>
                                            <td className="py-4 px-4 text-center">
                                              {result.match_type === "visual" && result.confidence_score ? (
                                                <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-green-500/10 text-green-600 text-xs font-medium">
                                                  <Shield className="w-3 h-3" />
                                                  {Math.round(result.confidence_score * 100)}%
                                                </span>
                                              ) : (
                                                <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-amber-500/10 text-amber-600 text-xs font-medium">
                                                  <Info className="w-3 h-3" />
                                                  Text
                                                </span>
                                              )}
                                            </td>
                                            <td className="py-4 px-4 text-right text-muted-foreground">
                                              <span className="text-sm text-red-500">{failureDisplay.text}</span>
                                            </td>
                                            <td className="py-4 px-4 text-center">
                                              <div className="flex flex-col gap-1.5 items-center">
                                                <Button variant="outline" size="sm" asChild>
                                                  <a href={result.listing_url} target="_blank" rel="noopener noreferrer">
                                                    View <ExternalLink className="w-3 h-3 ml-1" />
                                                  </a>
                                                </Button>
                                                <button
                                                  onClick={() => setExpandedComparison(isExpanded ? null : result.id)}
                                                  className={`text-xs px-2 py-1 rounded transition-colors flex items-center gap-1 ${isExpanded ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-primary'}`}
                                                >
                                                  <ArrowLeftRight className="w-3 h-3" />
                                                  {isExpanded ? 'Hide' : 'Photos'}
                                                </button>
                                              </div>
                                            </td>
                                          </tr>
                                          {isExpanded && (
                                            <tr className="border-b border-border/50">
                                              <td colSpan={4} className="p-4 bg-muted/30">
                                                {resultImages.length > 0 || airbnbImages.length > 0 ? (
                                                  <ImageComparison airbnbImages={airbnbImages} alternativeImages={resultImages} airbnbTitle={search?.airbnb_title || "Airbnb Listing"} alternativeTitle={result.listing_title || "Alternative Listing"} platformName={result.platform_name} sourceAirbnbImage={result.source_airbnb_image} />
                                                ) : (
                                                  <div className="text-center py-6 text-muted-foreground">
                                                    <Camera className="w-8 h-8 mx-auto mb-2 opacity-50" />
                                                    <p className="text-sm">No photos available for comparison</p>
                                                  </div>
                                                )}
                                              </td>
                                            </tr>
                                          )}
                                        </React.Fragment>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </div>
                        )}
                        
                        {/* Category 3: Extraction failed */}
                        {failedResults.length > 0 && (
                          <div className="rounded-xl border border-border bg-muted/30 overflow-hidden">
                            <button
                              onClick={() => setShowFailedExtractions(!showFailedExtractions)}
                              className="w-full px-4 py-3 flex items-center justify-between hover:bg-muted/50 transition-colors"
                            >
                              <div className="flex items-center gap-2">
                                <span className="w-2 h-2 rounded-full bg-muted-foreground" />
                                <AlertCircle className="w-4 h-4 text-muted-foreground" />
                                <span className="text-sm font-medium text-foreground">
                                  {failedResults.length} extraction{failedResults.length !== 1 ? 's' : ''} failed
                                </span>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="text-xs text-muted-foreground">Page load or price not found</span>
                                {showFailedExtractions ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
                              </div>
                            </button>
                            
                            {showFailedExtractions && (
                              <div className="border-t border-border">
                                <table className="w-full text-sm">
                                  <tbody>
                                    {failedResults.map((result) => {
                                      const resultImages = toStringArray(result.images);
                                      const isExpanded = expandedComparison === result.id;
                                      const failureDisplay = getFailureDisplay(result);
                                      
                                      return (
                                        <React.Fragment key={result.id}>
                                          <tr className="border-b border-border/50 hover:bg-muted/30">
                                            <td className="py-4 px-4">
                                              <div className="flex items-center gap-2">
                                                <span className="w-2 h-2 rounded-full bg-muted-foreground" />
                                                <span className="font-medium text-foreground">{result.platform_name}</span>
                                              </div>
                                            </td>
                                            <td className="py-4 px-4 text-center">
                                              {result.match_type === "visual" && result.confidence_score ? (
                                                <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-green-500/10 text-green-600 text-xs font-medium">
                                                  <Shield className="w-3 h-3" />
                                                  {Math.round(result.confidence_score * 100)}%
                                                </span>
                                              ) : (
                                                <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-amber-500/10 text-amber-600 text-xs font-medium">
                                                  <Info className="w-3 h-3" />
                                                  Text
                                                </span>
                                              )}
                                            </td>
                                            <td className="py-4 px-4 text-right text-muted-foreground">
                                              <span className="text-sm">{failureDisplay.text}</span>
                                            </td>
                                            <td className="py-4 px-4 text-center">
                                              <div className="flex flex-col gap-1.5 items-center">
                                                <Button variant="outline" size="sm" asChild>
                                                  <a href={result.listing_url} target="_blank" rel="noopener noreferrer">
                                                    View <ExternalLink className="w-3 h-3 ml-1" />
                                                  </a>
                                                </Button>
                                                <button
                                                  onClick={() => setExpandedComparison(isExpanded ? null : result.id)}
                                                  className={`text-xs px-2 py-1 rounded transition-colors flex items-center gap-1 ${isExpanded ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-primary'}`}
                                                >
                                                  <ArrowLeftRight className="w-3 h-3" />
                                                  {isExpanded ? 'Hide' : 'Photos'}
                                                </button>
                                              </div>
                                            </td>
                                          </tr>
                                          {isExpanded && (
                                            <tr className="border-b border-border/50">
                                              <td colSpan={4} className="p-4 bg-muted/30">
                                                {resultImages.length > 0 || airbnbImages.length > 0 ? (
                                                  <ImageComparison airbnbImages={airbnbImages} alternativeImages={resultImages} airbnbTitle={search?.airbnb_title || "Airbnb Listing"} alternativeTitle={result.listing_title || "Alternative Listing"} platformName={result.platform_name} sourceAirbnbImage={result.source_airbnb_image} />
                                                ) : (
                                                  <div className="text-center py-6 text-muted-foreground">
                                                    <Camera className="w-8 h-8 mx-auto mb-2 opacity-50" />
                                                    <p className="text-sm">No photos available for comparison</p>
                                                  </div>
                                                )}
                                              </td>
                                            </tr>
                                          )}
                                        </React.Fragment>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </div>
                        )}
                        
                      </div>
                    )}

                    {/* Search another button */}
                    <div className="text-center mt-8">
                      <Button variant="outline" asChild>
                        <Link to="/dashboard">
                          <Search className="w-4 h-4 mr-2" />
                          Search Another Property
                        </Link>
                      </Button>
                    </div>
                  </>
                )}

                {/* Main results with cheaper alternatives */}
                {(search?.status === "completed" && displayResults.length > 0 && (search?.airbnb_price || confirmedTotal)) && (
                  <>
                    {/* Comparison Table - Matching ExampleResult layout */}
                    {/* Comparison Table - Matching ExampleResult layout */}
                    <div className="overflow-x-auto mb-8">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-border">
                            <th className="text-left py-3 px-4 font-semibold text-foreground">Platform</th>
                            <th className="text-center py-3 px-4 font-semibold text-foreground">Trust Score</th>
                            <th className="text-right py-3 px-4 font-semibold text-foreground">Total ({nights || 1} nights)</th>
                            <th className="text-left py-3 px-4 font-semibold text-foreground hidden lg:table-cell">Key Differences</th>
                            <th className="text-center py-3 px-4 font-semibold text-foreground">Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {/* Airbnb Original Row - airbnb_price is now TOTAL */}
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
                            <td className="py-4 px-4 text-right">
                              {airbnbTotal ? (
                                <span className="font-semibold text-foreground">{currencySymbol}{Math.round(airbnbTotal)}</span>
                              ) : hasSubtotalOnly && displaySubtotal ? (
                                <div className="flex flex-col items-end gap-0.5">
                                  <span className="font-semibold text-amber-600">{currencySymbol}{Math.round(displaySubtotal)}*</span>
                                  <span className="text-[10px] text-amber-500">+ taxes/fees</span>
                                </div>
                              ) : (
                                <div className="flex justify-end">
                                  <div className="h-5 w-16 bg-muted animate-pulse rounded" />
                                </div>
                              )}
                            </td>
                            <td className="py-4 px-4 text-muted-foreground hidden lg:table-cell">
                              {hasSubtotalOnly && !confirmedTotal ? (
                                <span className="text-xs text-amber-600">*Subtotal only – confirm total below</span>
                              ) : (
                                <span className="text-xs">Baseline price from Airbnb for these dates</span>
                              )}
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
                                      {/* Verified badge - shows for all verified prices */}
                                      {result.eligible_for_comparison && (
                                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-green-500/10 text-green-600 text-[10px] font-medium">
                                          <CheckCircle className="w-2.5 h-2.5" />
                                          Verified
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
                                  {result.price && result.price >= 10 ? `${currencySymbol}${Math.round(result.price)}` : '—'}
                                </td>
                                <td className="py-4 px-4 hidden lg:table-cell">
                                    <div className="flex flex-col gap-1">
                                      <span className={`text-xs ${isCheapest ? 'text-success flex items-center gap-1' : 'text-muted-foreground'}`}>
                                        {isCheapest && <Check className="w-3 h-3" />}
                                        {keyDiffs.slice(0, 2).join(', ')}
                                      </span>
                                      {result.dates_differ && (
                                        <span className="text-[10px] text-amber-600 dark:text-amber-400">
                                          *Original dates unavailable
                                        </span>
                                      )}
                                    </div>
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
                                      {/* Always show photo comparison button */}
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
                                    </div>
                                  </td>
                                </tr>
                                {/* Inline Photo Comparison - appears directly below the row */}
                                {isExpanded && (
                                  <tr className="border-b border-border">
                                    <td colSpan={6} className="p-4 bg-muted/30">
                                      {resultImages.length > 0 || airbnbImages.length > 0 ? (
                                        <ImageComparison
                                          airbnbImages={airbnbImages}
                                          alternativeImages={resultImages}
                                          airbnbTitle={search?.airbnb_title || "Airbnb Listing"}
                                          alternativeTitle={result.listing_title || "Alternative Listing"}
                                          platformName={result.platform_name}
                                          sourceAirbnbImage={result.source_airbnb_image}
                                        />
                                      ) : (
                                        <div className="text-center py-6 text-muted-foreground">
                                          <Camera className="w-8 h-8 mx-auto mb-2 opacity-50" />
                                          <p className="text-sm">No photos available for comparison</p>
                                          <p className="text-xs mt-1">Photos could not be captured for this listing</p>
                                        </div>
                                      )}
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
                              {result.dates_differ && result.price_check_in && result.price_check_out && (
                                <span className="text-xs px-2 py-1 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 flex items-center gap-1">
                                  <Calendar className="w-3 h-3" />
                                  Price for {new Date(result.price_check_in).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} – {new Date(result.price_check_out).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} (original dates unavailable)
                                </span>
                              )}
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

                    {/* Airbnb Total Confirmation - Show when we only have subtotal */}
                    {hasSubtotalOnly && !confirmedTotal && (
                      <div className="mb-8">
                        <AirbnbTotalConfirmation
                          searchId={searchId!}
                          subtotalAmount={displaySubtotal}
                          subtotalNights={nights}
                          subtotalCurrency={search?.airbnb_currency || 'USD'}
                          existingConfirmation={confirmedTotal}
                          onConfirmed={handleTotalConfirmed}
                          onCleared={handleTotalCleared}
                        />
                      </div>
                    )}

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
                              <p className="text-5xl font-bold text-success">{currencySymbol}{potentialSavings.toFixed(2)}</p>
                              <span className="text-success text-xl font-semibold">
                                ({airbnbTotal ? Math.round((potentialSavings / airbnbTotal) * 100) : '~'}% off)
                              </span>
                            </>
                          ) : (
                            <p className="text-3xl font-bold text-success">
                              Best price: {currencySymbol}{cheapestResult.price?.toFixed(2)}/total
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
                            <strong>Unlock fee:</strong> {currencySymbol}{(potentialSavings * 0.1).toFixed(2)} (10% of your savings) — Only pay when you save
                          </p>
                        )}
                      </div>
                    )}

                    {/* Methodology note - Updated to reflect verified price system */}
                    <div className="flex items-start gap-3 p-5 bg-muted/30 rounded-2xl">
                      <Shield className="w-5 h-5 text-muted-foreground flex-shrink-0 mt-0.5" />
                      <div className="text-sm text-muted-foreground">
                        <p>
                          <strong>Verified price comparison:</strong> Only prices that have been automatically verified for your exact dates, including taxes and fees, are used for savings calculations.
                        </p>
                        {unverifiedResults.length > 0 && (
                          <p className="mt-2 text-xs">
                            Platforms where prices could not be verified are shown separately for manual checking.
                          </p>
                        )}
                      </div>
                    </div>

                    {/* Categorized Platform Results */}
                    {resultsWithoutPrices.length > 0 && (
                      <div className="mt-6 pt-6 border-t border-border/50 space-y-6">
                        
                        {/* Category 1: Price fetched but unverified */}
                        {unverifiedWithPrice.length > 0 && (
                          <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 overflow-hidden">
                            <button
                              onClick={() => setShowUnverifiedPrices(!showUnverifiedPrices)}
                              className="w-full px-4 py-3 flex items-center justify-between hover:bg-amber-500/10 transition-colors"
                            >
                              <div className="flex items-center gap-2">
                                <span className="w-2 h-2 rounded-full bg-amber-500" />
                                <AlertCircle className="w-4 h-4 text-amber-500" />
                                <span className="text-sm font-medium text-foreground">
                                  {unverifiedWithPrice.length} price{unverifiedWithPrice.length !== 1 ? 's' : ''} fetched (unverified)
                                </span>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="text-xs text-muted-foreground">Manual check recommended</span>
                                {showUnverifiedPrices ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
                              </div>
                            </button>
                            
                            {showUnverifiedPrices && (
                              <div className="border-t border-amber-500/20">
                                <table className="w-full text-sm">
                                  <tbody>
                                    {unverifiedWithPrice.map((result) => {
                                      const resultImages = toStringArray(result.images);
                                      const isExpanded = expandedComparison === result.id;
                                      const failureDisplay = getFailureDisplay(result);
                                      
                                      return (
                                        <React.Fragment key={result.id}>
                                          <tr className="border-b border-border/50 hover:bg-muted/30">
                                            <td className="py-4 px-4">
                                              <div className="flex items-center gap-2">
                                                <span className="w-2 h-2 rounded-full bg-amber-500" />
                                                <span className="font-medium text-foreground">{result.platform_name}</span>
                                              </div>
                                            </td>
                                            <td className="py-4 px-4 text-center">
                                              {result.match_type === "visual" && result.confidence_score ? (
                                                <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-green-500/10 text-green-600 text-xs font-medium">
                                                  <Shield className="w-3 h-3" />
                                                  {Math.round(result.confidence_score * 100)}%
                                                </span>
                                              ) : (
                                                <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-amber-500/10 text-amber-600 text-xs font-medium">
                                                  <Info className="w-3 h-3" />
                                                  Text
                                                </span>
                                              )}
                                            </td>
                                            <td className="py-4 px-4 text-right">
                                              <div className="flex flex-col items-end gap-0.5">
                                                <span className="text-sm font-medium text-foreground">
                                                  ${result.price?.toLocaleString()}
                                                </span>
                                                <span className="text-xs text-amber-600">{failureDisplay.text}</span>
                                              </div>
                                            </td>
                                            <td className="py-4 px-4 text-center">
                                              <div className="flex flex-col gap-1.5 items-center">
                                                <Button variant="outline" size="sm" asChild>
                                                  <a href={result.listing_url} target="_blank" rel="noopener noreferrer">
                                                    View <ExternalLink className="w-3 h-3 ml-1" />
                                                  </a>
                                                </Button>
                                                <button
                                                  onClick={() => setExpandedComparison(isExpanded ? null : result.id)}
                                                  className={`text-xs px-2 py-1 rounded transition-colors flex items-center gap-1 ${isExpanded ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-primary'}`}
                                                >
                                                  <ArrowLeftRight className="w-3 h-3" />
                                                  {isExpanded ? 'Hide' : 'Photos'}
                                                </button>
                                              </div>
                                            </td>
                                          </tr>
                                          {isExpanded && (
                                            <tr className="border-b border-border/50">
                                              <td colSpan={4} className="p-4 bg-muted/30">
                                                {resultImages.length > 0 || airbnbImages.length > 0 ? (
                                                  <ImageComparison airbnbImages={airbnbImages} alternativeImages={resultImages} airbnbTitle={search?.airbnb_title || "Airbnb Listing"} alternativeTitle={result.listing_title || "Alternative Listing"} platformName={result.platform_name} sourceAirbnbImage={result.source_airbnb_image} />
                                                ) : (
                                                  <div className="text-center py-6 text-muted-foreground">
                                                    <Camera className="w-8 h-8 mx-auto mb-2 opacity-50" />
                                                    <p className="text-sm">No photos available for comparison</p>
                                                  </div>
                                                )}
                                              </td>
                                            </tr>
                                          )}
                                        </React.Fragment>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </div>
                        )}
                        
                        {/* Category 2: Blocked by platform */}
                        {blockedResults.length > 0 && (
                          <div className="rounded-xl border border-red-500/20 bg-red-500/5 overflow-hidden">
                            <button
                              onClick={() => setShowBlockedPlatforms(!showBlockedPlatforms)}
                              className="w-full px-4 py-3 flex items-center justify-between hover:bg-red-500/10 transition-colors"
                            >
                              <div className="flex items-center gap-2">
                                <span className="w-2 h-2 rounded-full bg-red-500" />
                                <Ban className="w-4 h-4 text-red-500" />
                                <span className="text-sm font-medium text-foreground">
                                  {blockedResults.length} platform{blockedResults.length !== 1 ? 's' : ''} blocked access
                                </span>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="text-xs text-muted-foreground">Bot detection or rate limit</span>
                                {showBlockedPlatforms ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
                              </div>
                            </button>
                            
                            {showBlockedPlatforms && (
                              <div className="border-t border-red-500/20">
                                <table className="w-full text-sm">
                                  <tbody>
                                    {blockedResults.map((result) => {
                                      const resultImages = toStringArray(result.images);
                                      const isExpanded = expandedComparison === result.id;
                                      const failureDisplay = getFailureDisplay(result);
                                      
                                      return (
                                        <React.Fragment key={result.id}>
                                          <tr className="border-b border-border/50 hover:bg-muted/30">
                                            <td className="py-4 px-4">
                                              <div className="flex items-center gap-2">
                                                <span className="w-2 h-2 rounded-full bg-red-500" />
                                                <span className="font-medium text-foreground">{result.platform_name}</span>
                                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-500/10 text-red-600 text-[10px] font-medium">
                                                  <Ban className="w-2.5 h-2.5" />
                                                  Blocked
                                                </span>
                                              </div>
                                            </td>
                                            <td className="py-4 px-4 text-center">
                                              {result.match_type === "visual" && result.confidence_score ? (
                                                <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-green-500/10 text-green-600 text-xs font-medium">
                                                  <Shield className="w-3 h-3" />
                                                  {Math.round(result.confidence_score * 100)}%
                                                </span>
                                              ) : (
                                                <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-amber-500/10 text-amber-600 text-xs font-medium">
                                                  <Info className="w-3 h-3" />
                                                  Text
                                                </span>
                                              )}
                                            </td>
                                            <td className="py-4 px-4 text-right text-muted-foreground">
                                              <span className="text-sm text-red-500">{failureDisplay.text}</span>
                                            </td>
                                            <td className="py-4 px-4 text-center">
                                              <div className="flex flex-col gap-1.5 items-center">
                                                <Button variant="outline" size="sm" asChild>
                                                  <a href={result.listing_url} target="_blank" rel="noopener noreferrer">
                                                    View <ExternalLink className="w-3 h-3 ml-1" />
                                                  </a>
                                                </Button>
                                                <button
                                                  onClick={() => setExpandedComparison(isExpanded ? null : result.id)}
                                                  className={`text-xs px-2 py-1 rounded transition-colors flex items-center gap-1 ${isExpanded ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-primary'}`}
                                                >
                                                  <ArrowLeftRight className="w-3 h-3" />
                                                  {isExpanded ? 'Hide' : 'Photos'}
                                                </button>
                                              </div>
                                            </td>
                                          </tr>
                                          {isExpanded && (
                                            <tr className="border-b border-border/50">
                                              <td colSpan={4} className="p-4 bg-muted/30">
                                                {resultImages.length > 0 || airbnbImages.length > 0 ? (
                                                  <ImageComparison airbnbImages={airbnbImages} alternativeImages={resultImages} airbnbTitle={search?.airbnb_title || "Airbnb Listing"} alternativeTitle={result.listing_title || "Alternative Listing"} platformName={result.platform_name} sourceAirbnbImage={result.source_airbnb_image} />
                                                ) : (
                                                  <div className="text-center py-6 text-muted-foreground">
                                                    <Camera className="w-8 h-8 mx-auto mb-2 opacity-50" />
                                                    <p className="text-sm">No photos available for comparison</p>
                                                  </div>
                                                )}
                                              </td>
                                            </tr>
                                          )}
                                        </React.Fragment>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </div>
                        )}
                        
                        {/* Category 3: Extraction failed */}
                        {failedResults.length > 0 && (
                          <div className="rounded-xl border border-border bg-muted/30 overflow-hidden">
                            <button
                              onClick={() => setShowFailedExtractions(!showFailedExtractions)}
                              className="w-full px-4 py-3 flex items-center justify-between hover:bg-muted/50 transition-colors"
                            >
                              <div className="flex items-center gap-2">
                                <span className="w-2 h-2 rounded-full bg-muted-foreground" />
                                <AlertCircle className="w-4 h-4 text-muted-foreground" />
                                <span className="text-sm font-medium text-foreground">
                                  {failedResults.length} extraction{failedResults.length !== 1 ? 's' : ''} failed
                                </span>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="text-xs text-muted-foreground">Page load or price not found</span>
                                {showFailedExtractions ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
                              </div>
                            </button>
                            
                            {showFailedExtractions && (
                              <div className="border-t border-border">
                                <table className="w-full text-sm">
                                  <tbody>
                                    {failedResults.map((result) => {
                                      const resultImages = toStringArray(result.images);
                                      const isExpanded = expandedComparison === result.id;
                                      const failureDisplay = getFailureDisplay(result);
                                      
                                      return (
                                        <React.Fragment key={result.id}>
                                          <tr className="border-b border-border/50 hover:bg-muted/30">
                                            <td className="py-4 px-4">
                                              <div className="flex items-center gap-2">
                                                <span className="w-2 h-2 rounded-full bg-muted-foreground" />
                                                <span className="font-medium text-foreground">{result.platform_name}</span>
                                              </div>
                                            </td>
                                            <td className="py-4 px-4 text-center">
                                              {result.match_type === "visual" && result.confidence_score ? (
                                                <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-green-500/10 text-green-600 text-xs font-medium">
                                                  <Shield className="w-3 h-3" />
                                                  {Math.round(result.confidence_score * 100)}%
                                                </span>
                                              ) : (
                                                <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-amber-500/10 text-amber-600 text-xs font-medium">
                                                  <Info className="w-3 h-3" />
                                                  Text
                                                </span>
                                              )}
                                            </td>
                                            <td className="py-4 px-4 text-right text-muted-foreground">
                                              <span className="text-sm">{failureDisplay.text}</span>
                                            </td>
                                            <td className="py-4 px-4 text-center">
                                              <div className="flex flex-col gap-1.5 items-center">
                                                <Button variant="outline" size="sm" asChild>
                                                  <a href={result.listing_url} target="_blank" rel="noopener noreferrer">
                                                    View <ExternalLink className="w-3 h-3 ml-1" />
                                                  </a>
                                                </Button>
                                                <button
                                                  onClick={() => setExpandedComparison(isExpanded ? null : result.id)}
                                                  className={`text-xs px-2 py-1 rounded transition-colors flex items-center gap-1 ${isExpanded ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-primary'}`}
                                                >
                                                  <ArrowLeftRight className="w-3 h-3" />
                                                  {isExpanded ? 'Hide' : 'Photos'}
                                                </button>
                                              </div>
                                            </td>
                                          </tr>
                                          {isExpanded && (
                                            <tr className="border-b border-border/50">
                                              <td colSpan={4} className="p-4 bg-muted/30">
                                                {resultImages.length > 0 || airbnbImages.length > 0 ? (
                                                  <ImageComparison airbnbImages={airbnbImages} alternativeImages={resultImages} airbnbTitle={search?.airbnb_title || "Airbnb Listing"} alternativeTitle={result.listing_title || "Alternative Listing"} platformName={result.platform_name} sourceAirbnbImage={result.source_airbnb_image} />
                                                ) : (
                                                  <div className="text-center py-6 text-muted-foreground">
                                                    <Camera className="w-8 h-8 mx-auto mb-2 opacity-50" />
                                                    <p className="text-sm">No photos available for comparison</p>
                                                  </div>
                                                )}
                                              </td>
                                            </tr>
                                          )}
                                        </React.Fragment>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </div>
                        )}
                        
                      </div>
                    )}

                    {/* More expensive alternatives are not shown (only cheaper-than-Airbnb results). */}
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

      {/* Modal for confirming Airbnb total during search */}
      <AirbnbTotalConfirmationModal
        open={showConfirmationModal}
        onOpenChange={setShowConfirmationModal}
        searchId={searchId!}
        subtotalAmount={subtotalInfo?.amount ?? search?.airbnb_price ?? null}
        subtotalNights={subtotalInfo?.nights || nights}
        subtotalCurrency={subtotalInfo?.currency || search?.airbnb_currency || 'USD'}
        currentStageId={currentStep >= 0 && currentStep < PIPELINE_STAGES.length ? PIPELINE_STAGES[currentStep].id : null}
        onConfirmed={(amount, currency) => {
          handleTotalConfirmed(amount, currency);
          setShowConfirmationModal(false);
          // Don't restart search - pipeline is already running in background
          // Just refresh the UI state when search completes
        }}
      />
    </div>
  );
}
