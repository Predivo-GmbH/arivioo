import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAdminAuth } from '@/hooks/useAdminAuth';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useToast } from '@/hooks/use-toast';
import {
  Users,
  Bell,
  TrendingUp,
  AlertTriangle,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  Eye,
  Power,
  RotateCcw,
  DollarSign,
  Activity,
  CheckCircle2,
  XCircle,
  Clock,
  Mail,
  ExternalLink
} from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, BarChart, Bar, Cell, PieChart, Pie } from 'recharts';

interface NotifyMeStats {
  registrations: {
    total: number;
    active: number;
    today: number;
    last7Days: number;
    last30Days: number;
  };
  notifications: {
    pending: number;
    sent: number;
    failed: number;
    disabled: number;
  };
  extractions: {
    triggered: number;
    successful: number;
    successRate: number;
  };
  dailyTrend: Array<{ date: string; registrations: number }>;
}

interface Registration {
  id: string;
  email: string;
  emailHash: string;
  sourceAirbnbUrl?: string;
  sourceAirbnbTitle?: string;
  sourceAirbnbPrice?: number;
  searchId?: string;
  searchStatus?: string;
  searchTitle?: string;
  notificationStatus: string;
  lastNotifiedAt?: string;
  notificationCount: number;
  priceThreshold: number;
  isActive: boolean;
  createdAt: string;
  extractionCount: number;
  lastExtraction?: {
    status: string;
    createdAt: string;
    price?: number;
    platform?: string;
  };
}

interface RegistrationDetail {
  registration: {
    id: string;
    email: string;
    sourceAirbnbUrl?: string;
    sourceAirbnbTitle?: string;
    sourceAirbnbPrice?: number;
    searchId?: string;
    search?: any;
    notificationStatus: string;
    lastNotifiedAt?: string;
    notificationCount: number;
    lastNotificationError?: string;
    priceThreshold: number;
    isActive: boolean;
    metadata: any;
    createdAt: string;
    updatedAt: string;
  };
  events: Array<{
    id: string;
    type: string;
    searchId?: string;
    extractionId?: string;
    platform?: string;
    price?: number;
    savings?: number;
    error?: string;
    metadata?: any;
    createdAt: string;
  }>;
  extractions: Array<{
    id: string;
    platform: string;
    status: string;
    price?: number;
    currency?: string;
    provider?: string;
    error?: string;
    createdAt: string;
  }>;
  apiUsage: Record<string, { requests: number; cost: number; successes: number }>;
}

interface QuotaAttribution {
  period: { days: number; startDate: string };
  totals: {
    requests: number;
    notifyMeRequests: number;
    notifyMePercentage: number;
    estimatedCost: number;
    notifyMeCost: number;
    notifyMeCostPercentage: number;
  };
  byProvider: Array<{
    provider: string;
    totalRequests: number;
    notifyMeRequests: number;
    otherRequests: number;
    notifyMePercentage: number;
    estimatedCost: number;
    notifyMeCost: number;
  }>;
}

interface NotificationHealth {
  queue: { pendingCount: number };
  failures: {
    totalLast7Days: number;
    byReason: Record<string, number>;
    recentFailures: Array<{
      id: string;
      email: string;
      error?: string;
      retryCount: number;
      lastAttempt?: string;
    }>;
  };
  performance: { notificationsSentLast7Days: number };
}

const statusColors: Record<string, string> = {
  pending: 'bg-yellow-500',
  sent: 'bg-green-500',
  failed: 'bg-red-500',
  disabled: 'bg-muted'
};

