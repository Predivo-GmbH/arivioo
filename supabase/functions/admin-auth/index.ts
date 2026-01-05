import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Allowed origins for CORS - restrict to Lovable app domains
const ALLOWED_ORIGINS = [
  'https://lovable.dev',
  'https://www.lovable.dev',
  /^https:\/\/[a-zA-Z0-9-]+\.lovable\.app$/,  // Any Lovable app subdomain
  /^https:\/\/[a-zA-Z0-9-]+\.lovableproject\.com$/,  // Any Lovable project subdomain
  /^https:\/\/id-preview--[a-zA-Z0-9-]+\.lovable\.app$/,  // Preview domains
  'https://arivioo.lovable.app',  // Production (Lovable-hosted)
  'https://arivioo.com',          // Production custom domain
  'https://www.arivioo.com',      // Production custom domain (www)
];

function isOriginAllowed(origin: string | null): boolean {
  if (!origin) return false;
  return ALLOWED_ORIGINS.some(allowed => {
    if (typeof allowed === 'string') {
      return origin === allowed;
    }
    return allowed.test(origin);
  });
}

function getCorsHeaders(request: Request): Record<string, string> {
  const requestOrigin = request.headers.get('origin');
  // Always echo request origin so browsers can actually receive the response.
  // We still enforce the allowlist with an explicit 403 for disallowed origins.
  const origin = requestOrigin ?? '*';

  // Reflect requested headers for preflight when provided.
  // This avoids subtle mismatches where the browser requests (apikey, x-client-info, etc.).
  const requestedHeaders = request.headers.get('access-control-request-headers');

  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': requestedHeaders || 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin, Access-Control-Request-Headers',
  };
}

// Persistent rate limiting configuration
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 30 * 60 * 1000; // 30 minutes

// Dummy hash for constant-time authentication (PBKDF2 with 100,000 iterations)
// This ensures password verification always runs with the same iteration count
// whether or not the user exists, preventing timing-based user enumeration
const DUMMY_HASH = 'pbkdf2:00000000-0000-0000-0000-000000000000:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

// Simple timing-safe comparison for strings
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still do comparison to maintain constant time
    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ (b.charCodeAt(i % b.length) || 0);
    }
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// Validate password complexity for admin accounts
// Requires: 12+ chars, uppercase, lowercase, number, special character
function validatePasswordComplexity(password: string): { valid: boolean; error?: string } {
  if (password.length < 12) {
    return { valid: false, error: 'Password must be at least 12 characters' };
  }
  
  if (password.length > 128) {
    return { valid: false, error: 'Password must be at most 128 characters' };
  }
  
  if (!/[a-z]/.test(password)) {
    return { valid: false, error: 'Password must contain at least one lowercase letter' };
  }
  
  if (!/[A-Z]/.test(password)) {
    return { valid: false, error: 'Password must contain at least one uppercase letter' };
  }
  
  if (!/[0-9]/.test(password)) {
    return { valid: false, error: 'Password must contain at least one number' };
  }
  
  if (!/[^a-zA-Z0-9]/.test(password)) {
    return { valid: false, error: 'Password must contain at least one special character (!@#$%^&*...)' };
  }
  
  // Check for common weak patterns
  const weakPatterns = [
    /^(.)\1+$/, // All same character (aaaaaaaaaa)
    /^(012|123|234|345|456|567|678|789|890)+/, // Sequential numbers
    /^(abc|bcd|cde|def|efg|fgh|ghi|hij|ijk|jkl|klm|lmn|mno|nop|opq|pqr|qrs|rst|stu|tuv|uvw|vwx|wxy|xyz)+/i, // Sequential letters
  ];
  
  for (const pattern of weakPatterns) {
    if (pattern.test(password)) {
      return { valid: false, error: 'Password contains weak patterns. Please use a more complex password.' };
    }
  }
  
  return { valid: true };
}

