import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

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
  error?: string;
}

// Use Browserless to load page and extract price
async function extractPriceWithBrowserless(
  deepLink: string,
  platformName: string,
  priceSelectors: Record<string, string>
): Promise<{ price: number | null; currency: string; priceType: string; includesTaxesFees: boolean; error?: string }> {
  const browserlessApiKey = Deno.env.get('BROWSERLESS_API_KEY');
  
  if (!browserlessApiKey) {
    return { price: null, currency: 'USD', priceType: 'UNKNOWN', includesTaxesFees: false, error: 'Browserless API key not configured' };
  }

  try {
    console.log(`Extracting price from ${deepLink} for platform ${platformName}`);

    // Construct the extraction script based on platform selectors
    const selectors = priceSelectors || {};
    const priceSelector = selectors.price || selectors.total || '[data-testid*="price"], .price, .rate-price';

    const browserlessPayload = {
      url: deepLink,
      gotoOptions: {
        waitUntil: 'networkidle2',
        timeout: 30000,
      },
      waitForSelector: {
        selector: priceSelector,
        timeout: 15000,
      },
      elements: [
        {
          selector: priceSelector,
          timeout: 10000,
        }
      ],
    };

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
      return { price: null, currency: 'USD', priceType: 'UNKNOWN', includesTaxesFees: false, error: `Browserless error: ${response.status}` };
    }

    const htmlContent = await response.text();
    
    // Extract price from HTML content
    const priceResult = extractPriceFromHtml(htmlContent, platformName);
    
    return priceResult;

  } catch (error) {
    console.error(`Error extracting price from ${deepLink}:`, error);
    return { price: null, currency: 'USD', priceType: 'UNKNOWN', includesTaxesFees: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

// Extract price from HTML content
function extractPriceFromHtml(html: string, platformName: string): { price: number | null; currency: string; priceType: string; includesTaxesFees: boolean } {
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

// Alternative: Use function API for more control
async function extractPriceWithFunction(
  deepLink: string,
  platformName: string,
  priceSelectors: Record<string, string>
): Promise<{ price: number | null; currency: string; priceType: string; includesTaxesFees: boolean; error?: string }> {
  const browserlessApiKey = Deno.env.get('BROWSERLESS_API_KEY');
  
  if (!browserlessApiKey) {
    return { price: null, currency: 'USD', priceType: 'UNKNOWN', includesTaxesFees: false, error: 'Browserless API key not configured' };
  }

  const extractionScript = `
    module.exports = async ({ page }) => {
      await page.goto('${deepLink}', { waitUntil: 'networkidle2', timeout: 30000 });
      
      // Wait for any price elements to load
      await page.waitForTimeout(3000);
      
      // Extract all text content
      const bodyText = await page.evaluate(() => document.body.innerText);
      
      // Try to find price elements
      const priceData = await page.evaluate(() => {
        const priceSelectors = [
          '[data-testid*="price"]',
          '.price', '.rate-price', '.total-price',
          '[class*="price"]', '[class*="Price"]',
          '[data-price]', '[data-amount]',
        ];
        
        let prices = [];
        for (const selector of priceSelectors) {
          const elements = document.querySelectorAll(selector);
          elements.forEach(el => {
            const text = el.textContent;
            if (text) {
              const matches = text.match(/[\$€£¥₹]?\s*([\d,]+(?:\.\d{2})?)/g);
              if (matches) prices.push(...matches);
            }
          });
        }
        
        return { prices, html: document.body.innerHTML.substring(0, 50000) };
      });
      
      return priceData;
    };
  `;

  try {
    const response = await fetch(`https://chrome.browserless.io/function?token=${browserlessApiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        code: extractionScript,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Browserless function error: ${response.status} - ${errorText}`);
      return { price: null, currency: 'USD', priceType: 'UNKNOWN', includesTaxesFees: false, error: `Browserless error: ${response.status}` };
    }

    const result = await response.json();
    
    // Parse the extracted HTML
    if (result.html) {
      return extractPriceFromHtml(result.html, platformName);
    }

    return { price: null, currency: 'USD', priceType: 'UNKNOWN', includesTaxesFees: false, error: 'No price data extracted' };

  } catch (error) {
    console.error(`Error in function extraction:`, error);
    return { price: null, currency: 'USD', priceType: 'UNKNOWN', includesTaxesFees: false, error: error instanceof Error ? error.message : 'Unknown error' };
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

    console.log(`Starting price extraction for search ${searchId}`);

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
      return new Response(
        JSON.stringify({ success: true, results: [], message: 'No pending extractions found' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

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

          // Update status to processing
          await supabaseClient
            .from('price_extractions')
            .update({ extraction_status: 'processing' })
            .eq('id', extraction.id);

          // Extract price using Browserless
          const extractionResult = await extractPriceWithBrowserless(
            extraction.deep_link,
            platformName,
            priceSelectors
          );

          // Update extraction record
          await supabaseClient
            .from('price_extractions')
            .update({
              extracted_price: extractionResult.price,
              currency: extractionResult.currency,
              price_type: extractionResult.priceType,
              includes_taxes_fees: extractionResult.includesTaxesFees,
              extraction_status: extractionResult.price ? 'completed' : 'failed',
              extraction_error: extractionResult.error,
              extraction_metadata: {
                extracted_at: new Date().toISOString(),
                method: 'browserless',
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

          return {
            resultId: extraction.search_result_id,
            platformName: extraction.platform_name,
            deepLink: extraction.deep_link,
            price: extractionResult.price,
            currency: extractionResult.currency,
            priceType: extractionResult.priceType as any,
            includesTaxesFees: extractionResult.includesTaxesFees,
            success: !!extractionResult.price,
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

    console.log(`Price extraction complete: ${successful} successful, ${failed} failed`);

    return new Response(
      JSON.stringify({
        success: true,
        results,
        summary: {
          total: results.length,
          successful,
          failed,
        },
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in price extraction:', error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