export default function NotifyMeUsers() {
  const { getToken } = useAdminAuth();
  const { toast } = useToast();

  const [stats, setStats] = useState<NotifyMeStats | null>(null);
  const [registrations, setRegistrations] = useState<Registration[]>([]);
  const [quotaData, setQuotaData] = useState<QuotaAttribution | null>(null);
  const [healthData, setHealthData] = useState<NotificationHealth | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<RegistrationDetail | null>(null);
  
  const [isLoading, setIsLoading] = useState(true);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalCount, setTotalCount] = useState(0);

  // Detail modal
  const [detailOpen, setDetailOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState('overview');

  const fetchStats = async () => {
    const token = getToken();
    const { data, error } = await supabase.functions.invoke('admin-dashboard/notify-me-stats', {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (error) throw error;
    setStats(data);
  };

  const fetchRegistrations = async () => {
    const token = getToken();
    const params = new URLSearchParams({
      page: page.toString(),
      limit: '20'
    });
    if (statusFilter !== 'all') params.set('status', statusFilter);

    const { data, error } = await supabase.functions.invoke(`admin-dashboard/notify-me-list?${params}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (error) throw error;
    setRegistrations(data.registrations);
    setTotalPages(data.totalPages);
    setTotalCount(data.total);
  };

  const fetchQuotaData = async () => {
    const token = getToken();
    const { data, error } = await supabase.functions.invoke('admin-dashboard/notify-me-quota?days=30', {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (error) throw error;
    setQuotaData(data);
  };

  const fetchHealthData = async () => {
    const token = getToken();
    const { data, error } = await supabase.functions.invoke('admin-dashboard/notify-me-health', {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (error) throw error;
    setHealthData(data);
  };

  const fetchDetail = async (id: string) => {
    setIsDetailLoading(true);
    setSelectedId(id);
    setDetailOpen(true);
    try {
      const token = getToken();
      const { data, error } = await supabase.functions.invoke(`admin-dashboard/notify-me-detail?id=${id}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (error) throw error;
      setSelectedDetail(data);
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setIsDetailLoading(false);
    }
  };

  const handleDisable = async (id: string) => {
    try {
      const token = getToken();
      await supabase.functions.invoke('admin-dashboard/notify-me-update', {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` },
        body: { id, is_active: false, notification_status: 'disabled' }
      });
      toast({ title: 'Success', description: 'Registration disabled' });
      fetchRegistrations();
      if (selectedDetail?.registration.id === id) {
        fetchDetail(id);
      }
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    }
  };

  const handleRetry = async (id: string) => {
    try {
      const token = getToken();
      await supabase.functions.invoke('admin-dashboard/notify-me-retry', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: { id }
      });
      toast({ title: 'Success', description: 'Notification queued for retry' });
      fetchRegistrations();
      fetchHealthData();
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    }
  };

  const loadData = async () => {
    setIsLoading(true);
    setError(null);
    try {
      await Promise.all([
        fetchStats(),
        fetchRegistrations(),
        fetchQuotaData(),
        fetchHealthData()
      ]);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    if (!isLoading) {
      fetchRegistrations();
    }
  }, [page, statusFilter]);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-10 w-24" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <AlertTriangle className="h-12 w-12 text-destructive mb-4" />
        <h3 className="text-lg font-semibold mb-2">Failed to load data</h3>
        <p className="text-muted-foreground mb-4">{error}</p>
        <Button onClick={loadData}>
          <RefreshCw className="h-4 w-4 mr-2" />
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Users & Notify Me Registrations</h1>
          <p className="text-muted-foreground">Monitor and manage notification subscribers</p>
        </div>
        <Button onClick={loadData} variant="outline" size="sm">
          <RefreshCw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>

      {/* Overview Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Users className="h-4 w-4 text-primary" />
              Total Registrations
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.registrations.total || 0}</div>
            <p className="text-xs text-muted-foreground">
              {stats?.registrations.active || 0} active
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-green-500" />
              New Registrations
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.registrations.today || 0}</div>
            <p className="text-xs text-muted-foreground">
              {stats?.registrations.last7Days || 0} last 7 days · {stats?.registrations.last30Days || 0} last 30 days
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Bell className="h-4 w-4 text-blue-500" />
              Notifications
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.notifications.sent || 0}</div>
            <p className="text-xs text-muted-foreground">
              {stats?.notifications.pending || 0} pending · {stats?.notifications.failed || 0} failed
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Activity className="h-4 w-4 text-purple-500" />
              Extractions Triggered
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.extractions.triggered || 0}</div>
            <p className="text-xs text-muted-foreground">
              {stats?.extractions.successRate || 0}% success rate
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="registrations">Registrations</TabsTrigger>
          <TabsTrigger value="quota">Quota Attribution</TabsTrigger>
          <TabsTrigger value="health">Notification Health</TabsTrigger>
        </TabsList>

        {/* Overview Tab */}
        <TabsContent value="overview" className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Registration Trend */}
            <Card>
              <CardHeader>
                <CardTitle>Registration Trend (7 Days)</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={stats?.dailyTrend || []}>
                      <XAxis 
                        dataKey="date" 
                        tick={{ fontSize: 12 }}
                        tickFormatter={(value) => new Date(value).toLocaleDateString('en-US', { weekday: 'short' })}
                      />
                      <YAxis tick={{ fontSize: 12 }} />
                      <Tooltip 
                        labelFormatter={(value) => new Date(value).toLocaleDateString()}
                        formatter={(value: number) => [value, 'Registrations']}
                      />
                      <Line 
                        type="monotone" 
                        dataKey="registrations" 
                        stroke="hsl(var(--primary))" 
                        strokeWidth={2}
                        dot={{ fill: 'hsl(var(--primary))' }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            {/* Notification Status Breakdown */}
            <Card>
              <CardHeader>
                <CardTitle>Notification Status</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {['pending', 'sent', 'failed', 'disabled'].map((status) => {
                    const count = stats?.notifications[status as keyof typeof stats.notifications] || 0;
                    const total = (stats?.registrations.total || 1);
                    const percentage = Math.round((count / total) * 100);
                    return (
                      <div key={status} className="flex items-center gap-4">
                        <div className="w-20 capitalize text-sm">{status}</div>
                        <div className="flex-1 bg-muted rounded-full h-2">
                          <div 
                            className={`h-2 rounded-full ${statusColors[status]}`}
                            style={{ width: `${percentage}%` }}
                          />
                        </div>
                        <div className="w-16 text-right text-sm font-medium">{count}</div>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>

            {/* API Usage by Notify Me */}
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>API Usage Attribution (Last 30 Days)</CardTitle>
                <CardDescription>
                  {quotaData?.totals.notifyMePercentage || 0}% of API requests from Notify Me users
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={quotaData?.byProvider || []} layout="vertical">
                      <XAxis type="number" />
                      <YAxis dataKey="provider" type="category" width={100} tick={{ fontSize: 12 }} />
                      <Tooltip />
                      <Bar dataKey="notifyMeRequests" name="Notify Me" fill="hsl(var(--primary))" />
                      <Bar dataKey="otherRequests" name="Other" fill="hsl(var(--muted-foreground))" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Registrations Tab */}
        <TabsContent value="registrations" className="space-y-4">
          {/* Filters */}
          <div className="flex items-center gap-4">
            <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(1); }}>
              <SelectTrigger className="w-40">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="sent">Sent</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
                <SelectItem value="disabled">Disabled</SelectItem>
              </SelectContent>
            </Select>
            <div className="text-sm text-muted-foreground">
              Showing {registrations.length} of {totalCount} registrations
            </div>
          </div>

          {/* Table */}
          <Card>
            <ScrollArea className="h-[500px]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Email</TableHead>
                    <TableHead>Listing</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Extractions</TableHead>
                    <TableHead>Last Extraction</TableHead>
                    <TableHead>Registered</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {registrations.map((reg) => (
                    <TableRow key={reg.id}>
                      <TableCell className="font-mono text-sm">{reg.email}</TableCell>
                      <TableCell className="max-w-48 truncate">
                        {reg.sourceAirbnbTitle || reg.searchTitle || '-'}
                      </TableCell>
                      <TableCell>
                        <Badge 
                          variant={reg.notificationStatus === 'sent' ? 'default' : 
                                   reg.notificationStatus === 'failed' ? 'destructive' : 
                                   reg.notificationStatus === 'pending' ? 'secondary' : 'outline'}
                        >
                          {reg.notificationStatus}
                        </Badge>
                      </TableCell>
                      <TableCell>{reg.extractionCount}</TableCell>
                      <TableCell>
                        {reg.lastExtraction ? (
                          <div className="flex items-center gap-2">
                            {reg.lastExtraction.status === 'success' ? (
                              <CheckCircle2 className="h-4 w-4 text-green-500" />
                            ) : (
                              <XCircle className="h-4 w-4 text-red-500" />
                            )}
                            <span className="text-sm">
                              {reg.lastExtraction.price ? `$${reg.lastExtraction.price}` : reg.lastExtraction.status}
                            </span>
                          </div>
                        ) : '-'}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {new Date(reg.createdAt).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button variant="ghost" size="icon" onClick={() => fetchDetail(reg.id)}>
                            <Eye className="h-4 w-4" />
                          </Button>
                          {reg.notificationStatus === 'failed' && (
                            <Button variant="ghost" size="icon" onClick={() => handleRetry(reg.id)}>
                              <RotateCcw className="h-4 w-4" />
                            </Button>
                          )}
                          {reg.isActive && (
                            <Button variant="ghost" size="icon" onClick={() => handleDisable(reg.id)}>
                              <Power className="h-4 w-4 text-destructive" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
          </Card>

          {/* Pagination */}
          <div className="flex items-center justify-between">
            <Button 
              variant="outline" 
              size="sm"
              disabled={page === 1}
              onClick={() => setPage(p => p - 1)}
            >
              <ChevronLeft className="h-4 w-4 mr-1" />
              Previous
            </Button>
            <span className="text-sm text-muted-foreground">
              Page {page} of {totalPages}
            </span>
            <Button 
              variant="outline" 
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage(p => p + 1)}
            >
              Next
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          </div>
        </TabsContent>

        {/* Quota Attribution Tab */}
        <TabsContent value="quota" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">Total API Requests</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{quotaData?.totals.requests || 0}</div>
                <p className="text-xs text-muted-foreground">Last 30 days</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">Notify Me Requests</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{quotaData?.totals.notifyMeRequests || 0}</div>
                <p className="text-xs text-muted-foreground">
                  {quotaData?.totals.notifyMePercentage || 0}% of total
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">Estimated Cost</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">${(quotaData?.totals.notifyMeCost || 0).toFixed(2)}</div>
                <p className="text-xs text-muted-foreground">
                  {quotaData?.totals.notifyMeCostPercentage || 0}% of total cost
                </p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Usage by Provider</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Provider</TableHead>
                    <TableHead className="text-right">Total Requests</TableHead>
                    <TableHead className="text-right">Notify Me</TableHead>
                    <TableHead className="text-right">Other</TableHead>
                    <TableHead className="text-right">Notify Me %</TableHead>
                    <TableHead className="text-right">Estimated Cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {quotaData?.byProvider.map((provider) => (
                    <TableRow key={provider.provider}>
                      <TableCell className="font-medium">{provider.provider}</TableCell>
                      <TableCell className="text-right">{provider.totalRequests}</TableCell>
                      <TableCell className="text-right">{provider.notifyMeRequests}</TableCell>
                      <TableCell className="text-right">{provider.otherRequests}</TableCell>
                      <TableCell className="text-right">{provider.notifyMePercentage}%</TableCell>
                      <TableCell className="text-right">${provider.notifyMeCost.toFixed(2)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Notification Health Tab */}
        <TabsContent value="health" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <Clock className="h-4 w-4" />
                  Pending Queue
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{healthData?.queue.pendingCount || 0}</div>
                <p className="text-xs text-muted-foreground">Awaiting notification</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                  Sent (7 Days)
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{healthData?.performance.notificationsSentLast7Days || 0}</div>
                <p className="text-xs text-muted-foreground">Successfully delivered</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <XCircle className="h-4 w-4 text-red-500" />
                  Failed (7 Days)
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{healthData?.failures.totalLast7Days || 0}</div>
                <p className="text-xs text-muted-foreground">Delivery failures</p>
              </CardContent>
            </Card>
          </div>

          {/* Failure Reasons */}
          {healthData?.failures.byReason && Object.keys(healthData.failures.byReason).length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Failure Reasons (Last 7 Days)</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {Object.entries(healthData.failures.byReason).map(([reason, count]) => (
                    <div key={reason} className="flex items-center justify-between py-2 border-b last:border-0">
                      <span className="text-sm truncate max-w-md">{reason}</span>
                      <Badge variant="destructive">{count}</Badge>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Recent Failures */}
          {healthData?.failures.recentFailures && healthData.failures.recentFailures.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Recent Failed Notifications</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Email</TableHead>
                      <TableHead>Error</TableHead>
                      <TableHead>Retries</TableHead>
                      <TableHead>Last Attempt</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {healthData.failures.recentFailures.map((failure) => (
                      <TableRow key={failure.id}>
                        <TableCell className="font-mono text-sm">{failure.email}</TableCell>
                        <TableCell className="max-w-48 truncate text-sm text-destructive">
                          {failure.error || 'Unknown error'}
                        </TableCell>
                        <TableCell>{failure.retryCount}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {failure.lastAttempt ? new Date(failure.lastAttempt).toLocaleString() : '-'}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button variant="ghost" size="sm" onClick={() => handleRetry(failure.id)}>
                            <RotateCcw className="h-4 w-4 mr-1" />
                            Retry
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>

      {/* Detail Dialog */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Registration Details</DialogTitle>
            <DialogDescription>
              Full timeline and activity for this notification registration
            </DialogDescription>
          </DialogHeader>

          {isDetailLoading ? (
            <div className="space-y-4">
              <Skeleton className="h-20" />
              <Skeleton className="h-40" />
            </div>
          ) : selectedDetail ? (
            <div className="space-y-6">
              {/* Registration Info */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm text-muted-foreground">Email</label>
                  <p className="font-medium">{selectedDetail.registration.email}</p>
                </div>
                <div>
                  <label className="text-sm text-muted-foreground">Status</label>
                  <div className="flex items-center gap-2">
                    <Badge 
                      variant={selectedDetail.registration.notificationStatus === 'sent' ? 'default' : 
                               selectedDetail.registration.notificationStatus === 'failed' ? 'destructive' : 'secondary'}
                    >
                      {selectedDetail.registration.notificationStatus}
                    </Badge>
                    {!selectedDetail.registration.isActive && (
                      <Badge variant="outline">Disabled</Badge>
                    )}
                  </div>
                </div>
                <div>
                  <label className="text-sm text-muted-foreground">Price Threshold</label>
                  <p className="font-medium">{selectedDetail.registration.priceThreshold}%</p>
                </div>
                <div>
                  <label className="text-sm text-muted-foreground">Registered</label>
                  <p className="font-medium">{new Date(selectedDetail.registration.createdAt).toLocaleString()}</p>
                </div>
                {selectedDetail.registration.sourceAirbnbUrl && (
                  <div className="col-span-2">
                    <label className="text-sm text-muted-foreground">Source Listing</label>
                    <a 
                      href={selectedDetail.registration.sourceAirbnbUrl} 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="text-primary hover:underline flex items-center gap-1"
                    >
                      {selectedDetail.registration.sourceAirbnbTitle || 'View Listing'}
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                )}
                {selectedDetail.registration.lastNotificationError && (
                  <div className="col-span-2">
                    <label className="text-sm text-muted-foreground">Last Error</label>
                    <p className="text-sm text-destructive">{selectedDetail.registration.lastNotificationError}</p>
                  </div>
                )}
              </div>

              {/* API Usage */}
              {Object.keys(selectedDetail.apiUsage).length > 0 && (
                <div>
                  <h4 className="font-semibold mb-2">API Usage</h4>
                  <div className="grid grid-cols-3 gap-2">
                    {Object.entries(selectedDetail.apiUsage).map(([provider, data]) => (
                      <Card key={provider} className="p-3">
                        <div className="text-sm font-medium">{provider}</div>
                        <div className="text-lg font-bold">{data.requests} requests</div>
                        <div className="text-xs text-muted-foreground">
                          {data.successes} successful · ${data.cost.toFixed(2)} cost
                        </div>
                      </Card>
                    ))}
                  </div>
                </div>
              )}

              {/* Extractions */}
              {selectedDetail.extractions.length > 0 && (
                <div>
                  <h4 className="font-semibold mb-2">Extractions ({selectedDetail.extractions.length})</h4>
                  <ScrollArea className="h-40">
                    <div className="space-y-2">
                      {selectedDetail.extractions.map((ext) => (
                        <div key={ext.id} className="flex items-center justify-between py-2 border-b">
                          <div className="flex items-center gap-2">
                            {ext.status === 'success' ? (
                              <CheckCircle2 className="h-4 w-4 text-green-500" />
                            ) : (
                              <XCircle className="h-4 w-4 text-red-500" />
                            )}
                            <span className="font-medium">{ext.platform}</span>
                            {ext.price && <span className="text-green-600">${ext.price}</span>}
                          </div>
                          <span className="text-sm text-muted-foreground">
                            {new Date(ext.createdAt).toLocaleString()}
                          </span>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                </div>
              )}

              {/* Timeline */}
              {selectedDetail.events.length > 0 && (
                <div>
                  <h4 className="font-semibold mb-2">Event Timeline</h4>
                  <ScrollArea className="h-48">
                    <div className="space-y-3">
                      {selectedDetail.events.map((event) => (
                        <div key={event.id} className="flex gap-3 border-l-2 border-muted pl-3 py-1">
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <Badge variant="outline" className="text-xs">
                                {event.type.replace('_', ' ')}
                              </Badge>
                              {event.platform && <span className="text-sm">{event.platform}</span>}
                              {event.price && <span className="text-sm text-green-600">${event.price}</span>}
                            </div>
                            {event.error && <p className="text-xs text-destructive mt-1">{event.error}</p>}
                          </div>
                          <span className="text-xs text-muted-foreground whitespace-nowrap">
                            {new Date(event.createdAt).toLocaleString()}
                          </span>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                </div>
              )}

              {/* Actions */}
              <div className="flex justify-end gap-2 pt-4 border-t">
                {selectedDetail.registration.notificationStatus === 'failed' && (
                  <Button variant="outline" onClick={() => handleRetry(selectedDetail.registration.id)}>
                    <RotateCcw className="h-4 w-4 mr-2" />
                    Retry Notification
                  </Button>
                )}
                {selectedDetail.registration.isActive && (
                  <Button variant="destructive" onClick={() => handleDisable(selectedDetail.registration.id)}>
                    <Power className="h-4 w-4 mr-2" />
                    Disable Notifications
                  </Button>
                )}
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}