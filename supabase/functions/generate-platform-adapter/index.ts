import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface AdapterRequest {
  url: string;
  platformName?: string;
}

// Use Lovable AI to analyze a platform and generate adapter configuration
async function analyzeWithAI(url: string, htmlSample: string, platformName: string): Promise<{
  deepLinkTemplate: string;
  dateFormat: string;
  requiresOccupancy: boolean;
  occupancyParams: Record<string, string>;
  priceSelectors: Record<string, string>;
  validationRules: Record<string, any>;
}> {
  const lovableApiKey = Deno.env.get('LOVABLE_API_KEY');
  
  if (!lovableApiKey) {
    throw new Error('LOVABLE_API_KEY not configured');
  }

  const systemPrompt = `You are an expert at analyzing booking platform websites and extracting URL patterns.
Given a URL and HTML sample from a booking platform, analyze the structure and return a JSON configuration for generating deep links with dates and occupancy.

You must return a valid JSON object with exactly these fields:
- deepLinkTemplate: URL template with placeholders {property_id}, {checkin}, {checkout}, {adults}, {children}, {rooms}
- dateFormat: One of "YYYY-MM-DD", "MM/DD/YYYY", "YYYY/MM/DD", "DD-MM-YYYY"
- requiresOccupancy: boolean - whether the platform requires guest count
- occupancyParams: Object mapping our params to platform's param names (e.g., {"adults_param": "adults", "children_param": "kids"})
- priceSelectors: CSS selectors for price elements (e.g., {"price": ".total-price", "total": "[data-testid='price']"})
- validationRules: Any validation patterns (e.g., {"property_id_pattern": "\\\\d+"})

Analyze URL patterns carefully. Look for date formats in query params, path segments with IDs, and occupancy parameters.`;

  const userPrompt = `Analyze this booking platform:

URL: ${url}

Platform Name: ${platformName}

HTML Sample (first 10000 chars):
${htmlSample.substring(0, 10000)}

Based on the URL structure and HTML, generate the adapter configuration. Return ONLY valid JSON, no markdown or explanation.`;

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
        temperature: 0.2,
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
    
    return {
      deepLinkTemplate: config.deepLinkTemplate || '',
      dateFormat: config.dateFormat || 'YYYY-MM-DD',
      requiresOccupancy: config.requiresOccupancy ?? true,
      occupancyParams: config.occupancyParams || {},
      priceSelectors: config.priceSelectors || {},
      validationRules: config.validationRules || {},
    };

  } catch (error) {
    console.error('AI analysis error:', error);
    throw error;
  }
}

// Fetch page HTML using Browserless
async function fetchPageHtml(url: string): Promise<string> {
  const browserlessApiKey = Deno.env.get('BROWSERLESS_API_KEY');
  
  if (!browserlessApiKey) {
    // Fallback to simple fetch
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });
    return await response.text();
  }

  const response = await fetch(`https://chrome.browserless.io/content?token=${browserlessApiKey}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url,
      gotoOptions: {
        waitUntil: 'networkidle2',
        timeout: 30000,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch page: ${response.status}`);
  }

  return await response.text();
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const { url, platformName } = await req.json() as AdapterRequest;

    if (!url) {
      return new Response(
        JSON.stringify({ success: false, error: 'URL is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const domain = extractDomain(url);
    const name = platformName || domain;

    console.log(`Generating adapter for platform: ${name} (${domain})`);

    // Check if adapter already exists
    const { data: existingAdapter } = await supabaseClient
      .from('platform_adapters')
      .select('*')
      .eq('platform_domain', domain)
      .maybeSingle();

    if (existingAdapter) {
      console.log(`Adapter already exists for ${domain}`);
      return new Response(
        JSON.stringify({
          success: true,
          adapter: existingAdapter,
          isNew: false,
          message: 'Adapter already exists for this platform',
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

    // Fetch page HTML
    console.log(`Fetching page HTML from ${url}`);
    const html = await fetchPageHtml(url);

    // Analyze with AI
    console.log(`Analyzing platform with AI...`);
    const config = await analyzeWithAI(url, html, name);

    // Create new adapter
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
        reliability_score: 0.3, // Start with low reliability until validated
        is_active: true,
        is_ai_generated: true,
      })
      .select()
      .single();

    if (insertError) {
      throw new Error(`Failed to create adapter: ${insertError.message}`);
    }

    console.log(`Created new adapter for ${name}`);

    return new Response(
      JSON.stringify({
        success: true,
        adapter: newAdapter,
        isNew: true,
        message: `New adapter created for ${name}`,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error generating adapter:', error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
