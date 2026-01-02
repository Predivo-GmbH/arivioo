import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

export type AccessState = 'locked' | 'unlocked';
export type LockedReason = 'email_verification_required' | 'not_owner' | 'search_not_found';

export interface PublicSummary {
  searchId: string;
  status: string;
  createdAt: string;
  hasResults: boolean;
  resultCount: number;
  isComplete: boolean;
  checkInDate: string | null;
  checkOutDate: string | null;
  nightsCount: number | null;
}

export interface PrivateResults {
  search: any;
  results: any[];
  extractions: any[];
  confirmedTotal: any | null;
}

export interface SearchAccessResponse {
  access: AccessState;
  lockedReason?: LockedReason;
  publicSummary: PublicSummary;
  privateResults?: PrivateResults;
}

export function useSearchAccess() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accessData, setAccessData] = useState<SearchAccessResponse | null>(null);

  const fetchAccess = useCallback(async (searchId: string): Promise<SearchAccessResponse | null> => {
    setLoading(true);
    setError(null);

    try {
      // Get current session for auth header
      const { data: { session } } = await supabase.auth.getSession();
      const authToken = session?.access_token;

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
      }

      // Check for admin session in localStorage (if admin is logged in)
      const adminSession = localStorage.getItem('admin_session_token');
      if (adminSession) {
        headers['x-admin-session'] = adminSession;
      }

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/get-search-access`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ searchId }),
        }
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      const data: SearchAccessResponse = await response.json();
      setAccessData(data);
      return data;
    } catch (err: any) {
      console.error('[useSearchAccess] Error:', err);
      setError(err.message || 'Failed to fetch search access');
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const isUnlocked = accessData?.access === 'unlocked';
  const isLocked = accessData?.access === 'locked';

  return {
    loading,
    error,
    accessData,
    fetchAccess,
    isUnlocked,
    isLocked,
    publicSummary: accessData?.publicSummary ?? null,
    privateResults: accessData?.privateResults ?? null,
    lockedReason: accessData?.lockedReason ?? null,
  };
}
