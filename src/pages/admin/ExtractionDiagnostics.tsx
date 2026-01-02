import { useState, useEffect } from 'react';
import {
  Search,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Clock,
  Shield,
  ShieldX,
  ShieldCheck,
  ExternalLink,
  ChevronRight,
  Eye,
  Ban,
  HelpCircle,
  Loader2,
  Calendar,
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { supabase } from '@/integrations/supabase/client';
import { useAdminAuth } from '@/hooks/useAdminAuth';

interface ExtractionDiagnostic {
  platform_name: string;
  search_result_id: string;
  listing_url: string;
  scraped_price: number | null;
  match_confidence: number | null;
  match_type: string | null;
  coverage_tier: string;
  tier_reason: string | null;
  dedicated_extractor: string | null;
  extraction_attempted: boolean;
  extraction_id: string | null;
  extraction_path_used: string;
  provider_used: string;
  extraction_status: string;
  failure_reason: string | null;
  dates_applied: boolean | null;
  detected_checkin: string | null;
  detected_checkout: string | null;
  includes_taxes_fees: boolean | null;
  confidence_score: number | null;
  extracted_price: number | null;
  currency: string | null;
  price_status: string;
  verification_failures: string[];
  last_attempt_at: string | null;
}

interface SearchSummary {
  id: string;
  airbnb_url: string;
  airbnb_title: string | null;
  status: string;
  created_at: string;
  check_in_date: string | null;
  check_out_date: string | null;
  extraction_stats: {
    total: number;
    success: number;
    failed: number;
    pending: number;
  };
}

interface SystemicIssues {
  never_attempted: number;
  blocked: number;
  render_failed: number;
  timeout: number;
  verified: number;
  unverified: number;
  tier_a_failures: number;
}

const STATUS_CONFIG: Record<string, { icon: any; color: string; label: string }> = {
  success: { icon: CheckCircle2, color: 'text-green-500', label: 'Success' },
  blocked: { icon: Ban, color: 'text-red-500', label: 'Blocked' },
  render_failed: { icon: XCircle, color: 'text-orange-500', label: 'Render Failed' },
  timeout: { icon: Clock, color: 'text-yellow-500', label: 'Timeout' },
  price_not_found: { icon: HelpCircle, color: 'text-muted-foreground', label: 'Price Not Found' },
  pending: { icon: Loader2, color: 'text-blue-500', label: 'Pending' },
  not_attempted: { icon: XCircle, color: 'text-muted-foreground', label: 'Not Attempted' },
  internal_error: { icon: AlertTriangle, color: 'text-red-600', label: 'Internal Error' },
};

const PRICE_STATUS_CONFIG: Record<string, { icon: any; color: string; bgColor: string }> = {
  verified: { icon: ShieldCheck, color: 'text-green-600', bgColor: 'bg-green-500/10' },
  unverified: { icon: Shield, color: 'text-yellow-600', bgColor: 'bg-yellow-500/10' },
  unavailable: { icon: ShieldX, color: 'text-red-600', bgColor: 'bg-red-500/10' },
};

const VERIFICATION_FAILURE_LABELS: Record<string, string> = {
  extraction_not_successful: 'Extraction failed',
  dates_not_validated: 'Dates not validated',
  taxes_fees_not_included: 'Missing taxes/fees',
  low_confidence: 'Low confidence score',
  no_extraction_attempt: 'No extraction attempted',
};

function ExtractionStatusBadge({ status }: { status: string }) {
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.internal_error;
  const Icon = config.icon;
  return (
    <Badge variant="outline" className="gap-1">
      <Icon className={`h-3 w-3 ${config.color}`} />
      {config.label}
    </Badge>
  );
}

function PriceStatusBadge({ status }: { status: string }) {
  const config = PRICE_STATUS_CONFIG[status] || PRICE_STATUS_CONFIG.unavailable;
  const Icon = config.icon;
  return (
    <Badge variant="outline" className={`gap-1 ${config.bgColor} ${config.color}`}>
      <Icon className="h-3 w-3" />
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </Badge>
  );
}

function TierBadge({ tier }: { tier: string }) {
  const colors: Record<string, string> = {
    A: 'bg-green-100 text-green-700',
    B: 'bg-yellow-100 text-yellow-700',
    C: 'bg-red-100 text-red-700',
  };
  return (
    <Badge variant="outline" className={colors[tier] || 'bg-muted'}>
      Tier {tier}
    </Badge>
  );
}

function DiagnosticRow({ diagnostic }: { diagnostic: ExtractionDiagnostic }) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <TableRow className="cursor-pointer hover:bg-muted/50" onClick={() => setIsOpen(!isOpen)}>
        <TableCell>
          <div className="flex items-center gap-2">
            <ChevronRight className={`h-4 w-4 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
            <span className="font-medium">{diagnostic.platform_name}</span>
          </div>
        </TableCell>
        <TableCell>
          <TierBadge tier={diagnostic.coverage_tier} />
        </TableCell>
        <TableCell>
          <ExtractionStatusBadge status={diagnostic.extraction_status} />
        </TableCell>
        <TableCell>
          <PriceStatusBadge status={diagnostic.price_status} />
        </TableCell>
        <TableCell className="text-right font-mono">
          {diagnostic.extracted_price 
            ? `${diagnostic.currency || '$'}${diagnostic.extracted_price.toFixed(2)}`
            : diagnostic.scraped_price 
              ? <span className="text-muted-foreground">${diagnostic.scraped_price.toFixed(2)} (scraped)</span>
              : '—'}
        </TableCell>
        <TableCell>
          {diagnostic.dates_applied === true && <CheckCircle2 className="h-4 w-4 text-green-500" />}
          {diagnostic.dates_applied === false && <XCircle className="h-4 w-4 text-red-500" />}
          {diagnostic.dates_applied === null && <span className="text-muted-foreground">—</span>}
        </TableCell>
        <TableCell>
          {diagnostic.includes_taxes_fees === true && <CheckCircle2 className="h-4 w-4 text-green-500" />}
          {diagnostic.includes_taxes_fees === false && <XCircle className="h-4 w-4 text-red-500" />}
          {diagnostic.includes_taxes_fees === null && <span className="text-muted-foreground">—</span>}
        </TableCell>
      </TableRow>
      <CollapsibleContent asChild>
        <TableRow className="bg-muted/30">
          <TableCell colSpan={7} className="p-4">
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {/* Extraction Details */}
              <div className="space-y-2">
                <h4 className="font-medium text-sm">Extraction Details</h4>
                <div className="text-sm space-y-1">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Attempted:</span>
                    <span>{diagnostic.extraction_attempted ? 'Yes' : 'No'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Path:</span>
                    <span className="capitalize">{diagnostic.extraction_path_used}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Provider:</span>
                    <span className="capitalize">{diagnostic.provider_used}</span>
                  </div>
                  {diagnostic.dedicated_extractor && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Extractor:</span>
                      <span className="font-mono text-xs">{diagnostic.dedicated_extractor}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Date Validation */}
              <div className="space-y-2">
                <h4 className="font-medium text-sm">Date Validation</h4>
                <div className="text-sm space-y-1">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Dates Applied:</span>
                    <span>{diagnostic.dates_applied === null ? 'Unknown' : diagnostic.dates_applied ? 'Yes' : 'No'}</span>
                  </div>
                  {diagnostic.detected_checkin && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Check-in:</span>
                      <span>{diagnostic.detected_checkin}</span>
                    </div>
                  )}
                  {diagnostic.detected_checkout && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Check-out:</span>
                      <span>{diagnostic.detected_checkout}</span>
                    </div>
                  )}
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Confidence:</span>
                    <span>{diagnostic.confidence_score !== null ? `${(diagnostic.confidence_score * 100).toFixed(0)}%` : 'N/A'}</span>
                  </div>
                </div>
              </div>

              {/* Verification Failures */}
              <div className="space-y-2">
                <h4 className="font-medium text-sm">Verification Status</h4>
                {diagnostic.verification_failures.length === 0 ? (
                  <div className="flex items-center gap-2 text-green-600 text-sm">
                    <ShieldCheck className="h-4 w-4" />
                    All checks passed
                  </div>
                ) : (
                  <div className="space-y-1">
                    {diagnostic.verification_failures.map((failure) => (
                      <div key={failure} className="flex items-center gap-2 text-sm text-red-600">
                        <XCircle className="h-3 w-3" />
                        {VERIFICATION_FAILURE_LABELS[failure] || failure}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Failure Reason (full width) */}
              {diagnostic.failure_reason && (
                <div className="md:col-span-2 lg:col-span-3 space-y-2">
                  <h4 className="font-medium text-sm">Failure Reason</h4>
                  <div className="text-sm text-muted-foreground bg-muted p-2 rounded font-mono text-xs overflow-x-auto">
                    {diagnostic.failure_reason}
                  </div>
                </div>
              )}

              {/* Links */}
              <div className="md:col-span-2 lg:col-span-3 flex gap-2">
                <Button variant="outline" size="sm" asChild>
                  <a href={diagnostic.listing_url} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="h-3 w-3 mr-1" />
                    View Listing
                  </a>
                </Button>
                {diagnostic.last_attempt_at && (
                  <span className="text-xs text-muted-foreground self-center">
                    Last attempt: {new Date(diagnostic.last_attempt_at).toLocaleString()}
                  </span>
                )}
              </div>
            </div>
          </TableCell>
        </TableRow>
      </CollapsibleContent>
    </Collapsible>
  );
}

export default function ExtractionDiagnostics() {
  const { getToken } = useAdminAuth();
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searches, setSearches] = useState<SearchSummary[]>([]);
  const [selectedSearchId, setSelectedSearchId] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<ExtractionDiagnostic[]>([]);
  const [systemicIssues, setSystemicIssues] = useState<SystemicIssues | null>(null);
  const [searchFilter, setSearchFilter] = useState('');
  const [selectedSearch, setSelectedSearch] = useState<any>(null);

  const fetchSearches = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const token = getToken();
      if (!token) throw new Error('Not authenticated');

      const { data, error: invokeError } = await supabase.functions.invoke('admin-dashboard/extraction-diagnostics', {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });

      if (invokeError) throw invokeError;
      if (data?.error) throw new Error(data.error);

      setSearches(data.searches || []);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch searches');
    } finally {
      setIsLoading(false);
    }
  };

  const fetchDiagnostics = async (searchId: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const token = getToken();
      if (!token) throw new Error('Not authenticated');

      const { data, error: invokeError } = await supabase.functions.invoke(`admin-dashboard/extraction-diagnostics?searchId=${searchId}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });

      if (invokeError) throw invokeError;
      if (data?.error) throw new Error(data.error);

      setDiagnostics(data.diagnostics || []);
      setSystemicIssues(data.systemic_issues || null);
      setSelectedSearch(data.search);
      setSelectedSearchId(searchId);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch diagnostics');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchSearches();
  }, []);

  const filteredSearches = searches.filter(s => 
    s.airbnb_url?.toLowerCase().includes(searchFilter.toLowerCase()) ||
    s.airbnb_title?.toLowerCase().includes(searchFilter.toLowerCase()) ||
    s.id.includes(searchFilter)
  );

  if (selectedSearchId && diagnostics.length >= 0) {
    return (
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <Button variant="ghost" onClick={() => { setSelectedSearchId(null); setDiagnostics([]); }} className="mb-2">
              ← Back to Searches
            </Button>
            <h1 className="text-2xl font-bold">Extraction Diagnostics</h1>
            {selectedSearch && (
              <p className="text-muted-foreground text-sm mt-1">
                {selectedSearch.airbnb_title || selectedSearch.airbnb_url?.split('/rooms/')[1]?.split('?')[0] || selectedSearch.id}
                {selectedSearch.check_in_date && selectedSearch.check_out_date && (
                  <span className="ml-2">
                    ({selectedSearch.check_in_date} → {selectedSearch.check_out_date})
                  </span>
                )}
              </p>
            )}
          </div>
          <Button onClick={() => fetchDiagnostics(selectedSearchId)} variant="outline" disabled={isLoading}>
            <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>

        {/* Systemic Issues Summary */}
        {systemicIssues && (
          <div className="grid gap-4 md:grid-cols-4 lg:grid-cols-7">
            <Card className={systemicIssues.verified > 0 ? 'border-green-200' : ''}>
              <CardHeader className="pb-2">
                <CardDescription>Verified</CardDescription>
                <CardTitle className="text-2xl text-green-600">{systemicIssues.verified}</CardTitle>
              </CardHeader>
            </Card>
            <Card className={systemicIssues.unverified > 0 ? 'border-yellow-200' : ''}>
              <CardHeader className="pb-2">
                <CardDescription>Unverified</CardDescription>
                <CardTitle className="text-2xl text-yellow-600">{systemicIssues.unverified}</CardTitle>
              </CardHeader>
            </Card>
            <Card className={systemicIssues.never_attempted > 0 ? 'border-muted' : ''}>
              <CardHeader className="pb-2">
                <CardDescription>Not Attempted</CardDescription>
                <CardTitle className="text-2xl text-muted-foreground">{systemicIssues.never_attempted}</CardTitle>
              </CardHeader>
            </Card>
            <Card className={systemicIssues.blocked > 0 ? 'border-red-200' : ''}>
              <CardHeader className="pb-2">
                <CardDescription>Blocked</CardDescription>
                <CardTitle className="text-2xl text-red-600">{systemicIssues.blocked}</CardTitle>
              </CardHeader>
            </Card>
            <Card className={systemicIssues.render_failed > 0 ? 'border-orange-200' : ''}>
              <CardHeader className="pb-2">
                <CardDescription>Render Failed</CardDescription>
                <CardTitle className="text-2xl text-orange-600">{systemicIssues.render_failed}</CardTitle>
              </CardHeader>
            </Card>
            <Card className={systemicIssues.timeout > 0 ? 'border-yellow-200' : ''}>
              <CardHeader className="pb-2">
                <CardDescription>Timeout</CardDescription>
                <CardTitle className="text-2xl text-yellow-600">{systemicIssues.timeout}</CardTitle>
              </CardHeader>
            </Card>
            <Card className={systemicIssues.tier_a_failures > 0 ? 'border-red-300 bg-red-50' : ''}>
              <CardHeader className="pb-2">
                <CardDescription>Tier A Failures</CardDescription>
                <CardTitle className={`text-2xl ${systemicIssues.tier_a_failures > 0 ? 'text-red-700' : ''}`}>
                  {systemicIssues.tier_a_failures}
                </CardTitle>
              </CardHeader>
            </Card>
          </div>
        )}

        {error && (
          <Card className="border-destructive">
            <CardContent className="pt-6">
              <p className="text-destructive">{error}</p>
            </CardContent>
          </Card>
        )}

        {/* Diagnostics Table */}
        <Card>
          <CardHeader>
            <CardTitle>Platform Extraction Details</CardTitle>
            <CardDescription>
              Click a row to expand diagnostic details
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="h-40 flex items-center justify-center">
                <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : diagnostics.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                No platforms found for this search
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Platform</TableHead>
                    <TableHead>Tier</TableHead>
                    <TableHead>Extraction Status</TableHead>
                    <TableHead>Price Status</TableHead>
                    <TableHead className="text-right">Price</TableHead>
                    <TableHead>Dates</TableHead>
                    <TableHead>Taxes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {diagnostics.map((d) => (
                    <DiagnosticRow key={d.search_result_id} diagnostic={d} />
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  // Search Selection View
  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Extraction Diagnostics</h1>
          <p className="text-muted-foreground">
            Select a search to view per-platform extraction diagnostics
          </p>
        </div>
        <Button onClick={fetchSearches} variant="outline" disabled={isLoading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      <div className="flex items-center gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Filter by URL, title, or search ID..."
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      {error && (
        <Card className="border-destructive">
          <CardContent className="pt-6">
            <p className="text-destructive">{error}</p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Recent Searches</CardTitle>
          <CardDescription>
            {filteredSearches.length} searches shown
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="h-40 flex items-center justify-center">
              <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Search</TableHead>
                  <TableHead>Dates</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-center">Extractions</TableHead>
                  <TableHead className="text-center">Success</TableHead>
                  <TableHead className="text-center">Failed</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredSearches.map((search) => (
                  <TableRow key={search.id} className="cursor-pointer hover:bg-muted/50" onClick={() => fetchDiagnostics(search.id)}>
                    <TableCell>
                      <div className="max-w-xs truncate">
                        <span className="font-medium">
                          {search.airbnb_title || search.airbnb_url?.split('/rooms/')[1]?.split('?')[0] || search.id}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {search.check_in_date && search.check_out_date ? (
                        <span>{search.check_in_date} → {search.check_out_date}</span>
                      ) : '—'}
                    </TableCell>
                    <TableCell>
                      <Badge variant={search.status === 'completed' ? 'default' : 'secondary'}>
                        {search.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-center">{search.extraction_stats.total}</TableCell>
                    <TableCell className="text-center text-green-600">{search.extraction_stats.success}</TableCell>
                    <TableCell className="text-center text-red-600">{search.extraction_stats.failed}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {new Date(search.created_at).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <Button variant="ghost" size="sm">
                        <Eye className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
