import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ============================================================================
// SECURE CORS - Domain allowlist for production security
// ============================================================================
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
  const requestedHeaders = request.headers.get('access-control-request-headers');
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': requestedHeaders || 'authorization, x-client-info, apikey, content-type, x-debug-unlock',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Vary': 'Origin, Access-Control-Request-Headers',
  };
}

// ============================================================================
// Access Control Types
// ============================================================================
type AccessState = 'locked' | 'unlocked';
type LockedReason = 'email_verification_required' | 'not_owner' | 'search_not_found';

interface PublicSummary {
  searchId: string;
  status: string;
  createdAt: string;
  hasResults: boolean;
  resultCount: number;
  isComplete: boolean;
  // Safe metadata (no prices, no platform names, no URLs)
  checkInDate: string | null;
  checkOutDate: string | null;
  nightsCount: number | null;
}

interface PrivateResults {
  search: any;
  results: any[];
  extractions: any[];
  confirmedTotal: any | null;
}

interface AccessResponse {
  access: AccessState;
  lockedReason?: LockedReason;
  publicSummary: PublicSummary;
  privateResults?: PrivateResults;
}

// ============================================================================
// Admin Session Verification
// ============================================================================
async function isAdminSession(supabase: any, sessionToken: string | null): Promise<boolean> {
  if (!sessionToken) return false;
  
  try {
    const { data: session, error } = await supabase
      .from('admin_sessions')
      .select('id, admin_user_id, expires_at')
      .eq('session_token', sessionToken)
      .gt('expires_at', new Date().toISOString())
      .single();
    
    if (error || !session) return false;
    
    // Verify admin user is active
    const { data: adminUser, error: adminError } = await supabase
      .from('admin_users')
      .select('id, is_active')
      .eq('id', session.admin_user_id)
      .eq('is_active', true)
      .single();
    
    return !adminError && adminUser !== null;
  } catch {
    return false;
  }
}

// ============================================================================
// Debug Unlock (non-production only)
// ============================================================================
function isDebugUnlockAllowed(request: Request): boolean {
  // Get environment - only allow in dev/staging
  const env = Deno.env.get('ENVIRONMENT') || 'production';
  const isProduction = env === 'production' || env === 'prod';
  
  if (isProduction) {
    console.log('[get-search-access] Debug unlock blocked - production environment');
    return false;
  }
  
  // Require a server-side secret match
  const debugSecret = Deno.env.get('DEBUG_UNLOCK_SECRET');
  if (!debugSecret) {
    console.log('[get-search-access] Debug unlock blocked - no DEBUG_UNLOCK_SECRET configured');
    return false;
  }
  
  const providedSecret = request.headers.get('x-debug-unlock');
  if (!providedSecret || providedSecret !== debugSecret) {
    console.log('[get-search-access] Debug unlock blocked - secret mismatch');
    return false;
  }
  
  console.log('[get-search-access] Debug unlock GRANTED for non-production testing');
  return true;
}

