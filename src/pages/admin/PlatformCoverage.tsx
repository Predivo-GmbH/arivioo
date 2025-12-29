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
  TrendingUp,
  Target,
  PlayCircle,
  History,
  Loader2,
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
  coverage_tier: string | null;
  tier_reason: string | null;
  tier_updated_at: string | null;
  dedicated_extractor: string | null;
  reliability_score: number;
  retry_policy: string;
  next_review: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_attempt_at: string | null;
  last_outcome_type: string | null;
  total_attempts: number;
  total_successes: number;
  total_failures: number;
  gate_1_passed: boolean;
  gate_2_passed: boolean;
  gate_3_passed: boolean;
  promotion_score: number;
  last_scored_at: string | null;
  promotion_candidate: boolean;
  promotion_candidate_reason: string | null;
  promotion_status: string;
  promotion_in_progress: boolean;
  promotion_started_at: string | null;
  promotion_started_by: string | null;
  promotion_source_score: number | null;
  promotion_snapshot: any;
  promotion_notes: string | null;
  promotion_decision_at: string | null;
  promotion_decision_by: string | null;
  proven_deterministic: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

// Compute promotion readiness for Tier B platforms
function getPromotionReadiness(platform: PlatformAdapter): { 
  isCandidate: boolean; 
  reason: string;
  successRate: number;
} {
  if (platform.coverage_tier !== 'B') {
    return { isCandidate: false, reason: 'Not Tier B', successRate: 0 };
  }
  
  const attempts = platform.total_attempts || 0;
  const successes = platform.total_successes || 0;
  const successRate = attempts > 0 ? (successes / attempts) * 100 : 0;
  
  // Must have at least one real price extraction success
  if (successes === 0) {
    return { isCandidate: false, reason: 'No successful extractions yet', successRate };
  }
  
  // Check if last outcome was a blocking issue
  const blockingOutcomes = ['blocked', 'login_required', 'reserve_required', 'platform_unsupported'];
  if (platform.last_outcome_type && blockingOutcomes.includes(platform.last_outcome_type)) {
    return { isCandidate: false, reason: `Last attempt: ${platform.last_outcome_type}`, successRate };
  }
  
  // Promotion candidate if success rate > 50% with at least 3 attempts
  if (attempts >= 3 && successRate >= 50) {
    return { isCandidate: true, reason: `${successRate.toFixed(0)}% success rate (${successes}/${attempts})`, successRate };
  }
  
  // Has potential but needs more data
  if (successes > 0 && attempts < 3) {
    return { isCandidate: false, reason: `Needs more data (${attempts} attempts)`, successRate };
  }
  
  return { isCandidate: false, reason: `Low success rate: ${successRate.toFixed(0)}%`, successRate };
}

// Get dominant failure reason from last_outcome_type
function getDominantFailureReason(platform: PlatformAdapter): string {
  if (!platform.last_outcome_type || platform.last_outcome_type === 'success') {
    return '-';
  }
  
  const outcomeLabels: Record<string, string> = {
    dates_not_applied: 'Dates not applied',
    no_availability: 'No availability',
    price_not_found: 'Price not found',
    blocked: 'Blocked/Bot detection',
    login_required: 'Login required',
    reserve_required: 'Reserve required',
    platform_unsupported: 'Unsupported',
    other_failure: 'Other failure',
  };
  
  return outcomeLabels[platform.last_outcome_type] || platform.last_outcome_type;
}

// Tier configuration with descriptions
const TIER_CONFIG: Record<string, { label: string; color: string; bgColor: string; description: string }> = {
  A: { 
    label: 'Tier A', 
    color: 'text-green-700', 
    bgColor: 'bg-green-100',
    description: 'Production-supported with dedicated extractor, proven repeatability'
  },
  B: { 
    label: 'Tier B', 
    color: 'text-yellow-700', 
    bgColor: 'bg-yellow-100',
    description: 'Best effort extraction, no SLA on success'
  },
  C: { 
    label: 'Tier C', 
    color: 'text-red-700', 
    bgColor: 'bg-red-100',
    description: 'Unsupported - blocked, requires login, or non-compliant'
  },
};

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

