import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

interface AdminUser {
  id: string;
  email: string;
  role: string;
  fullName: string | null;
  twoFactorEnabled: boolean;
}

interface AdminAuthState {
  admin: AdminUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
}

// Use sessionStorage instead of localStorage for admin tokens
// This provides better security: tokens are cleared when browser closes,
// reducing XSS attack window and shared-computer risk
const ADMIN_TOKEN_KEY = 'admin_session_token';

export function useAdminAuth() {
  const [state, setState] = useState<AdminAuthState>({
    admin: null,
    isLoading: true,
    isAuthenticated: false,
  });

  const verifySession = useCallback(async () => {
    const token = sessionStorage.getItem(ADMIN_TOKEN_KEY);
    if (!token) {
      setState({ admin: null, isLoading: false, isAuthenticated: false });
      return;
    }

    try {
      const { data, error } = await supabase.functions.invoke('admin-auth/verify', {
        headers: { Authorization: `Bearer ${token}` },
        method: 'POST',
      });

      if (error || !data?.valid) {
        sessionStorage.removeItem(ADMIN_TOKEN_KEY);
        setState({ admin: null, isLoading: false, isAuthenticated: false });
        return;
      }

      setState({
        admin: data.admin,
        isLoading: false,
        isAuthenticated: true,
      });
    } catch (err) {
      console.error('Admin session verification failed:', err);
      sessionStorage.removeItem(ADMIN_TOKEN_KEY);
      setState({ admin: null, isLoading: false, isAuthenticated: false });
    }
  }, []);

  useEffect(() => {
    verifySession();
  }, [verifySession]);

  const login = async (email: string, password: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const { data, error } = await supabase.functions.invoke('admin-auth/login', {
        body: { email, password },
        method: 'POST',
      });

      if (error) {
        return { success: false, error: error.message };
      }

      if (!data?.success) {
        return { success: false, error: data?.error || 'Login failed' };
      }

      sessionStorage.setItem(ADMIN_TOKEN_KEY, data.token);
      setState({
        admin: data.admin,
        isLoading: false,
        isAuthenticated: true,
      });

      return { success: true };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Login failed' };
    }
  };

  const logout = async () => {
    const token = sessionStorage.getItem(ADMIN_TOKEN_KEY);
    if (token) {
      try {
        await supabase.functions.invoke('admin-auth/logout', {
          headers: { Authorization: `Bearer ${token}` },
          method: 'POST',
        });
      } catch (err) {
        console.error('Logout error:', err);
      }
    }
    sessionStorage.removeItem(ADMIN_TOKEN_KEY);
    setState({ admin: null, isLoading: false, isAuthenticated: false });
  };

  const changePassword = async (currentPassword: string, newPassword: string): Promise<{ success: boolean; error?: string }> => {
    const token = sessionStorage.getItem(ADMIN_TOKEN_KEY);
    if (!token) {
      return { success: false, error: 'Not authenticated' };
    }

    try {
      const { data, error } = await supabase.functions.invoke('admin-auth/change-password', {
        headers: { Authorization: `Bearer ${token}` },
        body: { currentPassword, newPassword },
        method: 'POST',
      });

      if (error || !data?.success) {
        return { success: false, error: data?.error || error?.message || 'Password change failed' };
      }

      return { success: true };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Password change failed' };
    }
  };

  const getToken = () => sessionStorage.getItem(ADMIN_TOKEN_KEY);

  return {
    ...state,
    login,
    logout,
    changePassword,
    getToken,
    refreshSession: verifySession,
  };
}
