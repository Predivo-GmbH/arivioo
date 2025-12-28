import { useState, useEffect } from 'react';
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  HelpCircle,
  Ban,
  Clock,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Globe,
  Zap,
  Shield,
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
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
import { supabase } from '@/integrations/supabase/client';
import { useAdminAuth } from '@/hooks/useAdminAuth';

interface PlatformAdapter {
  id: string;
  platform_name: string;
  platform_domain: string;
  coverage_status: string;
  coverage_reason: string | null;
  dedicated_extractor: string | null;
  reliability_score: number;
  retry_policy: string;
  next_review: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  proven_deterministic: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface PipelineRun {
  search_id: string;
  airbnb_url: string;
  run_timestamp: string;
  platforms: Array<{
    platform_name: string;
    status: string;
    extracted_price: number | null;
    dates_validated: boolean;
    error: string | null;
  }>;
  summary: {
    successes: number;
    failures: number;
    unsupported: number;
  };
}

const STATUS_CONFIG: Record<string, { icon: any; color: string; label: string }> = {
  supported: { icon: CheckCircle2, color: 'text-green-500', label: 'Supported' },
  unsupported: { icon: XCircle, color: 'text-red-500', label: 'Unsupported' },
  inquiry_based: { icon: HelpCircle, color: 'text-yellow-500', label: 'Inquiry Based' },
  reserve_required: { icon: Clock, color: 'text-orange-500', label: 'Reserve Required' },
  blocked: { icon: Ban, color: 'text-red-600', label: 'Blocked' },
  unknown: { icon: AlertTriangle, color: 'text-muted-foreground', label: 'Unknown' },
};

function StatusBadge({ status }: { status: string }) {
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.unknown;
  const Icon = config.icon;
  
  return (
    <Badge variant="outline" className="gap-1.5">
      <Icon className={`h-3.5 w-3.5 ${config.color}`} />
      {config.label}
    </Badge>
  );
}

function ReliabilityBar({ score }: { score: number }) {
  const percentage = Math.round(score * 100);
  let colorClass = 'bg-red-500';
  if (percentage >= 90) colorClass = 'bg-green-500';
  else if (percentage >= 70) colorClass = 'bg-yellow-500';
  else if (percentage >= 50) colorClass = 'bg-orange-500';
  
  return (
    <div className="flex items-center gap-2">
      <div className="w-20 h-2 bg-muted rounded-full overflow-hidden">
        <div 
          className={`h-full ${colorClass} transition-all`}
          style={{ width: `${percentage}%` }}
        />
      </div>
      <span className="text-sm text-muted-foreground">{percentage}%</span>
    </div>
  );
}

function PipelineRunCard({ run }: { run: PipelineRun }) {
  const [isOpen, setIsOpen] = useState(false);
  
  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <Card className="mb-3">
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors py-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                <div>
                  <p className="font-medium text-sm truncate max-w-md">
                    {run.airbnb_url.replace('https://www.airbnb.com/rooms/', '').split('?')[0]}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(run.run_timestamp).toLocaleString()}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="bg-green-500/10 text-green-600">
                  {run.summary.successes} success
                </Badge>
                {run.summary.failures > 0 && (
                  <Badge variant="outline" className="bg-red-500/10 text-red-600">
                    {run.summary.failures} failed
                  </Badge>
                )}
                {run.summary.unsupported > 0 && (
                  <Badge variant="outline" className="bg-muted">
                    {run.summary.unsupported} unsupported
                  </Badge>
                )}
              </div>
            </div>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="pt-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Platform</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Dates Validated</TableHead>
                  <TableHead>Price</TableHead>
                  <TableHead>Error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {run.platforms.map((p, idx) => (
                  <TableRow key={idx}>
                    <TableCell className="font-medium">{p.platform_name}</TableCell>
                    <TableCell>
                      <Badge 
                        variant={p.status === 'success' ? 'default' : 'outline'}
                        className={p.status === 'success' ? 'bg-green-500' : ''}
                      >
                        {p.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {p.dates_validated ? (
                        <CheckCircle2 className="h-4 w-4 text-green-500" />
                      ) : (
                        <XCircle className="h-4 w-4 text-muted-foreground" />
                      )}
                    </TableCell>
                    <TableCell>
                      {p.extracted_price ? `$${p.extracted_price.toFixed(2)}` : '-'}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground max-w-xs truncate">
                      {p.error || '-'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

export default function PlatformCoverage() {
  const { getToken } = useAdminAuth();
  const [platforms, setPlatforms] = useState<PlatformAdapter[]>([]);
  const [pipelineRuns, setPipelineRuns] = useState<PipelineRun[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = async () => {
    setIsLoading(true);
    setError(null);
    
    try {
      // Fetch platform adapters directly
      const { data: adaptersData, error: adaptersError } = await supabase
        .from('platform_adapters')
        .select('*')
        .order('coverage_status', { ascending: true })
        .order('platform_name', { ascending: true });
      
      if (adaptersError) throw adaptersError;
      setPlatforms(adaptersData || []);
      
      // Fetch recent pipeline runs from price_extractions
      const { data: extractionsData, error: extractionsError } = await supabase
        .from('price_extractions')
        .select(`
          id,
          search_id,
          platform_name,
          extraction_status,
          extracted_price,
          dates_validated,
          extraction_error,
          updated_at,
          searches!inner(airbnb_url)
        `)
        .order('updated_at', { ascending: false })
        .limit(100);
      
      if (extractionsError) throw extractionsError;
      
      // Group by search_id to form pipeline runs
      const runsMap = new Map<string, PipelineRun>();
      for (const ext of extractionsData || []) {
        const searchId = ext.search_id;
        if (!searchId) continue;
        
        if (!runsMap.has(searchId)) {
          runsMap.set(searchId, {
            search_id: searchId,
            airbnb_url: (ext.searches as any)?.airbnb_url || 'Unknown',
            run_timestamp: ext.updated_at,
            platforms: [],
            summary: { successes: 0, failures: 0, unsupported: 0 },
          });
        }
        
        const run = runsMap.get(searchId)!;
        const isSuccess = ext.extraction_status === 'success';
        const isUnsupported = ['blocked_captcha_or_bot', 'render_failed', 'listing_unavailable'].includes(ext.extraction_status || '');
        
        run.platforms.push({
          platform_name: ext.platform_name || 'Unknown',
          status: ext.extraction_status || 'unknown',
          extracted_price: ext.extracted_price,
          dates_validated: ext.dates_validated || false,
          error: ext.extraction_error,
        });
        
        if (isSuccess) run.summary.successes++;
        else if (isUnsupported) run.summary.unsupported++;
        else run.summary.failures++;
      }
      
      // Convert to array and sort by timestamp
      const runsArray = Array.from(runsMap.values())
        .sort((a, b) => new Date(b.run_timestamp).getTime() - new Date(a.run_timestamp).getTime())
        .slice(0, 20);
      
      setPipelineRuns(runsArray);
    } catch (err: any) {
      setError(err?.message || 'Failed to load data');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const supportedCount = platforms.filter(p => p.coverage_status === 'supported').length;
  const blockedCount = platforms.filter(p => p.coverage_status === 'blocked').length;
  const unknownCount = platforms.filter(p => p.coverage_status === 'unknown').length;

  if (isLoading) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold">Platform Coverage</h1>
        <div className="grid gap-4 md:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <Card key={i} className="animate-pulse">
              <CardHeader className="pb-2">
                <div className="h-4 bg-muted rounded w-24"></div>
              </CardHeader>
              <CardContent>
                <div className="h-8 bg-muted rounded w-16"></div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold">Platform Coverage</h1>
        <Card className="border-destructive">
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              <span>{error}</span>
            </div>
            <Button onClick={fetchData} className="mt-4">
              <RefreshCw className="mr-2 h-4 w-4" /> Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Platform Coverage</h1>
          <p className="text-muted-foreground">
            Monitor supported platforms and pipeline progress
          </p>
        </div>
        <Button variant="outline" onClick={fetchData} disabled={isLoading}>
          <RefreshCw className={`mr-2 h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* Summary Cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Supported</CardTitle>
            <CheckCircle2 className="h-4 w-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">{supportedCount}</div>
            <p className="text-xs text-muted-foreground">Production-ready platforms</p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Blocked</CardTitle>
            <Ban className="h-4 w-4 text-red-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">{blockedCount}</div>
            <p className="text-xs text-muted-foreground">Network/bot blocked</p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Pending Eval</CardTitle>
            <AlertTriangle className="h-4 w-4 text-yellow-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-yellow-600">{unknownCount}</div>
            <p className="text-xs text-muted-foreground">Awaiting classification</p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Platforms</CardTitle>
            <Globe className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{platforms.length}</div>
            <p className="text-xs text-muted-foreground">Configured adapters</p>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="coverage" className="space-y-4">
        <TabsList>
          <TabsTrigger value="coverage" className="gap-2">
            <Shield className="h-4 w-4" />
            Platform Coverage
          </TabsTrigger>
          <TabsTrigger value="pipeline" className="gap-2">
            <Zap className="h-4 w-4" />
            Pipeline Progress
          </TabsTrigger>
        </TabsList>

        <TabsContent value="coverage">
          <Card>
            <CardHeader>
              <CardTitle>Platform Coverage Overview</CardTitle>
              <CardDescription>
                Which platforms do we support today, which do we not, and why?
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Platform</TableHead>
                    <TableHead>Domain</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>Extractor</TableHead>
                    <TableHead>Reliability</TableHead>
                    <TableHead>Last Success</TableHead>
                    <TableHead>Last Failure</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {platforms.map((platform) => (
                    <TableRow key={platform.id}>
                      <TableCell className="font-medium">{platform.platform_name}</TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {platform.platform_domain}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={platform.coverage_status} />
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground max-w-xs">
                        {platform.coverage_reason || '-'}
                      </TableCell>
                      <TableCell>
                        {platform.dedicated_extractor ? (
                          <Badge variant="secondary" className="font-mono text-xs">
                            {platform.dedicated_extractor}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <ReliabilityBar score={platform.reliability_score || 0} />
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {platform.last_success_at 
                          ? new Date(platform.last_success_at).toLocaleDateString()
                          : '-'}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {platform.last_failure_at 
                          ? new Date(platform.last_failure_at).toLocaleDateString()
                          : '-'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="pipeline">
          <Card>
            <CardHeader>
              <CardTitle>Recent Pipeline Runs</CardTitle>
              <CardDescription>
                Per-search extraction outcomes across platforms
              </CardDescription>
            </CardHeader>
            <CardContent>
              {pipelineRuns.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  No pipeline runs found
                </div>
              ) : (
                <div className="space-y-2">
                  {pipelineRuns.map((run) => (
                    <PipelineRunCard key={run.search_id} run={run} />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* TODO: Coverage Program Hooks */}
      {/* 
        Future expansion hooks:
        - automatic adapter candidate backlog creation when new platforms appear
        - platform classification persistence 
        - reliability_score decay and revalidation hooks
      */}
    </div>
  );
}
