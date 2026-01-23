import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

/**
 * ============================================================================
 * AIRPAZ DEDICATED EXTRACTOR v1.0
 * ============================================================================
 * 
 * GOLDEN PATH:
 * 1. Build URL with date/guest params (ci=, co=, ro=, ad=)
 * 2. Use Zyte browserHtml to render JS-heavy Nuxt.js page
 * 3. Look for room cards with "Book Now" prices or total display
 * 4. Extract TOTAL stay price (not nightly) with currency
 * 
 * URL PARAM FORMAT:
 * https://www.airpaz.com/en/hotel/{slug}.{id}?ci=YYYY-MM-DD&co=YYYY-MM-DD&ro=1&ad=1
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
  | 'page_not_reached'
  | 'total_price_not_found'
  | 'nightly_only_rejected'
  | 'render_failed'
  | 'validation_error'
  | 'price_not_found'
  | 'platform_blocked';

type FailureCategory = 
  | 'blocked'
  | 'captcha'
  | 'params_missing'
  | 'no_rooms_found'
  | 'nightly_only'
  | 'unavailable'
  | 'render_error'
  | 'no_price'
  | 'success';

interface StructuralProof {
  page_reached: boolean;
  dates_in_url: boolean;
  dates_visible_on_page: boolean;
  rooms_section_found: boolean;
  total_label_found: boolean;
  nightly_rate_found: boolean;
  directly_comparable: boolean;
  proof_version: string;
  currency_detected: string | null;
  nights_detected: number | null;
  entry_url_used: string | null;
  final_url: string | null;
  content_hash: string | null;
  failure_category: FailureCategory;
  extraction_method: string | null;
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
  includesTaxesFees: boolean | null;
  directlyComparable: boolean;
  evidenceSnippet: string | null;
  structuralProof: StructuralProof;
  durationMs: number;
  error: string | null;
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
 * Build Airpaz URL with date and guest params
 * Airpaz uses: ci=YYYY-MM-DD, co=YYYY-MM-DD, ro=rooms, ad=adults
 */
function buildAirpazUrl(
  originalUrl: string,
  checkIn: string,
  checkOut: string,
  adults: number = 1,
  rooms: number = 1
): string {
  try {
    const urlObj = new URL(originalUrl);
    
    // Set Airpaz-specific params
    urlObj.searchParams.set('ci', checkIn);
    urlObj.searchParams.set('co', checkOut);
    urlObj.searchParams.set('ro', String(rooms));
    urlObj.searchParams.set('ad', String(adults));
    
    const datedUrl = urlObj.toString();
    console.log(`[AIRPAZ] dated_url_or_action=${datedUrl}`);
    return datedUrl;
  } catch (e) {
    // Fallback: append params
    const separator = originalUrl.includes('?') ? '&' : '?';
    const params = `ci=${checkIn}&co=${checkOut}&ro=${rooms}&ad=${adults}`;
    const datedUrl = `${originalUrl}${separator}${params}`;
    console.log(`[AIRPAZ] dated_url_or_action=${datedUrl}`);
    return datedUrl;
  }
}

/**
 * Parse price amount from string
 */
function parsePrice(text: string): number | null {
  const match = text.match(/[\$€£]?\s*([\d,]+(?:\.\d{2})?)/);
  if (match) {
    const val = parseFloat(match[1].replace(/,/g, ''));
    return isNaN(val) ? null : val;
  }
  return null;
}

/**
 * Detect currency from price string
 */
function detectCurrency(text: string): string {
  const upperText = text.toUpperCase();
  if (upperText.includes('USD') || text.includes('$')) return 'USD';
  if (upperText.includes('EUR') || text.includes('€')) return 'EUR';
  if (upperText.includes('GBP') || text.includes('£')) return 'GBP';
  if (upperText.includes('ZAR') || text.includes('R')) return 'ZAR';
  if (upperText.includes('IDR')) return 'IDR';
  return 'USD'; // Default
}

// ============================================================================
// AIRPAZ PRICE EXTRACTION
// ============================================================================