function TierBadge({ tier }: { tier: string | null }) {
  const config = TIER_CONFIG[tier || 'B'] || TIER_CONFIG['B'];
  
  return (
    <Badge variant="outline" className={`${config.bgColor} ${config.color} font-semibold`}>
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

function TierLegend() {
  return (
    <Card className="mb-4">
      <CardHeader className="py-3">
        <CardTitle className="text-sm font-medium">Coverage Tier Legend</CardTitle>
      </CardHeader>
      <CardContent className="py-2">
        <div className="grid gap-2 md:grid-cols-3">
          {Object.entries(TIER_CONFIG).map(([tier, config]) => (
            <div key={tier} className="flex items-start gap-2">
              <Badge variant="outline" className={`${config.bgColor} ${config.color} font-semibold shrink-0`}>
                {config.label}
              </Badge>
              <span className="text-xs text-muted-foreground">{config.description}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
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
  const [isStartingPromotion, setIsStartingPromotion] = useState(false);
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

  // Start Promotion Work - mark platform as in_progress
  // Uses the admin-dashboard edge function to ensure proper authorization and audit logging
  const startPromotionWork = async (platform: PlatformAdapter) => {
    if (!window.confirm(`Start promotion work for ${platform.platform_name}?\n\nThis will lock scoring for this platform and begin the promotion workflow.`)) {
      return;
    }
    
    setIsStartingPromotion(true);
    try {
      const token = getToken();
      if (!token) {
        throw new Error('Not authenticated. Please log in again.');
      }

      const snapshot = {
        gates: {
          gate_1_passed: platform.gate_1_passed,
          gate_2_passed: platform.gate_2_passed,
          gate_3_passed: platform.gate_3_passed,
        },
        evidence: {
          total_attempts: platform.total_attempts,
          total_successes: platform.total_successes,
          total_failures: platform.total_failures,
          last_success_at: platform.last_success_at,
          last_outcome_type: platform.last_outcome_type,
        },
        score: platform.promotion_score,
        captured_at: new Date().toISOString(),
      };
      
      // Use admin-dashboard edge function for secure server-side update with audit logging
      const { data, error } = await supabase.functions.invoke('admin-dashboard/adapters', {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` },
        body: {
          id: platform.id,
          promotion_in_progress: true,
          promotion_status: 'in_progress',
          promotion_started_at: new Date().toISOString(),
          promotion_started_by: 'admin',
          promotion_source_score: platform.promotion_score,
          promotion_snapshot: snapshot,
        },
      });
      
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      
      await fetchData();
    } catch (err: any) {
      setError(err?.message || 'Failed to start promotion work');
    } finally {
      setIsStartingPromotion(false);
    }
  };

  // Complete promotion - promote to Tier A or reject
  // Uses the admin-dashboard edge function to ensure proper authorization and audit logging
  const completePromotion = async (platform: PlatformAdapter, decision: 'promoted' | 'rejected', notes: string) => {
    try {
      const token = getToken();
      if (!token) {
        throw new Error('Not authenticated. Please log in again.');
      }

      const updates: Record<string, any> = {
        id: platform.id,
        promotion_in_progress: false,
        promotion_status: decision,
        promotion_decision_at: new Date().toISOString(),
        promotion_decision_by: 'admin',
        promotion_notes: notes,
      };
      
      if (decision === 'promoted') {
        updates.coverage_tier = 'A';
        updates.tier_reason = `Promoted from Tier B. ${notes}`;
        updates.tier_updated_at = new Date().toISOString();
      }
      
      // Use admin-dashboard edge function for secure server-side update with audit logging
      const { data, error } = await supabase.functions.invoke('admin-dashboard/adapters', {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` },
        body: updates,
      });
      
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      
      await fetchData();
    } catch (err: any) {
      setError(err?.message || 'Failed to complete promotion');
    }
  };

  const tierACount = platforms.filter(p => p.coverage_tier === 'A').length;
  const tierBCount = platforms.filter(p => p.coverage_tier === 'B').length;
  const tierCCount = platforms.filter(p => p.coverage_tier === 'C').length;
  const tierBPlatforms = platforms.filter(p => p.coverage_tier === 'B');
  const promotionCandidate = platforms.find(p => p.promotion_candidate === true && p.coverage_tier === 'B');
  const promotionInProgress = platforms.find(p => p.promotion_in_progress === true);
  const promotionHistory = platforms.filter(p => p.promotion_status === 'promoted' || p.promotion_status === 'rejected');

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
            <CardTitle className="text-sm font-medium text-muted-foreground">Tier A (Supported)</CardTitle>
            <CheckCircle2 className="h-4 w-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">{tierACount}</div>
            <p className="text-xs text-muted-foreground">Production-proven extractors</p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Tier B (Attempted)</CardTitle>
            <AlertTriangle className="h-4 w-4 text-yellow-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-yellow-600">{tierBCount}</div>
            <p className="text-xs text-muted-foreground">Best effort, no SLA</p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Tier C (Unsupported)</CardTitle>
            <Ban className="h-4 w-4 text-red-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">{tierCCount}</div>
            <p className="text-xs text-muted-foreground">Blocked or non-compliant</p>
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
          <TierLegend />
          
          {/* Promotion In Progress Section */}
          {promotionInProgress && (
            <Card className="mb-4 border-blue-300 bg-blue-50/50">
              <CardHeader className="pb-2">
                <div className="flex items-center gap-2">
                  <Loader2 className="h-5 w-5 text-blue-600 animate-spin" />
                  <CardTitle className="text-lg">Promotion Work In Progress</CardTitle>
                </div>
              </CardHeader>
              <CardContent>
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-3 mb-2">
                      <span className="text-xl font-bold">{promotionInProgress.platform_name}</span>
                      <Badge className="bg-blue-500 text-white">In Progress</Badge>
                      <Badge variant="outline">Locked Score: {((promotionInProgress.promotion_source_score || 0) * 100).toFixed(0)}%</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground mb-2">
                      Started: {promotionInProgress.promotion_started_at ? new Date(promotionInProgress.promotion_started_at).toLocaleString() : '-'}
                      {promotionInProgress.promotion_started_by && ` by ${promotionInProgress.promotion_started_by}`}
                    </p>
                    <p className="text-sm text-muted-foreground mb-3">
                      Scoring is locked. Build a dedicated extractor, run repeatability tests, then mark as promoted or rejected.
                    </p>
                    <div className="flex items-center gap-4 text-sm mb-4">
                      <div className="flex items-center gap-1">
                        {promotionInProgress.gate_1_passed ? (
                          <CheckCircle2 className="h-4 w-4 text-green-500" />
                        ) : (
                          <XCircle className="h-4 w-4 text-red-500" />
                        )}
                        <span>Gate 1: Dates</span>
                      </div>
                      <div className="flex items-center gap-1">
                        {promotionInProgress.gate_2_passed ? (
                          <CheckCircle2 className="h-4 w-4 text-green-500" />
                        ) : (
                          <XCircle className="h-4 w-4 text-red-500" />
                        )}
                        <span>Gate 2: Price</span>
                      </div>
                      <div className="flex items-center gap-1">
                        {promotionInProgress.gate_3_passed ? (
                          <CheckCircle2 className="h-4 w-4 text-green-500" />
                        ) : (
                          <XCircle className="h-4 w-4 text-red-500" />
                        )}
                        <span>Gate 3: Failure Quality</span>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button 
                        size="sm"
                        className="bg-green-600 hover:bg-green-700"
                        onClick={() => {
                          const notes = window.prompt('Enter promotion notes (extractor name, repeatability results, etc.):');
                          if (notes) completePromotion(promotionInProgress, 'promoted', notes);
                        }}
                      >
                        <CheckCircle2 className="h-4 w-4 mr-1" />
                        Mark as Promoted
                      </Button>
                      <Button 
                        size="sm"
                        variant="destructive"
                        onClick={() => {
                          const notes = window.prompt('Enter rejection reason:');
                          if (notes) completePromotion(promotionInProgress, 'rejected', notes);
                        }}
                      >
                        <XCircle className="h-4 w-4 mr-1" />
                        Mark as Rejected
                      </Button>
                    </div>
                  </div>
                  <div className="text-right text-sm text-muted-foreground">
                    <p>Attempts: {promotionInProgress.total_attempts || 0}</p>
                    <p>Successes: {promotionInProgress.total_successes || 0}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
          
          {/* Recommended Promotion Candidate Section */}
          {promotionCandidate && !promotionInProgress && (
            <Card className="mb-4 border-green-300 bg-green-50/50">
              <CardHeader className="pb-2">
                <div className="flex items-center gap-2">
                  <TrendingUp className="h-5 w-5 text-green-600" />
                  <CardTitle className="text-lg">Recommended Promotion Candidate</CardTitle>
                </div>
              </CardHeader>
              <CardContent>
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-3 mb-2">
                      <span className="text-xl font-bold">{promotionCandidate.platform_name}</span>
                      <Badge className="bg-green-500 text-white">Score: {((promotionCandidate.promotion_score || 0) * 100).toFixed(0)}%</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground mb-3">
                      {promotionCandidate.promotion_candidate_reason}
                    </p>
                    <div className="flex items-center gap-4 text-sm mb-4">
                      <div className="flex items-center gap-1">
                        {promotionCandidate.gate_1_passed ? (
                          <CheckCircle2 className="h-4 w-4 text-green-500" />
                        ) : (
                          <XCircle className="h-4 w-4 text-red-500" />
                        )}
                        <span>Gate 1: Dates</span>
                      </div>
                      <div className="flex items-center gap-1">
                        {promotionCandidate.gate_2_passed ? (
                          <CheckCircle2 className="h-4 w-4 text-green-500" />
                        ) : (
                          <XCircle className="h-4 w-4 text-red-500" />
                        )}
                        <span>Gate 2: Price</span>
                      </div>
                      <div className="flex items-center gap-1">
                        {promotionCandidate.gate_3_passed ? (
                          <CheckCircle2 className="h-4 w-4 text-green-500" />
                        ) : (
                          <XCircle className="h-4 w-4 text-red-500" />
                        )}
                        <span>Gate 3: Failure Quality</span>
                      </div>
                    </div>
                    <Button 
                      onClick={() => startPromotionWork(promotionCandidate)}
                      disabled={isStartingPromotion}
                      className="bg-green-600 hover:bg-green-700"
                    >
                      {isStartingPromotion ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <PlayCircle className="h-4 w-4 mr-2" />
                      )}
                      Start Promotion Work
                    </Button>
                  </div>
                  <div className="text-right text-sm text-muted-foreground">
                    <p>Attempts: {promotionCandidate.total_attempts || 0}</p>
                    <p>Successes: {promotionCandidate.total_successes || 0}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
          
          {!promotionCandidate && !promotionInProgress && tierBPlatforms.length > 0 && (
            <Card className="mb-4 border-muted">
              <CardHeader className="pb-2">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Target className="h-5 w-5" />
                  <CardTitle className="text-lg text-muted-foreground">No Promotion Candidate</CardTitle>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  No Tier B platform currently passes all eligibility gates. Continue collecting extraction evidence.
                </p>
              </CardContent>
            </Card>
          )}
          
          {/* Promotion History Section */}
          {promotionHistory.length > 0 && (
            <Card className="mb-4">
              <CardHeader className="pb-2">
                <div className="flex items-center gap-2">
                  <History className="h-5 w-5 text-muted-foreground" />
                  <CardTitle className="text-lg">Promotion History</CardTitle>
                </div>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Platform</TableHead>
                      <TableHead>Decision</TableHead>
                      <TableHead>Notes</TableHead>
                      <TableHead>By</TableHead>
                      <TableHead>Date</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {promotionHistory.map((platform) => (
                      <TableRow key={platform.id}>
                        <TableCell className="font-medium">{platform.platform_name}</TableCell>
                        <TableCell>
                          <Badge 
                            className={platform.promotion_status === 'promoted' ? 'bg-green-500' : 'bg-red-500'}
                          >
                            {platform.promotion_status === 'promoted' ? 'Promoted' : 'Rejected'}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground max-w-xs truncate">
                          {platform.promotion_notes || '-'}
                        </TableCell>
                        <TableCell className="text-sm">
                          {platform.promotion_decision_by || '-'}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {platform.promotion_decision_at 
                            ? new Date(platform.promotion_decision_at).toLocaleDateString()
                            : '-'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
          
          <Card>
            <CardHeader>
              <CardTitle>Platform Coverage Overview</CardTitle>
              <CardDescription>
                Which platforms do we support, which do we attempt, which are unsupported, and why?
              </CardDescription>
            </CardHeader>
            <CardContent>
              {/* Tier B Evidence Section */}
              {tierBPlatforms.length > 0 && (
                <div className="mb-6">
                  <h3 className="text-sm font-semibold text-muted-foreground mb-3 flex items-center gap-2">
                    <Target className="h-4 w-4" />
                    Tier B Eligibility & Evidence
                  </h3>
                  <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                    {tierBPlatforms.map((platform) => {
                      const allGatesPassed = platform.gate_1_passed && platform.gate_2_passed && platform.gate_3_passed;
                      const successRate = platform.total_attempts > 0 
                        ? ((platform.total_successes || 0) / platform.total_attempts) * 100 
                        : 0;
                      return (
                        <Card key={platform.id} className={`border ${platform.promotion_candidate ? 'border-green-300 bg-green-50/50' : allGatesPassed ? 'border-blue-200' : ''}`}>
                          <CardContent className="pt-4 pb-3">
                            <div className="flex items-center justify-between mb-2">
                              <span className="font-medium text-sm">{platform.platform_name}</span>
                              {platform.promotion_candidate ? (
                                <Badge className="bg-green-500 text-white text-xs gap-1">
                                  <TrendingUp className="h-3 w-3" /> Candidate
                                </Badge>
                              ) : allGatesPassed ? (
                                <Badge variant="outline" className="text-xs text-blue-600 border-blue-300">Eligible</Badge>
                              ) : (
                                <Badge variant="outline" className="text-xs">Not Eligible</Badge>
                              )}
                            </div>
                            
                            {/* Gates Section */}
                            <div className="flex items-center gap-2 mb-2 text-xs">
                              <div className="flex items-center gap-0.5" title="Gate 1: Dates validated at least once">
                                {platform.gate_1_passed ? (
                                  <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                                ) : (
                                  <XCircle className="h-3.5 w-3.5 text-muted-foreground" />
                                )}
                                <span className={platform.gate_1_passed ? '' : 'text-muted-foreground'}>G1</span>
                              </div>
                              <div className="flex items-center gap-0.5" title="Gate 2: Price extracted at least once">
                                {platform.gate_2_passed ? (
                                  <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                                ) : (
                                  <XCircle className="h-3.5 w-3.5 text-muted-foreground" />
                                )}
                                <span className={platform.gate_2_passed ? '' : 'text-muted-foreground'}>G2</span>
                              </div>
                              <div className="flex items-center gap-0.5" title="Gate 3: No blocking failures">
                                {platform.gate_3_passed ? (
                                  <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                                ) : (
                                  <XCircle className="h-3.5 w-3.5 text-muted-foreground" />
                                )}
                                <span className={platform.gate_3_passed ? '' : 'text-muted-foreground'}>G3</span>
                              </div>
                              {allGatesPassed && (
                                <Badge variant="secondary" className="text-xs ml-auto">
                                  Score: {((platform.promotion_score || 0) * 100).toFixed(0)}%
                                </Badge>
                              )}
                            </div>
                            
                            <div className="space-y-1 text-xs">
                              <div className="flex justify-between">
                                <span className="text-muted-foreground">Attempts:</span>
                                <span className="font-medium">{platform.total_attempts || 0}</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-muted-foreground">Successes:</span>
                                <span className="font-medium text-green-600">{platform.total_successes || 0}</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-muted-foreground">Success Rate:</span>
                                <span className="font-medium">{successRate.toFixed(0)}%</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-muted-foreground">Last Outcome:</span>
                                <span className={`font-medium ${platform.last_outcome_type === 'success' ? 'text-green-600' : 'text-red-600'}`}>
                                  {getDominantFailureReason(platform)}
                                </span>
                              </div>
                              <div className="mt-2 pt-2 border-t text-muted-foreground text-xs">
                                {platform.promotion_candidate_reason || 'Collecting evidence...'}
                              </div>
                            </div>
                          </CardContent>
                        </Card>
                      );
                    })}
                  </div>
                </div>
              )}
              
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Platform</TableHead>
                    <TableHead>Domain</TableHead>
                    <TableHead>Tier</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Attempts</TableHead>
                    <TableHead>Successes</TableHead>
                    <TableHead>Tier Reason</TableHead>
                    <TableHead>Extractor</TableHead>
                    <TableHead>Last Success</TableHead>
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
                        <TierBadge tier={platform.coverage_tier} />
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={platform.coverage_status} />
                      </TableCell>
                      <TableCell className="text-sm">
                        {platform.total_attempts || 0}
                      </TableCell>
                      <TableCell className="text-sm">
                        <span className="text-green-600">{platform.total_successes || 0}</span>
                        {(platform.total_failures || 0) > 0 && (
                          <span className="text-red-500 ml-1">/ {platform.total_failures}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground max-w-xs truncate">
                        {platform.tier_reason || platform.coverage_reason || '-'}
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
                      <TableCell className="text-xs text-muted-foreground">
                        {platform.last_success_at 
                          ? new Date(platform.last_success_at).toLocaleDateString()
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
