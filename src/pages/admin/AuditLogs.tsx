import { useState, useEffect } from 'react';
import { format } from 'date-fns';
import { 
  FileText, 
  RefreshCw, 
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  User,
  Shield
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { useAdminAuth } from '@/hooks/useAdminAuth';

interface AuditLog {
  id: string;
  admin_user_id: string;
  admin_email: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  old_values: any;
  new_values: any;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
}

const ACTION_COLORS: Record<string, string> = {
  login: 'bg-green-500',
  logout: 'bg-gray-500',
  change_password: 'bg-yellow-500',
  update_adapter: 'bg-blue-500',
  block_platform: 'bg-red-500',
  unblock_platform: 'bg-green-500',
  refresh_quota: 'bg-purple-500',
  update_provider_settings: 'bg-blue-500',
};

export default function AuditLogs() {
  const { getToken } = useAdminAuth();
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const limit = 25;

  const fetchLogs = async () => {
    setIsLoading(true);
    setError(null);

    try {
      const token = getToken();
      const { data, error } = await supabase.functions.invoke(`admin-dashboard/audit-logs?page=${page}&limit=${limit}`, {
        headers: { Authorization: `Bearer ${token}` },
        method: 'GET',
      });

      if (error) throw error;
      setLogs(data.logs || []);
      setTotal(data.total || 0);
    } catch (err: any) {
      setError(err?.message || 'Failed to load audit logs');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchLogs();
  }, [page]);

  const totalPages = Math.ceil(total / limit);

  if (isLoading && logs.length === 0) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold">Audit Logs</h1>
        <div className="animate-pulse space-y-3">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-16 bg-muted rounded-lg"></div>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold">Audit Logs</h1>
        <Card className="border-destructive">
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              <span>{error}</span>
            </div>
            <Button onClick={fetchLogs} className="mt-4">
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
          <h1 className="text-3xl font-bold">Audit Logs</h1>
          <p className="text-muted-foreground">{total} total events</p>
        </div>
        <Button variant="outline" onClick={fetchLogs} disabled={isLoading}>
          <RefreshCw className={`mr-2 h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      <Card>
        <CardContent className="pt-6">
          {logs.length === 0 ? (
            <div className="flex flex-col items-center py-8 text-muted-foreground">
              <FileText className="h-8 w-8 mb-2" />
              <p>No audit logs yet</p>
            </div>
          ) : (
            <div className="space-y-3">
              {logs.map((log) => (
                <div key={log.id} className="p-4 border rounded-lg">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <div className={`w-2 h-2 rounded-full ${ACTION_COLORS[log.action] || 'bg-gray-500'}`} />
                      <Badge variant="outline">{log.action.replace(/_/g, ' ')}</Badge>
                      <Badge variant="secondary" className="text-xs">{log.resource_type}</Badge>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {format(new Date(log.created_at), 'MMM d, yyyy HH:mm:ss')}
                    </span>
                  </div>
                  
                  <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
                    <User className="h-3 w-3" />
                    <span>{log.admin_email}</span>
                    {log.ip_address && (
                      <>
                        <span className="mx-1">•</span>
                        <span className="font-mono text-xs">{log.ip_address}</span>
                      </>
                    )}
                  </div>

                  {log.resource_id && (
                    <p className="text-xs text-muted-foreground font-mono">
                      Resource: {log.resource_id}
                    </p>
                  )}

                  {(log.old_values || log.new_values) && (
                    <details className="mt-2">
                      <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                        View changes
                      </summary>
                      <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                        {log.old_values && (
                          <div>
                            <p className="font-medium text-muted-foreground mb-1">Before</p>
                            <pre className="bg-muted p-2 rounded overflow-x-auto max-h-32">
                              {JSON.stringify(log.old_values, null, 2)}
                            </pre>
                          </div>
                        )}
                        {log.new_values && (
                          <div>
                            <p className="font-medium text-muted-foreground mb-1">After</p>
                            <pre className="bg-muted p-2 rounded overflow-x-auto max-h-32">
                              {JSON.stringify(log.new_values, null, 2)}
                            </pre>
                          </div>
                        )}
                      </div>
                    </details>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-4 pt-4 border-t">
              <p className="text-sm text-muted-foreground">
                Page {page} of {totalPages}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
