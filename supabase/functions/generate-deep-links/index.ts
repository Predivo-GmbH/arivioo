import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Declare EdgeRuntime for Supabase Edge Functions background tasks
declare const EdgeRuntime: { waitUntil?: (promise: Promise<unknown>) => void } | undefined;

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
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface DeepLinkRequest {
  searchId: string;
  checkIn: string;
  checkOut: string;
  adults?: number;
  children?: number;
  rooms?: number;
  skipPriceExtraction?: boolean;
}

interface UrlParameterRules {
  checkin_param?: string;
  checkout_param?: string;
  adults_param?: string;
  children_param?: string;
  rooms_param?: string;
  date_format?: string;
  // Special rules for platforms with unique URL structures
  preserve_params?: string[]; // Parameters to keep from original URL
  remove_params?: string[];   // Parameters to remove
}

// Default URL parameter rules per platform
const DEFAULT_URL_RULES: Record<string, UrlParameterRules> = {
  'booking.com': {
    checkin_param: 'checkin',
    checkout_param: 'checkout',
    adults_param: 'group_adults',
    children_param: 'group_children',
    rooms_param: 'no_rooms',
    date_format: 'YYYY-MM-DD',
    preserve_params: ['all_sr_blocks', 'highlighted_blocks', 'matching_block_id', 'sr_pri_blocks', 'srpvid', 'srepoch'],
  },
  'expedia.com': {
    checkin_param: 'chkin',
    checkout_param: 'chkout',
    adults_param: 'adults',
    children_param: 'children',
    rooms_param: 'rooms',
    date_format: 'YYYY-MM-DD',
  },
  'hotels.com': {
    checkin_param: 'chkin',
    checkout_param: 'chkout',
    adults_param: 'adults',
    children_param: 'children',
    rooms_param: 'rooms',
    date_format: 'YYYY-MM-DD',
  },
  'vrbo.com': {
    checkin_param: 'startDate',
    checkout_param: 'endDate',
    adults_param: 'adults',
    children_param: 'children',
    date_format: 'YYYY-MM-DD',
  },
  'agoda.com': {
    checkin_param: 'checkIn',
    checkout_param: 'checkOut',
    adults_param: 'adults',
    children_param: 'children',
    rooms_param: 'rooms',
    date_format: 'YYYY-MM-DD',
  },
  'tripadvisor.com': {
    checkin_param: 'checkin',
    checkout_param: 'checkout',
    adults_param: 'adults',
    rooms_param: 'rooms',
    date_format: 'YYYY/MM/DD',
  },
  'hostelworld.com': {
    checkin_param: 'dateFrom',
    checkout_param: 'dateTo',
    adults_param: 'guests',
    date_format: 'YYYY-MM-DD',
  },
  'hrs.com': {
    checkin_param: 'checkinDate',
    checkout_param: 'checkoutDate',
    adults_param: 'adults',
    rooms_param: 'rooms',
    date_format: 'YYYY-MM-DD',
  },
  'holidaycheck.de': {
    checkin_param: 'checkin',
    checkout_param: 'checkout',
    adults_param: 'adults',
    children_param: 'children',
    date_format: 'YYYY-MM-DD',
  },
};

// Format date according to platform requirements
function formatDate(dateStr: string, format: string): string {
  const date = new Date(dateStr);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  
  switch (format) {
    case 'YYYY-MM-DD':
      return `${year}-${month}-${day}`;
    case 'MM/DD/YYYY':
      return `${month}/${day}/${year}`;
    case 'YYYY/MM/DD':
      return `${year}/${month}/${day}`;
    case 'DD-MM-YYYY':
      return `${day}-${month}-${year}`;
    case 'DD.MM.YYYY':
      return `${day}.${month}.${year}`;
    default:
      return `${year}-${month}-${day}`;
  }
}

// Detect platform from URL
function detectPlatform(url: string): string | null {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase().replace('www.', '');
    
    const platformMappings: Record<string, string> = {
      'booking.com': 'booking.com',
      'expedia.com': 'expedia.com',
      'expedia.co.uk': 'expedia.com',
      'expedia.de': 'expedia.com',
      'hotels.com': 'hotels.com',
      'vrbo.com': 'vrbo.com',
      'agoda.com': 'agoda.com',
      'tripadvisor.com': 'tripadvisor.com',
      'tripadvisor.co.uk': 'tripadvisor.com',
      'tripadvisor.de': 'tripadvisor.com',
      'hostelworld.com': 'hostelworld.com',
      'hrs.com': 'hrs.com',
      'hrs.de': 'hrs.com',
      'holidaycheck.de': 'holidaycheck.de',
      'holidaycheck.com': 'holidaycheck.de',
    };

    for (const [domain, platform] of Object.entries(platformMappings)) {
      if (hostname.includes(domain)) {
        return platform;
      }
    }

    return null;
  } catch (e) {
    return null;
  }
}

