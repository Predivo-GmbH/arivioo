import { useState, useEffect } from 'react';
import { format } from 'date-fns';
import { 
  ShieldOff, 
  Plus, 
  Trash2, 
  RefreshCw,
  AlertTriangle,
  Search
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import { useAdminAuth } from '@/hooks/useAdminAuth';

interface BlockedPlatform {
  id: string;
  domain: string;
  reason: string;
  blocked_at: string;
}

function AddBlockedDialog({ onAdd }: { onAdd: (domain: string, reason: string) => Promise<void> }) {
  const [isOpen, setIsOpen] = useState(false);
  const [domain, setDomain] = useState('');
  const [reason, setReason] = useState('');
  const [isAdding, setIsAdding] = useState(false);

  const handleAdd = async () => {
    if (!domain || !reason) return;
    
    setIsAdding(true);
    try {
      await onAdd(domain, reason);
      setIsOpen(false);
      setDomain('');
      setReason('');
      toast({ title: 'Platform blocked successfully' });
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setIsAdding(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="h-4 w-4 mr-2" />
          Block Platform
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Block a Platform</DialogTitle>
          <DialogDescription>
            Add a domain to the blocked list. This platform will be excluded from searches.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label htmlFor="domain">Domain</Label>
            <Input
              id="domain"
              placeholder="example.com"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="reason">Reason</Label>
            <Textarea
              id="reason"
              placeholder="Why is this platform being blocked?"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setIsOpen(false)}>Cancel</Button>
          <Button onClick={handleAdd} disabled={isAdding || !domain || !reason}>
            {isAdding ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : <ShieldOff className="h-4 w-4 mr-2" />}
            Block Platform
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function BlockedPlatforms() {
  const { getToken } = useAdminAuth();
  const [blocked, setBlocked] = useState<BlockedPlatform[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const fetchBlocked = async () => {
    setIsLoading(true);
    setError(null);

    try {
      const token = getToken();
      const { data, error } = await supabase.functions.invoke('admin-dashboard/blocked', {
        headers: { Authorization: `Bearer ${token}` },
        method: 'GET',
      });

      if (error) throw error;
      setBlocked(data.blockedPlatforms || []);
    } catch (err: any) {
      setError(err?.message || 'Failed to load blocked platforms');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchBlocked();
  }, []);

  const addBlocked = async (domain: string, reason: string) => {
    const token = getToken();
    const { data, error } = await supabase.functions.invoke('admin-dashboard/blocked', {
      headers: { Authorization: `Bearer ${token}` },
      method: 'POST',
      body: { domain, reason },
    });

    if (error) throw error;
    setBlocked(prev => [data.blockedPlatform, ...prev]);
  };

  const unblock = async (id: string) => {
    const token = getToken();
    const { error } = await supabase.functions.invoke('admin-dashboard/unblock', {
      headers: { Authorization: `Bearer ${token}` },
      method: 'POST',
      body: { id },
    });

    if (error) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
      return;
    }

    setBlocked(prev => prev.filter(b => b.id !== id));
    toast({ title: 'Platform unblocked' });
  };

  const filteredBlocked = blocked.filter(b => 
    b.domain.toLowerCase().includes(search.toLowerCase()) ||
    b.reason.toLowerCase().includes(search.toLowerCase())
  );

  // Group by reason
  const reasonCounts = blocked.reduce((acc, b) => {
    acc[b.reason] = (acc[b.reason] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold">Blocked Platforms</h1>
        <div className="animate-pulse space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-16 bg-muted rounded-lg"></div>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold">Blocked Platforms</h1>
        <Card className="border-destructive">
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              <span>{error}</span>
            </div>
            <Button onClick={fetchBlocked} className="mt-4">
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
          <h1 className="text-3xl font-bold">Blocked Platforms</h1>
          <p className="text-muted-foreground">{blocked.length} platforms blocked</p>
        </div>
        <AddBlockedDialog onAdd={addBlocked} />
      </div>

      {/* Reason Summary */}
      {Object.keys(reasonCounts).length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Block Reasons</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {Object.entries(reasonCounts)
                .sort((a, b) => b[1] - a[1])
                .map(([reason, count]) => (
                  <Badge key={reason} variant="secondary">
                    {reason}: {count}
                  </Badge>
                ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search domains or reasons..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-10"
        />
      </div>

      {/* List */}
      <Card>
        <CardContent className="pt-6">
          {filteredBlocked.length === 0 ? (
            <div className="flex flex-col items-center py-8 text-muted-foreground">
              <ShieldOff className="h-8 w-8 mb-2" />
              <p>{search ? 'No matching platforms' : 'No blocked platforms'}</p>
            </div>
          ) : (
            <div className="divide-y">
              {filteredBlocked.map((platform) => (
                <div key={platform.id} className="py-4 flex items-center justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium font-mono">{platform.domain}</p>
                    <p className="text-sm text-muted-foreground">{platform.reason}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Blocked {format(new Date(platform.blocked_at), 'MMM d, yyyy')}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => unblock(platform.id)}
                    className="text-destructive hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4 mr-1" />
                    Unblock
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