// ============================================================================
// Main Handler
// ============================================================================
serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // Validate origin
  const origin = req.headers.get('origin');
  if (!isOriginAllowed(origin)) {
    console.log('[get-search-access] Origin not allowed:', origin);
    return new Response(
      JSON.stringify({ error: 'Origin not allowed' }),
      { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  try {
    const { searchId } = await req.json();
    
    if (!searchId) {
      return new Response(
        JSON.stringify({ error: 'searchId required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[get-search-access] Checking access for search: ${searchId}`);

    // Create Supabase client with service role for admin checks
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    // Get the search record first
    const { data: searchData, error: searchError } = await supabaseAdmin
      .from('searches')
      .select('*')
      .eq('id', searchId)
      .single();

    if (searchError || !searchData) {
      console.log('[get-search-access] Search not found:', searchId);
      return new Response(
        JSON.stringify({
          access: 'locked',
          lockedReason: 'search_not_found',
          publicSummary: {
            searchId,
            status: 'not_found',
            createdAt: new Date().toISOString(),
            hasResults: false,
            resultCount: 0,
            isComplete: false,
            checkInDate: null,
            checkOutDate: null,
            nightsCount: null,
          },
        }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Determine access level
    let access: AccessState = 'locked';
    let lockedReason: LockedReason = 'email_verification_required';

    // Check 1: Admin session (from cookie or header)
    const adminSessionToken = req.headers.get('x-admin-session');
    const isAdmin = await isAdminSession(supabaseAdmin, adminSessionToken);
    
    if (isAdmin) {
      console.log('[get-search-access] Admin session detected - granting access');
      access = 'unlocked';
    }

    // Check 2: Debug unlock for non-production testing
    if (access === 'locked' && isDebugUnlockAllowed(req)) {
      access = 'unlocked';
    }

    // Check 3: User owns the search (verified via JWT)
    if (access === 'locked') {
      const authHeader = req.headers.get('Authorization');
      if (authHeader?.startsWith('Bearer ')) {
        const token = authHeader.slice(7);
        const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
        const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
          global: { headers: { Authorization: `Bearer ${token}` } },
        });
        
        const { data: { user }, error: userError } = await supabaseUser.auth.getUser();
        
        if (!userError && user) {
          // Check if user owns this search
          if (searchData.user_id === user.id) {
            console.log('[get-search-access] User owns search - checking email verification');
            
            // For now, owner access grants unlock (email verification will be added later)
            // TODO: When email verification is implemented, check user.email_confirmed_at
            // For MVP, we allow anonymous owners to see their own results
            access = 'unlocked';
          } else {
            lockedReason = 'not_owner';
          }
        }
      }
    }

    // Build public summary (always returned, no sensitive data)
    const publicSummary: PublicSummary = {
      searchId: searchData.id,
      status: searchData.status,
      createdAt: searchData.created_at,
      hasResults: false, // Will be updated below
      resultCount: 0,    // Will be updated below
      isComplete: ['completed', 'error', 'cancelled', 'price_unavailable'].includes(searchData.status),
      checkInDate: searchData.check_in_date,
      checkOutDate: searchData.check_out_date,
      nightsCount: searchData.nights_count,
    };

    // Count results without exposing details
    const { count: resultCount } = await supabaseAdmin
      .from('search_results')
      .select('id', { count: 'exact', head: true })
      .eq('search_id', searchId);
    
    publicSummary.hasResults = (resultCount ?? 0) > 0;
    publicSummary.resultCount = resultCount ?? 0;

    // If locked, return only public summary
    if (access === 'locked') {
      console.log(`[get-search-access] Access LOCKED for search ${searchId}: ${lockedReason}`);
      const response: AccessResponse = {
        access: 'locked',
        lockedReason,
        publicSummary,
      };
      return new Response(
        JSON.stringify(response),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Access granted - fetch full private results
    console.log(`[get-search-access] Access UNLOCKED for search ${searchId}`);

    // Fetch search results
    const { data: resultsData } = await supabaseAdmin
      .from('search_results')
      .select('*')
      .eq('search_id', searchId)
      .order('savings_percentage', { ascending: false, nullsFirst: false });

    // Fetch price extractions
    const { data: extractionsData } = await supabaseAdmin
      .from('price_extractions')
      .select('*')
      .eq('search_id', searchId);

    // Fetch confirmed total if exists
    const { data: confirmedTotalData } = await supabaseAdmin
      .from('airbnb_confirmed_totals')
      .select('*')
      .eq('search_id', searchId)
      .single();

    const privateResults: PrivateResults = {
      search: searchData,
      results: resultsData || [],
      extractions: extractionsData || [],
      confirmedTotal: confirmedTotalData || null,
    };

    const response: AccessResponse = {
      access: 'unlocked',
      publicSummary,
      privateResults,
    };

    return new Response(
      JSON.stringify(response),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[get-search-access] Error:', error);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
