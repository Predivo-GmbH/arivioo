import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// Secure CORS - Domain allowlist
const ALLOWED_ORIGINS = [
  'https://lovable.dev',
  'https://www.lovable.dev',
  /^https:\/\/[a-zA-Z0-9-]+\.lovable\.app$/,
  /^https:\/\/[a-zA-Z0-9-]+\.lovableproject\.com$/,
  /^https:\/\/id-preview--[a-zA-Z0-9-]+\.lovable\.app$/,
  'https://arivioo.lovable.app',
  'https://arivioo.com',
  'https://www.arivioo.com',
];

function isOriginAllowed(origin: string | null): boolean {
  if (!origin) return false;
  return ALLOWED_ORIGINS.some(allowed => {
    if (typeof allowed === 'string') return origin === allowed;
    return allowed.test(origin);
  });
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Rate limiting configuration
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour window
const MAX_ATTEMPTS = 5; // 5 attempts per hour per IP
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minute lockout after exceeding limit
const ACCESS_GRANT_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours access grant

function getClientIP(req: Request): string {
  const forwardedFor = req.headers.get('x-forwarded-for');
  if (forwardedFor) {
    return forwardedFor.split(',')[0].trim();
  }
  const realIP = req.headers.get('x-real-ip');
  if (realIP) {
    return realIP;
  }
  return 'unknown';
}

// Timing-safe string comparison to prevent timing attacks
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
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
      .from('bypass_password_attempts')
      .select('*', { count: 'exact', head: true })
      .eq('ip_address', ip)
      .eq('was_successful', false)
      .gte('attempted_at', windowStart);
    
    if (error) {
      console.error('Rate limit check error:', error);
      // Fail open but log the issue - don't block legitimate users due to DB issues
      return { allowed: true };
    }
    
    const attemptCount = count || 0;
    
    if (attemptCount >= MAX_ATTEMPTS) {
      // Check when the oldest attempt in window was made to calculate retry time
      const { data: oldestAttempt } = await supabase
        .from('bypass_password_attempts')
        .select('attempted_at')
        .eq('ip_address', ip)
        .eq('was_successful', false)
        .gte('attempted_at', windowStart)
        .order('attempted_at', { ascending: true })
        .limit(1)
        .single();
      
      if (oldestAttempt && oldestAttempt.attempted_at) {
        const oldestTime = new Date(oldestAttempt.attempted_at).getTime();
        const unlockTime = oldestTime + RATE_LIMIT_WINDOW_MS;
        const retryAfter = Math.max(0, Math.ceil((unlockTime - Date.now()) / 1000));
        return { allowed: false, retryAfter: Math.max(retryAfter, 60) }; // Minimum 60 seconds
      }
      
      return { allowed: false, retryAfter: Math.ceil(LOCKOUT_DURATION_MS / 1000) };
    }
    
    return { allowed: true };
  } catch (err) {
    console.error('Rate limit check exception:', err);
    // Fail open on unexpected errors
    return { allowed: true };
  }
}

// Log attempt to database for persistent tracking
async function logAttempt(
  supabase: SupabaseClient,
  ip: string,
  wasSuccessful: boolean,
  userAgent: string | null
): Promise<void> {
  try {
    const { error } = await supabase
      .from('bypass_password_attempts')
      .insert({
        ip_address: ip,
        was_successful: wasSuccessful,
        user_agent: userAgent?.substring(0, 500) || null, // Limit user agent length
        attempted_at: new Date().toISOString()
      });
    
    if (error) {
      console.error('Failed to log bypass attempt:', error);
    }
  } catch (err) {
    console.error('Exception logging bypass attempt:', err);
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const clientIP = getClientIP(req);
  const userAgent = req.headers.get('user-agent');
  
  // Initialize Supabase client with service role for rate limiting
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  
  if (!supabaseUrl || !supabaseServiceKey) {
    console.error('Missing Supabase configuration');
    return new Response(
      JSON.stringify({ valid: false, error: 'Service not configured' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
  
  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  
  // Check persistent rate limit
  const rateCheck = await checkRateLimitPersistent(supabase, clientIP);
  if (!rateCheck.allowed) {
    console.warn(`Persistent rate limit exceeded for IP: ${clientIP}`);
    return new Response(
      JSON.stringify({ 
        valid: false, 
        error: 'Too many attempts. Please try again later.',
        retryAfter: rateCheck.retryAfter 
      }),
      { 
        status: 429, 
        headers: { 
          ...corsHeaders, 
          'Content-Type': 'application/json',
          'Retry-After': String(rateCheck.retryAfter || 900)
        } 
      }
    );
  }

  try {
    const { password, userId } = await req.json();
    
    if (!password || typeof password !== 'string') {
      console.warn(`Invalid password format from IP: ${clientIP}`);
      // Log failed attempt
      await logAttempt(supabase, clientIP, false, userAgent);
      return new Response(
        JSON.stringify({ valid: false, error: 'Password is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Enforce password length limits to prevent DOS via large payloads
    if (password.length > 100) {
      console.warn(`Password too long from IP: ${clientIP}`);
      await logAttempt(supabase, clientIP, false, userAgent);
      return new Response(
        JSON.stringify({ valid: false, error: 'Invalid password format' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const BYPASS_PASSWORD = Deno.env.get('BYPASS_PASSWORD');
    
    if (!BYPASS_PASSWORD) {
      console.error('BYPASS_PASSWORD secret is not configured');
      return new Response(
        JSON.stringify({ valid: false, error: 'Service not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Use timing-safe comparison to prevent timing attacks
    const isValid = password.length === BYPASS_PASSWORD.length && 
      timingSafeEqual(password, BYPASS_PASSWORD);
    
    // Log attempt to database (persistent audit trail)
    await logAttempt(supabase, clientIP, isValid, userAgent);
    
    // Log to console as well for immediate visibility
    console.log(`Bypass password verification from IP ${clientIP}: ${isValid ? 'SUCCESS' : 'FAILED'}`);

    // If valid and userId provided, create server-side access grant
    if (isValid && userId && typeof userId === 'string') {
      try {
        const grantedUntil = new Date(Date.now() + ACCESS_GRANT_DURATION_MS).toISOString();
        
        // Upsert access grant (insert or update if exists)
        const { error: grantError } = await supabase
          .from('access_grants')
          .upsert(
            { 
              user_id: userId, 
              granted_until: grantedUntil,
              updated_at: new Date().toISOString()
            },
            { onConflict: 'user_id' }
          );
        
        if (grantError) {
          console.error('Error creating access grant:', grantError);
        } else {
          console.log(`Access grant created for user ${userId} until ${grantedUntil}`);
        }
        
        return new Response(
          JSON.stringify({ valid: isValid, grantedUntil }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      } catch (grantError) {
        console.error('Error in access grant creation:', grantError);
      }
    }

    return new Response(
      JSON.stringify({ valid: isValid }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in verify-bypass-password:', error);
    // Log failed attempt for malformed requests
    await logAttempt(supabase, clientIP, false, userAgent);
    return new Response(
      JSON.stringify({ valid: false, error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