// NEW: Build deep link by modifying the canonical URL (not from template)
function buildDeepLinkFromUrl(
  originalUrl: string,
  rules: UrlParameterRules,
  checkIn: string,
  checkOut: string,
  adults: number,
  children: number,
  rooms: number
): string {
  try {
    const urlObj = new URL(originalUrl);
    const dateFormat = rules.date_format || 'YYYY-MM-DD';

    // Remove unwanted params if specified
    if (rules.remove_params) {
      for (const param of rules.remove_params) {
        urlObj.searchParams.delete(param);
      }
    }

    // Set date parameters
    if (rules.checkin_param) {
      urlObj.searchParams.set(rules.checkin_param, formatDate(checkIn, dateFormat));
    }
    if (rules.checkout_param) {
      urlObj.searchParams.set(rules.checkout_param, formatDate(checkOut, dateFormat));
    }

    // Set occupancy parameters
    if (rules.adults_param) {
      urlObj.searchParams.set(rules.adults_param, String(adults));
    }
    if (rules.children_param && children > 0) {
      urlObj.searchParams.set(rules.children_param, String(children));
    }
    if (rules.rooms_param) {
      urlObj.searchParams.set(rules.rooms_param, String(rooms));
    }

    return urlObj.toString();
  } catch (e) {
    console.error(`Error building deep link from URL ${originalUrl}:`, e);
    return originalUrl;
  }
}

// Merge DB rules with defaults
function mergeRules(dbRules: UrlParameterRules | null, platform: string): UrlParameterRules {
  const defaults = DEFAULT_URL_RULES[platform] || {
    checkin_param: 'checkin',
    checkout_param: 'checkout',
    adults_param: 'adults',
    date_format: 'YYYY-MM-DD',
  };

  if (!dbRules) {
    return defaults;
  }

  return { ...defaults, ...dbRules };
}