// Simple bcrypt verification using Web Crypto (simplified for edge function)
// In production, you'd want to use a proper bcrypt library
async function verifyPassword(password: string, hash: string): Promise<boolean> {
  // For edge functions, we'll use a simpler approach with PBKDF2
  // The seeded admin uses a placeholder hash - we need to implement proper verification
  // Using a simplified check for now - in production use proper bcrypt
  
  // Check if it's our seeded admin with temporary password
  if (hash === '$2a$10$rQnMRLBY.7JDjYC5FMnGWO5qgzd/x5OxBsXKqD.PMTGhXZR5.XVXW') {
    // This is the placeholder hash - only accept if password is the temp password
    return password === 'AdminTemp123!';
  }
  
  // For new passwords, we store them as base64(PBKDF2(password, salt))
  // Format: pbkdf2:salt:hash
  if (hash.startsWith('pbkdf2:')) {
    const parts = hash.split(':');
    if (parts.length !== 3) return false;
    const salt = parts[1];
    const storedHash = parts[2];
    
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      encoder.encode(password),
      'PBKDF2',
      false,
      ['deriveBits']
    );
    
    const derivedBits = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: encoder.encode(salt),
        iterations: 100000,
        hash: 'SHA-256',
      },
      keyMaterial,
      256
    );
    
    const hashArray = Array.from(new Uint8Array(derivedBits));
    const computedHash = btoa(String.fromCharCode(...hashArray));
    
    return timingSafeEqual(computedHash, storedHash);
  }
  
  return false;
}

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomUUID();
  const encoder = new TextEncoder();
  
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: encoder.encode(salt),
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );
  
  const hashArray = Array.from(new Uint8Array(derivedBits));
  const hash = btoa(String.fromCharCode(...hashArray));
  
  return `pbkdf2:${salt}:${hash}`;
}

function generateSessionToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Persistent rate limiting using database
async function checkRateLimitPersistent(
  supabase: SupabaseClient,
  ip: string
): Promise<{ allowed: boolean; retryAfter?: number }> {
  const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();
  
  try {
    // Count recent failed attempts from this IP
    const { count, error } = await supabase
      .from('admin_login_attempts')
      .select('*', { count: 'exact', head: true })
      .eq('ip_address', ip)
      .eq('was_successful', false)
      .gte('attempted_at', windowStart);
    
    if (error) {
      console.error('[Admin Auth] Rate limit check error:', error);
      // Fail open but log the issue - don't block legitimate users due to DB issues
      return { allowed: true };
    }
    
    const attemptCount = count || 0;
    
    if (attemptCount >= MAX_ATTEMPTS) {
      // Check when the oldest attempt in window was made to calculate retry time
      const { data: oldestAttempt } = await supabase
        .from('admin_login_attempts')
        .select('attempted_at')
        .eq('ip_address', ip)
        .eq('was_successful', false)
        .gte('attempted_at', windowStart)
        .order('attempted_at', { ascending: true })
        .limit(1)
        .single();
      
      if (oldestAttempt && oldestAttempt.attempted_at) {
        const oldestTime = new Date(oldestAttempt.attempted_at).getTime();
        const unlockTime = oldestTime + LOCKOUT_DURATION_MS;
        const retryAfter = Math.max(0, Math.ceil((unlockTime - Date.now()) / 1000));
        return { allowed: false, retryAfter: Math.max(retryAfter, 60) }; // Minimum 60 seconds
      }
      
      return { allowed: false, retryAfter: Math.ceil(LOCKOUT_DURATION_MS / 1000) };
    }
    
    return { allowed: true };
  } catch (err) {
    console.error('[Admin Auth] Rate limit check exception:', err);
    // Fail open on unexpected errors
    return { allowed: true };
  }
}

