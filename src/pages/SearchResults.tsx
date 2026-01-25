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
import { useEnrichedSearchResults, FAILURE_CATEGORY_LABELS, type EnrichedSearchResult } from "@/hooks/useEnrichedSearchResults";
import { PIPELINE_STAGES, getStageIndexFromStatus, isCompletedStatus, isTerminalStatus } from "@/lib/pipelineStages";
import { AirbnbTotalConfirmation } from "@/components/AirbnbTotalConfirmation";
import { AirbnbTotalConfirmationModal } from "@/components/AirbnbTotalConfirmationModal";
import { TerminalErrorPanel } from "@/components/TerminalErrorPanel";
import { ExpediaDebugReveal } from "@/components/ExpediaDebugReveal";
import { ResultBucketSection } from "@/components/search/ResultBucketSection";
import { ResultRow, type ResultRowResult, type RowVariant } from "@/components/search/ResultRow";
import { VerifiedMatchesLoading } from "@/components/search/VerifiedMatchesLoading";
import { SearchPhaseBanner, type SearchPhaseType } from "@/components/search/SearchPhaseBanner";
import { formatUSDPrice, formatPrice } from "@/lib/priceFormatter";
import { isHotelsComBypassUrl, shouldBypassPhotoRejection } from "@/lib/testingExceptions";
import {
  normalizeExtraction,
  type CanonicalPrice,
  type ExtractionInput,
} from "@/lib/canonicalPrice";
import {
  categorizeResult as categorizeResultFn,
  categorizeAllResults,
  BUCKET_DISPLAY,
  NON_COMPARABLE_REASON_LABELS,
  type ResultBucket,
  type CategorizedResult,
  type CategorizationInput,
} from "@/lib/resultCategorization";
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
  AlertTriangle,
  HelpCircle,
  Loader2
} from "lucide-react";
import type { User } from "@supabase/supabase-js";
import type { Json } from "@/integrations/supabase/types";
import type { OutcomeCategory } from "@/lib/extractionOutcomeTaxonomy";
import type { PriceType, CanonicalPrice as CanonicalPriceType } from "@/lib/canonicalPrice";

// ============================================================================
// TWO-PHASE UX: Search Result Phases
// ============================================================================
// Phase 1 (DISCOVERY_PRICING): Image verification complete, prices loading
// Phase 2 (COMPLETE): Finalization complete, final_bucket is authoritative
// ============================================================================

// PRICE_DEPENDENT buckets - only show in Phase 2 (after finalization)
const PRICE_DEPENDENT_BUCKETS: Set<ResultBucket> = new Set([
  'cheaper',
  'more_expensive', 
  'not_comparable',
]);

// MATCH_ONLY buckets - can show in Phase 1 (before finalization)
const MATCH_ONLY_BUCKETS: Set<ResultBucket> = new Set([
  'sold_out',
  'price_not_found',
  'blocked',
  'requires_action',
  'service_error',
  'platform_blocked',
  'additional_issues',
]);

// SearchResult can come from raw DB or enriched - make enrichment fields optional
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
  // Tier enrichment (optional - from enrichment)
  coverage_tier?: 'A' | 'B' | 'C' | null;
  is_tier_c_blocked?: boolean;
  failure_category?: string | null;
  failure_reason?: string | null;
  // Extraction info
  extraction_status?: string | null;
  extraction_error?: string | null;
  // Outcome taxonomy
  outcome_category?: OutcomeCategory | null;
  outcome_label?: string | null;
  // Price verification metadata
  price_status?: 'verified' | 'unverified' | 'unavailable';
  price_source?: 'extracted' | 'scraped' | 'none';
  price_verified_at?: string | null;
  eligible_for_comparison?: boolean;
  verification_failures?: string[];
  // Canonical price model
  canonical_price?: CanonicalPriceType | null;
  price_type?: PriceType;
  price_type_label?: string;
  is_total_price?: boolean;
  // Result categorization bucket (from snapshot)
  result_bucket?: ResultBucket | null;
  final_bucket?: ResultBucket | null;  // New snapshot field name
  final_bucket_label?: string | null;
  categorization?: CategorizedResult | null;
  // TWO-PASS IMAGE VERIFICATION: Authority status
  // is_authoritative = true means PASS 2 >= 90% (high trust, "Verified")
  // is_authoritative = false means PASS 1 passed but needs review
  is_authoritative?: boolean;
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
//
// CRITICAL: 'rate_limited' from SerpAPI (alternative discovery) should NOT be terminal
// if Airbnb extraction succeeded. Only treat rate_limited as terminal when we have
// no Airbnb price.
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
  
  // CRITICAL: 'rate_limited' from SerpAPI should NOT be terminal if Airbnb price was extracted.
  // SerpAPI rate limiting only affects alternative discovery, not the Airbnb baseline.
  // If we have a valid Airbnb price, the search can still complete successfully.
  if (rawCode === 'rate_limited' && s.airbnb_price && s.airbnb_price > 0) {
    // Don't treat as terminal - search completed with Airbnb price even if alternatives failed
    return null;
  }
  
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
    // Expedia-specific terminal states (v6.3 target card anchoring)
    'expedia_access_blocked': 'expedia_access_blocked',
    'expedia_target_offer_not_found': 'expedia_target_offer_not_found',
    'expedia_target_offer_mismatch': 'expedia_target_offer_mismatch',
    'expedia_dates_unavailable_for_target': 'expedia_dates_unavailable_for_target',
    'expedia_target_total_not_found': 'expedia_target_total_not_found',
    'expedia_total_not_found': 'expedia_total_not_found',
    'expedia_offers_page_not_reached': 'expedia_offers_page_not_reached',
    'expedia_total_not_found_on_offers_page': 'expedia_total_not_found_on_offers_page',
    'property_id_not_found': 'property_id_not_found',
    'offers_page_not_loaded': 'offers_page_not_loaded',
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

