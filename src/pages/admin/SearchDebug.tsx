import { useState, useEffect } from 'react';
import { format } from 'date-fns';
import { 
  Search as SearchIcon, 
  ExternalLink, 
  CheckCircle2, 
  XCircle, 
  AlertTriangle,
  Clock,
  RefreshCw,
  Calendar,
  DollarSign,
  Link as LinkIcon,
  FileText,
  Server,
  Play,
  History,
  ShieldAlert,
  Ban,
  CloudOff,
  Eye,
  ScanEye,
  CheckCircle,
  XOctagon
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { supabase } from '@/integrations/supabase/client';
import { useAdminAuth } from '@/hooks/useAdminAuth';

interface SearchInfo {
  id: string;
  airbnbUrl: string;
  airbnbTitle: string | null;
  airbnbPrice: number | null;
  checkInDate: string | null;
  checkOutDate: string | null;
  nightsCount: number | null;
  status: string;
  createdAt: string;
}

interface PlatformExtraction {
  id: string;
  platformName: string;
  coverageTier: string;
  coverageStatus: string;
  dedicatedExtractor: string | null;
  deepLink: string;
  checkIn: string | null;
  checkOut: string | null;
  datesValidated: boolean;
  extractionStatus: string;
  extractedPrice: number | null;
  currency: string;
  includesTaxesFees: boolean | null;
  extractionError: string | null;
  failureCategory: string | null;
  failureReason: string | null;
  evidenceSnippets: any;
  providerUsed: string | null;
  lastAttemptAt: string | null;
  priceType: string;
  pageContentHash: string | null;
  extractionMetadata: any;
  // OCR validation fields
  ocrBookingCardAmountValue?: number | null;
  ocrBookingCardSnippet?: string | null;
  ocrBreakdownTotalAmountValue?: number | null;
  ocrBreakdownTotalSnippet?: string | null;
  ocrValidationStatus?: string | null;
  ocrAcceptedVia?: string | null;
  ocrMismatchReason?: string | null;
}

interface RecentSearch {
  id: string;
  airbnbUrl: string;
  airbnbTitle: string | null;
  checkInDate: string | null;
  checkOutDate: string | null;
  status: string;
  createdAt: string;
  platformCount: number;
}

const TIER_COLORS: Record<string, string> = {
  'A': 'bg-green-500 text-white',
  'B': 'bg-yellow-500 text-white',
  'C': 'bg-red-500 text-white',
};

const FAILURE_CATEGORY_CONFIG: Record<string, { color: string; icon: typeof XCircle; label: string }> = {
  'provider_error': { color: 'text-orange-500', icon: CloudOff, label: 'Provider Error' },
  'blocked': { color: 'text-red-500', icon: Ban, label: 'Blocked' },
  'dates_not_applied': { color: 'text-orange-500', icon: Calendar, label: 'Dates Not Applied' },
  'sold_out': { color: 'text-yellow-500', icon: AlertTriangle, label: 'Sold Out' },
  'unsupported': { color: 'text-muted-foreground', icon: ShieldAlert, label: 'Unsupported' },
  'render_failed': { color: 'text-orange-500', icon: Eye, label: 'Render Failed' },
  'fetch_failed': { color: 'text-orange-500', icon: CloudOff, label: 'Fetch Failed' },
  'price_not_visible': { color: 'text-yellow-500', icon: DollarSign, label: 'Price Not Visible' },
  'unknown': { color: 'text-muted-foreground', icon: AlertTriangle, label: 'Unknown' },
};

const STATUS_CONFIG: Record<string, { color: string; icon: typeof CheckCircle2 }> = {
  'success': { color: 'text-green-500', icon: CheckCircle2 },
  'pending': { color: 'text-muted-foreground', icon: Clock },
  'running': { color: 'text-blue-500', icon: RefreshCw },
};

export default function SearchDebug() {
  const { getToken } = useAdminAuth();
  const [searchInput, setSearchInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingRecent, setIsLoadingRecent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchInfo, setSearchInfo] = useState<SearchInfo | null>(null);
  const [extractions, setExtractions] = useState<PlatformExtraction[]>([]);
  const [recentSearches, setRecentSearches] = useState<RecentSearch[]>([]);

  // Fetch recent searches on mount
  useEffect(() => {
    fetchRecentSearches();
  }, []);

  const fetchRecentSearches = async () => {
    setIsLoadingRecent(true);
    try {
      const token = getToken();
      const { data, error: fnError } = await supabase.functions.invoke('admin-dashboard/recent-searches', {
        headers: { Authorization: `Bearer ${token}` },
        method: 'GET',
      });

      if (fnError) throw fnError;
      if (data?.success) {
        setRecentSearches(data.searches || []);
      }
    } catch (err: any) {
      console.error('Failed to load recent searches:', err);
    } finally {
      setIsLoadingRecent(false);
    }
  };

  const fetchSearchData = async (inputOverride?: string) => {
    const input = inputOverride || searchInput;
    if (!input.trim()) return;
    
    setIsLoading(true);
    setError(null);
    setSearchInfo(null);
    setExtractions([]);

    try {
      const token = getToken();
      
      // Determine if input is UUID or URL
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.trim());
      
      const { data, error: fnError } = await supabase.functions.invoke('admin-dashboard/search-debug', {
        headers: { Authorization: `Bearer ${token}` },
        method: 'POST',
        body: { 
          searchId: isUuid ? input.trim() : undefined,
          airbnbUrl: !isUuid ? input.trim() : undefined
        },
      });

      if (fnError) throw fnError;
      
      if (!data.success) {
        if (data.notFound) {
          setError('No search found for this Airbnb URL. Run search-alternatives first to create a search.');
        } else {
          throw new Error(data.error || 'Failed to load search data');
        }
        return;
      }

      setSearchInfo(data.search);
      setExtractions(data.extractions || []);
    } catch (err: any) {
      setError(err?.message || 'Failed to load search data');
    } finally {
      setIsLoading(false);
    }
  };

  const getStatusDisplay = (extraction: PlatformExtraction) => {
    if (extraction.extractionStatus === 'success') {
      return (
        <div className="flex items-center gap-2 text-green-500">
          <CheckCircle2 className="h-4 w-4" />
          <span className="font-medium">Success</span>
        </div>
      );
    }

    // Use failure category for better display
    const categoryConfig = extraction.failureCategory 
      ? FAILURE_CATEGORY_CONFIG[extraction.failureCategory] 
      : FAILURE_CATEGORY_CONFIG['unknown'];
    
    const config = categoryConfig || FAILURE_CATEGORY_CONFIG['unknown'];
    const Icon = config.icon;
    
    return (
      <div className={`flex items-center gap-2 ${config.color}`}>
        <Icon className="h-4 w-4" />
        <span className="font-medium">{config.label}</span>
      </div>
    );
  };

  // Group by status for summary
  const successCount = extractions.filter(e => e.extractionStatus === 'success').length;
  const failedCount = extractions.filter(e => e.extractionStatus !== 'success' && e.extractionStatus !== 'pending').length;
  const pendingCount = extractions.filter(e => e.extractionStatus === 'pending').length;

  // Count by tier
  const tierACounts = extractions.filter(e => e.coverageTier === 'A');
  const tierASuccessCount = tierACounts.filter(e => e.extractionStatus === 'success').length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Search Debug View</h1>
        <p className="text-muted-foreground">
          Inspect per-platform extraction results for truth verification
        </p>
      </div>

      {/* Search Input */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <SearchIcon className="h-5 w-5" />
            Look Up Search
          </CardTitle>
          <CardDescription>
            Enter a search ID (UUID) or Airbnb URL to inspect all platform extractions
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-3">
            <Input
              placeholder="Search ID or Airbnb URL..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && fetchSearchData()}
              className="flex-1"
            />
            <Button onClick={() => fetchSearchData()} disabled={isLoading || !searchInput.trim()}>
              {isLoading ? (
                <RefreshCw className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <SearchIcon className="h-4 w-4 mr-2" />
                  Inspect
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Recent Searches */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <History className="h-5 w-5" />
            Recent Searches
          </CardTitle>
          <CardDescription>
            Quick access to the most recent pipeline runs
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoadingRecent ? (
            <div className="flex items-center justify-center py-4">
              <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : recentSearches.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">No recent searches found</p>
          ) : (
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {recentSearches.map((search) => (
                <div 
                  key={search.id}
                  className="flex items-center justify-between p-3 border rounded-lg hover:bg-muted/50 cursor-pointer transition-colors"
                  onClick={() => {
                    setSearchInput(search.id);
                    fetchSearchData(search.id);
                  }}
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">
                      {search.airbnbTitle || 'Untitled Listing'}
                    </p>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground mt-1">
                      {search.checkInDate && search.checkOutDate && (
                        <span className="flex items-center gap-1">
                          <Calendar className="h-3 w-3" />
                          {search.checkInDate} → {search.checkOutDate}
                        </span>
                      )}
                      <span>{format(new Date(search.createdAt), 'MMM d, HH:mm')}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-xs">
                      {search.platformCount} platforms
                    </Badge>
                    <Badge 
                      variant={search.status === 'completed' ? 'default' : 'secondary'}
                      className="text-xs"
                    >
                      {search.status}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="mt-3">
            <Button variant="outline" size="sm" onClick={fetchRecentSearches} disabled={isLoadingRecent}>
              <RefreshCw className={`h-4 w-4 mr-2 ${isLoadingRecent ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </CardContent>
      </Card>

      {error && (
        <Card className="border-destructive">
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-destructive">
              <XCircle className="h-5 w-5" />
              <span>{error}</span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Search Info */}
      {searchInfo && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Source Airbnb Listing</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              <div>
                <label className="text-sm text-muted-foreground">Search ID</label>
                <p className="font-mono text-sm">{searchInfo.id}</p>
              </div>
              <div>
                <label className="text-sm text-muted-foreground">Airbnb Price</label>
                <p className="font-semibold text-lg">
                  {searchInfo.airbnbPrice ? `$${searchInfo.airbnbPrice.toLocaleString()}` : 'N/A'}
                </p>
              </div>
              <div>
                <label className="text-sm text-muted-foreground">Date Range</label>
                <p className="flex items-center gap-1">
                  <Calendar className="h-4 w-4 text-muted-foreground" />
                  {searchInfo.checkInDate && searchInfo.checkOutDate 
                    ? `${searchInfo.checkInDate} → ${searchInfo.checkOutDate}`
                    : 'N/A'}
                </p>
              </div>
              <div>
                <label className="text-sm text-muted-foreground">Nights</label>
                <p>{searchInfo.nightsCount || 'N/A'}</p>
              </div>
            </div>
            
            <Separator className="my-4" />
            
            <div>
              <label className="text-sm text-muted-foreground">Title</label>
              <p className="font-medium">{searchInfo.airbnbTitle || 'N/A'}</p>
            </div>
            
            <div className="mt-2">
              <label className="text-sm text-muted-foreground">URL</label>
              <a 
                href={searchInfo.airbnbUrl} 
                target="_blank" 
                rel="noopener noreferrer"
                className="text-primary hover:underline flex items-center gap-1 text-sm break-all"
              >
                {searchInfo.airbnbUrl}
                <ExternalLink className="h-3 w-3 flex-shrink-0" />
              </a>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Summary */}
      {extractions.length > 0 && (
        <div className="grid gap-4 md:grid-cols-5">
          <Card>
            <CardContent className="pt-6">
              <div className="text-center">
                <p className="text-3xl font-bold">{extractions.length}</p>
                <p className="text-sm text-muted-foreground">Total Platforms</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="text-center">
                <p className="text-3xl font-bold text-green-500">{successCount}</p>
                <p className="text-sm text-muted-foreground">Successful</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="text-center">
                <p className="text-3xl font-bold text-red-500">{failedCount}</p>
                <p className="text-sm text-muted-foreground">Failed/Explicit</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="text-center">
                <p className="text-3xl font-bold text-muted-foreground">{pendingCount}</p>
                <p className="text-sm text-muted-foreground">Pending</p>
              </div>
            </CardContent>
          </Card>
          <Card className="border-green-200 bg-green-50/50 dark:border-green-900 dark:bg-green-950/20">
            <CardContent className="pt-6">
              <div className="text-center">
                <p className="text-3xl font-bold text-green-600">{tierASuccessCount}/{tierACounts.length}</p>
                <p className="text-sm text-muted-foreground">Tier A Success</p>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Platform Extractions */}
      {extractions.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Platform Extraction Results</CardTitle>
            <CardDescription>
              Complete truth view — every platform, every status, every reason
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {extractions.map((extraction) => (
                <div 
                  key={extraction.id} 
                  className="border rounded-lg p-4 hover:bg-muted/50 transition-colors"
                >
                  {/* Header Row */}
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <Badge className={TIER_COLORS[extraction.coverageTier] || 'bg-muted'}>
                        Tier {extraction.coverageTier}
                      </Badge>
                      <span className="font-semibold text-lg">{extraction.platformName}</span>
                      {extraction.dedicatedExtractor && (
                        <Badge variant="outline" className="text-xs">
                          {extraction.dedicatedExtractor}
                        </Badge>
                      )}
                    </div>
                    {getStatusDisplay(extraction)}
                  </div>

                  {/* Details Grid */}
                  <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4 text-sm">
                    {/* Price */}
                    <div className="flex items-start gap-2">
                      <DollarSign className="h-4 w-4 text-muted-foreground mt-0.5" />
                      <div>
                        <p className="text-muted-foreground">Extracted Price</p>
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-semibold">
                            {extraction.extractedPrice 
                              ? `${extraction.currency} ${extraction.extractedPrice.toLocaleString()}`
                              : '—'}
                            {extraction.includesTaxesFees === true && (
                              <span className="text-xs text-muted-foreground ml-1">(incl. taxes)</span>
                            )}
                            {extraction.includesTaxesFees === false && (
                              <span className="text-xs text-muted-foreground ml-1">(excl. taxes)</span>
                            )}
                          </p>
                          {/* OCR Validation Status Badge */}
                          {extraction.ocrValidationStatus === 'accepted' && (
                            <Badge className="bg-emerald-500/20 text-emerald-700 border-emerald-500/30 text-xs">
                              <CheckCircle className="w-3 h-3 mr-1" />
                              OCR: {extraction.ocrAcceptedVia?.replace(/_/g, ' ') || 'validated'}
                            </Badge>
                          )}
                          {extraction.ocrValidationStatus === 'rejected' && (
                            <Badge className="bg-red-500/20 text-red-700 border-red-500/30 text-xs">
                              <XOctagon className="w-3 h-3 mr-1" />
                              OCR rejected
                            </Badge>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Dates Validated */}
                    <div className="flex items-start gap-2">
                      <Calendar className="h-4 w-4 text-muted-foreground mt-0.5" />
                      <div>
                        <p className="text-muted-foreground">Dates Validated</p>
                        <p className={extraction.datesValidated ? 'text-green-500 font-medium' : 'text-red-500 font-medium'}>
                          {extraction.datesValidated ? 'Yes' : 'No'}
                          {extraction.checkIn && extraction.checkOut && (
                            <span className="text-xs text-muted-foreground ml-2">
                              ({extraction.checkIn} → {extraction.checkOut})
                            </span>
                          )}
                        </p>
                      </div>
                    </div>

                    {/* Provider */}
                    <div className="flex items-start gap-2">
                      <Server className="h-4 w-4 text-muted-foreground mt-0.5" />
                      <div>
                        <p className="text-muted-foreground">Provider</p>
                        <p>{extraction.providerUsed || 'N/A'}</p>
                      </div>
                    </div>

                    {/* Last Attempt */}
                    <div className="flex items-start gap-2">
                      <Clock className="h-4 w-4 text-muted-foreground mt-0.5" />
                      <div>
                        <p className="text-muted-foreground">Last Attempt</p>
                        <p>
                          {extraction.lastAttemptAt 
                            ? format(new Date(extraction.lastAttemptAt), 'MMM d, HH:mm:ss')
                            : 'N/A'}
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* OCR Visual Reference Section */}
                  {(extraction.ocrBookingCardAmountValue || extraction.ocrBreakdownTotalAmountValue) && (
                    <div className="mt-3 p-3 bg-blue-500/10 rounded-lg border border-blue-500/20">
                      <div className="flex items-center gap-2 mb-2">
                        <ScanEye className="h-4 w-4 text-blue-600" />
                        <span className="text-sm font-medium text-blue-700">OCR Visual Reference</span>
                      </div>
                      <div className="grid gap-2 text-sm">
                        {extraction.ocrBookingCardAmountValue && (
                          <div className="flex items-center justify-between">
                            <span className="text-muted-foreground">Booking Card:</span>
                            <div className="flex items-center gap-2">
                              <span className="font-mono font-bold text-blue-700">
                                ${extraction.ocrBookingCardAmountValue.toLocaleString()}
                              </span>
                              {extraction.ocrBookingCardSnippet && (
                                <span className="text-xs text-muted-foreground truncate max-w-40">
                                  "{extraction.ocrBookingCardSnippet}"
                                </span>
                              )}
                            </div>
                          </div>
                        )}
                        {extraction.ocrBreakdownTotalAmountValue && (
                          <div className="flex items-center justify-between">
                            <span className="text-muted-foreground">Breakdown Total:</span>
                            <div className="flex items-center gap-2">
                              <span className="font-mono font-bold text-emerald-700">
                                ${extraction.ocrBreakdownTotalAmountValue.toLocaleString()}
                              </span>
                              {extraction.ocrBreakdownTotalSnippet && (
                                <span className="text-xs text-muted-foreground truncate max-w-40">
                                  "{extraction.ocrBreakdownTotalSnippet}"
                                </span>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* OCR Rejection Reason */}
                  {extraction.ocrValidationStatus === 'rejected' && extraction.ocrMismatchReason && (
                    <div className="mt-3 p-2 bg-red-500/10 rounded border border-red-500/20">
                      <div className="flex items-start gap-2">
                        <XOctagon className="h-4 w-4 text-red-600 mt-0.5 flex-shrink-0" />
                        <div>
                          <p className="text-sm font-medium text-red-700">OCR Validation Failed</p>
                          <p className="text-xs text-red-600 mt-0.5">
                            {extraction.ocrMismatchReason.replace(/_/g, ' ')}
                          </p>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Failure Reason (enhanced) */}
                  {extraction.failureReason && (
                    <div className="mt-3 p-2 bg-destructive/10 rounded text-sm">
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 flex-shrink-0" />
                        <div>
                          <p className="font-medium text-destructive">
                            {extraction.failureCategory && (
                              <Badge variant="outline" className="mr-2 text-xs">
                                {extraction.failureCategory}
                              </Badge>
                            )}
                            {extraction.failureReason}
                          </p>
                          {extraction.extractionError && extraction.extractionError !== extraction.failureReason && (
                            <p className="text-destructive/70 text-xs mt-1">{extraction.extractionError}</p>
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Evidence Snippet */}
                  {extraction.evidenceSnippets && (
                    <div className="mt-3 p-2 bg-muted rounded text-sm">
                      <div className="flex items-start gap-2">
                        <FileText className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                        <div>
                          <p className="font-medium text-muted-foreground">Evidence</p>
                          <pre className="text-xs whitespace-pre-wrap overflow-x-auto max-h-20">
                            {typeof extraction.evidenceSnippets === 'string' 
                              ? extraction.evidenceSnippets 
                              : JSON.stringify(extraction.evidenceSnippets, null, 2)}
                          </pre>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Deep Link */}
                  <div className="mt-3 flex items-center gap-2">
                    <LinkIcon className="h-4 w-4 text-muted-foreground" />
                    <a 
                      href={extraction.deepLink} 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="text-primary hover:underline text-sm flex items-center gap-1"
                    >
                      Open listing to verify
                      <ExternalLink className="h-3 w-3" />
                    </a>
                    {extraction.pageContentHash && (
                      <span className="text-xs text-muted-foreground ml-2">
                        (hash: {extraction.pageContentHash})
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Empty State */}
      {!isLoading && !error && !searchInfo && (
        <Card>
          <CardContent className="pt-6">
            <div className="text-center py-8 text-muted-foreground">
              <SearchIcon className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p className="text-lg font-medium">Enter a search ID or Airbnb URL to inspect</p>
              <p className="text-sm mt-1">
                This view shows all platform extractions for truth verification
              </p>
              <p className="text-sm mt-3">
                Or click on a recent search above to load it
              </p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
