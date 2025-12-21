import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Extraction status lifecycle states
type ExtractionStatus = 
  | 'pending'           // Waiting to be processed
  | 'running'           // Currently being extracted
  | 'success'           // Price successfully extracted
  | 'blocked_captcha'   // Blocked by CAPTCHA
  | 'blocked_rate_limit'// Rate limited by platform
  | 'dates_not_applied' // Could not apply requested dates
  | 'price_not_found'   // Page loaded but no price found
  | 'failed_unknown';   // Unknown failure

interface ExtractionRequest {
  searchId: string;
  resultIds?: string[]; // Optional: specific results to extract, otherwise all pending
}

interface PriceExtractionResult {
  resultId: string;
  platformName: string;
  deepLink: string;
  price: number | null;
  currency: string;
  priceType: 'TOTAL_STAY' | 'NIGHTLY' | 'PARTIAL' | 'UNKNOWN';
  includesTaxesFees: boolean;
  success: boolean;
  status: ExtractionStatus;
  error?: string;
}

// Determine extraction status based on error type
function determineExtractionStatus(
  price: number | null,
  error?: string,
  html?: string
): ExtractionStatus {
  if (price !== null && price > 0) {
    return 'success';
  }

  if (!error && !html) {
    return 'failed_unknown';
  }

  const errorLower = (error || '').toLowerCase();
  const htmlLower = (html || '').toLowerCase();

  // Check for CAPTCHA
  if (
    errorLower.includes('captcha') ||
    htmlLower.includes('captcha') ||
    htmlLower.includes('robot') ||
    htmlLower.includes('verify you are human')
  ) {
    return 'blocked_captcha';
  }

  // Check for rate limiting
  if (
    errorLower.includes('rate limit') ||
    errorLower.includes('too many requests') ||
    errorLower.includes('429')
  ) {
    return 'blocked_rate_limit';
  }

  // Check for date issues
  if (
    errorLower.includes('date') ||
    errorLower.includes('unavailable') ||
    htmlLower.includes('dates not available') ||
    htmlLower.includes('no availability')
  ) {
    return 'dates_not_applied';
  }

  // If we got HTML but no price
  if (html && html.length > 1000) {
    return 'price_not_found';
  }

  return 'failed_unknown';
}

// Use Browserless to load page and extract price
async function extractPriceWithBrowserless(
  deepLink: string,
  platformName: string,
  priceSelectors: Record<string, string>
): Promise<{ 
  price: number | null; 
  currency: string; 
  priceType: string; 
  includesTaxesFees: boolean; 
  status: ExtractionStatus;
  error?: string;
  html?: string;
}> {
  const browserlessApiKey = Deno.env.get('BROWSERLESS_API_KEY');
  
  if (!browserlessApiKey) {
    return { 
      price: null, 
      currency: 'USD', 
      priceType: 'UNKNOWN', 
      includesTaxesFees: false, 
      status: 'failed_unknown',
      error: 'Browserless API key not configured' 
    };
  }

  try {
    console.log(`Extracting price from ${deepLink} for platform ${platformName}`);

    // Use Browserless content API to get page content
    const response = await fetch(`https://chrome.browserless.io/content?token=${browserlessApiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: deepLink,
        gotoOptions: {
          waitUntil: 'networkidle2',
          timeout: 30000,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Browserless error: ${response.status} - ${errorText}`);
      
      // Check for rate limiting from Browserless itself
      if (response.status === 429) {
        return { 
          price: null, 
          currency: 'USD', 
          priceType: 'UNKNOWN', 
          includesTaxesFees: false, 
          status: 'blocked_rate_limit',
          error: `Browserless rate limit: ${response.status}` 
        };
      }
      
      return { 
        price: null, 
        currency: 'USD', 
        priceType: 'UNKNOWN', 
        includesTaxesFees: false, 
        status: 'failed_unknown',
        error: `Browserless error: ${response.status}` 
      };
    }

    const htmlContent = await response.text();
    
    // Extract price from HTML content
    const priceResult = extractPriceFromHtml(htmlContent, platformName);
    const status = determineExtractionStatus(priceResult.price, undefined, htmlContent);
    
    return {
      ...priceResult,
      status,
      html: htmlContent.substring(0, 5000), // Store truncated HTML for debugging
    };

  } catch (error) {
    console.error(`Error extracting price from ${deepLink}:`, error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { 
      price: null, 
      currency: 'USD', 
      priceType: 'UNKNOWN', 
      includesTaxesFees: false, 
      status: determineExtractionStatus(null, errorMessage),
      error: errorMessage 
    };
  }
}

