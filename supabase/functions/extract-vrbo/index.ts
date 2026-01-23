import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

/**
 * ============================================================================
 * VRBO ZYTE-FIRST GOLDEN PATH EXTRACTOR v2.0
 * ============================================================================
 * 
 * GOLDEN PATH: Navigate from property page → checkout/session → extract Total
 * 
 * FLOW:
 * 1. Start from property URL (e.g., https://www.vrbo.com/9836046ha)
 * 2. Apply dates via URL params
 * 3. Use Zyte browser actions to click Reserve/Book CTA
 * 4. Follow navigation to checkout/session page
 * 5. Extract "Total" amount (not nightly, not subtotal, not deposit)
 * 
 * Based on VRBO_LIVE_ACCESS_CHECK: Zyte is the only viable provider.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Terminal status values
type TerminalStatus = 
  | 'success_total_stay'
  | 'success_partial'
  | 'dates_unavailable'
  | 'blocked_captcha_or_bot'
  | 'blocked_rate_limit'
  | 'quota_error'
  | 'page_not_reached'
  | 'checkout_not_reached'
  | 'total_price_not_found'
  | 'nightly_only_rejected'
  | 'render_failed'
  | 'validation_error'
  | 'timeout';

type FailureCategory = 
  | 'blocked'
  | 'captcha'
  | 'quota_error'
  | 'params_missing'
  | 'selector_not_found'
  | 'checkout_not_reached'
  | 'no_total_label'
  | 'nightly_only'
  | 'unavailable'
  | 'render_error'
  | 'timeout'
  | 'success';

type Provider = 'zyte' | 'browserless' | 'firecrawl';

interface ProviderAttemptTrace {
  provider: Provider;
  attempted: boolean;
  attemptIndex: number;
  startedAt: string | null;
  endedAt: string | null;
  outcome: string;
  httpStatus: number | null;
  contentLength: number | null;
  errorMessage: string | null;
  urlUsed: string | null;
  finalUrl: string | null;
}

interface StructuralProof {
  property_page_reached: boolean;
  checkout_session_reached: boolean;
  dates_injected: boolean;
  dates_visible_on_page: boolean;
  total_label_found: boolean;
  nightly_rate_found: boolean;
  subtotal_found: boolean;
  due_now_found: boolean;
  deposit_found: boolean;
  cleaning_fee_found: boolean;
  service_fee_found: boolean;
  taxes_visible: boolean;
  directly_comparable: boolean;
  proof_version: string;
  currency_detected: string | null;
  nights_detected: number | null;
  entry_url_used: string | null;
  dated_property_url: string | null;
  final_url: string | null;
  content_hash: string | null;
  failure_category: FailureCategory;
  extraction_method: string | null;
  competing_amounts: Record<string, number | null>;
}

interface ExtractionRequest {
  extractionId?: string;
  url?: string;
  checkIn: string;
  checkOut: string;
  adults?: number;
  children?: number;
  rooms?: number;
}

interface ExtractionResult {
  success: boolean;
  status: TerminalStatus;
  failureCategory: FailureCategory;
  extractedPrice: number | null;
  currency: string | null;
  originalAmount: number | null;
  originalCurrency: string | null;
  conversionRate: number | null;
  includesTaxesFees: boolean | null;
  directlyComparable: boolean;
  evidenceSnippet: string | null;
  structuralProof: StructuralProof;
  durationMs: number;
  error: string | null;
  providerAttempts: ProviderAttemptTrace[];
  goldenPath: boolean;
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

function calculateNights(checkIn: string, checkOut: string): number {
  const start = new Date(checkIn);
  const end = new Date(checkOut);
  const diffTime = end.getTime() - start.getTime();
  return Math.max(1, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));
}

function buildVrboUrl(baseUrl: string, checkIn: string, checkOut: string, adults: number = 2, children: number = 0): string {
  try {
    const url = new URL(baseUrl);
    // VRBO uses startDate/endDate and arrival/departure
    url.searchParams.set('startDate', checkIn);
    url.searchParams.set('endDate', checkOut);
    url.searchParams.set('adults', String(adults));
    if (children > 0) {
      url.searchParams.set('children', String(children));
    }
    return url.toString();
  } catch (e) {
    const separator = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${separator}startDate=${checkIn}&endDate=${checkOut}&adults=${adults}`;
  }
}

function detectBlockSignals(content: string): string | null {
  if (/captcha|recaptcha|hcaptcha/i.test(content)) return 'captcha';
  if (/verify you are human|verify you're human/i.test(content)) return 'human_verification';
  if (/checking your browser/i.test(content)) return 'browser_check';
  if (/access denied/i.test(content)) return 'access_denied';
  return null;
}

function isCheckoutSessionUrl(url: string): boolean {
  if (!url) return false;
  const lowerUrl = url.toLowerCase();
  return lowerUrl.includes('/checkout') || 
         lowerUrl.includes('/book/') ||
         lowerUrl.includes('/session/') ||
         lowerUrl.includes('tripid=') ||
         lowerUrl.includes('checkouttoken=') ||
         lowerUrl.includes('/reserve/');
}

// ============================================================================
// VRBO PRICE EXTRACTION - STRICT TOTAL ONLY
// ============================================================================

interface VrboPriceResult {
  totalFound: boolean;
  totalPrice: number | null;
  currency: string | null;
  totalEvidence: string | null;
  directlyComparable: boolean;
  // Competing amounts (for logging what was found instead)
  nightlyRate: number | null;
  subtotal: number | null;
  dueNow: number | null;
  deposit: number | null;
  cleaningFee: number | null;
  serviceFee: number | null;
  taxesAmount: number | null;
  // What labels were found
  labelsFound: string[];
}

function extractVrboTotal(content: string, nights: number): VrboPriceResult {
  const result: VrboPriceResult = {
    totalFound: false,
    totalPrice: null,
    currency: null,
    totalEvidence: null,
    directlyComparable: false,
    nightlyRate: null,
    subtotal: null,
    dueNow: null,
    deposit: null,
    cleaningFee: null,
    serviceFee: null,
    taxesAmount: null,
    labelsFound: [],
  };

  // Helper to parse price
  const parsePrice = (text: string): number | null => {
    const match = text.match(/\$?\s*([\d,]+(?:\.\d{2})?)/);
    if (match) {
      const val = parseFloat(match[1].replace(/,/g, ''));
      return isNaN(val) ? null : val;
    }
    return null;
  };

  // =========================================================================
  // PRIORITY 1: Find explicit "Total" label with price
  // This is the ONLY directly comparable price
  // =========================================================================
  
  // Look for patterns like "Total $2,167.40" or "Total: $2,167.40"
  const totalPatterns = [
    /\bTotal[:\s]*\$\s*([\d,]+(?:\.\d{2})?)/gi,
    /\bTotal\s+\$?([\d,]+(?:\.\d{2})?)/gi,
    /\$\s*([\d,]+(?:\.\d{2})?)\s*Total\b/gi,
  ];

  for (const pattern of totalPatterns) {
    const matches = [...content.matchAll(pattern)];
    for (const match of matches) {
      // Exclude "Subtotal", "Due now total", etc.
      const context = content.slice(Math.max(0, match.index! - 30), match.index! + match[0].length + 10);
      if (/subtotal|due\s*now|deposit|pay\s*now|per\s*night|nightly/i.test(context)) {
        continue;
      }
      
      const price = parseFloat(match[1].replace(/,/g, ''));
      if (!isNaN(price) && price > 100) { // Total should be substantial
        result.totalFound = true;
        result.totalPrice = price;
        result.currency = 'USD';
        result.totalEvidence = context.trim().slice(0, 150);
        result.directlyComparable = true;
        result.labelsFound.push('Total');
        
        console.log(`[VRBO] total_label_found=true extracted_total=${price} currency=USD evidence="${result.totalEvidence}"`);
        return result;
      }
    }
  }

  // =========================================================================
  // FALLBACK: Detect competing amounts (for error logging)
  // These are NOT directly comparable
  // =========================================================================

  // Nightly rate
  const nightlyMatch = content.match(/\$\s*([\d,]+(?:\.\d{2})?)\s*(?:\/?\s*)?(?:per\s*)?night/i);
  if (nightlyMatch) {
    result.nightlyRate = parsePrice(nightlyMatch[0]);
    result.labelsFound.push('nightly');
  }

  // Subtotal
  const subtotalMatch = content.match(/subtotal[:\s]*\$\s*([\d,]+(?:\.\d{2})?)/i);
  if (subtotalMatch) {
    result.subtotal = parsePrice(subtotalMatch[0]);
    result.labelsFound.push('subtotal');
  }

  // Due now / Pay now
  const dueNowMatch = content.match(/(?:due\s*now|pay\s*now)[:\s]*\$\s*([\d,]+(?:\.\d{2})?)/i);
  if (dueNowMatch) {
    result.dueNow = parsePrice(dueNowMatch[0]);
    result.labelsFound.push('due_now');
  }

  // Deposit
  const depositMatch = content.match(/deposit[:\s]*\$\s*([\d,]+(?:\.\d{2})?)/i);
  if (depositMatch) {
    result.deposit = parsePrice(depositMatch[0]);
    result.labelsFound.push('deposit');
  }

  // Cleaning fee
  const cleaningMatch = content.match(/cleaning\s*fee[:\s]*\$\s*([\d,]+(?:\.\d{2})?)/i);
  if (cleaningMatch) {
    result.cleaningFee = parsePrice(cleaningMatch[0]);
    result.labelsFound.push('cleaning_fee');
  }

  // Service fee
  const serviceMatch = content.match(/service\s*fee[:\s]*\$\s*([\d,]+(?:\.\d{2})?)/i);
  if (serviceMatch) {
    result.serviceFee = parsePrice(serviceMatch[0]);
    result.labelsFound.push('service_fee');
  }

  // Taxes
  const taxesMatch = content.match(/taxes?(?:\s*&\s*fees?)?[:\s]*\$\s*([\d,]+(?:\.\d{2})?)/i);
  if (taxesMatch) {
    result.taxesAmount = parsePrice(taxesMatch[0]);
    result.labelsFound.push('taxes');
  }

  console.log(`[VRBO] total_label_found=false competing_amounts: nightly=${result.nightlyRate}, subtotal=${result.subtotal}, due_now=${result.dueNow}, deposit=${result.deposit}`);
  
  return result;
}

// ============================================================================
// ZYTE EXTRACTION WITH NAVIGATION
// ============================================================================

async function extractWithZyteNavigation(propertyUrl: string, datedUrl: string, nights: number): Promise<{
  success: boolean;
  propertyPageReached: boolean;
  checkoutSessionReached: boolean;
  content: string;
  html: string;
  httpStatus: number | null;
  error: string | null;
  finalUrl: string | null;
  durationMs: number;
}> {
  const start = Date.now();
  const result = {
    success: false,
    propertyPageReached: false,
    checkoutSessionReached: false,
    content: '',
    html: '',
    httpStatus: null as number | null,
    error: null as string | null,
    finalUrl: null as string | null,
    durationMs: 0,
  };

  try {
    const apiKey = Deno.env.get('ZYTE_API_KEY');
    if (!apiKey) {
      result.error = 'ZYTE_API_KEY not configured';
      result.durationMs = Date.now() - start;
      return result;
    }

    console.log(`[VRBO] url_in=${propertyUrl}`);
    console.log(`[VRBO] dated_property_url=${datedUrl}`);

    const zyteAuth = btoa(apiKey + ':');
    
    // =========================================================================
    // STEP 1: Load property page with dates and click through to checkout
    // =========================================================================
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120000); // 2min timeout

    // Zyte browser actions to:
    // 1. Navigate to dated property page
    // 2. Wait for content to load
    // 3. Click the primary booking CTA (Reserve/Book/Continue)
    // 4. Wait for navigation to checkout
    // 5. Extract final page content
    
    const response = await fetch('https://api.zyte.com/v1/extract', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${zyteAuth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: datedUrl,
        browserHtml: true,
        javascript: true,
        actions: [
          // Wait for page to fully load
          { action: 'waitForTimeout', timeout: 8 },
          
          // Click primary booking button - use simple CSS selector
          // VRBO uses data-stid attributes for booking buttons
          {
            action: 'click',
            selector: {
              type: 'css',
              value: 'button[data-stid="submit-hotel-reserve"]'
            }
          },
          
          // Wait for navigation/loading
          { action: 'waitForTimeout', timeout: 5 },
          
          // Wait for page content to stabilize
          { action: 'waitForTimeout', timeout: 5 },
        ],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    result.httpStatus = response.status;
    result.durationMs = Date.now() - start;

    if (!response.ok) {
      const errText = await response.text();
      result.error = `HTTP ${response.status}: ${errText.slice(0, 200)}`;
      console.log(`[VRBO] Zyte navigation failed: ${result.error}`);
      return result;
    }

    const data = await response.json();
    result.html = data.browserHtml || '';
    result.content = result.html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    result.finalUrl = data.url || datedUrl;
    result.propertyPageReached = result.html.length > 10000;
    result.checkoutSessionReached = isCheckoutSessionUrl(result.finalUrl || '');

    console.log(`[VRBO] final_url=${result.finalUrl}`);
    console.log(`[VRBO] reached_checkout_session=${result.checkoutSessionReached}`);
    console.log(`[VRBO] Zyte navigation complete: ${result.html.length} bytes, ${result.durationMs}ms`);

    // =========================================================================
    // STEP 2: If not at checkout, try a second navigation attempt
    // =========================================================================
    
    if (!result.checkoutSessionReached && result.propertyPageReached) {
      console.log('[VRBO] Not at checkout, attempting second navigation...');
      
      // Look for checkout/booking links in the current content
      const checkoutLinkMatch = result.html.match(/href=["']([^"']*(?:checkout|book|reserve|session)[^"']*)["']/i);
      
      if (checkoutLinkMatch) {
        let checkoutUrl = checkoutLinkMatch[1];
        if (checkoutUrl.startsWith('/')) {
          checkoutUrl = 'https://www.vrbo.com' + checkoutUrl;
        }
        
        console.log(`[VRBO] Found checkout link, navigating to: ${checkoutUrl.slice(0, 100)}...`);
        
        const controller2 = new AbortController();
        const timeoutId2 = setTimeout(() => controller2.abort(), 60000);
        
        try {
          const response2 = await fetch('https://api.zyte.com/v1/extract', {
            method: 'POST',
            headers: {
              'Authorization': `Basic ${zyteAuth}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              url: checkoutUrl,
              browserHtml: true,
              javascript: true,
              actions: [
                { action: 'waitForTimeout', timeout: 8 },
              ],
            }),
            signal: controller2.signal,
          });
          
          clearTimeout(timeoutId2);
          
          if (response2.ok) {
            const data2 = await response2.json();
            const html2 = data2.browserHtml || '';
            const url2 = data2.url || checkoutUrl;
            
            if (html2.length > result.html.length / 2) {
              result.html = html2;
              result.content = html2.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
              result.finalUrl = url2;
              result.checkoutSessionReached = isCheckoutSessionUrl(url2 || '');
              result.durationMs = Date.now() - start;
              
              console.log(`[VRBO] Second navigation: final_url=${url2}, reached_checkout=${result.checkoutSessionReached}`);
            }
          }
        } catch (e) {
          console.log(`[VRBO] Second navigation failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    result.success = result.propertyPageReached;

  } catch (e) {
    result.durationMs = Date.now() - start;
    if (e instanceof Error && e.name === 'AbortError') {
      result.error = 'Timeout after 120s';
    } else {
      result.error = e instanceof Error ? e.message : String(e);
    }
    console.log(`[VRBO] Zyte error: ${result.error}`);
  }

  return result;
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();
  const providerAttempts: ProviderAttemptTrace[] = [];

  // Initialize result
  const result: ExtractionResult = {
    success: false,
    status: 'validation_error',
    failureCategory: 'params_missing',
    extractedPrice: null,
    currency: null,
    originalAmount: null,
    originalCurrency: null,
    conversionRate: null,
    includesTaxesFees: null,
    directlyComparable: false,
    evidenceSnippet: null,
    structuralProof: {
      property_page_reached: false,
      checkout_session_reached: false,
      dates_injected: false,
      dates_visible_on_page: false,
      total_label_found: false,
      nightly_rate_found: false,
      subtotal_found: false,
      due_now_found: false,
      deposit_found: false,
      cleaning_fee_found: false,
      service_fee_found: false,
      taxes_visible: false,
      directly_comparable: false,
      proof_version: 'vrbo-zyte-nav-v2.0',
      currency_detected: null,
      nights_detected: null,
      entry_url_used: null,
      dated_property_url: null,
      final_url: null,
      content_hash: null,
      failure_category: 'params_missing',
      extraction_method: null,
      competing_amounts: {},
    },
    durationMs: 0,
    error: null,
    providerAttempts: [],
    goldenPath: false,
  };

  try {
    const body: ExtractionRequest = await req.json();
    const { extractionId, url, checkIn, checkOut, adults = 2, children = 0 } = body;

    console.log(`[VRBO] Extraction request: url_in=${url}`);
    console.log(`[VRBO] Dates: ${checkIn} to ${checkOut}, adults: ${adults}`);

    // Validate inputs
    if (!url || !checkIn || !checkOut) {
      result.error = 'Missing required parameters: url, checkIn, checkOut';
      result.durationMs = Date.now() - startTime;
      return new Response(JSON.stringify(result), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const nights = calculateNights(checkIn, checkOut);
    result.structuralProof.nights_detected = nights;
    result.structuralProof.entry_url_used = url;

    // Build URL with dates
    const datedUrl = buildVrboUrl(url, checkIn, checkOut, adults, children);
    result.structuralProof.dated_property_url = datedUrl;
    result.structuralProof.dates_injected = true;

    // ========================================================================
    // ZYTE-FIRST GOLDEN PATH WITH NAVIGATION
    // ========================================================================
    
    const zyteAttempt: ProviderAttemptTrace = {
      provider: 'zyte',
      attempted: true,
      attemptIndex: 0,
      startedAt: new Date().toISOString(),
      endedAt: null,
      outcome: 'skipped',
      httpStatus: null,
      contentLength: null,
      errorMessage: null,
      urlUsed: datedUrl,
      finalUrl: null,
    };

    const zyteResult = await extractWithZyteNavigation(url, datedUrl, nights);
    
    zyteAttempt.endedAt = new Date().toISOString();
    zyteAttempt.httpStatus = zyteResult.httpStatus;
    zyteAttempt.contentLength = zyteResult.html.length;
    zyteAttempt.finalUrl = zyteResult.finalUrl;

    result.structuralProof.property_page_reached = zyteResult.propertyPageReached;
    result.structuralProof.checkout_session_reached = zyteResult.checkoutSessionReached;
    result.structuralProof.final_url = zyteResult.finalUrl;

    if (zyteResult.success) {
      zyteAttempt.outcome = 'success';
      result.structuralProof.content_hash = simpleHash(zyteResult.html);

      // Check for block signals
      const blockSignal = detectBlockSignals(zyteResult.content);
      if (blockSignal) {
        zyteAttempt.outcome = 'bot_blocked';
        zyteAttempt.errorMessage = blockSignal;
        result.status = 'blocked_captcha_or_bot';
        result.failureCategory = blockSignal === 'captcha' ? 'captcha' : 'blocked';
        result.error = `Blocked: ${blockSignal}`;
      } else {
        // Extract TOTAL price only
        const priceResult = extractVrboTotal(zyteResult.content, nights);
        
        result.structuralProof.total_label_found = priceResult.totalFound;
        result.structuralProof.nightly_rate_found = priceResult.nightlyRate !== null;
        result.structuralProof.subtotal_found = priceResult.subtotal !== null;
        result.structuralProof.due_now_found = priceResult.dueNow !== null;
        result.structuralProof.deposit_found = priceResult.deposit !== null;
        result.structuralProof.cleaning_fee_found = priceResult.cleaningFee !== null;
        result.structuralProof.service_fee_found = priceResult.serviceFee !== null;
        result.structuralProof.taxes_visible = priceResult.taxesAmount !== null;
        
        result.structuralProof.competing_amounts = {
          nightly: priceResult.nightlyRate,
          subtotal: priceResult.subtotal,
          due_now: priceResult.dueNow,
          deposit: priceResult.deposit,
          cleaning_fee: priceResult.cleaningFee,
          service_fee: priceResult.serviceFee,
          taxes: priceResult.taxesAmount,
        };

        if (priceResult.totalFound && priceResult.totalPrice && priceResult.directlyComparable) {
          // SUCCESS - Total price found from "Total" label
          result.success = true;
          result.status = 'success_total_stay';
          result.failureCategory = 'success';
          result.extractedPrice = priceResult.totalPrice;
          result.currency = priceResult.currency;
          result.originalAmount = priceResult.totalPrice;
          result.originalCurrency = priceResult.currency;
          result.conversionRate = 1.0;
          result.includesTaxesFees = true;
          result.directlyComparable = true;
          result.evidenceSnippet = priceResult.totalEvidence;
          result.structuralProof.directly_comparable = true;
          result.structuralProof.extraction_method = 'zyte_nav_total_label';
          result.goldenPath = true;

          console.log(`[VRBO] SUCCESS: Total=$${priceResult.totalPrice} currency=${priceResult.currency} directly_comparable=true`);

        } else if (!zyteResult.checkoutSessionReached) {
          // Could not reach checkout page
          result.success = false;
          result.status = 'checkout_not_reached';
          result.failureCategory = 'checkout_not_reached';
          result.directlyComparable = false;
          result.error = `Checkout/session page not reached. Final URL: ${zyteResult.finalUrl}. Labels found: ${priceResult.labelsFound.join(', ') || 'none'}`;
          result.structuralProof.extraction_method = 'zyte_nav_no_checkout';

          console.log(`[VRBO] FAILURE: Checkout not reached. Labels found: ${priceResult.labelsFound.join(', ')}`);

        } else {
          // At checkout but no "Total" label found
          result.success = false;
          result.status = 'total_price_not_found';
          result.failureCategory = 'no_total_label';
          result.directlyComparable = false;
          result.error = `"Total" label not found on checkout page. Found instead: ${priceResult.labelsFound.join(', ') || 'none'}. Competing amounts: nightly=${priceResult.nightlyRate}, subtotal=${priceResult.subtotal}, due_now=${priceResult.dueNow}`;
          result.structuralProof.extraction_method = 'zyte_nav_no_total_label';

          console.log(`[VRBO] FAILURE: No "Total" label. Competing: nightly=${priceResult.nightlyRate}, subtotal=${priceResult.subtotal}, due_now=${priceResult.dueNow}, deposit=${priceResult.deposit}`);
        }
      }
    } else {
      zyteAttempt.outcome = 'navigation_failed';
      zyteAttempt.errorMessage = zyteResult.error;

      if (zyteResult.error?.includes('Timeout')) {
        result.status = 'timeout';
        result.failureCategory = 'timeout';
      } else {
        result.status = 'render_failed';
        result.failureCategory = 'render_error';
      }
      result.error = zyteResult.error;
    }

    providerAttempts.push(zyteAttempt);

    // Browserless and Firecrawl skipped (captcha/quota per live check)
    providerAttempts.push({
      provider: 'browserless',
      attempted: false,
      attemptIndex: 1,
      startedAt: null,
      endedAt: null,
      outcome: 'skipped',
      httpStatus: null,
      contentLength: null,
      errorMessage: 'Skipped: Browserless captcha-blocked per VRBO_LIVE_ACCESS_CHECK',
      urlUsed: null,
      finalUrl: null,
    });

    providerAttempts.push({
      provider: 'firecrawl',
      attempted: false,
      attemptIndex: 2,
      startedAt: null,
      endedAt: null,
      outcome: 'skipped',
      httpStatus: null,
      contentLength: null,
      errorMessage: 'Skipped: Firecrawl quota error per VRBO_LIVE_ACCESS_CHECK',
      urlUsed: null,
      finalUrl: null,
    });

    result.providerAttempts = providerAttempts;
    result.structuralProof.failure_category = result.failureCategory;
    result.structuralProof.currency_detected = result.currency;
    result.durationMs = Date.now() - startTime;

    console.log(`[VRBO] Extraction complete: status=${result.status}, directly_comparable=${result.directlyComparable}, ${result.durationMs}ms`);

    // ========================================================================
    // DATABASE UPDATE (if extractionId provided)
    // ========================================================================
    
    if (extractionId) {
      try {
        const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
        const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
        const supabase = createClient(supabaseUrl, supabaseKey);

        await supabase
          .from('price_extractions')
          .update({
            extraction_status: result.status,
            extracted_price: result.extractedPrice,
            currency: result.currency,
            includes_taxes_fees: result.includesTaxesFees,
            evidence_snippets: result.evidenceSnippet ? [result.evidenceSnippet] : null,
            extraction_metadata: {
              structuralProof: result.structuralProof,
              providerAttempts: result.providerAttempts,
              goldenPath: result.goldenPath,
              durationMs: result.durationMs,
            },
            provider_used: 'zyte',
            updated_at: new Date().toISOString(),
          })
          .eq('id', extractionId);

        console.log(`[VRBO] Updated extraction ${extractionId}`);
      } catch (dbError) {
        console.error(`[VRBO] Database update failed:`, dbError);
      }
    }

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    result.status = 'validation_error';
    result.failureCategory = 'render_error';
    result.durationMs = Date.now() - startTime;
    result.providerAttempts = providerAttempts;

    console.error(`[VRBO] Fatal error:`, error);

    return new Response(JSON.stringify(result), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
