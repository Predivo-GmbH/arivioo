import { useState, useEffect } from 'react';
import { format } from 'date-fns';
import { 
  Settings, 
  CheckCircle, 
  XCircle, 
  RefreshCw,
  AlertTriangle,
  Edit,
  Save,
  X,
  TrendingUp,
  Clock
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { toast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import { useAdminAuth } from '@/hooks/useAdminAuth';

interface AdapterStats {
  totalLast7Days: number;
  successRate: number;
  lastSuccessAt: string | null;
  failureReasons: Record<string, number>;
}

interface Adapter {
  id: string;
  platform_name: string;
  platform_domain: string;
  is_active: boolean;
  is_ai_generated: boolean;
  deep_link_template: string;
  date_format: string;
  requires_occupancy: boolean;
  url_parameter_rules: any;
  navigation_hints: any;
  extraction_schema_overrides: any;
  occupancy_params: any;
  price_selectors: any;
  reliability_score: number;
  created_at: string;
  updated_at: string;
  stats: AdapterStats;
}

function AdapterEditDialog({ adapter, onSave }: { adapter: Adapter; onSave: (updates: any) => Promise<void> }) {
  const [isOpen, setIsOpen] = useState(false);
  const [urlRules, setUrlRules] = useState(JSON.stringify(adapter.url_parameter_rules, null, 2) || '{}');
  const [navHints, setNavHints] = useState(JSON.stringify(adapter.navigation_hints, null, 2) || '{}');
  const [schemaOverrides, setSchemaOverrides] = useState(JSON.stringify(adapter.extraction_schema_overrides, null, 2) || '{}');
  const [isSaving, setIsSaving] = useState(false);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const updates = {
        url_parameter_rules: urlRules ? JSON.parse(urlRules) : null,
        navigation_hints: navHints ? JSON.parse(navHints) : null,
        extraction_schema_overrides: schemaOverrides ? JSON.parse(schemaOverrides) : null,
      };
      await onSave(updates);
      setIsOpen(false);
      toast({ title: 'Adapter updated successfully' });
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          <Edit className="h-4 w-4 mr-1" />
          Edit
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Adapter: {adapter.platform_name}</DialogTitle>
          <DialogDescription>{adapter.platform_domain}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label>URL Parameter Rules (JSON)</Label>
            <Textarea
              value={urlRules}
              onChange={(e) => setUrlRules(e.target.value)}
              className="font-mono text-sm h-32"
              placeholder="{}"
            />
          </div>
          <div>
            <Label>Navigation Hints (JSON)</Label>
            <Textarea
              value={navHints}
              onChange={(e) => setNavHints(e.target.value)}
              className="font-mono text-sm h-32"
              placeholder="{}"
            />
          </div>
          <div>
            <Label>Extraction Schema Overrides (JSON)</Label>
            <Textarea
              value={schemaOverrides}
              onChange={(e) => setSchemaOverrides(e.target.value)}
              className="font-mono text-sm h-32"
              placeholder="{}"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setIsOpen(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
            Save Changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function Adapters() {
  const { getToken } = useAdminAuth();
  const [adapters, setAdapters] = useState<Adapter[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAdapters = async () => {
    setIsLoading(true);
    setError(null);

    try {
      const token = getToken();
      const { data, error } = await supabase.functions.invoke('admin-dashboard/adapters', {
        headers: { Authorization: `Bearer ${token}` },
        method: 'GET',
      });

      if (error) throw error;
      setAdapters(data.adapters || []);
    } catch (err: any) {
      setError(err?.message || 'Failed to load adapters');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchAdapters();
  }, []);

  const updateAdapter = async (id: string, updates: any) => {
    const token = getToken();
    const { data, error } = await supabase.functions.invoke('admin-dashboard/adapters', {
      headers: { Authorization: `Bearer ${token}` },
      method: 'PATCH',
      body: { id, ...updates },
    });

    if (error) throw error;
    
    setAdapters(prev => 
      prev.map(a => a.id === id ? { ...a, ...data.adapter } : a)
    );
  };

  const toggleActive = async (adapter: Adapter) => {
    try {
      await updateAdapter(adapter.id, { is_active: !adapter.is_active });
      toast({ title: `Adapter ${!adapter.is_active ? 'enabled' : 'disabled'}` });
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold">Platform Adapters</h1>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <Card key={i} className="animate-pulse">
              <CardHeader>
                <div className="h-5 bg-muted rounded w-32"></div>
              </CardHeader>
              <CardContent>
                <div className="h-4 bg-muted rounded w-24 mb-2"></div>
                <div className="h-4 bg-muted rounded w-20"></div>
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
        <h1 className="text-3xl font-bold">Platform Adapters</h1>
        <Card className="border-destructive">
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              <span>{error}</span>
            </div>
            <Button onClick={fetchAdapters} className="mt-4">
              <RefreshCw className="mr-2 h-4 w-4" /> Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const activeAdapters = adapters.filter(a => a.is_active);
  const inactiveAdapters = adapters.filter(a => !a.is_active);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Platform Adapters</h1>
          <p className="text-muted-foreground">
            {activeAdapters.length} active, {inactiveAdapters.length} inactive
          </p>
        </div>
        <Button variant="outline" onClick={fetchAdapters}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Refresh
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {adapters.map((adapter) => (
          <Card key={adapter.id} className={!adapter.is_active ? 'opacity-60' : ''}>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg">{adapter.platform_name}</CardTitle>
                <Switch
                  checked={adapter.is_active}
                  onCheckedChange={() => toggleActive(adapter)}
                />
              </div>
              <CardDescription className="text-xs font-mono">
                {adapter.platform_domain}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-2 flex-wrap">
                {adapter.is_ai_generated && (
                  <Badge variant="secondary" className="text-xs">AI Generated</Badge>
                )}
                {adapter.requires_occupancy && (
                  <Badge variant="outline" className="text-xs">Requires Occupancy</Badge>
                )}
              </div>

              <div className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <p className="text-muted-foreground text-xs">Reliability</p>
                  <p className="font-medium">{(adapter.reliability_score * 100).toFixed(0)}%</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Success Rate (7d)</p>
                  <div className="flex items-center gap-1">
                    <p className="font-medium">{adapter.stats.successRate}%</p>
                    {adapter.stats.successRate >= 70 ? (
                      <TrendingUp className="h-3 w-3 text-success" />
                    ) : (
                      <AlertTriangle className="h-3 w-3 text-yellow-500" />
                    )}
                  </div>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Total (7d)</p>
                  <p className="font-medium">{adapter.stats.totalLast7Days}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Last Success</p>
                  <p className="font-medium text-xs">
                    {adapter.stats.lastSuccessAt 
                      ? format(new Date(adapter.stats.lastSuccessAt), 'MMM d, HH:mm')
                      : 'Never'}
                  </p>
                </div>
              </div>

              {Object.keys(adapter.stats.failureReasons).length > 0 && (
                <div>
                  <p className="text-muted-foreground text-xs mb-1">Top Failures</p>
                  <div className="flex flex-wrap gap-1">
                    {Object.entries(adapter.stats.failureReasons)
                      .slice(0, 2)
                      .map(([reason, count]) => (
                        <Badge key={reason} variant="destructive" className="text-xs">
                          {reason.substring(0, 20)}: {count}
                        </Badge>
                      ))}
                  </div>
                </div>
              )}

              <div className="flex justify-end pt-2 border-t">
                <AdapterEditDialog 
                  adapter={adapter} 
                  onSave={(updates) => updateAdapter(adapter.id, updates)}
                />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
