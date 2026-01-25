import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

/**
 * ============================================================================
 * BOOKING.COM FIRECRAWL-FIRST GOLDEN PATH EXTRACTOR v2.0
 * ============================================================================
 * 
 * Based on successful Jan 10 extraction that used Firecrawl to extract
 * "$1,012 for 3 nights" from booking.com/hotel/us/tahquitz-rock-lodge.html
 * 
 * Strategy: Firecrawl (primary) → Zyte (fallback) → Browserless (last resort)
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

type TerminalStatus = 
  | 'success_total_stay'
  | 'success_partial'
  | 'unverified'
  | 'dates_unavailable'
  | 'blocked_captcha_or_bot'
  | 'blocked_rate_limit'
  | 'quota_error'
  | 'page_not_reached'
  | 'price_not_found'
  | 'render_failed'
  | 'validation_error'
  | 'timeout';

type Provider = 'firecrawl' | 'zyte' | 'browserless';

interface ProviderAttemptTrace {
  provider: Provider;
  attempted: boolean;
  startedAt: string | null;
  endedAt: string | null;
  outcome: string;
  httpStatus: number | null;
  contentLength: number | null;
  errorMessage: string | null;
}

interface ExtractionRequest {
  extractionId?: string;
  url?: string;
  checkIn: string;
  checkOut: string;
  adults?: number;
}

interface StructuralProofResult {
  breakdown_found: boolean;
  total_label_found: boolean;
  extracted_from_breakdown_total: boolean;
}

interface ExtractionResult {
  success: boolean;
  status: TerminalStatus;
  extractedPrice: number | null;
  currency: string | null;
  includesTaxesFees: boolean | null;
  evidenceSnippet: string | null;
  providerUsed: Provider | null;
  providerAttemptTrace: ProviderAttemptTrace[];
  allPricesFound: string[];
  nightsMatched: boolean;
  datesValidated: boolean;
  totalProven: boolean;
  structuralProof: StructuralProofResult | null;
  failedChecks: string[];
  detectedCheckIn: string | null;
  detectedCheckOut: string | null;
  durationMs: number;
  error: string | null;
}

function calculateNights(checkIn: string, checkOut: string): number {
  const start = new Date(checkIn);
  const end = new Date(checkOut);
  return Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
}

function buildBookingUrl(baseUrl: string, checkIn: string, checkOut: string, adults: number = 2): string {
  const url = new URL(baseUrl);
  url.searchParams.set('checkin', checkIn);
  url.searchParams.set('checkout', checkOut);
  url.searchParams.set('group_adults', String(adults));
  url.searchParams.set('no_rooms', '1');
  url.searchParams.set('selected_currency', 'USD');
  return url.toString();
}

function detectBotBlock(content: string): boolean {
  const lowerContent = content.toLowerCase();
  // Only flag actual bot blocks, not normal "sign in" text
  return (
    lowerContent.includes('captcha') ||
    lowerContent.includes('unusual traffic') ||
    lowerContent.includes('access denied') ||
    lowerContent.includes('please verify you are human') ||
    (lowerContent.includes('verifying') && lowerContent.includes('please wait'))
  );
}

// ============================================================================
// BOOKING.COM PRICE EXTRACTION - VRBO-style strict gate pattern
// ============================================================================

interface StructuralProof {
  breakdown_found: boolean;
  total_label_found: boolean;
  extracted_from_breakdown_total: boolean;
}

interface BookingPriceResult {
  totalFound: boolean;
  totalPrice: number | null;
  currency: string | null;
  totalEvidence: string | null;
  allPrices: Array<{ amount: number; context: string }>;
  nightsMatched: boolean;
  structuralProof: StructuralProof;
  detectedCheckIn: string | null;
  detectedCheckOut: string | null;
  datesValidated: boolean;
  includesTaxesFees: boolean;
  totalProven: boolean;
  failedChecks: string[];
}

function extractBookingTotal(content: string, nights: number, requestedCheckIn: string, requestedCheckOut: string): BookingPriceResult {
  const result: BookingPriceResult = {
    totalFound: false,
    totalPrice: null,
    currency: null,
    totalEvidence: null,
    allPrices: [],
    nightsMatched: false,
    structuralProof: {
      breakdown_found: false,
      total_label_found: false,
      extracted_from_breakdown_total: false,
    },
    detectedCheckIn: null,
    detectedCheckOut: null,
    datesValidated: false,
    includesTaxesFees: false,
    totalProven: false,
    failedChecks: [],
  };

  // ========================================
  // STEP 1: Detect structural proof - breakdown container
  // ========================================
  const breakdownPatterns = [
    /price\s*breakdown/i,
    /your\s*price\s*summary/i,
    /price\s*details/i,
    /booking\s*summary/i,
    /price\s*summary/i,
    /cost\s*breakdown/i,
    /total\s*cost/i,
  ];
  
  for (const pattern of breakdownPatterns) {
    if (pattern.test(content)) {
      result.structuralProof.breakdown_found = true;
      break;
    }
  }

  // ========================================
  // STEP 2: Detect total label
  // ========================================
  const totalLabelPatterns = [
    /(?:grand\s*)?total(?:\s*:|\s*\(|\s*for)/i,
    /total\s*price/i,
    /total\s*amount/i,
    /total\s*cost/i,
    /amount\s*due/i,
    /you\s*pay/i,
    /price\s*for\s*\d+\s*nights?/i,
  ];
  
  for (const pattern of totalLabelPatterns) {
    if (pattern.test(content)) {
      result.structuralProof.total_label_found = true;
      break;
    }
  }

  // ========================================
  // STEP 3: Detect taxes/fees inclusion
  // ========================================
  const taxesIncludedPatterns = [
    /includes?\s*(?:all\s*)?taxes/i,
    /tax(?:es)?\s*(?:&|and)\s*fees?\s*included/i,
    /includes?\s*(?:all\s*)?fees/i,
    /total\s*(?:includes?|incl\.?)\s*(?:taxes|fees)/i,
    /(?:taxes|fees)\s*included/i,
    /no\s*hidden\s*(?:fees|charges)/i,
    /all\s*(?:taxes|charges)\s*included/i,
    /\+\s*(?:US\$|\$|USD\s*)[\d,]+(?:\.\d{2})?\s*(?:taxes|fees)/i,
    /taxes\s*(?:&|and)\s*(?:charges|fees)/i,
  ];

  for (const pattern of taxesIncludedPatterns) {
    if (pattern.test(content)) {
      result.includesTaxesFees = true;
      break;
    }
  }

  // ========================================
  // STEP 4: Detect dates on page
  // ========================================
  // Look for date patterns like "Jan 15, 2025" or "2025-01-15" or "15 Jan 2025"
  const datePatterns = [
    // ISO format: 2025-01-15
    /(\d{4}-\d{2}-\d{2})/g,
    // US format: Jan 15, 2025 or January 15, 2025
    /((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})/gi,
    // EU format: 15 Jan 2025
    /(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4})/gi,
  ];

  const foundDates: string[] = [];
  for (const pattern of datePatterns) {
    const matches = content.match(pattern);
    if (matches) {
      foundDates.push(...matches);
    }
  }

  // Try to match requested dates
  const checkInDate = new Date(requestedCheckIn);
  const checkOutDate = new Date(requestedCheckOut);
  
  const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const checkInMonth = monthNames[checkInDate.getMonth()];
  const checkOutMonth = monthNames[checkOutDate.getMonth()];
  const checkInDay = checkInDate.getDate();
  const checkOutDay = checkOutDate.getDate();
  const checkInYear = checkInDate.getFullYear();
  const checkOutYear = checkOutDate.getFullYear();

  // Check if requested dates appear on page
  const checkInPatterns = [
    new RegExp(`${checkInMonth}[a-z]*\\.?\\s*${checkInDay}`, 'i'),
    new RegExp(`${checkInDay}\\s*${checkInMonth}`, 'i'),
    new RegExp(`${requestedCheckIn}`, 'i'),
  ];
  
  const checkOutPatterns = [
    new RegExp(`${checkOutMonth}[a-z]*\\.?\\s*${checkOutDay}`, 'i'),
    new RegExp(`${checkOutDay}\\s*${checkOutMonth}`, 'i'),
    new RegExp(`${requestedCheckOut}`, 'i'),
  ];

  let checkInFound = false;
  let checkOutFound = false;

  for (const pattern of checkInPatterns) {
    if (pattern.test(content)) {
      checkInFound = true;
      result.detectedCheckIn = requestedCheckIn;
      break;
    }
  }

  for (const pattern of checkOutPatterns) {
    if (pattern.test(content)) {
      checkOutFound = true;
      result.detectedCheckOut = requestedCheckOut;
      break;
    }
  }

  result.datesValidated = checkInFound && checkOutFound;

  // ========================================
  // STEP 5: Extract prices with structural context
  // ========================================
  const foundPrices: Array<{ 
    amount: number; 
    context: string; 
    nightsMatch: boolean; 
    priority: number;
    fromBreakdownTotal: boolean;
  }> = [];
  const seen = new Set<number>();

  // Pattern 1: Total with exact nights match (highest priority, from breakdown)
  const exactNightsPatterns = [
    new RegExp(`(?:total|price)[:\\s]*(?:US\\$|\\$|USD\\s*)([\\d,]+(?:\\.\\d{2})?)\\s*(?:for|\\/)?\\s*${nights}\\s*nights?`, 'gi'),
    new RegExp(`(?:US\\$|\\$|USD\\s*)([\\d,]+(?:\\.\\d{2})?)\\s*(?:for|\\/)?\\s*${nights}\\s*nights?`, 'gi'),
  ];

  for (const pattern of exactNightsPatterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const amountStr = match[1].replace(/,/g, '');
      const amount = parseFloat(amountStr);
      
      if (amount > 50 && !seen.has(amount)) {
        seen.add(amount);
        const start = Math.max(0, match.index - 80);
        const end = Math.min(content.length, match.index + match[0].length + 80);
        const context = content.slice(start, end).replace(/\n/g, ' ').trim();
        
        // Check if this is from a breakdown/total context
        const isFromBreakdown = /(?:total|price\s*breakdown|summary|amount\s*due)/i.test(context);
        
        foundPrices.push({ 
          amount, 
          context, 
          nightsMatch: true, 
          priority: 1,
          fromBreakdownTotal: isFromBreakdown,
        });
      }
    }
  }

  // Pattern 2: Generic "for X nights" (may not match requested nights)
  const genericNightsPattern = /(?:US\$|\$|USD\s*)([\d,]+(?:\.\d{2})?)\s*(?:for|\/)\s*(\d+)\s*nights?/gi;
  let match;
  while ((match = genericNightsPattern.exec(content)) !== null) {
    const amountStr = match[1].replace(/,/g, '');
    const amount = parseFloat(amountStr);
    const matchedNights = parseInt(match[2]);
    
    if (amount > 50 && !seen.has(amount)) {
      seen.add(amount);
      const start = Math.max(0, match.index - 80);
      const end = Math.min(content.length, match.index + match[0].length + 80);
      const context = content.slice(start, end).replace(/\n/g, ' ').trim();
      
      const isFromBreakdown = /(?:total|price\s*breakdown|summary|amount\s*due)/i.test(context);
      
      foundPrices.push({ 
        amount, 
        context, 
        nightsMatch: matchedNights === nights,
        priority: matchedNights === nights ? 1 : 2,
        fromBreakdownTotal: isFromBreakdown,
      });
    }
  }

  // Pattern 3: Total label patterns (explicit total)
  const totalPatterns = [
    /(?:grand\s*)?total[:\s]*(?:US\$|\$|USD\s*)([\d,]+(?:\.\d{2})?)/gi,
    /(?:amount\s*due|you\s*pay)[:\s]*(?:US\$|\$|USD\s*)([\d,]+(?:\.\d{2})?)/gi,
    /(?:US\$|\$|USD\s*)([\d,]+(?:\.\d{2})?)\s*(?:grand\s*)?total/gi,
  ];

  for (const pattern of totalPatterns) {
    while ((match = pattern.exec(content)) !== null) {
      const amountStr = match[1].replace(/,/g, '');
      const amount = parseFloat(amountStr);
      
      if (amount > 50 && !seen.has(amount)) {
        seen.add(amount);
        const start = Math.max(0, match.index - 80);
        const end = Math.min(content.length, match.index + match[0].length + 80);
        const context = content.slice(start, end).replace(/\n/g, ' ').trim();
        
        foundPrices.push({ 
          amount, 
          context, 
          nightsMatch: false, // Can't confirm nights from this pattern alone
          priority: 3,
          fromBreakdownTotal: true, // It's explicitly labeled as total
        });
      }
    }
  }

  // Sort: prioritize exact nights match from breakdown, then by priority
  foundPrices.sort((a, b) => {
    // Prefer breakdown totals with nights match
    if (a.fromBreakdownTotal && a.nightsMatch && !(b.fromBreakdownTotal && b.nightsMatch)) return -1;
    if (b.fromBreakdownTotal && b.nightsMatch && !(a.fromBreakdownTotal && a.nightsMatch)) return 1;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.amount - b.amount;
  });

  result.allPrices = foundPrices.map(p => ({ amount: p.amount, context: p.context }));

  console.log(`[BOOKING] Found ${foundPrices.length} prices: ${foundPrices.map(p => `$${p.amount}${p.nightsMatch ? '*' : ''}${p.fromBreakdownTotal ? '†' : ''}`).join(', ')}`);

  // ========================================
  // STEP 6: Select best price and validate TOTAL_PROVEN
  // ========================================
  if (foundPrices.length > 0) {
    const best = foundPrices[0];
    result.totalFound = true;
    result.totalPrice = best.amount;
    result.currency = 'USD';
    result.totalEvidence = best.context.slice(0, 300);
    result.nightsMatched = best.nightsMatch;
    result.structuralProof.extracted_from_breakdown_total = best.fromBreakdownTotal;

    // ========================================
    // STEP 7: Compute TOTAL_PROVEN
    // ========================================
    const failedChecks: string[] = [];

    if (!result.structuralProof.breakdown_found) {
      failedChecks.push('breakdown_not_found');
    }
    if (!result.structuralProof.total_label_found) {
      failedChecks.push('total_label_not_found');
    }
    if (!result.structuralProof.extracted_from_breakdown_total) {
      failedChecks.push('not_extracted_from_breakdown_total');
    }
    if (!result.datesValidated) {
      failedChecks.push('dates_not_validated');
    }
    if (!result.nightsMatched) {
      failedChecks.push('nights_not_matched');
    }
    if (!result.includesTaxesFees) {
      failedChecks.push('taxes_fees_not_confirmed');
    }

    result.failedChecks = failedChecks;
    result.totalProven = failedChecks.length === 0;

    // Logging per requirements
    console.log(`[BOOKING] total_proven=${result.totalProven}`);
    console.log(`[BOOKING] breakdown_found=${result.structuralProof.breakdown_found} total_label_found=${result.structuralProof.total_label_found} extracted_from_breakdown_total=${result.structuralProof.extracted_from_breakdown_total}`);
    console.log(`[BOOKING] dates_validated=${result.datesValidated} nightsMatched=${result.nightsMatched} includes_taxes_fees=${result.includesTaxesFees}`);
    
    if (!result.totalProven) {
      console.log(`[BOOKING] REJECTED: failed_checks=[${failedChecks.join(', ')}]`);
    } else {
      console.log(`[BOOKING] ACCEPTED: $${best.amount} TOTAL_PROVEN=true`);
    }
  }

  return result;
}

// ============================================================================
// FIRECRAWL EXTRACTION (PRIMARY - from successful Jan 10 run)
// ============================================================================

async function extractWithFirecrawl(url: string): Promise<{
  success: boolean;
  content: string;
  httpStatus: number | null;
  error: string | null;
  durationMs: number;
}> {
  const start = Date.now();
  const result = {
    success: false,
    content: '',
    httpStatus: null as number | null,
    error: null as string | null,
    durationMs: 0,
  };

  try {
    // Try connector key first, then fall back to legacy key
    const apiKey = Deno.env.get('FIRECRAWL_API_KEY_1') || Deno.env.get('FIRECRAWL_API_KEY');
    if (!apiKey) {
      result.error = 'FIRECRAWL_API_KEY not configured';
      result.durationMs = Date.now() - start;
      return result;
    }
    console.log(`[BOOKING] Using Firecrawl key: ${apiKey.startsWith('fc-') ? 'connector (FIRECRAWL_API_KEY_1)' : 'legacy'}`);

    console.log(`[BOOKING] Firecrawl request: ${url}`);

    const response = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url,
        formats: ['markdown'],
        waitFor: 8000,
        timeout: 45000,
        onlyMainContent: false,
        // Use US location like successful run
        location: { country: 'US' },
      }),
    });

    result.httpStatus = response.status;

    if (!response.ok) {
      const errText = await response.text();
      result.error = `Firecrawl HTTP ${response.status}: ${errText.slice(0, 200)}`;
      result.durationMs = Date.now() - start;
      return result;
    }

    const data = await response.json();
    const markdown = data.data?.markdown || data.markdown || '';
    
    console.log(`[BOOKING] Firecrawl returned ${markdown.length} chars`);

    result.content = markdown;
    result.success = markdown.length > 3000;
    result.durationMs = Date.now() - start;

    return result;

  } catch (error) {
    result.error = error instanceof Error ? error.message : 'Unknown error';
    result.durationMs = Date.now() - start;
    return result;
  }
}

// ============================================================================
// ZYTE FALLBACK
// ============================================================================

async function extractWithZyte(url: string): Promise<{
  success: boolean;
  content: string;
  httpStatus: number | null;
  error: string | null;
  durationMs: number;
}> {
  const start = Date.now();
  const result = {
    success: false,
    content: '',
    httpStatus: null as number | null,
    error: null as string | null,
    durationMs: 0,
  };

  try {
    const apiKey = Deno.env.get('ZYTE_API_KEY');
    if (!apiKey) {
      result.error = 'ZYTE_API_KEY not configured';
      result.durationMs = Date.now() - start;
      return result;
    }

    console.log(`[BOOKING] Zyte request: ${url}`);

    const response = await fetch('https://api.zyte.com/v1/extract', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${btoa(apiKey + ':')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url,
        browserHtml: true,
        javascript: true,
        geolocation: 'US',
        actions: [
          { action: 'waitForTimeout', timeout: 8 },
        ],
      }),
    });

    result.httpStatus = response.status;

    if (!response.ok) {
      const errText = await response.text();
      result.error = `Zyte HTTP ${response.status}: ${errText.slice(0, 200)}`;
      result.durationMs = Date.now() - start;
      return result;
    }

    const data = await response.json();
    const html = data.browserHtml || '';
    
    // Convert HTML to text
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    console.log(`[BOOKING] Zyte returned ${text.length} chars`);

    result.content = text;
    result.success = text.length > 5000;
    result.durationMs = Date.now() - start;

    return result;

  } catch (error) {
    result.error = error instanceof Error ? error.message : 'Unknown error';
    result.durationMs = Date.now() - start;
    return result;
  }
}

// ============================================================================
// BROWSERLESS LAST RESORT
// ============================================================================

async function extractWithBrowserless(url: string): Promise<{
  success: boolean;
  content: string;
  httpStatus: number | null;
  error: string | null;
  durationMs: number;
}> {
  const start = Date.now();
  const result = {
    success: false,
    content: '',
    httpStatus: null as number | null,
    error: null as string | null,
    durationMs: 0,
  };

  try {
    const apiKey = Deno.env.get('BROWSERLESS_API_KEY');
    if (!apiKey) {
      result.error = 'BROWSERLESS_API_KEY not configured';
      result.durationMs = Date.now() - start;
      return result;
    }

    console.log(`[BOOKING] Browserless request: ${url}`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    const response = await fetch(`https://chrome.browserless.io/content?token=${apiKey}&stealth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        gotoOptions: { waitUntil: 'networkidle0', timeout: 45000 },
        waitForTimeout: 8000,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    result.httpStatus = response.status;

    if (!response.ok) {
      const errText = await response.text();
      result.error = `Browserless HTTP ${response.status}: ${errText.slice(0, 200)}`;
      result.durationMs = Date.now() - start;
      return result;
    }

    const html = await response.text();
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    console.log(`[BOOKING] Browserless returned ${text.length} chars`);

    result.content = text;
    result.success = text.length > 5000;
    result.durationMs = Date.now() - start;

    return result;

  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    result.error = msg.includes('abort') ? 'Browserless timeout' : `Browserless error: ${msg}`;
    result.durationMs = Date.now() - start;
    return result;
  }
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();
  const providerAttemptTrace: ProviderAttemptTrace[] = [];

  const result: ExtractionResult = {
    success: false,
    status: 'render_failed',
    extractedPrice: null,
    currency: null,
    includesTaxesFees: null,
    evidenceSnippet: null,
    providerUsed: null,
    providerAttemptTrace: [],
    allPricesFound: [],
    nightsMatched: false,
    datesValidated: false,
    totalProven: false,
    structuralProof: null,
    failedChecks: [],
    detectedCheckIn: null,
    detectedCheckOut: null,
    durationMs: 0,
    error: null,
  };

  try {
    const body: ExtractionRequest = await req.json();
    const { extractionId, url, checkIn, checkOut, adults = 2 } = body;

    if (!checkIn || !checkOut) {
      result.status = 'validation_error';
      result.error = 'checkIn and checkOut are required';
      result.durationMs = Date.now() - startTime;
      return new Response(JSON.stringify(result), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const nights = calculateNights(checkIn, checkOut);

    // Get URL from DB or request
    let targetUrl = url;
    let supabase: any = null;

    if (extractionId) {
      const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
      const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
      supabase = createClient(supabaseUrl, supabaseKey);

      const { data: extraction } = await supabase
        .from('price_extractions')
        .select('deep_link')
        .eq('id', extractionId)
        .single();

      if (extraction?.deep_link) {
        targetUrl = extraction.deep_link;
      }
    }

    if (!targetUrl) {
      result.status = 'validation_error';
      result.error = 'No URL provided';
      result.durationMs = Date.now() - startTime;
      return new Response(JSON.stringify(result), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Build URL with dates
    const datedUrl = buildBookingUrl(targetUrl, checkIn, checkOut, adults);
    console.log(`[BOOKING] Target: ${datedUrl}`);
    console.log(`[BOOKING] Dates: ${checkIn} to ${checkOut} (${nights} nights)`);

    let content = '';
    let providerUsed: Provider | null = null;

    // ========================================
    // TRY 1: FIRECRAWL (Primary - worked Jan 10)
    // ========================================
    const firecrawlTrace: ProviderAttemptTrace = {
      provider: 'firecrawl',
      attempted: true,
      startedAt: new Date().toISOString(),
      endedAt: null,
      outcome: 'pending',
      httpStatus: null,
      contentLength: null,
      errorMessage: null,
    };

    const firecrawlResult = await extractWithFirecrawl(datedUrl);
    firecrawlTrace.endedAt = new Date().toISOString();
    firecrawlTrace.httpStatus = firecrawlResult.httpStatus;
    firecrawlTrace.contentLength = firecrawlResult.content.length;

    if (firecrawlResult.success && firecrawlResult.content.length > 3000 && !detectBotBlock(firecrawlResult.content)) {
      firecrawlTrace.outcome = 'success';
      content = firecrawlResult.content;
      providerUsed = 'firecrawl';
      console.log(`[BOOKING] Firecrawl succeeded with ${content.length} chars`);
    } else {
      firecrawlTrace.outcome = firecrawlResult.error || 'insufficient_content';
      firecrawlTrace.errorMessage = firecrawlResult.error;
      console.log(`[BOOKING] Firecrawl failed: ${firecrawlResult.error || 'insufficient content'}`);
    }
    providerAttemptTrace.push(firecrawlTrace);

    // ========================================
    // TRY 2: ZYTE (Fallback)
    // ========================================
    if (!providerUsed) {
      console.log(`[BOOKING] Trying Zyte fallback...`);
      
      const zyteTrace: ProviderAttemptTrace = {
        provider: 'zyte',
        attempted: true,
        startedAt: new Date().toISOString(),
        endedAt: null,
        outcome: 'pending',
        httpStatus: null,
        contentLength: null,
        errorMessage: null,
      };

      const zyteResult = await extractWithZyte(datedUrl);
      zyteTrace.endedAt = new Date().toISOString();
      zyteTrace.httpStatus = zyteResult.httpStatus;
      zyteTrace.contentLength = zyteResult.content.length;

      if (zyteResult.success && zyteResult.content.length > 5000 && !detectBotBlock(zyteResult.content)) {
        zyteTrace.outcome = 'success';
        content = zyteResult.content;
        providerUsed = 'zyte';
        console.log(`[BOOKING] Zyte succeeded with ${content.length} chars`);
      } else {
        zyteTrace.outcome = zyteResult.error || 'insufficient_content';
        zyteTrace.errorMessage = zyteResult.error;
        console.log(`[BOOKING] Zyte failed: ${zyteResult.error || 'insufficient content'}`);
      }
      providerAttemptTrace.push(zyteTrace);
    }

    // ========================================
    // TRY 3: BROWSERLESS (Last resort)
    // ========================================
    if (!providerUsed) {
      console.log(`[BOOKING] Trying Browserless fallback...`);
      
      const browserlessTrace: ProviderAttemptTrace = {
        provider: 'browserless',
        attempted: true,
        startedAt: new Date().toISOString(),
        endedAt: null,
        outcome: 'pending',
        httpStatus: null,
        contentLength: null,
        errorMessage: null,
      };

      const browserlessResult = await extractWithBrowserless(datedUrl);
      browserlessTrace.endedAt = new Date().toISOString();
      browserlessTrace.httpStatus = browserlessResult.httpStatus;
      browserlessTrace.contentLength = browserlessResult.content.length;

      if (browserlessResult.success && browserlessResult.content.length > 5000 && !detectBotBlock(browserlessResult.content)) {
        browserlessTrace.outcome = 'success';
        content = browserlessResult.content;
        providerUsed = 'browserless';
        console.log(`[BOOKING] Browserless succeeded with ${content.length} chars`);
      } else {
        browserlessTrace.outcome = browserlessResult.error || 'insufficient_content';
        browserlessTrace.errorMessage = browserlessResult.error;
        console.log(`[BOOKING] Browserless failed: ${browserlessResult.error || 'insufficient content'}`);
      }
      providerAttemptTrace.push(browserlessTrace);
    }

    result.providerUsed = providerUsed;
    result.providerAttemptTrace = providerAttemptTrace;

    // Check for blocking
    if (content.length > 0 && detectBotBlock(content)) {
      result.status = 'blocked_captcha_or_bot';
      result.error = 'Bot detection triggered';
      result.durationMs = Date.now() - startTime;
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (content.length < 3000) {
      result.status = 'page_not_reached';
      result.error = `Insufficient content from all providers`;
      result.durationMs = Date.now() - startTime;
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Extract prices with VRBO-style strict gate
    const priceResult = extractBookingTotal(content, nights, checkIn, checkOut);
    
    // Populate result fields from price extraction
    result.allPricesFound = priceResult.allPrices.map(p => `$${p.amount}`);
    result.nightsMatched = priceResult.nightsMatched;
    result.datesValidated = priceResult.datesValidated;
    result.totalProven = priceResult.totalProven;
    result.structuralProof = priceResult.structuralProof;
    result.failedChecks = priceResult.failedChecks;
    result.detectedCheckIn = priceResult.detectedCheckIn;
    result.detectedCheckOut = priceResult.detectedCheckOut;
    result.includesTaxesFees = priceResult.includesTaxesFees;

    // ========================================
    // VRBO-STYLE STRICT GATE: Only success_total_stay when TOTAL_PROVEN
    // ========================================
    if (priceResult.totalFound && priceResult.totalPrice) {
      result.extractedPrice = priceResult.totalPrice;
      result.currency = priceResult.currency;
      result.evidenceSnippet = priceResult.totalEvidence;
      
      if (priceResult.totalProven) {
        // ALL checks passed - legitimate comparable total
        result.success = true;
        result.status = 'success_total_stay';
        console.log(`[BOOKING] SUCCESS: $${priceResult.totalPrice} via ${providerUsed} - TOTAL_PROVEN=true`);
      } else {
        // Price found but not proven - downgrade to unverified (maps to not_comparable bucket)
        result.success = false;
        result.status = 'unverified';
        result.error = `Price found but not TOTAL_PROVEN: failed_checks=[${priceResult.failedChecks.join(', ')}]`;
        console.log(`[BOOKING] UNVERIFIED: $${priceResult.totalPrice} - TOTAL_PROVEN=false, failed_checks=[${priceResult.failedChecks.join(', ')}]`);
      }
    } else {
      result.status = 'price_not_found';
      result.error = `No total price found for ${nights} nights`;
    }

    result.durationMs = Date.now() - startTime;

    // Update DB if extractionId provided
    if (extractionId && supabase) {
      const priceType = priceResult.totalProven ? 'TOTAL_STAY' : 'UNKNOWN';
      
      await supabase
        .from('price_extractions')
        .update({
          extraction_status: result.status,
          extracted_price: result.extractedPrice,
          currency: result.currency,
          includes_taxes_fees: result.includesTaxesFees,
          provider_used: result.providerUsed,
          evidence_snippets: result.evidenceSnippet ? [result.evidenceSnippet] : null,
          dates_validated: result.datesValidated,
          detected_checkin: result.detectedCheckIn,
          detected_checkout: result.detectedCheckOut,
          extraction_metadata: {
            providerAttemptTrace: result.providerAttemptTrace,
            allPricesFound: result.allPricesFound,
            nightsMatched: result.nightsMatched,
            datesValidated: result.datesValidated,
            totalProven: result.totalProven,
            structuralProof: result.structuralProof,
            failedChecks: result.failedChecks,
            durationMs: result.durationMs,
          },
          extraction_error: result.error,
          price_type: priceType,
          updated_at: new Date().toISOString(),
        })
        .eq('id', extractionId);
    }

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    result.error = error instanceof Error ? error.message : 'Unknown error';
    result.durationMs = Date.now() - startTime;
    return new Response(JSON.stringify(result), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