interface AirpazPriceResult {
  totalFound: boolean;
  totalPrice: number | null;
  currency: string | null;
  totalEvidence: string | null;
  directlyComparable: boolean;
  nightlyRate: number | null;
  roomsFound: boolean;
  labelsFound: string[];
}

function extractAirpazPrice(content: string, nights: number): AirpazPriceResult {
  const result: AirpazPriceResult = {
    totalFound: false,
    totalPrice: null,
    currency: null,
    totalEvidence: null,
    directlyComparable: false,
    nightlyRate: null,
    roomsFound: false,
    labelsFound: [],
  };

  // Check if rooms section is present
  if (/room/i.test(content) && (/book now|select|choose/i.test(content))) {
    result.roomsFound = true;
    result.labelsFound.push('rooms_section');
  }

  // Look for nightly rates (to use for validation, not as result)
  const nightlyPatterns = [
    /\$\s*([\d,]+(?:\.\d{2})?)\s*(?:\/|\s*per)?\s*night/i,
    /per\s*night[:\s]*\$?\s*([\d,]+(?:\.\d{2})?)/i,
    /(?:USD|US\$)\s*([\d,]+(?:\.\d{2})?)\s*(?:\/|\s*per)?\s*night/i,
  ];

  for (const pattern of nightlyPatterns) {
    const match = content.match(pattern);
    if (match) {
      const nightlyPrice = parsePrice(match[0]);
      if (nightlyPrice && nightlyPrice > 10 && nightlyPrice < 10000) {
        result.nightlyRate = nightlyPrice;
        result.labelsFound.push('nightly_rate');
        console.log(`[AIRPAZ] nightly_rate=${nightlyPrice}`);
        break;
      }
    }
  }

  // Calculate expected minimum total (nightly * nights * 1.0 = at least the subtotal)
  const minTotal = result.nightlyRate ? result.nightlyRate * nights * 0.9 : 50;
  const maxTotal = result.nightlyRate ? result.nightlyRate * nights * 2.5 : 50000;

  // PRIORITY 1: Look for explicit "Total" labels
  const totalPatterns = [
    // "Total: $XXX" or "Total Price: $XXX"
    /\b(?:total|total\s*price|grand\s*total)[:\s]+(?:USD|US\$|\$)?\s*([\d,]+(?:\.\d{2})?)/gi,
    // "$XXX total" or "$XXX for N nights"
    /(?:USD|US\$|\$)\s*([\d,]+(?:\.\d{2})?)\s+(?:total|for\s+\d+\s*nights?)/gi,
    // "USD XXX" with total label nearby
    /(?:total|all\s*inclusive)[^\d]{0,20}([\d,]+(?:\.\d{2})?)\s*(?:USD|US\$)?/gi,
  ];

  const foundTotals: Array<{ price: number; currency: string; context: string }> = [];

  for (const pattern of totalPatterns) {
    const matches = [...content.matchAll(pattern)];
    for (const match of matches) {
      const startIdx = Math.max(0, match.index! - 50);
      const endIdx = Math.min(content.length, match.index! + match[0].length + 30);
      const context = content.slice(startIdx, endIdx);

      // Skip if context mentions "per night" or "nightly"
      if (/per\s*night|nightly|\/\s*night/i.test(context)) continue;

      const price = parsePrice(match[0]);
      const currency = detectCurrency(match[0] + context);

      if (price && price >= minTotal && price <= maxTotal) {
        foundTotals.push({ price, currency, context: context.trim() });
      }
    }
  }

  console.log(`[AIRPAZ] Found ${foundTotals.length} total candidates: ${foundTotals.map(t => `${t.currency} ${t.price}`).join(', ')}`);

  if (foundTotals.length > 0) {
    // If we have a nightly rate, the total should be > nightly * nights
    foundTotals.sort((a, b) => b.price - a.price);

    for (const candidate of foundTotals) {
      // Validate: if we know nightly rate, total must be higher than subtotal
      if (result.nightlyRate) {
        const subtotal = result.nightlyRate * nights;
        if (candidate.price < subtotal * 0.95) {
          console.log(`[AIRPAZ] Rejecting ${candidate.price} - less than subtotal ${subtotal}`);
          continue;
        }
      }

      result.totalFound = true;
      result.totalPrice = candidate.price;
      result.currency = candidate.currency;
      result.totalEvidence = candidate.context.slice(0, 150);
      result.directlyComparable = true;
      result.labelsFound.push('Total');

      console.log(`[AIRPAZ] total_found=${candidate.price} currency=${candidate.currency} directly_comparable=true`);
      return result;
    }
  }

  // PRIORITY 2: Look for room prices (often shown as total per room)
  // Airpaz shows: "Book Now" button with price = total for stay
  const roomPricePatterns = [
    // "Book Now $XXX" pattern
    /book\s*now[^\d]{0,10}(?:USD|US\$|\$)\s*([\d,]+(?:\.\d{2})?)/gi,
    // Room card with price
    /(?:select|choose)\s*room[^\d]{0,20}(?:USD|US\$|\$)\s*([\d,]+(?:\.\d{2})?)/gi,
    // Room price with currency
    /room[^\d]{0,30}(?:USD|US\$|\$)\s*([\d,]+(?:\.\d{2})?)/gi,
  ];

  for (const pattern of roomPricePatterns) {
    const matches = [...content.matchAll(pattern)];
    for (const match of matches) {
      const startIdx = Math.max(0, match.index! - 30);
      const endIdx = Math.min(content.length, match.index! + match[0].length + 30);
      const context = content.slice(startIdx, endIdx);

      // Skip if clearly per-night
      if (/per\s*night|nightly|\/\s*night/i.test(context)) continue;

      const price = parsePrice(match[0]);
      const currency = detectCurrency(match[0] + context);

      if (price && price >= minTotal && price <= maxTotal) {
        result.totalFound = true;
        result.totalPrice = price;
        result.currency = currency;
        result.totalEvidence = context.trim().slice(0, 150);
        result.directlyComparable = true;
        result.labelsFound.push('room_price');

        console.log(`[AIRPAZ] total_found=${price} currency=${currency} (room_price) directly_comparable=true`);
        return result;
      }
    }
  }

  // PRIORITY 3: Fall back to calculating from nightly if we can verify it's a total display
  if (result.nightlyRate && nights > 0) {
    // Only use calculated total if we see some indicator it's the full stay
    if (/\d+\s*nights?/i.test(content)) {
      const calculatedTotal = result.nightlyRate * nights;
      result.totalFound = true;
      result.totalPrice = calculatedTotal;
      result.currency = 'USD';
      result.totalEvidence = `Calculated: ${result.nightlyRate} x ${nights} nights`;
      result.directlyComparable = false; // Mark as not directly comparable since calculated
      result.labelsFound.push('calculated');

      console.log(`[AIRPAZ] total_found=${calculatedTotal} (calculated) directly_comparable=false`);
      return result;
    }
  }

  console.log(`[AIRPAZ] failure_reason=price_not_found labels=${result.labelsFound.join(',')}`);
  return result;
}

