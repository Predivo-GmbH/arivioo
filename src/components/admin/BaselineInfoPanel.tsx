import { useState, useEffect, useRef, useCallback } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip';
import { Shield, ChevronDown, ChevronRight, CheckCircle2, AlertCircle, Clock, GitCommit, Tag, RefreshCw, ShieldCheck, ShieldAlert, Zap, Activity } from 'lucide-react';
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

// Canonical check result (logic validation - deterministic)
interface CanonicalCheckResult {
  mode: string;
  passed: boolean;
  checks: Array<{
    name: string;
    expected: string;
    actual: string;
    passed: boolean;
  }>;
  status: string;
  timestamp: string;
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
  timestamp: string;
  duration_ms: number;
  checks: Array<{
    name: string;
    expected: string;
    actual: string;
    passed: boolean;
  }>;
}

type CheckResult = CanonicalCheckResult | CanaryCheckResult;

function isCanaryResult(result: CheckResult): result is CanaryCheckResult {
  return 'provider' in result && 'canary_url' in result;
}

export function BaselineInfoPanel() {
  const { getToken } = useAdminAuth();
  const [baseline, setBaseline] = useState<BaselineData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showExpectations, setShowExpectations] = useState(false);
  const [showLogicChecks, setShowLogicChecks] = useState(false);
  
  // Browserless CANARY check (live capability)
  const [browserlessCanary, setBrowserlessCanary] = useState<CanaryCheckResult | null>(null);
  const [checkingBrowserlessCanary, setCheckingBrowserlessCanary] = useState(false);
  const [browserlessCanaryError, setBrowserlessCanaryError] = useState<string | null>(null);
  
  // Logic validation checks (deterministic)
  const [browserlessLogic, setBrowserlessLogic] = useState<CanonicalCheckResult | null>(null);
  const [checkingBrowserlessLogic, setCheckingBrowserlessLogic] = useState(false);
  const [browserlessLogicError, setBrowserlessLogicError] = useState<string | null>(null);
  
  const [zyteLogic, setZyteLogic] = useState<CanonicalCheckResult | null>(null);
  const [checkingZyteLogic, setCheckingZyteLogic] = useState(false);
  const [zyteLogicError, setZyteLogicError] = useState<string | null>(null);
  
  const [firecrawlLogic, setFirecrawlLogic] = useState<CanonicalCheckResult | null>(null);
  const [checkingFirecrawlLogic, setCheckingFirecrawlLogic] = useState(false);
  const [firecrawlLogicError, setFirecrawlLogicError] = useState<string | null>(null);
  
  const [chainLogic, setChainLogic] = useState<CanonicalCheckResult | null>(null);
  const [checkingChainLogic, setCheckingChainLogic] = useState(false);
  const [chainLogicError, setChainLogicError] = useState<string | null>(null);
  
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
  
  // Run Firecrawl logic validation
  const runFirecrawlLogic = useCallback(async (signal?: AbortSignal) => {
    if (signal?.aborted) return;
    setCheckingFirecrawlLogic(true);
    setFirecrawlLogicError(null);
    try {
      const { data, error: invokeError } = await supabase.functions.invoke('airbnb-selftest?mode=firecrawl-canonical-check', {
        method: 'GET',
      });
      
      if (signal?.aborted) return;
      if (invokeError) throw invokeError;
      setFirecrawlLogic(data as CanonicalCheckResult);
    } catch (err: any) {
      if (signal?.aborted) return;
      console.error('Firecrawl logic check failed:', err);
      setFirecrawlLogicError(err?.message || 'Failed to run check');
    } finally {
      if (!signal?.aborted) {
        setCheckingFirecrawlLogic(false);
      }
    }
  }, []);
  
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
  
  // Run all checks with re-entrancy guard
  const runAllChecks = useCallback((signal?: AbortSignal) => {
    // Prevent overlapping runs
    if (isRunningRef.current) {
      console.log('Checks already running, skipping');
      return;
    }
    
    isRunningRef.current = true;
    
    // Run canary + logic checks in parallel
    Promise.all([
      runBrowserlessCanary(signal),
      runBrowserlessLogic(signal),
      runZyteLogic(signal),
      runFirecrawlLogic(signal),
      runChainLogic(signal),
    ]).finally(() => {
      isRunningRef.current = false;
    });
  }, [runBrowserlessCanary, runBrowserlessLogic, runZyteLogic, runFirecrawlLogic, runChainLogic]);
  
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
  
  // Check if any checks are running
  const isAnyCheckRunning = checkingBrowserlessCanary || checkingBrowserlessLogic || checkingZyteLogic || checkingFirecrawlLogic || checkingChainLogic;
  
  // Helper to render the Browserless canary indicator (main provider capability check)
  const renderBrowserlessCanaryIndicator = () => {
    const check = browserlessCanary;
    const checking = checkingBrowserlessCanary;
    const error = browserlessCanaryError;
    
    return (
      <div className={`p-3 rounded-lg border ${
        check?.passed 
          ? 'bg-green-500/10 border-green-500/30' 
          : error || (check && !check.passed)
            ? 'bg-destructive/10 border-destructive/30'
            : 'bg-muted/50 border-border'
      }`}>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            {checking ? (
              <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : check?.passed ? (
              <ShieldCheck className="h-4 w-4 text-green-500" />
            ) : error || (check && !check.passed) ? (
              <ShieldAlert className="h-4 w-4 text-destructive" />
            ) : (
              <Shield className="h-4 w-4 text-muted-foreground" />
            )}
            <span className="text-sm font-medium">
              Browserless Canary
            </span>
            <Badge variant={check?.passed ? 'default' : 'destructive'} className="text-[10px] px-1.5 py-0">
              {checking 
                ? 'Running...' 
                : check?.passed 
                  ? 'PASSING' 
                  : error 
                    ? 'ERROR' 
                    : check 
                      ? 'FAILING' 
                      : '—'}
            </Badge>
          </div>
          <Button 
            variant="ghost" 
            size="sm" 
            onClick={handleBrowserlessCanaryRefresh}
            disabled={checking}
            className="h-6 w-6 p-0"
          >
            <RefreshCw className={`h-3 w-3 ${checking ? 'animate-spin' : ''}`} />
          </Button>
        </div>
        
        {/* Canary scenario info */}
        {check && (
          <div className="space-y-1.5 text-xs">
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <Clock className="h-3 w-3" />
              <span>Checked: {formatTimestamp(check.timestamp)}</span>
              {check.duration_ms && (
                <span className="text-muted-foreground/70">({(check.duration_ms / 1000).toFixed(1)}s)</span>
              )}
            </div>
            
            <div className="text-muted-foreground">
              Canary: {check.canary_dates.nights} nights ({check.canary_dates.check_in} → {check.canary_dates.check_out})
            </div>
            
            {/* Extraction result */}
            {check.extraction_result && (
              <div className={`p-2 rounded mt-1.5 ${
                check.extraction_result.status === 'total_price_including_taxes_and_fees'
                  ? 'bg-green-500/10'
                  : 'bg-amber-500/10'
              }`}>
                <div className="flex items-center justify-between">
                  <span className="font-medium">
                    Status: <code className="text-[10px]">{check.extraction_result.status}</code>
                  </span>
                  {check.extraction_result.price && (
                    <span className="font-mono">
                      {check.extraction_result.currency} {check.extraction_result.price.toLocaleString()}
                    </span>
                  )}
                </div>
                {check.extraction_result.evidence_snippet && (
                  <div className="mt-1 text-[10px] text-muted-foreground truncate">
                    Evidence: "{check.extraction_result.evidence_snippet}"
                  </div>
                )}
              </div>
            )}
            
            {/* Failure reason */}
            {check.failure_reason && (
              <div className="p-2 rounded bg-destructive/10 text-destructive text-[11px] mt-1.5">
                <strong>Failure:</strong> {check.failure_reason}
              </div>
            )}
            
            {/* Failed checks */}
            {check.checks.filter(c => !c.passed).length > 0 && (
              <div className="mt-1.5 space-y-0.5">
                {check.checks.filter(c => !c.passed).slice(0, 3).map((c, i) => (
                  <div key={i} className="text-[10px] text-destructive">
                    ✗ {c.name}: expected "{c.expected}", got "{c.actual}"
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        
        {error && (
          <div className="mt-1.5 text-xs text-destructive">{error}</div>
        )}
      </div>
    );
  };
  
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
          <div className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs ${
            check?.passed 
              ? 'bg-green-500/10 text-green-600' 
              : error || (check && !check.passed)
                ? 'bg-destructive/10 text-destructive'
                : 'bg-muted/50 text-muted-foreground'
          }`}>
            {checking ? (
              <RefreshCw className="h-2.5 w-2.5 animate-spin" />
            ) : check?.passed ? (
              <CheckCircle2 className="h-2.5 w-2.5" />
            ) : error || (check && !check.passed) ? (
              <AlertCircle className="h-2.5 w-2.5" />
            ) : (
              <Activity className="h-2.5 w-2.5" />
            )}
            <span>{label}</span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs">
          <div className="text-xs">
            <strong>{label} Logic Validation</strong>
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
        
        {/* Provider Capability Guard (Live Canary) */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Zap className="h-3.5 w-3.5 text-amber-500" />
              <span className="text-xs font-medium">Provider Capability Guard</span>
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
          
          {/* Browserless Canary - Primary capability indicator */}
          {renderBrowserlessCanaryIndicator()}
          
          <div className="text-[10px] text-muted-foreground mt-1">
            Live test against fixed canary URL. If Browserless fails to extract a grounded total, it indicates a regression.
          </div>
        </div>
        
        {/* Logic Validation Checks (Deterministic) */}
        <Collapsible open={showLogicChecks} onOpenChange={setShowLogicChecks}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="w-full justify-between px-2 py-1 h-auto">
              <div className="flex items-center gap-2">
                <Activity className="h-3 w-3 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">Logic Validation Guards</span>
              </div>
              <div className="flex items-center gap-1">
                <div className="flex items-center gap-1">
                  {renderLogicCheckIndicator('Browserless', browserlessLogic, checkingBrowserlessLogic, browserlessLogicError)}
                  {renderLogicCheckIndicator('Zyte', zyteLogic, checkingZyteLogic, zyteLogicError)}
                  {renderLogicCheckIndicator('Firecrawl', firecrawlLogic, checkingFirecrawlLogic, firecrawlLogicError)}
                  {renderLogicCheckIndicator('Chain', chainLogic, checkingChainLogic, chainLogicError)}
                </div>
                {showLogicChecks ? (
                  <ChevronDown className="h-3 w-3 ml-2" />
                ) : (
                  <ChevronRight className="h-3 w-3 ml-2" />
                )}
              </div>
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2">
            <div className="text-[10px] text-muted-foreground p-2 bg-muted/30 rounded">
              Deterministic unit tests validating extraction logic, priority rules, and orchestration behavior with mock data.
              These verify the code is correct. Canary checks verify providers work in production.
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