// Extract price from HTML content
function extractPriceFromHtml(html: string, platformName: string): { 
  price: number | null; 
  currency: string; 
  priceType: string; 
  includesTaxesFees: boolean;
} {
  // Common price patterns across platforms
  const pricePatterns = [
    // Currency symbol before number: $123, €123, £123
    /[\$€£¥₹][\s]*([\d,]+(?:\.\d{2})?)/g,
    // Number with currency code: 123 USD, 123 EUR
    /([\d,]+(?:\.\d{2})?)\s*(USD|EUR|GBP|JPY|INR|AUD|CAD)/gi,
    // Total price patterns
    /total[:\s]+[\$€£¥₹]?\s*([\d,]+(?:\.\d{2})?)/gi,
    /price[:\s]+[\$€£¥₹]?\s*([\d,]+(?:\.\d{2})?)/gi,
    // Per night patterns
    /per\s*night[:\s]+[\$€£¥₹]?\s*([\d,]+(?:\.\d{2})?)/gi,
    /([\d,]+(?:\.\d{2})?)\s*\/\s*night/gi,
  ];

  let currency = 'USD';
  let priceType = 'UNKNOWN';
  let includesTaxesFees = false;

  // Detect currency from HTML
  if (html.includes('€') || html.toLowerCase().includes('eur')) currency = 'EUR';
  else if (html.includes('£') || html.toLowerCase().includes('gbp')) currency = 'GBP';
  else if (html.includes('¥') || html.toLowerCase().includes('jpy')) currency = 'JPY';
  else if (html.includes('₹') || html.toLowerCase().includes('inr')) currency = 'INR';

  // Detect if taxes/fees included
  const taxPatterns = /incl(udes?|uding)?\s*(taxes?|fees?)|taxes?\s*(&|and)\s*fees?\s*incl/gi;
  includesTaxesFees = taxPatterns.test(html);

  // Detect price type
  if (/total\s*(stay)?\s*price/gi.test(html)) priceType = 'TOTAL_STAY';
  else if (/per\s*night|\/\s*night/gi.test(html)) priceType = 'NIGHTLY';

  // Extract all prices and find the most likely total
  const prices: number[] = [];

  for (const pattern of pricePatterns) {
    let match;
    const regex = new RegExp(pattern.source, pattern.flags);
    while ((match = regex.exec(html)) !== null) {
      const priceStr = match[1].replace(/,/g, '');
      const price = parseFloat(priceStr);
      if (!isNaN(price) && price > 0 && price < 100000) {
        prices.push(price);
      }
    }
  }

  if (prices.length === 0) {
    return { price: null, currency, priceType, includesTaxesFees };
  }

  // Heuristic: The largest reasonable price is often the total
  // Filter out extremely small prices (likely per night) and very large (likely errors)
  const filteredPrices = prices.filter(p => p > 50);
  const price = filteredPrices.length > 0 ? Math.max(...filteredPrices) : prices[0];

  return { price, currency, priceType: priceType === 'UNKNOWN' ? 'TOTAL_STAY' : priceType, includesTaxesFees };
}

// Retry configuration
const RETRY_DELAYS: Record<string, number> = {
  failed_unknown: 30000,      // 30 seconds
  blocked_rate_limit: 60000,  // 1 minute
};
const MAX_RETRIES = 2;

