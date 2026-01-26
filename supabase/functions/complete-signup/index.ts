import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface RequestBody {
  email: string;
  verificationToken: string;
  password: string;
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
    const { email, verificationToken, password }: RequestBody = await req.json();

    if (!email || !verificationToken || !password) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    if (password.length < 8) {
      return new Response(JSON.stringify({ error: "Password must be at least 8 characters" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Verify the token exists and is valid
    const { data: tokenRecord, error: fetchError } = await supabase
      .from("signup_verification_codes")
      .select("*")
      .eq("email", email.toLowerCase())
      .eq("code", verificationToken)
      .eq("used", false)
      .eq("attempts", -1) // Verification tokens have attempts = -1
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();

    if (fetchError) {
      console.error("[COMPLETE-SIGNUP] Fetch error:", fetchError);
      throw new Error("Failed to verify token");
    }

    if (!tokenRecord) {
      return new Response(JSON.stringify({ error: "Verification expired. Please start over." }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Mark token as used
    await supabase
      .from("signup_verification_codes")
      .update({ used: true })
      .eq("id", tokenRecord.id);

    // Create the user with admin API
    const { data: newUser, error: createError } = await supabase.auth.admin.createUser({
      email: email.toLowerCase(),
      password,
      email_confirm: true, // Auto-confirm since we verified via OTP
    });

    if (createError) {
      console.error("[COMPLETE-SIGNUP] Create user error:", createError);
      
      if (createError.message?.includes("already been registered")) {
        return new Response(JSON.stringify({ error: "An account with this email already exists." }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      
      throw new Error("Failed to create account");
    }

    console.log(`[COMPLETE-SIGNUP] Account created for ${email.slice(0, 3)}***`);

    return new Response(JSON.stringify({ 
      success: true,
      message: "Account created successfully"
    }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (error: any) {
    console.error("[COMPLETE-SIGNUP] Error:", error);
    return new Response(JSON.stringify({ error: error.message || "Failed to create account" }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
});
