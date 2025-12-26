import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Rate limiting store (in-memory, resets on function restart)
const loginAttempts: Map<string, { count: number; firstAttempt: number }> = new Map();
const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 5;
const LOCKOUT_DURATION = 30 * 60 * 1000; // 30 minutes

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

function checkRateLimit(ip: string): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  const attempt = loginAttempts.get(ip);
  
  if (!attempt) {
    loginAttempts.set(ip, { count: 1, firstAttempt: now });
    return { allowed: true };
  }
  
  // Reset if window has passed
  if (now - attempt.firstAttempt > RATE_LIMIT_WINDOW) {
    loginAttempts.set(ip, { count: 1, firstAttempt: now });
    return { allowed: true };
  }
  
  // Check if locked out
  if (attempt.count >= MAX_ATTEMPTS) {
    const lockoutEnd = attempt.firstAttempt + LOCKOUT_DURATION;
    if (now < lockoutEnd) {
      return { allowed: false, retryAfter: Math.ceil((lockoutEnd - now) / 1000) };
    }
    // Lockout expired, reset
    loginAttempts.set(ip, { count: 1, firstAttempt: now });
    return { allowed: true };
  }
  
  attempt.count++;
  return { allowed: true };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const url = new URL(req.url);
  const action = url.pathname.split('/').pop();
  const ip = req.headers.get('x-forwarded-for') || req.headers.get('cf-connecting-ip') || 'unknown';
  const userAgent = req.headers.get('user-agent') || 'unknown';

  try {
    // LOGIN
    if (action === 'login' && req.method === 'POST') {
      const rateCheck = checkRateLimit(ip);
      if (!rateCheck.allowed) {
        console.log(`[Admin Auth] Rate limited: ${ip}`);
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

      console.log(`[Admin Auth] Login attempt for: ${email}`);

      // Get admin user
      const { data: admin, error: adminError } = await supabase
        .from('admin_users')
        .select('*')
        .eq('email', email.toLowerCase())
        .single();

      if (adminError || !admin) {
        console.log(`[Admin Auth] Admin not found: ${email}`);
        return new Response(
          JSON.stringify({ error: 'Invalid credentials' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Check if account is locked
      if (admin.locked_until && new Date(admin.locked_until) > new Date()) {
        console.log(`[Admin Auth] Account locked: ${email}`);
        return new Response(
          JSON.stringify({ error: 'Account is locked. Please try again later.' }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Check if account is active
      if (!admin.is_active) {
        console.log(`[Admin Auth] Account inactive: ${email}`);
        return new Response(
          JSON.stringify({ error: 'Account is disabled' }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Verify password
      const passwordValid = await verifyPassword(password, admin.password_hash);
      
      if (!passwordValid) {
        console.log(`[Admin Auth] Invalid password for: ${email}`);
        
        // Increment failed attempts
        const newAttempts = admin.failed_login_attempts + 1;
        const lockUntil = newAttempts >= 5 ? new Date(Date.now() + 30 * 60 * 1000).toISOString() : null;
        
        await supabase
          .from('admin_users')
          .update({ 
            failed_login_attempts: newAttempts,
            locked_until: lockUntil
          })
          .eq('id', admin.id);

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

      // Clear rate limit on successful login
      loginAttempts.delete(ip);

      console.log(`[Admin Auth] Login successful: ${email}`);

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

      if (newPassword.length < 12) {
        return new Response(
          JSON.stringify({ error: 'New password must be at least 12 characters' }),
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

      console.log(`[Admin Auth] Password changed for: ${admin.email}`);

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
