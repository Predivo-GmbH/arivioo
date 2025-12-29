import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// In-memory rate limiting (per instance)
const rateLimit = new Map<string, { count: number; resetTime: number }>();
const MAX_SIGNUPS_PER_HOUR = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// Email validation regex (RFC 5322 simplified)
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 255;

function hashIP(ip: string): string {
  // Simple hash for rate limiting - not cryptographic, just for bucketing
  let hash = 0;
  for (let i = 0; i < ip.length; i++) {
    const char = ip.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash.toString(16);
}

function checkRateLimit(ipHash: string): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const record = rateLimit.get(ipHash);
  
  // Clean up expired entries periodically
  if (rateLimit.size > 10000) {
    for (const [key, value] of rateLimit.entries()) {
      if (value.resetTime <= now) {
        rateLimit.delete(key);
      }
    }
  }
  
  if (!record || record.resetTime <= now) {
    // New window
    return { allowed: true, remaining: MAX_SIGNUPS_PER_HOUR - 1 };
  }
  
  if (record.count >= MAX_SIGNUPS_PER_HOUR) {
    return { allowed: false, remaining: 0 };
  }
  
  return { allowed: true, remaining: MAX_SIGNUPS_PER_HOUR - record.count - 1 };
}

function updateRateLimit(ipHash: string): void {
  const now = Date.now();
  const record = rateLimit.get(ipHash);
  
  if (!record || record.resetTime <= now) {
    rateLimit.set(ipHash, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS });
  } else {
    record.count++;
  }
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Get client IP for rate limiting
    const forwardedFor = req.headers.get('x-forwarded-for');
    const realIP = req.headers.get('x-real-ip');
    const clientIP = forwardedFor?.split(',')[0]?.trim() || realIP || 'unknown';
    const ipHash = hashIP(clientIP);

    console.log(`[submit-launch-signup] Request from IP hash: ${ipHash}`);

    // Check rate limit
    const rateLimitCheck = checkRateLimit(ipHash);
    if (!rateLimitCheck.allowed) {
      console.log(`[submit-launch-signup] Rate limit exceeded for IP hash: ${ipHash}`);
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: 'Too many signup attempts. Please try again later.' 
        }),
        { 
          status: 429, 
          headers: { 
            ...corsHeaders, 
            'Content-Type': 'application/json',
            'Retry-After': '3600'
          } 
        }
      );
    }

    // Parse and validate request body
    let body: { email?: string };
    try {
      body = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ success: false, error: 'Invalid request body' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { email } = body;

    // Validate email
    if (!email || typeof email !== 'string') {
      return new Response(
        JSON.stringify({ success: false, error: 'Email is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const trimmedEmail = email.toLowerCase().trim();

    if (trimmedEmail.length > MAX_EMAIL_LENGTH) {
      return new Response(
        JSON.stringify({ success: false, error: 'Email is too long' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!EMAIL_REGEX.test(trimmedEmail)) {
      return new Response(
        JSON.stringify({ success: false, error: 'Invalid email format' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Initialize Supabase client with service role
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Insert email
    const { error: insertError } = await supabase
      .from('launch_signups')
      .insert({ email: trimmedEmail });

    // Update rate limit after successful validation (even if duplicate)
    updateRateLimit(ipHash);

    if (insertError) {
      if (insertError.code === '23505') {
        // Duplicate email - this is fine, don't reveal if email exists
        console.log(`[submit-launch-signup] Duplicate email signup attempt`);
        return new Response(
          JSON.stringify({ success: true, message: 'already_registered' }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      
      console.error('[submit-launch-signup] Database error:', insertError);
      return new Response(
        JSON.stringify({ success: false, error: 'Failed to save signup' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[submit-launch-signup] Successfully registered email`);
    
    return new Response(
      JSON.stringify({ success: true, message: 'registered' }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[submit-launch-signup] Unexpected error:', error);
    return new Response(
      JSON.stringify({ success: false, error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
