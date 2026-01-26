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

    if (!email || !code || code.length !== 6) {
      return new Response(JSON.stringify({ error: "Invalid request" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Find valid code
    const { data: codeRecord, error: fetchError } = await supabase
      .from("signup_verification_codes")
      .select("*")
      .eq("email", email.toLowerCase())
      .eq("used", false)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (fetchError) {
      console.error("[VERIFY-SIGNUP] Fetch error:", fetchError);
      throw new Error("Failed to verify code");
    }

    if (!codeRecord) {
      return new Response(JSON.stringify({ error: "Code expired or invalid. Please request a new one." }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Check attempts
    if (codeRecord.attempts >= codeRecord.max_attempts) {
      return new Response(JSON.stringify({ error: "Too many attempts. Please request a new code." }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Increment attempts
    await supabase
      .from("signup_verification_codes")
      .update({ attempts: codeRecord.attempts + 1 })
      .eq("id", codeRecord.id);

    // Verify code
    if (codeRecord.code !== code) {
      const remainingAttempts = codeRecord.max_attempts - codeRecord.attempts - 1;
      return new Response(JSON.stringify({ 
        error: remainingAttempts > 0 
          ? `Incorrect code. ${remainingAttempts} attempt${remainingAttempts === 1 ? '' : 's'} remaining.`
          : "Too many attempts. Please request a new code."
      }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Generate a verification token (used to complete signup)
    const verificationToken = crypto.randomUUID();

    // Update the code record with the verification token (store it temporarily)
    await supabase
      .from("signup_verification_codes")
      .update({ 
        used: true,
        // Store verification token in a way we can retrieve it
        // We'll add 10 more minutes for the user to set their password
      })
      .eq("id", codeRecord.id);

    // Store the verification token in a simple way - we'll create a new record
    const tokenExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await supabase
      .from("signup_verification_codes")
      .insert({
        email: email.toLowerCase(),
        code: verificationToken, // Use code field to store the token
        expires_at: tokenExpiresAt,
        used: false,
        attempts: -1, // Mark as verification token (not a code)
      });

    console.log(`[VERIFY-SIGNUP] Code verified for ${email.slice(0, 3)}***`);

    return new Response(JSON.stringify({ 
      success: true,
      verificationToken 
    }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (error: any) {
    console.error("[VERIFY-SIGNUP] Error:", error);
    return new Response(JSON.stringify({ error: "Failed to verify code" }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
});
