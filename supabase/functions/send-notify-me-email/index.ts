import { Resend } from "https://esm.sh/resend@2.0.0";

const resend = new Resend(Deno.env.get("RESEND_API_KEY"));

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

const handler = async (req: Request): Promise<Response> => {
  // Handle CORS preflight requests
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { email, airbnbUrl, airbnbTitle, airbnbPrice }: NotifyMeRequest = await req.json();

    console.log(`[NOTIFY-ME-EMAIL] Processing registration for: ${email}`);

    if (!email) {
      return new Response(
        JSON.stringify({ error: "Email is required" }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Send notification to admin
    const adminEmailResponse = await resend.emails.send({
      from: "Arivioo <noreply@arivioo.com>",
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
                <div class="value">${email}</div>
              </div>
              ${airbnbTitle ? `
              <div class="info-box">
                <div class="label">Property</div>
                <div class="value">${airbnbTitle}</div>
              </div>
              ` : ''}
              ${airbnbPrice ? `
              <div class="info-box">
                <div class="label">Airbnb Price</div>
                <div class="value">$${airbnbPrice}</div>
              </div>
              ` : ''}
              ${airbnbUrl ? `
              <div class="info-box">
                <div class="label">Listing URL</div>
                <div class="value"><a href="${airbnbUrl}" style="color: #667eea;">${airbnbUrl.substring(0, 60)}...</a></div>
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

    console.log("[NOTIFY-ME-EMAIL] Admin notification sent:", adminEmailResponse);

    // Send confirmation to user
    const userEmailResponse = await resend.emails.send({
      from: "Arivioo <noreply@arivioo.com>",
      to: [email],
      subject: "You're on the list! 🎉",
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 40px; border-radius: 10px 10px 0 0; text-align: center; }
            .content { background: #f9fafb; padding: 30px; border-radius: 0 0 10px 10px; }
            .highlight { background: white; padding: 25px; border-radius: 8px; margin: 20px 0; text-align: center; }
            .footer { text-align: center; margin-top: 20px; color: #6b7280; font-size: 14px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1 style="margin: 0; font-size: 28px;">You're In!</h1>
              <p style="margin: 15px 0 0 0; opacity: 0.9; font-size: 16px;">We'll notify you when we find better prices</p>
            </div>
            <div class="content">
              <div class="highlight">
                <p style="font-size: 18px; margin: 0;">Thanks for signing up! We're scanning multiple booking platforms to find you the best deals.</p>
              </div>
              <p>Here's what happens next:</p>
              <ul>
                <li>We continuously monitor prices across Booking.com, Vrbo, and direct booking sites</li>
                <li>When we find a better price for your property, we'll email you immediately</li>
                <li>You'll get a direct link to book at the lower price</li>
              </ul>
              <div class="footer">
                <p>Happy travels! 🌍</p>
                <p style="font-size: 12px; color: #9ca3af;">The Arivioo Team</p>
              </div>
            </div>
          </div>
        </body>
        </html>
      `,
    });

    console.log("[NOTIFY-ME-EMAIL] User confirmation sent:", userEmailResponse);

    return new Response(
      JSON.stringify({ 
        success: true, 
        adminEmail: adminEmailResponse,
        userEmail: userEmailResponse 
      }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  } catch (error: any) {
    console.error("[NOTIFY-ME-EMAIL] Error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }
};

Deno.serve(handler);
