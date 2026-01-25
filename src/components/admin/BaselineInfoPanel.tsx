import { useState, useEffect, useRef, useCallback } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip';
import { Shield, ChevronDown, ChevronRight, CheckCircle2, AlertCircle, Clock, GitCommit, Tag, RefreshCw, ShieldCheck, ShieldAlert, Zap, Activity, FileCheck2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAdminAuth } from '@/hooks/useAdminAuth';
import { BASELINE_EXPECTATIONS, CATEGORY_LABELS, getExpectationsByCategory } from '@/lib/baselineExpectations';

interface BaselineData {
  baseline_name: string;
  baseline_version: string;
  declared_at: string;
  declared_by: string | null;
  git_commit_hash: string | null;
  deployment_id: string | null;
  is_active: boolean;
  expectations: Record<string, unknown>;
  notes: string | null;
}

// Structured error from edge function
interface StructuredError {
  code: string;
  message: string;
  details?: string[] | null;
}

// Meta info from edge function
interface CheckMeta {
  evaluated_at: string;
  duration_ms?: number;
}

// Canonical check result (logic validation - deterministic)
// Follows the stable response contract - always HTTP 200 with structured result
interface CanonicalCheckResult {
  mode: string;
  passed: boolean;
  ok?: boolean;
  checks: Array<{
    name: string;
    expected: string;
    actual: string;
    passed: boolean;
  }>;
  status: string;
  timestamp: string;
  error?: StructuredError | null;
  meta?: CheckMeta;
}

// Canary check result (live provider capability check)
interface CanaryCheckResult {
  mode: string;
  passed: boolean;
  provider: string;
  canary_url: string;
  canary_dates: { check_in: string; check_out: string; nights: number };
  extraction_result: {
    status: string;
    price: number | null;
    currency: string;
    evidence_snippet: string | null;
  } | null;
  failure_reason: string | null;
  expected_behavior: string;
  expected_total?: number;
  price_within_tolerance?: boolean;
  timestamp: string;
  duration_ms: number;
  checks: Array<{
    name: string;
    expected: string;
    actual: string;
    passed: boolean;
  }>;
}

// System Logic Baseline definition - array-driven for future extensibility
interface SystemLogicBaseline {
  id: string;
  name: string;
  version: string;
  description: string;
  checkMode: string; // Edge function mode to call
  invariants: Array<{
    id: string;
    label: string;
    description: string;
  }>;
}

// Array of system-level baselines - add new ones here
const SYSTEM_LOGIC_BASELINES: SystemLogicBaseline[] = [
  {
    id: 'finalization',
    name: 'Finalization & Deterministic Results',
    version: '1.0.0',
    description: 'Ensures results are never shown until fully finalized, snapshots are immutable, and refreshes are deterministic.',
    checkMode: 'finalization-canonical-check',
    invariants: [
      { id: 'no_early_render', label: 'No results before all platforms finalised', description: 'Results page never renders until finalised_at and final_results_snapshot are set' },
      { id: 'immutable_snapshot', label: 'Completed search has immutable snapshot', description: 'Once finalised_at is set, final_results_snapshot never changes' },
      { id: 'deterministic_refresh', label: 'Page refresh is deterministic', description: 'Refreshing a completed search shows identical results every time' },
      { id: 'all_platforms_included', label: 'All discovered platforms in final snapshot', description: 'Every platform in search_platforms appears in final_results_snapshot' },
      { id: 'no_post_mutation', label: 'No post-finalisation UI mutation', description: 'After terminal freeze, no background polling or SSE updates mutate displayed results' },
      { id: 'progress_observable', label: 'Finalisation progress is observable (X/Y)', description: 'Users see real-time count of platforms reaching terminal status during finalization' },
    ],
  },
];