// Background task: Trigger price pipeline via process-platform-extraction
// This ensures golden path routing for Tier A platforms (Expedia, Hotels.com, Agoda)
async function triggerPriceExtraction(searchId: string, extractions: Array<{ id: string; deepLink: string; platformName: string }>, checkIn: string, checkOut: string): Promise<void> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !supabaseServiceKey) {
    console.error('Missing credentials for price extraction');
    return;
  }

  try {
    console.log(`[BACKGROUND] Starting price extraction for search ${searchId} with ${extractions.length} platforms`);
    
    // CRITICAL FIX: Route through process-platform-extraction worker
    // This ensures Tier A platforms (Expedia, Hotels.com, Agoda) use their dedicated golden path extractors
    // instead of the generic validate-dates → extract-prices flow
    
    const workerPromises = extractions.map(async (extraction) => {
      console.log(`[BACKGROUND] Triggering worker for ${extraction.platformName} (${extraction.id})`);
      
      try {
        const workerResponse = await fetch(`${supabaseUrl}/functions/v1/process-platform-extraction`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${supabaseServiceKey}`,
          },
          body: JSON.stringify({
            extractionId: extraction.id,
            requestedCheckIn: checkIn,
            requestedCheckOut: checkOut,
          }),
        });

        if (!workerResponse.ok) {
          const errorText = await workerResponse.text().catch(() => 'Unknown error');
          console.error(`[BACKGROUND] Worker failed for ${extraction.platformName}: ${workerResponse.status} - ${errorText.slice(0, 200)}`);
          return { platform: extraction.platformName, success: false, error: `HTTP ${workerResponse.status}` };
        }

        const result = await workerResponse.json();
        console.log(`[BACKGROUND] ${extraction.platformName}: ${result.result?.finalStatus || result.status || 'unknown'}`);
        return { platform: extraction.platformName, success: result.success, status: result.result?.finalStatus };
      } catch (err) {
        console.error(`[BACKGROUND] Worker error for ${extraction.platformName}:`, err);
        return { platform: extraction.platformName, success: false, error: String(err) };
      }
    });

    // Run all workers in parallel
    const results = await Promise.allSettled(workerPromises);
    
    const successful = results.filter(r => r.status === 'fulfilled' && (r.value as any)?.success).length;
    const failed = results.length - successful;
    
    console.log(`[BACKGROUND] Price extraction completed: ${successful} success, ${failed} failed`);
  } catch (error) {
    console.error(`[BACKGROUND] Price extraction error:`, error);
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const { 
      searchId, 
      checkIn, 
      checkOut, 
      adults = 2, 
      children = 0, 
      rooms = 1,
      skipPriceExtraction = false 
    } = await req.json() as DeepLinkRequest;

    console.log(`[DEEP-LINKS] Generating for search ${searchId}`);
    console.log(`[DEEP-LINKS] Dates: ${checkIn} to ${checkOut}, Occupancy: ${adults}a/${children}c/${rooms}r`);

    // Fetch search results
    const { data: searchResults, error: searchError } = await supabaseClient
      .from('search_results')
      .select('*')
      .eq('search_id', searchId);

    if (searchError) {
      throw new Error(`Failed to fetch search results: ${searchError.message}`);
    }

    if (!searchResults || searchResults.length === 0) {
      return new Response(
        JSON.stringify({ success: true, deepLinks: [], message: 'No search results found' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Fetch platform adapters with new url_parameter_rules
    const { data: adapters } = await supabaseClient
      .from('platform_adapters')
      .select('platform_name, platform_domain, url_parameter_rules, is_active')
      .eq('is_active', true);

    const adapterMap = new Map<string, UrlParameterRules>();
    for (const adapter of (adapters || [])) {
      const rules = adapter.url_parameter_rules as UrlParameterRules || null;
      adapterMap.set(adapter.platform_domain, rules);
    }

    // Fetch blocked platforms
    const { data: blockedPlatforms } = await supabaseClient
      .from('blocked_platforms')
      .select('domain');

    const blockedDomains = new Set((blockedPlatforms || []).map(p => p.domain));

    // Generate deep links using URL modification approach
    const deepLinks: Array<{
      resultId: string;
      extractionId: string;
      platformName: string;
      originalUrl: string;
      deepLink: string;
      occupancyAssumed: boolean;
      hasRules: boolean;
    }> = [];

    for (const result of searchResults) {
      const platform = detectPlatform(result.listing_url);
      
      // Skip blocked platforms
      if (blockedDomains.has(result.platform_name.toLowerCase())) {
        console.log(`[DEEP-LINKS] Skipping blocked platform: ${result.platform_name}`);
        continue;
      }

      // Get URL modification rules (from DB or defaults)
      const dbRules = platform ? (adapterMap.get(platform) ?? null) : null;
      const rules = mergeRules(dbRules, platform || '');

      // Build deep link by modifying the original URL
      const deepLink = buildDeepLinkFromUrl(
        result.listing_url,
        rules,
        checkIn,
        checkOut,
        adults,
        children,
        rooms
      );

      // Create/update price extraction record and get the actual extraction ID
      const { data: extractionData, error: upsertError } = await supabaseClient
        .from('price_extractions')
        .upsert({
          search_result_id: result.id,
          search_id: searchId,
          platform_name: result.platform_name,
          deep_link: deepLink,
          assumed_adults: adults,
          assumed_children: children,
          assumed_rooms: rooms,
          occupancy_assumed: true,
          extraction_status: 'pending',
          dates_validated: false,
        }, {
          onConflict: 'search_result_id'
        })
        .select('id')
        .single();

      if (upsertError) {
        console.error(`[DEEP-LINKS] Upsert error for ${result.platform_name}:`, upsertError);
        continue;
      }

      deepLinks.push({
        resultId: result.id,
        extractionId: extractionData.id,
        platformName: result.platform_name,
        originalUrl: result.listing_url,
        deepLink,
        occupancyAssumed: true,
        hasRules: !!platform,
      });
    }

    console.log(`[DEEP-LINKS] Generated ${deepLinks.length} deep links`);

    // Automatic price extraction via process-platform-extraction (runs in background)
    // This routes Tier A platforms (Expedia, Hotels.com, Agoda) through their golden path extractors
    if (!skipPriceExtraction && deepLinks.length > 0) {
      console.log(`[DEEP-LINKS] Scheduling price extraction via process-platform-extraction workers`);
      
      // Use actual price_extractions.id, not search_result.id
      const extractionData = deepLinks.map(d => ({
        id: d.extractionId,
        deepLink: d.deepLink,
        platformName: d.platformName,
      }));
      
      if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime?.waitUntil) {
        EdgeRuntime.waitUntil(triggerPriceExtraction(searchId, extractionData, checkIn, checkOut));
      } else {
        triggerPriceExtraction(searchId, extractionData, checkIn, checkOut).catch((err: Error) => 
          console.error('Background price extraction error:', err)
        );
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        deepLinks,
        totalResults: searchResults.length,
        withRules: deepLinks.filter(d => d.hasRules).length,
        unknownPlatforms: deepLinks.filter(d => !d.hasRules).map(d => d.platformName),
        priceExtractionQueued: !skipPriceExtraction && deepLinks.length > 0,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[DEEP-LINKS] Error:', error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
