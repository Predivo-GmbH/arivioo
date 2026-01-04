import { useState, useEffect } from 'react';
import { useAdminAuth } from '@/hooks/useAdminAuth';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { 
  Play, 
  RefreshCw, 
  CheckCircle2, 
  XCircle, 
  AlertTriangle,
  Clock,
  ExternalLink,
  Copy,
  History
} from 'lucide-react';
import { toast } from 'sonner';

interface ExtractionResult {
  platform: 'airbnb' | 'expedia';
  status: string;
  terminal_status?: string;
  extracted_price?: number | null;
  currency?: string;
  converted_usd?: number;
  includes_taxes_fees?: boolean;
  provider_used?: string;
  evidence_snippets?: string[];
  verification_status?: string;
  structural_proof?: Record<string, any>;
  expedia_trace?: Record<string, any>;
  date_injection?: Record<string, any>;
  error?: string;
}

interface TestRun {
  id: string;
  created_at: string;
  admin_email: string;
  airbnb_url: string;
  expedia_url: string | null;
  request_params: Record<string, any>;
  results_json: {
    airbnb?: ExtractionResult;
    expedia?: ExtractionResult;
    request_dates?: { check_in: string; check_out: string; adults: number };
  } | null;
  status: string;
  duration_ms: number | null;
  error_message: string | null;
}