function TestingPublicSearchResultsView({
  searchId,
  search,
  results,
  loading,
  onBack,
}: {
  searchId: string | undefined;
  search: SearchData | null;
  results: SearchResult[];
  loading: boolean;
  onBack: () => void;
}) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card">
        <div className="mx-auto max-w-5xl px-6 py-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h1 className="text-xl font-semibold">Search results (testing view)</h1>
              <p className="mt-1 text-sm text-muted-foreground break-all">Search ID: {searchId}</p>
            </div>
            <Button variant="secondary" onClick={onBack}>Back</Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8">
        {loading ? (
          <div className="rounded-xl border border-border bg-card p-6">
            <p className="text-sm text-muted-foreground">Loading snapshot…</p>
          </div>
        ) : (
          <div className="space-y-6">
            <section className="rounded-xl border border-border bg-card p-6">
              <h2 className="text-base font-medium">Airbnb</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {search?.airbnb_title || "(title unavailable)"}
              </p>
              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="rounded-lg border border-border bg-background p-3">
                  <div className="text-xs text-muted-foreground">Status</div>
                  <div className="mt-1 text-sm font-medium">{search?.status || "unknown"}</div>
                </div>
                <div className="rounded-lg border border-border bg-background p-3">
                  <div className="text-xs text-muted-foreground">Total</div>
                  <div className="mt-1 text-sm font-medium">
                    {search?.airbnb_price != null
                      ? formatPrice(search.airbnb_price, search?.airbnb_currency || "USD")
                      : "—"}
                  </div>
                </div>
                <div className="rounded-lg border border-border bg-background p-3">
                  <div className="text-xs text-muted-foreground">Results in snapshot</div>
                  <div className="mt-1 text-sm font-medium">{results.length}</div>
                </div>
              </div>
            </section>

            <section className="rounded-xl border border-border bg-card">
              <div className="border-b border-border px-6 py-4">
                <h2 className="text-base font-medium">Platforms</h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="text-left text-xs text-muted-foreground">
                    <tr className="border-b border-border">
                      <th className="px-6 py-3 font-medium">Platform</th>
                      <th className="px-6 py-3 font-medium">Bucket</th>
                      <th className="px-6 py-3 font-medium">Price</th>
                    </tr>
                  </thead>
                  <tbody className="text-sm">
                    {results.map((r) => (
                      <tr key={r.id} className="border-b border-border/50 last:border-0">
                        <td className="px-6 py-4">{r.platform_name}</td>
                        <td className="px-6 py-4 text-muted-foreground">
                          {(r as any).final_bucket_label || (r as any).final_bucket || "—"}
                        </td>
                        <td className="px-6 py-4">
                          {(r as any).extracted_price != null
                            ? formatPrice((r as any).extracted_price, (r as any).currency || search?.airbnb_currency || "USD")
                            : r.price != null
                              ? formatPrice(r.price, (r as any).currency || search?.airbnb_currency || "USD")
                              : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

export default function SearchResults() {
  const { searchId } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { fetchEnrichedResults } = useEnrichedSearchResults();

  // TESTING-ONLY: allow a locked-down public render path in preview so we can
  // capture evidence screenshots without requiring the original user session.
  const isTestingPublicView = (() => {
    try {
      const host = window.location.hostname;
      return (
        (host.includes("lovableproject.com") || host.startsWith("id-preview--")) &&
        searchId === "ad29e42c-1e5c-4190-b446-6b104fc795b1"
      );
    } catch {
      return false;
    }
  })();
  
  const [user, setUser] = useState<User | null>(null);
  const [search, setSearch] = useState<SearchData | null>(null);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [priceExtractions, setPriceExtractions] = useState<PriceExtraction[]>([]);
  const [loading, setLoading] = useState(true);
  const [terminalHydrating, setTerminalHydrating] = useState(false);
  const [hydrationRetryCount, setHydrationRetryCount] = useState(0);
  const [hydrationError, setHydrationError] = useState<string | null>(null);
  
  // Finalization gate progress tracking
  const [finalizationProgress, setFinalizationProgress] = useState<{ terminal: number; total: number } | null>(null);
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
  const [showSoldOutPlatforms, setShowSoldOutPlatforms] = useState(false);
  const [showAdditionalIssues, setShowAdditionalIssues] = useState(false);
  const [showLowTrustScore, setShowLowTrustScore] = useState(false);
  const [lowTrustScoreResults, setLowTrustScoreResults] = useState<Array<{
    id: string;
    platform_name: string;
    listing_url: string;
    listing_title: string | null;
    images: Json;
    source_airbnb_image: string | null;
    confidence_score: number | null;
  }>>([]);
  // TESTING: Bypassed results that failed photo comparison but are allowed via testing exception
  const [bypassedResults, setBypassedResults] = useState<Array<{
    id: string;
    platform_name: string;
    listing_url: string;
    listing_title: string | null;
    images: Json;
    source_airbnb_image: string | null;
    confidence_score: number | null;
    bypassed_reason: string;
  }>>([]);

  // TESTING: Hotels.com bypass extraction status (only for the specific Airbnb URL exception)
  const [hotelsComBypassExtraction, setHotelsComBypassExtraction] = useState<{
    status: 'idle' | 'triggering' | 'running' | 'done' | 'error';
    extractionId?: string;
    extractedPrice?: number | null;
    currency?: string | null;
    extractionStatus?: string | null;
    error?: string;
  }>({ status: 'idle' });

  const hotelsComBypassTriggeredRef = useRef(false);
  const [streamDisconnected, setStreamDisconnected] = useState(false);
  const [extractingPrices, setExtractingPrices] = useState(false);
  const [priceExtractionPlatforms, setPriceExtractionPlatforms] = useState<PlatformExtractionStatus[]>([]);
  const [priceExtractionTotal, setPriceExtractionTotal] = useState(0);
  const [priceExtractionCompleted, setPriceExtractionCompleted] = useState(0);
  
  // Track if search is finalized (finalised_at is set in DB)
  const [isFinalized, setIsFinalized] = useState(false);
  
  // TWO-PHASE UX: Track verified matches found during discovery (before pricing)
  const [verifiedMatchesPending, setVerifiedMatchesPending] = useState<Array<{
    id: string;
    platform_name: string;
    listing_url: string;
    listing_title: string | null;
    confidence_score: number | null;
    images: Json;
    match_type?: string;
    source_airbnb_image?: string | null;
  }>>([]);
  // Track whether we're in Phase 1 (discovery complete, pricing running) or Phase 2 (complete)
  const [resultsPhase, setResultsPhase] = useState<SearchPhaseType>("discovery_pricing");
  
  const withTimeout = async <T,>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
    let timeoutId: number | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = window.setTimeout(() => reject(new Error(`timeout:${label}`)), ms);
    });
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeoutId) window.clearTimeout(timeoutId);
    }
  };

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
  const activityFeedRef = useRef<Array<{ ts: number; message: string; detail?: string; id: string }>>([]); // Ref for persistence

  // TERMINAL STATE FREEZE: Once search reaches a terminal status, results are frozen
  // No more polling, no more live mutations. This ensures deterministic display.
  const isTerminalFrozenRef = useRef(false); // Ref for synchronous checks in callbacks
  const [isTerminalFrozen, setIsTerminalFrozen] = useState(false);

  // Late-async guard: only the latest request is allowed to commit state
  const latestRequestTokenRef = useRef(0);
  const nextRequestToken = () => {
    latestRequestTokenRef.current += 1;
    return latestRequestTokenRef.current;
  };
  /**
   * Commit a state update only if the request token is still fresh.
   * The skipFreezeCheck flag allows terminal hydration to commit even after freeze is set.
   */
  const commitIfFresh = (token: number, commit: () => void, skipFreezeCheck = false) => {
    if (!skipFreezeCheck && isTerminalFrozenRef.current) return;
    if (latestRequestTokenRef.current !== token) return;
    commit();
  };

  // Helper function to add activity items
  const addActivityItem = (message: string, detail?: string) => {
    activityIdCounterRef.current += 1;
    const newItem = {
      ts: Date.now(),
      message,
      detail,
      id: `activity-${activityIdCounterRef.current}`,
    };
    setActivityFeed((prev) => {
      const updated = [...prev, newItem];
      activityFeedRef.current = updated;
      return updated;
    });
  };
  useEffect(() => {
    // TESTING-ONLY: In the preview public screenshot mode, we intentionally ignore
    // any existing (often anonymous) auth session because it will not own the
    // target search and will cause RLS fetches to fail/redirect.
    if (isTestingPublicView) {
      setUser(null);
      return;
    }

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      setUser(session?.user ?? null);
      if (!session?.user && !isTestingPublicView) navigate("/auth");
    });

    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      if (!session?.user && !isTestingPublicView) navigate("/auth");
    });

    return () => subscription.unsubscribe();
  }, [navigate, isTestingPublicView]);

  // TESTING-ONLY: Fetch snapshot via restricted backend function (no auth needed).
  useEffect(() => {
    if (!isTestingPublicView || !searchId) return;
    // In testing public view, always prefer the backend snapshot fetch.

    let cancelled = false;
    const run = async () => {
      setLoading(true);
      try {
        const { data, error } = await supabase.functions.invoke("testing-public-search-results", {
          body: { searchId },
        });
        if (error) throw error;
        if (!data?.success) throw new Error(data?.error || "Unable to load testing view");

        const searchRow = data.search as any;
        const snapshot = data.snapshot as any;
        const snapshotResults = Array.isArray(snapshot?.results) ? snapshot.results : [];

        if (cancelled) return;

        setSearch(searchRow);
        setResults(snapshotResults);
        setIsFinalized(Boolean(searchRow?.finalised_at));
        setResultsPhase("complete");
      } catch (e: any) {
        if (!cancelled) {
          console.error("[testing-public-view] failed", e);
          toast({
            title: "Unable to load testing view",
            description: e?.message || "Unknown error",
            variant: "destructive",
          });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [isTestingPublicView, searchId, user, toast]);

  // Fetch search data and trigger search
  useEffect(() => {
    // TESTING-ONLY: Never run the authenticated pipeline flow in the preview public view.
    if (isTestingPublicView) return;
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
      // TERMINAL FREEZE: dates_unavailable is terminal
      if (resolvedErrorCode === 'dates_unavailable') {
        console.log('[TerminalFreeze] dates_unavailable on load, freezing');
        isTerminalFrozenRef.current = true;
        setIsTerminalFrozen(true);
        setSearchPhase("done");
        setLoading(false);
        setShowConfirmationModal(false);
        return;
      }

      // If the search has already failed, show the error state immediately.
      // TERMINAL FREEZE: error is terminal
      if (searchRecord.status === 'error') {
        console.log('[TerminalFreeze] error status on load, freezing');
        isTerminalFrozenRef.current = true;
        setIsTerminalFrozen(true);
        setSearchPhase("done");
        setLoading(false);
        return;
      }

      // HANDLE finalization_failed - search completed but snapshot persistence failed
      // Show error state with option to retry
      if (searchRecord.status === 'finalization_failed') {
        console.log('[TerminalFreeze] finalization_failed on load, showing error');
        isTerminalFrozenRef.current = true;
        setIsTerminalFrozen(true);
        setSearchPhase("done");
        setLoading(false);
        setHydrationError(`Finalization failed: ${searchRecord.api_error || 'Unknown error'}. Please try refreshing.`);
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

      // NEW GATE: Only hydrate results if finalised_at exists
      // For terminal statuses that should have a snapshot (completed), verify finalised_at
      // If status is 'completed' but no finalised_at, redirect to dashboard (shouldn't happen with new invariant)

      // If search is already terminal, do a deterministic single-shot hydration.
      // IMPORTANT: Do NOT render any intermediate snapshot that could later flip buckets.
      if (isTerminalStatus(searchRecord.status)) {
        console.log('[TerminalFreeze] Terminal status on load, single-shot hydrating:', searchRecord.status);

        const token = nextRequestToken();

        // Freeze immediately to prevent ANY later merges/polls from committing.
        isTerminalFrozenRef.current = true;
        setIsTerminalFrozen(true);
        setIsFinalized(true);

        // Show a lightweight loading state while we fetch the authoritative joined dataset.
        setTerminalHydrating(true);
        setSearchPhase('done');
        setExtractingPrices(false);
        setResults([]);
        setPriceExtractions([]);
        setHydrationError(null);

        // BOUNDED RETRY: Fetch with retries and timeout
        const MAX_RETRIES = 5;
        const INITIAL_BACKOFF_MS = 1000;
        const TOTAL_TIMEOUT_MS = 30000;
        const startTime = Date.now();
        let attempt = 0;
        let backoffMs = INITIAL_BACKOFF_MS;
        let success = false;

        while (attempt < MAX_RETRIES && !success) {
          if (Date.now() - startTime > TOTAL_TIMEOUT_MS) {
            console.error('[TerminalHydration] Total timeout exceeded');
            break;
          }
          
          attempt++;
          setHydrationRetryCount(attempt);
          
          try {
            console.log(`[TerminalHydration] Attempt ${attempt}/${MAX_RETRIES}`);
            
            // Fetch finalised_at and final_results_snapshot from DB
            // Backend is responsible for setting these - frontend only reads
            const { data: snapshotData, error: snapshotError } = await supabase
              .from('searches')
              .select('finalised_at, final_results_snapshot')
              .eq('id', searchId)
              .single();
            
            if (snapshotError) {
              throw new Error(`Failed to fetch snapshot: ${snapshotError.message}`);
            }
            
            const finalisedAt = (snapshotData as any)?.finalised_at;
            const snapshot = (snapshotData as any)?.final_results_snapshot;
            
            // If not yet finalized by backend, wait and retry
            if (!finalisedAt) {
              console.log('[TerminalHydration] Search not yet finalized by backend, waiting...');
              throw new Error('Search not yet finalized');
            }
            
            // If we have a snapshot, use it directly (deterministic)
            if (snapshot && snapshot.results) {
              console.log(`[TerminalHydration] Using persisted snapshot with ${snapshot.results.length} results`);
              commitIfFresh(token, () => {
                setSearch(searchRecord);
                setResults(snapshot.results as unknown as SearchResult[]);
                setIsFinalized(true);
                setTerminalHydrating(false);
                setLoading(false);
                setHydrationError(null);
              }, true); // skipFreezeCheck: allow commit during terminal hydration
              success = true;
            } else {
              // Fallback: snapshot exists but no results - fetch enriched results
              console.log('[TerminalHydration] Finalized but no snapshot - falling back to enriched fetch');
              const enrichedResults = await withTimeout(
                fetchEnrichedResults(searchId), 
                12_000, 
                'fetchEnrichedResults:terminal_hydrate'
              );
              
              commitIfFresh(token, () => {
                setSearch(searchRecord);
                setResults(enrichedResults as unknown as SearchResult[]);
                setIsFinalized(true);
                setTerminalHydrating(false);
                setLoading(false);
                setHydrationError(null);
              }, true); // skipFreezeCheck: allow commit during terminal hydration
              success = true;
            }
          } catch (e) {
            console.error(`[TerminalHydration] Attempt ${attempt} failed:`, e);
            
            if (attempt >= MAX_RETRIES) {
              const errorMsg = e instanceof Error ? e.message : 'Unknown error';
              setHydrationError(`Failed to load results: ${errorMsg}`);
              setTerminalHydrating(false);
              setLoading(false);
              setSearch(searchRecord);
            } else {
              // Wait with backoff before next attempt
              await new Promise(resolve => setTimeout(resolve, backoffMs));
              backoffMs = Math.min(backoffMs * 1.5, 8000);
            }
          }
        }

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
          activityFeedRef.current = []; // Reset ref too
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

                      // Add to activity feed (append-only; do not dedupe)
                      activityIdCounterRef.current += 1;
                      const newItem = {
                        ts: data.timestamp || Date.now(),
                        message: data.step,
                        detail: data.detail,
                        id: `activity-${activityIdCounterRef.current}`,
                      };
                      setActivityFeed((prev) => {
                        const updated = [...prev, newItem];
                        activityFeedRef.current = updated; // Keep ref in sync for persistence
                        return updated;
                      });
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
                      // Starting price extraction phase - this is Phase 1 of two-phase UX
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
                      
                      // TWO-PHASE UX: Fetch verified matches to show in Phase 1 UI
                      // These are candidates that passed image verification
                      try {
                        const { data: platformsData } = await supabase
                          .from('search_platforms')
                          .select('id, platform_name, listing_url, listing_title, confidence_score, images, match_type, source_airbnb_image')
                          .eq('search_id', searchId)
                          .gte('confidence_score', 75);
                        
                        if (platformsData && platformsData.length > 0) {
                          setVerifiedMatchesPending(platformsData);
                          // Also set results for Phase 1 display
                          setResults(platformsData.map(p => ({
                            ...p,
                            price: null,
                            original_price: null,
                            savings_amount: null,
                            savings_percentage: null,
                            image_url: null,
                            price_check_in: null,
                            price_check_out: null,
                            dates_differ: false,
                          })) as unknown as SearchResult[]);
                        }
                      } catch (e) {
                        console.error('[Phase1] Failed to fetch verified matches:', e);
                      }
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
                      // TERMINAL FREEZE: SSE complete means search is done
                      console.log('[TerminalFreeze] SSE complete event received, freezing');
                      isTerminalFrozenRef.current = true;
                      setIsTerminalFrozen(true);
                      
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

                      // Refresh search from DB to get finalized data
                      const { data: updatedSearch } = await supabase
                        .from("searches")
                        .select("*")
                        .eq("id", searchId)
                        .single();

                      // Persist activity log for admin diagnostics (use ref for current value)
                      const currentFeed = activityFeedRef.current.map(item => ({
                        ts: item.ts,
                        message: item.message,
                        detail: item.detail,
                      }));
                      if (currentFeed.length > 0) {
                        console.log('[ActivityLog] Persisting', currentFeed.length, 'events to search', searchId);
                        await supabase
                          .from("searches")
                          .update({ activity_log: currentFeed })
                          .eq("id", searchId);
                      }

                      addActivityItem("Finalizing results", "Loading final snapshot...");
                      
                      // FETCH THE SNAPSHOT - not enriched results
                      // Backend should have set finalised_at and final_results_snapshot atomically
                      const { data: snapshotData } = await supabase
                        .from('searches')
                        .select('finalised_at, final_results_snapshot')
                        .eq('id', searchId)
                        .single();
                      
                      const finalisedAt = (snapshotData as any)?.finalised_at;
                      const snapshot = (snapshotData as any)?.final_results_snapshot;
                      
                      if (finalisedAt && snapshot && snapshot.results) {
                        console.log(`[SSEComplete] Using persisted snapshot with ${snapshot.results.length} results`);
                        addActivityItem("Search complete", `Found ${snapshot.results.length} alternatives`);
                        setSearch(updatedSearch as SearchData);
                        setResults(snapshot.results as unknown as SearchResult[]);
                        setIsFinalized(true);
                      } else {
                        // Fallback: snapshot not found, use enriched results
                        console.warn('[SSEComplete] No snapshot found, falling back to enriched results');
                        addActivityItem("Computing savings", "Analyzing alternatives...");
                        const enrichedResults = await withTimeout(fetchEnrichedResults(searchId), 12_000, 'fetchEnrichedResults:complete');
                        setSearch(updatedSearch as SearchData);
                        setResults(enrichedResults as unknown as SearchResult[]);
                      }
                      
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
              
              // TERMINAL FREEZE: Stream ended and status is terminal
              console.log('[TerminalFreeze] Stream ended with terminal status:', updatedSearch?.status);
              isTerminalFrozenRef.current = true;
              setIsTerminalFrozen(true);

               // Persist activity log for admin diagnostics (stream ended path, use ref)
               const currentFeed = activityFeedRef.current.map(item => ({
                 ts: item.ts,
                 message: item.message,
                 detail: item.detail,
               }));
               if (currentFeed.length > 0) {
                 console.log('[ActivityLog] Persisting (stream ended)', currentFeed.length, 'events to search', searchId);
                 await supabase
                   .from("searches")
                   .update({ activity_log: currentFeed })
                   .eq("id", searchId);
               }

               // Add finalization activity logs
               addActivityItem("Finalizing results", "Loading final snapshot...");
               
               try {
                 // CRITICAL: Use snapshot for deterministic results (preserves final_bucket)
                 // fetchEnrichedResults() does NOT include final_bucket from snapshot
                 const { data: snapshotData } = await supabase
                   .from('searches')
                   .select('finalised_at, final_results_snapshot')
                   .eq('id', searchId)
                   .single();
                 
                 const snapshot = (snapshotData as any)?.final_results_snapshot;
                 
                 if (snapshot && snapshot.results) {
                   console.log(`[StreamEndedTerminal] Using persisted snapshot with ${snapshot.results.length} results`);
                   addActivityItem("Search complete", `Found ${snapshot.results.length} alternatives`);
                   setResults(snapshot.results as unknown as SearchResult[]);
                   setIsFinalized(true);
                 } else {
                   // Fallback: no snapshot, use enriched results (legacy)
                   console.warn('[StreamEndedTerminal] No snapshot found, falling back to enriched results');
                   const enrichedResults = await withTimeout(fetchEnrichedResults(searchId), 12_000, 'fetchEnrichedResults:streamEnded');
                   const totalMatches = (enrichedResults as any[]).length;
                   addActivityItem("Computing savings", `Analyzing ${totalMatches} alternatives`);
                   setResults(enrichedResults as unknown as SearchResult[]);
                 }
               } catch (e) {
                 console.error("Failed to fetch results (stream ended):", e);
                 toast({
                   title: "Showing partial results",
                   description: "We couldn't load all comparison details, but your search finished successfully.",
                 });
                 setResults([]);
               }

              // Close any open modals since search is complete
              setShowConfirmationModal(false);
              setSubtotalInfo(null);

              setSearch(updatedSearch as SearchData);
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
  // TERMINAL FREEZE: Stop polling once results are frozen
  useEffect(() => {
    if (!loading || searchPhase !== "thinking" || !searchId) return;
    
    // Don't start heartbeat if already frozen
    if (isTerminalFrozenRef.current) return;

    const pollHeartbeat = async () => {
      // Check freeze before polling
      if (isTerminalFrozenRef.current) return;
      
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
        // TERMINAL FREEZE: error is terminal
        if (data.status === "error") {
          console.log('[TerminalFreeze] error detected via heartbeat, freezing');
          isTerminalFrozenRef.current = true;
          setIsTerminalFrozen(true);
          
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
        // TERMINAL FREEZE: cancelled is terminal
        if (data.status === "cancelled") {
          console.log('[TerminalFreeze] cancelled detected via heartbeat, freezing');
          isTerminalFrozenRef.current = true;
          setIsTerminalFrozen(true);
          
          toast({
            title: "Search Cancelled",
            description: "This search was cancelled.",
          });
          navigate("/dashboard");
          return;
        }

        // If search is done, update state
        // TERMINAL FREEZE: completed/price_unavailable/dates_required are terminal
        if (["completed", "price_unavailable", "dates_required"].includes(data.status)) {
          console.log('[TerminalFreeze] terminal status detected via heartbeat:', data.status);
          isTerminalFrozenRef.current = true;
          setIsTerminalFrozen(true);
          
          // Add finalization activity logs
          addActivityItem("Finalizing results", "Loading final snapshot...");
          
          try {
            // CRITICAL: Use snapshot for deterministic results (preserves final_bucket)
            // fetchEnrichedResults() does NOT include final_bucket from snapshot
            const { data: snapshotData } = await supabase
              .from('searches')
              .select('finalised_at, final_results_snapshot')
              .eq('id', searchId)
              .single();
            
            const snapshot = (snapshotData as any)?.final_results_snapshot;
            
            if (snapshot && snapshot.results) {
              console.log(`[HeartbeatTerminal] Using persisted snapshot with ${snapshot.results.length} results`);
              addActivityItem("Search complete", `Found ${snapshot.results.length} alternatives`);
              setResults(snapshot.results as unknown as SearchResult[]);
              setIsFinalized(true);
            } else {
              // Fallback: no snapshot, use enriched results (legacy)
              console.warn('[HeartbeatTerminal] No snapshot found, falling back to enriched results');
              const enrichedResults = await withTimeout(fetchEnrichedResults(searchId), 12_000, 'fetchEnrichedResults:heartbeat');
              const totalMatches = (enrichedResults as any[]).length;
              addActivityItem("Computing savings", `Analyzing ${totalMatches} alternatives`);
              setResults(enrichedResults as unknown as SearchResult[]);
            }
          } catch (e) {
            console.error("Failed to fetch results (heartbeat):", e);
            toast({
              title: "Showing partial results",
              description: "We couldn't load all comparison details, but your search finished successfully.",
            });
            setResults([]);
          }

          // CRITICAL: Update search state with latest data before transitioning
          // This ensures the UI sees the correct status and closes any modals
          setSearch(data as SearchData);

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
  }, [loading, searchPhase, searchId, fetchEnrichedResults, navigate, toast]);

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
    activityIdCounterRef.current += 1;
    const newItem = {
      ts: Date.now(),
      message: activity.message,
      detail: activity.detail,
      id: `activity-${activityIdCounterRef.current}`,
    };
    setActivityFeed((prev) => {
      const updated = [...prev, newItem];
      activityFeedRef.current = updated; // Keep ref in sync for persistence
      return updated;
    });
  }, [loading, search?.status]);

  // Track when results page is actually rendered (after DOM update)
  const [resultsPageRendered, setResultsPageRendered] = useState(false);
  // Once we show the results view, never return to the pipeline view for this run.
  // This prevents confetti from triggering on results and then the UI snapping back
  // to "Finding Better Deals" while background price polling continues.
  const [resultsViewUnlocked, setResultsViewUnlocked] = useState(false);

  // Reset view-unlock and terminal freeze when the searchId changes (new run)
  useEffect(() => {
    setResultsViewUnlocked(false);
    setResultsPageRendered(false);
    setHasCelebrated(false);
    setTerminalHydrating(false);
    // Reset terminal freeze for new search
    isTerminalFrozenRef.current = false;
    setIsTerminalFrozen(false);
    // Reset late-async guard
    latestRequestTokenRef.current = 0;
  }, [searchId]);

  // TERMINAL STATE FREEZE: Freeze results once search reaches terminal status
  // This ensures deterministic display regardless of late polling or background updates
  useEffect(() => {
    if (!search?.status) return;
    
    if (isTerminalStatus(search.status) && !isTerminalFrozenRef.current) {
      console.log('[TerminalFreeze] Freezing results, status:', search.status);
      isTerminalFrozenRef.current = true;
      setIsTerminalFrozen(true);
      
      // Stop any remaining polling intervals
      if (heartbeatIntervalRef.current) {
        window.clearInterval(heartbeatIntervalRef.current);
        heartbeatIntervalRef.current = null;
      }
    }
  }, [search?.status]);

  // Detect when results page becomes visible (pipeline hidden)
  useEffect(() => {
    const pipelineHidden = !loading && !extractingPrices;

    // Unlock results view as soon as we have anything to render.
    // From this point on, we keep showing results even if extractingPrices flips true later.
    if (!resultsViewUnlocked && pipelineHidden && searchPhase === "done" && results.length > 0) {
      setResultsViewUnlocked(true);
    }

    if (pipelineHidden && searchPhase === "done" && results.length > 0) {
      // Delay to ensure the DOM has updated and pipeline is truly hidden
      const timer = window.setTimeout(() => setResultsPageRendered(true), 150);
      return () => window.clearTimeout(timer);
    }

    setResultsPageRendered(false);
  }, [loading, extractingPrices, searchPhase, results.length, resultsViewUnlocked]);
  
  // Add "Search complete" activity and confetti ONLY when results page is actually rendered
  useEffect(() => {
    if (resultsPageRendered && !hasCelebrated) {
      // Count verified results
      const verifiedCount = results.filter((r: any) => r.priceVerificationStatus === 'verified').length;
      addActivityItem("Search complete", `Found ${results.length} alternatives (${verifiedCount} with verified prices)`);
      
      setHasCelebrated(true);
      // Small delay for confetti after results page is confirmed visible
      setTimeout(() => quickCelebration(), 300);
    }
  }, [resultsPageRendered, hasCelebrated, results]);

  // Poll for price extraction status - runs when extractingPrices is true OR after search completes
  // IMPORTANT: Once terminal freeze is active, stop polling and don't mutate results
  useEffect(() => {
    if (!searchId) return;

    // TERMINAL FREEZE: Stop polling once results are frozen
    if (isTerminalFrozenRef.current) {
      return;
    }

    if (loading && !extractingPrices) return;

    const token = nextRequestToken();

    const fetchExtractionStatus = async () => {
      if (isTerminalFrozenRef.current) return;

      const { data } = await supabase
        .from('price_extractions')
        .select('id, search_result_id, platform_name, extraction_status, extracted_price, extraction_error, deep_link')
        .eq('search_id', searchId);

      // Late async guard: ignore if we froze or a newer request started.
      if (isTerminalFrozenRef.current) return;
      if (latestRequestTokenRef.current !== token) return;

      if (data) {
        setPriceExtractions(data as PriceExtraction[]);

        const inProgress = data.some(e => e.extraction_status === 'pending' || e.extraction_status === 'running');
        setExtractingPrices(inProgress);

        // IMPORTANT: incremental merges are ONLY allowed pre-terminal.
        // Once terminal, we never touch results again.
        if (data.length > 0) {
          setResults(prev => {
            if (isTerminalFrozenRef.current) return prev;
            return prev.map(r => {
              const extraction = data.find(e => e.search_result_id === r.id);
              if (extraction?.extracted_price && extraction.extracted_price > 0) {
                const isExpedia = r.platform_name.toLowerCase().includes('expedia');
                const shouldUpdate = isExpedia || !r.price || r.price < 10 || (extraction.extracted_price !== r.price && extraction.extraction_status === 'success');
                if (shouldUpdate) return { ...r, price: extraction.extracted_price };
              }
              return r;
            });
          });
        }
      }
    };

    if (!isTerminalFrozenRef.current) {
      fetchExtractionStatus();
    }

    const pollInterval = window.setInterval(() => {
      if (extractingPrices && !isTerminalFrozenRef.current) {
        fetchExtractionStatus();
      }
    }, 3000);

    return () => window.clearInterval(pollInterval);
  }, [loading, searchId, extractingPrices, isTerminalFrozen]);

  // Poll finalization progress during terminal hydration
  useEffect(() => {
    if (!searchId || !terminalHydrating) {
      setFinalizationProgress(null);
      return;
    }

    let cancelled = false;
    
    const TERMINAL_STATUSES = ['success', 'failed', 'timeout', 'render_failed', 'dates_unavailable', 'sold_out', 'blocked', 'error', 'captcha', 'bot_detected', 'rate_limited'];

    const fetchProgress = async () => {
      try {
        // Get total platforms from search_platforms
        const { data: platforms, error: platformError } = await supabase
          .from('search_platforms')
          .select('id, extraction_status_terminal')
          .eq('search_id', searchId);

        if (platformError || !platforms) return;

        const total = platforms.length;
        const terminal = platforms.filter(p => 
          p.extraction_status_terminal && TERMINAL_STATUSES.includes(p.extraction_status_terminal)
        ).length;

        if (!cancelled) {
          setFinalizationProgress({ terminal, total });
        }
      } catch (e) {
        console.error('[FinalizationProgress] Error fetching progress:', e);
      }
    };

    fetchProgress();
    const interval = setInterval(fetchProgress, 2000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [searchId, terminalHydrating]);
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

  // Fetch rejected platforms (low trust score) for testing display
  // Also check for testing exceptions that bypass photo comparison rejection
  useEffect(() => {
    if (!searchId || !isTerminalFrozen) return;

    const fetchRejectedPlatforms = async () => {
      const { data, error } = await supabase
        .from('search_platforms')
        .select('id, platform_name, listing_url, listing_title, images, source_airbnb_image, confidence_score')
        .eq('search_id', searchId)
        .eq('outcome_category', 'rejected')
        .order('confidence_score', { ascending: false, nullsFirst: false });

      if (error) {
        console.error('[LowTrustScore] Error fetching rejected platforms:', error);
        return;
      }

      if (data) {
        // Check for testing exceptions - bypass photo comparison for specific URLs
        const airbnbUrl = search?.airbnb_url;
        const bypassed: typeof bypassedResults = [];
        const remaining: typeof data = [];

        for (const result of data) {
          if (shouldBypassPhotoRejection(airbnbUrl, result.platform_name)) {
            console.log(`[TestingException] Bypassing photo rejection for ${result.platform_name} on URL: ${airbnbUrl}`);
            bypassed.push({
              ...result,
              bypassed_reason: 'Testing exception: Hotels.com photo comparison bypass'
            });
          } else {
            remaining.push(result);
          }
        }

        setLowTrustScoreResults(remaining);
        setBypassedResults(bypassed);

        // If we have bypassed results, add them to verified matches for price extraction
        if (bypassed.length > 0) {
          console.log(`[TestingException] ${bypassed.length} result(s) bypassed and promoted to valid matches`);
        }
      }
    };

    fetchRejectedPlatforms();
  }, [searchId, isTerminalFrozen, search?.airbnb_url]);

  // TESTING: For the Hotels.com bypass case, trigger a backend extraction so we can validate the extractor.
  useEffect(() => {
    if (!searchId || !isTerminalFrozen) return;
    if (!search?.airbnb_url) return;
    if (!isHotelsComBypassUrl(search.airbnb_url)) return;

    const hasHotelsComBypass = bypassedResults.some((r) => {
      const n = r.platform_name.toLowerCase().replace(/[^a-z]/g, '');
      return n === 'hotelscom' || n === 'hotels';
    });

    if (!hasHotelsComBypass) return;
    if (hotelsComBypassTriggeredRef.current) return;

    hotelsComBypassTriggeredRef.current = true;
    setHotelsComBypassExtraction({ status: 'triggering' });

    let cancelled = false;
    let pollId: number | null = null;

    const trigger = async () => {
      try {
        const { data, error } = await supabase.functions.invoke('testing-hotelscom-bypass', {
          body: { searchId },
        });

        if (cancelled) return;

        if (error || !data?.success) {
          setHotelsComBypassExtraction({
            status: 'error',
            error: error?.message || data?.error || 'Failed to trigger Hotels.com extraction',
          });
          return;
        }

        const extractionId = data.extractionId as string | undefined;
        setHotelsComBypassExtraction({ status: 'running', extractionId });

        // Poll until we see a terminal extraction for Hotels.com
        const startedAt = Date.now();
        pollId = window.setInterval(async () => {
          if (cancelled) return;
          if (Date.now() - startedAt > 120000) {
            window.clearInterval(pollId!);
            pollId = null;
            setHotelsComBypassExtraction((prev) => ({
              ...prev,
              status: 'error',
              error: 'Timed out waiting for Hotels.com extraction',
            }));
            return;
          }

          const { data: rows } = await supabase
            .from('price_extractions')
            .select('id, extraction_status, extracted_price, currency, extraction_error')
            .eq('search_id', searchId)
            .eq('platform_name', 'Hotels.com')
            .order('created_at', { ascending: false })
            .limit(1);

          const row = rows?.[0];
          if (!row) return;

          const status = row.extraction_status;
          const isRunning = status === 'pending' || status === 'running';
          if (!isRunning) {
            window.clearInterval(pollId!);
            pollId = null;
            setHotelsComBypassExtraction({
              status: 'done',
              extractionId: row.id,
              extractedPrice: row.extracted_price,
              currency: row.currency,
              extractionStatus: status,
              error: row.extraction_error || undefined,
            });
          }
        }, 4000);
      } catch (e) {
        if (cancelled) return;
        setHotelsComBypassExtraction({
          status: 'error',
          error: e instanceof Error ? e.message : 'Unknown error',
        });
      }
    };

    trigger();

    return () => {
      cancelled = true;
      if (pollId) window.clearInterval(pollId);
    };
  }, [searchId, isTerminalFrozen, search?.airbnb_url, bypassedResults]);

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

  if (isTestingPublicView) {
    return (
      <TestingPublicSearchResultsView
        searchId={searchId}
        search={search}
        results={results}
        loading={loading}
        onBack={() => navigate("/")}
      />
    );
  }

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

  // ============================================================================
  // FINAL CANDIDATES (Single Source of Truth)
  // ============================================================================
  // The canonical set that drives:
  // - final rendering
  // - banner counts
  // - section counts
  // This must include discovered + cached candidates after merge.
  //
  // IMPORTANT: Do not drop candidates for missing photos, missing price, or
  // incomplete extraction metadata. Categorization will force them into an
  // appropriate bucket (additional_issues as catch-all).
  const finalCandidates = results;

  // Create baseline (Airbnb) canonical price for comparison
  // Note: Not using useMemo here to avoid hook order issues with early returns
  const baselineCanonicalPrice: CanonicalPriceType | null = (() => {
    if (!airbnbTotal) return null;

    return {
      platform_id: 'airbnb',
      source_url: search?.airbnb_url || '',
      check_in_date: checkIn || null,
      check_out_date: checkOut || null,
      nights_count: nights || null,
      currency: confirmedTotal?.confirmed_currency || search?.airbnb_currency || 'USD',
      nightly_rate: null,
      subtotal_nights: null,
      fees_total: null,
      taxes_total: null,
      total_price: airbnbTotal,
      price_type: 'total_proven' as PriceType,
      extraction_method: 'dom' as const,
      confidence: 'high' as const,
      extracted_at: new Date().toISOString(),
      is_comparable: true,
      comparability_failures: [],
    };
  })();

  // ============================================================================
  // TWO-PHASE UX: Determine if we're in Phase 1 (pricing running) or Phase 2 (complete)
  // ============================================================================
  // Phase 1: Matches found, prices still loading (show VerifiedMatchesLoading)
  // Phase 2: Finalization complete, show bucketed results with final_bucket
  // ============================================================================
  
  // Compute the actual phase based on finalization state
  const computedResultsPhase: SearchPhaseType = isFinalized ? "complete" : "discovery_pricing";
  
  // Results that are still awaiting prices (Phase 1 display)
  // These are results without a frozen bucket that would be price-dependent
  const pendingPriceResults = finalCandidates.filter((r) => {
    const frozenBucket = ((r as any).final_bucket ?? (r as any).result_bucket) as string | undefined;
    // No frozen bucket = still pending
    if (!frozenBucket) return true;
    return false;
  });

  // ============================================================================
  // CATEGORIZATION: Use frozen snapshot bucket if available, else compute
  // CRITICAL: For refresh determinism, snapshot-based buckets are authoritative
  // PHASE 1 GUARD: In Phase 1, prevent price-dependent bucket assignment
  // ============================================================================
  const categorizedResults = finalCandidates.map((r) => {
    // CHECK IF WE HAVE A FROZEN BUCKET FROM THE SNAPSHOT
    // Snapshot field naming can vary across versions:
    // - final_bucket / final_bucket_label (new)
    // - result_bucket / result_bucket_label (older)
    // Always prefer these over client-side recomputation.
    const frozenBucket = ((r as any).final_bucket ?? (r as any).result_bucket) as string | undefined;
    
    // DEBUG: Log frozen bucket detection
    console.log(`[Categorization] ${r.platform_name}: frozenBucket=${frozenBucket}, final_bucket=${(r as any).final_bucket}, result_bucket=${(r as any).result_bucket}, phase=${computedResultsPhase}`);
    
    if (frozenBucket) {
      // Use the frozen bucket from snapshot - no re-computation
      const bucketLabel =
        (r as any).final_bucket_label ||
        (r as any).result_bucket_label ||
        BUCKET_DISPLAY[frozenBucket as ResultBucket]?.label ||
        'Unknown';
      const bucketDisplay = BUCKET_DISPLAY[frozenBucket as ResultBucket];
      
      // Build a minimal categorization object from frozen data
      const frozenCategorization: CategorizedResult = {
        bucket: frozenBucket as ResultBucket,
        bucket_label: bucketLabel,
        bucket_description: bucketDisplay?.description || '',
        is_comparable: frozenBucket === 'cheaper' || frozenBucket === 'more_expensive',
        comparison_result: null,
        savings_amount: r.savings_amount || null,
        savings_percentage: r.savings_percentage || null,
        // Note: snapshot buckets 'cheaper'/'more_expensive' imply a comparable total.
        is_verified: frozenBucket === 'cheaper' || frozenBucket === 'more_expensive',
        verification_label:
          frozenBucket === 'cheaper' || frozenBucket === 'more_expensive' ? 'Verified' : 'Not Available',
        has_low_confidence: false,
        non_comparable_reasons: [],
        non_comparable_user_message: null,
        // Build foreign price display from canonical_price if currency is not USD
        foreign_price_display: (() => {
          const cp = (r as any).canonical_price;
          if (cp && cp.currency && cp.currency !== 'USD' && cp.total_price) {
            const currency = cp.currency;
            const amount = cp.total_price;
            const symbol = currency === 'EUR' ? '€' : 
                           currency === 'GBP' ? '£' : 
                           currency === 'ZAR' ? 'R ' :
                           currency === 'CAD' ? 'CA$' :
                           currency === 'AUD' ? 'A$' :
                           currency === 'NZD' ? 'NZ$' :
                           `${currency} `;
            return {
              amount,
              currency,
              formatted: `${symbol}${amount.toLocaleString()} ${currency}`,
            };
          }
          return null;
        })(),
        price_type: ((r as any).canonical_price?.price_type || null) as PriceType | null,
        outcome_category: ((r as any).outcome_category || null) as OutcomeCategory | null,
      };
      
      return { result: r, categorization: frozenCategorization };
    }
    
    // FALLBACK: Compute categorization for legacy data without frozen bucket
    // This path is for backwards compatibility only
    const isExpedia = r.platform_name.toLowerCase().includes('expedia');
    const effectivePrice = (isExpedia && (r.canonical_price as any)?.total_price && (r.canonical_price as any).total_price > 0)
      ? ((r.canonical_price as any).total_price as number)
      : r.price;

    const input: CategorizationInput = {
      price: effectivePrice,
      canonical_price: (r.canonical_price as any) || null,
      outcome_category: (r.outcome_category as any) || null,
      extraction_status: r.extraction_status || null,
      extraction_error: r.extraction_error || null,
      is_tier_c_blocked: r.is_tier_c_blocked || false,
      coverage_tier: (r.coverage_tier as any) || null,
      price_status: r.price_status || 'unavailable',
      eligible_for_comparison: r.eligible_for_comparison || false,
      verification_failures: r.verification_failures || [],
    };

    const categorization = categorizeResultFn(input, baselineCanonicalPrice);
    return { result: r, categorization };
  });

  // Organize results by bucket (using frozen or computed bucket)
  const cheaperResults = categorizedResults
    .filter(({ categorization }) => categorization.bucket === 'cheaper')
    .sort((a, b) => (b.categorization.savings_amount ?? 0) - (a.categorization.savings_amount ?? 0))
    .map(({ result }) => result);

  const moreExpensiveResults = categorizedResults
    .filter(({ categorization }) => categorization.bucket === 'more_expensive')
    .map(({ result }) => result);

  const notComparableResults = categorizedResults
    .filter(({ categorization }) => categorization.bucket === 'not_comparable')
    .map(({ result }) => result);

  const soldOutResults = categorizedResults
    .filter(({ categorization }) => categorization.bucket === 'sold_out')
    .map(({ result }) => result);

  const blockedResults = categorizedResults
    .filter(({ categorization }) => categorization.bucket === 'blocked' || categorization.bucket === 'platform_blocked')
    .map(({ result }) => result);

  const failedResults = categorizedResults
    .filter(({ categorization }) => 
      categorization.bucket === 'price_not_found' || 
      categorization.bucket === 'service_error' ||
      categorization.bucket === 'requires_action'
    )
    .map(({ result }) => result);

  // Additional issues - unmapped/unknown terminal outcomes
  const additionalIssuesResults = categorizedResults
    .filter(({ categorization }) => categorization.bucket === 'additional_issues')
    .map(({ result }) => result);

  // Get categorization for a result (for UI display)
  const getResultCategorization = (resultId: string): CategorizedResult | null => {
    const found = categorizedResults.find(({ result }) => result.id === resultId);
    return found?.categorization || null;
  };

  // VERIFIED = comparable totals (cheaper or more expensive)
  // These are results where we can make definitive price claims
  const verifiedResults = [...cheaperResults, ...moreExpensiveResults];
  
  // UNVERIFIED = not comparable + failed + blocked + additional issues
  // These need manual verification
  const unverifiedResults = [...notComparableResults, ...failedResults, ...blockedResults, ...additionalIssuesResults];
  const unverifiedWithPrice = notComparableResults.filter(r => r.price && r.price > 0);

  // Legacy compatibility
  const resultsWithPrices = verifiedResults;
  const resultsWithoutPrices = unverifiedResults;
  const sortedByPrice = [...verifiedResults].sort((a, b) => (b.price ?? 0) - (a.price ?? 0));
  const validResults = verifiedResults;

  // Show up to 10 cheaper alternatives
  const MAX_ALTERNATIVES = 10;
  let displayResults: SearchResult[] = cheaperResults.slice(0, MAX_ALTERNATIVES);

  // Find cheapest result
  const cheapestResult = cheaperResults.length > 0 ? cheaperResults[0] : null;
  const cheapestOverall = cheapestResult;

  if (cheapestOverall && !displayResults.some((r) => r.id === cheapestOverall.id)) {
    if (displayResults.length === MAX_ALTERNATIVES) {
      displayResults = [...displayResults.slice(0, MAX_ALTERNATIVES - 1), cheapestOverall];
    } else {
      displayResults = [...displayResults, cheapestOverall];
    }
  }

  // Calculate potential savings
  const cheapestTotal = cheapestResult?.price || null;
  const potentialSavings = airbnbTotal && cheapestTotal ? airbnbTotal - cheapestTotal : null;

  // ========================================
  // CANONICAL RESULT STATE COMPUTATION
  // ========================================
  type ResultState = 
    | 'no_platforms_found'
    | 'cheaper_found'
    | 'no_cheaper_found'
    | 'prices_unavailable'
    | 'pricing_in_progress';  // NEW: Phase 1 state

  const computeResultState = (): ResultState => {
    // TWO-PHASE UX: If not finalized, we're in Phase 1 (pricing in progress)
    // Only show this state if we have matches but finalization not complete
    if (!isFinalized && finalCandidates.length > 0) {
      return 'pricing_in_progress';
    }
    
    // Canonical: if backend proceeded with N candidates, we must not claim
    // "No Alternative Listings Found" just because some candidates lack photos
    // or complete extraction metadata.
    if (finalCandidates.length === 0) {
      return 'no_platforms_found';
    }
    if (cheaperResults.length > 0) {
      return 'cheaper_found';
    }
    if (moreExpensiveResults.length > 0) {
      return 'no_cheaper_found';
    }
    return 'prices_unavailable';
  };

  const resultState = computeResultState();

  // Get counts for display
  const comparedPlatformsCount = verifiedResults.length;
  const platformsWithoutPricesCount = unverifiedResults.length;
  const notComparableCount = notComparableResults.length;
  
  // Phase 1 specific: Count matches awaiting prices (those without frozen bucket)
  const pendingPriceCount = pendingPriceResults.length;
  const matchOnlyResultsCount = soldOutResults.length + blockedResults.length + failedResults.length;

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

  // Get human-readable failure reason using canonical categorization
  const getFailureDisplay = (result: SearchResult): { 
    text: string; 
    isTierC: boolean; 
    isTierA: boolean; 
    isUnverified: boolean; 
    isSoldOut: boolean;
    isNotComparable: boolean;
    isMoreExpensive: boolean;
  } => {
    const categorization = getResultCategorization(result.id);
    const bucket = categorization?.bucket;
    const isTierC = result.is_tier_c_blocked === true;
    const isTierA = result.coverage_tier === 'A';
    
    if (isTierC || bucket === 'platform_blocked') {
      return { text: 'Platform not supported', isTierC: true, isTierA: false, isUnverified: false, isSoldOut: false, isNotComparable: false, isMoreExpensive: false };
    }
    
    if (bucket === 'sold_out') {
      return { text: 'Not available for these dates', isTierC: false, isTierA, isUnverified: false, isSoldOut: true, isNotComparable: false, isMoreExpensive: false };
    }
    
    if (bucket === 'more_expensive') {
      const savings = categorization?.savings_amount;
      const text = savings ? `${Math.abs(savings).toFixed(0)} more than Airbnb` : 'More expensive than Airbnb';
      return { text, isTierC: false, isTierA, isUnverified: false, isSoldOut: false, isNotComparable: false, isMoreExpensive: true };
    }
    
    if (bucket === 'not_comparable') {
      const msg = categorization?.non_comparable_user_message || 'Price not directly comparable';
      return { text: msg, isTierC: false, isTierA, isUnverified: true, isSoldOut: false, isNotComparable: true, isMoreExpensive: false };
    }
    
    if (bucket === 'blocked') {
      return { text: 'Access blocked by platform', isTierC: false, isTierA, isUnverified: false, isSoldOut: false, isNotComparable: false, isMoreExpensive: false };
    }
    
    if (bucket === 'price_not_found' || bucket === 'service_error') {
      return { text: 'Price unavailable', isTierC: false, isTierA, isUnverified: false, isSoldOut: false, isNotComparable: false, isMoreExpensive: false };
    }
    
    if (bucket === 'additional_issues') {
      return { text: 'Outcome not classified', isTierC: false, isTierA, isUnverified: true, isSoldOut: false, isNotComparable: false, isMoreExpensive: false };
    }
    
    // Fallback
    return { text: result.failure_reason || 'Manual check recommended', isTierC: false, isTierA, isUnverified: true, isSoldOut: false, isNotComparable: false, isMoreExpensive: false };
  };

  // EXPEDIA-SPECIFIC: Get effective display price for a result
  // For Expedia, prefer canonical_price.total_price over result.price to avoid stale subtotals
  const getEffectivePrice = (result: SearchResult): number | null => {
    const isExpedia = result.platform_name.toLowerCase().includes('expedia');
    
    // For Expedia: use canonical_price.total_price if available (proven golden path total)
    if (isExpedia && result.canonical_price?.total_price && result.canonical_price.total_price > 0) {
      return result.canonical_price.total_price;
    }
    
    // For all platforms: if canonical_price.total_price exists and price_type is total, prefer it
    if (result.canonical_price?.total_price && result.canonical_price.total_price > 0) {
      const isTotalType = result.canonical_price.price_type === 'total_proven' || 
                          result.canonical_price.price_type === 'total_derived';
      if (isTotalType) {
        return result.canonical_price.total_price;
      }
    }
    
    // Fallback to result.price
    return result.price;
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
        {/* Hydration error state with retry button (prevents stuck Loading forever) */}
        {hydrationError ? (
          <div className="max-w-3xl mx-auto">
            <div className="bg-card rounded-2xl shadow-large border border-border overflow-hidden">
              <div className="p-8 text-center">
                <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-destructive/10 flex items-center justify-center">
                  <AlertCircle className="w-8 h-8 text-destructive" />
                </div>
                <h3 className="text-xl font-semibold text-foreground mb-2">
                  Failed to Load Results
                </h3>
                <p className="text-muted-foreground mb-4 max-w-md mx-auto">
                  {hydrationError}
                </p>
                <div className="flex items-center justify-center gap-3">
                  <Button 
                    onClick={() => {
                      setHydrationError(null);
                      setTerminalHydrating(true);
                      setHydrationRetryCount(0);
                      // Reset and re-trigger by incrementing runSeq
                      searchTriggeredRef.current = false;
                      setRunSeq(s => s + 1);
                    }}
                  >
                    <Search className="w-4 h-4 mr-2" />
                    Retry
                  </Button>
                  <Button variant="outline" asChild>
                    <Link to="/dashboard">Go to Dashboard</Link>
                  </Button>
                </div>
              </div>
            </div>
          </div>
        ) : terminalHydrating ? (
          <div className="max-w-3xl mx-auto">
            <div className="bg-card rounded-2xl shadow-large border border-border overflow-hidden">
              <div className="p-8 text-center">
                <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-primary/10 flex items-center justify-center">
                  <Sparkles className="w-6 h-6 text-primary animate-pulse" />
                </div>
                <p className="text-sm text-muted-foreground mb-2">Loading final results…</p>
                
                {/* Finalization Gate Progress */}
                {finalizationProgress && finalizationProgress.total > 0 && (
                  <div className="mt-4 space-y-2">
                    <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground/80">
                      <span className="font-medium">
                        {finalizationProgress.terminal}/{finalizationProgress.total}
                      </span>
                      <span>platforms finalized</span>
                    </div>
                    <div className="w-48 mx-auto h-1.5 bg-muted rounded-full overflow-hidden">
                      <div 
                        className="h-full bg-primary/60 rounded-full transition-all duration-500"
                        style={{ 
                          width: `${Math.round((finalizationProgress.terminal / finalizationProgress.total) * 100)}%` 
                        }}
                      />
                    </div>
                  </div>
                )}
                
                {hydrationRetryCount > 1 && (
                  <p className="text-xs text-muted-foreground/70 mt-3">
                    Attempt {hydrationRetryCount} of 5
                  </p>
                )}
              </div>
            </div>
          </div>
        ) : ((loading || extractingPrices) && !resultsViewUnlocked) ? (
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
                  // All supported terminal types from TerminalErrorPanel
                  const terminalTypes = [
                    "dates_unavailable", 
                    "rate_limited", 
                    "airbnb_total_not_visible", 
                    "provider_timeout", 
                    "bot_detected",
                    // Expedia-specific terminal states
                    "expedia_access_blocked",
                    "expedia_total_not_found",
                    "property_id_not_found",
                    "offers_page_not_loaded",
                    "expedia_offers_page_not_reached",
                    "expedia_total_not_found_on_offers_page",
                    // Target card anchoring statuses (v6.3)
                    "expedia_target_offer_not_found",
                    "expedia_target_offer_mismatch",
                    "expedia_dates_unavailable_for_target",
                    "expedia_target_total_not_found",
                  ];
                  
                  if (errorCode && terminalTypes.includes(errorCode)) {
                    return (
                      <TerminalErrorPanel
                        type={errorCode as any}
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

                {/* ================================================================
                    PHASE 1 UI: Pricing In Progress
                    Shows verified matches with "Fetching price…" placeholders
                    Only renders when search has matches but finalization not complete
                ================================================================ */}
                {(resultState === 'pricing_in_progress' && finalCandidates.length > 0) && (
                  <>
                    {/* Phase 1 Banner */}
                    <SearchPhaseBanner 
                      phase="discovery_pricing" 
                      matchCount={finalCandidates.length}
                    />

                    {/* Verified Matches Loading Section */}
                    <div className="space-y-6">
                      {/* Main matches awaiting prices */}
                      <VerifiedMatchesLoading
                        results={finalCandidates.map(r => ({
                          id: r.id,
                          platform_name: r.platform_name,
                          listing_url: r.listing_url,
                          listing_title: r.listing_title,
                          confidence_score: r.confidence_score,
                          images: r.images,
                          match_type: r.match_type,
                          source_airbnb_image: r.source_airbnb_image,
                          extraction_status: r.extraction_status,
                          outcome_category: r.outcome_category,
                        }))}
                        pricingProgress={{
                          completed: priceExtractionCompleted,
                          total: priceExtractionTotal || finalCandidates.length,
                        }}
                      />

                      {/* MATCH_ONLY sections can still show in Phase 1 */}
                      {/* Blocked platforms */}
                      {blockedResults.length > 0 && (
                        <div className="rounded-xl border border-red-500/20 bg-red-500/5 overflow-hidden">
                          <div className="px-4 py-3 flex items-center gap-2">
                            <Ban className="w-4 h-4 text-red-500" />
                            <span className="text-sm font-medium text-foreground">
                              {blockedResults.length} platform{blockedResults.length !== 1 ? 's' : ''} blocked access
                            </span>
                          </div>
                        </div>
                      )}

                      {/* Sold out platforms */}
                      {soldOutResults.length > 0 && (
                        <div className="rounded-xl border border-orange-500/20 bg-orange-500/5 overflow-hidden">
                          <div className="px-4 py-3 flex items-center gap-2">
                            <Calendar className="w-4 h-4 text-orange-500" />
                            <span className="text-sm font-medium text-foreground">
                              {soldOutResults.length} platform{soldOutResults.length !== 1 ? 's' : ''} unavailable for these dates
                            </span>
                          </div>
                        </div>
                      )}

                      {/* TESTING: Bypassed results - photo comparison bypassed via testing exception */}
                      {bypassedResults.length > 0 && (
                        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 overflow-hidden">
                          <div className="px-4 py-3 flex items-center gap-2">
                            <AlertTriangle className="w-4 h-4 text-amber-500" />
                            <span className="text-sm font-medium text-foreground">
                              {bypassedResults.length} result{bypassedResults.length !== 1 ? 's' : ''} with photo verification bypassed
                            </span>
                            <span className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-600 text-[10px] font-medium">
                              TESTING EXCEPTION
                            </span>
                          </div>
                          <div className="border-t border-amber-500/20 p-4">
                            <table className="w-full text-sm">
                              <tbody>
                                {bypassedResults.map((result) => {
                                  const resultImages = toStringArray(result.images);
                                  const isExpanded = expandedComparison === result.id;
                                  return (
                                    <React.Fragment key={result.id}>
                                      <tr className="border-b border-border/50 last:border-0">
                                        <td className="py-3 pr-3">
                                          <div className="font-medium text-foreground">{result.platform_name}</div>
                                          <div className="text-xs text-muted-foreground truncate max-w-[200px]">
                                            {result.listing_title || 'Listing'}
                                          </div>
                                          <div className="text-xs text-amber-600 mt-1">
                                            {result.bypassed_reason}
                                          </div>
                                        </td>
                                        <td className="py-3 px-3 text-center">
                                          <span className="text-xs text-muted-foreground">
                                            Score: {result.confidence_score != null ? `${Math.round(result.confidence_score)}%` : 'N/A'}
                                          </span>
                                        </td>
                                        <td className="py-3 px-3">
                                          <span className="px-2 py-1 rounded bg-amber-500/20 text-amber-600 text-xs font-medium">
                                            Bypassed
                                          </span>
                                        </td>
                                        <td className="py-3 pl-3 text-right">
                                          <div className="flex items-center justify-end gap-2">
                                            <a 
                                              href={result.listing_url} 
                                              target="_blank" 
                                              rel="noopener noreferrer"
                                              className="text-xs text-primary hover:underline"
                                            >
                                              View
                                            </a>
                                            {(result.source_airbnb_image || airbnbImages[0]) && resultImages.length > 0 && (
                                              <Button
                                                variant="ghost"
                                                size="sm"
                                                onClick={() => setExpandedComparison(isExpanded ? null : result.id)}
                                                className="text-xs h-7 px-2"
                                              >
                                                <Camera className="w-3 h-3 mr-1" />
                                                {isExpanded ? 'Hide' : 'Photos'}
                                              </Button>
                                            )}
                                          </div>
                                        </td>
                                      </tr>
                                      {isExpanded && (result.source_airbnb_image || airbnbImages[0]) && resultImages.length > 0 && (
                                        <tr>
                                          <td colSpan={4} className="py-4 bg-muted/30">
                                            <ImageComparison
                                              airbnbImages={result.source_airbnb_image ? [result.source_airbnb_image] : airbnbImages}
                                              alternativeImages={resultImages}
                                              airbnbTitle={search?.airbnb_title || 'Airbnb Listing'}
                                              alternativeTitle={result.listing_title || 'Alternative Listing'}
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
                        </div>
                      )}

                      {/* Low trust score section (unchanged - always available) */}
                      {lowTrustScoreResults.length > 0 && (
                        <div className="rounded-xl border border-muted-foreground/20 bg-muted/20 overflow-hidden">
                          <div className="px-4 py-3 flex items-center gap-2">
                            <Shield className="w-4 h-4 text-muted-foreground" />
                            <span className="text-sm font-medium text-foreground">
                              {lowTrustScoreResults.length} candidate{lowTrustScoreResults.length !== 1 ? 's' : ''} below trust threshold
                            </span>
                            <span className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground text-[10px] font-medium">
                              TESTING
                            </span>
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                )}
                {/* PHASE 2 ONLY: Show when finalized and no cheaper alternatives found */}
                {(search?.status === "completed" && isFinalized && displayResults.length === 0 && (resultState === 'no_cheaper_found' || resultState === 'prices_unavailable') && (search?.airbnb_price || confirmedTotal)) && (
                  /* Alternatives exist but none are cheaper than Airbnb - use same table layout */
                  <>
                    {/* Phase 2 Banner: Final results ready */}
                    <SearchPhaseBanner 
                      phase="complete" 
                      matchCount={finalCandidates.length}
                      cheaperCount={0}
                    />
                    
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

                    {/* More expensive alternatives (same bucket UI structure as other categories) */}
                    {moreExpensiveResults.length > 0 && (
                      <ResultBucketSection
                        open={showMoreExpensive}
                        onToggle={() => setShowMoreExpensive(!showMoreExpensive)}
                        containerClassName="rounded-xl border border-border bg-muted/30 overflow-hidden"
                        headerClassName="w-full px-4 py-3 flex items-center justify-between hover:bg-muted/50 transition-colors"
                        borderTopClassName="border-t border-border"
                        leading={<span className="w-2 h-2 rounded-full bg-muted-foreground" />}
                        title={
                          <>
                            {moreExpensiveResults.length} more expensive alternative{moreExpensiveResults.length !== 1 ? "s" : ""}
                          </>
                        }
                        subtitle="Higher total than Airbnb"
                      >
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <tbody>
                              {moreExpensiveResults.map((result) => {
                                const effectiveTotal = getEffectivePrice(result) || 0;
                                const priceDiff = Math.round(effectiveTotal - (airbnbTotal || 0));
                                const resultImages = toStringArray(result.images);
                                const isExpanded = expandedComparison === result.id;

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
                                          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-success/10 text-success text-xs font-medium">
                                            <Shield className="w-3 h-3" />
                                            {Math.round(result.confidence_score)}%
                                          </span>
                                        ) : (
                                          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-muted text-muted-foreground text-xs font-medium">
                                            <Info className="w-3 h-3" />
                                            Text
                                          </span>
                                        )}
                                      </td>
                                      <td className="py-4 px-4 text-right">
                                        <div className="flex flex-col items-end gap-0.5">
                                          <span className="font-semibold text-foreground">
                                            {currencySymbol}{formatUSDPrice(effectiveTotal)}
                                          </span>
                                          <span className="text-xs text-muted-foreground">
                                            (+{currencySymbol}{formatUSDPrice(priceDiff)})
                                          </span>
                                          <ExpediaDebugReveal
                                            platformName={result.platform_name}
                                            canonicalPrice={result.canonical_price || null}
                                            categorization={getResultCategorization(result.id)}
                                            extractionMetadata={(result as any).extraction_metadata}
                                            airbnbTotal={airbnbTotal}
                                          />
                                        </div>
                                      </td>
                                      <td className="py-4 px-4 hidden lg:table-cell">
                                        <span className="text-xs text-muted-foreground">May have different terms</span>
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
                                            className={`text-xs px-2 py-1 rounded transition-colors flex items-center gap-1 ${
                                              isExpanded ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-primary'
                                            }`}
                                          >
                                            <ArrowLeftRight className="w-3 h-3" />
                                            {isExpanded ? 'Hide' : 'Photos'}
                                          </button>
                                        </div>
                                      </td>
                                    </tr>
                                    {isExpanded && (
                                      <tr className="border-b border-border/50">
                                        <td colSpan={5} className="p-4 bg-muted/30">
                                          {resultImages.length > 0 || airbnbImages.length > 0 || result.source_airbnb_image ? (
                                            <ImageComparison
                                              airbnbImages={airbnbImages}
                                              alternativeImages={resultImages}
                                              airbnbTitle={search?.airbnb_title || "Airbnb Listing"}
                                              alternativeTitle={result.listing_title || "Alternative Listing"}
                                              platformName={result.platform_name}
                                              sourceAirbnbImage={result.source_airbnb_image}
                                            />
                                          ) : (
                                            <p className="text-sm text-muted-foreground text-center py-4">No photos available for comparison</p>
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
                      </ResultBucketSection>
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
                                      // EXPEDIA-SPECIFIC: Use effective price (canonical total) not stale result.price
                                      const effectivePrice = getEffectivePrice(result);
                                      
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
                                                  {Math.min(100, Math.round(result.confidence_score))}%
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
                                                  {currencySymbol}{formatUSDPrice(effectivePrice)}
                                                </span>
                                                <span className="text-xs text-amber-600">{failureDisplay.text}</span>
                                                {/* Expedia Debug Reveal */}
                                                <ExpediaDebugReveal
                                                  platformName={result.platform_name}
                                                  canonicalPrice={result.canonical_price || null}
                                                  categorization={getResultCategorization(result.id)}
                                                  extractionMetadata={(result as any).extraction_metadata}
                                                  airbnbTotal={airbnbTotal}
                                                />
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
                                      const failureDisplay = getFailureDisplay(result);
                                      return (
                                        <ResultRow
                                          key={result.id}
                                          result={result as ResultRowResult}
                                          variant="blocked"
                                          isExpanded={expandedComparison === result.id}
                                          onToggleExpand={(id) => setExpandedComparison(expandedComparison === id ? null : id)}
                                          airbnbImages={airbnbImages}
                                          airbnbTitle={search?.airbnb_title || "Airbnb Listing"}
                                          currencySymbol={currencySymbol}
                                          failureDisplayText={failureDisplay.text}
                                          colSpan={4}
                                        />
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </div>
                        )}
                        
                        {/* Category 3: Sold out / Unavailable for dates (NOT an error) */}
                        {soldOutResults.length > 0 && (
                          <div className="rounded-xl border border-orange-500/20 bg-orange-500/5 overflow-hidden">
                            <button
                              onClick={() => setShowSoldOutPlatforms(!showSoldOutPlatforms)}
                              className="w-full px-4 py-3 flex items-center justify-between hover:bg-orange-500/10 transition-colors"
                            >
                              <div className="flex items-center gap-2">
                                <span className="w-2 h-2 rounded-full bg-orange-500" />
                                <Calendar className="w-4 h-4 text-orange-500" />
                                <span className="text-sm font-medium text-foreground">
                                  {soldOutResults.length} platform{soldOutResults.length !== 1 ? 's' : ''} unavailable for these dates
                                </span>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="text-xs text-muted-foreground">Sold out or dates not available</span>
                                {showSoldOutPlatforms ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
                              </div>
                            </button>
                            
                            {showSoldOutPlatforms && (
                              <div className="border-t border-orange-500/20">
                                <table className="w-full text-sm">
                                  <tbody>
                                    {soldOutResults.map((result) => {
                                      const failureDisplay = getFailureDisplay(result);
                                      return (
                                        <ResultRow
                                          key={result.id}
                                          result={result as ResultRowResult}
                                          variant="sold_out"
                                          isExpanded={expandedComparison === result.id}
                                          onToggleExpand={(id) => setExpandedComparison(expandedComparison === id ? null : id)}
                                          airbnbImages={airbnbImages}
                                          airbnbTitle={search?.airbnb_title || "Airbnb Listing"}
                                          currencySymbol={currencySymbol}
                                          failureDisplayText={failureDisplay.text}
                                          colSpan={4}
                                        />
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </div>
                        )}
                        
                        {/* Category 4: Extraction failed */}
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
                                                  {Math.min(100, Math.round(result.confidence_score))}%
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

                        {/* Category 5: Additional Issues Detected - unmapped outcomes */}
                        {additionalIssuesResults.length > 0 && (
                          <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 overflow-hidden">
                            <button
                              onClick={() => setShowAdditionalIssues(!showAdditionalIssues)}
                              className="w-full px-4 py-3 flex items-center justify-between hover:bg-amber-500/10 transition-colors"
                            >
                              <div className="flex items-center gap-2">
                                <span className="w-2 h-2 rounded-full bg-amber-500" />
                                <HelpCircle className="w-4 h-4 text-amber-500" />
                                <span className="text-sm font-medium text-foreground">
                                  {additionalIssuesResults.length} additional issue{additionalIssuesResults.length !== 1 ? 's' : ''} detected
                                </span>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="text-xs text-muted-foreground">Could not classify pricing outcome</span>
                                {showAdditionalIssues ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
                              </div>
                            </button>
                            
                            {showAdditionalIssues && (
                              <div className="border-t border-amber-500/20">
                                <table className="w-full text-sm">
                                  <tbody>
                                    {additionalIssuesResults.map((result) => {
                                      const resultImages = toStringArray(result.images);
                                      const isExpanded = expandedComparison === result.id;
                                      // Show extraction status as secondary detail
                                      const errorDetail = result.extraction_status || result.extraction_error || 'Unknown issue';
                                      
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
                                                  {Math.min(100, Math.round(result.confidence_score))}%
                                                </span>
                                              ) : (
                                                <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-amber-500/10 text-amber-600 text-xs font-medium">
                                                  <Info className="w-3 h-3" />
                                                  Text
                                                </span>
                                              )}
                                            </td>
                                            <td className="py-4 px-4 text-right text-muted-foreground">
                                              <div className="flex flex-col items-end gap-0.5">
                                                <span className="text-sm text-amber-600">Outcome not classified</span>
                                                <span className="text-[10px] text-muted-foreground/70 font-mono truncate max-w-[150px]" title={errorDetail}>
                                                  {errorDetail}
                                                </span>
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
                                                {resultImages.length > 0 || airbnbImages.length > 0 || result.source_airbnb_image ? (
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

                        {/* TESTING: Bypassed results - photo comparison bypassed via testing exception */}
                        {bypassedResults.length > 0 && (
                          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 overflow-hidden">
                            <div className="px-4 py-3 flex items-center gap-2">
                              <AlertTriangle className="w-4 h-4 text-amber-500" />
                              <span className="text-sm font-medium text-foreground">
                                {bypassedResults.length} result{bypassedResults.length !== 1 ? 's' : ''} with photo verification bypassed
                              </span>
                              <span className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-600 text-[10px] font-medium">
                                TESTING EXCEPTION
                              </span>
                            </div>
                            <div className="border-t border-amber-500/20 p-4">
                              <p className="text-xs text-amber-600 mb-3">
                                These results failed photo comparison but are shown due to an active testing exception.
                              </p>
                              {bypassedResults.map((result) => (
                                <div key={result.id} className="flex items-center justify-between py-2 border-b border-amber-500/10 last:border-0">
                                  <div>
                                    <span className="font-medium text-foreground">{result.platform_name}</span>
                                    <span className="text-xs text-muted-foreground ml-2">Score: {result.confidence_score != null ? `${Math.round(result.confidence_score)}%` : 'N/A'}</span>
                                  </div>
                                  <a 
                                    href={result.listing_url} 
                                    target="_blank" 
                                    rel="noopener noreferrer"
                                    className="text-xs text-primary hover:underline"
                                  >
                                    View Listing
                                  </a>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        
                        {/* Category 6: Low Trust Score - Candidates that failed image verification (for testing) */}
                        {lowTrustScoreResults.length > 0 && (
                          <div className="rounded-xl border border-muted-foreground/20 bg-muted/20 overflow-hidden">
                            <button
                              onClick={() => setShowLowTrustScore(!showLowTrustScore)}
                              className="w-full px-4 py-3 flex items-center justify-between hover:bg-muted/40 transition-colors"
                            >
                              <div className="flex items-center gap-2">
                                <span className="w-2 h-2 rounded-full bg-muted-foreground" />
                                <Shield className="w-4 h-4 text-muted-foreground" />
                                <span className="text-sm font-medium text-foreground">
                                  {lowTrustScoreResults.length} candidate{lowTrustScoreResults.length !== 1 ? 's' : ''} below trust threshold
                                </span>
                                <span className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground text-[10px] font-medium">
                                  TESTING
                                </span>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="text-xs text-muted-foreground">Trust score &lt; 75%</span>
                                {showLowTrustScore ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
                              </div>
                            </button>
                            
                            {showLowTrustScore && (
                              <div className="border-t border-muted-foreground/20">
                                <div className="px-4 py-2 bg-muted/30 border-b border-muted-foreground/10">
                                  <p className="text-xs text-muted-foreground italic">
                                    These candidates were found via image search but failed visual verification. 
                                    They may be similar-looking properties, not the same listing.
                                  </p>
                                </div>
                                <table className="w-full text-sm">
                                  <tbody>
                                    {lowTrustScoreResults.map((result) => {
                                      const resultImages = toStringArray(result.images);
                                      const isExpanded = expandedComparison === result.id;
                                      const score = typeof result.confidence_score === 'number' ? Math.round(result.confidence_score) : null;
                                      
                                      // Determine badge color based on score range
                                      const getBadgeStyle = (s: number | null) => {
                                        if (s === null) return 'bg-muted text-muted-foreground';
                                        if (s >= 50) return 'bg-amber-500/10 text-amber-600'; // Close to threshold
                                        if (s >= 25) return 'bg-orange-500/10 text-orange-600'; // Medium
                                        return 'bg-destructive/10 text-destructive'; // Low
                                      };
                                      
                                      const getTooltipText = (s: number | null) => {
                                        if (s === null) return 'Score not available for this candidate';
                                        if (s >= 50) return `${s}% confidence - Close to threshold but still uncertain. Compare photos to verify.`;
                                        if (s >= 25) return `${s}% confidence - Some visual similarities but key structural differences detected.`;
                                        return `${s}% confidence - Different property or significant structural differences detected.`;
                                      };
                                      
                                      return (
                                        <React.Fragment key={result.id}>
                                          <tr className="border-b border-border/50 hover:bg-muted/30 opacity-70">
                                            <td className="py-4 px-4">
                                              <div className="flex items-center gap-2 flex-wrap">
                                                <span className="w-2 h-2 rounded-full bg-muted-foreground" />
                                                <span className="font-medium text-foreground">{result.platform_name}</span>
                                                {/* Rejected badge with tooltip */}
                                                <span 
                                                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-muted text-muted-foreground text-[10px] font-medium cursor-help"
                                                  title="Failed image verification. Photos may look similar but structural analysis didn't confirm same property."
                                                >
                                                  <AlertTriangle className="w-2.5 h-2.5" />
                                                  Rejected
                                                </span>
                                              </div>
                                            </td>
                                            <td className="py-4 px-4 text-center">
                                              <span 
                                                className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium cursor-help ${getBadgeStyle(score)}`}
                                                title={getTooltipText(score)}
                                              >
                                                <Shield className="w-3 h-3" />
                                                {score !== null ? `${score}%` : '?'}
                                              </span>
                                            </td>
                                            <td className="py-4 px-4 text-right text-muted-foreground">
                                              <span 
                                                className="text-sm cursor-help"
                                                title="This candidate did not pass the 75% confidence threshold required for verification."
                                              >
                                                Below threshold
                                              </span>
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
                                                {resultImages.length > 0 || airbnbImages.length > 0 || result.source_airbnb_image ? (
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
                {/* PHASE 2 ONLY: Only show price-dependent results after finalization */}
                {(search?.status === "completed" && isFinalized && displayResults.length > 0 && (search?.airbnb_price || confirmedTotal)) && (
                  <>
                    {/* Phase 2 Banner: Final results ready */}
                    <SearchPhaseBanner 
                      phase="complete" 
                      matchCount={finalCandidates.length}
                      cheaperCount={cheaperResults.length}
                    />

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
                                        result.confidence_score >= 90 
                                          ? 'bg-success/20 text-success' 
                                          : 'bg-primary/20 text-primary'
                                      }`}>
                                        <Shield className="w-3 h-3" />
                                        {Math.min(100, Math.round(result.confidence_score))}%
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
                                                  {Math.min(100, Math.round(result.confidence_score))}%
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
                                                  {Math.min(100, Math.round(result.confidence_score))}%
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
                                                  {Math.min(100, Math.round(result.confidence_score))}%
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

                        {/* Category 4: Additional Issues Detected - unmapped outcomes */}
                        {additionalIssuesResults.length > 0 && (
                          <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 overflow-hidden">
                            <button
                              onClick={() => setShowAdditionalIssues(!showAdditionalIssues)}
                              className="w-full px-4 py-3 flex items-center justify-between hover:bg-amber-500/10 transition-colors"
                            >
                              <div className="flex items-center gap-2">
                                <span className="w-2 h-2 rounded-full bg-amber-500" />
                                <HelpCircle className="w-4 h-4 text-amber-500" />
                                <span className="text-sm font-medium text-foreground">
                                  {additionalIssuesResults.length} additional issue{additionalIssuesResults.length !== 1 ? 's' : ''} detected
                                </span>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="text-xs text-muted-foreground">Could not classify pricing outcome</span>
                                {showAdditionalIssues ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
                              </div>
                            </button>
                            
                            {showAdditionalIssues && (
                              <div className="border-t border-amber-500/20">
                                <table className="w-full text-sm">
                                  <tbody>
                                    {additionalIssuesResults.map((result) => {
                                      const resultImages = toStringArray(result.images);
                                      const isExpanded = expandedComparison === result.id;
                                      const errorDetail = result.extraction_status || result.extraction_error || 'Unknown issue';
                                      
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
                                                  {Math.min(100, Math.round(result.confidence_score))}%
                                                </span>
                                              ) : (
                                                <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-amber-500/10 text-amber-600 text-xs font-medium">
                                                  <Info className="w-3 h-3" />
                                                  Text
                                                </span>
                                              )}
                                            </td>
                                            <td className="py-4 px-4 text-right text-muted-foreground">
                                              <div className="flex flex-col items-end gap-0.5">
                                                <span className="text-sm text-amber-600">Outcome not classified</span>
                                                <span className="text-[10px] text-muted-foreground/70 font-mono truncate max-w-[150px]" title={errorDetail}>
                                                  {errorDetail}
                                                </span>
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

                        {/* TESTING: Bypassed results - photo comparison bypassed via testing exception */}
                        {bypassedResults.length > 0 && (
                          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 overflow-hidden">
                            <div className="px-4 py-3 flex items-center gap-2">
                              <AlertTriangle className="w-4 h-4 text-amber-500" />
                              <span className="text-sm font-medium text-foreground">
                                {bypassedResults.length} result{bypassedResults.length !== 1 ? 's' : ''} with photo verification bypassed
                              </span>
                              <span className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-600 text-[10px] font-medium">
                                TESTING EXCEPTION
                              </span>
                            </div>
                            <div className="border-t border-amber-500/20 p-4">
                              <p className="text-xs text-amber-600 mb-3">
                                These results failed photo comparison but are shown due to an active testing exception.
                              </p>
                              {bypassedResults.map((result) => (
                                <div key={result.id} className="flex items-center justify-between py-2 border-b border-amber-500/10 last:border-0">
                                  <div>
                                    <span className="font-medium text-foreground">{result.platform_name}</span>
                                    <span className="text-xs text-muted-foreground ml-2">Score: {result.confidence_score != null ? `${Math.round(result.confidence_score)}%` : 'N/A'}</span>
                                  </div>
                                  <a 
                                    href={result.listing_url} 
                                    target="_blank" 
                                    rel="noopener noreferrer"
                                    className="text-xs text-primary hover:underline"
                                  >
                                    View Listing
                                  </a>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Category 5: Low Trust Score - Candidates that failed image verification */}
                        {lowTrustScoreResults.length > 0 && (
                          <div className="rounded-xl border border-muted-foreground/20 bg-muted/20 overflow-hidden">
                            <button
                              onClick={() => setShowLowTrustScore(!showLowTrustScore)}
                              className="w-full px-4 py-3 flex items-center justify-between hover:bg-muted/40 transition-colors"
                            >
                              <div className="flex items-center gap-2">
                                <span className="w-2 h-2 rounded-full bg-muted-foreground" />
                                <Shield className="w-4 h-4 text-muted-foreground" />
                                <span className="text-sm font-medium text-foreground">
                                  {lowTrustScoreResults.length} candidate{lowTrustScoreResults.length !== 1 ? 's' : ''} below trust threshold
                                </span>
                                <span className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground text-[10px] font-medium">
                                  TESTING
                                </span>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="text-xs text-muted-foreground">Trust score &lt; 75%</span>
                                {showLowTrustScore ? (
                                  <ChevronUp className="w-4 h-4 text-muted-foreground" />
                                ) : (
                                  <ChevronDown className="w-4 h-4 text-muted-foreground" />
                                )}
                              </div>
                            </button>

                            {showLowTrustScore && (
                              <div className="border-t border-muted-foreground/20">
                                <div className="px-4 py-2 bg-muted/30 border-b border-muted-foreground/10">
                                  <p className="text-xs text-muted-foreground italic">
                                    These candidates were found via image search but failed visual verification.
                                    They may be similar-looking properties, not the same listing.
                                  </p>
                                </div>
                                <table className="w-full text-sm">
                                  <tbody>
                                    {lowTrustScoreResults.map((result) => {
                                      const resultImages = toStringArray(result.images);
                                      const isExpanded = expandedComparison === result.id;
                                      const score = typeof result.confidence_score === 'number' ? Math.round(result.confidence_score) : null;

                                      const getBadgeStyle = (s: number | null) => {
                                        if (s === null) return 'bg-muted text-muted-foreground';
                                        if (s >= 50) return 'bg-amber-500/10 text-amber-600';
                                        if (s >= 25) return 'bg-orange-500/10 text-orange-600';
                                        return 'bg-destructive/10 text-destructive';
                                      };

                                      return (
                                        <React.Fragment key={result.id}>
                                          <tr className="border-b border-border/50 hover:bg-muted/30 opacity-70">
                                            <td className="py-4 px-4">
                                              <div className="flex items-center gap-2 flex-wrap">
                                                <span className="w-2 h-2 rounded-full bg-muted-foreground" />
                                                <span className="font-medium text-foreground">{result.platform_name}</span>
                                                <span
                                                  className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${getBadgeStyle(score)}`}
                                                  title={score === null ? 'Score not available for this candidate' : `${score}% confidence`}
                                                >
                                                  <Shield className="w-3 h-3" />
                                                  {score === null ? 'N/A' : `${score}%`}
                                                </span>
                                              </div>
                                            </td>
                                            <td className="py-4 px-4 text-right text-muted-foreground">
                                              <span
                                                className="text-xs px-2 py-1 rounded bg-muted text-muted-foreground"
                                                title="This candidate did not pass the 75% confidence threshold required for verification."
                                              >
                                                Below threshold
                                              </span>
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
                                                  className={`text-xs px-2 py-1 rounded transition-colors flex items-center gap-1 ${
                                                    isExpanded ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-primary'
                                                  }`}
                                                >
                                                  <ArrowLeftRight className="w-3 h-3" />
                                                  {isExpanded ? 'Hide' : 'Photos'}
                                                </button>
                                              </div>
                                            </td>
                                          </tr>
                                          {isExpanded && (
                                            <tr className="border-b border-border/50">
                                              <td colSpan={3} className="p-4 bg-muted/30">
                                                {resultImages.length > 0 || airbnbImages.length > 0 || result.source_airbnb_image ? (
                                                  <ImageComparison
                                                    airbnbImages={airbnbImages}
                                                    alternativeImages={resultImages}
                                                    airbnbTitle={search?.airbnb_title || 'Airbnb Listing'}
                                                    alternativeTitle={result.listing_title || 'Alternative Listing'}
                                                    platformName={result.platform_name}
                                                    sourceAirbnbImage={result.source_airbnb_image}
                                                  />
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
