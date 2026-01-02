import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { 
  Activity, 
  Search, 
  CheckCircle, 
  XCircle, 
  Clock, 
  Server, 
  TrendingUp,
  RefreshCw,
  AlertTriangle,
  Gauge,
  Database,
  Settings,
  ShieldOff,
  FileText,
  User,
  TestTube,
  ArrowRight,
  Zap,
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { useAdminAuth } from '@/hooks/useAdminAuth';
import { useSystemHealth, type HealthAlert } from '@/hooks/useSystemHealth';
import { HealthIndicator, SystemHealthBanner, type HealthStatus } from '@/components/admin/HealthIndicator';
import { BaselineInfoPanel } from '@/components/admin/BaselineInfoPanel';
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
import { formatDistanceToNow } from 'date-fns';

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

// Quick navigation sections for the dashboard
const adminSections = [
  { 
    title: 'Platform Coverage', 
    url: '/admin/coverage', 
    icon: Gauge,
    description: 'Monitor supported platforms and extraction reliability',
    healthKey: 'platforms' as const,
  },
  { 
    title: 'Pipeline Status', 
    url: '/admin/pipeline', 
    icon: Activity,
    description: 'Real-time job queue and stage runs monitoring',
    healthKey: 'pipeline' as const,
  },
  { 
    title: 'Extractions', 
    url: '/admin/extractions', 
    icon: Database,
    description: 'View and filter price extraction records',
    healthKey: 'extractions' as const,
  },
  { 
    title: 'Search Debug', 
    url: '/admin/search-debug', 
    icon: Search,
    description: 'Debug individual search requests and results',
    healthKey: 'searches' as const,
  },
  { 
    title: 'Airbnb Diagnostic', 
    url: '/admin/airbnb-diagnostic', 
    icon: TestTube,
    description: 'Test Airbnb scraping and baseline pricing',
    healthKey: null,
  },
  { 
    title: 'API Quotas', 
    url: '/admin/quotas', 
    icon: Zap,
    description: 'Monitor API usage and rate limits',
    healthKey: null,
  },
];

function StatCard({ 
  title, 
  value, 
  description, 
  icon: Icon, 
  className,
  health,
}: { 
  title: string; 
  value: string | number; 
  description?: string; 
  icon: any;
  className?: string;
  health?: HealthStatus;
}) {
  return (
    <Card className={className}>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <div className="flex items-center gap-2">
          {health && <HealthIndicator status={health} showLabel={false} />}
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
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

function SectionCard({ 
  section, 
  healthStatus 
}: { 
  section: typeof adminSections[0];
  healthStatus?: HealthStatus;
}) {
  const Icon = section.icon;
  
  return (
    <Link to={section.url}>
      <Card className="hover:border-primary/50 transition-colors cursor-pointer h-full">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="p-2 bg-primary/10 rounded-lg">
                <Icon className="h-4 w-4 text-primary" />
              </div>
              <CardTitle className="text-base">{section.title}</CardTitle>
            </div>
            <div className="flex items-center gap-2">
              {healthStatus && (
                <HealthIndicator status={healthStatus} showLabel={false} />
              )}
              <ArrowRight className="h-4 w-4 text-muted-foreground" />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{section.description}</p>
        </CardContent>
      </Card>
    </Link>
  );
}

function SystemStatusPanel({ 
  systemHealth, 
  isLoading 
}: { 
  systemHealth: ReturnType<typeof useSystemHealth>['health'];
  isLoading: boolean;
}) {
  if (isLoading || !systemHealth) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Server className="h-5 w-5" />
            System Status
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="animate-pulse space-y-3">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="h-10 bg-muted rounded"></div>
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  const sections = [
    { key: 'pipeline', label: 'Pipeline', data: systemHealth.sections.pipeline },
    { key: 'extractions', label: 'Extractions', data: systemHealth.sections.extractions },
    { key: 'platforms', label: 'Platforms', data: systemHealth.sections.platforms },
    { key: 'searches', label: 'Searches', data: systemHealth.sections.searches },
  ];

  const allHealthy = sections.every(s => s.data.status === 'healthy');

  return (
    <Card className={allHealthy ? 'border-green-500/30' : 'border-yellow-500/30'}>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Server className="h-5 w-5" />
            System Status
          </CardTitle>
          <Badge variant={allHealthy ? 'default' : 'secondary'} className={allHealthy ? 'bg-green-500' : 'bg-yellow-500'}>
            {allHealthy ? 'All Systems Healthy' : 'Attention Needed'}
          </Badge>
        </div>
        <CardDescription>
          Last checked: {formatDistanceToNow(new Date(systemHealth.timestamp), { addSuffix: true })}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {sections.map(section => (
            <div key={section.key} className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
              <div className="flex items-center gap-3">
                <HealthIndicator 
                  status={section.data.status} 
                  lastActivity={section.data.lastActivity}
                  label={section.label}
                  showLabel={false}
                />
                <div>
                  <p className="font-medium text-sm">{section.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {section.data.lastActivity 
                      ? `Updated ${formatDistanceToNow(new Date(section.data.lastActivity), { addSuffix: true })}`
                      : 'No recent activity'}
                  </p>
                </div>
              </div>
              <Badge variant="outline" className="capitalize">
                {section.data.status.replace('_', ' ')}
              </Badge>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export default function HealthOverview() {
  const { getToken } = useAdminAuth();
  const [stats, setStats] = useState<HealthStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  const { 
    health: systemHealth, 
    loading: healthLoading, 
    hasAlerts,
    refetch: refetchHealth 
  } = useSystemHealth({ refreshIntervalMs: 30000 });

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

  const handleRefresh = () => {
    fetchStats();
    refetchHealth();
  };

  useEffect(() => {
    fetchStats();
  }, []);

  if (error) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold">Admin Dashboard</h1>
        <Card className="border-destructive">
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              <span>{error}</span>
            </div>
            <Button onClick={handleRefresh} className="mt-4">
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

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Admin Dashboard</h1>
          <p className="text-muted-foreground">System health and key metrics at a glance</p>
        </div>
        <Button variant="outline" onClick={handleRefresh} disabled={isLoading || healthLoading}>
          <RefreshCw className={`mr-2 h-4 w-4 ${(isLoading || healthLoading) ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* System Status Panel + Baseline Info */}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <SystemStatusPanel systemHealth={systemHealth} isLoading={healthLoading} />
        </div>
        <div>
          <BaselineInfoPanel />
        </div>
      </div>

      {/* Key Metrics */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Searches Today"
          value={isLoading ? '...' : (stats?.searches.today || 0)}
          description={`${stats?.searches.last7Days || 0} last 7 days`}
          icon={Search}
          health={systemHealth?.sections.searches.status}
        />
        <StatCard
          title="Extractions Today"
          value={isLoading ? '...' : (stats?.extractions.today || 0)}
          description={`${stats?.extractions.last7Days || 0} last 7 days`}
          icon={Activity}
          health={systemHealth?.sections.extractions.status}
        />
        <StatCard
          title="Success Rate"
          value={isLoading ? '...' : `${stats?.extractions.successRate || 0}%`}
          description="Last 7 days"
          icon={CheckCircle}
          className={stats?.extractions.successRate && stats.extractions.successRate < 50 ? 'border-destructive' : ''}
        />
        <StatCard
          title="Avg Duration"
          value={isLoading ? '...' : `${((stats?.extractions.avgDurationMs || 0) / 1000).toFixed(1)}s`}
          description="Per extraction"
          icon={Clock}
        />
      </div>

      {/* Quick Navigation */}
      <div>
        <h2 className="text-lg font-semibold mb-4">Quick Navigation</h2>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {adminSections.map(section => (
            <SectionCard 
              key={section.url} 
              section={section}
              healthStatus={section.healthKey ? systemHealth?.sections[section.healthKey]?.status : undefined}
            />
          ))}
        </div>
      </div>

      {/* Platform Stats */}
      <div className="grid gap-4 md:grid-cols-3">
        <StatCard
          title="Active Platforms"
          value={isLoading ? '...' : (stats?.platforms.active || 0)}
          description={`${stats?.platforms.inactive || 0} inactive`}
          icon={Server}
          health={systemHealth?.sections.platforms.status}
        />
        <StatCard
          title="New Platforms"
          value={isLoading ? '...' : (stats?.platforms.newLast30Days || 0)}
          description="Last 30 days"
          icon={TrendingUp}
        />
        <StatCard
          title="Blocked Platforms"
          value={isLoading ? '...' : (stats?.blockedPlatforms.total || 0)}
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
              {isLoading ? (
                <div className="h-full flex items-center justify-center">
                  <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
                </div>
              ) : (
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
              )}
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
              {isLoading ? (
                <div className="h-full flex items-center justify-center">
                  <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
                </div>
              ) : (
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
                    <Bar dataKey="successes" fill="hsl(142 76% 36%)" name="Successes" />
                    <Bar dataKey="failures" fill="hsl(var(--destructive))" name="Failures" />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
