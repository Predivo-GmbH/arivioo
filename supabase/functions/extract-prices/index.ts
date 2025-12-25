import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Extraction status lifecycle states
type ExtractionStatus = 
  | 'pending'
  | 'running'
  | 'success'
  | 'blocked_captcha_or_bot'
  | 'blocked_rate_limit'
  | 'dates_not_applied'
  | 'price_not_found'
  | 'render_failed'
  | 'failed_unknown';

type PriceType = 'TOTAL_STAY' | 'NIGHTLY' | 'TOTAL_EXCL_TAX' | 'UNKNOWN';
type ExtractionStage = 'LISTING_PAGE' | 'ROOMS_PAGE' | 'CHECKOUT_REVIEW' | 'UNKNOWN';
type Provider = 'firecrawl' | 'zyte';

interface ExtractionRequest {
  searchId: string;
  resultIds?: string[];
  stream?: boolean;
}

interface ExtractionSchema {
  property_name?: string;
  checkin_date_detected?: string;
  checkout_date_detected?: string;
  total_price?: number | string;
  currency?: string;
  includes_taxes_fees?: boolean;
  price_type?: PriceType;
  extraction_stage?: ExtractionStage;
  evidence_snippets?: string[];
}

interface ProviderResult {
  success: boolean;
  data?: ExtractionSchema;
  evidence?: string[];
  finalUrl?: string;
  status: ExtractionStatus;
  error?: string;
  contentHash?: string;
  provider: Provider;
}

// SSE helpers
const encoder = new TextEncoder();

function sendSSE(controller: ReadableStreamDefaultController<Uint8Array>, event: string, data: any): boolean {
  try {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    controller.enqueue(encoder.encode(message));
    return true;
  } catch (e) {
    console.log("SSE send failed:", event, e);
    return false;
  }
}

// Simple hash for content deduplication/debugging
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}

// Default extraction schema for Firecrawl structured extraction
const DEFAULT_EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    property_name: { type: "string", description: "Name of the property/listing" },
    checkin_date_detected: { type: "string", description: "Check-in date shown on page (YYYY-MM-DD format)" },
    checkout_date_detected: { type: "string", description: "Check-out date shown on page (YYYY-MM-DD format)" },
    total_price: { type: "number", description: "Total price for the stay including all fees if visible" },
    currency: { type: "string", description: "Currency code (USD, EUR, GBP, etc.)" },
    includes_taxes_fees: { type: "boolean", description: "Whether the price includes taxes and fees" },
    price_type: { 
      type: "string", 
      enum: ["TOTAL_STAY", "NIGHTLY", "TOTAL_EXCL_TAX", "UNKNOWN"],
      description: "Type of price shown"
    },
    extraction_stage: {
      type: "string",
      enum: ["LISTING_PAGE", "ROOMS_PAGE", "CHECKOUT_REVIEW", "UNKNOWN"],
      description: "Which stage of booking flow the price was found"
    },
    evidence_snippets: {
      type: "array",
      items: { type: "string" },
      description: "Short text snippets from page that mention price and/or dates (max 5)"
    }
  },
  required: ["total_price", "currency", "includes_taxes_fees", "price_type"]
};

// AI prompt for extraction
function buildExtractionPrompt(platformName: string, requestedCheckIn: string, requestedCheckOut: string): string {
  return `You are extracting booking price information from a ${platformName} property page.

REQUESTED DATES: Check-in ${requestedCheckIn}, Check-out ${requestedCheckOut}

CRITICAL VALIDATION:
1. First verify if the page shows the SAME dates as requested (${requestedCheckIn} to ${requestedCheckOut})
2. If dates don't match or aren't shown, set checkin_date_detected and checkout_date_detected to what you see (or null)
3. Only extract price if you're confident it's for the shown dates

EXTRACT:
- total_price: The TOTAL price for the full stay (prefer total over per-night)
- currency: Currency code (USD, EUR, GBP, etc.)
- includes_taxes_fees: true if price includes "taxes & fees" or "final price"
- price_type: TOTAL_STAY (full stay), NIGHTLY (per night), TOTAL_EXCL_TAX, or UNKNOWN
- evidence_snippets: 3-5 short text snippets showing price and dates

IGNORE: Review counts, ratings, distances, unrelated prices

Return valid JSON matching the schema.`;
}

