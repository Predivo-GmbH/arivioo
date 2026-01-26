import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { Webhook } from "https://esm.sh/standardwebhooks@1.0.0";
import { Resend } from "https://esm.sh/resend@4.0.0";

const resend = new Resend(Deno.env.get("RESEND_API_KEY") as string);
const hookSecret = Deno.env.get("SEND_EMAIL_HOOK_SECRET") as string;

interface EmailPayload {
  user: {
    email: string;
    user_metadata?: {
      full_name?: string;
      name?: string;
    };
  };
  email_data: {
    token: string;
    token_hash: string;
    redirect_to: string;
    email_action_type: string;
    site_url: string;
  };
}

serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const payload = await req.text();
  const headers = Object.fromEntries(req.headers);

  try {
    const wh = new Webhook(hookSecret);
    const {
      user,
      email_data: { token, token_hash, redirect_to, email_action_type, site_url },
    } = wh.verify(payload, headers) as EmailPayload;

    const userName = user.user_metadata?.full_name || user.user_metadata?.name || "there";
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";

    let subject = "";
    let html = "";

    // Handle different email types
    switch (email_action_type) {
      case "recovery":
        subject = "Password Reset Request";
        html = `
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
                  <p style="margin: 0 0 16px 0;">Hello ${userName},</p>
                  <p style="margin: 0 0 16px 0;">You requested a password reset for your Arivioo account. Use the link below to set a new password:</p>
                  <p style="margin: 24px 0; text-align: center;">
                    <a href="${supabaseUrl}/auth/v1/verify?token=${token_hash}&type=${email_action_type}&redirect_to=${redirect_to}" 
                       style="display: inline-block; background-color: #5046e5; color: #ffffff; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-weight: 500;">
                      Reset Password
                    </a>
                  </p>
                  <p style="margin: 16px 0 0 0; font-size: 13px; color: #666;">
                    If the button doesn't work, copy this URL into your browser:<br>
                    <a href="${supabaseUrl}/auth/v1/verify?token=${token_hash}&type=${email_action_type}&redirect_to=${redirect_to}" style="color: #5046e5; word-break: break-all;">
                      ${supabaseUrl}/auth/v1/verify?token=${token_hash}&type=${email_action_type}&redirect_to=${redirect_to}
                    </a>
                  </p>
                  <p style="margin: 24px 0 0 0; font-size: 13px; color: #888;">
                    This link expires in 1 hour. If you did not request this, please ignore this email.
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
        `;
        break;

      case "signup":
      case "email_confirmation":
        subject = "Confirm Your Arivioo Account";
        html = `
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
                  <p style="margin: 0 0 16px 0;">Hello ${userName},</p>
                  <p style="margin: 0 0 16px 0;">Welcome to Arivioo! Please confirm your email address to complete your registration:</p>
                  <p style="margin: 24px 0; text-align: center;">
                    <a href="${supabaseUrl}/auth/v1/verify?token=${token_hash}&type=${email_action_type}&redirect_to=${redirect_to}" 
                       style="display: inline-block; background-color: #5046e5; color: #ffffff; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-weight: 500;">
                      Confirm Email
                    </a>
                  </p>
                  <p style="margin: 16px 0 0 0; font-size: 13px; color: #666;">
                    If the button doesn't work, copy this URL into your browser:<br>
                    <a href="${supabaseUrl}/auth/v1/verify?token=${token_hash}&type=${email_action_type}&redirect_to=${redirect_to}" style="color: #5046e5; word-break: break-all;">
                      ${supabaseUrl}/auth/v1/verify?token=${token_hash}&type=${email_action_type}&redirect_to=${redirect_to}
                    </a>
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
        `;
        break;

      case "magiclink":
        subject = "Sign In to Arivioo";
        html = `
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
                  <p style="margin: 0 0 16px 0;">Hello ${userName},</p>
                  <p style="margin: 0 0 16px 0;">Use the link below to sign in to your Arivioo account:</p>
                  <p style="margin: 24px 0; text-align: center;">
                    <a href="${supabaseUrl}/auth/v1/verify?token=${token_hash}&type=${email_action_type}&redirect_to=${redirect_to}" 
                       style="display: inline-block; background-color: #5046e5; color: #ffffff; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-weight: 500;">
                      Sign In
                    </a>
                  </p>
                  <p style="margin: 24px 0 0 0; font-size: 13px; color: #888;">
                    This link expires in 1 hour. If you did not request this, please ignore this email.
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
        `;
        break;

      default:
        console.log(`Unhandled email action type: ${email_action_type}`);
        return new Response(JSON.stringify({ error: `Unhandled email type: ${email_action_type}` }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
    }

    console.log(`Sending ${email_action_type} email to ${user.email} from noreply@updates.arivioo.com`);

    const { error } = await resend.emails.send({
      from: "Arivioo Account <noreply@updates.arivioo.com>",
      replyTo: "support@arivioo.com",
      to: [user.email],
      subject,
      html,
      headers: {
        "X-Entity-Ref-ID": `${email_action_type}-${Date.now()}`,
      },
    });

    if (error) {
      console.error("Resend error:", error);
      throw error;
    }

    console.log(`Email sent successfully to ${user.email}`);

    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error: any) {
    console.error("Error in email-hook:", error);
    return new Response(
      JSON.stringify({
        error: {
          http_code: error.code || 500,
          message: error.message || "Failed to send email",
        },
      }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
});
