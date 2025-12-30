import { useState } from 'react';
import { Play, RefreshCw, CheckCircle, XCircle, AlertCircle, Clock } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import { useAdminAuth } from '@/hooks/useAdminAuth';

interface CandidateSummary {
  amount: number;
  currency: string;
  kind: string;
  label_hint: string;
  rejected_reason?: string;
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
  url: string;
  check_in: string;
  check_out: string;
  nights: number;
  total_runs: number;
  consistent: boolean;
  all_prices_match: boolean;
  results: ValidationRunResult[];
}

function StatusBadge({ status }: { status: string }) {
  const isSuccess = status.startsWith('total_price_');
  const isBlocked = status.includes('blocked') || status.includes('captcha');
  const isNotSupported = status.includes('not_supported');
  
  if (isSuccess) {
    return (
      <Badge className="bg-green-500/20 text-green-700 border-green-500/30">
        <CheckCircle className="w-3 h-3 mr-1" />
        {status.replace(/_/g, ' ')}
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

function ProviderResultCard({ result }: { result: ProviderAttemptResult }) {
  const isSuccess = result.status.startsWith('total_price_');
  
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
        {isSuccess && result.price && (
          <div className="p-3 bg-green-500/10 rounded-lg border border-green-500/20">
            <div className="flex items-baseline gap-2">
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
                <div key={i} className="flex items-center justify-between text-xs p-2 bg-muted/50 rounded">
                  <span className="font-medium">
                    {c.currency} {c.amount.toLocaleString()}
                  </span>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-xs">
                      {c.kind.replace(/_/g, ' ').slice(0, 20)}
                    </Badge>
                    {c.rejected_reason && (
                      <Badge variant="destructive" className="text-xs">
                        {c.rejected_reason}
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
      setResults(data);
      
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
              <CardTitle>Test Summary</CardTitle>
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
              
              <div className="mt-4 text-sm">
                <p><strong>Check-in:</strong> {results.check_in}</p>
                <p><strong>Check-out:</strong> {results.check_out}</p>
              </div>
            </CardContent>
          </Card>

          <Separator />

          <div className="space-y-4">
            <h2 className="text-xl font-semibold">Run Results</h2>
            {results.results.map((run, i) => (
              <RunResultCard key={i} result={run} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
