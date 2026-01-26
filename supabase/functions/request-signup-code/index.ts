import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { Resend } from "https://esm.sh/resend@4.0.0";

const resend = new Resend(Deno.env.get("RESEND_API_KEY") as string);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface RequestBody {
  email: string;
}

// Generate a 6-digit code
function generateCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  try {
    const { email }: RequestBody = await req.json();

    // Validate email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || typeof email !== "string" || !emailRegex.test(email)) {
      return new Response(JSON.stringify({ error: "Invalid email address" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Check if user already exists
    let page = 1;
    const perPage = 1000;
    let userExists = false;
    
    while (true) {
      const { data: usersData, error: listError } = await supabase.auth.admin.listUsers({
        page,
        perPage,
      });
      
      if (listError || !usersData?.users?.length) break;
      
      if (usersData.users.some(u => u.email?.toLowerCase() === email.toLowerCase())) {
        userExists = true;
        break;
      }
      
      if (usersData.users.length < perPage) break;
      page++;
    }

    if (userExists) {
      return new Response(JSON.stringify({ error: "An account with this email already exists. Please sign in instead." }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Check rate limiting - max 3 codes per email per hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count } = await supabase
      .from("signup_verification_codes")
      .select("*", { count: "exact", head: true })
      .eq("email", email.toLowerCase())
      .gte("created_at", oneHourAgo);

    if (count && count >= 3) {
      return new Response(JSON.stringify({ error: "Too many signup requests. Please try again later." }), {
        status: 429,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Invalidate any existing unused codes for this email
    await supabase
      .from("signup_verification_codes")
      .update({ used: true })
      .eq("email", email.toLowerCase())
      .eq("used", false);

    // Generate new code with 15-minute expiry
    const code = generateCode();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    const { error: insertError } = await supabase
      .from("signup_verification_codes")
      .insert({
        email: email.toLowerCase(),
        code,
        expires_at: expiresAt,
      });

    if (insertError) {
      console.error("[SIGNUP-CODE] Insert error:", insertError);
      throw new Error("Failed to create verification code");
    }

    // Send email with the code
    const { error: emailError } = await resend.emails.send({
      from: "Arivioo <noreply@updates.arivioo.com>",
      replyTo: "support@arivioo.com",
      to: [email],
      subject: "Verify your email to create your account",
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #ffffff;">
          <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 600px; margin: 0 auto;">
            <tr>
              <td style="text-align: center; padding: 20px 0;">
                <span style="font-size: 24px; font-weight: bold; color: #1a1a1a;">Arivioo</span>
              </td>
            </tr>
            <tr>
              <td style="padding: 20px 0;">
                <p style="margin: 0 0 16px 0;">Welcome! 👋</p>
                <p style="margin: 0 0 24px 0;">Use this code to verify your email and create your account:</p>
                <div style="text-align: center; margin: 32px 0;">
                  <div style="display: inline-block; background-color: #f4f4f5; border-radius: 12px; padding: 20px 40px; letter-spacing: 8px; font-size: 32px; font-weight: bold; color: #1a1a1a; font-family: monospace;">
                    ${code}
                  </div>
                </div>
                <p style="margin: 24px 0 0 0; font-size: 14px; color: #666; text-align: center;">
                  This code expires in <strong>15 minutes</strong>.
                </p>
                <p style="margin: 16px 0 0 0; font-size: 13px; color: #888; text-align: center;">
                  If you did not request this, please ignore this email.
                </p>
              </td>
            </tr>
            <tr>
              <td style="border-top: 1px solid #eee; padding-top: 20px; text-align: center;">
                <p style="margin: 0; font-size: 12px; color: #999;">
                  Arivioo · Find better prices for your vacation rentals
                </p>
              </td>
            </tr>
          </table>
        </body>
        </html>
      `,
      headers: {
        "X-Entity-Ref-ID": `signup-verify-${Date.now()}`,
      },
    });

    if (emailError) {
      console.error("[SIGNUP-CODE] Email error:", emailError);
      throw new Error("Failed to send verification email");
    }

    console.log(`[SIGNUP-CODE] Code sent to ${email.slice(0, 3)}***`);

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (error: any) {
    console.error("[SIGNUP-CODE] Error:", error);
    return new Response(JSON.stringify({ error: error.message || "Failed to process request" }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
});