// ============= FIRECRAWL PROVIDER =============
async function extractWithFirecrawl(
  url: string,
  platformName: string,
  requestedCheckIn: string,
  requestedCheckOut: string,
  navigationHints?: string[],
  schemaOverrides?: Record<string, any>
): Promise<ProviderResult> {
  const firecrawlApiKey = Deno.env.get('FIRECRAWL_API_KEY') || Deno.env.get('FIRECRAWL_API_KEY_1');
  
  if (!firecrawlApiKey) {
    console.log('[FIRECRAWL] API key not configured');
    return {
      success: false,
      status: 'failed_unknown',
      error: 'Firecrawl API key not configured',
      provider: 'firecrawl'
    };
  }

  try {
    console.log(`[FIRECRAWL] Scraping ${url} for ${platformName}`);
    
    // Step A: Firecrawl scrape with JSON extraction
    const scrapeResponse = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${firecrawlApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url,
        formats: [
          'markdown',
          { 
            type: 'json', 
            schema: schemaOverrides || DEFAULT_EXTRACTION_SCHEMA,
            prompt: buildExtractionPrompt(platformName, requestedCheckIn, requestedCheckOut)
          }
        ],
        onlyMainContent: true,
        waitFor: 3000,
      }),
    });

    if (!scrapeResponse.ok) {
      const errorText = await scrapeResponse.text();
      console.error(`[FIRECRAWL] Scrape failed: ${scrapeResponse.status} - ${errorText}`);
      
      if (scrapeResponse.status === 429) {
        return { success: false, status: 'blocked_rate_limit', error: 'Firecrawl rate limit', provider: 'firecrawl' };
      }
      if (scrapeResponse.status === 402) {
        return { success: false, status: 'failed_unknown', error: 'Firecrawl insufficient credits', provider: 'firecrawl' };
      }
      
      return { success: false, status: 'render_failed', error: `Firecrawl error: ${scrapeResponse.status}`, provider: 'firecrawl' };
    }

    const scrapeData = await scrapeResponse.json();
    const markdown = scrapeData.data?.markdown || scrapeData.markdown || '';
    const extractedJson = scrapeData.data?.json || scrapeData.json;
    const finalUrl = scrapeData.data?.metadata?.sourceURL || url;
    const contentHash = simpleHash(markdown.slice(0, 5000));

    // Check for bot detection patterns
    const lowerMarkdown = markdown.toLowerCase();
    if (
      lowerMarkdown.includes('captcha') ||
      lowerMarkdown.includes('robot') ||
      lowerMarkdown.includes('verify you are human') ||
      lowerMarkdown.includes('access denied') ||
      lowerMarkdown.includes('blocked')
    ) {
      console.log('[FIRECRAWL] Bot/CAPTCHA detected in content');
      return {
        success: false,
        status: 'blocked_captcha_or_bot',
        error: 'Bot/CAPTCHA detected',
        provider: 'firecrawl',
        contentHash,
        finalUrl
      };
    }

    // Validate extracted data
    if (extractedJson && extractedJson.total_price) {
      const price = typeof extractedJson.total_price === 'string' 
        ? parseFloat(extractedJson.total_price.replace(/[^0-9.]/g, ''))
        : extractedJson.total_price;

      if (price && price > 0) {
        // Validate dates if detected
        const detectedCheckIn = extractedJson.checkin_date_detected;
        const detectedCheckOut = extractedJson.checkout_date_detected;
        
        if (detectedCheckIn && detectedCheckOut) {
          // Normalize dates for comparison
          const normalizeDate = (d: string) => d.replace(/\//g, '-').slice(0, 10);
          const reqIn = normalizeDate(requestedCheckIn);
          const reqOut = normalizeDate(requestedCheckOut);
          const detIn = normalizeDate(detectedCheckIn);
          const detOut = normalizeDate(detectedCheckOut);
          
          if (detIn !== reqIn || detOut !== reqOut) {
            console.log(`[FIRECRAWL] Date mismatch: requested ${reqIn}-${reqOut}, detected ${detIn}-${detOut}`);
            return {
              success: false,
              status: 'dates_not_applied',
              error: `Dates don't match: expected ${reqIn} to ${reqOut}, got ${detIn} to ${detOut}`,
              provider: 'firecrawl',
              data: extractedJson,
              evidence: extractedJson.evidence_snippets,
              contentHash,
              finalUrl
            };
          }
        }

        console.log(`[FIRECRAWL] Success: ${price} ${extractedJson.currency}`);
        return {
          success: true,
          status: 'success',
          provider: 'firecrawl',
          data: { ...extractedJson, total_price: price },
          evidence: extractedJson.evidence_snippets || [],
          contentHash,
          finalUrl
        };
      }
    }

    // Step B: If no price found, try link-following with navigation hints
    if (navigationHints && navigationHints.length > 0) {
      console.log(`[FIRECRAWL] No price found, attempting link-following with hints: ${navigationHints.join(', ')}`);
      
      // Use Firecrawl's links format to find navigation options
      const linksResponse = await fetch('https://api.firecrawl.dev/v1/scrape', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${firecrawlApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url,
          formats: ['links'],
          onlyMainContent: false,
        }),
      });

      if (linksResponse.ok) {
        const linksData = await linksResponse.json();
        const links = linksData.data?.links || linksData.links || [];
        
        // Find links matching navigation hints
        const matchingLinks = links.filter((link: string) => {
          const lowerLink = link.toLowerCase();
          return navigationHints.some(hint => lowerLink.includes(hint.toLowerCase()));
        }).slice(0, 3); // Max 3 links to follow

        for (const followLink of matchingLinks) {
          console.log(`[FIRECRAWL] Following link: ${followLink}`);
          
          const followResult = await fetch('https://api.firecrawl.dev/v1/scrape', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${firecrawlApiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              url: followLink,
              formats: [
                'markdown',
                { 
                  type: 'json', 
                  schema: schemaOverrides || DEFAULT_EXTRACTION_SCHEMA,
                  prompt: buildExtractionPrompt(platformName, requestedCheckIn, requestedCheckOut)
                }
              ],
              onlyMainContent: true,
              waitFor: 2000,
            }),
          });

          if (followResult.ok) {
            const followData = await followResult.json();
            const followJson = followData.data?.json || followData.json;
            
            if (followJson?.total_price) {
              const price = typeof followJson.total_price === 'string'
                ? parseFloat(followJson.total_price.replace(/[^0-9.]/g, ''))
                : followJson.total_price;

              if (price && price > 0) {
                console.log(`[FIRECRAWL] Found price via link-following: ${price} ${followJson.currency}`);
                return {
                  success: true,
                  status: 'success',
                  provider: 'firecrawl',
                  data: { ...followJson, total_price: price, extraction_stage: 'ROOMS_PAGE' },
                  evidence: followJson.evidence_snippets || [],
                  contentHash: simpleHash((followData.data?.markdown || '').slice(0, 5000)),
                  finalUrl: followLink
                };
              }
            }
          }
        }
      }
    }

    // No price found after all attempts
    console.log('[FIRECRAWL] Price not found after all attempts');
    return {
      success: false,
      status: 'price_not_found',
      error: 'No price found in page content',
      provider: 'firecrawl',
      contentHash,
      finalUrl
    };

  } catch (error) {
    console.error('[FIRECRAWL] Error:', error);
    return {
      success: false,
      status: 'failed_unknown',
      error: error instanceof Error ? error.message : 'Unknown Firecrawl error',
      provider: 'firecrawl'
    };
  }
}

