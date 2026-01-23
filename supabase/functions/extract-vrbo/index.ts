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

function hasCheckoutSignals(content: string): boolean {
  // VRBO sometimes keeps the same URL but swaps to a booking/checkout view.
  // We treat these as strong checkout signals that appear on the "Begin booking" flow.
  const signals = [
    /\bTrip\s+total\b/i,
    /\bTraveler\s+information\b/i,
    /\bPayment\s+(?:details|schedule)\b/i,
    /\bDue\s+now\b/i,
    /\bTaxes\b/i,
    /\bService\s+fee\b/i,
    /\bCleaning\s+fee\b/i,
  ];
  const hits = signals.reduce((acc, r) => acc + (r.test(content) ? 1 : 0), 0);
  // Require multiple signals to avoid falsely treating marketing/footer text as checkout.
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
  // STEP 1: Extract all fee components first
  // This helps us identify the price breakdown structure
  // =========================================================================
  
  // Nightly rate - look for various patterns
  const nightlyPatterns = [
    /\$\s*([\d,]+(?:\.\d{2})?)\s*(?:\/?\s*)?(?:per\s*)?night\b/i,
    /\$\s*([\d,]+(?:\.\d{2})?)\s*avg(?:\/|\s*per)?\s*night/i,
    /avg\.\s*\$\s*([\d,]+(?:\.\d{2})?)\s*\/?\s*night/i,
  ];
  for (const np of nightlyPatterns) {
    const nightlyMatch = content.match(np);
    if (nightlyMatch) {
      result.nightlyRate = parsePrice(nightlyMatch[0]);
      if (result.nightlyRate) {
        result.labelsFound.push('nightly');
        break;
      }
    }
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

  // Taxes - CRITICAL: This indicates we have the full breakdown
  const taxesPatterns = [
    /taxes?\s*(?:&\s*fees?)?[:\s]*\$\s*([\d,]+(?:\.\d{2})?)/i,
    /\$\s*([\d,]+(?:\.\d{2})?)\s*(?:in\s+)?taxes?/i,
  ];
  for (const tp of taxesPatterns) {
    const taxesMatch = content.match(tp);
    if (taxesMatch) {
      result.taxesAmount = parsePrice(taxesMatch[0]);
      if (result.taxesAmount && result.taxesAmount > 10) { // Sanity check
        result.labelsFound.push('taxes');
        break;
      }
    }
  }

  // Subtotal / nights cost (without fees/taxes)
  const subtotalPatterns = [
    /subtotal[:\s]*\$\s*([\d,]+(?:\.\d{2})?)/i,
    /\$\s*([\d,]+(?:\.\d{2})?)\s+for\s+\d+\s+nights?/i, // This is SUBTOTAL not total
  ];
  for (const sp of subtotalPatterns) {
    const subtotalMatch = content.match(sp);
    if (subtotalMatch) {
      result.subtotal = parsePrice(subtotalMatch[0]);
      if (result.subtotal) {
        result.labelsFound.push('subtotal');
        break;
      }
    }
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

  console.log(`[VRBO] Fee components: nightly=${result.nightlyRate}, subtotal=${result.subtotal}, cleaning=${result.cleaningFee}, service=${result.serviceFee}, taxes=${result.taxesAmount}`);

  // =========================================================================
  // STEP 2: Look for EXPLICIT "Total" that is GREATER than subtotal
  // The real total MUST include taxes, so it should be > subtotal
  // =========================================================================
  
  // Calculate expected subtotal for sanity check
  const expectedSubtotal = result.nightlyRate ? result.nightlyRate * nights : (result.subtotal || 0);
  const minValidTotal = expectedSubtotal > 0 ? expectedSubtotal * 1.05 : 100; // Total must be at least 5% more than subtotal
  
  // VRBO-specific patterns for EXPLICIT Total only
  const totalPatterns = [
    // "Trip total" is the most reliable - VRBO's final total
    /\bTrip\s+total[:\s]*\$\s*([\d,]+(?:\.\d{2})?)/gi,
    // Standard explicit "Total" with $ and amount
    /\bTotal[:\s]+\$\s*([\d,]+(?:\.\d{2})?)/gi,
    // "Total price" pattern
    /\bTotal\s+price[:\s]*\$\s*([\d,]+(?:\.\d{2})?)/gi,
    // Total at end of breakdown (amount followed by Total label)
    /\$\s*([\d,]+(?:\.\d{2})?)\s+Total\b/gi,
    // Total with currency after
    /\bTotal[:\s]*([\d,]+(?:\.\d{2})?)\s*USD/gi,
  ];

  const foundTotals: Array<{price: number, context: string, pattern: string}> = [];

  for (const pattern of totalPatterns) {
    const matches = [...content.matchAll(pattern)];
    for (const match of matches) {
      // Get surrounding context
      const startIdx = Math.max(0, match.index! - 60);
      const endIdx = Math.min(content.length, match.index! + match[0].length + 40);
      const context = content.slice(startIdx, endIdx);
      
      // STRICT EXCLUSIONS: Skip if context indicates this is NOT the final total
      const exclusionPatterns = [
        /subtotal/i,
        /due\s*now/i,
        /pay\s*now/i,
        /deposit/i,
        /per\s*night/i,
        /nightly/i,
        /avg\.?\s*\$/i,
        /for\s+\d+\s+nights?/i, // This is subtotal, not total with taxes
      ];
      
      let isExcluded = false;
      for (const exclusion of exclusionPatterns) {
        if (exclusion.test(context)) {
          // Exception: "Trip total" is NEVER excluded
          if (!/trip\s+total/i.test(match[0])) {
            isExcluded = true;
            console.log(`[VRBO] Excluding match due to pattern: ${exclusion.source}, context: "${context.slice(0, 80)}"`);
            break;
          }
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

  // =========================================================================
  // STEP 3: Select the CORRECT total
  // Priority: 
  //   1. Total that is greater than subtotal (includes taxes)
  //   2. If taxes found separately, total should be >= subtotal + taxes
  //   3. Prefer "Trip total" pattern
  // =========================================================================

  if (foundTotals.length > 0) {
    // Sort by price descending - the true total should be the highest
    foundTotals.sort((a, b) => b.price - a.price);
    
    for (const candidate of foundTotals) {
      // Validate: Total must be greater than subtotal if we know the subtotal
      if (result.subtotal && candidate.price <= result.subtotal) {
        console.log(`[VRBO] Rejecting total $${candidate.price} - not greater than subtotal $${result.subtotal}`);
        continue;
      }
      
      // Validate: If we have taxes, total should be approximately subtotal + taxes
      if (result.subtotal && result.taxesAmount) {
        const expectedTotal = result.subtotal + result.taxesAmount;
        const tolerance = expectedTotal * 0.15; // 15% tolerance for rounding/fees
        if (Math.abs(candidate.price - expectedTotal) > tolerance && candidate.price < expectedTotal) {
          console.log(`[VRBO] Rejecting total $${candidate.price} - doesn't match expected $${expectedTotal} (subtotal + taxes)`);
          continue;
        }
      }
      
      // Validate: Total must be substantial compared to expected subtotal
      if (minValidTotal > 0 && candidate.price < minValidTotal) {
        console.log(`[VRBO] Rejecting total $${candidate.price} - below minimum valid total $${minValidTotal}`);
        continue;
      }
      
      // This candidate passes validation
      result.totalFound = true;
      result.totalPrice = candidate.price;
      result.currency = 'USD';
      result.totalEvidence = candidate.context.slice(0, 150);
      result.directlyComparable = true;
      result.labelsFound.push('Total');
      
      console.log(`[VRBO] ACCEPTED total_label_found=true extracted_total=${candidate.price} currency=USD evidence="${result.totalEvidence}"`);
      return result;
    }
    
    console.log(`[VRBO] All ${foundTotals.length} total candidates were rejected`);
  }

  // =========================================================================
  // STEP 4: If we have subtotal + taxes but no explicit total, calculate it
  // This is a derived total, still directly comparable
  // =========================================================================
  if (result.subtotal && result.taxesAmount && !result.totalFound) {
    const calculatedTotal = result.subtotal + result.taxesAmount + (result.cleaningFee || 0) + (result.serviceFee || 0);
    if (calculatedTotal > result.subtotal * 1.05) { // Sanity check
      result.totalFound = true;
      result.totalPrice = calculatedTotal;
      result.currency = 'USD';
      result.totalEvidence = `Calculated: subtotal $${result.subtotal} + taxes $${result.taxesAmount} + fees`;
      result.directlyComparable = true;
      result.labelsFound.push('calculated_total');
      
      console.log(`[VRBO] CALCULATED total=${calculatedTotal} from subtotal=${result.subtotal} + taxes=${result.taxesAmount} + fees`);
      return result;
    }
  }

  console.log(`[VRBO] total_label_found=false - no valid total found`);
  console.log(`[VRBO] Labels found: ${result.labelsFound.join(', ')}`);
  
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

    // NOTE: VRBO commonly requires opening the booking drawer, then clicking the
    // primary CTA (often labeled "Begin booking") to reach the checkout/session
    // where taxes/fees are shown.
    // XPath selectors targeting visible button text - more reliable than data-stid attributes
    // These target the actual visible text users see on the buttons
    const xpathBookingSelectors = [
      '//button[contains(text(), "Reserve")]',
      '//button[contains(text(), "Book")]',
      '//button[contains(text(), "Begin booking")]',
      '//button[contains(text(), "Check availability")]',
      '//a[contains(text(), "Reserve")]',
      '//a[contains(text(), "Book")]',
      // Fallback: buttons with primary styling
      '//button[contains(@class, "primary")]',
    ];
    
    // CSS selectors as fallback
    const cssBookingSelectors = [
      'button[data-stid="submit-hotel-reserve"]',
      'button[data-stid="open-booking-drawer"]',
      'button.uitk-button-primary',
    ];

    const zyteExtract = async (url: string, actions: any[], timeoutMs: number, captureScreenshot: boolean = false) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const requestBody: Record<string, any> = {
          url,
          browserHtml: true,
          javascript: true,
          actions,
        };
        // Enable screenshot capture for debugging
        if (captureScreenshot) {
          requestBody.screenshot = true;
          requestBody.screenshotOptions = { fullPage: false }; // viewport only to reduce size
        }
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
        return response;
      } catch (e) {
        clearTimeout(timeoutId);
        throw e;
      }
    };
    
    // VRBO extraction strategy:
    // 1. Use waitForSelector to wait for booking widget to appear (indicates JS hydrated)
    // 2. Click the booking CTA using XPath selectors targeting visible text
    // 3. Wait for checkout signals to appear using waitForSelector
    // CRITICAL: Zyte waitForTimeout max is 15 seconds! waitForSelector max is also 15s.
    // NOTE: Zyte does NOT support waitForNetworkIdle - must use waitForSelector instead
    
    // Selector to wait for that indicates page is ready (booking widget loaded)
    const pageReadySelector = 'button.uitk-button-primary, [data-stid="property-price-summary"], .uitk-card-content-section';
    
    const attempts: Array<{ label: string; actions: any[]; expectedCheckout?: boolean }> = [
      // First: wait for booking widget to appear (indicates page is ready)
      {
        label: 'wait_for_widget',
        actions: [
          { action: 'waitForSelector', selector: { type: 'css', value: pageReadySelector }, timeout: 15 },
        ],
      },
      // XPath selectors targeting visible button text - most reliable
      ...xpathBookingSelectors.map((xpath) => ({
        label: `xpath:${xpath.slice(0, 40)}`,
        expectedCheckout: true,
        actions: [
          { action: 'waitForSelector', selector: { type: 'css', value: pageReadySelector }, timeout: 15 },
          { action: 'click', selector: { type: 'xpath', value: xpath } },
          { action: 'waitForTimeout', timeout: 5 },
          // Second click for "Begin booking" confirmation button
          { action: 'click', selector: { type: 'xpath', value: '//button[contains(text(), "Begin booking")]' } },
          { action: 'waitForTimeout', timeout: 10 },
        ],
      })),
      // CSS selectors as fallback
      ...cssBookingSelectors.map((sel) => ({
        label: `css:${sel}`,
        expectedCheckout: true,
        actions: [
          { action: 'waitForSelector', selector: { type: 'css', value: pageReadySelector }, timeout: 15 },
          { action: 'click', selector: { type: 'css', value: sel } },
          { action: 'waitForTimeout', timeout: 5 },
          { action: 'click', selector: { type: 'css', value: 'button.uitk-button-primary' } },
          { action: 'waitForTimeout', timeout: 10 },
        ],
      })),
    ];

    let lastErr: string | null = null;
    // DEBUG: Capture screenshots for the first few attempts to understand page state
    const screenshotDebugLog: Array<{ label: string; screenshotB64Preview: string; pageTitle: string; checkoutSignals: string[] }> = [];
    
    for (const attempt of attempts) {
      const elapsed = Date.now() - start;
      // TIMEOUT FIX: Increased hard stop to 240s to allow full navigation
      if (elapsed > 240000) break;

      try {
        console.log(`[VRBO] zyte_attempt=${attempt.label} elapsed=${elapsed}ms`);
        // Enable screenshot capture for first 3 attempts only (to limit cost/time)
        const captureScreenshot = screenshotDebugLog.length < 3;
        // TIMEOUT FIX: Increased per-attempt timeout to 180s
        const response = await zyteExtract(datedUrl, attempt.actions, 180000, captureScreenshot);
        result.httpStatus = response.status;

        if (!response.ok) {
          const errText = await response.text();
          lastErr = `HTTP ${response.status}: ${errText.slice(0, 200)}`;
          console.log(`[VRBO] Zyte attempt failed (${attempt.label}): ${lastErr}`);
          continue;
        }

        const data = await response.json();
        const html = data.browserHtml || '';
        const finalUrl = data.url || datedUrl;
        const propertyPageReached = html.length > 10000;
        const normalizedContent = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        const reachedCheckout = isCheckoutSessionUrl(finalUrl) || hasCheckoutSignals(normalizedContent);

        // DEBUG: Log screenshot info if captured
        if (data.screenshot) {
          const screenshotB64 = data.screenshot as string;
          // Extract page title for context
          const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
          const pageTitle = titleMatch ? titleMatch[1].slice(0, 100) : 'No title';
          // Check which checkout signals are present
          const signalChecks = [
            { name: 'Trip total', pattern: /\bTrip\s+total\b/i },
            { name: 'Traveler info', pattern: /\bTraveler\s+information\b/i },
            { name: 'Payment details', pattern: /\bPayment\s+(?:details|schedule)\b/i },
            { name: 'Due now', pattern: /\bDue\s+now\b/i },
            { name: 'Taxes', pattern: /\bTaxes\b/i },
            { name: 'Service fee', pattern: /\bService\s+fee\b/i },
            { name: 'Cleaning fee', pattern: /\bCleaning\s+fee\b/i },
          ];
          const foundSignals = signalChecks.filter(s => s.pattern.test(normalizedContent)).map(s => s.name);
          
          screenshotDebugLog.push({
            label: attempt.label,
            screenshotB64Preview: screenshotB64.slice(0, 100) + '...[truncated]',
            pageTitle,
            checkoutSignals: foundSignals,
          });
          
          console.log(`[VRBO_DEBUG] attempt=${attempt.label} screenshot_size=${screenshotB64.length} title="${pageTitle}" signals=[${foundSignals.join(',')}]`);
          
          // Log price-related content, not just first 500 chars
          // Search for price indicators in the content
          const priceMatch = normalizedContent.match(/\$\s*[\d,]+(?:\.\d{2})?[^$]{0,100}/g);
          if (priceMatch && priceMatch.length > 0) {
            console.log(`[VRBO_DEBUG] price_snippets="${priceMatch.slice(0, 5).join(' | ')}"`);
          } else {
            console.log(`[VRBO_DEBUG] price_snippets=NONE_FOUND`);
          }
          
          // Check for button text to verify page rendered
          const buttonMatch = normalizedContent.match(/(Reserve|Book|Check availability)[^a-z]{0,50}/gi);
          if (buttonMatch && buttonMatch.length > 0) {
            console.log(`[VRBO_DEBUG] button_text="${buttonMatch.slice(0, 3).join(' | ')}"`);
          } else {
            console.log(`[VRBO_DEBUG] button_text=NONE_FOUND`);
          }
        }

        console.log(`[VRBO] final_url=${finalUrl}`);
        console.log(`[VRBO] reached_checkout_session=${reachedCheckout}`);
        console.log(`[VRBO] Zyte attempt complete (${attempt.label}): ${html.length} bytes, ${Date.now() - start}ms`);

        // Always keep the latest successful HTML payload.
        if (propertyPageReached) {
          result.html = html;
          result.content = normalizedContent;
          result.finalUrl = finalUrl;
          result.propertyPageReached = true;
          result.checkoutSessionReached = reachedCheckout;
        }

        // If we reached checkout/session, stop immediately.
        // This is the only place we should attempt to read a total-with-taxes.
        if (reachedCheckout) break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        lastErr = msg;
        console.log(`[VRBO] Zyte attempt exception (${attempt.label}): ${msg}`);
        continue;
      }
    }
    
    // Log summary of screenshot debug attempts
    if (screenshotDebugLog.length > 0) {
      console.log(`[VRBO_DEBUG_SUMMARY] ${JSON.stringify(screenshotDebugLog)}`);
    }

    result.durationMs = Date.now() - start;
    if (!result.propertyPageReached) {
      result.error = lastErr || 'No property page content returned';
      console.log(`[VRBO] Zyte navigation failed: ${result.error}`);
      return result;
    }

    result.success = result.propertyPageReached;

  } catch (e) {
    result.durationMs = Date.now() - start;
    if (e instanceof Error && e.name === 'AbortError') {
      result.error = 'Timeout after 240s';
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

        // STRICT RULE: Only accept Total if checkout session was reached
        // This prevents property-page subtotals from being accepted as totals
        if (!zyteResult.checkoutSessionReached) {
          // Could not reach checkout page - NEVER accept any price
          result.success = false;
          result.status = 'checkout_not_reached';
          result.failureCategory = 'checkout_not_reached';
          result.directlyComparable = false;
          result.error = `Checkout/session page not reached. Final URL: ${zyteResult.finalUrl}. Labels found: ${priceResult.labelsFound.join(', ') || 'none'}`;
          result.structuralProof.extraction_method = 'zyte_nav_no_checkout';

          console.log(`[VRBO] FAILURE: Checkout not reached. Labels found: ${priceResult.labelsFound.join(', ')}`);

        } else if (priceResult.totalFound && priceResult.totalPrice && priceResult.directlyComparable) {
          // SUCCESS - Total price found from explicit "Total" label ON CHECKOUT PAGE
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
          result.structuralProof.extraction_method = 'zyte_nav_checkout_total_label';
          result.goldenPath = true;

          console.log(`[VRBO] SUCCESS: Total=$${priceResult.totalPrice} currency=${priceResult.currency} directly_comparable=true checkout_verified=true`);

        } else {
          // At checkout but no explicit "Total" label found
          result.success = false;
          result.status = 'total_price_not_found';
          result.failureCategory = 'no_total_label';
          result.directlyComparable = false;
          result.error = `Explicit "Total" label not found on checkout page. Found instead: ${priceResult.labelsFound.join(', ') || 'none'}. Competing amounts: nightly=${priceResult.nightlyRate}, subtotal=${priceResult.subtotal}, due_now=${priceResult.dueNow}`;
          result.structuralProof.extraction_method = 'zyte_nav_checkout_no_total_label';

          console.log(`[VRBO] FAILURE: No explicit "Total" label on checkout. Competing: nightly=${priceResult.nightlyRate}, subtotal=${priceResult.subtotal}, due_now=${priceResult.dueNow}, deposit=${priceResult.deposit}`);
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

        // Resolve search/platform for targeted logs
        const { data: ctx } = await supabase
          .from('price_extractions')
          .select('search_id, platform_name')
          .eq('id', extractionId)
          .maybeSingle();

        const ctxSearchId = (ctx as any)?.search_id || 'unknown';
        const ctxPlatform = (ctx as any)?.platform_name || 'unknown';

        console.log(`[VRBO_PIPE] search_id=${ctxSearchId} platform=${ctxPlatform} extraction_id=${extractionId} return status=${result.status} total=${result.extractedPrice ?? 'null'} currency=${result.currency ?? 'null'} directly_comparable=${result.directlyComparable}`);

        // Map success_total_stay to canonical 'success' status for classification
        const canonicalStatus = result.status === 'success_total_stay' ? 'success' : result.status;
        
        await supabase
          .from('price_extractions')
          .update({
            extraction_status: canonicalStatus,
            extracted_price: result.extractedPrice,
            currency: result.currency,
            includes_taxes_fees: result.includesTaxesFees,
            dates_validated: result.directlyComparable && result.success, // Set dates_validated for proper classification
            evidence_snippets: result.evidenceSnippet ? [result.evidenceSnippet] : null,
            extraction_metadata: {
              structuralProof: result.structuralProof,
              providerAttempts: result.providerAttempts,
              goldenPath: result.goldenPath,
              durationMs: result.durationMs,
              originalStatus: result.status, // Preserve original for debugging
              price_type: result.directlyComparable ? 'TOTAL_STAY' : 'UNKNOWN',
              verification: result.directlyComparable ? 'VERIFIED' : 'UNVERIFIED',
            },
            price_type: result.directlyComparable ? 'TOTAL_STAY' : 'UNKNOWN',
            provider_used: 'zyte',
            updated_at: new Date().toISOString(),
          })
          .eq('id', extractionId);

        console.log(`[VRBO_PIPE] search_id=${ctxSearchId} platform=${ctxPlatform} extraction_id=${extractionId} persisted status=${canonicalStatus} price_type=${result.directlyComparable ? 'TOTAL_STAY' : 'UNKNOWN'} extracted_price=${result.extractedPrice ?? 'null'}`);
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
