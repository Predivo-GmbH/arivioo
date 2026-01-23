import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Sparkles } from 'lucide-react';
import { TableRow, TableCell } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';

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
}

interface SortablePlatformRowProps {
  platform: PlatformAdapter;
  TierBadge: React.ComponentType<{ tier: string }>;
  StatusBadge: React.ComponentType<{ status: string }>;
  onClearNew?: (platformId: string) => void;
}

export function SortablePlatformRow({ platform, TierBadge, StatusBadge, onClearNew }: SortablePlatformRowProps) {
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

  return (
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
          {platform.platform_name}
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
        {(platform.total_failures || 0) > 0 && (
          <span className="text-red-500 ml-1">/ {platform.total_failures}</span>
        )}
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
    </TableRow>
  );
}
