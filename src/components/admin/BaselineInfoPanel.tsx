import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Button } from '@/components/ui/button';
import { Shield, ChevronDown, ChevronRight, CheckCircle2, AlertCircle, Clock, GitCommit, Tag } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAdminAuth } from '@/hooks/useAdminAuth';
import { BASELINE_EXPECTATIONS, CATEGORY_LABELS, getExpectationsByCategory } from '@/lib/baselineExpectations';

interface BaselineData {
  baseline_name: string;
  baseline_version: string;
  declared_at: string;
  declared_by: string | null;
  git_commit_hash: string | null;
  deployment_id: string | null;
  is_active: boolean;
  expectations: Record<string, unknown>;
  notes: string | null;
}

export function BaselineInfoPanel() {
  const { getToken } = useAdminAuth();
  const [baseline, setBaseline] = useState<BaselineData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showExpectations, setShowExpectations] = useState(false);

  useEffect(() => {
    async function fetchBaseline() {
      try {
        const token = getToken();
        if (!token) {
          setError('Not authenticated');
          return;
        }

        const { data, error: invokeError } = await supabase.functions.invoke('admin-dashboard/baseline', {
          headers: { Authorization: `Bearer ${token}` },
          method: 'GET',
        });

        if (invokeError) throw invokeError;
        setBaseline(data);
        setError(null);
      } catch (err: any) {
        console.error('Failed to fetch baseline:', err);
        setError(err?.message || 'Failed to fetch baseline');
      } finally {
        setLoading(false);
      }
    }

    fetchBaseline();
  }, [getToken]);

  const expectationsByCategory = getExpectationsByCategory();

  if (loading) {
    return (
      <Card className="border-border/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Shield className="h-4 w-4" />
            Current Stable Baseline
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground">Loading...</div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="border-destructive/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Shield className="h-4 w-4" />
            Current Stable Baseline
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-destructive flex items-center gap-2">
            <AlertCircle className="h-4 w-4" />
            {error}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!baseline) {
    return (
      <Card className="border-warning/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Shield className="h-4 w-4" />
            Current Stable Baseline
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-warning">No active baseline declared</div>
        </CardContent>
      </Card>
    );
  }

  const declaredDate = new Date(baseline.declared_at);
  const formattedDate = declaredDate.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <Card className="border-primary/20 bg-primary/5">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Shield className="h-4 w-4 text-primary" />
            Current Stable Baseline
          </CardTitle>
          <Badge variant="outline" className="border-primary/50 text-primary">
            <CheckCircle2 className="h-3 w-3 mr-1" />
            Active
          </Badge>
        </div>
        <CardDescription className="text-xs">
          Reference point for debugging and regression analysis
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Baseline Identity */}
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="flex items-center gap-2">
            <Tag className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">Name:</span>
            <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
              {baseline.baseline_name}
            </code>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">Version:</span>
            <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
              v{baseline.baseline_version}
            </code>
          </div>
        </div>

        <div className="flex items-center gap-2 text-sm">
          <Clock className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-muted-foreground">Declared:</span>
          <span>{formattedDate}</span>
          {baseline.declared_by && (
            <span className="text-muted-foreground">by {baseline.declared_by}</span>
          )}
        </div>

        {baseline.git_commit_hash && (
          <div className="flex items-center gap-2 text-sm">
            <GitCommit className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">Commit:</span>
            <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
              {baseline.git_commit_hash.slice(0, 8)}
            </code>
          </div>
        )}

        {baseline.notes && (
          <p className="text-xs text-muted-foreground border-t pt-2 mt-2">
            {baseline.notes}
          </p>
        )}

        {/* Expandable Expectations */}
        <Collapsible open={showExpectations} onOpenChange={setShowExpectations}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="w-full justify-between mt-2">
              <span className="text-xs">
                Baseline Expectations ({BASELINE_EXPECTATIONS.length})
              </span>
              {showExpectations ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2 space-y-3">
            {Object.entries(expectationsByCategory).map(([category, expectations]) => (
              <div key={category} className="space-y-1.5">
                <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  {CATEGORY_LABELS[category] || category}
                </h4>
                <ul className="space-y-1">
                  {expectations.map((exp) => (
                    <li
                      key={exp.id}
                      className="flex items-start gap-2 text-xs"
                      title={exp.observable}
                    >
                      <CheckCircle2 className="h-3 w-3 text-primary mt-0.5 shrink-0" />
                      <span>
                        {exp.description}
                        {exp.critical && (
                          <Badge variant="destructive" className="ml-1.5 text-[10px] px-1 py-0">
                            Critical
                          </Badge>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  );
}
