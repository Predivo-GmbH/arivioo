import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Declare EdgeRuntime for Supabase Edge Functions background tasks
declare const EdgeRuntime: { waitUntil?: (promise: Promise<unknown>) => void } | undefined;

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
  skipPriceExtraction?: boolean; // Optional: skip auto price extraction
}

interface PlatformAdapter {
  platform_name: string;
  platform_domain: string;
  deep_link_template: string;
  date_format: string;
  requires_occupancy: boolean;
  occupancy_params: Record<string, string>;
  price_selectors: Record<string, string>;
  is_active: boolean;
}

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
    default:
      return `${year}-${month}-${day}`;
  }
}

// Extract property ID from listing URL based on platform
function extractPropertyId(url: string, platform: string): string | null {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    
    switch (platform) {
      case 'booking.com': {
        // Format: /hotel/country/property-name.html or /hotel/country/property-name.en-gb.html
        const match = pathname.match(/\/hotel\/[^\/]+\/([^\/\.]+)/);
        return match ? match[1] : null;
      }
      case 'expedia.com': {
        // Format: /Hotel-Search?destination=xxx or hotel ID in path
        const hotelMatch = pathname.match(/\.h(\d+)\./);
        return hotelMatch ? hotelMatch[1] : urlObj.searchParams.get('destination');
      }
      case 'hotels.com': {
        // Format: /hoXXXXXX/
        const match = pathname.match(/\/ho(\d+)/);
        return match ? match[1] : null;
      }
      case 'vrbo.com': {
        // Format: /XXXXXX or /unitId/
        const match = pathname.match(/\/(\d+)/);
        return match ? match[1] : null;
      }
      case 'agoda.com': {
        // Format: /hotel/city/property-name.html
        const match = pathname.match(/\/hotel\/[^\/]+\/([^\/\.]+)/);
        return match ? match[1] : null;
      }
      case 'tripadvisor.com': {
        // Format: /Hotel_Review-gXXX-dXXXXXXX
        const match = pathname.match(/Hotel_Review-([^-]+-[^-]+)/);
        return match ? match[1] : null;
      }
      case 'hostelworld.com': {
        // Format: /st/hostels/p/XXXXXX
        const match = pathname.match(/\/p\/(\d+)/);
        return match ? match[1] : null;
      }
      case 'hrs.com': {
        // Format: /hotel/xxx/property-id
        const match = pathname.match(/\/hotel\/[^\/]+\/([^\/]+)/);
        return match ? match[1] : null;
      }
      case 'holidaycheck.de': {
        // Format: /hi/property-id
        const match = pathname.match(/\/hi\/([^\/]+)/);
        return match ? match[1] : null;
      }
      default:
        // For unknown platforms, try to extract any ID-like pattern
        const genericMatch = pathname.match(/\/(\d{5,})/);
        return genericMatch ? genericMatch[1] : null;
    }
  } catch (e) {
    console.error(`Error extracting property ID from ${url}:`, e);
    return null;
  }
}