export default function ExtractionTestHarness() {
  const { getToken, admin } = useAdminAuth();
  const [airbnbUrl, setAirbnbUrl] = useState('');
  const [expediaUrl, setExpediaUrl] = useState('');
  const [skipDiscovery, setSkipDiscovery] = useState(true);
  const [isRunning, setIsRunning] = useState(false);
  const [currentResult, setCurrentResult] = useState<TestRun | null>(null);
  const [recentRuns, setRecentRuns] = useState<TestRun[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    fetchRecentRuns();
  }, []);

  const fetchRecentRuns = async () => {
    const token = getToken();
    if (!token) return;

    try {
      const { data, error } = await supabase.functions.invoke('admin-dashboard/extraction-test-history', {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!error && data?.runs) {
        setRecentRuns(data.runs);
      }
    } catch (err) {
      console.error('Failed to fetch recent runs:', err);
    }
  };

  const runTest = async () => {
    if (!airbnbUrl.trim()) {
      toast.error('Airbnb URL is required');
      return;
    }

    setIsRunning(true);
    setCurrentResult(null);

    try {
      const token = getToken();
      if (!token) throw new Error('Not authenticated');

      const { data, error } = await supabase.functions.invoke('admin-dashboard/extraction-test', {
        headers: { Authorization: `Bearer ${token}` },
        body: {
          airbnb_url: airbnbUrl.trim(),
          expedia_url: expediaUrl.trim() || null,
          skip_discovery: skipDiscovery,
        },
      });

      if (error) throw error;

      setCurrentResult(data.run);
      toast.success('Extraction test completed');
      fetchRecentRuns();
    } catch (err: any) {
      console.error('Test run failed:', err);
      toast.error(err.message || 'Test failed');
    } finally {
      setIsRunning(false);
    }
  };

  const loadRun = (run: TestRun) => {
    setCurrentResult(run);
    setAirbnbUrl(run.airbnb_url);
    setExpediaUrl(run.expedia_url || '');
    setShowHistory(false);
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success('Copied to clipboard');
  };

  const getStatusBadge = (status: string) => {
    if (status === 'success' || status === 'verified') {
      return <Badge variant="default" className="bg-green-500"><CheckCircle2 className="h-3 w-3 mr-1" /> {status}</Badge>;
    }
    if (status === 'pending' || status === 'running') {
      return <Badge variant="secondary"><Clock className="h-3 w-3 mr-1" /> {status}</Badge>;
    }
    if (status === 'unverified') {
      return <Badge variant="outline" className="border-yellow-500 text-yellow-600"><AlertTriangle className="h-3 w-3 mr-1" /> {status}</Badge>;
    }
    return <Badge variant="destructive"><XCircle className="h-3 w-3 mr-1" /> {status}</Badge>;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Extraction Test Harness</h1>
          <p className="text-muted-foreground">
            Test Airbnb + Expedia extraction from pasted URLs without running full search flow
          </p>
        </div>
        <Button variant="outline" onClick={() => setShowHistory(!showHistory)}>
          <History className="h-4 w-4 mr-2" />
          {showHistory ? 'Hide History' : 'Show History'}
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Input Panel */}
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle>Test Input</CardTitle>
            <CardDescription>Paste URLs to test extraction</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="airbnb-url">Airbnb URL (required)</Label>
              <Input
                id="airbnb-url"
                placeholder="https://www.airbnb.com/rooms/..."
                value={airbnbUrl}
                onChange={(e) => setAirbnbUrl(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Source of truth for dates, guests, and baseline price
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="expedia-url">Expedia URL (optional)</Label>
              <Input
                id="expedia-url"
                placeholder="https://www.expedia.co.jp/..."
                value={expediaUrl}
                onChange={(e) => setExpediaUrl(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Property page or offers page URL
              </p>
            </div>

            <div className="flex items-center space-x-2">
              <Checkbox
                id="skip-discovery"
                checked={skipDiscovery}
                onCheckedChange={(checked) => setSkipDiscovery(!!checked)}
              />
              <Label htmlFor="skip-discovery" className="text-sm">
                Skip discovery, use provided Expedia URL
              </Label>
            </div>

            <Separator />

            <Button 
              className="w-full" 
              onClick={runTest} 
              disabled={isRunning || !airbnbUrl.trim()}
            >
              {isRunning ? (
                <>
                  <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                  Running...
                </>
              ) : (
                <>
                  <Play className="h-4 w-4 mr-2" />
                  Run Extraction Test
                </>
              )}
            </Button>
          </CardContent>
        </Card>

        {/* Results Panel */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <span>Results</span>
              {currentResult && (
                <div className="flex items-center gap-2 text-sm font-normal">
                  {getStatusBadge(currentResult.status)}
                  {currentResult.duration_ms && (
                    <span className="text-muted-foreground">
                      {(currentResult.duration_ms / 1000).toFixed(2)}s
                    </span>
                  )}
                </div>
              )}
            </CardTitle>
            {currentResult && (
              <CardDescription>
                Test ID: {currentResult.id} • {new Date(currentResult.created_at).toLocaleString()}
              </CardDescription>
            )}
          </CardHeader>
          <CardContent>
            {!currentResult ? (
              <div className="text-center py-12 text-muted-foreground">
                Run a test to see results
              </div>
            ) : currentResult.error_message ? (
              <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-4">
                <p className="text-destructive font-medium">Error: {currentResult.error_message}</p>
              </div>
            ) : (
              <div className="space-y-6">
                {/* Request Dates */}
                {currentResult.results_json?.request_dates && (
                  <div className="bg-muted/50 rounded-lg p-4">
                    <h4 className="font-medium mb-2">Request Dates (from Airbnb URL)</h4>
                    <div className="grid grid-cols-3 gap-4 text-sm">
                      <div>
                        <span className="text-muted-foreground">Check-in:</span>{' '}
                        <span className="font-mono">{currentResult.results_json.request_dates.check_in}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Check-out:</span>{' '}
                        <span className="font-mono">{currentResult.results_json.request_dates.check_out}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Adults:</span>{' '}
                        <span className="font-mono">{currentResult.results_json.request_dates.adults}</span>
                      </div>
                    </div>
                  </div>
                )}

                {/* Airbnb Result */}
                {currentResult.results_json?.airbnb && (
                  <ExtractionResultPanel 
                    result={currentResult.results_json.airbnb} 
                    title="Airbnb Baseline"
                    onCopy={copyToClipboard}
                  />
                )}

                {/* Expedia Result */}
                {currentResult.results_json?.expedia && (
                  <ExtractionResultPanel 
                    result={currentResult.results_json.expedia} 
                    title="Expedia Extraction"
                    onCopy={copyToClipboard}
                  />
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* History Panel */}
      {showHistory && (
        <Card>
          <CardHeader>
            <CardTitle>Recent Test Runs</CardTitle>
            <CardDescription>Click a run to view details</CardDescription>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-[300px]">
              <div className="space-y-2">
                {recentRuns.length === 0 ? (
                  <p className="text-muted-foreground text-center py-8">No test runs yet</p>
                ) : (
                  recentRuns.map((run) => (
                    <div
                      key={run.id}
                      className="flex items-center justify-between p-3 rounded-lg border hover:bg-muted/50 cursor-pointer transition-colors"
                      onClick={() => loadRun(run)}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          {getStatusBadge(run.status)}
                          <span className="text-xs text-muted-foreground">
                            {new Date(run.created_at).toLocaleString()}
                          </span>
                        </div>
                        <p className="text-sm font-mono truncate mt-1">{run.airbnb_url}</p>
                      </div>
                      <ExternalLink className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                    </div>
                  ))
                )}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

interface ExtractionResultPanelProps {
  result: ExtractionResult;
  title: string;
  onCopy: (text: string) => void;
}

function ExtractionResultPanel({ result, title, onCopy }: ExtractionResultPanelProps) {
  const [showRawData, setShowRawData] = useState(false);

  return (
    <div className="border rounded-lg">
      <div className="flex items-center justify-between p-4 border-b bg-muted/30">
        <h4 className="font-medium">{title}</h4>
        <div className="flex items-center gap-2">
          {result.terminal_status && (
            <Badge variant="outline" className="font-mono text-xs">
              {result.terminal_status}
            </Badge>
          )}
          {result.verification_status && (
            <Badge 
              variant={result.verification_status === 'verified' ? 'default' : 'secondary'}
              className={result.verification_status === 'verified' ? 'bg-green-500' : ''}
            >
              {result.verification_status}
            </Badge>
          )}
        </div>
      </div>

      <div className="p-4 space-y-4">
        {/* Price Info */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <span className="text-xs text-muted-foreground">Extracted Price</span>
            <p className="font-mono text-lg">
              {result.extracted_price != null 
                ? `${result.currency || ''}${result.extracted_price.toLocaleString()}`
                : '-'
              }
            </p>
          </div>
          {result.converted_usd != null && (
            <div>
              <span className="text-xs text-muted-foreground">Converted (USD)</span>
              <p className="font-mono text-lg">${result.converted_usd.toLocaleString()}</p>
            </div>
          )}
          <div>
            <span className="text-xs text-muted-foreground">Provider</span>
            <p className="font-medium">{result.provider_used || '-'}</p>
          </div>
          <div>
            <span className="text-xs text-muted-foreground">Includes Taxes</span>
            <p className="font-medium">{result.includes_taxes_fees ? 'Yes' : 'No'}</p>
          </div>
        </div>

        {/* Error */}
        {result.error && (
          <div className="bg-destructive/10 border border-destructive/20 rounded p-3">
            <p className="text-sm text-destructive">{result.error}</p>
          </div>
        )}

        {/* Expedia Trace */}
        {result.expedia_trace && Object.keys(result.expedia_trace).length > 0 && (
          <div className="space-y-2">
            <h5 className="text-sm font-medium">Expedia Trace</h5>
            <div className="bg-muted rounded p-3 space-y-1">
              {Object.entries(result.expedia_trace).map(([key, value]) => (
                <div key={key} className="flex items-start gap-2 text-xs">
                  <span className="text-muted-foreground font-medium min-w-[180px]">{key}:</span>
                  <span className="font-mono break-all">
                    {typeof value === 'boolean' 
                      ? (value ? '✓ true' : '✗ false')
                      : String(value ?? '-')
                    }
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Structural Proof */}
        {result.structural_proof && Object.keys(result.structural_proof).length > 0 && (
          <div className="space-y-2">
            <h5 className="text-sm font-medium">Structural Proof</h5>
            <div className="bg-muted rounded p-3 grid grid-cols-2 gap-2">
              {Object.entries(result.structural_proof).map(([key, value]) => (
                <div key={key} className="flex items-center gap-2 text-xs">
                  {typeof value === 'boolean' ? (
                    value ? (
                      <CheckCircle2 className="h-3 w-3 text-green-500" />
                    ) : (
                      <XCircle className="h-3 w-3 text-red-500" />
                    )
                  ) : null}
                  <span className="text-muted-foreground">{key}:</span>
                  <span className="font-mono">
                    {typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value ?? '-')}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Date Injection */}
        {result.date_injection && Object.keys(result.date_injection).length > 0 && (
          <div className="space-y-2">
            <h5 className="text-sm font-medium">Date Injection</h5>
            <div className="bg-muted rounded p-3 space-y-1">
              {Object.entries(result.date_injection).map(([key, value]) => (
                <div key={key} className="flex items-start gap-2 text-xs">
                  <span className="text-muted-foreground font-medium min-w-[140px]">{key}:</span>
                  <span className="font-mono">{String(value ?? '-')}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Evidence Snippets */}
        {result.evidence_snippets && result.evidence_snippets.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h5 className="text-sm font-medium">Evidence Snippets</h5>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onCopy(result.evidence_snippets?.join('\n') || '')}
              >
                <Copy className="h-3 w-3 mr-1" />
                Copy
              </Button>
            </div>
            <ScrollArea className="h-[120px] bg-muted rounded p-3">
              <div className="space-y-1">
                {result.evidence_snippets.map((snippet, i) => (
                  <p key={i} className="text-xs font-mono text-muted-foreground">{snippet}</p>
                ))}
              </div>
            </ScrollArea>
          </div>
        )}

        {/* Raw Data Toggle */}
        <div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowRawData(!showRawData)}
          >
            {showRawData ? 'Hide' : 'Show'} Raw JSON
          </Button>
          {showRawData && (
            <ScrollArea className="h-[200px] bg-muted rounded p-3 mt-2">
              <pre className="text-xs font-mono whitespace-pre-wrap">
                {JSON.stringify(result, null, 2)}
              </pre>
            </ScrollArea>
          )}
        </div>
      </div>
    </div>
  );
}
