import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface RequestBody {
  email: string;
  verificationToken: string;
  newPassword: string;
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
    const { email, verificationToken, newPassword }: RequestBody = await req.json();

    // Validate inputs
    if (!email || !verificationToken || !newPassword) {
      return new Response(JSON.stringify({ error: "All fields are required" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Validate password strength
    if (newPassword.length < 8) {
      return new Response(JSON.stringify({ error: "Password must be at least 8 characters" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Verify the token (code ID) is valid and belongs to this email
    const { data: resetCode, error: fetchError } = await supabase
      .from("password_reset_codes")
      .select("*")
      .eq("id", verificationToken)
      .eq("email", email.toLowerCase())
      .eq("used", false)
      .maybeSingle();

    if (fetchError) {
      console.error("[RESET-PASSWORD] Fetch error:", fetchError);
      throw new Error("Failed to verify token");
    }

    if (!resetCode) {
      return new Response(JSON.stringify({ error: "Invalid or expired verification. Please start over." }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Check if code is expired (give 5 more minutes buffer for password entry)
    const bufferExpiry = new Date(new Date(resetCode.expires_at).getTime() + 5 * 60 * 1000);
    if (bufferExpiry < new Date()) {
      return new Response(JSON.stringify({ error: "Session expired. Please start over." }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Find the user
    const { data: userData } = await supabase.auth.admin.listUsers();
    const user = userData?.users?.find(u => u.email?.toLowerCase() === email.toLowerCase());

    if (!user) {
      return new Response(JSON.stringify({ error: "User not found" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Update the password
    const { error: updateError } = await supabase.auth.admin.updateUserById(user.id, {
      password: newPassword,
    });

    if (updateError) {
      console.error("[RESET-PASSWORD] Update error:", updateError);
      throw new Error("Failed to update password");
    }

    // Mark the code as used
    await supabase
      .from("password_reset_codes")
      .update({ used: true })
      .eq("id", verificationToken);

    console.log(`[RESET-PASSWORD] Password reset for ${email.slice(0, 3)}***`);

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (error: any) {
    console.error("[RESET-PASSWORD] Error:", error);
    return new Response(JSON.stringify({ error: "Failed to reset password" }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
});
