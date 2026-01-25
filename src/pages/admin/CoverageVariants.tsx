import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAdminAuth } from '@/hooks/useAdminAuth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { RefreshCw, Globe, AlertTriangle, CheckCircle, Clock, HelpCircle } from 'lucide-react';
import { getPlatformDisplayName, getCountryDisplayName } from '@/lib/platformNames';
import { toast } from 'sonner';

interface CoverageVariant {
  id: string;
  parent_platform_domain: string;
  coverage_variant_key: string;
  detected_country: string | null;
  detected_locale: string | null;
  detected_tld: string | null;
  variant_status: string;
  variant_reason: string | null;
  inherited_tier: string | null;
  total_attempts: number;
  structural_failures: number;
  transient_failures: number;
  first_detected_at: string;
  last_seen_at: string;
  sample_urls: string[] | null;
}

interface GroupedVariants {
  [domain: string]: CoverageVariant[];
}

const STATUS_CONFIG: Record<string, { icon: React.ReactNode; color: string; label: string }> = {
  needs_coverage: { 
    icon: <AlertTriangle className="h-4 w-4" />, 
    color: 'bg-amber-500/20 text-amber-700 dark:text-amber-400 border-amber-500/30', 
    label: 'Needs Coverage' 
  },
  covered: { 
    icon: <CheckCircle className="h-4 w-4" />, 
    color: 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-400 border-emerald-500/30', 
    label: 'Covered' 
  },
  investigating: { 
    icon: <Clock className="h-4 w-4" />, 
    color: 'bg-blue-500/20 text-blue-700 dark:text-blue-400 border-blue-500/30', 
    label: 'Investigating' 
  },
  wont_fix: { 
    icon: <HelpCircle className="h-4 w-4" />, 
    color: 'bg-muted text-muted-foreground border-muted', 
    label: "Won't Fix" 
  },
};

export default function CoverageVariants() {
  const { getToken } = useAdminAuth();
  const [variants, setVariants] = useState<CoverageVariant[]>([]);
  const [groupedVariants, setGroupedVariants] = useState<GroupedVariants>({});
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState<string | null>(null);

  const fetchVariants = async () => {
    const sessionToken = getToken();
    if (!sessionToken) return;
    
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke('admin-dashboard/coverage-variants', {
        method: 'GET',
        headers: { Authorization: `Bearer ${sessionToken}` }
      });

      if (error) throw error;

      const variantList = data?.variants || [];
      setVariants(variantList);

      // Group by parent domain
      const grouped: GroupedVariants = {};
      for (const v of variantList) {
        const domain = v.parent_platform_domain || 'unknown';
        if (!grouped[domain]) grouped[domain] = [];
        grouped[domain].push(v);
      }
      setGroupedVariants(grouped);
    } catch (err) {
      console.error('Failed to fetch variants:', err);
      toast.error('Failed to load coverage variants');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchVariants();
  }, []);

  const updateVariantStatus = async (variantId: string, newStatus: string) => {
    const sessionToken = getToken();
    if (!sessionToken) return;

    setUpdating(variantId);
    try {
      const { error } = await supabase.functions.invoke('admin-dashboard/coverage-variants', {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${sessionToken}` },
        body: { 
          id: variantId,
          variant_status: newStatus
        }
      });

      if (error) throw error;

      toast.success('Variant status updated');
      fetchVariants();
    } catch (err) {
      console.error('Failed to update variant:', err);
      toast.error('Failed to update variant status');
    } finally {
      setUpdating(null);
    }
  };

  const StatusBadge = ({ status }: { status: string }) => {
    const config = STATUS_CONFIG[status] || STATUS_CONFIG.needs_coverage;
    return (
      <Badge variant="outline" className={`gap-1 ${config.color}`}>
        {config.icon}
        {config.label}
      </Badge>
    );
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const domains = Object.keys(groupedVariants).sort();
  const totalVariants = variants.length;
  const needsCoverage = variants.filter(v => v.variant_status === 'needs_coverage').length;

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Variants</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalVariants}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Needs Coverage</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-amber-600 dark:text-amber-400">{needsCoverage}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Platforms Affected</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{domains.length}</div>
          </CardContent>
        </Card>
      </div>

      {/* Refresh Button */}
      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={fetchVariants} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* Variants by Platform */}
      {domains.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <Globe className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p>No coverage variants detected yet.</p>
            <p className="text-sm">Variants are auto-registered when structural extraction failures occur.</p>
          </CardContent>
        </Card>
      ) : (
        domains.map(domain => (
          <Card key={domain}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Globe className="h-5 w-5 text-muted-foreground" />
                {getPlatformDisplayName(domain)}
                <Badge variant="secondary" className="ml-2">
                  {groupedVariants[domain].length} variant{groupedVariants[domain].length !== 1 ? 's' : ''}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Country / Region</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Attempts</TableHead>
                    <TableHead className="text-right">Structural Failures</TableHead>
                    <TableHead className="text-right">Transient Failures</TableHead>
                    <TableHead>Last Seen</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {groupedVariants[domain].map(variant => (
                    <TableRow key={variant.id}>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="font-medium">
                            {getCountryDisplayName(variant.detected_country)}
                          </span>
                          {variant.detected_locale && (
                            <span className="text-xs text-muted-foreground">
                              Locale: {variant.detected_locale}
                            </span>
                          )}
                          {variant.detected_tld && (
                            <span className="text-xs text-muted-foreground">
                              TLD: .{variant.detected_tld}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={variant.variant_status} />
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {variant.total_attempts}
                      </TableCell>
                      <TableCell className="text-right font-mono text-destructive">
                        {variant.structural_failures}
                      </TableCell>
                      <TableCell className="text-right font-mono text-amber-600 dark:text-amber-400">
                        {variant.transient_failures}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {new Date(variant.last_seen_at).toLocaleDateString()}
                      </TableCell>
                      <TableCell>
                        <Select
                          value={variant.variant_status}
                          onValueChange={(value) => updateVariantStatus(variant.id, value)}
                          disabled={updating === variant.id}
                        >
                          <SelectTrigger className="w-[140px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="needs_coverage">Needs Coverage</SelectItem>
                            <SelectItem value="investigating">Investigating</SelectItem>
                            <SelectItem value="covered">Covered</SelectItem>
                            <SelectItem value="wont_fix">Won't Fix</SelectItem>
                          </SelectContent>
                        </Select>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