// ============================================================================
// ZYTE EXTRACTION
// ============================================================================

async function extractWithZyte(datedUrl: string, nights: number): Promise<{
  success: boolean;
  pageReached: boolean;
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
    pageReached: false,
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
      console.log(`[AIRPAZ] failure_reason=api_key_missing`);
      return result;
    }

    const zyteAuth = btoa(apiKey + ':');

    console.log(`[AIRPAZ] provider=zyte status=requesting url=${datedUrl}`);

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
      }),
    });

    result.httpStatus = response.status;

    if (!response.ok) {
      const errText = await response.text();
      result.error = `Zyte HTTP ${response.status}: ${errText.slice(0, 200)}`;
      result.durationMs = Date.now() - start;
      console.log(`[AIRPAZ] provider=zyte status=error http_status=${response.status}`);
      return result;
    }

    const data = await response.json();
    const html = data.browserHtml || '';
    const finalUrl = data.url || datedUrl;

    result.html = html;
    result.content = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    result.finalUrl = finalUrl;
    result.pageReached = html.length > 10000;
    result.success = result.pageReached;
    result.durationMs = Date.now() - start;

    console.log(`[AIRPAZ] provider=zyte status=success content_length=${html.length}`);

    // Check for bot detection - must be specific to avoid false positives
    const lowerContent = result.content.toLowerCase();
    const botPatterns = [
      /please\s+verify\s+you\s+are\s+human/i,
      /complete\s+the\s+captcha/i,
      /access\s+denied\s+to\s+this\s+page/i,
      /your\s+ip\s+(?:address\s+)?(?:has\s+been\s+)?blocked/i,
      /cloudflare.*ray\s+id/i,
      /please\s+wait\s+while\s+we\s+verify/i,
    ];
    
    const isBlocked = botPatterns.some(pattern => pattern.test(result.content));
    
    if (isBlocked) {
      result.success = false;
      result.error = 'Bot/CAPTCHA detected';
      console.log(`[AIRPAZ] failure_reason=blocked`);
    }

    return result;
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    result.durationMs = Date.now() - start;
    console.log(`[AIRPAZ] provider=zyte status=exception error=${result.error}`);
    return result;
  }
}

