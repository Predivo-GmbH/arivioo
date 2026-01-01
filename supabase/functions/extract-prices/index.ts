import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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

// Extraction status lifecycle states (Phase B: only after dates validated)
type ExtractionStatus = 
  | 'pending'                      // Initial state
  | 'awaiting_validation'          // Waiting for Phase A
  | 'running'                      // Phase B in progress
  | 'success'                      // Price extracted successfully
  | 'dates_not_applied'            // Phase A failed - dates not applied
  | 'no_availability_for_dates'    // Phase A found dates unavailable
  | 'price_not_found_after_dates_applied'  // Phase B: dates OK but no price
  | 'blocked_captcha_or_bot'       // Blocked by anti-bot
  | 'blocked_rate_limit'           // Rate limited
  | 'render_failed'                // Page didn't render
  | 'failed_unknown';              // Unknown failure

type PriceType = 'TOTAL_STAY' | 'NIGHTLY' | 'TOTAL_EXCL_TAX' | 'UNKNOWN';
type ExtractionStage = 'LISTING_PAGE' | 'ROOMS_PAGE' | 'CHECKOUT_REVIEW' | 'UNKNOWN';
type Provider = 'firecrawl' | 'zyte';

interface ExtractionRequest {
  searchId: string;
  resultIds?: string[];
  stream?: boolean;
  requireValidation?: boolean;  // If true, only process validated extractions
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

// AI prompt for extraction - CRITICAL: Must extract ONLY from actual page content
function buildExtractionPrompt(platformName: string, requestedCheckIn: string, requestedCheckOut: string): string {
  return `You are extracting booking price information from a ${platformName} property page.

REQUESTED DATES: Check-in ${requestedCheckIn}, Check-out ${requestedCheckOut}

CRITICAL EXTRACTION RULES:
1. ONLY extract prices that are EXPLICITLY visible in the page content
2. DO NOT invent, guess, or fabricate any prices
3. If you cannot find a clear total price, set total_price to null
4. evidence_snippets MUST be EXACT quotes copied verbatim from the page content

PRICE EXTRACTION PRIORITY:
1. Look for "total", "trip total", "stay total", "for X nights", "final price" labels
2. If only per-night price is visible without a total, set total_price to null and note this in evidence
3. NEVER multiply per-night by nights yourself - only use totals shown on page

EXTRACT:
- total_price: The TOTAL price for the full stay (ONLY if explicitly shown as a total, otherwise null)
- currency: Currency code (USD, EUR, GBP, etc.)
- includes_taxes_fees: true ONLY if page explicitly says "includes taxes" or "final price"
- price_type: TOTAL_STAY (explicit total), NIGHTLY (only per-night shown), UNKNOWN
- evidence_snippets: 3-5 EXACT VERBATIM quotes from the page showing price text

CRITICAL: If unsure or no clear total visible, return total_price as null.

Return valid JSON matching the schema.`;
}

// ============= BOOKING.COM GROUND-TRUTH EXTRACTION =============
// This is the golden path: extract real, verified prices with hallucination protection

interface BookingComTotal {
  amount: number;
  currency: string;
  context: string;
  nightCount: number;
}

/**
 * Extract all "for N nights" totals from Booking.com content
 * This uses regex patterns to find real prices, not AI inference
 */
function extractBookingComTotals(markdown: string, expectedNights: number): { 
  allTotals: BookingComTotal[];
  lowestTotal: BookingComTotal | null;
} {
  const patterns = [
    // $1,234 for 4 nights
    /(\$|US\$|USD\s*)([\d,]+(?:\.\d{2})?)\s*(?:for|\/)\s*(\d+)\s*nights?/gi,
    // US$ 1,234 for 4 nights  
    /(US\$|USD)\s*([\d,]+(?:\.\d{2})?)\s*(?:for|\/)\s*(\d+)\s*nights?/gi,
  ];
  
  const totals: BookingComTotal[] = [];
  const seen = new Set<string>();
  
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(markdown)) !== null) {
      const currency = 'USD'; // Booking.com US shows USD
      const amount = parseFloat(match[2].replace(/,/g, ''));
      const nights = parseInt(match[3]);
      
      // Only include if nights match expected AND amount is reasonable
      if (nights === expectedNights && amount > 50 && amount < 100000) {
        const key = `${amount}`;
        if (!seen.has(key)) {
          seen.add(key);
          
          // Get context snippet (verbatim from content)
          const matchIndex = match.index;
          const contextStart = Math.max(0, matchIndex - 20);
          const contextEnd = Math.min(markdown.length, matchIndex + match[0].length + 40);
          const context = markdown.slice(contextStart, contextEnd).replace(/\n/g, ' ').trim();
          
          totals.push({ amount, currency, context, nightCount: nights });
        }
      }
    }
  }
  
  // Sort by amount to find lowest
  totals.sort((a, b) => a.amount - b.amount);
  
  return {
    allTotals: totals,
    lowestTotal: totals.length > 0 ? totals[0] : null,
  };
}

