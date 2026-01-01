import { useState, useEffect } from 'react';
import { format } from 'date-fns';
import { 
  Filter, 
  Download, 
  ExternalLink, 
  ChevronLeft, 
  ChevronRight,
  CheckCircle,
  XCircle,
  Clock,
  AlertTriangle,
  RefreshCw,
  Search as SearchIcon
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { supabase } from '@/integrations/supabase/client';
import { useAdminAuth } from '@/hooks/useAdminAuth';
import { HealthIndicator, SystemHealthBanner } from '@/components/admin/HealthIndicator';
import { useSystemHealth } from '@/hooks/useSystemHealth';

interface Extraction {
  id: string;
  platformName: string;
  deepLink: string;
  status: string;
  extractedPrice: number | null;
  currency: string;
  includesTaxesFees: boolean;
  providerUsed: string | null;
  finalResolvedUrl: string | null;
  extractionStage: string | null;
  confidenceScore: number | null;
  error: string | null;
  evidenceSnippets: any;
  metadata: any;
  assumedAdults: number;
  assumedChildren: number;
  assumedRooms: number;
  priceType: string;
  createdAt: string;
  searchId: string;
  airbnbUrl: string | null;
  airbnbTitle: string | null;
}

const STATUS_COLORS: Record<string, string> = {
  success: 'bg-success text-success-foreground',
  pending: 'bg-muted text-muted-foreground',
  running: 'bg-primary text-primary-foreground',
  failed: 'bg-destructive text-destructive-foreground',
  blocked_captcha_or_bot: 'bg-yellow-500 text-white',
  dates_not_applied: 'bg-orange-500 text-white',
  price_not_found: 'bg-red-400 text-white',
};

const PROVIDERS = ['firecrawl', 'zyte', 'browserless', 'serpapi'];
const STATUSES = ['pending', 'running', 'success', 'failed', 'blocked_captcha_or_bot', 'dates_not_applied', 'price_not_found'];

function ExtractionDetailDialog({ extraction }: { extraction: Extraction }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">View</Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Extraction Details</DialogTitle>
          <DialogDescription>{extraction.platformName}</DialogDescription>
        </DialogHeader>
        
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium text-muted-foreground">Status</label>
              <Badge className={STATUS_COLORS[extraction.status] || 'bg-muted'}>
                {extraction.status}
              </Badge>
            </div>
            <div>
              <label className="text-sm font-medium text-muted-foreground">Provider</label>
              <p className="text-sm">{extraction.providerUsed || 'N/A'}</p>
            </div>
            <div>
              <label className="text-sm font-medium text-muted-foreground">Price</label>
              <p className="text-sm font-semibold">
                {extraction.extractedPrice 
                  ? `${extraction.currency} ${extraction.extractedPrice.toFixed(2)}`
                  : 'N/A'}
              </p>
            </div>
            <div>
              <label className="text-sm font-medium text-muted-foreground">Confidence</label>
              <p className="text-sm">{extraction.confidenceScore?.toFixed(2) || 'N/A'}</p>
            </div>
            <div>
              <label className="text-sm font-medium text-muted-foreground">Price Type</label>
              <p className="text-sm">{extraction.priceType}</p>
            </div>
            <div>
              <label className="text-sm font-medium text-muted-foreground">Includes Taxes</label>
              <p className="text-sm">{extraction.includesTaxesFees ? 'Yes' : 'No'}</p>
            </div>
            <div>
              <label className="text-sm font-medium text-muted-foreground">Occupancy</label>
              <p className="text-sm">
                {extraction.assumedAdults}A / {extraction.assumedChildren}C / {extraction.assumedRooms}R
              </p>
            </div>
            <div>
              <label className="text-sm font-medium text-muted-foreground">Stage</label>
              <p className="text-sm">{extraction.extractionStage || 'N/A'}</p>
            </div>
          </div>

          <div>
            <label className="text-sm font-medium text-muted-foreground">Deep Link</label>
            <a 
              href={extraction.deepLink} 
              target="_blank" 
              rel="noopener noreferrer"
              className="text-sm text-primary hover:underline flex items-center gap-1 break-all"
            >
              {extraction.deepLink.substring(0, 80)}...
              <ExternalLink className="h-3 w-3 flex-shrink-0" />
            </a>
          </div>

          {extraction.finalResolvedUrl && (
            <div>
              <label className="text-sm font-medium text-muted-foreground">Final URL</label>
              <a 
                href={extraction.finalResolvedUrl} 
                target="_blank" 
                rel="noopener noreferrer"
                className="text-sm text-primary hover:underline flex items-center gap-1 break-all"
              >
                {extraction.finalResolvedUrl.substring(0, 80)}...
                <ExternalLink className="h-3 w-3 flex-shrink-0" />
              </a>
            </div>
          )}

          {extraction.error && (
            <div>
              <label className="text-sm font-medium text-destructive">Error</label>
              <p className="text-sm text-destructive bg-destructive/10 p-2 rounded">
                {extraction.error}
              </p>
            </div>
          )}

          {extraction.evidenceSnippets && (
            <div>
              <label className="text-sm font-medium text-muted-foreground">Evidence Snippets</label>
              <pre className="text-xs bg-muted p-2 rounded overflow-x-auto">
                {JSON.stringify(extraction.evidenceSnippets, null, 2)}
              </pre>
            </div>
          )}

          {extraction.metadata && (
            <div>
              <label className="text-sm font-medium text-muted-foreground">Metadata</label>
              <pre className="text-xs bg-muted p-2 rounded overflow-x-auto max-h-40">
                {JSON.stringify(extraction.metadata, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function Extractions() {
  const { getToken } = useAdminAuth();
  const [extractions, setExtractions] = useState<Extraction[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { health: systemHealth, hasAlerts } = useSystemHealth();
  
  // Endpoint health tracking
  const [endpointHealth, setEndpointHealth] = useState<{
    status: 'healthy' | 'stale' | 'not_updating' | 'empty' | 'error';
    lastRecordAt: string | null;
    message: string;
    queriedAt: string | null;
  } | null>(null);

  // Filters
  const [platform, setPlatform] = useState<string>('');
  const [status, setStatus] = useState<string>('');
  const [provider, setProvider] = useState<string>('');

  const limit = 20;

  const fetchExtractions = async () => {
    setIsLoading(true);
    setError(null);

    try {
      const token = getToken();
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('limit', String(limit));
      if (platform) params.set('platform', platform);
      if (status) params.set('status', status);
      if (provider) params.set('provider', provider);

      const { data, error: invokeError } = await supabase.functions.invoke(`admin-dashboard/extractions?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
        method: 'GET',
      });

      if (invokeError) throw invokeError;
      
      // Check for endpoint-level errors
      if (data?.error) {
        setError(`Data source error: ${data.message || data.error}`);
        setEndpointHealth(data.health || { status: 'error', lastRecordAt: null, message: data.message, queriedAt: null });
        setExtractions([]);
        setTotal(0);
        return;
      }
      
      setExtractions(data.extractions || []);
      setTotal(data.total || 0);
      setEndpointHealth(data.health || null);
    } catch (err: any) {
      const errorMessage = err?.message || 'Failed to load extractions';
      setError(errorMessage);
      setEndpointHealth({ status: 'error', lastRecordAt: null, message: errorMessage, queriedAt: new Date().toISOString() });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchExtractions();
  }, [page, platform, status, provider]);

  const exportCSV = () => {
    const headers = ['ID', 'Platform', 'Status', 'Price', 'Currency', 'Provider', 'Created At'];
    const rows = extractions.map(e => [
      e.id,
      e.platformName,
      e.status,
      e.extractedPrice || '',
      e.currency,
      e.providerUsed || '',
      e.createdAt,
    ]);
    
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `extractions-${format(new Date(), 'yyyy-MM-dd')}.csv`;
    a.click();
  };

  const totalPages = Math.ceil(total / limit);

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'success': return <CheckCircle className="h-4 w-4 text-success" />;
      case 'failed': return <XCircle className="h-4 w-4 text-destructive" />;
      case 'pending': return <Clock className="h-4 w-4 text-muted-foreground" />;
      case 'running': return <RefreshCw className="h-4 w-4 text-primary animate-spin" />;
      default: return <AlertTriangle className="h-4 w-4 text-yellow-500" />;
    }
  };

  return (
    <div className="space-y-6">
      {/* System Health Alerts */}
      {hasAlerts && systemHealth && (
        <SystemHealthBanner alerts={systemHealth.alerts} />
      )}

      {/* Endpoint-specific stale/error alert */}
      {endpointHealth && (endpointHealth.status === 'stale' || endpointHealth.status === 'not_updating' || endpointHealth.status === 'error') && (
        <Card className={`border-l-4 ${endpointHealth.status === 'error' ? 'border-l-destructive bg-destructive/5' : endpointHealth.status === 'not_updating' ? 'border-l-destructive bg-destructive/5' : 'border-l-yellow-500 bg-yellow-50 dark:bg-yellow-950/20'}`}>
          <CardContent className="py-3">
            <div className="flex items-center gap-3">
              <AlertTriangle className={`h-5 w-5 ${endpointHealth.status === 'error' || endpointHealth.status === 'not_updating' ? 'text-destructive' : 'text-yellow-600'}`} />
              <div>
                <p className="font-medium">
                  {endpointHealth.status === 'error' ? 'Data Source Error' : 
                   endpointHealth.status === 'not_updating' ? 'Extractions Pipeline Stopped' : 
                   'Extractions Data is Stale'}
                </p>
                <p className="text-sm text-muted-foreground">{endpointHealth.message}</p>
                {endpointHealth.lastRecordAt && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Last record: {format(new Date(endpointHealth.lastRecordAt), 'MMM d, yyyy HH:mm:ss')}
                  </p>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div>
            <h1 className="text-3xl font-bold">Price Extractions</h1>
            <div className="flex items-center gap-2 text-muted-foreground">
              <span>{total} total extractions</span>
              {endpointHealth?.lastRecordAt && (
                <>
                  <span>•</span>
                  <span className="text-xs">
                    Last: {format(new Date(endpointHealth.lastRecordAt), 'MMM d, HH:mm')}
                  </span>
                </>
              )}
            </div>
          </div>
          {endpointHealth && (
            <HealthIndicator 
              status={endpointHealth.status === 'error' || endpointHealth.status === 'empty' ? 'not_updating' : endpointHealth.status} 
              lastActivity={endpointHealth.lastRecordAt}
              label="Data Source"
            />
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={fetchExtractions} disabled={isLoading}>
            <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
          </Button>
          <Button variant="outline" onClick={exportCSV}>
            <Download className="mr-2 h-4 w-4" />
            Export CSV
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="text-base flex items-center gap-2">
            <Filter className="h-4 w-4" />
            Filters
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-4">
            <div>
              <label className="text-sm font-medium mb-1 block">Platform</label>
              <Input
                placeholder="Filter by platform..."
                value={platform}
                onChange={(e) => { setPlatform(e.target.value); setPage(1); }}
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">Status</label>
              <Select value={status} onValueChange={(v) => { setStatus(v === 'all' ? '' : v); setPage(1); }}>
                <SelectTrigger>
                  <SelectValue placeholder="All statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  {STATUSES.map(s => (
                    <SelectItem key={s} value={s}>{s.replace(/_/g, ' ')}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">Provider</label>
              <Select value={provider} onValueChange={(v) => { setProvider(v === 'all' ? '' : v); setPage(1); }}>
                <SelectTrigger>
                  <SelectValue placeholder="All providers" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All providers</SelectItem>
                  {PROVIDERS.map(p => (
                    <SelectItem key={p} value={p}>{p}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end">
              <Button 
                variant="ghost" 
                onClick={() => { setPlatform(''); setStatus(''); setProvider(''); setPage(1); }}
              >
                Clear filters
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Table */}
      <Card>
        <CardContent className="pt-6">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="flex flex-col items-center py-8 text-destructive">
              <AlertTriangle className="h-6 w-6 mb-2" />
              <p>{error}</p>
              <Button onClick={fetchExtractions} variant="outline" className="mt-4">Retry</Button>
            </div>
          ) : extractions.length === 0 ? (
            <div className="flex flex-col items-center py-8 text-muted-foreground">
              <SearchIcon className="h-8 w-8 mb-2" />
              <p>No extractions found</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b text-left">
                    <th className="pb-3 font-medium text-muted-foreground">Status</th>
                    <th className="pb-3 font-medium text-muted-foreground">Platform</th>
                    <th className="pb-3 font-medium text-muted-foreground">Price</th>
                    <th className="pb-3 font-medium text-muted-foreground">Provider</th>
                    <th className="pb-3 font-medium text-muted-foreground">Created</th>
                    <th className="pb-3 font-medium text-muted-foreground"></th>
                  </tr>
                </thead>
                <tbody>
                  {extractions.map((extraction) => (
                    <tr key={extraction.id} className="border-b last:border-0">
                      <td className="py-3">
                        <div className="flex items-center gap-2">
                          {getStatusIcon(extraction.status)}
                          <Badge variant="outline" className="text-xs">
                            {extraction.status.replace(/_/g, ' ')}
                          </Badge>
                        </div>
                      </td>
                      <td className="py-3">
                        <span className="font-medium">{extraction.platformName}</span>
                      </td>
                      <td className="py-3">
                        {extraction.extractedPrice ? (
                          <span className="font-mono">
                            {extraction.currency} {extraction.extractedPrice.toFixed(2)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="py-3">
                        <Badge variant="secondary">{extraction.providerUsed || 'N/A'}</Badge>
                      </td>
                      <td className="py-3 text-sm text-muted-foreground">
                        {format(new Date(extraction.createdAt), 'MMM d, HH:mm')}
                      </td>
                      <td className="py-3">
                        <ExtractionDetailDialog extraction={extraction} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-4 pt-4 border-t">
              <p className="text-sm text-muted-foreground">
                Page {page} of {totalPages}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
