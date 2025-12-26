import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface AdapterRequest {
  url: string;
  platformName?: string;
  checkIn?: string;  // Optional: for validation testing
  checkOut?: string;
}

interface UrlParameterRules {
  checkin_param: string;
  checkout_param: string;
  adults_param?: string;
  children_param?: string;
  rooms_param?: string;
  date_format: string;
  preserve_params?: string[];
  remove_params?: string[];
}

interface NavigationHints {
  availability_keywords: string[];
  price_keywords: string[];
  booking_flow_patterns: string[];
}

interface AdapterConfig {
  deepLinkTemplate: string;
  dateFormat: string;
  requiresOccupancy: boolean;
  occupancyParams: Record<string, string>;
  priceSelectors: Record<string, string>;
  validationRules: Record<string, any>;
  urlParameterRules: UrlParameterRules;
  navigationHints: NavigationHints;
  extractionSchemaOverrides?: Record<string, any>;
}

// Use Lovable AI to analyze a platform and generate complete adapter configuration
async function analyzeWithAI(url: string, markdown: string, platformName: string): Promise<AdapterConfig> {
  const lovableApiKey = Deno.env.get('LOVABLE_API_KEY');
  
  if (!lovableApiKey) {
    throw new Error('LOVABLE_API_KEY not configured');
  }

  const systemPrompt = `You are an expert at analyzing booking platform websites and extracting URL patterns for automated price extraction.

Given a URL and page content from a booking platform, analyze the structure and return a comprehensive JSON configuration.

You must return a valid JSON object with these fields:

1. **urlParameterRules** (REQUIRED - most important):
   - checkin_param: query parameter name for check-in date (e.g., "checkin", "checkIn", "check_in", "startDate")
   - checkout_param: query parameter name for check-out date
   - adults_param: parameter for adult count (optional)
   - children_param: parameter for children count (optional)
   - rooms_param: parameter for room count (optional)
   - date_format: "YYYY-MM-DD", "MM/DD/YYYY", "YYYY/MM/DD", or "DD-MM-YYYY"
   - preserve_params: array of query params that should be kept from original URL (for dynamic booking state)
   - remove_params: array of query params to remove

2. **navigationHints** (REQUIRED):
   - availability_keywords: words/phrases that link to availability pages (e.g., "See availability", "Check dates")
   - price_keywords: words/phrases near pricing info (e.g., "total", "price", "per night", "taxes included")
   - booking_flow_patterns: URL patterns for booking flow pages (e.g., "/reserve", "/checkout", "/book")

3. **deepLinkTemplate**: URL template with {property_id}, {checkin}, {checkout}, {adults} (legacy, but still needed)

4. **dateFormat**: Date format the platform uses

5. **requiresOccupancy**: boolean - whether platform needs guest count

6. **occupancyParams**: Object mapping our params to platform's param names

7. **priceSelectors**: CSS selectors for price elements (fallback)

8. **validationRules**: Validation patterns for property IDs etc.

9. **extractionSchemaOverrides**: Optional platform-specific overrides for AI extraction schema

FOCUS on urlParameterRules - this is critical for URL modification approach.`;

  const userPrompt = `Analyze this booking platform for automated price extraction:

URL: ${url}

Platform Name: ${platformName}

Page Content (markdown):
${markdown.substring(0, 15000)}

Examine:
1. The URL query parameters - what params control dates and occupancy?
2. Links on the page - what text/patterns lead to pricing/availability pages?
3. Price display patterns - what keywords appear near prices?

Return ONLY valid JSON, no markdown or explanation.`;

  try {
    const response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${lovableApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 2000,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`AI gateway error: ${response.status} - ${errorText}`);
      throw new Error(`AI gateway error: ${response.status}`);
    }

    const aiResponse = await response.json();
    const content = aiResponse.choices?.[0]?.message?.content;
    
    if (!content) {
      throw new Error('No content in AI response');
    }

    // Parse JSON from response (handle markdown code blocks)
    let jsonStr = content;
    if (content.includes('```json')) {
      jsonStr = content.split('```json')[1].split('```')[0].trim();
    } else if (content.includes('```')) {
      jsonStr = content.split('```')[1].split('```')[0].trim();
    }

    const config = JSON.parse(jsonStr);
    
    // Ensure urlParameterRules has required fields
    const urlParameterRules: UrlParameterRules = {
      checkin_param: config.urlParameterRules?.checkin_param || 'checkin',
      checkout_param: config.urlParameterRules?.checkout_param || 'checkout',
      adults_param: config.urlParameterRules?.adults_param,
      children_param: config.urlParameterRules?.children_param,
      rooms_param: config.urlParameterRules?.rooms_param,
      date_format: config.urlParameterRules?.date_format || config.dateFormat || 'YYYY-MM-DD',
      preserve_params: config.urlParameterRules?.preserve_params || [],
      remove_params: config.urlParameterRules?.remove_params || [],
    };

    // Ensure navigationHints has required fields
    const navigationHints: NavigationHints = {
      availability_keywords: config.navigationHints?.availability_keywords || ['availability', 'check dates', 'see prices'],
      price_keywords: config.navigationHints?.price_keywords || ['total', 'price', 'per night', 'taxes'],
      booking_flow_patterns: config.navigationHints?.booking_flow_patterns || ['/reserve', '/book', '/checkout'],
    };

    return {
      deepLinkTemplate: config.deepLinkTemplate || '',
      dateFormat: config.dateFormat || urlParameterRules.date_format,
      requiresOccupancy: config.requiresOccupancy ?? true,
      occupancyParams: config.occupancyParams || {},
      priceSelectors: config.priceSelectors || {},
      validationRules: config.validationRules || {},
      urlParameterRules,
      navigationHints,
      extractionSchemaOverrides: config.extractionSchemaOverrides,
    };

  } catch (error) {
    console.error('AI analysis error:', error);
    throw error;
  }
}