export function BaselineInfoPanel() {
  const { getToken } = useAdminAuth();
  const [baseline, setBaseline] = useState<BaselineData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showExpectations, setShowExpectations] = useState(false);
  const [showLogicChecks, setShowLogicChecks] = useState(false);
  const [showSystemLogicBaselines, setShowSystemLogicBaselines] = useState(true);
  const [expandedSystemBaselines, setExpandedSystemBaselines] = useState<Set<string>>(new Set());
  
  // Provider CANARY checks (live capability)
  const [browserlessCanary, setBrowserlessCanary] = useState<CanaryCheckResult | null>(null);
  const [checkingBrowserlessCanary, setCheckingBrowserlessCanary] = useState(false);
  const [browserlessCanaryError, setBrowserlessCanaryError] = useState<string | null>(null);
  
  const [zyteCanary, setZyteCanary] = useState<CanaryCheckResult | null>(null);
  const [checkingZyteCanary, setCheckingZyteCanary] = useState(false);
  const [zyteCanaryError, setZyteCanaryError] = useState<string | null>(null);
  
  // Firecrawl removed from baseline - not used for Airbnb price discovery
  
  // Logic validation checks (deterministic)
  const [browserlessLogic, setBrowserlessLogic] = useState<CanonicalCheckResult | null>(null);
  const [checkingBrowserlessLogic, setCheckingBrowserlessLogic] = useState(false);
  const [browserlessLogicError, setBrowserlessLogicError] = useState<string | null>(null);
  
  const [zyteLogic, setZyteLogic] = useState<CanonicalCheckResult | null>(null);
  const [checkingZyteLogic, setCheckingZyteLogic] = useState(false);
  const [zyteLogicError, setZyteLogicError] = useState<string | null>(null);
  
  // Firecrawl logic removed from baseline - not used for Airbnb price discovery
  
  const [chainLogic, setChainLogic] = useState<CanonicalCheckResult | null>(null);
  const [checkingChainLogic, setCheckingChainLogic] = useState(false);
  const [chainLogicError, setChainLogicError] = useState<string | null>(null);
  
  const [finalizationLogic, setFinalizationLogic] = useState<CanonicalCheckResult | null>(null);
  const [checkingFinalizationLogic, setCheckingFinalizationLogic] = useState(false);
  const [finalizationLogicError, setFinalizationLogicError] = useState<string | null>(null);
  
  // Guards to prevent duplicate runs and handle cleanup
  const hasRunInitialChecks = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const isRunningRef = useRef(false);

  // Run Browserless CANARY check (live provider capability)
  const runBrowserlessCanary = useCallback(async (signal?: AbortSignal) => {
    if (signal?.aborted) return;
    setCheckingBrowserlessCanary(true);
    setBrowserlessCanaryError(null);
    try {
      const { data, error: invokeError } = await supabase.functions.invoke('airbnb-selftest?mode=browserless-canary', {
        method: 'GET',
      });
      
      if (signal?.aborted) return;
      if (invokeError) throw invokeError;
      setBrowserlessCanary(data as CanaryCheckResult);
    } catch (err: any) {
      if (signal?.aborted) return;
      console.error('Browserless canary check failed:', err);
      setBrowserlessCanaryError(err?.message || 'Failed to run check');
    } finally {
      if (!signal?.aborted) {
        setCheckingBrowserlessCanary(false);
      }
    }
  }, []);
  
  // Run Zyte CANARY check
  const runZyteCanary = useCallback(async (signal?: AbortSignal) => {
    if (signal?.aborted) return;
    setCheckingZyteCanary(true);
    setZyteCanaryError(null);
    try {
      const { data, error: invokeError } = await supabase.functions.invoke('airbnb-selftest?mode=zyte-canary', {
        method: 'GET',
      });
      
      if (signal?.aborted) return;
      if (invokeError) throw invokeError;
      setZyteCanary(data as CanaryCheckResult);
    } catch (err: any) {
      if (signal?.aborted) return;
      console.error('Zyte canary check failed:', err);
      setZyteCanaryError(err?.message || 'Failed to run check');
    } finally {
      if (!signal?.aborted) {
        setCheckingZyteCanary(false);
      }
    }
  }, []);
  
  // Firecrawl CANARY check removed - not used for Airbnb price discovery

  // Run Browserless logic validation (deterministic)
  const runBrowserlessLogic = useCallback(async (signal?: AbortSignal) => {
    if (signal?.aborted) return;
    setCheckingBrowserlessLogic(true);
    setBrowserlessLogicError(null);
    try {
      const { data, error: invokeError } = await supabase.functions.invoke('airbnb-selftest?mode=canonical-check', {
        method: 'GET',
      });
      
      if (signal?.aborted) return;
      if (invokeError) throw invokeError;
      setBrowserlessLogic(data as CanonicalCheckResult);
    } catch (err: any) {
      if (signal?.aborted) return;
      console.error('Browserless logic check failed:', err);
      setBrowserlessLogicError(err?.message || 'Failed to run check');
    } finally {
      if (!signal?.aborted) {
        setCheckingBrowserlessLogic(false);
      }
    }
  }, []);
  
  // Run Zyte logic validation
  const runZyteLogic = useCallback(async (signal?: AbortSignal) => {
    if (signal?.aborted) return;
    setCheckingZyteLogic(true);
    setZyteLogicError(null);
    try {
      const { data, error: invokeError } = await supabase.functions.invoke('airbnb-selftest?mode=zyte-canonical-check', {
        method: 'GET',
      });
      
      if (signal?.aborted) return;
      if (invokeError) throw invokeError;
      setZyteLogic(data as CanonicalCheckResult);
    } catch (err: any) {
      if (signal?.aborted) return;
      console.error('Zyte logic check failed:', err);
      setZyteLogicError(err?.message || 'Failed to run check');
    } finally {
      if (!signal?.aborted) {
        setCheckingZyteLogic(false);
      }
    }
  }, []);
  
  // Firecrawl logic validation removed - not used for Airbnb price discovery
  
  // Run Chain logic validation
  const runChainLogic = useCallback(async (signal?: AbortSignal) => {
    if (signal?.aborted) return;
    setCheckingChainLogic(true);
    setChainLogicError(null);
    try {
      const { data, error: invokeError } = await supabase.functions.invoke('airbnb-selftest?mode=baseline-chain-canonical-check', {
        method: 'GET',
      });
      
      if (signal?.aborted) return;
      if (invokeError) throw invokeError;
      setChainLogic(data as CanonicalCheckResult);
    } catch (err: any) {
      if (signal?.aborted) return;
      console.error('Chain logic check failed:', err);
      setChainLogicError(err?.message || 'Failed to run check');
    } finally {
      if (!signal?.aborted) {
        setCheckingChainLogic(false);
      }
    }
  }, []);
  
  // Run Finalization logic validation
  const runFinalizationLogic = useCallback(async (signal?: AbortSignal) => {
    if (signal?.aborted) return;
    setCheckingFinalizationLogic(true);
    setFinalizationLogicError(null);
    try {
      const { data, error: invokeError } = await supabase.functions.invoke('airbnb-selftest?mode=finalization-canonical-check', {
        method: 'GET',
      });
      
      if (signal?.aborted) return;
      
      // Handle structured error in response (HTTP 200 with error field)
      if (data?.error && !data?.passed) {
        setFinalizationLogicError(`${data.error.code}: ${data.error.message}`);
        // Still set the data so we can display partial info (checks, etc.)
        setFinalizationLogic(data as CanonicalCheckResult);
      } else if (invokeError) {
        throw invokeError;
      } else {
        setFinalizationLogic(data as CanonicalCheckResult);
      }
    } catch (err: any) {
      if (signal?.aborted) return;
      console.error('Finalization logic check failed:', err);
      // Provide actionable error message instead of generic "non-2xx"
      const errorMessage = err?.message || 'Failed to run check';
      const friendlyMessage = errorMessage.includes('non-2xx') 
        ? 'Baseline check could not run - see logs for details'
        : errorMessage;
      setFinalizationLogicError(friendlyMessage);
    } finally {
      if (!signal?.aborted) {
        setCheckingFinalizationLogic(false);
      }
    }
  }, []);
  
  // Run all checks with re-entrancy guard
  const runAllChecks = useCallback((signal?: AbortSignal) => {
    // Prevent overlapping runs
    if (isRunningRef.current) {
      console.log('Checks already running, skipping');
      return;
    }
    
    isRunningRef.current = true;
    
    // Run canary + logic checks in parallel (Firecrawl removed - not used for Airbnb)
    Promise.all([
      runBrowserlessCanary(signal),
      runZyteCanary(signal),
      runBrowserlessLogic(signal),
      runZyteLogic(signal),
      runChainLogic(signal),
      runFinalizationLogic(signal),
    ]).finally(() => {
      isRunningRef.current = false;
    });
  }, [runBrowserlessCanary, runZyteCanary, runBrowserlessLogic, runZyteLogic, runChainLogic, runFinalizationLogic]);
  
  // Handler for user-initiated "Check All" button
  const handleCheckAll = useCallback(() => {
    // Cancel any previous in-flight requests
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();
    runAllChecks(abortControllerRef.current.signal);
  }, [runAllChecks]);
  
  // Individual refresh handlers
  const handleBrowserlessCanaryRefresh = useCallback(() => {
    runBrowserlessCanary();
  }, [runBrowserlessCanary]);
  
  const handleZyteCanaryRefresh = useCallback(() => {
    runZyteCanary();
  }, [runZyteCanary]);
  
  // Firecrawl refresh handler removed - not used for Airbnb price discovery

  // Fetch baseline data on mount (once only)
  useEffect(() => {
    let cancelled = false;
    
    async function fetchBaseline() {
      try {
        const token = getToken();
        if (!token) {
          if (!cancelled) setError('Not authenticated');
          return;
        }

        const { data, error: invokeError } = await supabase.functions.invoke('admin-dashboard/baseline', {
          headers: { Authorization: `Bearer ${token}` },
          method: 'GET',
        });

        if (cancelled) return;
        if (invokeError) throw invokeError;
        setBaseline(data);
        setError(null);
      } catch (err: any) {
        if (cancelled) return;
        console.error('Failed to fetch baseline:', err);
        setError(err?.message || 'Failed to fetch baseline');
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    fetchBaseline();
    
    return () => {
      cancelled = true;
    };
  }, []);
  
  // Run checks exactly once on mount
  useEffect(() => {
    // Strict guard: only run once ever per component instance
    if (hasRunInitialChecks.current) {
      return;
    }
    hasRunInitialChecks.current = true;
    
    // Create abort controller for cleanup
    abortControllerRef.current = new AbortController();
    runAllChecks(abortControllerRef.current.signal);
    
    // Cleanup: abort in-flight requests on unmount
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [runAllChecks]);

  const expectationsByCategory = getExpectationsByCategory();
  
  // Format timestamp for display
  const formatTimestamp = (timestamp: string) => {
    try {
      const date = new Date(timestamp);
      return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch {
      return '—';
    }
  };
  
  // Check if any checks are running (Firecrawl removed)
  const isAnyCheckRunning = checkingBrowserlessCanary || checkingZyteCanary || 
    checkingBrowserlessLogic || checkingZyteLogic || checkingChainLogic || checkingFinalizationLogic;
  
  // Helper to render a provider canary indicator (compact card)
  const renderCanaryIndicator = (
    label: string,
    check: CanaryCheckResult | null,
    checking: boolean,
    error: string | null,
    onRefresh: () => void
  ) => (
    <div className={`p-2.5 rounded-lg border ${
      check?.passed 
        ? 'bg-green-500/10 border-green-500/30' 
        : error || (check && !check.passed)
          ? 'bg-destructive/10 border-destructive/30'
          : 'bg-muted/50 border-border'
    }`}>
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5">
          {checking ? (
            <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground" />
          ) : check?.passed ? (
            <ShieldCheck className="h-3 w-3 text-green-500" />
          ) : error || (check && !check.passed) ? (
            <ShieldAlert className="h-3 w-3 text-destructive" />
          ) : (
            <Shield className="h-3 w-3 text-muted-foreground" />
          )}
          <span className="text-xs font-medium">{label}</span>
          <Badge 
            variant={check?.passed ? 'default' : 'destructive'} 
            className="text-[9px] px-1 py-0 h-4"
          >
            {checking 
              ? '...' 
              : check?.passed 
                ? 'PASS' 
                : error 
                  ? 'ERR' 
                  : check 
                    ? 'FAIL' 
                    : '—'}
          </Badge>
        </div>
        <Button 
          variant="ghost" 
          size="sm" 
          onClick={onRefresh}
          disabled={checking}
          className="h-5 w-5 p-0"
        >
          <RefreshCw className={`h-2.5 w-2.5 ${checking ? 'animate-spin' : ''}`} />
        </Button>
      </div>
      
      {check && (
        <div className="space-y-1 text-[10px]">
          {/* Test inputs used - URL and dates */}
          <div className="bg-muted/30 rounded px-1.5 py-1 space-y-0.5">
            <div className="flex items-center gap-1 text-muted-foreground">
              <span className="font-medium">Tested:</span>
              <code className="text-[9px] truncate max-w-[200px]" title={check.canary_url}>
                {check.canary_dates.check_in} → {check.canary_dates.check_out} ({check.canary_dates.nights}n)
              </code>
            </div>
            <div className="text-[9px] text-muted-foreground/70 truncate" title={check.canary_url}>
              {check.canary_url}
            </div>
          </div>
          
          {/* Status and price with expected comparison */}
          <div className="flex items-center justify-between">
            <code className={`px-1 py-0.5 rounded ${
              check.extraction_result?.status === 'total_price_including_taxes_and_fees'
                ? 'bg-green-500/20 text-green-700'
                : check.extraction_result?.status?.startsWith('http_')
                  ? 'bg-destructive/20 text-destructive'
                  : 'bg-amber-500/20 text-amber-700'
            }`}>
              {check.extraction_result?.status?.replace(/_/g, ' ').slice(0, 25) || 'no result'}
            </code>
            <div className="flex items-center gap-1">
              {check.extraction_result?.price && (
                <span className={`font-mono text-[10px] ${
                  check.price_within_tolerance === false ? 'text-destructive' : ''
                }`}>
                  ${check.extraction_result.price.toLocaleString()}
                </span>
              )}
              {check.expected_total && (
                <span className="text-muted-foreground">
                  (exp: ${check.expected_total.toLocaleString()})
                </span>
              )}
            </div>
          </div>
          
          {/* Price tolerance indicator */}
          {check.extraction_result?.price && check.expected_total && (
            <div className={`flex items-center gap-1 ${
              check.price_within_tolerance ? 'text-green-600' : 'text-destructive'
            }`}>
              {check.price_within_tolerance ? '✓' : '✗'} 
              {check.price_within_tolerance 
                ? 'Price within tolerance' 
                : `Price differs from expected (~${((Math.abs(check.extraction_result.price - check.expected_total) / check.expected_total) * 100).toFixed(0)}%)`
              }
            </div>
          )}
          
          {/* Timestamp and duration */}
          <div className="flex items-center gap-1 text-muted-foreground">
            <Clock className="h-2.5 w-2.5" />
            <span>{formatTimestamp(check.timestamp)}</span>
            {check.duration_ms && (
              <span>({(check.duration_ms / 1000).toFixed(1)}s)</span>
            )}
          </div>
          
          {/* Failure reason - show full detail for HTTP errors */}
          {check.failure_reason && (
            <div className="text-destructive text-[9px] break-words" title={check.failure_reason}>
              ✗ {check.failure_reason.slice(0, 200)}{check.failure_reason.length > 200 ? '...' : ''}
            </div>
          )}
        </div>
      )}
      
      {error && (
        <div className="text-[10px] text-destructive truncate">{error}</div>
      )}
    </div>
  );
  
  // Helper to render a compact logic check indicator
  const renderLogicCheckIndicator = (
    label: string,
    check: CanonicalCheckResult | null,
    checking: boolean,
    error: string | null
  ) => (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] ${
            check?.passed 
              ? 'bg-green-500/10 text-green-600' 
              : error || (check && !check.passed)
                ? 'bg-destructive/10 text-destructive'
                : 'bg-muted/50 text-muted-foreground'
          }`}>
            {checking ? (
              <RefreshCw className="h-2 w-2 animate-spin" />
            ) : check?.passed ? (
              <CheckCircle2 className="h-2 w-2" />
            ) : error || (check && !check.passed) ? (
              <AlertCircle className="h-2 w-2" />
            ) : (
              <Activity className="h-2 w-2" />
            )}
            <span>{label}</span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs">
          <div className="text-xs">
            <strong>{label} Logic</strong>
            {check && (
              <div className="mt-1">
                {check.passed ? (
                  <span className="text-green-600">All {check.checks.length} checks passed</span>
                ) : (
                  <div className="text-destructive">
                    {check.checks.filter(c => !c.passed).map((c, i) => (
                      <div key={i}>✗ {c.name}</div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {error && <div className="text-destructive mt-1">{error}</div>}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );

  if (loading) {
    return (
      <Card className="border-border/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Shield className="h-4 w-4" />
            Current Stable Baseline
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground">Loading...</div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="border-destructive/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Shield className="h-4 w-4" />
            Current Stable Baseline
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-destructive flex items-center gap-2">
            <AlertCircle className="h-4 w-4" />
            {error}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!baseline) {
    return (
      <Card className="border-warning/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Shield className="h-4 w-4" />
            Current Stable Baseline
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-warning">No active baseline declared</div>
        </CardContent>
      </Card>
    );
  }

  const declaredDate = new Date(baseline.declared_at);
  const formattedDate = declaredDate.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <Card className="border-primary/20 bg-primary/5">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Shield className="h-4 w-4 text-primary" />
            Current Stable Baseline
          </CardTitle>
          <Badge variant="outline" className="border-primary/50 text-primary">
            <CheckCircle2 className="h-3 w-3 mr-1" />
            Active
          </Badge>
        </div>
        <CardDescription className="text-xs">
          Reference point for debugging and regression analysis
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        
        {/* Provider Capability Guards (Live Canary) */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Zap className="h-3.5 w-3.5 text-amber-500" />
              <span className="text-xs font-medium">Provider Canary Checks</span>
            </div>
            <Button 
              variant="ghost" 
              size="sm" 
              onClick={handleCheckAll}
              disabled={isAnyCheckRunning}
              className="h-6 px-2 text-xs"
            >
              <RefreshCw className={`h-3 w-3 mr-1 ${isAnyCheckRunning ? 'animate-spin' : ''}`} />
              Check All
            </Button>
          </div>
          
          {/* Canary Scenario Header - Shows the exact test inputs */}
          <div className="p-2 bg-muted/40 rounded-md border border-border/50 text-[10px] space-y-1">
            <div className="flex items-center gap-1 font-medium text-muted-foreground">
              <span>📍 Canary Scenario:</span>
              <span className="text-foreground">Airbnb Room 903802242341279498</span>
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-muted-foreground">
              <span>
                <span className="font-medium">Dates:</span>{' '}
                <code className="bg-muted px-1 rounded text-foreground">2026-03-01</code>
                {' → '}
                <code className="bg-muted px-1 rounded text-foreground">2026-03-04</code>
                {' (3 nights)'}
              </span>
              <span>
                <span className="font-medium">Guests:</span>{' '}
                <code className="bg-muted px-1 rounded text-foreground">1 adult</code>
              </span>
              <span>
                <span className="font-medium">Expected:</span>{' '}
                <code className="bg-muted px-1 rounded text-foreground">~$1,659</code>
              </span>
            </div>
            <div className="text-[9px] text-muted-foreground/70 truncate">
              URL: https://www.airbnb.com/rooms/903802242341279498?check_in=2026-03-01&check_out=2026-03-04&adults=1
            </div>
          </div>
          
          {/* Provider canary cards - Browserless and Zyte only (Firecrawl not used for Airbnb) */}
          <div className="grid grid-cols-1 gap-2">
            {renderCanaryIndicator('Browserless', browserlessCanary, checkingBrowserlessCanary, browserlessCanaryError, handleBrowserlessCanaryRefresh)}
            {renderCanaryIndicator('Zyte', zyteCanary, checkingZyteCanary, zyteCanaryError, handleZyteCanaryRefresh)}
          </div>
          
          <div className="text-[10px] text-muted-foreground">
            Each provider runs against the canary URL above. PASS requires verified total within ±5% of expected.
          </div>
        </div>
        
        {/* Logic Validation Checks (Deterministic) */}
        <Collapsible open={showLogicChecks} onOpenChange={setShowLogicChecks}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="w-full justify-between px-2 py-1 h-auto">
              <div className="flex items-center gap-2">
                <Activity className="h-3 w-3 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">Logic Validation</span>
              </div>
              <div className="flex items-center gap-1">
                <div className="flex items-center gap-0.5">
                  {renderLogicCheckIndicator('B', browserlessLogic, checkingBrowserlessLogic, browserlessLogicError)}
                  {renderLogicCheckIndicator('Z', zyteLogic, checkingZyteLogic, zyteLogicError)}
                  {renderLogicCheckIndicator('C', chainLogic, checkingChainLogic, chainLogicError)}
                </div>
                {showLogicChecks ? (
                  <ChevronDown className="h-3 w-3 ml-1" />
                ) : (
                  <ChevronRight className="h-3 w-3 ml-1" />
                )}
              </div>
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2">
            <div className="text-[10px] text-muted-foreground p-2 bg-muted/30 rounded">
              Deterministic unit tests (B=Browserless, Z=Zyte, C=Chain) validating extraction logic with mock data.
            </div>
          </CollapsibleContent>
        </Collapsible>

        {/* System Logic Baselines - array-driven */}
        <Collapsible open={showSystemLogicBaselines} onOpenChange={setShowSystemLogicBaselines}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="w-full justify-between px-2 py-1 h-auto">
              <div className="flex items-center gap-2">
                <FileCheck2 className="h-3.5 w-3.5 text-primary" />
                <span className="text-xs font-medium">System Logic Baselines</span>
              </div>
              <div className="flex items-center gap-1">
                {/* Summary status badges */}
                {SYSTEM_LOGIC_BASELINES.map((baseline) => {
                  const isFinalization = baseline.id === 'finalization';
                  const check = isFinalization ? finalizationLogic : null;
                  const checking = isFinalization ? checkingFinalizationLogic : false;
                  const error = isFinalization ? finalizationLogicError : null;
                  
                  return (
                    <Badge 
                      key={baseline.id}
                      variant={check?.passed ? 'default' : (error || (check && !check.passed)) ? 'destructive' : 'outline'}
                      className="text-[9px] px-1.5 py-0 h-4"
                    >
                      {checking ? '...' : check?.passed ? 'PASS' : error ? 'ERR' : check ? 'FAIL' : '—'}
                    </Badge>
                  );
                })}
                {showSystemLogicBaselines ? (
                  <ChevronDown className="h-3 w-3 ml-1" />
                ) : (
                  <ChevronRight className="h-3 w-3 ml-1" />
                )}
              </div>
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2 space-y-2">
            {SYSTEM_LOGIC_BASELINES.map((sysBaseline) => {
              const isFinalization = sysBaseline.id === 'finalization';
              const check = isFinalization ? finalizationLogic : null;
              const checking = isFinalization ? checkingFinalizationLogic : false;
              const error = isFinalization ? finalizationLogicError : null;
              const isExpanded = expandedSystemBaselines.has(sysBaseline.id);
              
              const toggleExpanded = () => {
                setExpandedSystemBaselines(prev => {
                  const next = new Set(prev);
                  if (next.has(sysBaseline.id)) {
                    next.delete(sysBaseline.id);
                  } else {
                    next.add(sysBaseline.id);
                  }
                  return next;
                });
              };
              
              return (
                <div 
                  key={sysBaseline.id}
                  className={`rounded-lg border ${
                    check?.passed 
                      ? 'bg-green-500/10 border-green-500/30' 
                      : error || (check && !check.passed)
                        ? 'bg-destructive/10 border-destructive/30'
                        : 'bg-muted/50 border-border'
                  }`}
                >
                  {/* Baseline Header */}
                  <button 
                    onClick={toggleExpanded}
                    className="w-full p-2.5 flex items-center justify-between hover:bg-muted/30 rounded-t-lg transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      {checking ? (
                        <RefreshCw className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                      ) : check?.passed ? (
                        <ShieldCheck className="h-3.5 w-3.5 text-green-500" />
                      ) : error || (check && !check.passed) ? (
                        <ShieldAlert className="h-3.5 w-3.5 text-destructive" />
                      ) : (
                        <Shield className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                      <span className="text-xs font-medium">{sysBaseline.name}</span>
                      <Badge 
                        variant="outline" 
                        className="text-[9px] px-1 py-0 h-4 border-muted-foreground/30"
                      >
                        v{sysBaseline.version}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge 
                        variant={check?.passed ? 'default' : (error || (check && !check.passed)) ? 'destructive' : 'secondary'}
                        className="text-[9px] px-1.5 py-0 h-4"
                      >
                        {checking ? 'Checking...' : check?.passed ? 'PASS' : error ? 'ERROR' : check ? 'FAIL' : 'Pending'}
                      </Badge>
                      {isExpanded ? (
                        <ChevronDown className="h-3 w-3" />
                      ) : (
                        <ChevronRight className="h-3 w-3" />
                      )}
                    </div>
                  </button>
                  
                  {/* Baseline Details (expanded) */}
                  {isExpanded && (
                    <div className="px-2.5 pb-2.5 space-y-2">
                      <p className="text-[10px] text-muted-foreground">{sysBaseline.description}</p>
                      
                      {/* Timestamp */}
                      {check?.timestamp && (
                        <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                          <Clock className="h-2.5 w-2.5" />
                          <span>Last checked: {formatTimestamp(check.timestamp)}</span>
                        </div>
                      )}
                      
                      {/* Error display - shows structured error with actionable info */}
                      {(error || check?.error) && (
                        <div className="text-[10px] bg-destructive/10 rounded px-2 py-1.5 space-y-1">
                          <div className="text-destructive font-medium flex items-center gap-1">
                            <AlertCircle className="h-3 w-3" />
                            {check?.error?.code || 'ERROR'}: {check?.error?.message || error || 'Check failed'}
                          </div>
                          {check?.error?.details && Array.isArray(check.error.details) && check.error.details.length > 0 && (
                            <Collapsible>
                              <CollapsibleTrigger className="text-[9px] text-muted-foreground hover:text-foreground flex items-center gap-1">
                                <ChevronRight className="h-2 w-2" />
                                Show details ({check.error.details.length} failed)
                              </CollapsibleTrigger>
                              <CollapsibleContent className="text-[9px] text-muted-foreground pt-1 pl-3">
                                {check.error.details.map((d, i) => (
                                  <div key={i}>• {d}</div>
                                ))}
                              </CollapsibleContent>
                            </Collapsible>
                          )}
                        </div>
                      )}
                      
                      {/* Invariant checks */}
                      <div className="space-y-1.5 pt-1 border-t border-border/50">
                        <span className="text-[10px] font-medium text-muted-foreground">Invariant Checks:</span>
                        <ul className="space-y-1">
                          {sysBaseline.invariants.map((inv) => {
                            // Map UI invariant IDs to edge function check names
                            const checkNameMap: Record<string, string[]> = {
                              'no_early_render': ['no_results_before_finalization'],
                              'immutable_snapshot': ['atomic_finalization_invariant'],
                              'deterministic_refresh': ['atomic_finalization_invariant'],
                              'all_platforms_included': ['all_platforms_in_snapshot'],
                              'no_post_mutation': ['terminal_freeze_blocks_mutations'],
                              'progress_observable': ['terminal_statuses_defined'],
                            };
                            
                            const matchingCheck = check?.checks?.find(c => 
                              checkNameMap[inv.id]?.includes(c.name) ||
                              c.name.toLowerCase().includes(inv.id.replace(/_/g, '_').toLowerCase())
                            );
                            // Only show as passed/failed if we have the check data, otherwise show pending
                            const invPassed = matchingCheck ? matchingCheck.passed : (check ? check.passed : null);
                            
                            return (
                              <li 
                                key={inv.id}
                                className="flex items-start gap-2 text-[10px]"
                                title={inv.description}
                              >
                                {invPassed === true ? (
                                  <CheckCircle2 className="h-3 w-3 text-green-500 mt-0.5 shrink-0" />
                                ) : invPassed === false ? (
                                  <AlertCircle className="h-3 w-3 text-destructive mt-0.5 shrink-0" />
                                ) : (
                                  <div className="h-3 w-3 rounded-full border border-muted-foreground/30 mt-0.5 shrink-0" />
                                )}
                                <span className={invPassed === false ? 'text-destructive' : ''}>
                                  {inv.label}
                                </span>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            
            <div className="text-[9px] text-muted-foreground pt-1">
              System-level invariants that protect core behaviour across all searches.
            </div>
          </CollapsibleContent>
        </Collapsible>

        {/* Baseline Identity */}
        <div className="grid grid-cols-2 gap-3 text-sm pt-2 border-t">
          <div className="flex items-center gap-2">
            <Tag className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">Name:</span>
            <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
              {baseline.baseline_name}
            </code>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">Version:</span>
            <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
              v{baseline.baseline_version}
            </code>
          </div>
        </div>

        <div className="flex items-center gap-2 text-sm">
          <Clock className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-muted-foreground">Declared:</span>
          <span>{formattedDate}</span>
          {baseline.declared_by && (
            <span className="text-muted-foreground">by {baseline.declared_by}</span>
          )}
        </div>

        {baseline.git_commit_hash && (
          <div className="flex items-center gap-2 text-sm">
            <GitCommit className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">Commit:</span>
            <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
              {baseline.git_commit_hash.slice(0, 8)}
            </code>
          </div>
        )}

        {baseline.notes && (
          <p className="text-xs text-muted-foreground border-t pt-2 mt-2">
            {baseline.notes}
          </p>
        )}

        {/* Expandable Expectations */}
        <Collapsible open={showExpectations} onOpenChange={setShowExpectations}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="w-full justify-between mt-2">
              <span className="text-xs">
                Baseline Expectations ({BASELINE_EXPECTATIONS.length})
              </span>
              {showExpectations ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2 space-y-3">
            {Object.entries(expectationsByCategory).map(([category, expectations]) => (
              <div key={category} className="space-y-1.5">
                <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  {CATEGORY_LABELS[category] || category}
                </h4>
                <ul className="space-y-1">
                  {expectations.map((exp) => (
                    <li
                      key={exp.id}
                      className="flex items-start gap-2 text-xs"
                      title={exp.observable}
                    >
                      <CheckCircle2 className="h-3 w-3 text-primary mt-0.5 shrink-0" />
                      <span>
                        {exp.description}
                        {exp.critical && (
                          <Badge variant="destructive" className="ml-1.5 text-[10px] px-1 py-0">
                            Critical
                          </Badge>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  );
}
