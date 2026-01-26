import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface RequestBody {
  email: string;
  code: string;
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
    const { email, code }: RequestBody = await req.json();

    // Validate inputs
    if (!email || !code) {
      return new Response(JSON.stringify({ error: "Email and code are required" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Validate code format (6 digits)
    if (!/^\d{6}$/.test(code)) {
      return new Response(JSON.stringify({ error: "Invalid code format" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Find the most recent unused code for this email
    const { data: resetCode, error: fetchError } = await supabase
      .from("password_reset_codes")
      .select("*")
      .eq("email", email.toLowerCase())
      .eq("used", false)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (fetchError) {
      console.error("[VERIFY-CODE] Fetch error:", fetchError);
      throw new Error("Failed to verify code");
    }

    if (!resetCode) {
      return new Response(JSON.stringify({ error: "No valid reset code found. Please request a new one." }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Check if code is expired
    if (new Date(resetCode.expires_at) < new Date()) {
      return new Response(JSON.stringify({ error: "Code has expired. Please request a new one." }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Check max attempts
    if (resetCode.attempts >= resetCode.max_attempts) {
      // Mark as used to prevent further attempts
      await supabase
        .from("password_reset_codes")
        .update({ used: true })
        .eq("id", resetCode.id);

      return new Response(JSON.stringify({ error: "Too many failed attempts. Please request a new code." }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Verify the code (constant-time comparison would be better, but this is acceptable for 6-digit codes)
    if (resetCode.code !== code) {
      // Increment attempts
      await supabase
        .from("password_reset_codes")
        .update({ attempts: resetCode.attempts + 1 })
        .eq("id", resetCode.id);

      const remainingAttempts = resetCode.max_attempts - resetCode.attempts - 1;
      return new Response(JSON.stringify({ 
        error: `Incorrect code. ${remainingAttempts} attempt${remainingAttempts === 1 ? '' : 's'} remaining.` 
      }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Code is valid! Generate a temporary token for the password reset step
    // We'll use the code ID as a token since it's already verified
    const verificationToken = resetCode.id;

    console.log(`[VERIFY-CODE] Code verified for ${email.slice(0, 3)}***`);

    return new Response(JSON.stringify({ 
      success: true,
      verificationToken 
    }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (error: any) {
    console.error("[VERIFY-CODE] Error:", error);
    return new Response(JSON.stringify({ error: "Failed to verify code" }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
});
