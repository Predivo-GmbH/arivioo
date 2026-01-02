import { useState, useEffect, useMemo } from 'react';
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  RefreshCw,
  TrendingUp,
  TrendingDown,
  Shield,
  ShieldCheck,
  ShieldX,
  Calendar,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { useAdminAuth } from '@/hooks/useAdminAuth';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  BarChart,
  Bar,
  Cell,
} from 'recharts';
import { ChartContainer, ChartTooltipContent } from '@/components/ui/chart';

// Verification threshold - matches src/lib/priceVerification.ts
const MIN_CONFIDENCE_THRESHOLD = 0.5;

interface ExtractionRecord {
  platform_name: string;
  extraction_status: string;
  dates_validated: boolean;
  includes_taxes_fees: boolean;
  confidence_score: number | null;
  extraction_date: string;
  count: number;
}

interface PlatformStats {
  platform_name: string;
  total_extractions: number;
  verified_count: number;
  unverified_count: number;
  verification_rate: number;
  success_count: number;
  failure_count: number;
  blocked_count: number;
  pending_count: number;
  avg_confidence: number | null;
  dates_validated_rate: number;
  taxes_included_rate: number;
  trend: 'up' | 'down' | 'stable';
  last_success: string | null;
}

interface DailyStats {
  date: string;
  [platform: string]: number | string;
}