// Log login attempt to database for persistent tracking
async function logLoginAttempt(
  supabase: SupabaseClient,
  ip: string,
  wasSuccessful: boolean,
  emailAttempted: string | null,
  userAgent: string | null
): Promise<void> {
  try {
    const { error } = await supabase
      .from('admin_login_attempts')
      .insert({
        ip_address: ip,
        was_successful: wasSuccessful,
        email_attempted: emailAttempted?.toLowerCase().substring(0, 255) || null,
        user_agent: userAgent?.substring(0, 500) || null,
        attempted_at: new Date().toISOString()
      });
    
    if (error) {
      console.error('[Admin Auth] Failed to log login attempt:', error);
    }
  } catch (err) {
    console.error('[Admin Auth] Exception logging login attempt:', err);
  }
}

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID();
  const origin = req.headers.get('origin');
  const host = req.headers.get('host');
  const corsHeaders = getCorsHeaders(req);
  // Ensure every response includes an ID we can correlate in logs
  corsHeaders['X-Request-Id'] = requestId;

  const url = new URL(req.url);
  const path = url.pathname;

  console.log(JSON.stringify({
    request_id: requestId,
    ts: new Date().toISOString(),
    method: req.method,
    origin,
    host,
    path,
    is_preflight: req.method === 'OPTIONS',
  }));

  // Enforce allowlist for browser requests (origin-present).
  if (origin && !isOriginAllowed(origin)) {
    console.log(JSON.stringify({ request_id: requestId, msg: 'Origin not allowed', origin }));
    return new Response(JSON.stringify({ error: 'Origin not allowed', requestId }), {
      status: 403,
      headers: { ...corsHeaders, 'Content-Type': 'application/json', 'X-Request-Id': requestId },
    });
  }

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...corsHeaders, 'X-Request-Id': requestId } });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const action = path.split('/').pop();
  const ip = req.headers.get('x-forwarded-for') || req.headers.get('cf-connecting-ip') || 'unknown';
  const userAgent = req.headers.get('user-agent') || 'unknown';

  // PING (proof-mode endpoint)
  // GET /admin-auth/ping → 200 JSON with requestId for correlation
  if (action === 'ping' && req.method === 'GET') {
    return new Response(
      JSON.stringify({ ok: true, ts: new Date().toISOString(), requestId, originSeen: origin ?? null }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  try {
    // LOGIN
    if (action === 'login' && req.method === 'POST') {
      // Check persistent rate limit
      const rateCheck = await checkRateLimitPersistent(supabase, ip);
      if (!rateCheck.allowed) {
        console.log(`[Admin Auth] Persistent rate limited: ${ip}`);
        return new Response(
          JSON.stringify({ error: 'Too many login attempts. Please try again later.', retryAfter: rateCheck.retryAfter }),
          { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Retry-After': String(rateCheck.retryAfter) } }
        );
      }

      const { email, password } = await req.json();
      
      if (!email || !password) {
        return new Response(
          JSON.stringify({ error: 'Email and password are required' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      console.log(`[Admin Auth] Login attempt from IP: ${ip}`);

      // Get admin user
      const { data: admin, error: adminError } = await supabase
        .from('admin_users')
        .select('*')
        .eq('email', email.toLowerCase())
        .single();

      // CONSTANT-TIME AUTHENTICATION: Always perform password verification
      // to prevent timing-based user enumeration attacks.
      // If user doesn't exist, we verify against a dummy hash with the same
      // iteration count, ensuring consistent timing regardless of user existence.
      const hashToVerify = admin?.password_hash || DUMMY_HASH;
      const passwordValid = await verifyPassword(password, hashToVerify);

      // Now check user existence and password validity AFTER timing-critical operation
      if (adminError || !admin || !passwordValid) {
        // Log failed attempt (don't reveal whether user exists or password was wrong)
        await logLoginAttempt(supabase, ip, false, email, userAgent);
        console.log(`[Admin Auth] Login failed from IP: ${ip}`);
        
        // If admin exists and password was wrong, increment failed attempts
        if (admin && !passwordValid) {
          const newAttempts = admin.failed_login_attempts + 1;
          const lockUntil = newAttempts >= 5 ? new Date(Date.now() + 30 * 60 * 1000).toISOString() : null;
          
          await supabase
            .from('admin_users')
            .update({ 
              failed_login_attempts: newAttempts,
              locked_until: lockUntil
            })
            .eq('id', admin.id);
        }

        // Add random jitter (50-150ms) to further mask any timing variations
        const jitter = 50 + Math.random() * 100;
        await new Promise(resolve => setTimeout(resolve, jitter));
        
        return new Response(
          JSON.stringify({ error: 'Invalid credentials' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Check if account is locked (after password verification to maintain constant time)
      if (admin.locked_until && new Date(admin.locked_until) > new Date()) {
        await logLoginAttempt(supabase, ip, false, email, userAgent);
        console.log(`[Admin Auth] Account locked, attempt from IP: ${ip}`);
        return new Response(
          JSON.stringify({ error: 'Invalid credentials' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Check if account is active (after password verification to maintain constant time)
      if (!admin.is_active) {
        await logLoginAttempt(supabase, ip, false, email, userAgent);
        console.log(`[Admin Auth] Account inactive, attempt from IP: ${ip}`);
        return new Response(
          JSON.stringify({ error: 'Invalid credentials' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Reset failed attempts on successful login
      await supabase
        .from('admin_users')
        .update({ 
          failed_login_attempts: 0,
          locked_until: null,
          last_login_at: new Date().toISOString()
        })
        .eq('id', admin.id);

      // Log successful login attempt
      await logLoginAttempt(supabase, ip, true, email, userAgent);

      // Create session
      const sessionToken = generateSessionToken();
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

      const { error: sessionError } = await supabase
        .from('admin_sessions')
        .insert({
          admin_user_id: admin.id,
          session_token: sessionToken,
          expires_at: expiresAt.toISOString(),
          ip_address: ip,
          user_agent: userAgent
        });

      if (sessionError) {
        console.error('[Admin Auth] Session creation error:', sessionError);
        return new Response(
          JSON.stringify({ error: 'Failed to create session' }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Audit log
      await supabase.from('admin_audit_logs').insert({
        admin_user_id: admin.id,
        admin_email: admin.email,
        action: 'login',
        resource_type: 'session',
        ip_address: ip,
        user_agent: userAgent
      });

      console.log(`[Admin Auth] Login successful from IP: ${ip}`);

      return new Response(
        JSON.stringify({
          success: true,
          token: sessionToken,
          expiresAt: expiresAt.toISOString(),
          admin: {
            id: admin.id,
            email: admin.email,
            role: admin.role,
            fullName: admin.full_name,
            twoFactorEnabled: admin.two_factor_enabled
          }
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // VERIFY SESSION
    if (action === 'verify' && req.method === 'POST') {
      const authHeader = req.headers.get('authorization');
      const token = authHeader?.replace('Bearer ', '');

      if (!token) {
        return new Response(
          JSON.stringify({ valid: false, error: 'No token provided' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const { data: session, error: sessionError } = await supabase
        .from('admin_sessions')
        .select('*, admin_users(*)')
        .eq('session_token', token)
        .gt('expires_at', new Date().toISOString())
        .single();

      if (sessionError || !session) {
        return new Response(
          JSON.stringify({ valid: false, error: 'Invalid or expired session' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const admin = session.admin_users;
      if (!admin.is_active) {
        return new Response(
          JSON.stringify({ valid: false, error: 'Account is disabled' }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      return new Response(
        JSON.stringify({
          valid: true,
          admin: {
            id: admin.id,
            email: admin.email,
            role: admin.role,
            fullName: admin.full_name,
            twoFactorEnabled: admin.two_factor_enabled
          }
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // LOGOUT
    if (action === 'logout' && req.method === 'POST') {
      const authHeader = req.headers.get('authorization');
      const token = authHeader?.replace('Bearer ', '');

      if (token) {
        // Get session for audit log
        const { data: session } = await supabase
          .from('admin_sessions')
          .select('admin_user_id, admin_users!inner(email)')
          .eq('session_token', token)
          .single();

        // Delete session
        await supabase
          .from('admin_sessions')
          .delete()
          .eq('session_token', token);

        // Audit log
        if (session) {
          const adminEmail = (session.admin_users as any)?.email || 'unknown';
          await supabase.from('admin_audit_logs').insert({
            admin_user_id: session.admin_user_id,
            admin_email: adminEmail,
            action: 'logout',
            resource_type: 'session',
            ip_address: ip,
            user_agent: userAgent
          });
        }
      }

      return new Response(
        JSON.stringify({ success: true }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // CHANGE PASSWORD
    if (action === 'change-password' && req.method === 'POST') {
      const authHeader = req.headers.get('authorization');
      const token = authHeader?.replace('Bearer ', '');

      if (!token) {
        return new Response(
          JSON.stringify({ error: 'Authentication required' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const { data: session } = await supabase
        .from('admin_sessions')
        .select('admin_user_id, admin_users!inner(*)')
        .eq('session_token', token)
        .gt('expires_at', new Date().toISOString())
        .single();

      if (!session) {
        return new Response(
          JSON.stringify({ error: 'Invalid or expired session' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const admin = session.admin_users as any;
      const { currentPassword, newPassword } = await req.json();

      if (!currentPassword || !newPassword) {
        return new Response(
          JSON.stringify({ error: 'Current and new password are required' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Validate password complexity for admin accounts
      const passwordValidation = validatePasswordComplexity(newPassword);
      if (!passwordValidation.valid) {
        return new Response(
          JSON.stringify({ error: passwordValidation.error }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const currentValid = await verifyPassword(currentPassword, admin.password_hash);

      if (!currentValid) {
        return new Response(
          JSON.stringify({ error: 'Current password is incorrect' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const newHash = await hashPassword(newPassword);

      await supabase
        .from('admin_users')
        .update({ password_hash: newHash })
        .eq('id', admin.id);

      // Invalidate all other sessions
      await supabase
        .from('admin_sessions')
        .delete()
        .eq('admin_user_id', admin.id)
        .neq('session_token', token);

      // Audit log
      await supabase.from('admin_audit_logs').insert({
        admin_user_id: admin.id,
        admin_email: admin.email,
        action: 'change_password',
        resource_type: 'admin_user',
        resource_id: admin.id,
        ip_address: ip,
        user_agent: userAgent
      });

      console.log(`[Admin Auth] Password changed from IP: ${ip}`);

      return new Response(
        JSON.stringify({ success: true }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ error: 'Not found' }),
      { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[Admin Auth] Error:', error);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
