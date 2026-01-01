import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAdminAuth } from './useAdminAuth';

export interface SectionHealth {
  status: 'healthy' | 'stale' | 'not_updating';
  lastActivity: string | null;
  staleSince?: string | null;
}

export interface HealthAlert {
  section: string;
  severity: 'warning' | 'critical';
  message: string;
  staleDuration: number | null;
}

export interface SystemHealthData {
  timestamp: string;
  sections: {
    pipeline: SectionHealth;
    extractions: SectionHealth;
    platforms: SectionHealth;
    searches: SectionHealth;
  };
  alerts: HealthAlert[];
}

interface UseSystemHealthOptions {
  refreshIntervalMs?: number;
}

export function useSystemHealth(options: UseSystemHealthOptions = {}) {
  const { refreshIntervalMs = 60000 } = options; // Default 1 minute
  const { getToken } = useAdminAuth();
  const [health, setHealth] = useState<SystemHealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchHealth = useCallback(async () => {
    try {
      const token = getToken();
      if (!token) {
        setError('Not authenticated');
        return;
      }

      const { data, error: invokeError } = await supabase.functions.invoke('admin-dashboard/system-health', {
        headers: { Authorization: `Bearer ${token}` },
        method: 'GET',
      });

      if (invokeError) throw invokeError;
      
      setHealth(data);
      setError(null);
    } catch (err: any) {
      console.error('Failed to fetch system health:', err);
      setError(err?.message || 'Failed to fetch system health');
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  useEffect(() => {
    fetchHealth();
    const interval = setInterval(fetchHealth, refreshIntervalMs);
    return () => clearInterval(interval);
  }, [fetchHealth, refreshIntervalMs]);

  return {
    health,
    loading,
    error,
    refetch: fetchHealth,
    hasAlerts: (health?.alerts?.length || 0) > 0,
    criticalAlerts: health?.alerts?.filter(a => a.severity === 'critical') || [],
    warningAlerts: health?.alerts?.filter(a => a.severity === 'warning') || [],
  };
}
