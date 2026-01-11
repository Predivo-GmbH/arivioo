import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Button } from '@/components/ui/button';
import { Shield, ChevronDown, ChevronRight, CheckCircle2, AlertCircle, Clock, GitCommit, Tag, RefreshCw, ShieldCheck, ShieldAlert } from 'lucide-react';
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

interface CanonicalCheckResult {
  mode: 'canonical-check' | 'zyte-canonical-check';
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

export function BaselineInfoPanel() {
  const { getToken } = useAdminAuth();
  const [baseline, setBaseline] = useState<BaselineData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showExpectations, setShowExpectations] = useState(false);
  
  // Browserless canonical baseline check state
  const [browserlessCheck, setBrowserlessCheck] = useState<CanonicalCheckResult | null>(null);
  const [checkingBrowserless, setCheckingBrowserless] = useState(false);
  const [browserlessError, setBrowserlessError] = useState<string | null>(null);
  
  // Zyte canonical baseline check state
  const [zyteCheck, setZyteCheck] = useState<CanonicalCheckResult | null>(null);
  const [checkingZyte, setCheckingZyte] = useState(false);
  const [zyteError, setZyteError] = useState<string | null>(null);
  
  // Firecrawl canonical baseline check state
  const [firecrawlCheck, setFirecrawlCheck] = useState<CanonicalCheckResult | null>(null);
  const [checkingFirecrawl, setCheckingFirecrawl] = useState(false);
  const [firecrawlError, setFirecrawlError] = useState<string | null>(null);

  // Fetch Browserless canonical check
  const runBrowserlessCheck = async () => {
    setCheckingBrowserless(true);
    setBrowserlessError(null);
    try {
      const { data, error: invokeError } = await supabase.functions.invoke('airbnb-selftest?mode=canonical-check', {
        method: 'GET',
      });
      
      if (invokeError) throw invokeError;
      setBrowserlessCheck(data as CanonicalCheckResult);
    } catch (err: any) {
      console.error('Browserless canonical check failed:', err);
      setBrowserlessError(err?.message || 'Failed to run check');
    } finally {
      setCheckingBrowserless(false);
    }
  };
  
  // Fetch Zyte canonical check
  const runZyteCheck = async () => {
    setCheckingZyte(true);
    setZyteError(null);
    try {
      const { data, error: invokeError } = await supabase.functions.invoke('airbnb-selftest?mode=zyte-canonical-check', {
        method: 'GET',
      });
      
      if (invokeError) throw invokeError;
      setZyteCheck(data as CanonicalCheckResult);
    } catch (err: any) {
      console.error('Zyte canonical check failed:', err);
      setZyteError(err?.message || 'Failed to run check');
    } finally {
      setCheckingZyte(false);
    }
  };
  
  // Fetch Firecrawl canonical check
  const runFirecrawlCheck = async () => {
    setCheckingFirecrawl(true);
    setFirecrawlError(null);
    try {
      const { data, error: invokeError } = await supabase.functions.invoke('airbnb-selftest?mode=firecrawl-canonical-check', {
        method: 'GET',
      });
      
      if (invokeError) throw invokeError;
      setFirecrawlCheck(data as CanonicalCheckResult);
    } catch (err: any) {
      console.error('Firecrawl canonical check failed:', err);
      setFirecrawlError(err?.message || 'Failed to run check');
    } finally {
      setCheckingFirecrawl(false);
    }
  };
  
  // Run all checks
  const runAllChecks = () => {
    runBrowserlessCheck();
    runZyteCheck();
    runFirecrawlCheck();
  };

  useEffect(() => {
    async function fetchBaseline() {
      try {
        const token = getToken();
        if (!token) {
          setError('Not authenticated');
          return;
        }

        const { data, error: invokeError } = await supabase.functions.invoke('admin-dashboard/baseline', {
          headers: { Authorization: `Bearer ${token}` },
          method: 'GET',
        });

        if (invokeError) throw invokeError;
        setBaseline(data);
        setError(null);
      } catch (err: any) {
        console.error('Failed to fetch baseline:', err);
        setError(err?.message || 'Failed to fetch baseline');
      } finally {
        setLoading(false);
      }
    }

    fetchBaseline();
    runAllChecks(); // Run Browserless, Zyte, and Firecrawl checks on mount
  }, [getToken]);

  const expectationsByCategory = getExpectationsByCategory();
  
  // Helper to render a canonical check indicator
  const renderCanonicalCheckIndicator = (
    label: string,
    check: CanonicalCheckResult | null,
    checking: boolean,
    error: string | null,
    onRefresh: () => void
  ) => (
    <div className={`p-2 rounded-lg border ${
      check?.passed 
        ? 'bg-green-500/10 border-green-500/30' 
        : error || (check && !check.passed)
          ? 'bg-destructive/10 border-destructive/30'
          : 'bg-muted/50 border-border'
    }`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {checking ? (
            <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground" />
          ) : check?.passed ? (
            <ShieldCheck className="h-3 w-3 text-green-500" />
          ) : error || (check && !check.passed) ? (
            <ShieldAlert className="h-3 w-3 text-destructive" />
          ) : (
            <Shield className="h-3 w-3 text-muted-foreground" />
          )}
          <span className="text-xs font-medium">
            {label}: {checking 
              ? 'Checking...' 
              : check?.passed 
                ? 'Valid' 
                : error 
                  ? 'Error' 
                  : check 
                    ? 'Violation!' 
                    : '—'}
          </span>
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
      {check && !check.passed && (
        <div className="mt-1.5 space-y-0.5">
          {check.checks.filter(c => !c.passed).slice(0, 2).map((c, i) => (
            <div key={i} className="text-[10px] text-destructive truncate">
              ✗ {c.name}
            </div>
          ))}
        </div>
      )}
      {error && (
        <div className="mt-1 text-[10px] text-destructive truncate">{error}</div>
      )}
    </div>
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
      <CardContent className="space-y-3">
        {/* Canonical Baseline Runtime Checks */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">Canonical Baseline Guards</span>
            <Button 
              variant="ghost" 
              size="sm" 
              onClick={runAllChecks}
              disabled={checkingBrowserless || checkingZyte || checkingFirecrawl}
              className="h-6 px-2 text-xs"
            >
              <RefreshCw className={`h-3 w-3 mr-1 ${(checkingBrowserless || checkingZyte || checkingFirecrawl) ? 'animate-spin' : ''}`} />
              Check All
            </Button>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {renderCanonicalCheckIndicator('Browserless', browserlessCheck, checkingBrowserless, browserlessError, runBrowserlessCheck)}
            {renderCanonicalCheckIndicator('Zyte', zyteCheck, checkingZyte, zyteError, runZyteCheck)}
            {renderCanonicalCheckIndicator('Firecrawl', firecrawlCheck, checkingFirecrawl, firecrawlError, runFirecrawlCheck)}
          </div>
        </div>

        {/* Baseline Identity */}
        <div className="grid grid-cols-2 gap-3 text-sm">
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
