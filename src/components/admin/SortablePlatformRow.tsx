import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Sparkles, AlertTriangle, Globe } from 'lucide-react';
import { TableRow, TableCell } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { getPlatformDisplayName, getCountryDisplayName } from '@/lib/platformNames';

interface PlatformAdapter {
  id: string;
  platform_name: string;
  platform_domain: string;
  coverage_tier: string;
  coverage_status: string;
  total_attempts: number;
  total_successes: number;
  total_failures: number;
  tier_reason: string | null;
  coverage_reason: string | null;
  dedicated_extractor: string | null;
  last_success_at: string | null;
  promotion_score: number | null;
  is_new?: boolean;
  discovered_at?: string | null;
  created_at?: string;
}

interface CoverageVariant {
  id: string;
  parent_platform_domain: string;
  coverage_variant_key: string;
  detected_country: string | null;
  variant_status: string;
  total_attempts: number;
  structural_failures: number;
  transient_failures: number;
  last_seen_at: string;
}

interface SortablePlatformRowProps {
  platform: PlatformAdapter;
  variants?: CoverageVariant[];
  TierBadge: React.ComponentType<{ tier: string }>;
  StatusBadge: React.ComponentType<{ status: string }>;
  onClearNew?: (platformId: string) => void;
}

function VariantTierBadge() {
  // Variants inherit tier from parent - shown as a muted dash indicator
  return (
    <Badge variant="outline" className="text-xs bg-muted/50 text-muted-foreground border-muted">
      —
    </Badge>
  );
}

function VariantStatusBadge({ status }: { status: string }) {
  const config: Record<string, { className: string; label: string }> = {
    needs_coverage: { className: 'bg-amber-500/20 text-amber-700 dark:text-amber-400 border-amber-500/30', label: 'Needs Coverage' },
    covered: { className: 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-400 border-emerald-500/30', label: 'Covered' },
    investigating: { className: 'bg-blue-500/20 text-blue-700 dark:text-blue-400 border-blue-500/30', label: 'Investigating' },
    wont_fix: { className: 'bg-muted text-muted-foreground border-muted', label: "Won't Fix" },
  };
  const c = config[status] || config.needs_coverage;
  return <Badge variant="outline" className={`text-xs ${c.className}`}>{c.label}</Badge>;
}

export function SortablePlatformRow({ platform, variants = [], TierBadge, StatusBadge, onClearNew }: SortablePlatformRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ 
    id: platform.id,
    data: {
      tier: platform.coverage_tier,
    }
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const displayName = getPlatformDisplayName(platform.platform_domain);
  const hasVariants = variants.length > 0;

  return (
    <>
      <TableRow 
        ref={setNodeRef} 
        style={style}
        className={isDragging ? 'bg-muted/50' : ''}
      >
        <TableCell className="w-8">
          <button
            {...attributes}
            {...listeners}
            className="cursor-grab active:cursor-grabbing p-1 hover:bg-muted rounded touch-none"
            aria-label="Drag to reorder"
          >
            <GripVertical className="h-4 w-4 text-muted-foreground" />
          </button>
        </TableCell>
        <TableCell className="font-medium">
          <div className="flex items-center gap-2">
            {displayName}
            {platform.is_new && (
              <Badge 
                variant="default" 
                className="bg-emerald-500 hover:bg-emerald-600 text-white cursor-pointer text-xs gap-1"
                onClick={(e) => {
                  e.stopPropagation();
                  onClearNew?.(platform.id);
                }}
                title="Click to dismiss"
              >
                <Sparkles className="h-3 w-3" />
                New
              </Badge>
            )}
            {hasVariants && (
              <Badge variant="outline" className="text-xs gap-1 bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30">
                <Globe className="h-3 w-3" />
                {variants.length} variant{variants.length !== 1 ? 's' : ''}
              </Badge>
            )}
          </div>
        </TableCell>
        <TableCell className="text-muted-foreground text-sm">
          {platform.platform_domain}
        </TableCell>
        <TableCell>
          <TierBadge tier={platform.coverage_tier} />
        </TableCell>
        <TableCell>
          <StatusBadge status={platform.coverage_status} />
        </TableCell>
        <TableCell className="text-sm">
          {platform.total_attempts || 0}
        </TableCell>
        <TableCell className="text-sm">
          <span className="text-green-600">{platform.total_successes || 0}</span>
          <span className="text-red-500 ml-1">/ {platform.total_failures || 0}</span>
        </TableCell>
        <TableCell className="text-sm text-muted-foreground max-w-xs truncate">
          {platform.tier_reason || platform.coverage_reason || '-'}
        </TableCell>
        <TableCell>
          {platform.dedicated_extractor ? (
            <Badge variant="secondary" className="font-mono text-xs">
              {platform.dedicated_extractor}
            </Badge>
          ) : (
            <span className="text-muted-foreground">-</span>
          )}
        </TableCell>
        <TableCell className="text-xs text-muted-foreground">
          {platform.last_success_at 
            ? new Date(platform.last_success_at).toLocaleDateString()
            : '-'}
        </TableCell>
        <TableCell className="text-xs text-muted-foreground">
          {platform.discovered_at 
            ? new Date(platform.discovered_at).toLocaleDateString()
            : platform.created_at
              ? new Date(platform.created_at).toLocaleDateString()
              : '-'}
        </TableCell>
      </TableRow>
      {/* Render variants as sub-rows */}
      {variants.map((variant) => {
        const variantSuccesses = (variant.total_attempts || 0) - (variant.structural_failures || 0) - (variant.transient_failures || 0);
        const variantFailures = (variant.structural_failures || 0) + (variant.transient_failures || 0);
        
        return (
          <TableRow key={variant.id} className="bg-muted/30">
            <TableCell className="w-8"></TableCell>
            <TableCell className="font-medium pl-8">
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">└</span>
                {displayName} ({getCountryDisplayName(variant.detected_country)})
                <AlertTriangle className="h-3 w-3 text-amber-500" />
              </div>
            </TableCell>
            <TableCell className="text-muted-foreground text-xs">
              {variant.coverage_variant_key}
            </TableCell>
            <TableCell>
              <VariantTierBadge />
            </TableCell>
            <TableCell>
              <VariantStatusBadge status={variant.variant_status} />
            </TableCell>
            <TableCell className="text-sm">
              {variant.total_attempts || 0}
            </TableCell>
            <TableCell className="text-sm">
              <span className="text-green-600">{variantSuccesses}</span>
              <span className="text-red-500 ml-1">/ {variantFailures}</span>
            </TableCell>
            <TableCell className="text-xs text-muted-foreground" colSpan={2}>
              Different regional extraction logic detected
            </TableCell>
            <TableCell className="text-xs text-muted-foreground">
              {new Date(variant.last_seen_at).toLocaleDateString()}
            </TableCell>
            <TableCell></TableCell>
          </TableRow>
        );
      })}
    </>
  );
}
