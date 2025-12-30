import { useState, useEffect } from 'react';
import { Play, RefreshCw, CheckCircle, XCircle, AlertCircle, Clock, Copy, History, ExternalLink, Beaker, AlertTriangle, Eye } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import { useAdminAuth } from '@/hooks/useAdminAuth';
import { format } from 'date-fns';
import { DiagnosticTotalConfirmation } from '@/components/admin/DiagnosticTotalConfirmation';

interface CandidateSummary {
  amount: number;
  currency: string;
  kind: string;
  label_hint: string;
  rejected_reason?: string;
  candidate_type?: string;
}

interface ProviderAttemptResult {
  provider: string;
  status: string;
  price: number | null;
  currency: string | null;
  includes_taxes_fees: boolean;
  evidence_snippet: string;
  error?: string;
  duration_ms: number;
  candidates_summary: CandidateSummary[];
  // OCR validation fields
  ocr_booking_card_amount_value?: number | null;
  ocr_booking_card_snippet?: string | null;
  ocr_breakdown_total_amount_value?: number | null;
  ocr_breakdown_total_snippet?: string | null;
  ocr_validation_status?: string | null;
  ocr_accepted_via?: string | null;
  ocr_mismatch_reason?: string | null;
}

interface ValidationRunResult {
  run_number: number;
  timestamp: string;
  provider_order: string[];
  provider_results: ProviderAttemptResult[];
  final_status: string;
  final_price: number | null;
  final_currency: string | null;
  final_includes_taxes_fees: boolean;
  final_evidence_snippet: string;
  selected_provider?: string;
}

interface TestSummary {
  run_id: string;
  url: string;
  check_in: string;
  check_out: string;
  nights: number;
  total_runs: number;
  consistent: boolean;
  all_prices_match: boolean;
  results: ValidationRunResult[];
}

interface DebugHistoryItem {
  runId: string;
  airbnbUrl: string;
  checkInDate: string;
  checkOutDate: string;
  nightsCount: number;
  createdAt: string;
}

function StatusBadge({ status }: { status: string }) {
  const isSuccess = status.startsWith('total_price_');
  const isBlocked = status.includes('blocked') || status.includes('captcha');
  const isNotSupported = status.includes('not_supported');
  const isNeedsConfirmation = status === 'needs_user_confirmation' || status === 'subtotal_nights_only';
  
  if (isSuccess) {
    return (
      <Badge className="bg-green-500/20 text-green-700 border-green-500/30">
        <CheckCircle className="w-3 h-3 mr-1" />
        {status.replace(/_/g, ' ')}
      </Badge>
    );
  }

  if (isNeedsConfirmation) {
    return (
      <Badge className="bg-amber-500/20 text-amber-700 border-amber-500/30">
        <AlertTriangle className="w-3 h-3 mr-1" />
        Needs Confirmation
      </Badge>
    );
  }
  
  if (isBlocked) {
    return (
      <Badge variant="destructive">
        <XCircle className="w-3 h-3 mr-1" />
        Blocked/Captcha
      </Badge>
    );
  }
  
  if (isNotSupported) {
    return (
      <Badge variant="outline" className="text-orange-600 border-orange-400">
        <AlertCircle className="w-3 h-3 mr-1" />
        Not Supported
      </Badge>
    );
  }
  
  return (
    <Badge variant="secondary">
      <AlertCircle className="w-3 h-3 mr-1" />
      {status.replace(/_/g, ' ')}
    </Badge>
  );
}

function OcrValidationBadge({ status, acceptedVia, mismatchReason }: { 
  status?: string | null; 
  acceptedVia?: string | null;
  mismatchReason?: string | null;
}) {
  if (!status) return null;
  
  const isAccepted = status === 'accepted';
  const isRejected = status === 'rejected';
  
  if (isAccepted) {
    return (
      <div className="flex items-center gap-1">
        <Badge className="bg-emerald-500/20 text-emerald-700 border-emerald-500/30 text-xs">
          <CheckCircle className="w-3 h-3 mr-1" />
          OCR: {acceptedVia?.replace(/_/g, ' ') || 'accepted'}
        </Badge>
      </div>
    );
  }
  
  if (isRejected) {
    return (
      <Badge className="bg-red-500/20 text-red-700 border-red-500/30 text-xs">
        <XCircle className="w-3 h-3 mr-1" />
        OCR Rejected: {mismatchReason?.replace(/_/g, ' ') || 'mismatch'}
      </Badge>
    );
  }
  
  return (
    <Badge variant="outline" className="text-xs text-muted-foreground">
      OCR: {status}
    </Badge>
  );
}