/**
 * Validate that extracted price exists verbatim in content (hallucination guard)
 */
function validatePriceVerbatimInContent(markdown: string, price: number): {
  found: boolean;
  evidenceSnippet: string | null;
} {
  const priceStr = price.toLocaleString('en-US');
  const priceFormats = [
    `$${priceStr}`,
    `$${price}`,
    `US$${priceStr}`,
    `US$ ${priceStr}`,
    priceStr,
    price.toString(),
  ];
  
  for (const format of priceFormats) {
    const index = markdown.indexOf(format);
    if (index >= 0) {
      const start = Math.max(0, index - 30);
      const end = Math.min(markdown.length, index + format.length + 50);
      const snippet = markdown.slice(start, end).replace(/\n/g, ' ').trim();
      return { found: true, evidenceSnippet: snippet };
    }
  }
  
  return { found: false, evidenceSnippet: null };
}

/**
 * Check if page is in price-eligible state (Booking.com specific)
 */
function isBookingComPriceEligible(markdown: string): { eligible: boolean; reason: string } {
  const lowerMarkdown = markdown.toLowerCase();
  
  // Negative: page needs dates
  const needsDates = [
    'enter dates to see prices',
    'select dates to see prices',
    'enter your dates',
    'choose your dates',
  ];
  for (const phrase of needsDates) {
    if (lowerMarkdown.includes(phrase)) {
      return { eligible: false, reason: `Page shows "${phrase}"` };
    }
  }
  
  // Positive: has price totals
  if (/\$[\d,]+\s*(?:for|\/)\s*\d+\s*nights?/i.test(markdown)) {
    return { eligible: true, reason: 'Found total price patterns' };
  }
  
  return { eligible: false, reason: 'No price patterns detected' };
}

// Build date selection actions for platforms that require JS interaction
function buildDateSelectionActions(platformName: string, checkIn: string, checkOut: string): any[] {
  const platformLower = platformName.toLowerCase();
  
  // Agoda-specific date selection
  if (platformLower.includes('agoda')) {
    return [
      { type: 'wait', milliseconds: 2000 },
      // Click on check-in field
      { type: 'click', selector: '[data-selenium="checkInInput"], #check-in-box, .SearchBoxTextDescription__title' },
      { type: 'wait', milliseconds: 1000 },
      // Type check-in date
      { type: 'write', selector: 'input[data-selenium="checkInDate"], input[placeholder*="Check"]', text: checkIn },
      { type: 'wait', milliseconds: 500 },
      // Press enter to confirm
      { type: 'press', key: 'Enter' },
      { type: 'wait', milliseconds: 1000 },
      // Type check-out date
      { type: 'write', selector: 'input[data-selenium="checkOutDate"]', text: checkOut },
      { type: 'press', key: 'Enter' },
      { type: 'wait', milliseconds: 2000 },
      // Click search/update button
      { type: 'click', selector: 'button[data-selenium="searchButton"], button:contains("Update"), .SearchBoxSubmit' },
      { type: 'wait', milliseconds: 3000 },
    ];
  }
  
  // Booking.com date selection
  if (platformLower.includes('booking')) {
    return [
      { type: 'wait', milliseconds: 2000 },
      { type: 'click', selector: '[data-testid="date-display-field-start"], .bui-calendar' },
      { type: 'wait', milliseconds: 1000 },
    ];
  }
  
  // Default: no actions, rely on URL params
  return [];
}

