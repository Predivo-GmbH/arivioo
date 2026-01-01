import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Shield, Lock, Mail, AlertCircle, Eye, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useAdminAuth } from '@/hooks/useAdminAuth';

export default function AdminLogin() {
  const navigate = useNavigate();
  const { login, isAuthenticated, isLoading, ping } = useAdminAuth();
  
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [debugOpen, setDebugOpen] = useState(false);
  const [pingResult, setPingResult] = useState<null | {
    ok: boolean;
    error?: string;
    requestId?: string;
    originSeen?: string | null;
    ts?: string;
    url?: string;
  }>(null);

  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      navigate('/admin');
    }
  }, [isAuthenticated, isLoading, navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsSubmitting(true);

    // Proof-mode: ping first so we can surface URL + requestId and avoid the generic “Failed to send…”
    const pingInfo = await ping();
    setPingResult({
      ok: pingInfo.ok,
      error: pingInfo.error,
      requestId: pingInfo.requestId,
      originSeen: pingInfo.originSeen,
      ts: pingInfo.ts,
      url: pingInfo.debug?.url,
    });

    if (!pingInfo.ok) {
      setDebugOpen(true);
      setError(pingInfo.error || 'Admin auth ping failed (no HTTP response or blocked)');
      setIsSubmitting(false);
      return;
    }

    const result = await login(email, password);

    if (result.success) {
      navigate('/admin');
    } else {
      setError(result.error || 'Invalid credentials');
      // If login failed, keep debug visible so you can capture requestId/url from ping.
      setDebugOpen(true);
    }

    setIsSubmitting(false);
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-warm p-4">
      <Card className="w-full max-w-md shadow-large">
        <CardHeader className="text-center">
          <div className="mx-auto w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mb-4">
            <Shield className="w-6 h-6 text-primary" />
          </div>
          <CardTitle className="text-2xl font-bold">Admin Access</CardTitle>
          <CardDescription>
            Enter your credentials to access the admin dashboard
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="email"
                  type="email"
                  placeholder="admin@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="pl-10"
                  required
                  autoComplete="email"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  placeholder="••••••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="pl-10 pr-10"
                  required
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? (
                <>
                  <span className="animate-spin mr-2">⏳</span>
                  Signing in...
                </>
              ) : (
                'Sign In'
              )}
            </Button>
          </form>

          <div className="mt-6">
            <button
              type="button"
              className="w-full text-xs text-muted-foreground hover:text-foreground underline underline-offset-4"
              onClick={() => setDebugOpen((v) => !v)}
            >
              {debugOpen ? 'Hide connection debug' : 'Show connection debug'}
            </button>

            {debugOpen && (
              <div className="mt-3 rounded-md border bg-background/60 p-3 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-medium">Admin auth diagnostics</span>
                  <span className="text-muted-foreground">(safe to screenshot)</span>
                </div>

                <div className="mt-2 space-y-2">
                  <div>
                    <div className="text-muted-foreground">Expected ping URL</div>
                    <code className="break-all">{pingResult?.url || `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/admin-auth/ping`}</code>
                  </div>

                  <div>
                    <div className="text-muted-foreground">Ping status</div>
                    <div>{pingResult ? (pingResult.ok ? 'OK (HTTP response received)' : 'FAILED (no response or blocked)') : 'Not run yet'}</div>
                  </div>

                  {pingResult?.requestId && (
                    <div>
                      <div className="text-muted-foreground">Ping request_id</div>
                      <code>{pingResult.requestId}</code>
                    </div>
                  )}

                  {pingResult?.originSeen !== undefined && (
                    <div>
                      <div className="text-muted-foreground">Origin seen by backend</div>
                      <code className="break-all">{String(pingResult.originSeen)}</code>
                    </div>
                  )}

                  {pingResult?.error && (
                    <div>
                      <div className="text-muted-foreground">Ping error</div>
                      <code className="break-all">{pingResult.error}</code>
                    </div>
                  )}

                  <p className="text-muted-foreground">
                    If ping is OK but login still fails, grab your DevTools Network entry for <code>/admin-auth/login</code> and the ping request_id above.
                  </p>
                </div>
              </div>
            )}
          </div>

          <p className="text-xs text-muted-foreground text-center mt-6">
            Protected area. Unauthorized access is prohibited.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
