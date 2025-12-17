import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Simple in-memory rate limiting (resets on function cold start)
// For production, use Redis or database-backed rate limiting
const rateLimitMap = new Map<string, { attempts: number; lastAttempt: number; lockedUntil: number }>();

const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour window
const MAX_ATTEMPTS = 5; // 5 attempts per hour per IP
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minute lockout after exceeding limit

function getClientIP(req: Request): string {
  // Check common headers for client IP
  const forwardedFor = req.headers.get('x-forwarded-for');
  if (forwardedFor) {
    return forwardedFor.split(',')[0].trim();
  }
  const realIP = req.headers.get('x-real-ip');
  if (realIP) {
    return realIP;
  }
  // Fallback to connection info if available
  return 'unknown';
}

function checkRateLimit(ip: string): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  const record = rateLimitMap.get(ip);
  
  if (!record) {
    rateLimitMap.set(ip, { attempts: 1, lastAttempt: now, lockedUntil: 0 });
    return { allowed: true };
  }
  
  // Check if currently locked out
  if (record.lockedUntil > now) {
    return { allowed: false, retryAfter: Math.ceil((record.lockedUntil - now) / 1000) };
  }
  
  // Reset counter if window has passed
  if (now - record.lastAttempt > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, { attempts: 1, lastAttempt: now, lockedUntil: 0 });
    return { allowed: true };
  }
  
  // Check if exceeded attempts
  if (record.attempts >= MAX_ATTEMPTS) {
    record.lockedUntil = now + LOCKOUT_DURATION_MS;
    rateLimitMap.set(ip, record);
    return { allowed: false, retryAfter: Math.ceil(LOCKOUT_DURATION_MS / 1000) };
  }
  
  // Increment attempts
  record.attempts++;
  record.lastAttempt = now;
  rateLimitMap.set(ip, record);
  return { allowed: true };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const clientIP = getClientIP(req);
  
  // Check rate limit before processing
  const rateCheck = checkRateLimit(clientIP);
  if (!rateCheck.allowed) {
    console.warn(`Rate limit exceeded for IP: ${clientIP}`);
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
    const { password } = await req.json();
    
    if (!password || typeof password !== 'string') {
      console.warn(`Invalid password format from IP: ${clientIP}`);
      return new Response(
        JSON.stringify({ valid: false, error: 'Password is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Enforce password length limits to prevent DOS via large payloads
    if (password.length > 100) {
      console.warn(`Password too long from IP: ${clientIP}`);
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
    
    // Log all attempts with IP (but not the password itself)
    console.log(`Bypass password verification from IP ${clientIP}: ${isValid ? 'SUCCESS' : 'FAILED'}`);

    return new Response(
      JSON.stringify({ valid: isValid }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in verify-bypass-password:', error);
    return new Response(
      JSON.stringify({ valid: false, error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

// Timing-safe string comparison to prevent timing attacks
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
