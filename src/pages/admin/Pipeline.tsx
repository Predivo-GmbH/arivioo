import { useState, useEffect } from 'react';
import { format } from 'date-fns';
import { 
  Activity, 
  RefreshCw, 
  AlertTriangle,
  CheckCircle,
  XCircle,
  Clock,
  Layers,
  Info
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { useAdminAuth } from '@/hooks/useAdminAuth';
import { HealthIndicator, SystemHealthBanner } from '@/components/admin/HealthIndicator';
import { useSystemHealth } from '@/hooks/useSystemHealth';

interface PipelineStats {
  counts: {
    queued: number;
    running: number;
    completed: number;
    failed: number;
  };
  totalRetries: number;
  recentErrors: Array<{
    id: string;
    jobType: string;
    error: string;
    errorCategory: string;
    searchId: string;
    createdAt: string;
    stageName?: string;
    durationMs?: number;
  }>;
  health?: {
    status: 'healthy' | 'stale' | 'not_updating';
    lastActivity: string | null;
    message: string;
  };
  meta?: {
    source: string;
    todaySearches: number;
    todayStageRuns: number;
  };
}

export default function Pipeline() {
  const { getToken } = useAdminAuth();
  const [stats, setStats] = useState<PipelineStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { health: systemHealth, hasAlerts } = useSystemHealth();

  const fetchStats = async () => {
    setIsLoading(true);
    setError(null);

    try {
      const token = getToken();
      const { data, error } = await supabase.functions.invoke('admin-dashboard/pipeline', {
        headers: { Authorization: `Bearer ${token}` },
        method: 'GET',
      });

      if (error) throw error;
      setStats(data);
    } catch (err: any) {
      setError(err?.message || 'Failed to load pipeline stats');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchStats();
    // Refresh every 30 seconds
    const interval = setInterval(fetchStats, 30000);
    return () => clearInterval(interval);
  }, []);

  if (isLoading && !stats) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold">Pipeline Status</h1>
        <div className="grid gap-4 md:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <Card key={i} className="animate-pulse">
              <CardHeader className="pb-2">
                <div className="h-4 bg-muted rounded w-16"></div>
              </CardHeader>
              <CardContent>
                <div className="h-8 bg-muted rounded w-12"></div>
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
        <h1 className="text-3xl font-bold">Pipeline Status</h1>
        <Card className="border-destructive">
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              <span>{error}</span>
            </div>
            <Button onClick={fetchStats} className="mt-4">
              <RefreshCw className="mr-2 h-4 w-4" /> Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const totalToday = (stats?.counts.queued || 0) + (stats?.counts.running || 0) + 
                     (stats?.counts.completed || 0) + (stats?.counts.failed || 0);

  return (
    <div className="space-y-6">
      {/* System Health Alerts */}
      {hasAlerts && systemHealth && (
        <SystemHealthBanner alerts={systemHealth.alerts} />
      )}

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div>
            <h1 className="text-3xl font-bold">Pipeline Status</h1>
            <p className="text-muted-foreground">Real-time job queue monitoring (Today)</p>
          </div>
          {stats?.health && (
            <HealthIndicator 
              status={stats.health.status} 
              lastActivity={stats.health.lastActivity}
              label="Pipeline"
            />
          )}
        </div>
        <Button variant="outline" onClick={fetchStats} disabled={isLoading}>
          <RefreshCw className={`mr-2 h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* Data Source Info */}
      {stats?.meta && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted/50 px-3 py-2 rounded-lg">
          <Info className="h-4 w-4" />
          <span>
            Source: <code className="bg-background px-1 rounded">{stats.meta.source}</code> • 
            Today: {stats.meta.todaySearches} searches, {stats.meta.todayStageRuns} stage runs
          </span>
        </div>
      )}

      {/* Status Cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Queued</CardTitle>
            <Layers className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.counts.queued || 0}</div>
            <p className="text-xs text-muted-foreground">Searches in progress</p>
          </CardContent>
        </Card>

        <Card className={stats?.counts.running ? 'border-primary' : ''}>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Running</CardTitle>
            <Activity className={`h-4 w-4 ${stats?.counts.running ? 'text-primary animate-pulse' : 'text-muted-foreground'}`} />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.counts.running || 0}</div>
            <p className="text-xs text-muted-foreground">Active stage runs</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Completed</CardTitle>
            <CheckCircle className="h-4 w-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-500">{stats?.counts.completed || 0}</div>
            <p className="text-xs text-muted-foreground">
              {totalToday > 0 ? `${Math.round((stats?.counts.completed || 0) / totalToday * 100)}% success rate` : 'Today'}
            </p>
          </CardContent>
        </Card>

        <Card className={stats?.counts.failed ? 'border-destructive' : ''}>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Failed</CardTitle>
            <XCircle className="h-4 w-4 text-destructive" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-destructive">{stats?.counts.failed || 0}</div>
            <p className="text-xs text-muted-foreground">Failed/timeout today</p>
          </CardContent>
        </Card>
      </div>

      {/* Recent Errors */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Errors</CardTitle>
          <CardDescription>Failed stage runs from today</CardDescription>
        </CardHeader>
        <CardContent>
          {!stats?.recentErrors?.length ? (
            <div className="flex flex-col items-center py-8 text-muted-foreground">
              <CheckCircle className="h-8 w-8 mb-2 text-green-500" />
              <p>No recent errors</p>
            </div>
          ) : (
            <div className="space-y-3 max-h-[400px] overflow-y-auto">
              {stats.recentErrors.map((err) => (
                <div key={err.id} className="p-3 bg-muted rounded-lg">
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{err.stageName || err.jobType}</Badge>
                      {err.durationMs && (
                        <span className="text-xs text-muted-foreground">
                          {(err.durationMs / 1000).toFixed(1)}s
                        </span>
                      )}
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {format(new Date(err.createdAt), 'MMM d, HH:mm')}
                    </span>
                  </div>
                  <p className="text-sm text-destructive">{err.error}</p>
                  {err.errorCategory && (
                    <Badge variant="destructive" className="mt-1 text-xs">
                      {err.errorCategory}
                    </Badge>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