function ProviderResultCard({ result }: { result: ProviderAttemptResult }) {
  const isSuccess = result.status.startsWith('total_price_');
  const hasOcrData = result.ocr_booking_card_amount_value || result.ocr_breakdown_total_amount_value;
  
  // Calculate OCR baseline and diff for comparison
  const ocrBaseline = result.ocr_breakdown_total_amount_value || result.ocr_booking_card_amount_value;
  const providerPrice = result.price;
  const priceDiff = (providerPrice && ocrBaseline) ? providerPrice - ocrBaseline : null;
  const priceDiffPercent = (providerPrice && ocrBaseline) ? ((priceDiff! / ocrBaseline) * 100) : null;
  
  return (
    <Card className={isSuccess ? 'border-green-500/50' : 'border-muted'}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base capitalize">{result.provider}</CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-xs">
              <Clock className="w-3 h-3 mr-1" />
              {(result.duration_ms / 1000).toFixed(1)}s
            </Badge>
            <StatusBadge status={result.status} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Provider vs OCR Side-by-Side Comparison */}
        {hasOcrData && (
          <div className="p-3 bg-slate-100 dark:bg-slate-800 rounded-lg border border-slate-300 dark:border-slate-600">
            <Label className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-2 block">
              Provider vs OCR Comparison
            </Label>
            <div className="grid grid-cols-3 gap-2 items-center">
              {/* Provider Price Column */}
              <div className="text-center p-2 rounded bg-background border">
                <div className="text-xs text-muted-foreground mb-1">Provider</div>
                <div className={`text-lg font-bold font-mono ${providerPrice ? (isSuccess ? 'text-green-600' : 'text-orange-600') : 'text-muted-foreground'}`}>
                  {providerPrice 
                    ? `$${providerPrice.toLocaleString()}`
                    : '—'
                  }
                </div>
              </div>
              
              {/* Diff Column */}
              <div className="text-center p-2">
                {priceDiff !== null ? (
                  <div className={`text-sm font-bold ${
                    priceDiff === 0 ? 'text-emerald-600' :
                    priceDiff > 0 ? 'text-blue-600' :
                    'text-red-600'
                  }`}>
                    {priceDiff === 0 ? '=' : priceDiff > 0 ? `+$${priceDiff.toFixed(0)}` : `-$${Math.abs(priceDiff).toFixed(0)}`}
                    {priceDiffPercent !== null && priceDiff !== 0 && (
                      <div className="text-xs font-normal">
                        ({priceDiffPercent > 0 ? '+' : ''}{priceDiffPercent.toFixed(1)}%)
                      </div>
                    )}
                  </div>
                ) : (
                  <span className="text-muted-foreground text-sm">—</span>
                )}
              </div>
              
              {/* OCR Baseline Column */}
              <div className="text-center p-2 rounded bg-background border">
                <div className="text-xs text-muted-foreground mb-1">
                  {result.ocr_breakdown_total_amount_value ? 'OCR Total' : 'OCR Card'}
                </div>
                <div className="text-lg font-bold font-mono text-blue-600">
                  ${ocrBaseline?.toLocaleString() || '—'}
                </div>
              </div>
            </div>
            
            {/* Validation Status Row */}
            <div className="mt-2 pt-2 border-t border-slate-200 dark:border-slate-600 flex items-center justify-between">
              <OcrValidationBadge 
                status={result.ocr_validation_status} 
                acceptedVia={result.ocr_accepted_via}
                mismatchReason={result.ocr_mismatch_reason}
              />
              {result.ocr_booking_card_snippet && (
                <span className="text-xs text-muted-foreground truncate max-w-40">
                  "{result.ocr_booking_card_snippet}"
                </span>
              )}
            </div>
          </div>
        )}

        {/* Success display without OCR */}
        {isSuccess && result.price && !hasOcrData && (
          <div className="p-3 bg-green-500/10 rounded-lg border border-green-500/20">
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="text-2xl font-bold text-green-700">
                {result.currency === 'CHF' ? 'CHF ' : result.currency === 'EUR' ? '€' : '$'}
                {result.price.toLocaleString()}
              </span>
              {result.includes_taxes_fees && (
                <Badge variant="outline" className="text-green-600 border-green-400 text-xs">
                  Incl. taxes & fees
                </Badge>
              )}
            </div>
          </div>
        )}

        {/* OCR Rejection display for failed extractions */}
        {!isSuccess && result.ocr_validation_status === 'rejected' && !hasOcrData && (
          <div className="p-3 bg-red-500/10 rounded-lg border border-red-500/20">
            <div className="flex items-center gap-2 text-red-700">
              <XCircle className="w-4 h-4" />
              <span className="font-medium">Rejected by OCR validation</span>
            </div>
            {result.ocr_mismatch_reason && (
              <p className="text-xs text-red-600 mt-1">
                Reason: {result.ocr_mismatch_reason.replace(/_/g, ' ')}
              </p>
            )}
          </div>
        )}
        
        {result.error && (
          <div className="p-2 bg-destructive/10 rounded text-sm text-destructive">
            {result.error}
          </div>
        )}
        
        <div>
          <Label className="text-xs text-muted-foreground">Evidence Snippet</Label>
          <ScrollArea className="h-24 mt-1">
            <pre className="text-xs bg-muted p-2 rounded whitespace-pre-wrap font-mono">
              {result.evidence_snippet || 'No evidence captured'}
            </pre>
          </ScrollArea>
        </div>
        
        {result.candidates_summary.length > 0 && (
          <div>
            <Label className="text-xs text-muted-foreground">
              Top {result.candidates_summary.length} Candidates
            </Label>
            <div className="mt-1 space-y-1">
              {result.candidates_summary.map((c, i) => (
                <div key={i} className="flex items-center justify-between text-xs p-2 bg-muted/50 rounded gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-bold">
                      {c.currency} {c.amount.toLocaleString()}
                    </span>
                    {c.candidate_type && (
                      <Badge 
                        variant={c.candidate_type === 'total_final' ? 'default' : 'outline'} 
                        className={`text-xs ${c.candidate_type === 'total_final' ? 'bg-green-600' : c.candidate_type === 'subtotal_nights' ? 'bg-orange-500/20 text-orange-700 border-orange-400' : ''}`}
                      >
                        {c.candidate_type}
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-wrap justify-end">
                    {c.rejected_reason && (
                      <Badge variant="destructive" className="text-xs">
                        ✗ {c.rejected_reason}
                      </Badge>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RunResultCard({ result }: { result: ValidationRunResult }) {
  const isSuccess = result.final_status.startsWith('total_price_');
  
  return (
    <Card className={isSuccess ? 'border-green-500' : 'border-orange-400'}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">Run #{result.run_number}</CardTitle>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {new Date(result.timestamp).toLocaleTimeString()}
            </span>
            <StatusBadge status={result.final_status} />
          </div>
        </div>
        {isSuccess && result.final_price && (
          <div className="flex items-baseline gap-2 mt-2">
            <span className="text-2xl font-bold text-green-700">
              {result.final_currency === 'CHF' ? 'CHF ' : result.final_currency === 'EUR' ? '€' : '$'}
              {result.final_price.toLocaleString()}
            </span>
            <span className="text-sm text-muted-foreground">
              via {result.selected_provider}
            </span>
            {result.final_includes_taxes_fees && (
              <Badge variant="outline" className="text-green-600 border-green-400">
                Incl. taxes & fees
              </Badge>
            )}
          </div>
        )}
      </CardHeader>
      <CardContent>
        <div className="grid gap-3">
          {result.provider_results.map((pr, i) => (
            <ProviderResultCard key={i} result={pr} />
          ))}
        </div>
        
        {result.final_evidence_snippet && (
          <div className="mt-4">
            <Label className="text-xs text-muted-foreground">Final Evidence</Label>
            <ScrollArea className="h-20 mt-1">
              <pre className="text-xs bg-muted p-2 rounded whitespace-pre-wrap font-mono">
                {result.final_evidence_snippet}
              </pre>
            </ScrollArea>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function AirbnbBaselineDiagnostic() {
  const { getToken } = useAdminAuth();
  const [url, setUrl] = useState('https://www.airbnb.com/rooms/903802242341279498?check_in=2026-01-04&check_out=2026-01-08');
  const [runs, setRuns] = useState(3);
  const [delaySeconds, setDelaySeconds] = useState(25);
  const [isRunning, setIsRunning] = useState(false);
  const [results, setResults] = useState<TestSummary | null>(null);
  const [history, setHistory] = useState<DebugHistoryItem[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [activeTab, setActiveTab] = useState('run');
  const [diagnosticConfirmation, setDiagnosticConfirmation] = useState<{
    confirmed_total_amount: number;
    confirmed_currency: string;
    confirmation_source: string;
    confirmed_at: string;
    confirmation_note?: string;
  } | null>(null);

  // Load confirmation for current run_id
  const loadConfirmation = async (runId: string) => {
    try {
      const token = getToken();
      const { data, error } = await supabase.functions.invoke(`admin-dashboard/get-diagnostic-confirmation?runId=${runId}`, {
        headers: { Authorization: `Bearer ${token}` },
        method: 'GET',
      });
      if (error) throw error;
      setDiagnosticConfirmation(data.confirmation || null);
    } catch (err: any) {
      console.error('Error loading confirmation:', err);
    }
  };

  // Get subtotal info from results
  const getSubtotalFromResults = (): { amount: number | null; nights: number | null; currency: string } => {
    if (!results?.results?.[0]) return { amount: null, nights: null, currency: 'USD' };
    
    // Look for subtotal candidates in the first run's provider results
    for (const providerResult of results.results[0].provider_results) {
      const subtotalCandidate = providerResult.candidates_summary?.find(
        c => c.candidate_type === 'subtotal_nights' || c.kind === 'subtotal'
      );
      if (subtotalCandidate) {
        return {
          amount: subtotalCandidate.amount,
          nights: results.nights,
          currency: subtotalCandidate.currency || 'USD',
        };
      }
    }
    return { amount: null, nights: results.nights, currency: 'USD' };
  };

  // Check if any run needs confirmation (no proven total)
  const needsConfirmation = (): boolean => {
    if (!results) return false;
    // If no run has a proven total, we need confirmation
    const hasProvenTotal = results.results.some(r => 
      r.final_status.startsWith('total_price_') && r.final_price !== null
    );
    return !hasProvenTotal;
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast({ title: 'Copied to clipboard' });
  };

  const loadHistory = async () => {
    setIsLoadingHistory(true);
    try {
      const token = getToken();
      const { data, error } = await supabase.functions.invoke('admin-dashboard/debug-history?limit=20', {
        headers: { Authorization: `Bearer ${token}` },
        method: 'GET',
      });
      if (error) throw error;
      setHistory(data.history || []);
    } catch (err: any) {
      toast({ title: 'Error loading history', description: err.message, variant: 'destructive' });
    } finally {
      setIsLoadingHistory(false);
    }
  };

  const loadRunById = async (runId: string) => {
    try {
      const token = getToken();
      const { data, error } = await supabase.functions.invoke(`admin-dashboard/debug-bundles?runId=${runId}`, {
        headers: { Authorization: `Bearer ${token}` },
        method: 'GET',
      });
      if (error) throw error;
      
      // Convert stored bundles to TestSummary format
      const bundles = data.debugBundles[runId] || [];
      if (bundles.length === 0) {
        toast({ title: 'No data found', description: 'Run ID not found in database', variant: 'destructive' });
        return;
      }

      // Group by run_number
      const byRunNumber: Record<number, any[]> = {};
      bundles.forEach((b: any) => {
        if (!byRunNumber[b.runNumber]) byRunNumber[b.runNumber] = [];
        byRunNumber[b.runNumber].push(b);
      });

      const resultsArray: ValidationRunResult[] = Object.entries(byRunNumber).map(([runNum, providers]) => {
        const sortedProviders = providers.sort((a, b) => a.providerOrder - b.providerOrder);
        const successProvider = sortedProviders.find(p => p.status?.startsWith('total_price_'));
        const lastProvider = sortedProviders[sortedProviders.length - 1];
        
        return {
          run_number: parseInt(runNum),
          timestamp: providers[0]?.createdAt || '',
          provider_order: sortedProviders.map(p => p.provider),
          provider_results: sortedProviders.map(p => ({
            provider: p.provider,
            status: p.status,
            price: p.extractedPrice,
            currency: p.currency,
            includes_taxes_fees: p.includesTaxesFees,
            evidence_snippet: p.evidenceSnippet || '',
            duration_ms: p.durationMs || 0,
            candidates_summary: p.candidatesSummary || [],
            // OCR validation fields
            ocr_booking_card_amount_value: p.ocrBookingCardAmountValue,
            ocr_booking_card_snippet: p.ocrBookingCardSnippet,
            ocr_breakdown_total_amount_value: p.ocrBreakdownTotalAmountValue,
            ocr_breakdown_total_snippet: p.ocrBreakdownTotalSnippet,
            ocr_validation_status: p.ocrValidationStatus,
            ocr_accepted_via: p.ocrAcceptedVia,
            ocr_mismatch_reason: p.ocrMismatchReason,
          })),
          final_status: successProvider?.status || lastProvider?.status || 'unknown',
          final_price: successProvider?.extractedPrice || null,
          final_currency: successProvider?.currency || null,
          final_includes_taxes_fees: successProvider?.includesTaxesFees || false,
          final_evidence_snippet: successProvider?.evidenceSnippet || lastProvider?.evidenceSnippet || '',
          selected_provider: successProvider?.provider,
        };
      });

      const firstBundle = bundles[0];
      setResults({
        run_id: runId,
        url: firstBundle.airbnbUrl || '',
        check_in: firstBundle.checkInDate || '',
        check_out: firstBundle.checkOutDate || '',
        nights: firstBundle.nightsCount || 0,
        total_runs: Object.keys(byRunNumber).length,
        consistent: resultsArray.every(r => r.final_status === resultsArray[0].final_status),
        all_prices_match: resultsArray.every(r => r.final_price === resultsArray[0].final_price),
        results: resultsArray.sort((a, b) => a.run_number - b.run_number),
      });
      setActiveTab('run');
      toast({ title: 'Loaded', description: `Loaded run ${runId.slice(0, 8)}...` });
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    }
  };

  useEffect(() => {
    loadHistory();
  }, []);

  const runTest = async () => {
    if (!url.includes('airbnb.com')) {
      toast({ title: 'Invalid URL', description: 'Please enter a valid Airbnb URL', variant: 'destructive' });
      return;
    }
    
    if (!url.includes('check_in=') || !url.includes('check_out=')) {
      toast({ title: 'Missing dates', description: 'URL must include check_in and check_out dates', variant: 'destructive' });
      return;
    }

    setIsRunning(true);
    setResults(null);

    try {
      const token = getToken();
      const { data, error } = await supabase.functions.invoke('airbnb-baseline-test', {
        headers: { Authorization: `Bearer ${token}` },
        body: { url, runs, delay_seconds: delaySeconds },
      });

      if (error) throw error;
      
      // Map OCR fields from nested objects in API response to flat fields expected by UI
      const mappedData = {
        ...data,
        results: data.results?.map((run: any) => ({
          ...run,
          provider_results: run.provider_results?.map((pr: any) => ({
            ...pr,
            // Map nested ocr_reference to flat fields
            ocr_booking_card_amount_value: pr.ocr_reference?.bookingCardAmount ?? null,
            ocr_booking_card_snippet: pr.ocr_reference?.bookingCardSnippet ?? null,
            ocr_breakdown_total_amount_value: pr.ocr_reference?.breakdownTotalAmount ?? null,
            ocr_breakdown_total_snippet: pr.ocr_reference?.breakdownTotalSnippet ?? null,
            // Map nested ocr_validation to flat fields
            ocr_validation_status: pr.ocr_validation?.status ?? null,
            ocr_accepted_via: pr.ocr_validation?.acceptedVia ?? null,
            ocr_mismatch_reason: pr.ocr_validation?.mismatchReason ?? null,
          })),
        })),
      };
      setResults(mappedData);
      
      // Refresh history after test
      loadHistory();
      
      if (data.consistent && data.all_prices_match) {
        toast({ title: 'Test Complete', description: `All ${runs} runs produced consistent results` });
      } else {
        toast({ title: 'Test Complete', description: 'Results vary between runs - check details', variant: 'destructive' });
      }
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Airbnb Baseline Diagnostic</h1>
        <p className="text-muted-foreground">
          Test total-only price extraction across all providers with evidence validation
        </p>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="run">Run Test</TabsTrigger>
          <TabsTrigger value="history" className="flex items-center gap-1">
            <History className="h-4 w-4" />
            History ({history.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="run" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Test Configuration</CardTitle>
              <CardDescription>
                Run deterministic validation tests on an Airbnb URL
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Airbnb URL (must include check_in and check_out)</Label>
                <Input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://www.airbnb.com/rooms/..."
                  className="font-mono text-sm"
                />
              </div>
              
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Number of Runs</Label>
                  <Input
                    type="number"
                    min={1}
                    max={5}
                    value={runs}
                    onChange={(e) => setRuns(parseInt(e.target.value) || 1)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Delay Between Runs (seconds)</Label>
                  <Input
                    type="number"
                    min={5}
                    max={60}
                    value={delaySeconds}
                    onChange={(e) => setDelaySeconds(parseInt(e.target.value) || 20)}
                  />
                </div>
              </div>
              
              <Button 
                onClick={runTest} 
                disabled={isRunning}
                className="w-full"
              >
                {isRunning ? (
                  <>
                    <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                    Running Test ({runs} runs)...
                  </>
                ) : (
                  <>
                    <Play className="mr-2 h-4 w-4" />
                    Run Validation Test
                  </>
                )}
              </Button>
            </CardContent>
          </Card>

          {results && (
            <>
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle>Test Summary</CardTitle>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="font-mono text-xs">
                        run_id: {results.run_id.slice(0, 8)}...
                      </Badge>
                      <Button 
                        variant="ghost" 
                        size="sm"
                        onClick={() => copyToClipboard(results.run_id)}
                      >
                        <Copy className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div className="text-center p-3 bg-muted rounded-lg">
                      <div className="text-2xl font-bold">{results.nights}</div>
                      <div className="text-xs text-muted-foreground">Nights</div>
                    </div>
                    <div className="text-center p-3 bg-muted rounded-lg">
                      <div className="text-2xl font-bold">{results.total_runs}</div>
                      <div className="text-xs text-muted-foreground">Runs</div>
                    </div>
                    <div className={`text-center p-3 rounded-lg ${results.consistent ? 'bg-green-500/20' : 'bg-orange-500/20'}`}>
                      <div className="text-2xl font-bold">{results.consistent ? '✓' : '✗'}</div>
                      <div className="text-xs text-muted-foreground">Consistent Status</div>
                    </div>
                    <div className={`text-center p-3 rounded-lg ${results.all_prices_match ? 'bg-green-500/20' : 'bg-orange-500/20'}`}>
                      <div className="text-2xl font-bold">{results.all_prices_match ? '✓' : '✗'}</div>
                      <div className="text-xs text-muted-foreground">Prices Match</div>
                    </div>
                  </div>
                  
                  <div className="mt-4 text-sm space-y-1">
                    <p><strong>Check-in:</strong> {results.check_in}</p>
                    <p><strong>Check-out:</strong> {results.check_out}</p>
                    <p className="flex items-center gap-2">
                      <strong>URL:</strong> 
                      <a 
                        href={results.url} 
                        target="_blank" 
                        rel="noopener noreferrer"
                        className="text-primary hover:underline truncate max-w-md inline-flex items-center gap-1"
                      >
                        {results.url.slice(0, 60)}...
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </p>
                  </div>
                </CardContent>
              </Card>

              {/* Confirmation UI for when no proven total */}
              {needsConfirmation() && (
                <DiagnosticTotalConfirmation
                  runId={results.run_id}
                  subtotalAmount={getSubtotalFromResults().amount}
                  subtotalNights={getSubtotalFromResults().nights}
                  subtotalCurrency={getSubtotalFromResults().currency}
                  existingConfirmation={diagnosticConfirmation}
                  onConfirmed={() => loadConfirmation(results.run_id)}
                  onCleared={() => setDiagnosticConfirmation(null)}
                />
              )}

              <Separator />

              <div className="space-y-4">
                <h2 className="text-xl font-semibold">Run Results</h2>
                {results.results.map((run, i) => (
                  <RunResultCard key={i} result={run} />
                ))}
              </div>
            </>
          )}
        </TabsContent>

        <TabsContent value="history" className="space-y-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>Recent Test Runs</CardTitle>
                <CardDescription>Persisted debug bundles from previous tests</CardDescription>
              </div>
              <Button 
                variant="outline" 
                size="sm" 
                onClick={loadHistory}
                disabled={isLoadingHistory}
              >
                {isLoadingHistory ? (
                  <RefreshCw className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
              </Button>
            </CardHeader>
            <CardContent>
              {history.length === 0 ? (
                <p className="text-muted-foreground text-center py-8">
                  No test runs found. Run a test to see results here.
                </p>
              ) : (
                <div className="space-y-2">
                  {history.map((item) => (
                    <div 
                      key={item.runId}
                      className="flex items-center justify-between p-3 border rounded-lg hover:bg-muted/50 cursor-pointer"
                      onClick={() => loadRunById(item.runId)}
                    >
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="font-mono text-xs">
                            {item.runId.slice(0, 8)}...
                          </Badge>
                          <span className="text-sm text-muted-foreground">
                            {format(new Date(item.createdAt), 'MMM d, HH:mm')}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground truncate max-w-md">
                          {item.airbnbUrl?.slice(0, 60)}...
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {item.nightsCount} nights • {item.checkInDate} to {item.checkOutDate}
                        </p>
                      </div>
                      <Button variant="ghost" size="sm">
                        View
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
