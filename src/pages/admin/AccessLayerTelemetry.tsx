import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { RefreshCw, ShieldOff, Clock, AlertTriangle, TrendingUp } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAdminAuth } from '@/hooks/useAdminAuth';
import { formatDistanceToNow } from 'date-fns';

interface AbortTelemetry {
  provider_name: string;
  failure_category: string;
  count: number;
  last_occurrence: string;
}

interface TimeWindowStats {
  window: string;
  rateLimited: number;
  botBlocked: number;
  total: number;
}

export default function AccessLayerTelemetry() {
  const { isAuthenticated } = useAdminAuth();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [telemetry, setTelemetry] = useState<AbortTelemetry[]>([]);
  const [timeWindowStats, setTimeWindowStats] = useState<TimeWindowStats[]>([]);
  const [error, setError] = useState<string | null>(null);

  const fetchTelemetry = async () => {
    if (!isAuthenticated) return;
    
    try {
      setRefreshing(true);
      
      // Fetch abort telemetry by provider
      const { data: abortData, error: abortError } = await supabase
        .from('api_request_logs')
        .select('provider_name, failure_category, created_at')
        .eq('endpoint_type', 'access_layer_abort')
        .order('created_at', { ascending: false })
        .limit(1000);
      
      if (abortError) throw abortError;
      
      // Aggregate by provider and failure category
      const aggregated: Record<string, AbortTelemetry> = {};
      (abortData || []).forEach((row: { provider_name: string; failure_category: string | null; created_at: string }) => {
        const key = `${row.provider_name}-${row.failure_category || 'unknown'}`;
        if (!aggregated[key]) {
          aggregated[key] = {
            provider_name: row.provider_name,
            failure_category: row.failure_category || 'unknown',
            count: 0,
            last_occurrence: row.created_at,
          };
        }
        aggregated[key].count++;
        if (row.created_at > aggregated[key].last_occurrence) {
          aggregated[key].last_occurrence = row.created_at;
        }
      });
      
      setTelemetry(Object.values(aggregated).sort((a, b) => b.count - a.count));
      
      // Calculate time window stats
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      
      const stats: TimeWindowStats[] = [
        { window: 'Last 1h', rateLimited: 0, botBlocked: 0, total: 0 },
        { window: 'Last 24h', rateLimited: 0, botBlocked: 0, total: 0 },
        { window: 'Last 7d', rateLimited: 0, botBlocked: 0, total: 0 },
      ];
      
      (abortData || []).forEach((row: { failure_category: string | null; created_at: string }) => {
        const createdAt = new Date(row.created_at);
        const isRateLimited = row.failure_category?.toLowerCase().includes('rate');
        const isBotBlocked = row.failure_category?.toLowerCase().includes('bot') || 
                            row.failure_category?.toLowerCase().includes('captcha');
        
        if (createdAt >= oneHourAgo) {
          stats[0].total++;
          if (isRateLimited) stats[0].rateLimited++;
          if (isBotBlocked) stats[0].botBlocked++;
        }
        if (createdAt >= oneDayAgo) {
          stats[1].total++;
          if (isRateLimited) stats[1].rateLimited++;
          if (isBotBlocked) stats[1].botBlocked++;
        }
        if (createdAt >= sevenDaysAgo) {
          stats[2].total++;
          if (isRateLimited) stats[2].rateLimited++;
          if (isBotBlocked) stats[2].botBlocked++;
        }
      });
      
      setTimeWindowStats(stats);
      setError(null);
    } catch (err) {
      console.error('Failed to fetch telemetry:', err);
      setError(err instanceof Error ? err.message : 'Failed to load telemetry');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchTelemetry();
  }, [isAuthenticated]);

  const getCategoryBadge = (category: string) => {
    const lowerCategory = category.toLowerCase();
    if (lowerCategory.includes('rate')) {
      return <Badge variant="destructive" className="text-xs">RATE_LIMITED</Badge>;
    }
    if (lowerCategory.includes('bot') || lowerCategory.includes('captcha')) {
      return <Badge variant="secondary" className="bg-orange-500/20 text-orange-700 text-xs">BOT_BLOCKED</Badge>;
    }
    return <Badge variant="outline" className="text-xs">{category}</Badge>;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Access Layer Telemetry</h1>
          <p className="text-muted-foreground">Monitor rate limiting and bot blocking events</p>
        </div>
        <Button 
          variant="outline" 
          size="sm" 
          onClick={fetchTelemetry}
          disabled={refreshing}
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {error && (
        <Card className="border-destructive">
          <CardContent className="py-4">
            <p className="text-destructive text-sm">{error}</p>
          </CardContent>
        </Card>
      )}

      {/* Time Window Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {timeWindowStats.map((stat) => (
          <Card key={stat.window}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Clock className="h-4 w-4 text-muted-foreground" />
                {stat.window}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stat.total}</div>
              <div className="flex gap-3 mt-2 text-xs">
                <span className="text-destructive">
                  Rate Limited: {stat.rateLimited}
                </span>
                <span className="text-orange-600">
                  Bot Blocked: {stat.botBlocked}
                </span>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Provider Breakdown */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldOff className="h-5 w-5" />
            Access Aborts by Provider
          </CardTitle>
          <CardDescription>
            Breakdown of hard-stop events preventing fallback scrapers
          </CardDescription>
        </CardHeader>
        <CardContent>
          {telemetry.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <TrendingUp className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p>No access layer abort events recorded</p>
              <p className="text-xs mt-1">This is good - the pipeline is not being rate limited or blocked</p>
            </div>
          ) : (
            <div className="space-y-3">
              {telemetry.map((item, index) => (
                <div 
                  key={index}
                  className="flex items-center justify-between p-3 rounded-lg border bg-muted/30"
                >
                  <div className="flex items-center gap-3">
                    <AlertTriangle className="h-4 w-4 text-amber-500" />
                    <div>
                      <div className="font-medium text-sm">{item.provider_name}</div>
                      <div className="text-xs text-muted-foreground">
                        Last: {formatDistanceToNow(new Date(item.last_occurrence), { addSuffix: true })}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {getCategoryBadge(item.failure_category)}
                    <div className="text-lg font-semibold tabular-nums">{item.count}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