// Build deep link for a platform
function buildDeepLink(
  adapter: PlatformAdapter,
  propertyId: string,
  checkIn: string,
  checkOut: string,
  adults: number,
  children: number,
  rooms: number,
  originalUrl: string
): string {
  // If we can't extract a proper property ID, use the original URL with date params appended
  if (!propertyId) {
    console.log(`No property ID extracted, using original URL with params: ${originalUrl}`);
    const urlObj = new URL(originalUrl);
    urlObj.searchParams.set('checkin', formatDate(checkIn, adapter.date_format));
    urlObj.searchParams.set('checkout', formatDate(checkOut, adapter.date_format));
    if (adapter.requires_occupancy) {
      urlObj.searchParams.set('adults', String(adults));
      urlObj.searchParams.set('children', String(children));
      urlObj.searchParams.set('rooms', String(rooms));
    }
    return urlObj.toString();
  }

  let deepLink = adapter.deep_link_template
    .replace('{property_id}', propertyId)
    .replace('{checkin}', formatDate(checkIn, adapter.date_format))
    .replace('{checkout}', formatDate(checkOut, adapter.date_format))
    .replace('{adults}', String(adults))
    .replace('{children}', String(children))
    .replace('{rooms}', String(rooms));

  return deepLink;
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

// Background task: Trigger price extraction for all pending extractions
async function triggerPriceExtraction(searchId: string): Promise<void> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !supabaseServiceKey) {
    console.error('Missing Supabase credentials for price extraction trigger');
    return;
  }

  try {
    console.log(`[BACKGROUND] Triggering automatic price extraction for search ${searchId}`);
    
    const response = await fetch(`${supabaseUrl}/functions/v1/extract-prices`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseServiceKey}`,
      },
      body: JSON.stringify({ searchId }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[BACKGROUND] Price extraction failed: ${response.status} - ${errorText}`);
      return;
    }

    const result = await response.json();
    console.log(`[BACKGROUND] Price extraction completed:`, {
      total: result.summary?.total || 0,
      successful: result.summary?.successful || 0,
      failed: result.summary?.failed || 0,
    });
  } catch (error) {
    console.error(`[BACKGROUND] Error triggering price extraction:`, error);
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

    console.log(`Generating deep links for search ${searchId}`);
    console.log(`Dates: ${checkIn} to ${checkOut}, Occupancy: ${adults} adults, ${children} children, ${rooms} rooms`);
    console.log(`Auto price extraction: ${!skipPriceExtraction}`);

    // Fetch search results for this search
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

    // Fetch platform adapters
    const { data: adapters, error: adaptersError } = await supabaseClient
      .from('platform_adapters')
      .select('*')
      .eq('is_active', true);

    if (adaptersError) {
      throw new Error(`Failed to fetch platform adapters: ${adaptersError.message}`);
    }

    const adapterMap = new Map<string, PlatformAdapter>();
    for (const adapter of (adapters || [])) {
      adapterMap.set(adapter.platform_domain, adapter as PlatformAdapter);
    }

    // Fetch blocked platforms
    const { data: blockedPlatforms } = await supabaseClient
      .from('blocked_platforms')
      .select('domain');

    const blockedDomains = new Set((blockedPlatforms || []).map(p => p.domain));

    // Generate deep links for each search result
    const deepLinks: Array<{
      resultId: string;
      platformName: string;
      originalUrl: string;
      deepLink: string;
      propertyId: string | null;
      occupancyAssumed: boolean;
      hasAdapter: boolean;
    }> = [];

    for (const result of searchResults) {
      const platformName = detectPlatform(result.listing_url);
      
      // Skip blocked platforms
      if (blockedDomains.has(result.platform_name.toLowerCase())) {
        console.log(`Skipping blocked platform: ${result.platform_name}`);
        continue;
      }

      const adapter = platformName ? adapterMap.get(platformName) : null;
      const propertyId = platformName ? extractPropertyId(result.listing_url, platformName) : null;

      let deepLink = result.listing_url;
      let hasAdapter = false;

      if (adapter) {
        deepLink = buildDeepLink(
          adapter,
          propertyId || '',
          checkIn,
          checkOut,
          adults,
          children,
          rooms,
          result.listing_url
        );
        hasAdapter = true;
      } else {
        // For unknown platforms, try to append dates as query params
        try {
          const urlObj = new URL(result.listing_url);
          urlObj.searchParams.set('checkin', checkIn);
          urlObj.searchParams.set('checkout', checkOut);
          urlObj.searchParams.set('adults', String(adults));
          deepLink = urlObj.toString();
        } catch (e) {
          // Keep original URL if parsing fails
          deepLink = result.listing_url;
        }
      }

      deepLinks.push({
        resultId: result.id,
        platformName: result.platform_name,
        originalUrl: result.listing_url,
        deepLink,
        propertyId,
        occupancyAssumed: true,
        hasAdapter,
      });

      // Create or update price extraction record with 'pending' status
      await supabaseClient
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
        }, {
          onConflict: 'search_result_id'
        });
    }

    console.log(`Generated ${deepLinks.length} deep links`);

    // AUTOMATIC PRICE EXTRACTION: Run in background without blocking response
    // This ensures price extraction happens automatically after deep links are created
    if (!skipPriceExtraction && deepLinks.length > 0) {
      console.log(`Scheduling automatic price extraction for ${deepLinks.length} results`);
      
      // Use EdgeRuntime.waitUntil if available, otherwise fire-and-forget
      if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime?.waitUntil) {
        EdgeRuntime.waitUntil(triggerPriceExtraction(searchId));
      } else {
        // Fallback: trigger without waiting (fire and forget)
        triggerPriceExtraction(searchId).catch(err => 
          console.error('Background price extraction error:', err)
        );
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        deepLinks,
        totalResults: searchResults.length,
        withAdapters: deepLinks.filter(d => d.hasAdapter).length,
        unknownPlatforms: deepLinks.filter(d => !d.hasAdapter).map(d => d.platformName),
        priceExtractionQueued: !skipPriceExtraction && deepLinks.length > 0,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error generating deep links:', error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
