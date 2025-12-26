import { useState, useEffect } from 'react';
import { 
  Activity, 
  Search, 
  CheckCircle, 
  XCircle, 
  Clock, 
  Server, 
  TrendingUp,
  RefreshCw,
  AlertTriangle
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
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
  BarChart,
  Bar,
} from 'recharts';

interface HealthStats {
  searches: { today: number; last7Days: number };
  extractions: {
    today: number;
    last7Days: number;
    successRate: number;
    failureRate: number;
    avgDurationMs: number;
  };
  platforms: { active: number; inactive: number; newLast30Days: number };
  blockedPlatforms: { total: number; byReason: Record<string, number> };
  dailyStats: Array<{ date: string; searches: number; extractions: number; successes: number; failures: number }>;
}

function StatCard({ 
  title, 
  value, 
  description, 
  icon: Icon, 
  trend,
  className 
}: { 
  title: string; 
  value: string | number; 
  description?: string; 
  icon: any;
  trend?: 'up' | 'down' | 'neutral';
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        {description && (
          <p className="text-xs text-muted-foreground mt-1">{description}</p>
        )}
      </CardContent>
    </Card>
  );
}

export default function HealthOverview() {
  const { getToken } = useAdminAuth();
  const [stats, setStats] = useState<HealthStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStats = async () => {
    setIsLoading(true);
    setError(null);
    
    try {
      const token = getToken();
      const { data, error } = await supabase.functions.invoke('admin-dashboard/health', {
        headers: { Authorization: `Bearer ${token}` },
        method: 'GET',
      });

      if (error) throw error;
      setStats(data);
    } catch (err: any) {
      setError(err?.message || 'Failed to load stats');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchStats();
  }, []);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-bold">Health Overview</h1>
        </div>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
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
        <h1 className="text-3xl font-bold">Health Overview</h1>
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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Health Overview</h1>
          <p className="text-muted-foreground">System status and key metrics</p>
        </div>
        <Button variant="outline" onClick={fetchStats} disabled={isLoading}>
          <RefreshCw className={`mr-2 h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* Key Metrics */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Searches Today"
          value={stats?.searches.today || 0}
          description={`${stats?.searches.last7Days || 0} last 7 days`}
          icon={Search}
        />
        <StatCard
          title="Extractions Today"
          value={stats?.extractions.today || 0}
          description={`${stats?.extractions.last7Days || 0} last 7 days`}
          icon={Activity}
        />
        <StatCard
          title="Success Rate"
          value={`${stats?.extractions.successRate || 0}%`}
          description="Last 7 days"
          icon={CheckCircle}
          className={stats?.extractions.successRate && stats.extractions.successRate < 50 ? 'border-destructive' : ''}
        />
        <StatCard
          title="Avg Duration"
          value={`${((stats?.extractions.avgDurationMs || 0) / 1000).toFixed(1)}s`}
          description="Per extraction"
          icon={Clock}
        />
      </div>

      {/* Platform Stats */}
      <div className="grid gap-4 md:grid-cols-3">
        <StatCard
          title="Active Platforms"
          value={stats?.platforms.active || 0}
          description={`${stats?.platforms.inactive || 0} inactive`}
          icon={Server}
        />
        <StatCard
          title="New Platforms"
          value={stats?.platforms.newLast30Days || 0}
          description="Last 30 days"
          icon={TrendingUp}
        />
        <StatCard
          title="Blocked Platforms"
          value={stats?.blockedPlatforms.total || 0}
          description={Object.entries(stats?.blockedPlatforms.byReason || {})
            .slice(0, 2)
            .map(([reason, count]) => `${reason}: ${count}`)
            .join(', ') || 'None'}
          icon={XCircle}
          className={stats?.blockedPlatforms.total && stats.blockedPlatforms.total > 5 ? 'border-yellow-500' : ''}
        />
      </div>

      {/* Charts */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Extractions Trend</CardTitle>
            <CardDescription>Daily extraction volume over the last 7 days</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={stats?.dailyStats || []}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis 
                    dataKey="date" 
                    tickFormatter={(value) => new Date(value).toLocaleDateString('en-US', { weekday: 'short' })}
                    className="text-xs"
                  />
                  <YAxis className="text-xs" />
                  <Tooltip 
                    labelFormatter={(value) => new Date(value).toLocaleDateString()}
                    contentStyle={{ backgroundColor: 'hsl(var(--card))', border: '1px solid hsl(var(--border))' }}
                  />
                  <Line 
                    type="monotone" 
                    dataKey="extractions" 
                    stroke="hsl(var(--primary))" 
                    strokeWidth={2}
                    dot={{ fill: 'hsl(var(--primary))' }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Success vs Failures</CardTitle>
            <CardDescription>Daily extraction outcomes</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={stats?.dailyStats || []}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis 
                    dataKey="date" 
                    tickFormatter={(value) => new Date(value).toLocaleDateString('en-US', { weekday: 'short' })}
                    className="text-xs"
                  />
                  <YAxis className="text-xs" />
                  <Tooltip 
                    labelFormatter={(value) => new Date(value).toLocaleDateString()}
                    contentStyle={{ backgroundColor: 'hsl(var(--card))', border: '1px solid hsl(var(--border))' }}
                  />
                  <Bar dataKey="successes" fill="hsl(var(--success))" name="Successes" />
                  <Bar dataKey="failures" fill="hsl(var(--destructive))" name="Failures" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