// Check and trigger retries for failed extractions
async function checkAndRetryFailedExtractions(
  supabaseClient: any,
  searchId: string
): Promise<void> {
  console.log(`[RETRY] Checking for retryable extractions for search ${searchId}`);

  // Find extractions that need retry
  const { data: failedExtractions, error } = await supabaseClient
    .from('price_extractions')
    .select('*')
    .eq('search_id', searchId)
    .in('extraction_status', ['failed_unknown', 'blocked_rate_limit']);

  if (error || !failedExtractions || failedExtractions.length === 0) {
    console.log(`[RETRY] No retryable extractions found`);
    return;
  }

  console.log(`[RETRY] Found ${failedExtractions.length} extractions to potentially retry`);

  for (const extraction of failedExtractions as any[]) {
    const metadata = (extraction.extraction_metadata as Record<string, unknown>) || {};
    const retryCount = (metadata.retry_count as number) || 0;

    if (retryCount >= MAX_RETRIES) {
      console.log(`[RETRY] Skipping ${extraction.platform_name} - max retries (${MAX_RETRIES}) reached`);
      continue;
    }

    const lastAttempt = metadata.extracted_at ? new Date(metadata.extracted_at as string).getTime() : 0;
    const retryDelay = RETRY_DELAYS[extraction.extraction_status] || 30000;
    const now = Date.now();

    if (now - lastAttempt < retryDelay) {
      console.log(`[RETRY] Skipping ${extraction.platform_name} - retry delay not elapsed`);
      continue;
    }

    console.log(`[RETRY] Scheduling retry for ${extraction.platform_name} (attempt ${retryCount + 1}/${MAX_RETRIES})`);

    // Reset to pending with incremented retry count
    await supabaseClient
      .from('price_extractions')
      .update({
        extraction_status: 'pending',
        extraction_metadata: {
          ...metadata,
          retry_count: retryCount + 1,
          last_retry_at: new Date().toISOString(),
          previous_status: extraction.extraction_status,
        },
      })
      .eq('id', extraction.id);
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

    const { searchId, resultIds } = await req.json() as ExtractionRequest;

    console.log(`[EXTRACT-PRICES] Starting price extraction for search ${searchId}`);

    // First, check for failed extractions that need retry
    await checkAndRetryFailedExtractions(supabaseClient, searchId);

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
      console.log(`[EXTRACT-PRICES] No pending extractions found for search ${searchId}`);
      return new Response(
        JSON.stringify({ success: true, results: [], message: 'No pending extractions found' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[EXTRACT-PRICES] Found ${pendingExtractions.length} pending extractions`);

    // Fetch platform adapters for selectors
    const { data: adapters } = await supabaseClient
      .from('platform_adapters')
      .select('platform_name, price_selectors');

    const adapterMap = new Map<string, Record<string, string>>();
    for (const adapter of (adapters || [])) {
      adapterMap.set(adapter.platform_name, adapter.price_selectors || {});
    }

    const results: PriceExtractionResult[] = [];

    // Process extractions with rate limiting (max 3 concurrent)
    const batchSize = 3;
    for (let i = 0; i < pendingExtractions.length; i += batchSize) {
      const batch = pendingExtractions.slice(i, i + batchSize);

      const batchResults = await Promise.all(
        batch.map(async (extraction) => {
          const platformName = extraction.platform_name.toLowerCase();
          const priceSelectors = adapterMap.get(platformName) || {};
          const metadata = extraction.extraction_metadata as Record<string, unknown> || {};
          const retryCount = (metadata.retry_count as number) || 0;

          // Update status to 'running'
          await supabaseClient
            .from('price_extractions')
            .update({ extraction_status: 'running' })
            .eq('id', extraction.id);

          // Extract price using Browserless
          const extractionResult = await extractPriceWithBrowserless(
            extraction.deep_link,
            platformName,
            priceSelectors
          );

          // Update extraction record with final status
          await supabaseClient
            .from('price_extractions')
            .update({
              extracted_price: extractionResult.price,
              currency: extractionResult.currency,
              price_type: extractionResult.priceType,
              includes_taxes_fees: extractionResult.includesTaxesFees,
              extraction_status: extractionResult.status,
              extraction_error: extractionResult.error,
              extraction_metadata: {
                ...metadata,
                extracted_at: new Date().toISOString(),
                method: 'browserless',
                retry_count: retryCount,
                html_snippet: extractionResult.html?.substring(0, 1000),
              },
            })
            .eq('id', extraction.id);

          // If we got a price, update the search result as well
          if (extractionResult.price) {
            await supabaseClient
              .from('search_results')
              .update({
                price: extractionResult.price,
              })
              .eq('id', extraction.search_result_id);
          }

          console.log(`[EXTRACT-PRICES] ${extraction.platform_name}: ${extractionResult.status} - price: ${extractionResult.price} (retry: ${retryCount})`);

          return {
            resultId: extraction.search_result_id,
            platformName: extraction.platform_name,
            deepLink: extraction.deep_link,
            price: extractionResult.price,
            currency: extractionResult.currency,
            priceType: extractionResult.priceType as any,
            includesTaxesFees: extractionResult.includesTaxesFees,
            success: extractionResult.status === 'success',
            status: extractionResult.status,
            error: extractionResult.error,
          };
        })
      );

      results.push(...batchResults);

      // Rate limiting: wait between batches
      if (i + batchSize < pendingExtractions.length) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    // Group results by status for summary
    const statusSummary: Record<string, number> = {};
    for (const r of results) {
      statusSummary[r.status] = (statusSummary[r.status] || 0) + 1;
    }

    console.log(`[EXTRACT-PRICES] Complete: ${successful} successful, ${failed} failed`);
    console.log(`[EXTRACT-PRICES] Status breakdown:`, statusSummary);

    return new Response(
      JSON.stringify({
        success: true,
        results,
        summary: {
          total: results.length,
          successful,
          failed,
          byStatus: statusSummary,
        },
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
