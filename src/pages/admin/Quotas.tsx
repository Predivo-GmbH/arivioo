import { useState, useEffect } from 'react';
import { format } from 'date-fns';
import { 
  Gauge, 
  RefreshCw, 
  AlertTriangle,
  TrendingUp,
  Clock,
  Zap,
  Edit,
  Save
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import { useAdminAuth } from '@/hooks/useAdminAuth';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';

interface ProviderQuota {
  provider: {
    id: string;
    name: string;
    displayName: string;
    planType: string;
    planLimit: number | null;
    costPerRequest: number;
    supportsQuotaApi: boolean;
    keysActive?: number;
  };
  quota: {
    used: number;
    remaining: number | null;
    limit: number | null;
    limitType: 'known_limit' | 'unlimited' | 'unknown';
    limitSource: 'provider_api' | 'configured' | 'inferred' | 'unknown';
    resetAt: string | null;
    isEstimated: boolean;
  };
  estimated: {
    requestCount: number;
    costUnits: number;
    successRate: number;
  };
  last24h: {
    requests: number;
    errors: number;
    errorRate: number;
    avgDurationMs: number;
  };
  trends: {
    last7Days: Array<{ date: string; requests: number; successes: number; errors: number }>;
    last30Days: Array<{ date: string; requests: number; successes: number; errors: number }>;
  };
  lastSnapshot: any;
}

function QuotaCard({ 
  quota, 
  onRefresh, 
  onUpdateSettings,
  isRefreshing 
}: { 
  quota: ProviderQuota; 
  onRefresh: () => void; 
  onUpdateSettings: (planLimit: number | null, costPerRequest: number) => Promise<void>;
  isRefreshing: boolean;
}) {
  const [showTrend, setShowTrend] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [planLimit, setPlanLimit] = useState(String(quota.provider.planLimit || ''));
  const [costPerRequest, setCostPerRequest] = useState(String(quota.provider.costPerRequest || 1));

  const usagePercent = quota.quota.limit 
    ? Math.min(100, (quota.quota.used / quota.quota.limit) * 100)
    : 0;

  const handleSaveSettings = async () => {
    try {
      await onUpdateSettings(
        planLimit ? parseInt(planLimit) : null,
        parseFloat(costPerRequest) || 1
      );
      setIsEditing(false);
      toast({ title: 'Settings updated' });
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              {quota.provider.displayName}
              {quota.quota.isEstimated && (
                <Badge variant="outline" className="text-xs">Estimated</Badge>
              )}
              {quota.quota.limitType === 'unknown' && (
                <Badge variant="secondary" className="text-xs">Limit Unknown</Badge>
              )}
              {quota.quota.limitType === 'unlimited' && (
                <Badge variant="secondary" className="text-xs">Unlimited</Badge>
              )}
              {quota.provider.keysActive && quota.provider.keysActive > 1 && (
                <Badge variant="outline" className="text-xs">{quota.provider.keysActive} keys</Badge>
              )}
            </CardTitle>
            <CardDescription className="text-xs">
              {quota.provider.planType} plan • {quota.provider.name}
              {quota.quota.limitSource !== 'unknown' && (
                <span className="ml-1 text-muted-foreground/60">
                  (source: {quota.quota.limitSource.replace('_', ' ')})
                </span>
              )}
            </CardDescription>
          </div>
          <Button variant="ghost" size="sm" onClick={onRefresh} disabled={isRefreshing}>
            <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Usage Bar */}
        <div>
          <div className="flex justify-between text-sm mb-1">
            <span className={quota.quota.used === 0 && quota.estimated.requestCount > 0 ? 'text-yellow-600' : ''}>
              {quota.quota.used.toLocaleString()} used
              {quota.quota.used === 0 && quota.estimated.requestCount > 0 && (
                <span className="text-xs text-muted-foreground ml-1">
                  ({quota.estimated.requestCount} in logs)
                </span>
              )}
            </span>
            <span>
              {quota.quota.limitType === 'known_limit' 
                ? quota.quota.limit?.toLocaleString() + ' limit'
                : quota.quota.limitType === 'unlimited'
                  ? 'Unlimited'
                  : 'Unknown limit'
              }
            </span>
          </div>
          {quota.quota.limitType === 'known_limit' && (
            <Progress 
              value={usagePercent} 
              className={usagePercent > 80 ? 'bg-destructive/20' : usagePercent > 50 ? 'bg-yellow-500/20' : ''}
            />
          )}
          {quota.quota.limitType !== 'known_limit' && (
            <div className="h-2 bg-muted rounded-full overflow-hidden">
              <div 
                className="h-full bg-primary/40" 
                style={{ width: quota.quota.used > 0 ? '100%' : '0%' }}
              />
            </div>
          )}
          {quota.quota.remaining !== null && quota.quota.limitType === 'known_limit' && (
            <p className="text-xs text-muted-foreground mt-1">
              {quota.quota.remaining.toLocaleString()} remaining
            </p>
          )}
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-muted-foreground text-xs">24h Requests</p>
              <p className="font-medium">{quota.last24h.requests}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-muted-foreground text-xs">24h Error Rate</p>
              <p className={`font-medium ${quota.last24h.errorRate > 10 ? 'text-destructive' : ''}`}>
                {quota.last24h.errorRate}%
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-muted-foreground text-xs">Avg Response</p>
              <p className="font-medium">{(quota.last24h.avgDurationMs / 1000).toFixed(1)}s</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-muted-foreground text-xs">Success Rate</p>
              <p className="font-medium">{quota.estimated.successRate}%</p>
            </div>
          </div>
        </div>

        {quota.quota.resetAt && (
          <p className="text-xs text-muted-foreground">
            Resets: {format(new Date(quota.quota.resetAt), 'MMM d, yyyy')}
          </p>
        )}

        {/* Trend Chart Toggle */}
        <div className="pt-2 border-t">
          <Button 
            variant="ghost" 
            size="sm" 
            className="w-full text-xs"
            onClick={() => setShowTrend(!showTrend)}
          >
            {showTrend ? 'Hide' : 'Show'} 7-Day Trend
          </Button>
          
          {showTrend && (
            <div className="h-[150px] mt-3">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={quota.trends.last7Days}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis 
                    dataKey="date" 
                    tickFormatter={(v) => format(new Date(v), 'dd')}
                    className="text-xs"
                  />
                  <YAxis className="text-xs" />
                  <Tooltip 
                    labelFormatter={(v) => format(new Date(v), 'MMM d')}
                    contentStyle={{ backgroundColor: 'hsl(var(--card))', border: '1px solid hsl(var(--border))' }}
                  />
                  <Line 
                    type="monotone" 
                    dataKey="requests" 
                    stroke="hsl(var(--primary))" 
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* Settings */}
        <div className="pt-2 border-t">
          {isEditing ? (
            <div className="space-y-3">
              <div>
                <Label className="text-xs">Plan Limit</Label>
                <Input
                  type="number"
                  value={planLimit}
                  onChange={(e) => setPlanLimit(e.target.value)}
                  placeholder="Unlimited"
                  className="h-8"
                />
              </div>
              <div>
                <Label className="text-xs">Cost Per Request</Label>
                <Input
                  type="number"
                  step="0.1"
                  value={costPerRequest}
                  onChange={(e) => setCostPerRequest(e.target.value)}
                  className="h-8"
                />
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={handleSaveSettings}>
                  <Save className="h-3 w-3 mr-1" /> Save
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setIsEditing(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="ghost" size="sm" className="w-full text-xs" onClick={() => setIsEditing(true)}>
              <Edit className="h-3 w-3 mr-1" /> Edit Settings
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default function Quotas() {
  const { getToken } = useAdminAuth();
  const [quotas, setQuotas] = useState<ProviderQuota[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);

  const fetchQuotas = async () => {
    setIsLoading(true);
    setError(null);

    try {
      const token = getToken();
      const { data, error } = await supabase.functions.invoke('admin-quotas/all', {
        headers: { Authorization: `Bearer ${token}` },
        method: 'GET',
      });

      if (error) throw error;
      setQuotas(data.quotas || []);
    } catch (err: any) {
      setError(err?.message || 'Failed to load quotas');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchQuotas();
  }, []);

  const refreshQuota = async (providerId: string) => {
    setRefreshingId(providerId);
    try {
      const token = getToken();
      const { data, error } = await supabase.functions.invoke('admin-quotas/refresh', {
        headers: { Authorization: `Bearer ${token}` },
        method: 'POST',
        body: { providerId },
      });

      if (error) throw error;
      
      // Refresh all quotas to get updated data
      await fetchQuotas();
      toast({ title: `${data.provider} quota refreshed` });
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setRefreshingId(null);
    }
  };

  const updateProviderSettings = async (providerId: string, planLimit: number | null, costPerRequest: number) => {
    const token = getToken();
    const { error } = await supabase.functions.invoke('admin-quotas/provider', {
      headers: { Authorization: `Bearer ${token}` },
      method: 'PATCH',
      body: { id: providerId, planLimit, costPerRequest },
    });

    if (error) throw error;
    await fetchQuotas();
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold">API Quotas</h1>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <Card key={i} className="animate-pulse">
              <CardHeader>
                <div className="h-5 bg-muted rounded w-32"></div>
              </CardHeader>
              <CardContent>
                <div className="h-4 bg-muted rounded w-full mb-4"></div>
                <div className="h-20 bg-muted rounded"></div>
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
        <h1 className="text-3xl font-bold">API Quotas</h1>
        <Card className="border-destructive">
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              <span>{error}</span>
            </div>
            <Button onClick={fetchQuotas} className="mt-4">
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
          <h1 className="text-3xl font-bold">API Quotas</h1>
          <p className="text-muted-foreground">Monitor usage and limits for external APIs</p>
        </div>
        <Button variant="outline" onClick={fetchQuotas}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Refresh All
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {quotas.map((quota) => (
          <QuotaCard
            key={quota.provider.id}
            quota={quota}
            onRefresh={() => refreshQuota(quota.provider.id)}
            onUpdateSettings={(limit, cost) => updateProviderSettings(quota.provider.id, limit, cost)}
            isRefreshing={refreshingId === quota.provider.id}
          />
        ))}
      </div>
    </div>
  );
}