// ============= FIRECRAWL PROVIDER =============
async function extractWithFirecrawl(
  url: string,
  platformName: string,
  requestedCheckIn: string,
  requestedCheckOut: string,
  navigationHints?: string[],
  schemaOverrides?: Record<string, any>,
  useActions: boolean = false
): Promise<ProviderResult> {
  const firecrawlApiKey = Deno.env.get('FIRECRAWL_API_KEY_1') || Deno.env.get('FIRECRAWL_API_KEY');
  
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
    console.log(`[FIRECRAWL] Scraping ${url} for ${platformName} (useActions: ${useActions})`);
    
    // Build actions if platform requires JS interaction for date selection
    const actions = useActions ? buildDateSelectionActions(platformName, requestedCheckIn, requestedCheckOut) : [];
    
    if (actions.length > 0) {
      console.log(`[FIRECRAWL] Using ${actions.length} actions for date selection on ${platformName}`);
    }
    
    // Add timeout to Firecrawl request (35s when using actions, 25s otherwise)
    const timeoutMs = actions.length > 0 ? 35000 : 25000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    
    let scrapeResponse: Response;
    try {
      // Firecrawl scrape with optional actions and JSON extraction
      const requestBody: any = {
        url,
        formats: ['markdown', 'extract'],
        extract: {
          schema: schemaOverrides || DEFAULT_EXTRACTION_SCHEMA,
          prompt: buildExtractionPrompt(platformName, requestedCheckIn, requestedCheckOut)
        },
        onlyMainContent: true,
        waitFor: actions.length > 0 ? 5000 : 3000,
      };
      
      // Add actions if we have them
      if (actions.length > 0) {
        requestBody.actions = actions;
      }
      
      scrapeResponse = await fetch('https://api.firecrawl.dev/v1/scrape', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${firecrawlApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
    } catch (fetchError) {
      clearTimeout(timeoutId);
      const errorMsg = fetchError instanceof Error ? fetchError.message : 'Unknown error';
      console.error(`[FIRECRAWL] Fetch error: ${errorMsg}`);
      // Return render_failed to trigger Zyte fallback
      return { 
        success: false, 
        status: 'render_failed', 
        error: errorMsg.includes('aborted') ? 'Firecrawl timeout (25s)' : `Firecrawl fetch error: ${errorMsg}`,
        provider: 'firecrawl'
      };
    }
    
    clearTimeout(timeoutId);

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
    const extractedJson = scrapeData.data?.extract || scrapeData.extract;
    const finalUrl = scrapeData.data?.metadata?.sourceURL || url;
    const contentHash = simpleHash(markdown.slice(0, 5000));

    // Log actual content sample for debugging variance issues
    console.log(`[FIRECRAWL] Content sample (first 500 chars): ${markdown.slice(0, 500)}`);
    console.log(`[FIRECRAWL] Content hash: ${contentHash}, length: ${markdown.length}`);

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

    // ============= BOOKING.COM GOLDEN PATH: GROUND-TRUTH EXTRACTION =============
    // For Booking.com, use regex-based extraction with hallucination guard
    // This bypasses AI extraction to ensure grounded, verifiable prices
    const platformLower = platformName.toLowerCase();
    if (platformLower.includes('booking.com') || platformLower === 'booking') {
      console.log('[FIRECRAWL] Using Booking.com golden path extraction');
      
      // Check if page is in price-eligible state
      const priceEligible = isBookingComPriceEligible(markdown);
      if (!priceEligible.eligible) {
        console.log(`[FIRECRAWL] Booking.com not price-eligible: ${priceEligible.reason}`);
        return {
          success: false,
          status: 'dates_not_applied',
          error: priceEligible.reason,
          provider: 'firecrawl',
          contentHash,
          finalUrl
        };
      }
      
      // Calculate expected nights
      const checkInDate = new Date(requestedCheckIn);
      const checkOutDate = new Date(requestedCheckOut);
      const expectedNights = Math.round((checkOutDate.getTime() - checkInDate.getTime()) / (1000 * 60 * 60 * 24));
      
      console.log(`[FIRECRAWL] Looking for prices "for ${expectedNights} nights"`);
      
      // Extract all totals using ground-truth regex
      const { allTotals, lowestTotal } = extractBookingComTotals(markdown, expectedNights);
      
      console.log(`[FIRECRAWL] Found ${allTotals.length} total prices: ${allTotals.map(t => `$${t.amount}`).join(', ')}`);
      
      if (!lowestTotal) {
        console.log('[FIRECRAWL] No "for N nights" totals found');
        return {
          success: false,
          status: 'price_not_found_after_dates_applied',
          error: `No "for ${expectedNights} nights" total prices found in content`,
          provider: 'firecrawl',
          contentHash,
          finalUrl,
          evidence: [`Content sample: ${markdown.slice(0, 500)}`]
        };
      }
      
      // HALLUCINATION GUARD: Verify price exists verbatim
      const validation = validatePriceVerbatimInContent(markdown, lowestTotal.amount);
      if (!validation.found) {
        console.log(`[FIRECRAWL] HALLUCINATION GUARD FAILED: $${lowestTotal.amount} not found verbatim`);
        return {
          success: false,
          status: 'price_not_found_after_dates_applied',
          error: `Price $${lowestTotal.amount} not found verbatim in content`,
          provider: 'firecrawl',
          contentHash,
          finalUrl
        };
      }
      
      // Check for taxes/fees indicator
      const taxPatterns = [/includes taxes/i, /incl\. taxes/i, /taxes and fees included/i];
      const includesTaxesFees = taxPatterns.some(p => p.test(markdown));
      
      console.log(`[FIRECRAWL] Booking.com SUCCESS: $${lowestTotal.amount} (verified, lowest of ${allTotals.length} options)`);
      
      return {
        success: true,
        status: 'success',
        provider: 'firecrawl',
        data: {
          total_price: lowestTotal.amount,
          currency: lowestTotal.currency,
          includes_taxes_fees: includesTaxesFees,
          price_type: 'TOTAL_STAY' as PriceType,
          extraction_stage: 'LISTING_PAGE' as ExtractionStage,
          checkin_date_detected: requestedCheckIn,
          checkout_date_detected: requestedCheckOut,
          evidence_snippets: [validation.evidenceSnippet || lowestTotal.context]
        },
        evidence: [validation.evidenceSnippet || lowestTotal.context],
        contentHash,
        finalUrl
      };
    }
    // ============= END BOOKING.COM GOLDEN PATH =============

    // Validate extracted data (for non-Booking.com platforms)
    if (extractedJson && extractedJson.total_price) {
      const price = typeof extractedJson.total_price === 'string' 
        ? parseFloat(extractedJson.total_price.replace(/[^0-9.]/g, ''))
        : extractedJson.total_price;

      if (price && price > 0) {
        // CRITICAL: Validate evidence snippets exist in actual markdown
        const evidence = extractedJson.evidence_snippets || [];
        const validatedEvidence: string[] = [];
        let evidenceValidationPassed = false;
        
        for (const snippet of evidence) {
          // Check if snippet text (ignoring whitespace/formatting) appears in markdown
          const normalizedSnippet = snippet.toLowerCase().replace(/[\s\n\r]+/g, ' ').trim();
          const normalizedMarkdown = markdown.toLowerCase().replace(/[\s\n\r]+/g, ' ');
          
          // Look for key price text from snippet in actual content
          const priceMatch = normalizedSnippet.match(/\$[\d,]+(?:\.\d{2})?/);
          if (priceMatch && normalizedMarkdown.includes(priceMatch[0])) {
            validatedEvidence.push(snippet);
            evidenceValidationPassed = true;
          } else if (normalizedMarkdown.includes(normalizedSnippet.slice(0, 30))) {
            // Partial match on beginning of snippet
            validatedEvidence.push(snippet);
            evidenceValidationPassed = true;
          }
        }
        
        // Also search markdown directly for the extracted price
        const priceStr = `$${price}`;
        const priceInContent = markdown.includes(priceStr) || 
                              markdown.includes(price.toString()) ||
                              markdown.includes(price.toLocaleString());
        
        console.log(`[FIRECRAWL] Price validation - Price in content: ${priceInContent}, Evidence validated: ${evidenceValidationPassed}`);
        console.log(`[FIRECRAWL] Looking for price: ${priceStr} or ${price}`);
        
        if (!priceInContent && !evidenceValidationPassed) {
          console.log(`[FIRECRAWL] REJECTED: Price ${price} not found in actual page content - likely AI hallucination`);
          return {
            success: false,
            status: 'price_not_found_after_dates_applied',
            error: `Extracted price $${price} not found in actual page content (likely AI hallucination)`,
            provider: 'firecrawl',
            contentHash,
            finalUrl,
            evidence: [`Content sample: ${markdown.slice(0, 300)}`]
          };
        }

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
              evidence: validatedEvidence.length > 0 ? validatedEvidence : extractedJson.evidence_snippets,
              contentHash,
              finalUrl
            };
          }
        }

        console.log(`[FIRECRAWL] Success: ${price} ${extractedJson.currency} (verified in content)`);
        return {
          success: true,
          status: 'success',
          provider: 'firecrawl',
          data: { ...extractedJson, total_price: price },
          evidence: validatedEvidence.length > 0 ? validatedEvidence : extractedJson.evidence_snippets,
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
              formats: ['markdown', 'extract'],
              extract: {
                schema: schemaOverrides || DEFAULT_EXTRACTION_SCHEMA,
                prompt: buildExtractionPrompt(platformName, requestedCheckIn, requestedCheckOut)
              },
              onlyMainContent: true,
              waitFor: 2000,
            }),
          });

          if (followResult.ok) {
            const followData = await followResult.json();
            const followJson = followData.data?.extract || followData.extract;
            
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
      status: 'price_not_found_after_dates_applied',
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
      status: 'price_not_found_after_dates_applied',
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
  // Step 1: Try Firecrawl without actions first (URL params may work)
  console.log(`[EXTRACT] Starting extraction for ${platformName}: ${url}`);
  
  const firecrawlResult = await extractWithFirecrawl(
    url,
    platformName,
    requestedCheckIn,
    requestedCheckOut,
    navigationHints,
    schemaOverrides,
    false // no actions first
  );

  if (firecrawlResult.success) {
    return firecrawlResult;
  }

  // Step 2: If price not found, retry with actions for date selection
  const needsActionsStatuses: ExtractionStatus[] = ['price_not_found_after_dates_applied', 'dates_not_applied'];
  
  if (needsActionsStatuses.includes(firecrawlResult.status)) {
    console.log(`[EXTRACT] Firecrawl found no price, retrying WITH date selection actions for ${platformName}`);
    
    const firecrawlWithActionsResult = await extractWithFirecrawl(
      url,
      platformName,
      requestedCheckIn,
      requestedCheckOut,
      navigationHints,
      schemaOverrides,
      true // use actions
    );
    
    if (firecrawlWithActionsResult.success) {
      return firecrawlWithActionsResult;
    }
    
    // If actions also failed, try Zyte
    console.log(`[EXTRACT] Firecrawl with actions failed with ${firecrawlWithActionsResult.status}, trying Zyte fallback`);
    
    const zyteResult = await extractWithZyte(url, platformName, requestedCheckIn, requestedCheckOut);
    
    if (zyteResult.success) {
      return zyteResult;
    }

    // If Zyte also fails with CAPTCHA/bot, use that status
    if (zyteResult.status === 'blocked_captcha_or_bot') {
      return zyteResult;
    }

    // Return firecrawl with actions result if both failed
    return {
      ...firecrawlWithActionsResult,
      error: `Firecrawl: ${firecrawlWithActionsResult.error}; Zyte: ${zyteResult.error}`
    };
  }

  // Step 3: If Firecrawl fails with other retryable status, try Zyte
  const retryableStatuses: ExtractionStatus[] = ['render_failed', 'failed_unknown'];
  
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

    const { searchId, resultIds, stream = false, requireValidation = false } = await req.json() as ExtractionRequest;

    console.log(`[EXTRACT-PRICES] Starting Phase B extraction for search ${searchId} (requireValidation: ${requireValidation})`);

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
    // If requireValidation is true, only process extractions where dates_validated = true
    let query = supabaseClient
      .from('price_extractions')
      .select('*, search_results(*)')
      .eq('search_id', searchId)
      .eq('extraction_status', 'pending');

    if (requireValidation) {
      query = query.eq('dates_validated', true);
    }

    if (resultIds && resultIds.length > 0) {
      query = query.in('search_result_id', resultIds);
    }

    const { data: pendingExtractions, error: fetchError } = await query;

    if (fetchError) {
      throw new Error(`Failed to fetch pending extractions: ${fetchError.message}`);
    }

    if (!pendingExtractions || pendingExtractions.length === 0) {
      // Check if there are unvalidated extractions
      const { count: unvalidatedCount } = await supabaseClient
        .from('price_extractions')
        .select('*', { count: 'exact', head: true })
        .eq('search_id', searchId)
        .eq('dates_validated', false)
        .in('extraction_status', ['pending', 'awaiting_validation']);

      if (unvalidatedCount && unvalidatedCount > 0) {
        console.log(`[EXTRACT-PRICES] ${unvalidatedCount} extractions awaiting date validation`);
        return new Response(
          JSON.stringify({ 
            success: true, 
            results: [], 
            message: `${unvalidatedCount} extractions awaiting date validation (Phase A)`,
            awaitingValidation: unvalidatedCount,
          }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      console.log(`[EXTRACT-PRICES] No pending extractions found`);
      return new Response(
        JSON.stringify({ success: true, results: [], message: 'No pending extractions' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[EXTRACT-PRICES] Processing ${pendingExtractions.length} validated extractions`);

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