// ============================================================================
// MAIN EXTRACTION FLOW
// ============================================================================

async function runExtraction(
  request: ExtractionRequest
): Promise<ExtractionResult> {
  const startTime = Date.now();
  
  const proof: StructuralProof = {
    page_reached: false,
    dates_in_url: false,
    dates_visible_on_page: false,
    rooms_section_found: false,
    total_label_found: false,
    nightly_rate_found: false,
    directly_comparable: false,
    proof_version: 'airpaz-v1.0',
    currency_detected: null,
    nights_detected: null,
    entry_url_used: null,
    final_url: null,
    content_hash: null,
    failure_category: 'no_price',
    extraction_method: null,
  };

  const result: ExtractionResult = {
    success: false,
    status: 'price_not_found',
    failureCategory: 'no_price',
    extractedPrice: null,
    currency: null,
    originalAmount: null,
    originalCurrency: null,
    includesTaxesFees: null,
    directlyComparable: false,
    evidenceSnippet: null,
    structuralProof: proof,
    durationMs: 0,
    error: null,
    goldenPath: true,
  };

  // Validate request
  if (!request.url) {
    result.status = 'validation_error';
    result.failureCategory = 'params_missing';
    result.error = 'URL is required';
    result.durationMs = Date.now() - startTime;
    console.log(`[AIRPAZ] failure_reason=url_missing`);
    return result;
  }

  if (!request.checkIn || !request.checkOut) {
    result.status = 'validation_error';
    result.failureCategory = 'params_missing';
    result.error = 'Check-in and check-out dates are required';
    result.durationMs = Date.now() - startTime;
    console.log(`[AIRPAZ] failure_reason=dates_missing`);
    return result;
  }

  const nights = calculateNights(request.checkIn, request.checkOut);
  proof.nights_detected = nights;

  console.log(`[AIRPAZ] url_in=${request.url}`);
  console.log(`[AIRPAZ] dates=${request.checkIn} to ${request.checkOut} (${nights} nights)`);

  // Build URL with date params
  const datedUrl = buildAirpazUrl(
    request.url,
    request.checkIn,
    request.checkOut,
    request.adults || 1,
    request.rooms || 1
  );
  proof.entry_url_used = datedUrl;
  proof.dates_in_url = true;

  // Extract with Zyte
  const zyteResult = await extractWithZyte(datedUrl, nights);
  
  proof.page_reached = zyteResult.pageReached;
  proof.final_url = zyteResult.finalUrl;
  proof.content_hash = zyteResult.content ? simpleHash(zyteResult.content.slice(0, 5000)) : null;

  if (!zyteResult.success) {
    result.error = zyteResult.error;
    
    if (zyteResult.error?.includes('CAPTCHA') || zyteResult.error?.includes('blocked')) {
      result.status = 'blocked_captcha_or_bot';
      result.failureCategory = 'blocked';
      proof.failure_category = 'blocked';
      console.log(`[AIRPAZ] failure_reason=blocked`);
    } else if (zyteResult.httpStatus === 429) {
      result.status = 'blocked_rate_limit';
      result.failureCategory = 'blocked';
      proof.failure_category = 'blocked';
      console.log(`[AIRPAZ] failure_reason=rate_limited`);
    } else {
      result.status = 'render_failed';
      result.failureCategory = 'render_error';
      proof.failure_category = 'render_error';
      console.log(`[AIRPAZ] failure_reason=render_failed`);
    }
    
    result.durationMs = Date.now() - startTime;
    return result;
  }

  // Check if dates are visible on page
  const checkInFormatted = request.checkIn; // YYYY-MM-DD
  const checkInDate = new Date(request.checkIn);
  const datePatterns = [
    new RegExp(checkInFormatted, 'i'),
    new RegExp(checkInDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), 'i'),
    new RegExp(checkInDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric' }), 'i'),
  ];

  for (const pattern of datePatterns) {
    if (pattern.test(zyteResult.content)) {
      proof.dates_visible_on_page = true;
      break;
    }
  }

  if (!proof.dates_visible_on_page) {
    console.log(`[AIRPAZ] Warning: dates not visible on page`);
  }

  // CRITICAL: Check for sold out / unavailable BEFORE price extraction
  // Airpaz shows these messages when rooms are fully booked
  const soldOutPatterns = [
    /rooms?\s*fully\s*booked/i,
    /fully\s*booked/i,
    /sold\s*out/i,
    /no\s*rooms?\s*available/i,
    /not\s*available\s*for\s*(?:these|selected)\s*dates/i,
    /no\s*availability/i,
    /unavailable\s*for\s*(?:these|selected|your)\s*dates/i,
    /all\s*rooms?\s*(?:are\s*)?(?:sold\s*out|booked|unavailable)/i,
    /property\s*(?:is\s*)?(?:fully\s*booked|not\s*available)/i,
  ];

  const lowerContent = zyteResult.content.toLowerCase();
  for (const pattern of soldOutPatterns) {
    if (pattern.test(zyteResult.content)) {
      // Extract the matched text for evidence
      const match = zyteResult.content.match(pattern);
      const evidenceText = match ? match[0] : 'sold out indicator found';
      
      result.status = 'dates_unavailable';
      result.failureCategory = 'unavailable';
      proof.failure_category = 'unavailable';
      result.error = `Property sold out for these dates: "${evidenceText}"`;
      result.evidenceSnippet = evidenceText;
      result.durationMs = Date.now() - startTime;
      result.structuralProof = proof;
      
      console.log(`[AIRPAZ] failure_reason=sold_out evidence="${evidenceText}"`);
      return result;
    }
  }

  // Extract price
  const priceResult = extractAirpazPrice(zyteResult.content, nights);

  proof.rooms_section_found = priceResult.roomsFound;
  proof.nightly_rate_found = priceResult.nightlyRate !== null;
  proof.total_label_found = priceResult.totalFound;
  proof.directly_comparable = priceResult.directlyComparable;
  proof.currency_detected = priceResult.currency;
  proof.extraction_method = priceResult.labelsFound.join(',');

  if (priceResult.totalFound && priceResult.totalPrice) {
    result.success = true;
    result.status = 'success_total_stay';
    result.failureCategory = 'success';
    result.extractedPrice = priceResult.totalPrice;
    result.currency = priceResult.currency;
    result.originalAmount = priceResult.totalPrice;
    result.originalCurrency = priceResult.currency;
    result.includesTaxesFees = true; // Airpaz typically shows all-inclusive prices
    result.directlyComparable = priceResult.directlyComparable;
    result.evidenceSnippet = priceResult.totalEvidence;
    proof.failure_category = 'success';

    console.log(`[AIRPAZ] SUCCESS: total=${priceResult.totalPrice} currency=${priceResult.currency} directly_comparable=${priceResult.directlyComparable}`);
  } else if (priceResult.nightlyRate && !priceResult.totalFound) {
    // We found nightly rate but no total - this is "nightly only" case
    result.status = 'nightly_only_rejected';
    result.failureCategory = 'nightly_only';
    proof.failure_category = 'nightly_only';
    result.error = `Only nightly rate found: ${priceResult.currency || 'USD'} ${priceResult.nightlyRate}/night`;
    console.log(`[AIRPAZ] failure_reason=nightly_only rate=${priceResult.nightlyRate}`);
  } else if (!priceResult.roomsFound) {
    // No rooms section found - might be unavailable or page structure issue
    result.status = 'dates_unavailable';
    result.failureCategory = 'unavailable';
    proof.failure_category = 'unavailable';
    result.error = 'No rooms section found - property may be unavailable for these dates';
    console.log(`[AIRPAZ] failure_reason=sold_out`);
  } else {
    // Rooms found but no price - extraction failed
    result.status = 'total_price_not_found';
    result.failureCategory = 'no_price';
    proof.failure_category = 'no_price';
    result.error = 'Rooms found but could not extract total price';
    console.log(`[AIRPAZ] failure_reason=price_not_found`);
  }

  result.durationMs = Date.now() - startTime;
  result.structuralProof = proof;

  return result;
}

