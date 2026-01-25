import { useState, useEffect, useCallback } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragStartEvent,
  DragOverlay,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { restrictToVerticalAxis } from '@dnd-kit/modifiers';
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
  Info,
  GripVertical,
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
import { HealthIndicator, SystemHealthBanner } from '@/components/admin/HealthIndicator';
import { useSystemHealth } from '@/hooks/useSystemHealth';
import { SortablePlatformRow } from '@/components/admin/SortablePlatformRow';
import { toast } from '@/hooks/use-toast';
import { getPlatformDisplayName } from '@/lib/platformNames';

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
  is_new: boolean;
  discovered_at: string | null;
  created_at: string;
  updated_at: string;
}

interface CoverageVariant {
  id: string;
  parent_platform_domain: string;
  coverage_variant_key: string;
  detected_country: string | null;
  detected_locale: string | null;
  detected_tld: string | null;
  variant_status: string;
  variant_reason: string | null;
  inherited_tier: string | null;
  total_attempts: number;
  structural_failures: number;
  transient_failures: number;
  first_detected_at: string;
  last_seen_at: string;
  sample_urls: string[] | null;
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
  supported: { icon: CheckCircle2, color: 'text-green-500', label: 'Working' },
  unsupported: { icon: XCircle, color: 'text-red-500', label: 'Failing' },
  inquiry_based: { icon: HelpCircle, color: 'text-yellow-500', label: 'Inquiry Based' },
  reserve_required: { icon: Clock, color: 'text-orange-500', label: 'Reserve Required' },
  blocked: { icon: Ban, color: 'text-red-600', label: 'Blocked' },
  unknown: { icon: AlertTriangle, color: 'text-muted-foreground', label: 'Not Tested' },
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
                    <TableCell className="font-medium">{getPlatformDisplayName(p.platform_name)}</TableCell>
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

// Debug info state for admin visibility
interface DebugInfo {
  source: string;
  supabaseProjectRef: string;
  queryMethod: string;
  totalCount: number | null;
  tierCounts: { A: number; B: number; C: number };
  fetchedAt: string;
  error?: string;
  errorCode?: string;
}

export default function PlatformCoverage() {
  const { getToken } = useAdminAuth();
  const [platforms, setPlatforms] = useState<PlatformAdapter[]>([]);
  const [variants, setVariants] = useState<CoverageVariant[]>([]);
  const [pipelineRuns, setPipelineRuns] = useState<PipelineRun[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isStartingPromotion, setIsStartingPromotion] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [debugInfo, setDebugInfo] = useState<DebugInfo | null>(null);
  const [showDebug, setShowDebug] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [isSavingOrder, setIsSavingOrder] = useState(false);
  const { health: systemHealth, hasAlerts } = useSystemHealth();

  // DnD sensors for pointer and keyboard
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // GOLDEN PATH: Fetch via admin-dashboard edge function with service role
  // This bypasses RLS and uses the authoritative data source
  const fetchData = async () => {
    setIsLoading(true);
    setError(null);
    setDebugInfo(null);
    
    try {
      const token = getToken();
      if (!token) {
        setError('Not authenticated. Please log in to the admin panel.');
        setDebugInfo({
          source: 'none',
          supabaseProjectRef: 'unknown',
          queryMethod: 'none',
          totalCount: null,
          tierCounts: { A: 0, B: 0, C: 0 },
          fetchedAt: new Date().toISOString(),
          error: 'No admin token available',
        });
        setIsLoading(false);
        return;
      }

      // Use the golden path endpoint - admin-dashboard/platform-coverage
      const { data, error: invokeError } = await supabase.functions.invoke('admin-dashboard/platform-coverage', {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });

      if (invokeError) {
        console.error('[PlatformCoverage] Edge function error:', invokeError);
        setError(`Data source error: ${invokeError.message}`);
        setDebugInfo({
          source: 'admin-dashboard/platform-coverage',
          supabaseProjectRef: 'unknown',
          queryMethod: 'edge_function_failed',
          totalCount: null,
          tierCounts: { A: 0, B: 0, C: 0 },
          fetchedAt: new Date().toISOString(),
          error: invokeError.message,
        });
        setIsLoading(false);
        return;
      }

      // Check for error in response body
      if (data?.error) {
        console.error('[PlatformCoverage] API error:', data);
        setError(`Query failed: ${data.error}`);
        setDebugInfo({
          source: data.source || 'admin-dashboard/platform-coverage',
          supabaseProjectRef: 'unknown',
          queryMethod: data.queryMethod || 'service_role',
          totalCount: null,
          tierCounts: { A: 0, B: 0, C: 0 },
          fetchedAt: new Date().toISOString(),
          error: data.error,
          errorCode: data.errorCode,
        });
        setIsLoading(false);
        return;
      }

      // Success - set platforms and debug info
      setPlatforms(data.platforms || []);
      setPipelineRuns(data.pipelineRuns || []);
      
      // Also fetch variants
      try {
        const variantsResp = await supabase.functions.invoke('admin-dashboard/coverage-variants', {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` }
        });
        if (variantsResp.data?.variants) {
          setVariants(variantsResp.data.variants);
        }
      } catch (variantErr) {
        console.warn('[PlatformCoverage] Failed to fetch variants:', variantErr);
      }
      
      setDebugInfo({
        source: data.meta?.source || 'admin-dashboard/platform-coverage',
        supabaseProjectRef: data.meta?.supabaseProjectRef || 'unknown',
        queryMethod: data.meta?.queryMethod || 'service_role',
        totalCount: data.meta?.totalCount ?? (data.platforms?.length || 0),
        tierCounts: data.meta?.tierCounts || { A: 0, B: 0, C: 0 },
        fetchedAt: data.meta?.fetchedAt || new Date().toISOString(),
      });
      
    } catch (err: any) {
      console.error('[PlatformCoverage] Unexpected error:', err);
      setError(`Unexpected error: ${err?.message || 'Unknown error'}`);
      setDebugInfo({
        source: 'admin-dashboard/platform-coverage',
        supabaseProjectRef: 'unknown',
        queryMethod: 'failed',
        totalCount: null,
        tierCounts: { A: 0, B: 0, C: 0 },
        fetchedAt: new Date().toISOString(),
        error: err?.message || 'Unknown error',
      });
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
    if (!window.confirm(`Start promotion work for ${getPlatformDisplayName(platform.platform_domain)}?\n\nThis will lock scoring for this platform and begin the promotion workflow.`)) {
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

  // Handle drag start
  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as string);
  };

  // Handle drag end - reorder within same tier only
  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);
    
    if (!over || active.id === over.id) return;

    const activePlatform = platforms.find(p => p.id === active.id);
    const overPlatform = platforms.find(p => p.id === over.id);
    
    if (!activePlatform || !overPlatform) return;
    
    // Only allow reordering within the same tier
    if (activePlatform.coverage_tier !== overPlatform.coverage_tier) {
      toast({
        title: "Cannot move between tiers",
        description: "Platforms can only be reordered within the same tier.",
        variant: "destructive",
      });
      return;
    }

    // Get platforms in the same tier
    const tier = activePlatform.coverage_tier;
    const tierPlatforms = platforms.filter(p => p.coverage_tier === tier);
    const otherPlatforms = platforms.filter(p => p.coverage_tier !== tier);
    
    const oldIndex = tierPlatforms.findIndex(p => p.id === active.id);
    const newIndex = tierPlatforms.findIndex(p => p.id === over.id);
    
    if (oldIndex === -1 || newIndex === -1) return;
    
    // Reorder within tier
    const reorderedTier = arrayMove(tierPlatforms, oldIndex, newIndex);
    
    // Calculate new promotion_scores for this tier (higher score = higher in list)
    const baseScore = tier === 'A' ? 1000 : tier === 'B' ? 500 : 100;
    const updatedTier = reorderedTier.map((p, idx) => ({
      ...p,
      promotion_score: baseScore - idx,
    }));
    
    // Update local state immediately for smooth UX
    const newPlatforms = [...otherPlatforms, ...updatedTier];
    setPlatforms(newPlatforms);
    
    // Persist to database
    setIsSavingOrder(true);
    try {
      const token = getToken();
      if (!token) throw new Error('Not authenticated');
      
      // Update each platform's promotion_score
      const updates = updatedTier.map(p => ({
        id: p.id,
        promotion_score: p.promotion_score,
      }));
      
      const { error: updateError } = await supabase.functions.invoke('admin-dashboard/reorder', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: { updates },
      });
      
      if (updateError) throw updateError;
      
      toast({
        title: "Order saved",
        description: `${tier === 'A' ? 'Tier A' : tier === 'B' ? 'Tier B' : 'Tier C'} platform order updated.`,
      });
    } catch (err: any) {
      console.error('Failed to save order:', err);
      toast({
        title: "Failed to save order",
        description: err.message || "Please try again.",
        variant: "destructive",
      });
      // Revert on error
      fetchData();
    } finally {
      setIsSavingOrder(false);
    }
  };

  // Handle clearing the "new" flag from a platform
  const handleClearNew = async (platformId: string) => {
    try {
      const token = getToken();
      if (!token) throw new Error('Not authenticated');
      
      const { error: updateError } = await supabase.functions.invoke('admin-dashboard/clear-new', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: { platformId },
      });
      
      if (updateError) throw updateError;
      
      // Update local state
      setPlatforms(prev => prev.map(p => 
        p.id === platformId ? { ...p, is_new: false } : p
      ));
      
      toast({
        title: "Label removed",
        description: "Platform is no longer marked as new.",
      });
    } catch (err: any) {
      console.error('Failed to clear new flag:', err);
      toast({
        title: "Failed to update",
        description: err.message || "Please try again.",
        variant: "destructive",
      });
    }
  };

  // Sort platforms: Tier A first, then Tier B, then Tier C (sorted by promotion_score descending, new at end)
  const sortedPlatforms = [...platforms].sort((a, b) => {
    // First sort by tier: A > B > C
    const tierOrder = { 'A': 0, 'B': 1, 'C': 2 };
    const aTier = tierOrder[a.coverage_tier as keyof typeof tierOrder] ?? 3;
    const bTier = tierOrder[b.coverage_tier as keyof typeof tierOrder] ?? 3;
    
    if (aTier !== bTier) return aTier - bTier;
    
    // Within Tier C, put "new" platforms at the end
    if (a.coverage_tier === 'C' && a.is_new !== b.is_new) {
      return a.is_new ? 1 : -1;
    }
    
    // Within all tiers, sort by promotion_score descending (higher = more important)
    const aScore = a.promotion_score ?? 0;
    const bScore = b.promotion_score ?? 0;
    if (aScore !== bScore) return bScore - aScore;
    
    // Fallback to alphabetical
    return (a.platform_name || '').localeCompare(b.platform_name || '');
  });

  // Get active platform for drag overlay
  const activePlatform = activeId ? sortedPlatforms.find(p => p.id === activeId) : null;

  const tierACount = sortedPlatforms.filter(p => p.coverage_tier === 'A').length;
  const tierBCount = sortedPlatforms.filter(p => p.coverage_tier === 'B').length;
  const tierCCount = sortedPlatforms.filter(p => p.coverage_tier === 'C').length;
  const tierBPlatforms = sortedPlatforms.filter(p => p.coverage_tier === 'B');
  const promotionCandidate = sortedPlatforms.find(p => p.promotion_candidate === true && p.coverage_tier === 'B');
  const promotionInProgress = sortedPlatforms.find(p => p.promotion_in_progress === true);
  const promotionHistory = sortedPlatforms.filter(p => p.promotion_status === 'promoted' || p.promotion_status === 'rejected');
  
  // Detect empty tier states
  const noTierAWarning = platforms.length > 0 && tierACount === 0;
  const noPlatformsAtAll = platforms.length === 0;

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
              <span className="font-medium">Data Source Error</span>
            </div>
            <p className="text-sm text-muted-foreground mt-2">{error}</p>
            
            {/* Debug Info Accordion */}
            {debugInfo && (
              <Collapsible open={showDebug} onOpenChange={setShowDebug} className="mt-4">
                <CollapsibleTrigger asChild>
                  <Button variant="outline" size="sm" className="gap-2">
                    <Info className="h-4 w-4" />
                    {showDebug ? 'Hide' : 'Show'} Debug Info
                    {showDebug ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="mt-3 p-3 bg-muted rounded-md text-xs font-mono space-y-1">
                    <div><span className="text-muted-foreground">Source:</span> {debugInfo.source}</div>
                    <div><span className="text-muted-foreground">Project Ref:</span> {debugInfo.supabaseProjectRef}</div>
                    <div><span className="text-muted-foreground">Query Method:</span> {debugInfo.queryMethod}</div>
                    <div><span className="text-muted-foreground">Total Count:</span> {debugInfo.totalCount ?? 'null'}</div>
                    <div><span className="text-muted-foreground">Tier Counts:</span> A={debugInfo.tierCounts.A}, B={debugInfo.tierCounts.B}, C={debugInfo.tierCounts.C}</div>
                    <div><span className="text-muted-foreground">Fetched At:</span> {debugInfo.fetchedAt}</div>
                    {debugInfo.error && <div className="text-destructive"><span className="text-muted-foreground">Error:</span> {debugInfo.error}</div>}
                    {debugInfo.errorCode && <div className="text-destructive"><span className="text-muted-foreground">Error Code:</span> {debugInfo.errorCode}</div>}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            )}
            
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
      {/* System Health Alerts */}
      {hasAlerts && systemHealth && (
        <SystemHealthBanner alerts={systemHealth.alerts} />
      )}
      
      {/* Data Source Mismatch Alert - Detects contradictions between debug info and visible data */}
      {debugInfo && debugInfo.totalCount !== null && debugInfo.totalCount > 0 && platforms.length === 0 && !isLoading && (
        <Card className="border-destructive bg-destructive/10">
          <CardContent className="pt-6">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-6 w-6 text-destructive shrink-0" />
              <div>
                <h3 className="font-semibold text-destructive">Data Access Mismatch Detected</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  The backend reports {debugInfo.totalCount} platforms exist, but the UI received 0.
                  This indicates a data access or permission issue.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
      
      {/* Empty Platform Coverage Alert - Only when truly empty */}
      {noPlatformsAtAll && !isLoading && (!debugInfo || debugInfo.totalCount === 0) && (
        <Card className="border-destructive bg-destructive/10">
          <CardContent className="pt-6">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-6 w-6 text-destructive shrink-0" />
              <div>
                <h3 className="font-semibold text-destructive">No Platforms Configured</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  The platform_adapters table is empty. No platforms are available in any tier (A, B, or C).
                  This indicates a data source failure or migration issue.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
      
      {/* No Tier A Warning */}
      {noTierAWarning && !isLoading && (
        <Card className="border-yellow-400 bg-yellow-50/50">
          <CardContent className="pt-6">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-6 w-6 text-yellow-600 shrink-0" />
              <div>
                <h3 className="font-semibold text-yellow-700">No Tier A Platforms</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  There are {tierBCount} Tier B and {tierCCount} Tier C platforms, but no production-supported Tier A platforms.
                  All extractions will be best-effort with no SLA.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div>
            <h1 className="text-3xl font-bold">Platform Coverage</h1>
            <p className="text-muted-foreground">
              Monitor supported platforms and pipeline progress
            </p>
          </div>
          {systemHealth?.sections.platforms && (
            <HealthIndicator 
              status={systemHealth.sections.platforms.status} 
              lastActivity={systemHealth.sections.platforms.lastActivity}
              label="Platforms"
            />
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Debug toggle button */}
          <Collapsible open={showDebug} onOpenChange={setShowDebug}>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" className="gap-2 text-muted-foreground">
                <Info className="h-4 w-4" />
                Debug
              </Button>
            </CollapsibleTrigger>
          </Collapsible>
          
          <Button variant="outline" onClick={fetchData} disabled={isLoading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </div>
      
      {/* Debug Info Panel */}
      {showDebug && debugInfo && (
        <Card className="bg-muted/50">
          <CardHeader className="py-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Info className="h-4 w-4" />
              Data Source Debug Info
            </CardTitle>
          </CardHeader>
          <CardContent className="py-2">
            <div className="grid gap-2 md:grid-cols-3 text-xs font-mono">
              <div><span className="text-muted-foreground">Source:</span> {debugInfo.source}</div>
              <div><span className="text-muted-foreground">Project Ref:</span> {debugInfo.supabaseProjectRef}</div>
              <div><span className="text-muted-foreground">Query Method:</span> {debugInfo.queryMethod}</div>
              <div><span className="text-muted-foreground">Total Count:</span> {debugInfo.totalCount ?? 'null'}</div>
              <div><span className="text-muted-foreground">Tier Counts:</span> A={debugInfo.tierCounts.A}, B={debugInfo.tierCounts.B}, C={debugInfo.tierCounts.C}</div>
              <div><span className="text-muted-foreground">Fetched At:</span> {new Date(debugInfo.fetchedAt).toLocaleTimeString()}</div>
              <div><span className="text-muted-foreground">UI Platforms:</span> {platforms.length}</div>
              {debugInfo.error && (
                <div className="col-span-3 text-destructive"><span className="text-muted-foreground">Error:</span> {debugInfo.error}</div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

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
                      <span className="text-xl font-bold">{getPlatformDisplayName(promotionInProgress.platform_domain)}</span>
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
                      <span className="text-xl font-bold">{getPlatformDisplayName(promotionCandidate.platform_domain)}</span>
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
                        <TableCell className="font-medium">{getPlatformDisplayName(platform.platform_domain)}</TableCell>
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
                              <span className="font-medium text-sm">{getPlatformDisplayName(platform.platform_domain)}</span>
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
              
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
                modifiers={[restrictToVerticalAxis]}
              >
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10"></TableHead>
                      <TableHead>Platform</TableHead>
                      <TableHead>Domain</TableHead>
                      <TableHead>Tier</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Attempts</TableHead>
                      <TableHead>Successes</TableHead>
                      <TableHead>Tier Reason</TableHead>
                      <TableHead>Extractor</TableHead>
                      <TableHead>Last Success</TableHead>
                      <TableHead>Added</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <SortableContext 
                      items={sortedPlatforms.map(p => p.id)} 
                      strategy={verticalListSortingStrategy}
                    >
                      {sortedPlatforms.map((platform) => {
                        const platformVariants = variants.filter(
                          v => v.parent_platform_domain === platform.platform_domain
                        );
                        return (
                          <SortablePlatformRow
                            key={platform.id}
                            platform={platform}
                            variants={platformVariants}
                            TierBadge={TierBadge}
                            StatusBadge={StatusBadge}
                            onClearNew={handleClearNew}
                          />
                        );
                      })}
                    </SortableContext>
                  </TableBody>
                </Table>
                <DragOverlay>
                  {activePlatform ? (
                    <Table className="bg-background shadow-lg border rounded-md">
                      <TableBody>
                        <TableRow>
                          <TableCell className="w-10">
                            <GripVertical className="h-4 w-4 text-muted-foreground" />
                          </TableCell>
                          <TableCell className="font-medium">{getPlatformDisplayName(activePlatform.platform_domain)}</TableCell>
                          <TableCell className="text-muted-foreground text-sm">
                            {activePlatform.platform_domain}
                          </TableCell>
                          <TableCell>
                            <TierBadge tier={activePlatform.coverage_tier} />
                          </TableCell>
                          <TableCell>
                            <StatusBadge status={activePlatform.coverage_status} />
                          </TableCell>
                          <TableCell className="text-sm">
                            {activePlatform.total_attempts || 0}
                          </TableCell>
                          <TableCell className="text-sm">
                            <span className="text-green-600">{activePlatform.total_successes || 0}</span>
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground max-w-xs truncate">
                            {activePlatform.tier_reason || activePlatform.coverage_reason || '-'}
                          </TableCell>
                          <TableCell>
                            {activePlatform.dedicated_extractor ? (
                              <Badge variant="secondary" className="font-mono text-xs">
                                {activePlatform.dedicated_extractor}
                              </Badge>
                            ) : (
                              <span className="text-muted-foreground">-</span>
                            )}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {activePlatform.last_success_at 
                              ? new Date(activePlatform.last_success_at).toLocaleDateString()
                              : '-'}
                          </TableCell>
                        </TableRow>
                      </TableBody>
                    </Table>
                  ) : null}
                </DragOverlay>
              </DndContext>
              
              {isSavingOrder && (
                <div className="flex items-center justify-center py-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Saving order...
                </div>
              )}
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
