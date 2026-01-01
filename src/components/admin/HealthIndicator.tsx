import { useState, useEffect } from 'react';
import { AlertTriangle, CheckCircle, XCircle, Clock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { formatDistanceToNow } from 'date-fns';

export type HealthStatus = 'healthy' | 'stale' | 'not_updating' | 'unknown';

interface HealthIndicatorProps {
  status: HealthStatus;
  lastActivity?: string | null;
  label?: string;
  showLabel?: boolean;
}

export function HealthIndicator({ status, lastActivity, label = 'Status', showLabel = true }: HealthIndicatorProps) {
  const getStatusConfig = () => {
    switch (status) {
      case 'healthy':
        return {
          icon: CheckCircle,
          color: 'text-green-500',
          bgColor: 'bg-green-500/10',
          label: 'Healthy',
          description: 'Data is up to date',
        };
      case 'stale':
        return {
          icon: Clock,
          color: 'text-yellow-500',
          bgColor: 'bg-yellow-500/10',
          label: 'Stale',
          description: 'Data may be outdated',
        };
      case 'not_updating':
        return {
          icon: XCircle,
          color: 'text-destructive',
          bgColor: 'bg-destructive/10',
          label: 'Not Updating',
          description: 'Data has stopped updating',
        };
      default:
        return {
          icon: AlertTriangle,
          color: 'text-muted-foreground',
          bgColor: 'bg-muted',
          label: 'Unknown',
          description: 'Status unknown',
        };
    }
  };

  const config = getStatusConfig();
  const Icon = config.icon;

  const timeAgo = lastActivity
    ? formatDistanceToNow(new Date(lastActivity), { addSuffix: true })
    : 'never';

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md ${config.bgColor}`}>
            <Icon className={`h-3.5 w-3.5 ${config.color}`} />
            {showLabel && (
              <span className={`text-xs font-medium ${config.color}`}>
                {config.label}
              </span>
            )}
          </div>
        </TooltipTrigger>
        <TooltipContent>
          <div className="text-sm">
            <p className="font-medium">{label}: {config.label}</p>
            <p className="text-muted-foreground">{config.description}</p>
            <p className="text-muted-foreground">Last update: {timeAgo}</p>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

interface SystemHealthBannerProps {
  alerts: Array<{
    section: string;
    severity: 'warning' | 'critical';
    message: string;
    staleDuration?: number | null;
  }>;
}

export function SystemHealthBanner({ alerts }: SystemHealthBannerProps) {
  if (alerts.length === 0) return null;

  const criticalAlerts = alerts.filter(a => a.severity === 'critical');
  const warningAlerts = alerts.filter(a => a.severity === 'warning');

  return (
    <div className="space-y-2 mb-4">
      {criticalAlerts.map((alert, i) => (
        <div key={`critical-${i}`} className="flex items-center gap-2 p-3 bg-destructive/10 border border-destructive/20 rounded-lg">
          <XCircle className="h-5 w-5 text-destructive flex-shrink-0" />
          <div className="flex-1">
            <span className="font-medium text-destructive">Critical: </span>
            <span className="text-sm">{alert.message}</span>
            {alert.staleDuration && (
              <span className="text-xs text-muted-foreground ml-2">
                ({alert.staleDuration} minutes ago)
              </span>
            )}
          </div>
          <Badge variant="destructive" className="uppercase text-xs">
            {alert.section}
          </Badge>
        </div>
      ))}
      {warningAlerts.map((alert, i) => (
        <div key={`warning-${i}`} className="flex items-center gap-2 p-3 bg-yellow-500/10 border border-yellow-500/20 rounded-lg">
          <AlertTriangle className="h-5 w-5 text-yellow-500 flex-shrink-0" />
          <div className="flex-1">
            <span className="font-medium text-yellow-600">Warning: </span>
            <span className="text-sm">{alert.message}</span>
            {alert.staleDuration && (
              <span className="text-xs text-muted-foreground ml-2">
                ({alert.staleDuration} minutes ago)
              </span>
            )}
          </div>
          <Badge variant="outline" className="uppercase text-xs border-yellow-500 text-yellow-600">
            {alert.section}
          </Badge>
        </div>
      ))}
    </div>
  );
}