// ============================================================================
// HANDLER
// ============================================================================

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();

  try {
    const body = await req.json();
    const {
      extractionId,
      url,
      checkIn,
      checkOut,
      adults = 1,
      children = 0,
      rooms = 1,
    } = body;

    console.log(`[AIRPAZ] Starting extraction: extractionId=${extractionId}, url=${url}`);

    // Initialize Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // If extractionId provided, fetch URL and dates from database
    let extractionUrl = url;
    let extractionCheckIn = checkIn;
    let extractionCheckOut = checkOut;

    if (extractionId && !extractionUrl) {
      const { data: extraction, error: fetchError } = await supabase
        .from('price_extractions')
        .select('deep_link, search:searches(check_in_date, check_out_date)')
        .eq('id', extractionId)
        .single();

      if (fetchError || !extraction) {
        console.error(`[AIRPAZ] Failed to fetch extraction: ${fetchError?.message}`);
        return new Response(
          JSON.stringify({ error: 'Extraction not found' }),
          { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      extractionUrl = extraction.deep_link;
      extractionCheckIn = (extraction as any).search?.check_in_date;
      extractionCheckOut = (extraction as any).search?.check_out_date;
    }

    // Run extraction
    const result = await runExtraction({
      extractionId,
      url: extractionUrl,
      checkIn: extractionCheckIn,
      checkOut: extractionCheckOut,
      adults,
      children,
      rooms,
    });

    // Update database if extractionId provided
    if (extractionId) {
      const updatePayload: Record<string, any> = {
        extraction_status: result.status,
        extraction_error: result.error,
        provider_used: 'zyte',
        updated_at: new Date().toISOString(),
        extraction_metadata: {
          structural_proof: result.structuralProof,
          duration_ms: result.durationMs,
          golden_path: result.goldenPath,
          provider: 'zyte',
          extractor_version: 'airpaz-v1.0',
        },
      };

      if (result.success && result.extractedPrice) {
        updatePayload.extracted_price = result.extractedPrice;
        updatePayload.currency = result.currency;
        updatePayload.includes_taxes_fees = result.includesTaxesFees;
        updatePayload.confidence_score = result.directlyComparable ? 90 : 60;
        updatePayload.dates_validated = result.structuralProof.dates_visible_on_page;
        updatePayload.price_type = result.directlyComparable ? 'TOTAL_STAY' : 'UNKNOWN';
        updatePayload.evidence_snippets = result.evidenceSnippet ? [result.evidenceSnippet] : [];
      }

      const { error: updateError } = await supabase
        .from('price_extractions')
        .update(updatePayload)
        .eq('id', extractionId);

      if (updateError) {
        console.error(`[AIRPAZ] Failed to update extraction: ${updateError.message}`);
      } else {
        console.log(`[AIRPAZ] Updated extraction ${extractionId} with status=${result.status}`);
      }
    }

    const totalDuration = Date.now() - startTime;
    console.log(`[AIRPAZ] Complete: status=${result.status} price=${result.extractedPrice} duration=${totalDuration}ms`);

    return new Response(
      JSON.stringify(result),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[AIRPAZ] Error: ${errorMessage}`);

    return new Response(
      JSON.stringify({
        success: false,
        status: 'render_failed',
        error: errorMessage,
        durationMs: Date.now() - startTime,
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
