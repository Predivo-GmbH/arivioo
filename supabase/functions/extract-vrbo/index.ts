import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

/**
 * ============================================================================
 * VRBO ZYTE-FIRST GOLDEN PATH EXTRACTOR v3.0
 * ============================================================================
 * 
 * SIMPLIFIED APPROACH: Single Zyte request with one "Begin booking" click
 * 
 * User-verified workflow insight:
 * - Property URL with dates in params -> Click "Begin booking" -> Checkout page
 * - The checkout page contains "Trip total" / "Total" with taxes
 * 
 * KEY OPTIMIZATION: 
 * - Use VRBO's direct property URL format with chkin/chkout params
 * - Single Zyte browserActions request with one click action
 * - Extract total from the checkout drawer/page
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

type Provider = 'zyte';

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

/**
 * Build VRBO URL with dates in the format that works for direct property access
 * Based on user-verified Step 6 URL format
 */
function buildVrboUrlWithDates(baseUrl: string, checkIn: string, checkOut: string, adults: number = 2): string {
  try {
    const url = new URL(baseUrl);
    
    // Clear any existing date params first
    url.searchParams.delete('chkin');
    url.searchParams.delete('chkout');
    url.searchParams.delete('d1');
    url.searchParams.delete('d2');
    url.searchParams.delete('startDate');
    url.searchParams.delete('endDate');
    
    // VRBO uses multiple date param formats - set all of them
    url.searchParams.set('chkin', checkIn);
    url.searchParams.set('chkout', checkOut);
    url.searchParams.set('d1', checkIn);
    url.searchParams.set('d2', checkOut);
    url.searchParams.set('startDate', checkIn);
    url.searchParams.set('endDate', checkOut);
    url.searchParams.set('adults', String(adults));
    url.searchParams.set('x_pwa', '1'); // Request PWA/modern version
    
    return url.toString();
  } catch (e) {
    // Fallback if URL parsing fails
    const separator = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${separator}chkin=${checkIn}&chkout=${checkOut}&d1=${checkIn}&d2=${checkOut}&startDate=${checkIn}&endDate=${checkOut}&adults=${adults}&x_pwa=1`;
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
         lowerUrl.includes('checkouttoken=');
}

function hasCheckoutSignals(content: string): boolean {
  const signals = [
    /\bTrip\s+total\b/i,
    /\bTraveler\s+information\b/i,
    /\bPayment\s+(?:details|schedule)\b/i,
    /\bDue\s+now\b/i,
    /\bTaxes\b/i,
    /\bService\s+fee\b/i,
  ];
  const hits = signals.reduce((acc, r) => acc + (r.test(content) ? 1 : 0), 0);
  return hits >= 2;
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
  nightlyRate: number | null;
  subtotal: number | null;
  dueNow: number | null;
  deposit: number | null;
  cleaningFee: number | null;
  serviceFee: number | null;
  taxesAmount: number | null;
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

  const parsePrice = (text: string): number | null => {
    const match = text.match(/\$?\s*([\d,]+(?:\.\d{2})?)/);
    if (match) {
      const val = parseFloat(match[1].replace(/,/g, ''));
      return isNaN(val) ? null : val;
    }
    return null;
  };

  // Extract fee components for context
  const nightlyPatterns = [
    /\$\s*([\d,]+(?:\.\d{2})?)\s*(?:\/?\s*)?(?:per\s*)?night\b/i,
    /\$\s*([\d,]+(?:\.\d{2})?)\s*avg(?:\/|\s*per)?\s*night/i,
  ];
  for (const np of nightlyPatterns) {
    const match = content.match(np);
    if (match) {
      result.nightlyRate = parsePrice(match[0]);
      if (result.nightlyRate) {
        result.labelsFound.push('nightly');
        break;
      }
    }
  }

  const cleaningMatch = content.match(/cleaning\s*fee[:\s]*\$\s*([\d,]+(?:\.\d{2})?)/i);
  if (cleaningMatch) {
    result.cleaningFee = parsePrice(cleaningMatch[0]);
    result.labelsFound.push('cleaning_fee');
  }

  const serviceMatch = content.match(/service\s*fee[:\s]*\$\s*([\d,]+(?:\.\d{2})?)/i);
  if (serviceMatch) {
    result.serviceFee = parsePrice(serviceMatch[0]);
    result.labelsFound.push('service_fee');
  }

  const taxesMatch = content.match(/taxes?\s*(?:&\s*fees?)?[:\s]*\$\s*([\d,]+(?:\.\d{2})?)/i);
  if (taxesMatch) {
    result.taxesAmount = parsePrice(taxesMatch[0]);
    if (result.taxesAmount && result.taxesAmount > 10) {
      result.labelsFound.push('taxes');
    }
  }

  const subtotalMatch = content.match(/\$\s*([\d,]+(?:\.\d{2})?)\s+for\s+\d+\s+nights?/i);
  if (subtotalMatch) {
    result.subtotal = parsePrice(subtotalMatch[0]);
    result.labelsFound.push('subtotal');
  }

  const dueNowMatch = content.match(/(?:due\s*now|pay\s*now)[:\s]*\$\s*([\d,]+(?:\.\d{2})?)/i);
  if (dueNowMatch) {
    result.dueNow = parsePrice(dueNowMatch[0]);
    result.labelsFound.push('due_now');
  }

  console.log(`[VRBO] Fee components: nightly=${result.nightlyRate}, subtotal=${result.subtotal}, cleaning=${result.cleaningFee}, service=${result.serviceFee}, taxes=${result.taxesAmount}`);

  // Calculate minimum valid total (should be > subtotal)
  const expectedSubtotal = result.nightlyRate ? result.nightlyRate * nights : (result.subtotal || 0);
  const minValidTotal = expectedSubtotal > 0 ? expectedSubtotal * 1.05 : 100;

  // Look for explicit "Total" patterns - PRIORITY ORDER
  const totalPatterns = [
    // "Trip total" is the most reliable - VRBO's final total on checkout
    /\bTrip\s+total[:\s]*\$\s*([\d,]+(?:\.\d{2})?)/gi,
    // Standard explicit "Total" with $ and amount
    /\bTotal[:\s]+\$\s*([\d,]+(?:\.\d{2})?)/gi,
    // "Total price" pattern
    /\bTotal\s+price[:\s]*\$\s*([\d,]+(?:\.\d{2})?)/gi,
    // Amount followed by Total label
    /\$\s*([\d,]+(?:\.\d{2})?)\s+Total\b/gi,
  ];

  const foundTotals: Array<{price: number, context: string, pattern: string}> = [];

  for (const pattern of totalPatterns) {
    const matches = [...content.matchAll(pattern)];
    for (const match of matches) {
      const startIdx = Math.max(0, match.index! - 60);
      const endIdx = Math.min(content.length, match.index! + match[0].length + 40);
      const context = content.slice(startIdx, endIdx);
      
      // Exclusions: Skip if context indicates NOT the final total
      const exclusions = [/subtotal/i, /due\s*now/i, /pay\s*now/i, /deposit/i, /per\s*night/i, /nightly/i, /for\s+\d+\s+nights?/i];
      
      let isExcluded = false;
      for (const exclusion of exclusions) {
        if (exclusion.test(context) && !/trip\s+total/i.test(match[0])) {
          isExcluded = true;
          break;
        }
      }
      
      if (isExcluded) continue;
      
      const price = parseFloat(match[1].replace(/,/g, ''));
      if (!isNaN(price) && price > 100) {
        foundTotals.push({ price, context: context.trim(), pattern: pattern.source });
      }
    }
  }

  console.log(`[VRBO] Found ${foundTotals.length} potential totals: ${foundTotals.map(t => `$${t.price}`).join(', ')}`);

  if (foundTotals.length > 0) {
    // Sort by price descending - true total should be highest
    foundTotals.sort((a, b) => b.price - a.price);
    
    for (const candidate of foundTotals) {
      // Validate: Total must be > subtotal
      if (result.subtotal && candidate.price <= result.subtotal) {
        console.log(`[VRBO] Rejecting total $${candidate.price} - not greater than subtotal $${result.subtotal}`);
        continue;
      }
      
      if (minValidTotal > 0 && candidate.price < minValidTotal) {
        console.log(`[VRBO] Rejecting total $${candidate.price} - below minimum $${minValidTotal}`);
        continue;
      }
      
      result.totalFound = true;
      result.totalPrice = candidate.price;
      result.currency = 'USD';
      result.totalEvidence = candidate.context.slice(0, 150);
      result.directlyComparable = true;
      result.labelsFound.push('Total');
      
      console.log(`[VRBO] ACCEPTED total=${candidate.price} currency=USD evidence="${result.totalEvidence}"`);
      return result;
    }
  }

  // Fallback: Calculate from components if we have enough info
  if (result.subtotal && result.taxesAmount && !result.totalFound) {
    const calculatedTotal = result.subtotal + result.taxesAmount + (result.cleaningFee || 0) + (result.serviceFee || 0);
    if (calculatedTotal > result.subtotal * 1.05) {
      result.totalFound = true;
      result.totalPrice = calculatedTotal;
      result.currency = 'USD';
      result.totalEvidence = `Calculated: subtotal $${result.subtotal} + taxes $${result.taxesAmount} + fees`;
      result.directlyComparable = true;
      result.labelsFound.push('calculated_total');
      
      console.log(`[VRBO] CALCULATED total=${calculatedTotal}`);
      return result;
    }
  }

  console.log(`[VRBO] No valid total found. Labels: ${result.labelsFound.join(', ')}`);
  return result;
}

// ============================================================================
// SINGLE-REQUEST ZYTE EXTRACTION WITH ONE CLICK
// ============================================================================

async function extractWithZyte(datedUrl: string, nights: number): Promise<{
  success: boolean;
  propertyPageReached: boolean;
  checkoutSessionReached: boolean;
  content: string;
  html: string;
  httpStatus: number | null;
  error: string | null;
  finalUrl: string | null;
  durationMs: number;
  actionResults: any[];
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
    actionResults: [] as any[],
  };

  try {
    const apiKey = Deno.env.get('ZYTE_API_KEY');
    if (!apiKey) {
      result.error = 'ZYTE_API_KEY not configured';
      result.durationMs = Date.now() - start;
      return result;
    }

    console.log(`[VRBO] Zyte request: ${datedUrl}`);

    const zyteAuth = btoa(apiKey + ':');

    // JavaScript to click "Begin booking" / "Reserve" / "Book" button
    // This is the ONLY click we need - on the property page with dates
    const clickBeginBookingJS = `
      (function() {
        const result = { clicked: false, buttonText: '', foundButtons: [], error: null };
        try {
          const allClickables = Array.from(document.querySelectorAll('button, a[role="button"], a.uitk-button, [data-stid*="submit"]'));
          
          // Collect all button texts for debugging
          for (const el of allClickables) {
            const text = (el.textContent || '').trim();
            if (text.length > 0 && text.length < 50) {
              result.foundButtons.push(text.slice(0, 30));
            }
          }
          
          // Priority 1: "Begin booking" (exact or contains)
          for (const el of allClickables) {
            const text = (el.textContent || '').trim().toLowerCase();
            if (text.includes('begin booking')) {
              el.scrollIntoView({ behavior: 'instant', block: 'center' });
              el.click();
              result.clicked = true;
              result.buttonText = text.slice(0, 50);
              return JSON.stringify(result);
            }
          }
          
          // Priority 2: "Reserve" button (common on VRBO)
          for (const el of allClickables) {
            const text = (el.textContent || '').trim().toLowerCase();
            if (text === 'reserve' || text === 'reserve now') {
              el.scrollIntoView({ behavior: 'instant', block: 'center' });
              el.click();
              result.clicked = true;
              result.buttonText = text.slice(0, 50);
              return JSON.stringify(result);
            }
          }
          
          // Priority 3: Primary "Book" button in pricing card
          const priceCard = document.querySelector('[data-stid="property-price-summary"], [data-stid="book-now-section"], [class*="BookingCard"], [class*="price-card"]');
          if (priceCard) {
            const btns = priceCard.querySelectorAll('button, a[role="button"]');
            for (const btn of btns) {
              const text = (btn.textContent || '').trim().toLowerCase();
              if (text.includes('book') || text.includes('continue')) {
                btn.scrollIntoView({ behavior: 'instant', block: 'center' });
                btn.click();
                result.clicked = true;
                result.buttonText = text.slice(0, 50);
                return JSON.stringify(result);
              }
            }
          }
          
          // Priority 4: data-stid submit button
          const submitBtn = document.querySelector('button[data-stid="submit-hotel-reserve"]');
          if (submitBtn) {
            submitBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
            submitBtn.click();
            result.clicked = true;
            result.buttonText = 'submit-hotel-reserve';
            return JSON.stringify(result);
          }
          
          // Priority 5: Any primary button with booking text
          for (const el of allClickables) {
            const text = (el.textContent || '').trim().toLowerCase();
            const isPrimary = el.classList.contains('uitk-button-primary') || el.classList.contains('primary');
            if (isPrimary && (text.includes('book') || text.includes('continue') || text.includes('proceed'))) {
              el.scrollIntoView({ behavior: 'instant', block: 'center' });
              el.click();
              result.clicked = true;
              result.buttonText = text.slice(0, 50);
              return JSON.stringify(result);
            }
          }
          
          result.error = 'No booking button found';
        } catch (e) {
          result.error = e.message || String(e);
        }
        return JSON.stringify(result);
      })();
    `;

    // Single Zyte request with browser actions.
    // Keep it minimal - just load page, wait for hydration, click, wait.
    const requestBody = {
      url: datedUrl,
      browserHtml: true,
      javascript: true,
      actions: [
        { action: 'waitForTimeout', timeout: 10 }, // Wait for page hydration (max 15)
        { action: 'evaluate', source: clickBeginBookingJS }, // Click booking button
        { action: 'waitForTimeout', timeout: 15 }, // Wait for checkout (max 15)
      ],
    };

    console.log(`[VRBO] Sending Zyte request with ${requestBody.actions.length} actions`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120000); // 120s total timeout

    const response = await fetch('https://api.zyte.com/v1/extract', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${zyteAuth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    result.httpStatus = response.status;

    if (!response.ok) {
      const errText = await response.text();
      console.log(`[VRBO] Zyte HTTP error: ${response.status} - ${errText.slice(0, 200)}`);
      result.error = `Zyte HTTP ${response.status}: ${errText.slice(0, 200)}`;
      result.durationMs = Date.now() - start;
      return result;
    }

    const data = await response.json();
    result.html = data.browserHtml || '';
    result.content = result.html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    result.finalUrl = data.url || datedUrl;
    result.actionResults = data.actions || [];

    console.log(`[VRBO] Zyte response: ${result.html.length} bytes, finalUrl=${result.finalUrl}`);
    console.log(`[VRBO] Action results: ${JSON.stringify(result.actionResults).slice(0, 500)}`);

    // Check block signals
    const blockSignal = detectBlockSignals(result.content);
    if (blockSignal) {
      console.log(`[VRBO] Block detected: ${blockSignal}`);
      result.error = `Blocked: ${blockSignal}`;
      result.durationMs = Date.now() - start;
      return result;
    }

    // Check if we reached property page (basic sanity check)
    result.propertyPageReached = result.html.length > 50000;

    // Check if we reached checkout (URL or content signals)
    result.checkoutSessionReached = isCheckoutSessionUrl(result.finalUrl || '') || hasCheckoutSignals(result.content);

    console.log(`[VRBO] property_reached=${result.propertyPageReached}, checkout_reached=${result.checkoutSessionReached}`);

    result.success = result.propertyPageReached;
    result.durationMs = Date.now() - start;

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
      proof_version: 'vrbo-zyte-v3.0',
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

    console.log(`[VRBO] Extraction request: url=${url}`);
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

    // Build URL with dates in VRBO format
    const datedUrl = buildVrboUrlWithDates(url, checkIn, checkOut, adults);
    result.structuralProof.dated_property_url = datedUrl;
    result.structuralProof.dates_injected = true;

    console.log(`[VRBO] Dated URL: ${datedUrl}`);

    // ========================================================================
    // SINGLE ZYTE REQUEST WITH CLICK ACTION
    // ========================================================================
    const zyteAttempt: ProviderAttemptTrace = {
      provider: 'zyte',
      attempted: true,
      attemptIndex: 1,
      startedAt: new Date().toISOString(),
      endedAt: null,
      outcome: 'pending',
      httpStatus: null,
      contentLength: null,
      errorMessage: null,
      urlUsed: datedUrl,
      finalUrl: null,
    };

    const zyteResult = await extractWithZyte(datedUrl, nights);

    zyteAttempt.endedAt = new Date().toISOString();
    zyteAttempt.httpStatus = zyteResult.httpStatus;
    zyteAttempt.contentLength = zyteResult.html.length;
    zyteAttempt.finalUrl = zyteResult.finalUrl;
    zyteAttempt.errorMessage = zyteResult.error;

    result.structuralProof.property_page_reached = zyteResult.propertyPageReached;
    result.structuralProof.checkout_session_reached = zyteResult.checkoutSessionReached;
    result.structuralProof.final_url = zyteResult.finalUrl;
    result.structuralProof.content_hash = simpleHash(zyteResult.content.slice(0, 5000));

    if (!zyteResult.success) {
      zyteAttempt.outcome = 'failed';
      providerAttempts.push(zyteAttempt);

      result.status = zyteResult.error?.includes('Timeout') ? 'timeout' : 'page_not_reached';
      result.failureCategory = zyteResult.error?.includes('captcha') ? 'captcha' : 'render_error';
      result.structuralProof.failure_category = result.failureCategory;
      result.error = zyteResult.error || 'Zyte extraction failed';
      result.durationMs = Date.now() - startTime;
      result.providerAttempts = providerAttempts;

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ========================================================================
    // EXTRACT TOTAL PRICE
    // ========================================================================
    const priceResult = extractVrboTotal(zyteResult.content, nights);

    result.structuralProof.total_label_found = priceResult.totalFound;
    result.structuralProof.nightly_rate_found = priceResult.nightlyRate !== null;
    result.structuralProof.subtotal_found = priceResult.subtotal !== null;
    result.structuralProof.due_now_found = priceResult.dueNow !== null;
    result.structuralProof.deposit_found = priceResult.deposit !== null;
    result.structuralProof.cleaning_fee_found = priceResult.cleaningFee !== null;
    result.structuralProof.service_fee_found = priceResult.serviceFee !== null;
    result.structuralProof.taxes_visible = priceResult.taxesAmount !== null;
    result.structuralProof.directly_comparable = priceResult.directlyComparable;
    result.structuralProof.currency_detected = priceResult.currency;
    result.structuralProof.competing_amounts = {
      nightlyRate: priceResult.nightlyRate,
      subtotal: priceResult.subtotal,
      dueNow: priceResult.dueNow,
      cleaningFee: priceResult.cleaningFee,
      serviceFee: priceResult.serviceFee,
      taxesAmount: priceResult.taxesAmount,
    };

    // Check for dates visibility
    const datesVisible = zyteResult.content.includes(checkIn) || zyteResult.content.includes(checkOut.replace(/-/g, '/'));
    result.structuralProof.dates_visible_on_page = datesVisible;

    if (priceResult.totalFound && priceResult.totalPrice) {
      // SUCCESS!
      zyteAttempt.outcome = 'success';
      providerAttempts.push(zyteAttempt);

      result.success = true;
      result.status = 'success_total_stay';
      result.failureCategory = 'success';
      result.structuralProof.failure_category = 'success';
      result.extractedPrice = priceResult.totalPrice;
      result.currency = priceResult.currency;
      result.originalAmount = priceResult.totalPrice;
      result.originalCurrency = priceResult.currency;
      result.includesTaxesFees = true;
      result.directlyComparable = true;
      result.evidenceSnippet = priceResult.totalEvidence;
      result.structuralProof.extraction_method = 'zyte-click-checkout';
      result.goldenPath = zyteResult.checkoutSessionReached;

      console.log(`[VRBO] SUCCESS: total=${priceResult.totalPrice} ${priceResult.currency}`);
    } else {
      // Failed to find total
      zyteAttempt.outcome = 'no_price_found';
      providerAttempts.push(zyteAttempt);

      result.status = zyteResult.checkoutSessionReached ? 'total_price_not_found' : 'checkout_not_reached';
      result.failureCategory = zyteResult.checkoutSessionReached ? 'no_total_label' : 'checkout_not_reached';
      result.structuralProof.failure_category = result.failureCategory;
      result.error = `Checkout reached: ${zyteResult.checkoutSessionReached}, Total found: false, Labels: ${priceResult.labelsFound.join(', ')}`;

      // If we have nightly rate but no total, note that
      if (priceResult.nightlyRate && !priceResult.totalFound) {
        result.status = 'nightly_only_rejected';
        result.failureCategory = 'nightly_only';
        result.structuralProof.failure_category = 'nightly_only';
      }

      console.log(`[VRBO] FAILED: checkout=${zyteResult.checkoutSessionReached}, labels=${priceResult.labelsFound.join(',')}`);
    }

    result.durationMs = Date.now() - startTime;
    result.providerAttempts = providerAttempts;

    // Update extraction record in database if extractionId provided
    if (extractionId) {
      try {
        const supabaseUrl = Deno.env.get('SUPABASE_URL');
        const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
        if (supabaseUrl && supabaseKey) {
          const supabase = createClient(supabaseUrl, supabaseKey);
          await supabase.from('price_extractions').update({
            extraction_status: result.success ? 'completed' : 'failed',
            extracted_price: result.extractedPrice,
            currency: result.currency,
            includes_taxes_fees: result.includesTaxesFees,
            evidence_snippets: result.evidenceSnippet ? [result.evidenceSnippet] : null,
            extraction_metadata: {
              structuralProof: result.structuralProof,
              providerAttempts: result.providerAttempts,
              goldenPath: result.goldenPath,
            },
            extraction_error: result.error,
            provider_used: 'zyte',
            final_resolved_url: result.structuralProof.final_url,
            updated_at: new Date().toISOString(),
          }).eq('id', extractionId);
        }
      } catch (dbErr) {
        console.log(`[VRBO] DB update error: ${dbErr}`);
      }
    }

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (e) {
    result.durationMs = Date.now() - startTime;
    result.error = e instanceof Error ? e.message : String(e);
    result.providerAttempts = providerAttempts;
    console.log(`[VRBO] Handler error: ${result.error}`);

    return new Response(JSON.stringify(result), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
