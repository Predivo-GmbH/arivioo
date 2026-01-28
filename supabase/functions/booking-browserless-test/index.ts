import { gatedBrowserlessFetch, isFetchRateLimited } from '../_shared/browserlessGate.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * BOOKING.COM BROWSERLESS EXTRACTION TEST
 * 
 * Direct Browserless test to see if we can bypass Booking.com's bot detection
 * and extract prices with dates applied via URL parameters.
 */

interface TestResult {
  success: boolean;
  url: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  provider: 'browserless';
  
  // Content analysis
  contentLength: number;
  hasVerifyingPage: boolean;
  hasLoginPage: boolean;
  hasBotBlock: boolean;
  hasPriceContent: boolean;
  
  // Price extraction
  extractedPrice: number | null;
  currency: string | null;
  priceEvidence: string | null;
  allPricesFound: string[];
  
  // Error
  error: string | null;
  durationMs: number;
}

function extractBookingPrices(content: string, nights: number): {
  allPrices: Array<{ amount: number; context: string }>;
  lowestPrice: number | null;
  evidence: string | null;
} {
  const patterns = [
    // "US$XXX for 3 nights" pattern
    new RegExp(`(?:US\\$|\\$|USD\\s*)([\\d,]+(?:\\.\\d{2})?)\\s*(?:for|\\/)\\s*${nights}\\s*nights?`, 'gi'),
    // "XXX USD for 3 nights" pattern
    new RegExp(`([\\d,]+(?:\\.\\d{2})?)\\s*(?:US\\$|USD|\\$)\\s*(?:for|\\/)\\s*${nights}\\s*nights?`, 'gi'),
    // Price total pattern
    new RegExp(`(?:total|price)[:\\s]*(?:US\\$|\\$|USD\\s*)([\\d,]+(?:\\.\\d{2})?)`, 'gi'),
  ];
  
  const prices: Array<{ amount: number; context: string }> = [];
  const seen = new Set<number>();
  
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const amountStr = match[1].replace(/,/g, '');
      const amount = parseFloat(amountStr);
      
      if (amount > 0 && !seen.has(amount)) {
        seen.add(amount);
        const start = Math.max(0, match.index - 30);
        const end = Math.min(content.length, match.index + match[0].length + 30);
        const context = content.slice(start, end).replace(/\n/g, ' ').trim();
        prices.push({ amount, context });
      }
    }
  }
  
  prices.sort((a, b) => a.amount - b.amount);
  
  return {
    allPrices: prices.slice(0, 10),
    lowestPrice: prices.length > 0 ? prices[0].amount : null,
    evidence: prices.length > 0 ? prices[0].context : null,
  };
}

async function fetchWithBrowserless(url: string): Promise<{
  success: boolean;
  content: string;
  error: string | null;
}> {
  const browserlessKey = Deno.env.get('BROWSERLESS_API_KEY');
  
  if (!browserlessKey) {
    return { success: false, content: '', error: 'BROWSERLESS_API_KEY not configured' };
  }
  
  console.log('[BOOKING-TEST] Fetching with Browserless via gate (stealth mode):', url);
  
  const result = await gatedBrowserlessFetch(
    `https://chrome.browserless.io/content?token=${browserlessKey}&stealth`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        gotoOptions: { waitUntil: 'networkidle0', timeout: 60000 },
        waitForSelector: { selector: 'body', timeout: 20000 },
        waitForTimeout: 5000,
      }),
      timeout: 90000,
    },
    { platform: 'booking-test', operation: 'fetchWithBrowserless' }
  );
  
  if (isFetchRateLimited(result)) {
    return { success: false, content: '', error: 'Rate limited (HTTP 429)' };
  }
  
  if (!result.success) {
    return { success: false, content: '', error: result.error || `Browserless HTTP ${result.status}` };
  }
  
  const html = result.body;
  const text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  
  console.log(`[BOOKING-TEST] Browserless returned ${text.length} chars`);
  return { success: true, content: text, error: null };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  
  const startTime = Date.now();
  
  try {
    const body = await req.json();
    const { url, checkIn, checkOut } = body;
    
    if (!url || !checkIn || !checkOut) {
      return new Response(
        JSON.stringify({ error: 'Missing url, checkIn, or checkOut' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    // Calculate nights
    const checkInDate = new Date(checkIn);
    const checkOutDate = new Date(checkOut);
    const nights = Math.round((checkOutDate.getTime() - checkInDate.getTime()) / (1000 * 60 * 60 * 24));
    
    // Build URL with dates
    const urlObj = new URL(url);
    urlObj.searchParams.set('checkin', checkIn);
    urlObj.searchParams.set('checkout', checkOut);
    urlObj.searchParams.set('group_adults', '2');
    urlObj.searchParams.set('no_rooms', '1');
    urlObj.searchParams.set('selected_currency', 'USD');
    
    const targetUrl = urlObj.toString();
    console.log(`[BOOKING-TEST] Target URL: ${targetUrl}`);
    console.log(`[BOOKING-TEST] Dates: ${checkIn} to ${checkOut} (${nights} nights)`);
    
    // Fetch with Browserless
    const fetchResult = await fetchWithBrowserless(targetUrl);
    
    const result: TestResult = {
      success: false,
      url: targetUrl,
      checkIn,
      checkOut,
      nights,
      provider: 'browserless',
      contentLength: fetchResult.content.length,
      hasVerifyingPage: false,
      hasLoginPage: false,
      hasBotBlock: false,
      hasPriceContent: false,
      extractedPrice: null,
      currency: null,
      priceEvidence: null,
      allPricesFound: [],
      error: fetchResult.error,
      durationMs: 0,
    };
    
    if (!fetchResult.success) {
      result.durationMs = Date.now() - startTime;
      return new Response(
        JSON.stringify(result),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    const content = fetchResult.content;
    const lowerContent = content.toLowerCase();
    
    // Check for bot detection signals
    result.hasVerifyingPage = lowerContent.includes('verifying') && lowerContent.includes('booking.com');
    result.hasLoginPage = lowerContent.includes('signing in') || lowerContent.includes('sign in to');
    result.hasBotBlock = /captcha|unusual\s*traffic|access\s*denied|please\s*verify/i.test(content);
    
    if (result.hasVerifyingPage || result.hasLoginPage || result.hasBotBlock) {
      result.error = result.hasVerifyingPage 
        ? 'Booking.com verification page detected'
        : result.hasLoginPage 
          ? 'Login redirect detected'
          : 'Bot block detected';
      result.durationMs = Date.now() - startTime;
      return new Response(
        JSON.stringify(result),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    // Check for price content
    result.hasPriceContent = /\$[\d,]+|US\$[\d,]+|for\s+\d+\s+nights?/i.test(content);
    
    // Extract prices
    const priceExtraction = extractBookingPrices(content, nights);
    result.allPricesFound = priceExtraction.allPrices.map(p => `$${p.amount}`);
    result.extractedPrice = priceExtraction.lowestPrice;
    result.currency = priceExtraction.lowestPrice ? 'USD' : null;
    result.priceEvidence = priceExtraction.evidence;
    
    if (result.extractedPrice) {
      result.success = true;
    } else {
      result.error = result.hasPriceContent 
        ? `Price patterns found but no ${nights}-night total extracted`
        : 'No price content found in page';
    }
    
    result.durationMs = Date.now() - startTime;
    
    return new Response(
      JSON.stringify(result),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
    
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: msg,
        durationMs: Date.now() - startTime 
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