const TIME_RANGES = [
  { value: '7', label: 'Last 7 days' },
  { value: '14', label: 'Last 14 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '60', label: 'Last 60 days' },
];

const CHART_COLORS = [
  'hsl(var(--chart-1))',
  'hsl(var(--chart-2))',
  'hsl(var(--chart-3))',
  'hsl(var(--chart-4))',
  'hsl(var(--chart-5))',
  'hsl(142, 71%, 45%)',
  'hsl(262, 83%, 58%)',
  'hsl(43, 96%, 56%)',
];

function VerificationBadge({ rate }: { rate: number }) {
  if (rate >= 70) {
    return (
      <Badge className="bg-green-500/10 text-green-600 gap-1">
        <ShieldCheck className="h-3 w-3" />
        Reliable
      </Badge>
    );
  }
  if (rate >= 30) {
    return (
      <Badge className="bg-yellow-500/10 text-yellow-600 gap-1">
        <Shield className="h-3 w-3" />
        Partial
      </Badge>
    );
  }
  return (
    <Badge className="bg-red-500/10 text-red-600 gap-1">
      <ShieldX className="h-3 w-3" />
      Unreliable
    </Badge>
  );
}

function TrendIndicator({ trend }: { trend: 'up' | 'down' | 'stable' }) {
  if (trend === 'up') {
    return <TrendingUp className="h-4 w-4 text-green-500" />;
  }
  if (trend === 'down') {
    return <TrendingDown className="h-4 w-4 text-red-500" />;
  }
  return <span className="text-muted-foreground">—</span>;
}

export default function PlatformReliability() {
  const { getToken } = useAdminAuth();
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [timeRange, setTimeRange] = useState('30');
  const [rawData, setRawData] = useState<ExtractionRecord[]>([]);
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([]);

  const fetchData = async () => {
    setIsLoading(true);
    setError(null);

    try {
      const { data, error: queryError } = await supabase
        .from('price_extractions')
        .select('platform_name, extraction_status, dates_validated, includes_taxes_fees, confidence_score, created_at')
        .gte('created_at', new Date(Date.now() - parseInt(timeRange) * 24 * 60 * 60 * 1000).toISOString())
        .order('created_at', { ascending: false });

      if (queryError) {
        // Fallback to edge function for admin access
        const token = getToken();
        if (!token) {
          throw new Error('Not authenticated');
        }

        const { data: funcData, error: funcError } = await supabase.functions.invoke('admin-dashboard/extractions', {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
        });

        if (funcError) throw funcError;

        const records = (funcData?.extractions || []).map((e: any) => ({
          platform_name: e.platform_name,
          extraction_status: e.extraction_status,
          dates_validated: e.dates_validated || false,
          includes_taxes_fees: e.includes_taxes_fees || false,
          confidence_score: e.confidence_score,
          extraction_date: e.created_at?.split('T')[0] || new Date().toISOString().split('T')[0],
          count: 1,
        }));
        setRawData(records);
      } else {
        const records = (data || []).map((e) => ({
          platform_name: e.platform_name,
          extraction_status: e.extraction_status,
          dates_validated: e.dates_validated || false,
          includes_taxes_fees: e.includes_taxes_fees || false,
          confidence_score: e.confidence_score,
          extraction_date: e.created_at?.split('T')[0] || new Date().toISOString().split('T')[0],
          count: 1,
        }));
        setRawData(records);
      }
    } catch (err: any) {
      console.error('[PlatformReliability] Error:', err);
      setError(err.message || 'Failed to fetch data');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [timeRange]);

  // Compute platform statistics
  const platformStats = useMemo(() => {
    const statsMap = new Map<string, PlatformStats>();

    rawData.forEach((record) => {
      const existing = statsMap.get(record.platform_name) || {
        platform_name: record.platform_name,
        total_extractions: 0,
        verified_count: 0,
        unverified_count: 0,
        verification_rate: 0,
        success_count: 0,
        failure_count: 0,
        blocked_count: 0,
        pending_count: 0,
        avg_confidence: null,
        dates_validated_rate: 0,
        taxes_included_rate: 0,
        trend: 'stable' as const,
        last_success: null,
      };

      existing.total_extractions += record.count;

      // Check if this record meets verified price criteria
      const isVerified = 
        record.extraction_status === 'success' &&
        record.dates_validated === true &&
        record.includes_taxes_fees === true &&
        (record.confidence_score ?? 0) >= MIN_CONFIDENCE_THRESHOLD;

      if (isVerified) {
        existing.verified_count += record.count;
      } else {
        existing.unverified_count += record.count;
      }

      if (record.extraction_status === 'success') {
        existing.success_count += record.count;
        if (!existing.last_success || record.extraction_date > existing.last_success) {
          existing.last_success = record.extraction_date;
        }
      } else if (record.extraction_status === 'pending') {
        existing.pending_count += record.count;
      } else if (record.extraction_status?.includes('blocked')) {
        existing.blocked_count += record.count;
      } else {
        existing.failure_count += record.count;
      }

      if (record.dates_validated) {
        existing.dates_validated_rate += record.count;
      }
      if (record.includes_taxes_fees) {
        existing.taxes_included_rate += record.count;
      }

      statsMap.set(record.platform_name, existing);
    });

    // Calculate rates
    const stats = Array.from(statsMap.values()).map((s) => ({
      ...s,
      verification_rate: s.total_extractions > 0 ? (s.verified_count / s.total_extractions) * 100 : 0,
      dates_validated_rate: s.total_extractions > 0 ? (s.dates_validated_rate / s.total_extractions) * 100 : 0,
      taxes_included_rate: s.total_extractions > 0 ? (s.taxes_included_rate / s.total_extractions) * 100 : 0,
    }));

    return stats.sort((a, b) => b.total_extractions - a.total_extractions);
  }, [rawData]);

  // Compute daily stats for chart
  const dailyStats = useMemo(() => {
    const dailyMap = new Map<string, Map<string, { verified: number; total: number }>>();

    rawData.forEach((record) => {
      const date = record.extraction_date;
      if (!dailyMap.has(date)) {
        dailyMap.set(date, new Map());
      }

      const platformMap = dailyMap.get(date)!;
      const existing = platformMap.get(record.platform_name) || { verified: 0, total: 0 };

      existing.total += record.count;

      const isVerified = 
        record.extraction_status === 'success' &&
        record.dates_validated === true &&
        record.includes_taxes_fees === true &&
        (record.confidence_score ?? 0) >= MIN_CONFIDENCE_THRESHOLD;

      if (isVerified) {
        existing.verified += record.count;
      }

      platformMap.set(record.platform_name, existing);
    });

    // Convert to chart format
    const allPlatforms = [...new Set(rawData.map((r) => r.platform_name))];
    const chartData: DailyStats[] = [];

    const sortedDates = [...dailyMap.keys()].sort();
    sortedDates.forEach((date) => {
      const row: DailyStats = { date };
      const platformMap = dailyMap.get(date)!;

      allPlatforms.forEach((platform) => {
        const stats = platformMap.get(platform);
        if (stats && stats.total > 0) {
          row[platform] = Math.round((stats.verified / stats.total) * 100);
        }
      });

      chartData.push(row);
    });

    return chartData;
  }, [rawData]);

  // Top platforms for chart display
  const topPlatforms = useMemo(() => {
    const platforms = platformStats
      .filter((p) => p.total_extractions >= 3)
      .slice(0, 8)
      .map((p) => p.platform_name);
    
    if (selectedPlatforms.length > 0) {
      return selectedPlatforms;
    }
    return platforms;
  }, [platformStats, selectedPlatforms]);

  // Summary stats
  const summary = useMemo(() => {
    const totalExtractions = platformStats.reduce((sum, p) => sum + p.total_extractions, 0);
    const totalVerified = platformStats.reduce((sum, p) => sum + p.verified_count, 0);
    const reliablePlatforms = platformStats.filter((p) => p.verification_rate >= 70).length;
    const unreliablePlatforms = platformStats.filter((p) => p.verification_rate < 30 && p.total_extractions >= 3).length;

    return {
      totalExtractions,
      totalVerified,
      overallRate: totalExtractions > 0 ? (totalVerified / totalExtractions) * 100 : 0,
      reliablePlatforms,
      unreliablePlatforms,
      totalPlatforms: platformStats.length,
    };
  }, [platformStats]);

  const chartConfig = useMemo(() => {
    const config: Record<string, { label: string; color: string }> = {};
    topPlatforms.forEach((platform, idx) => {
      config[platform] = {
        label: platform,
        color: CHART_COLORS[idx % CHART_COLORS.length],
      };
    });
    return config;
  }, [topPlatforms]);

  if (error) {
    return (
      <div className="p-6">
        <Card className="border-destructive">
          <CardHeader>
            <CardTitle className="text-destructive flex items-center gap-2">
              <AlertTriangle className="h-5 w-5" />
              Error Loading Data
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground mb-4">{error}</p>
            <Button onClick={fetchData} variant="outline">
              <RefreshCw className="h-4 w-4 mr-2" />
              Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Platform Reliability</h1>
          <p className="text-muted-foreground">
            Verification success rates based on date accuracy, tax inclusion, and confidence scores
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Select value={timeRange} onValueChange={setTimeRange}>
            <SelectTrigger className="w-40">
              <Calendar className="h-4 w-4 mr-2" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TIME_RANGES.map((range) => (
                <SelectItem key={range.value} value={range.value}>
                  {range.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={fetchData} variant="outline" disabled={isLoading}>
            <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Overall Verification Rate</CardDescription>
            <CardTitle className="text-3xl">{summary.overallRate.toFixed(1)}%</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">
              {summary.totalVerified} of {summary.totalExtractions} extractions verified
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Reliable Platforms</CardDescription>
            <CardTitle className="text-3xl text-green-600">{summary.reliablePlatforms}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">≥70% verification rate</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Unreliable Platforms</CardDescription>
            <CardTitle className="text-3xl text-red-600">{summary.unreliablePlatforms}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">&lt;30% verification rate</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total Platforms</CardDescription>
            <CardTitle className="text-3xl">{summary.totalPlatforms}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">In the last {timeRange} days</p>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="chart" className="space-y-4">
        <TabsList>
          <TabsTrigger value="chart">Trend Chart</TabsTrigger>
          <TabsTrigger value="table">Platform Details</TabsTrigger>
          <TabsTrigger value="breakdown">Failure Breakdown</TabsTrigger>
        </TabsList>

        <TabsContent value="chart" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Verification Rate Over Time</CardTitle>
              <CardDescription>
                Daily verification success rate per platform (top {topPlatforms.length} by volume)
              </CardDescription>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="h-80 flex items-center justify-center">
                  <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
                </div>
              ) : dailyStats.length === 0 ? (
                <div className="h-80 flex items-center justify-center text-muted-foreground">
                  No data available for the selected time range
                </div>
              ) : (
                <ChartContainer config={chartConfig} className="h-80 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={dailyStats}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis 
                        dataKey="date" 
                        tickFormatter={(value) => new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        className="text-xs"
                      />
                      <YAxis 
                        domain={[0, 100]} 
                        tickFormatter={(value) => `${value}%`}
                        className="text-xs"
                      />
                      <Tooltip content={<ChartTooltipContent />} />
                      <Legend />
                      {topPlatforms.map((platform, idx) => (
                        <Line
                          key={platform}
                          type="monotone"
                          dataKey={platform}
                          stroke={CHART_COLORS[idx % CHART_COLORS.length]}
                          strokeWidth={2}
                          dot={{ r: 3 }}
                          connectNulls
                        />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                </ChartContainer>
              )}
            </CardContent>
          </Card>

          {/* Bar chart for current rates */}
          <Card>
            <CardHeader>
              <CardTitle>Current Verification Rates by Platform</CardTitle>
              <CardDescription>
                Platforms with ≥3 extractions in the selected period
              </CardDescription>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="h-80 flex items-center justify-center">
                  <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <ChartContainer config={chartConfig} className="h-80 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart 
                      data={platformStats.filter((p) => p.total_extractions >= 3).slice(0, 12)}
                      layout="vertical"
                    >
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis type="number" domain={[0, 100]} tickFormatter={(v) => `${v}%`} />
                      <YAxis 
                        type="category" 
                        dataKey="platform_name" 
                        width={120}
                        className="text-xs"
                      />
                      <Tooltip 
                        formatter={(value: number) => [`${value.toFixed(1)}%`, 'Verification Rate']}
                      />
                      <Bar dataKey="verification_rate" radius={[0, 4, 4, 0]}>
                        {platformStats.filter((p) => p.total_extractions >= 3).slice(0, 12).map((entry, idx) => (
                          <Cell 
                            key={entry.platform_name}
                            fill={entry.verification_rate >= 70 ? 'hsl(142, 71%, 45%)' : 
                                  entry.verification_rate >= 30 ? 'hsl(43, 96%, 56%)' : 
                                  'hsl(0, 84%, 60%)'}
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </ChartContainer>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="table">
          <Card>
            <CardHeader>
              <CardTitle>Platform Verification Details</CardTitle>
              <CardDescription>
                Complete breakdown of verification metrics per platform
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
                      <TableHead>Platform</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead className="text-right">Verified</TableHead>
                      <TableHead className="text-right">Rate</TableHead>
                      <TableHead className="text-right">Dates Valid</TableHead>
                      <TableHead className="text-right">Taxes Incl.</TableHead>
                      <TableHead>Last Success</TableHead>
                      <TableHead>Trend</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {platformStats.map((platform) => (
                      <TableRow key={platform.platform_name}>
                        <TableCell className="font-medium">{platform.platform_name}</TableCell>
                        <TableCell>
                          <VerificationBadge rate={platform.verification_rate} />
                        </TableCell>
                        <TableCell className="text-right">{platform.total_extractions}</TableCell>
                        <TableCell className="text-right">
                          <span className="text-green-600">{platform.verified_count}</span>
                          <span className="text-muted-foreground"> / </span>
                          <span className="text-red-600">{platform.unverified_count}</span>
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {platform.verification_rate.toFixed(1)}%
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {platform.dates_validated_rate.toFixed(0)}%
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {platform.taxes_included_rate.toFixed(0)}%
                        </TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          {platform.last_success 
                            ? new Date(platform.last_success).toLocaleDateString() 
                            : 'Never'}
                        </TableCell>
                        <TableCell>
                          <TrendIndicator trend={platform.trend} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="breakdown">
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <CheckCircle2 className="h-5 w-5 text-green-500" />
                  Verification Requirements
                </CardTitle>
                <CardDescription>
                  Criteria for a price to be classified as "verified"
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between p-2 bg-muted/50 rounded">
                  <span>Extraction status</span>
                  <Badge variant="outline">success</Badge>
                </div>
                <div className="flex items-center justify-between p-2 bg-muted/50 rounded">
                  <span>Dates validated</span>
                  <Badge variant="outline">true</Badge>
                </div>
                <div className="flex items-center justify-between p-2 bg-muted/50 rounded">
                  <span>Includes taxes/fees</span>
                  <Badge variant="outline">true</Badge>
                </div>
                <div className="flex items-center justify-between p-2 bg-muted/50 rounded">
                  <span>Confidence score</span>
                  <Badge variant="outline">≥ {MIN_CONFIDENCE_THRESHOLD}</Badge>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <XCircle className="h-5 w-5 text-red-500" />
                  Common Failure Reasons
                </CardTitle>
                <CardDescription>
                  Why extractions fail verification
                </CardDescription>
              </CardHeader>
              <CardContent>
                {isLoading ? (
                  <div className="h-40 flex items-center justify-center">
                    <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
                  </div>
                ) : (
                  <div className="space-y-2">
                    {(() => {
                      const reasons: Record<string, number> = {};
                      rawData.forEach((r) => {
                        if (r.extraction_status !== 'success') {
                          const reason = r.extraction_status || 'unknown';
                          reasons[reason] = (reasons[reason] || 0) + r.count;
                        } else {
                          if (!r.dates_validated) {
                            reasons['dates_not_validated'] = (reasons['dates_not_validated'] || 0) + r.count;
                          }
                          if (!r.includes_taxes_fees) {
                            reasons['missing_taxes_fees'] = (reasons['missing_taxes_fees'] || 0) + r.count;
                          }
                          if ((r.confidence_score ?? 0) < MIN_CONFIDENCE_THRESHOLD) {
                            reasons['low_confidence'] = (reasons['low_confidence'] || 0) + r.count;
                          }
                        }
                      });
                      
                      return Object.entries(reasons)
                        .sort((a, b) => b[1] - a[1])
                        .slice(0, 8)
                        .map(([reason, count]) => (
                          <div key={reason} className="flex items-center justify-between p-2 bg-muted/50 rounded">
                            <span className="text-sm capitalize">{reason.replace(/_/g, ' ')}</span>
                            <Badge variant="secondary">{count}</Badge>
                          </div>
                        ));
                    })()}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
