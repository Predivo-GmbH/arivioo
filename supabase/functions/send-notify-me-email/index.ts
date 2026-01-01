import { Resend } from "https://esm.sh/resend@2.0.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const resend = new Resend(Deno.env.get("RESEND_API_KEY"));

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
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface NotifyMeRequest {
  email: string;
  airbnbUrl?: string;
  airbnbTitle?: string;
  airbnbPrice?: number;
}

// HTML escape function to prevent XSS in emails
function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, (m) => map[m]);
}

// Simple hash function for IP-based rate limiting
async function hashIp(ip: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(ip + Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.slice(0, 10));
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

// Rate limiting: 5 requests per hour per IP
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX_REQUESTS = 5;

async function checkRateLimit(supabase: any, ipHash: string): Promise<{ allowed: boolean; remaining: number }> {
  const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();
  
  // Count recent requests from this IP
  const { count, error } = await supabase
    .from('api_request_logs')
    .select('*', { count: 'exact', head: true })
    .eq('endpoint_type', 'notify_me_email')
    .eq('correlation_id', ipHash)
    .gte('request_timestamp', windowStart);

  if (error) {
    console.error('[RATE-LIMIT] Error checking rate limit:', error);
    // Allow on error but log it
    return { allowed: true, remaining: RATE_LIMIT_MAX_REQUESTS };
  }

  const currentCount = count || 0;
  const remaining = Math.max(0, RATE_LIMIT_MAX_REQUESTS - currentCount);
  return { allowed: currentCount < RATE_LIMIT_MAX_REQUESTS, remaining };
}

async function logRequest(supabase: any, ipHash: string, success: boolean, errorMessage?: string): Promise<void> {
  try {
    await supabase.from('api_request_logs').insert({
      provider_name: 'resend',
      endpoint_type: 'notify_me_email',
      correlation_id: ipHash,
      success,
      error_message: errorMessage,
    });
  } catch (e) {
    console.error('[LOG-REQUEST] Failed to log request:', e);
  }
}

const handler = async (req: Request): Promise<Response> => {
  // Handle CORS preflight requests
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Initialize Supabase client with service role for rate limiting
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  // Get client IP for rate limiting
  const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || 
                   req.headers.get("x-real-ip") || 
                   "unknown";
  const ipHash = await hashIp(clientIp);

  try {
    // Check rate limit first
    const { allowed, remaining } = await checkRateLimit(supabase, ipHash);
    if (!allowed) {
      console.log(`[NOTIFY-ME-EMAIL] Rate limit exceeded for IP hash: ${ipHash}`);
      await logRequest(supabase, ipHash, false, 'rate_limit_exceeded');
      return new Response(
        JSON.stringify({ error: "Too many requests. Please try again later." }),
        { 
          status: 429, 
          headers: { 
            "Content-Type": "application/json", 
            "X-RateLimit-Remaining": "0",
            ...corsHeaders 
          } 
        }
      );
    }

    const { email, airbnbUrl, airbnbTitle, airbnbPrice }: NotifyMeRequest = await req.json();

    console.log(`[NOTIFY-ME-EMAIL] Processing registration for: ${email?.slice(0, 3)}***`);

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || typeof email !== 'string' || !emailRegex.test(email) || email.length > 255) {
      await logRequest(supabase, ipHash, false, 'invalid_email');
      return new Response(
        JSON.stringify({ error: "Invalid email address" }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Validate Airbnb URL if provided
    if (airbnbUrl) {
      if (typeof airbnbUrl !== 'string' || airbnbUrl.length > 2000) {
        await logRequest(supabase, ipHash, false, 'invalid_url_length');
        return new Response(
          JSON.stringify({ error: "Invalid URL" }),
          { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }
      // Allow airbnb.com URLs (with or without www, and regional variants)
      const urlPattern = /^https:\/\/(www\.)?airbnb\.(com|co\.[a-z]{2}|[a-z]{2})\//i;
      if (!urlPattern.test(airbnbUrl)) {
        await logRequest(supabase, ipHash, false, 'invalid_airbnb_url');
        return new Response(
          JSON.stringify({ error: "Invalid Airbnb URL" }),
          { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }
    }

    // Validate title length if provided
    if (airbnbTitle && (typeof airbnbTitle !== 'string' || airbnbTitle.length > 500)) {
      await logRequest(supabase, ipHash, false, 'invalid_title');
      return new Response(
        JSON.stringify({ error: "Invalid title" }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Validate price if provided
    if (airbnbPrice !== undefined && (typeof airbnbPrice !== 'number' || airbnbPrice < 0 || airbnbPrice > 1000000)) {
      await logRequest(supabase, ipHash, false, 'invalid_price');
      return new Response(
        JSON.stringify({ error: "Invalid price" }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Escape all user inputs for HTML email to prevent XSS
    const safeEmail = escapeHtml(email);
    const safeTitle = airbnbTitle ? escapeHtml(airbnbTitle) : '';
    const safeUrl = airbnbUrl ? escapeHtml(airbnbUrl) : '';
    const safePrice = airbnbPrice ? Math.floor(airbnbPrice) : null;

    // Send notification to admin
    const adminEmailResponse = await resend.emails.send({
      from: "Arivioo <noreply@updates.arivioo.com>",
      to: ["lakeviewer1976@gmail.com"],
      subject: "🔔 New Notify Me Registration",
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; border-radius: 10px 10px 0 0; text-align: center; }
            .content { background: #f9fafb; padding: 30px; border-radius: 0 0 10px 10px; }
            .info-box { background: white; padding: 20px; border-radius: 8px; margin: 15px 0; border-left: 4px solid #667eea; }
            .label { font-weight: 600; color: #667eea; margin-bottom: 5px; }
            .value { font-size: 16px; }
            .footer { text-align: center; margin-top: 20px; color: #6b7280; font-size: 14px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1 style="margin: 0;">New Registration!</h1>
              <p style="margin: 10px 0 0 0; opacity: 0.9;">Someone wants to be notified about price drops</p>
            </div>
            <div class="content">
              <div class="info-box">
                <div class="label">Email Address</div>
                <div class="value">${safeEmail}</div>
              </div>
              ${safeTitle ? `
              <div class="info-box">
                <div class="label">Property</div>
                <div class="value">${safeTitle}</div>
              </div>
              ` : ''}
              ${safePrice ? `
              <div class="info-box">
                <div class="label">Airbnb Price</div>
                <div class="value">$${safePrice}</div>
              </div>
              ` : ''}
              ${safeUrl ? `
              <div class="info-box">
                <div class="label">Listing URL</div>
                <div class="value"><a href="${safeUrl}" style="color: #667eea;">${safeUrl.length > 60 ? safeUrl.substring(0, 60) + '...' : safeUrl}</a></div>
              </div>
              ` : ''}
              <div class="footer">
                <p>Registered at: ${new Date().toLocaleString('en-US', { timeZone: 'UTC' })} UTC</p>
              </div>
            </div>
          </div>
        </body>
        </html>
      `,
    });

    console.log("[NOTIFY-ME-EMAIL] Admin notification sent successfully");
    await logRequest(supabase, ipHash, true);

    return new Response(
      JSON.stringify({ 
        success: true,
        rateLimit: { remaining: remaining - 1 }
      }),
      { 
        status: 200, 
        headers: { 
          "Content-Type": "application/json",
          "X-RateLimit-Remaining": String(remaining - 1),
          ...corsHeaders 
        } 
      }
    );
  } catch (error: any) {
    console.error("[NOTIFY-ME-EMAIL] Error:", error);
    await logRequest(supabase, ipHash, false, error.message?.slice(0, 200));
    return new Response(
      JSON.stringify({ error: "Failed to process request" }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }
};

Deno.serve(handler);