// ============= ZYTE PROVIDER (FALLBACK) =============
async function extractWithZyte(
  url: string,
  platformName: string,
  requestedCheckIn: string,
  requestedCheckOut: string
): Promise<ProviderResult> {
  const zyteApiKey = Deno.env.get('ZYTE_API_KEY');
  
  if (!zyteApiKey) {
    console.log('[ZYTE] API key not configured');
    return {
      success: false,
      status: 'failed_unknown',
      error: 'Zyte API key not configured',
      provider: 'zyte'
    };
  }

  try {
    console.log(`[ZYTE] Extracting from ${url} for ${platformName}`);
    
    // Zyte API with AI extraction
    const response = await fetch('https://api.zyte.com/v1/extract', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${btoa(zyteApiKey + ':')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url,
        browserHtml: true,
        javascript: true,
        actions: [
          { action: 'waitForTimeout', timeout: 3000 }
        ],
        // Request AI-powered extraction
        customAttributes: {
          schema: DEFAULT_EXTRACTION_SCHEMA,
          prompt: buildExtractionPrompt(platformName, requestedCheckIn, requestedCheckOut)
        }
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[ZYTE] Request failed: ${response.status} - ${errorText}`);
      
      if (response.status === 429) {
        return { success: false, status: 'blocked_rate_limit', error: 'Zyte rate limit', provider: 'zyte' };
      }
      
      return { success: false, status: 'render_failed', error: `Zyte error: ${response.status}`, provider: 'zyte' };
    }

    const data = await response.json();
    const html = data.browserHtml || '';
    const customData = data.customAttributes;
    const contentHash = simpleHash(html.slice(0, 5000));

    // Check for bot detection
    const lowerHtml = html.toLowerCase();
    if (
      lowerHtml.includes('captcha') ||
      lowerHtml.includes('robot') ||
      lowerHtml.includes('verify you are human') ||
      lowerHtml.includes('access denied')
    ) {
      console.log('[ZYTE] Bot/CAPTCHA detected');
      return {
        success: false,
        status: 'blocked_captcha_or_bot',
        error: 'Bot/CAPTCHA detected by Zyte',
        provider: 'zyte',
        contentHash
      };
    }

    // Try to use AI-extracted custom attributes
    if (customData?.total_price) {
      const price = typeof customData.total_price === 'string'
        ? parseFloat(customData.total_price.replace(/[^0-9.]/g, ''))
        : customData.total_price;

      if (price && price > 0) {
        console.log(`[ZYTE] Success: ${price} ${customData.currency}`);
        return {
          success: true,
          status: 'success',
          provider: 'zyte',
          data: { ...customData, total_price: price },
          evidence: customData.evidence_snippets || [],
          contentHash,
          finalUrl: url
        };
      }
    }

    // Fallback: Use Lovable AI to extract from HTML
    const aiResult = await extractPriceWithAI(html, platformName, requestedCheckIn, requestedCheckOut);
    
    if (aiResult.price) {
      return {
        success: true,
        status: 'success',
        provider: 'zyte',
        data: {
          total_price: aiResult.price,
          currency: aiResult.currency,
          includes_taxes_fees: aiResult.includesTaxesFees,
          price_type: aiResult.priceType as PriceType,
          extraction_stage: 'UNKNOWN'
        },
        contentHash,
        finalUrl: url
      };
    }

    return {
      success: false,
      status: 'price_not_found',
      error: 'No price found by Zyte',
      provider: 'zyte',
      contentHash
    };

  } catch (error) {
    console.error('[ZYTE] Error:', error);
    return {
      success: false,
      status: 'failed_unknown',
      error: error instanceof Error ? error.message : 'Unknown Zyte error',
      provider: 'zyte'
    };
  }
}

// AI fallback for price extraction from HTML
async function extractPriceWithAI(
  html: string,
  platformName: string,
  checkIn: string,
  checkOut: string
): Promise<{ price: number | null; currency: string; priceType: string; includesTaxesFees: boolean }> {
  const lovableApiKey = Deno.env.get('LOVABLE_API_KEY');
  if (!lovableApiKey) {
    return { price: null, currency: 'USD', priceType: 'UNKNOWN', includesTaxesFees: false };
  }

  try {
    const prompt = `Extract booking price from this ${platformName} page.
Dates: ${checkIn} to ${checkOut}

HTML (first 8000 chars):
${html.slice(0, 8000)}

Return ONLY JSON: {"price": <number|null>, "currency": "USD"|"EUR"|etc, "priceType": "TOTAL_STAY"|"NIGHTLY"|"UNKNOWN", "includesTaxesFees": <boolean>}`;

    const response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${lovableApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 100,
      }),
    });

    if (!response.ok) {
      return { price: null, currency: 'USD', priceType: 'UNKNOWN', includesTaxesFees: false };
    }

    const data = await response.json();
    const resultText = data.choices?.[0]?.message?.content?.trim();

    if (resultText) {
      const jsonMatch = resultText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          price: parsed.price,
          currency: parsed.currency || 'USD',
          priceType: parsed.priceType || 'UNKNOWN',
          includesTaxesFees: parsed.includesTaxesFees || false,
        };
      }
    }

    return { price: null, currency: 'USD', priceType: 'UNKNOWN', includesTaxesFees: false };
  } catch (error) {
    console.error('[AI-FALLBACK] Error:', error);
    return { price: null, currency: 'USD', priceType: 'UNKNOWN', includesTaxesFees: false };
  }
}

// ============= MAIN EXTRACTION ORCHESTRATOR =============
async function extractPrice(
  url: string,
  platformName: string,
  requestedCheckIn: string,
  requestedCheckOut: string,
  navigationHints?: string[],
  schemaOverrides?: Record<string, any>
): Promise<ProviderResult> {
  // Step 1: Try Firecrawl (primary)
  console.log(`[EXTRACT] Starting extraction for ${platformName}: ${url}`);
  
  const firecrawlResult = await extractWithFirecrawl(
    url,
    platformName,
    requestedCheckIn,
    requestedCheckOut,
    navigationHints,
    schemaOverrides
  );

  if (firecrawlResult.success) {
    return firecrawlResult;
  }

  // Step 2: If Firecrawl fails with retryable status, try Zyte
  const retryableStatuses: ExtractionStatus[] = ['price_not_found', 'dates_not_applied', 'render_failed'];
  
  if (retryableStatuses.includes(firecrawlResult.status)) {
    console.log(`[EXTRACT] Firecrawl failed with ${firecrawlResult.status}, trying Zyte fallback`);
    
    const zyteResult = await extractWithZyte(url, platformName, requestedCheckIn, requestedCheckOut);
    
    if (zyteResult.success) {
      return zyteResult;
    }

    // If Zyte also fails with CAPTCHA/bot, use that status
    if (zyteResult.status === 'blocked_captcha_or_bot') {
      return zyteResult;
    }

    // Return Firecrawl result if Zyte also failed (preserve original error context)
    return {
      ...firecrawlResult,
      error: `Firecrawl: ${firecrawlResult.error}; Zyte: ${zyteResult.error}`
    };
  }

  // For non-retryable failures (blocked, etc.), return Firecrawl result directly
  return firecrawlResult;
}

// Calculate confidence score based on extraction quality
function calculateConfidence(result: ProviderResult, datesMatched: boolean): number {
  let score = 0.5; // Base score
  
  if (result.success) score += 0.2;
  if (datesMatched) score += 0.15;
  if (result.data?.includes_taxes_fees) score += 0.1;
  if (result.data?.price_type === 'TOTAL_STAY') score += 0.05;
  if (result.evidence && result.evidence.length > 0) score += 0.05;
  
  return Math.min(1, score);
}

// ============= MAIN HANDLER =============
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const { searchId, resultIds, stream = false } = await req.json() as ExtractionRequest;

    console.log(`[EXTRACT-PRICES] Starting Firecrawl-first extraction for search ${searchId}`);

    // Fetch search info for dates
    const { data: searchData } = await supabaseClient
      .from('searches')
      .select('check_in_date, check_out_date')
      .eq('id', searchId)
      .single();

    const requestedCheckIn = searchData?.check_in_date || '';
    const requestedCheckOut = searchData?.check_out_date || '';

    if (!requestedCheckIn || !requestedCheckOut) {
      console.log('[EXTRACT-PRICES] No dates found for search');
    }

    // Fetch pending price extractions
    let query = supabaseClient
      .from('price_extractions')
      .select('*, search_results(*)')
      .eq('search_id', searchId)
      .eq('extraction_status', 'pending');

    if (resultIds && resultIds.length > 0) {
      query = query.in('search_result_id', resultIds);
    }

    const { data: pendingExtractions, error: fetchError } = await query;

    if (fetchError) {
      throw new Error(`Failed to fetch pending extractions: ${fetchError.message}`);
    }

    if (!pendingExtractions || pendingExtractions.length === 0) {
      console.log(`[EXTRACT-PRICES] No pending extractions found`);
      return new Response(
        JSON.stringify({ success: true, results: [], message: 'No pending extractions' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[EXTRACT-PRICES] Processing ${pendingExtractions.length} extractions`);

    // Fetch platform adapters for navigation hints and schema overrides
    const { data: adapters } = await supabaseClient
      .from('platform_adapters')
      .select('platform_name, navigation_hints, extraction_schema_overrides');

    const adapterMap = new Map<string, { navigationHints?: string[]; schemaOverrides?: Record<string, any> }>();
    for (const adapter of (adapters || [])) {
      adapterMap.set(adapter.platform_name.toLowerCase(), {
        navigationHints: adapter.navigation_hints as string[] || undefined,
        schemaOverrides: adapter.extraction_schema_overrides as Record<string, any> || undefined
      });
    }

    // Default navigation hints for common platforms
    const defaultNavigationHints = ['availability', 'reserve', 'book', 'select room', 'price', 'checkout'];

    const results: any[] = [];

    // SSE streaming mode
    if (stream) {
      const responseStream = new ReadableStream({
        async start(controller) {
          sendSSE(controller, 'price_extraction_start', {
            totalPlatforms: pendingExtractions.length,
            platforms: pendingExtractions.map(e => e.platform_name),
          });

          for (let i = 0; i < pendingExtractions.length; i++) {
            const extraction = pendingExtractions[i];
            const platformKey = extraction.platform_name.toLowerCase();
            const adapterConfig = adapterMap.get(platformKey) || {};
            const navigationHints = adapterConfig.navigationHints || defaultNavigationHints;

            sendSSE(controller, 'price_extraction_progress', {
              platformName: extraction.platform_name,
              status: 'running',
              index: i + 1,
              total: pendingExtractions.length,
            });

            // Update status to running
            await supabaseClient
              .from('price_extractions')
              .update({ extraction_status: 'running' })
              .eq('id', extraction.id);

            // Extract price using Firecrawl-first pipeline
            const result = await extractPrice(
              extraction.deep_link,
              extraction.platform_name,
              requestedCheckIn,
              requestedCheckOut,
              navigationHints,
              adapterConfig.schemaOverrides
            );

            const datesMatched = result.data?.checkin_date_detected === requestedCheckIn;
            const confidence = calculateConfidence(result, datesMatched);

            // Update extraction record
            await supabaseClient
              .from('price_extractions')
              .update({
                extracted_price: result.data?.total_price || null,
                currency: result.data?.currency || 'USD',
                price_type: result.data?.price_type || 'UNKNOWN',
                includes_taxes_fees: result.data?.includes_taxes_fees || false,
                extraction_status: result.status,
                extraction_error: result.error,
                provider_used: result.provider,
                evidence_snippets: result.evidence || [],
                final_resolved_url: result.finalUrl,
                page_content_hash: result.contentHash,
                extraction_stage: result.data?.extraction_stage || 'UNKNOWN',
                confidence_score: confidence,
                extraction_metadata: {
                  extracted_at: new Date().toISOString(),
                  provider: result.provider,
                  dates_matched: datesMatched,
                },
              })
              .eq('id', extraction.id);

            // Update search result price if successful
            if (result.success && result.data?.total_price) {
              await supabaseClient
                .from('search_results')
                .update({ price: result.data.total_price })
                .eq('id', extraction.search_result_id);
            }

            sendSSE(controller, 'price_extraction_progress', {
              platformName: extraction.platform_name,
              status: result.status,
              price: result.data?.total_price,
              currency: result.data?.currency,
              provider: result.provider,
              error: result.error,
              index: i + 1,
              total: pendingExtractions.length,
            });

            results.push({
              resultId: extraction.search_result_id,
              platformName: extraction.platform_name,
              price: result.data?.total_price,
              currency: result.data?.currency,
              success: result.success,
              status: result.status,
              provider: result.provider,
            });

            // Rate limiting between extractions
            if (i < pendingExtractions.length - 1) {
              await new Promise(resolve => setTimeout(resolve, 1500));
            }
          }

          sendSSE(controller, 'price_extraction_complete', {
            totalExtracted: results.length,
            successful: results.filter(r => r.success).length,
            failed: results.filter(r => !r.success).length,
            results,
          });

          controller.close();
        },
      });

      return new Response(responseStream, {
        headers: {
          ...corsHeaders,
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
    }

    // Non-streaming batch mode
    const batchSize = 2; // Lower concurrency for stability
    for (let i = 0; i < pendingExtractions.length; i += batchSize) {
      const batch = pendingExtractions.slice(i, i + batchSize);

      const batchResults = await Promise.all(
        batch.map(async (extraction) => {
          const platformKey = extraction.platform_name.toLowerCase();
          const adapterConfig = adapterMap.get(platformKey) || {};
          const navigationHints = adapterConfig.navigationHints || defaultNavigationHints;

          await supabaseClient
            .from('price_extractions')
            .update({ extraction_status: 'running' })
            .eq('id', extraction.id);

          const result = await extractPrice(
            extraction.deep_link,
            extraction.platform_name,
            requestedCheckIn,
            requestedCheckOut,
            navigationHints,
            adapterConfig.schemaOverrides
          );

          const datesMatched = result.data?.checkin_date_detected === requestedCheckIn;
          const confidence = calculateConfidence(result, datesMatched);

          await supabaseClient
            .from('price_extractions')
            .update({
              extracted_price: result.data?.total_price || null,
              currency: result.data?.currency || 'USD',
              price_type: result.data?.price_type || 'UNKNOWN',
              includes_taxes_fees: result.data?.includes_taxes_fees || false,
              extraction_status: result.status,
              extraction_error: result.error,
              provider_used: result.provider,
              evidence_snippets: result.evidence || [],
              final_resolved_url: result.finalUrl,
              page_content_hash: result.contentHash,
              extraction_stage: result.data?.extraction_stage || 'UNKNOWN',
              confidence_score: confidence,
              extraction_metadata: {
                extracted_at: new Date().toISOString(),
                provider: result.provider,
                dates_matched: datesMatched,
              },
            })
            .eq('id', extraction.id);

          if (result.success && result.data?.total_price) {
            await supabaseClient
              .from('search_results')
              .update({ price: result.data.total_price })
              .eq('id', extraction.search_result_id);
          }

          console.log(`[EXTRACT-PRICES] ${extraction.platform_name}: ${result.status} via ${result.provider} - ${result.data?.total_price}`);

          return {
            resultId: extraction.search_result_id,
            platformName: extraction.platform_name,
            price: result.data?.total_price,
            currency: result.data?.currency,
            success: result.success,
            status: result.status,
            provider: result.provider,
          };
        })
      );

      results.push(...batchResults);

      if (i + batchSize < pendingExtractions.length) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    console.log(`[EXTRACT-PRICES] Complete: ${successful} successful, ${failed} failed`);

    return new Response(
      JSON.stringify({
        success: true,
        results,
        summary: { total: results.length, successful, failed },
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[EXTRACT-PRICES] Error:', error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