// Fetch page content using Firecrawl (primary) with fallback to simple fetch
async function fetchPageContent(url: string): Promise<{ markdown: string; links: string[] }> {
  const firecrawlApiKey = Deno.env.get('FIRECRAWL_API_KEY_1') || Deno.env.get('FIRECRAWL_API_KEY');
  
  if (firecrawlApiKey) {
    try {
      console.log(`[FIRECRAWL] Scraping ${url} for adapter generation`);
      
      const response = await fetch('https://api.firecrawl.dev/v1/scrape', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${firecrawlApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url,
          formats: ['markdown', 'links'],
          onlyMainContent: false, // Get full page for URL pattern analysis
          waitFor: 3000,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        return {
          markdown: data.data?.markdown || data.markdown || '',
          links: data.data?.links || data.links || [],
        };
      }
      
      console.log(`[FIRECRAWL] Failed: ${response.status}, falling back to simple fetch`);
    } catch (error) {
      console.error('[FIRECRAWL] Error:', error);
    }
  }

  // Fallback: simple fetch
  console.log('[FETCH] Using simple HTTP fetch');
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  });
  
  const html = await response.text();
  
  // Extract links from HTML
  const linkMatches = html.match(/href=["']([^"']+)["']/gi) || [];
  const links = linkMatches
    .map(m => m.replace(/href=["']|["']/gi, ''))
    .filter(l => l.startsWith('http') || l.startsWith('/'));

  return { markdown: html, links };
}

// Extract domain from URL
function extractDomain(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.replace('www.', '');
  } catch {
    return '';
  }
}

// Validate adapter by testing URL modification on a sample date range
async function validateAdapter(
  originalUrl: string,
  urlRules: UrlParameterRules,
  testCheckIn: string,
  testCheckOut: string
): Promise<{ valid: boolean; testUrl: string; error?: string }> {
  try {
    const urlObj = new URL(originalUrl);
    
    // Apply date parameters
    const formatDate = (dateStr: string, format: string): string => {
      const date = new Date(dateStr);
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      
      switch (format) {
        case 'YYYY-MM-DD': return `${year}-${month}-${day}`;
        case 'MM/DD/YYYY': return `${month}/${day}/${year}`;
        case 'YYYY/MM/DD': return `${year}/${month}/${day}`;
        case 'DD-MM-YYYY': return `${day}-${month}-${year}`;
        default: return `${year}-${month}-${day}`;
      }
    };

    urlObj.searchParams.set(urlRules.checkin_param, formatDate(testCheckIn, urlRules.date_format));
    urlObj.searchParams.set(urlRules.checkout_param, formatDate(testCheckOut, urlRules.date_format));
    
    if (urlRules.adults_param) {
      urlObj.searchParams.set(urlRules.adults_param, '2');
    }

    const testUrl = urlObj.toString();
    
    // Quick validation: check if URL is syntactically valid
    new URL(testUrl);
    
    return { valid: true, testUrl };
  } catch (error) {
    return { 
      valid: false, 
      testUrl: originalUrl,
      error: error instanceof Error ? error.message : 'Validation failed'
    };
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

    const { url, platformName, checkIn, checkOut } = await req.json() as AdapterRequest;

    if (!url) {
      return new Response(
        JSON.stringify({ success: false, error: 'URL is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const domain = extractDomain(url);
    const name = platformName || domain;

    console.log(`[ADAPTER-GEN] Generating adapter for: ${name} (${domain})`);

    // Check if adapter already exists
    const { data: existingAdapter } = await supabaseClient
      .from('platform_adapters')
      .select('*')
      .eq('platform_domain', domain)
      .maybeSingle();

    if (existingAdapter) {
      console.log(`[ADAPTER-GEN] Adapter already exists for ${domain}`);
      return new Response(
        JSON.stringify({
          success: true,
          adapter: existingAdapter,
          isNew: false,
          message: 'Adapter already exists',
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Check if platform is blocked
    const { data: blockedPlatform } = await supabaseClient
      .from('blocked_platforms')
      .select('*')
      .eq('domain', domain)
      .maybeSingle();

    if (blockedPlatform) {
      return new Response(
        JSON.stringify({
          success: false,
          error: `Platform is blocked: ${blockedPlatform.reason}`,
          isBlocked: true,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Fetch page content using Firecrawl
    console.log(`[ADAPTER-GEN] Fetching page content from ${url}`);
    const { markdown, links } = await fetchPageContent(url);

    if (!markdown || markdown.length < 100) {
      console.log(`[ADAPTER-GEN] Insufficient content fetched (${markdown.length} chars)`);
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Could not fetch sufficient page content for analysis',
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Analyze with AI to generate complete configuration
    console.log(`[ADAPTER-GEN] Analyzing platform with AI...`);
    const config = await analyzeWithAI(url, markdown, name);

    // Validate the generated URL rules
    const testCheckIn = checkIn || '2025-03-01';
    const testCheckOut = checkOut || '2025-03-05';
    const validation = await validateAdapter(url, config.urlParameterRules, testCheckIn, testCheckOut);

    console.log(`[ADAPTER-GEN] Validation result:`, validation);

    // Create new adapter with all new fields
    const { data: newAdapter, error: insertError } = await supabaseClient
      .from('platform_adapters')
      .insert({
        platform_name: name,
        platform_domain: domain,
        deep_link_template: config.deepLinkTemplate,
        date_format: config.dateFormat,
        requires_occupancy: config.requiresOccupancy,
        occupancy_params: config.occupancyParams,
        price_selectors: config.priceSelectors,
        validation_rules: config.validationRules,
        url_parameter_rules: config.urlParameterRules,
        navigation_hints: config.navigationHints,
        extraction_schema_overrides: config.extractionSchemaOverrides || null,
        reliability_score: validation.valid ? 0.5 : 0.3, // Higher score if validation passed
        is_active: true,
        is_ai_generated: true,
      })
      .select()
      .single();

    if (insertError) {
      throw new Error(`Failed to create adapter: ${insertError.message}`);
    }

    console.log(`[ADAPTER-GEN] Created new adapter for ${name}`);
    console.log(`[ADAPTER-GEN] URL rules:`, config.urlParameterRules);
    console.log(`[ADAPTER-GEN] Navigation hints:`, config.navigationHints);

    return new Response(
      JSON.stringify({
        success: true,
        adapter: newAdapter,
        isNew: true,
        validation,
        message: `New adapter created for ${name}`,
        config: {
          urlParameterRules: config.urlParameterRules,
          navigationHints: config.navigationHints,
        },
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[ADAPTER-GEN] Error:', error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
