import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

function getCorsHeaders(request: Request): Record<string, string> {
  const requestOrigin = request.headers.get('origin');
  const origin = requestOrigin ?? '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Vary': 'Origin',
  };
}

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  const origin = req.headers.get('origin');

  // Enforce origin allowlist
  if (origin && !isOriginAllowed(origin)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
      status: 403,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Handle CORS preflight requests
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      return new Response(JSON.stringify({ error: "Server not configured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!jwt) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { searchId } = await req.json().catch(() => ({ searchId: null }));
    if (!searchId || typeof searchId !== "string") {
      return new Response(JSON.stringify({ error: "Missing searchId" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Verify user from JWT (use anon client for auth)
    const authClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { persistSession: false },
    });

    const { data: userData, error: userErr } = await authClient.auth.getUser();
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userId = userData.user.id;

    // Bypass RLS for update, but enforce ownership explicitly.
    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    });

    const { data: searchRow, error: searchErr } = await admin
      .from("searches")
      .select("id,user_id,status,skip_requested")
      .eq("id", searchId)
      .maybeSingle();

    if (searchErr || !searchRow) {
      return new Response(JSON.stringify({ error: "Search not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (searchRow.user_id !== userId) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // If already terminal, no-op.
    if (["completed", "price_unavailable", "dates_required"].includes(searchRow.status)) {
      return new Response(JSON.stringify({ ok: true, status: searchRow.status, skipped: false }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // If already skip requested, acknowledge (but also refresh heartbeat so UI doesn't think nothing happened)
    if (searchRow.skip_requested === true) {
      await admin
        .from("searches")
        .update({ last_progress_at: new Date().toISOString() })
        .eq("id", searchId);

      return new Response(
        JSON.stringify({ ok: true, status: searchRow.status, skipped: true, alreadyRequested: true }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Set skip_requested = true (backend will check this and skip current phase)
    const { error: updErr } = await admin
      .from("searches")
      .update({ skip_requested: true })
      .eq("id", searchId);

    if (updErr) {
      console.error("Failed to set skip_requested:", updErr);
      return new Response(JSON.stringify({ error: "Failed to request skip" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`Skip requested for search ${searchId} by user ${userId}`);

    return new Response(JSON.stringify({ ok: true, status: searchRow.status, skipped: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("request-skip-step error:", e);
    return new Response(JSON.stringify({ error: (e as Error)?.message ?? "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
