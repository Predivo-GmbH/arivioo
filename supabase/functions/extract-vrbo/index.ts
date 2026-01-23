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
// ZYTE EXTRACTION WITH MULTI-STEP NAVIGATION
// ============================================================================
// 
// USER-VERIFIED WORKFLOW (2026-01-23):
// 1. Start at property URL: https://www.vrbo.com/9836046ha
// 2. Enter dates + click "Check availability"
// 3. Land on search results: /search?startDate=...&selected=...
// 4. Click "Continue with your booking" on top result
// 5. Land on property page WITH dates in URL
// 6. Click "Begin booking"
// 7. Land on checkout/session page
// 8. Extract "Trip total" / "Total"
//
// KEY INSIGHT: We must navigate through the SEARCH RESULTS page, not
// try to click booking buttons directly on the initial property page.
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

    // ===========================================================================
    // HELPER: Make Zyte API call with actions
    // ===========================================================================
    const zyteExtract = async (url: string, actions: any[], timeoutMs: number) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const requestBody = {
          url,
          browserHtml: true,
          javascript: true,
          actions,
        };
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

    // ===========================================================================
    // STEP 1: Load property page and click "Check availability"
    // This submits the date form and navigates to search results
    // ===========================================================================
    console.log(`[VRBO] STEP 1: Loading property page with dates and clicking Check availability`);
    
    // JavaScript to fill dates and click "Check availability"
    const clickCheckAvailabilityJS = `
      (function() {
        const result = { clicked: false, buttonText: '', foundDateInputs: false, error: null, debug: {} };
        try {
          // Look for "Check availability" button - this is the CTA on property page
          const allButtons = Array.from(document.querySelectorAll('button, a[role="button"], input[type="submit"]'));
          
          for (const btn of allButtons) {
            const text = (btn.textContent || btn.value || '').trim().toLowerCase();
            if (text.includes('check availability') || text.includes('search')) {
              btn.scrollIntoView({ behavior: 'instant', block: 'center' });
              btn.click();
              result.clicked = true;
              result.buttonText = text.slice(0, 50);
              return JSON.stringify(result);
            }
          }
          
          // Fallback: Look for date picker submit button in booking widget
          const bookingWidget = document.querySelector('[data-stid="property-booking-widget"], [class*="BookingWidget"], [class*="booking-widget"]');
          if (bookingWidget) {
            result.debug.foundBookingWidget = true;
            const submitBtn = bookingWidget.querySelector('button[type="submit"], button.uitk-button-primary');
            if (submitBtn) {
              submitBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
              submitBtn.click();
              result.clicked = true;
              result.buttonText = (submitBtn.textContent || 'widget-submit').trim().slice(0, 50);
              return JSON.stringify(result);
            }
          }
          
          result.debug.totalButtons = allButtons.length;
          result.error = 'No Check availability button found';
        } catch (e) {
          result.error = e.message || String(e);
        }
        return JSON.stringify(result);
      })();
    `;

    const step1Actions = [
      { action: 'waitForTimeout', timeout: 8 }, // Wait for page to fully hydrate
      { action: 'evaluate', source: clickCheckAvailabilityJS },
      { action: 'waitForTimeout', timeout: 10 }, // Wait for navigation to search results
    ];

    let step1Response;
    try {
      step1Response = await zyteExtract(datedUrl, step1Actions, 60000);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`[VRBO] STEP 1 failed: ${msg}`);
      result.error = `Step 1 (Check availability) failed: ${msg}`;
      result.durationMs = Date.now() - start;
      return result;
    }

    if (!step1Response.ok) {
      const errText = await step1Response.text();
      console.log(`[VRBO] STEP 1 HTTP error: ${step1Response.status}`);
      result.httpStatus = step1Response.status;
      result.error = `Step 1 HTTP ${step1Response.status}: ${errText.slice(0, 200)}`;
      result.durationMs = Date.now() - start;
      return result;
    }

    const step1Data = await step1Response.json();
    const step1Html = step1Data.browserHtml || '';
    const step1Url = step1Data.url || datedUrl;
    result.httpStatus = step1Response.status;
    
    console.log(`[VRBO] STEP 1 complete: ${step1Html.length} bytes, url=${step1Url}`);
    
    // Check if we landed on search results page
    const isSearchResultsPage = step1Url.includes('/search') || step1Url.includes('selected=') || step1Html.includes('Continue with your booking');
    console.log(`[VRBO] STEP 1 landed on search results: ${isSearchResultsPage}`);

    // ===========================================================================
    // STEP 2: On search results page, click "Continue with your booking"
    // This takes us to the property page WITH dates in URL
    // ===========================================================================
    let step2Url = step1Url;
    let step2Html = step1Html;
    
    if (isSearchResultsPage) {
      console.log(`[VRBO] STEP 2: Clicking 'Continue with your booking' on search results`);
      
      const clickContinueBookingJS = `
        (function() {
          const result = { clicked: false, buttonText: '', error: null, debug: {} };
          try {
            // Look for "Continue with your booking" link/button - this is on search results
            const allClickables = Array.from(document.querySelectorAll('a, button'));
            
            for (const el of allClickables) {
              const text = (el.textContent || '').trim().toLowerCase();
              if (text.includes('continue with your booking') || text.includes('continue booking')) {
                el.scrollIntoView({ behavior: 'instant', block: 'center' });
                el.click();
                result.clicked = true;
                result.buttonText = text.slice(0, 60);
                return JSON.stringify(result);
              }
            }
            
            // Fallback: Look for the first property card link
            const propertyCards = document.querySelectorAll('[data-stid="property-listing-results"] a, .uitk-card a[href*="vrbo.com"]');
            if (propertyCards.length > 0) {
              result.debug.foundPropertyCards = propertyCards.length;
              const firstCard = propertyCards[0];
              firstCard.click();
              result.clicked = true;
              result.buttonText = 'first-property-card';
              return JSON.stringify(result);
            }
            
            result.debug.totalClickables = allClickables.length;
            result.error = 'No Continue with your booking link found';
          } catch (e) {
            result.error = e.message || String(e);
          }
          return JSON.stringify(result);
        })();
      `;

      const step2Actions = [
        { action: 'waitForTimeout', timeout: 5 },
        { action: 'evaluate', source: clickContinueBookingJS },
        { action: 'waitForTimeout', timeout: 10 }, // Wait for navigation to property page
      ];

      try {
        const step2Response = await zyteExtract(step1Url, step2Actions, 60000);
        if (step2Response.ok) {
          const step2Data = await step2Response.json();
          step2Html = step2Data.browserHtml || step1Html;
          step2Url = step2Data.url || step1Url;
          console.log(`[VRBO] STEP 2 complete: ${step2Html.length} bytes, url=${step2Url}`);
        } else {
          console.log(`[VRBO] STEP 2 HTTP error: ${step2Response.status}, continuing with step 1 HTML`);
          await step2Response.text(); // consume body
        }
      } catch (e) {
        console.log(`[VRBO] STEP 2 failed: ${e}, continuing with step 1 HTML`);
      }
    } else {
      // We might have landed directly on the property page with dates
      console.log(`[VRBO] STEP 2 skipped: Already on property page with dates`);
    }

    // Store property page state
    result.propertyPageReached = step2Html.length > 10000;
    result.html = step2Html;
    result.content = step2Html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    result.finalUrl = step2Url;

    // ===========================================================================
    // STEP 3: Click "Begin booking" to open checkout drawer / navigate to checkout
    // ===========================================================================
    console.log(`[VRBO] STEP 3: Clicking 'Begin booking' button`);
    
    const clickBeginBookingJS = `
      (function() {
        const result = { clicked: false, buttonText: '', error: null, debug: {} };
        try {
          const allClickables = Array.from(document.querySelectorAll('button, a[role="button"], a.uitk-button'));
          
          // Priority 1: Exact "Begin booking" match
          for (const el of allClickables) {
            const text = (el.textContent || '').trim().toLowerCase();
            if (text === 'begin booking' || text.includes('begin booking')) {
              el.scrollIntoView({ behavior: 'instant', block: 'center' });
              el.click();
              result.clicked = true;
              result.buttonText = text.slice(0, 50);
              return JSON.stringify(result);
            }
          }
          
          // Priority 2: "Book" or "Reserve" in pricing card
          const priceCard = document.querySelector('[data-stid="property-price-summary"], [class*="BookingCard"], [class*="price-summary"]');
          if (priceCard) {
            result.debug.foundPriceCard = true;
            const btns = priceCard.querySelectorAll('button, a[role="button"]');
            for (const btn of btns) {
              const text = (btn.textContent || '').trim().toLowerCase();
              if (text.includes('book') || text.includes('reserve')) {
                btn.scrollIntoView({ behavior: 'instant', block: 'center' });
                btn.click();
                result.clicked = true;
                result.buttonText = text.slice(0, 50);
                return JSON.stringify(result);
              }
            }
          }
          
          // Priority 3: Primary button with booking-related text anywhere
          for (const el of allClickables) {
            const text = (el.textContent || '').trim().toLowerCase();
            if ((text.includes('book') || text.includes('reserve')) && el.classList.contains('uitk-button-primary')) {
              el.scrollIntoView({ behavior: 'instant', block: 'center' });
              el.click();
              result.clicked = true;
              result.buttonText = text.slice(0, 50);
              return JSON.stringify(result);
            }
          }
          
          result.debug.totalClickables = allClickables.length;
          result.error = 'No Begin booking button found';
        } catch (e) {
          result.error = e.message || String(e);
        }
        return JSON.stringify(result);
      })();
    `;

    const step3Actions = [
      { action: 'waitForTimeout', timeout: 5 },
      { action: 'evaluate', source: clickBeginBookingJS },
      { action: 'waitForTimeout', timeout: 15 }, // Wait for checkout/session page to load
    ];

    let step3Html = step2Html;
    let step3Url = step2Url;
    
    try {
      const step3Response = await zyteExtract(step2Url, step3Actions, 90000);
      if (step3Response.ok) {
        const step3Data = await step3Response.json();
        step3Html = step3Data.browserHtml || step2Html;
        step3Url = step3Data.url || step2Url;
        console.log(`[VRBO] STEP 3 complete: ${step3Html.length} bytes, url=${step3Url}`);
      } else {
        console.log(`[VRBO] STEP 3 HTTP error: ${step3Response.status}`);
        await step3Response.text();
      }
    } catch (e) {
      console.log(`[VRBO] STEP 3 failed: ${e}`);
    }

    // Update with step 3 result
    result.html = step3Html;
    result.content = step3Html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    result.finalUrl = step3Url;
    
    // Check if we reached checkout
    const reachedCheckout = isCheckoutSessionUrl(step3Url) || hasCheckoutSignals(result.content);
    result.checkoutSessionReached = reachedCheckout;
    
    console.log(`[VRBO] STEP 3 final_url=${step3Url}`);
    console.log(`[VRBO] STEP 3 checkout_reached=${reachedCheckout}`);

    // ===========================================================================
    // STEP 4: If not at checkout yet, try one more click (drawer may have opened)
    // ===========================================================================
    if (!reachedCheckout) {
      console.log(`[VRBO] STEP 4: Retry - looking for checkout CTA in drawer/modal`);
      
      const clickDrawerCTAJS = `
        (function() {
          const result = { clicked: false, buttonText: '', error: null };
          try {
            // Look in any open drawer/modal
            const modalContainers = document.querySelectorAll('[role="dialog"], .uitk-sheet, .uitk-modal, [class*="drawer"], [class*="Drawer"]');
            
            for (const modal of modalContainers) {
              const btns = modal.querySelectorAll('button, a[role="button"]');
              for (const btn of btns) {
                const text = (btn.textContent || '').trim().toLowerCase();
                if (text.includes('begin booking') || text.includes('continue') || text.includes('proceed') || text === 'book') {
                  btn.scrollIntoView({ behavior: 'instant', block: 'center' });
                  btn.click();
                  result.clicked = true;
                  result.buttonText = text.slice(0, 50);
                  return JSON.stringify(result);
                }
              }
            }
            
            // Fallback: any visible primary button
            const visiblePrimary = document.querySelector('button.uitk-button-primary:not([disabled])');
            if (visiblePrimary) {
              visiblePrimary.click();
              result.clicked = true;
              result.buttonText = (visiblePrimary.textContent || 'primary').trim().slice(0, 50);
              return JSON.stringify(result);
            }
            
            result.error = 'No drawer CTA found';
          } catch (e) {
            result.error = e.message || String(e);
          }
          return JSON.stringify(result);
        })();
      `;

      const step4Actions = [
        { action: 'waitForTimeout', timeout: 3 },
        { action: 'evaluate', source: clickDrawerCTAJS },
        { action: 'waitForTimeout', timeout: 15 },
      ];

      try {
        const step4Response = await zyteExtract(step3Url, step4Actions, 60000);
        if (step4Response.ok) {
          const step4Data = await step4Response.json();
          const step4Html = step4Data.browserHtml || step3Html;
          const step4Url = step4Data.url || step3Url;
          const step4Content = step4Html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
          
          console.log(`[VRBO] STEP 4 complete: ${step4Html.length} bytes, url=${step4Url}`);
          
          const step4Checkout = isCheckoutSessionUrl(step4Url) || hasCheckoutSignals(step4Content);
          if (step4Checkout) {
            result.html = step4Html;
            result.content = step4Content;
            result.finalUrl = step4Url;
            result.checkoutSessionReached = true;
            console.log(`[VRBO] STEP 4 checkout_reached=true`);
          }
        } else {
          await step4Response.text();
        }
      } catch (e) {
        console.log(`[VRBO] STEP 4 failed: ${e}`);
      }
    }

    result.durationMs = Date.now() - start;
    result.success = result.propertyPageReached;
    
    console.log(`[VRBO] Navigation complete: property_reached=${result.propertyPageReached}, checkout_reached=${result.checkoutSessionReached}, ${result.durationMs}ms`);

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
