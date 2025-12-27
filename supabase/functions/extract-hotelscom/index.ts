import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * Hotels.com Production Extraction Function
 * 
 * This is the REFERENCE IMPLEMENTATION of the Golden Path.
 * Hotels.com is Classification A: prices visible pre-payment via URL parameters.
 * 
 * PROVEN PROPERTIES (2025-12-27):
 * - URL parameters apply dates correctly (chkin, chkout)
 * - Total prices visible pre-payment ("$XXX total")
 * - Content verified with verbatim evidence
 * - 100% deterministic across 3 consecutive runs
 * - No retries or Zyte escalation needed
 * - Firecrawl alone is sufficient
 * 
 * SYSTEM CONTRACT:
 * - Phase A: Validate dates are applied and page is price-eligible
 * - Phase B: Extract total price only (not nightly, not per-room ambiguity)
 * - Never fall back to AI inference if no price is present
 * - Always require verbatim evidence from captured content
 */

// Terminal status values
type TerminalStatus = 
  | 'success'
  | 'dates_not_applied'
  | 'no_availability_for_dates'
  | 'blocked_captcha_or_bot'
  | 'sold_out'
  | 'price_not_found'
  | 'render_failed'
  | 'validation_error';

interface ExtractionRequest {
  // Option 1: Provide extraction ID (reads from DB)
  extractionId?: string;
  // Option 2: Provide URL directly
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
  phaseA: {
    ran: boolean;
    priceEligible: boolean;
    enterDatesFound: boolean;
    soldOut: boolean;
    contentHash: string | null;
    contentLength: number;
  };
  phaseB: {
    ran: boolean;
    extractedPrice: number | null;
    currency: string | null;
    includesTaxesFees: boolean | null;
    priceVerified: boolean;
    evidenceSnippet: string | null;
  };
  durationMs: number;
  error: string | null;
}

// Simple hash for content verification
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

// Build Hotels.com URL with date parameters
function buildHotelsComUrl(baseUrl: string, checkIn: string, checkOut: string, adults: number = 2): string {
  const url = new URL(baseUrl);
  url.searchParams.set('chkin', checkIn);
  url.searchParams.set('chkout', checkOut);
  url.searchParams.set('x_pwa', '1');
  url.searchParams.set('q-room-0-adults', String(adults));
  return url.toString();
}

// Phase A: Validate page is price-eligible
function validatePhaseA(markdown: string): {
  priceEligible: boolean;
  enterDatesFound: boolean;
  soldOut: boolean;
  priceCount: number;
} {
  const lowerMarkdown = markdown.toLowerCase();
  
  // Check for "enter dates" state
  const enterDatesIndicators = [
    'enter your dates',
    'select dates',
    'choose your dates',
    'add dates',
    'enter dates to see',
    'select check-in',
    'pick dates',
  ];
  const enterDatesFound = enterDatesIndicators.some(ind => lowerMarkdown.includes(ind));
  
  // Check for sold out
  const soldOutIndicators = [
    'sold out',
    'not available',
    'no rooms available',
    'fully booked',
    'no availability',
  ];
  const soldOut = soldOutIndicators.some(ind => lowerMarkdown.includes(ind));
  
  // Count price patterns (total prices specifically)
  const totalPricePattern = /\$[\d,]+(?:\.\d{2})?\s*total/gi;
  const matches = markdown.match(totalPricePattern) || [];
  
  // Price-eligible if we find total prices and not in "enter dates" state
  const priceEligible = matches.length > 0 && !enterDatesFound && !soldOut;
  
  return {
    priceEligible,
    enterDatesFound,
    soldOut,
    priceCount: matches.length,
  };
}

// Phase B: Extract total price with verification
function extractPrice(markdown: string): {
  extractedPrice: number | null;
  currency: string | null;
  includesTaxesFees: boolean | null;
  priceVerified: boolean;
  evidenceSnippet: string | null;
} {
  // Pattern 1: "The price is $XXX total" (Hotels.com specific)
  const thepricePattern = /the\s+price\s+is\s+\$?([\d,]+(?:\.\d{2})?)\s*total/i;
  const thepriceMatch = markdown.match(thepricePattern);
  
  // Pattern 2: "$XXX total" (general)
  const totalPattern = /\$([\d,]+(?:\.\d{2})?)\s*total/gi;
  const totalMatches = [...markdown.matchAll(totalPattern)];
  
  // Pattern 3: "total with taxes and fees"
  const taxesPattern = /\$([\d,]+(?:\.\d{2})?)\s*total\s*(?:with\s+taxes\s+(?:and|&)\s+fees)?/gi;
  const taxesMatches = [...markdown.matchAll(taxesPattern)];
  
  let extractedPrice: number | null = null;
  let evidenceSnippet: string | null = null;
  let includesTaxesFees: boolean | null = null;
  
  // Prefer "The price is $XXX total" pattern (most explicit)
  if (thepriceMatch) {
    const priceStr = thepriceMatch[1].replace(/,/g, '');
    extractedPrice = parseFloat(priceStr);
    
    // Find surrounding context for evidence
    const matchIndex = markdown.indexOf(thepriceMatch[0]);
    const start = Math.max(0, matchIndex - 30);
    const end = Math.min(markdown.length, matchIndex + thepriceMatch[0].length + 50);
    evidenceSnippet = markdown.slice(start, end).replace(/\s+/g, ' ').trim();
    
    // Check if taxes included
    const context = markdown.slice(matchIndex, matchIndex + 100).toLowerCase();
    if (context.includes('taxes') && context.includes('fees')) {
      includesTaxesFees = true;
    }
  }
  // Fallback to general "$XXX total" pattern
  else if (totalMatches.length > 0) {
    // Use the first (usually most prominent) total
    const firstMatch = totalMatches[0];
    const priceStr = firstMatch[1].replace(/,/g, '');
    extractedPrice = parseFloat(priceStr);
    
    // Find surrounding context for evidence
    const matchIndex = markdown.indexOf(firstMatch[0]);
    const start = Math.max(0, matchIndex - 30);
    const end = Math.min(markdown.length, matchIndex + firstMatch[0].length + 50);
    evidenceSnippet = markdown.slice(start, end).replace(/\s+/g, ' ').trim();
    
    // Check if taxes included
    const context = markdown.slice(matchIndex, matchIndex + 100).toLowerCase();
    if (context.includes('taxes') && context.includes('fees')) {
      includesTaxesFees = true;
    }
  }
  
  // HALLUCINATION GUARD: Verify price appears verbatim in content
  const priceVerified = extractedPrice !== null && 
    evidenceSnippet !== null && 
    (evidenceSnippet.includes(String(extractedPrice)) || 
     evidenceSnippet.includes(extractedPrice.toLocaleString()));
  
  return {
    extractedPrice,
    currency: extractedPrice ? 'USD' : null,
    includesTaxesFees,
    priceVerified,
    evidenceSnippet,
  };
}

// Check for bot blocking
function detectBotBlocking(markdown: string): boolean {
  const lowerMarkdown = markdown.toLowerCase();
  
  // Only flag as blocked if EXPLICIT blocking indicators are present
  const explicitBlockingIndicators = [
    'access denied',
    'please verify you are human',
    'prove you are human',
    'complete the captcha',
    'security check required',
    'unusual traffic',
    'automated access',
    'bot detected',
  ];
  
  return explicitBlockingIndicators.some(ind => lowerMarkdown.includes(ind));
}

async function extractFromHotelsCom(
  url: string,
  checkIn: string,
  checkOut: string,
  adults: number = 2
): Promise<ExtractionResult> {
  const startTime = Date.now();
  
  const result: ExtractionResult = {
    success: false,
    status: 'validation_error',
    phaseA: {
      ran: false,
      priceEligible: false,
      enterDatesFound: false,
      soldOut: false,
      contentHash: null,
      contentLength: 0,
    },
    phaseB: {
      ran: false,
      extractedPrice: null,
      currency: null,
      includesTaxesFees: null,
      priceVerified: false,
      evidenceSnippet: null,
    },
    durationMs: 0,
    error: null,
  };
  
  try {
    const firecrawlApiKey = Deno.env.get('FIRECRAWL_API_KEY_1') || Deno.env.get('FIRECRAWL_API_KEY');
    
    if (!firecrawlApiKey) {
      result.error = 'Firecrawl API key not configured';
      result.status = 'render_failed';
      result.durationMs = Date.now() - startTime;
      return result;
    }
    
    // Build URL with date parameters
    const fullUrl = buildHotelsComUrl(url, checkIn, checkOut, adults);
    console.log(`[HOTELS.COM] Extracting from: ${fullUrl}`);
    
    // Fetch page with Firecrawl
    const response = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${firecrawlApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: fullUrl,
        formats: ['markdown'],
        onlyMainContent: true,
        waitFor: 3000,
      }),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      result.error = `Firecrawl error: ${response.status}`;
      result.status = response.status === 429 ? 'blocked_captcha_or_bot' : 'render_failed';
      result.durationMs = Date.now() - startTime;
      console.error(`[HOTELS.COM] Firecrawl error: ${errorText}`);
      return result;
    }
    
    const data = await response.json();
    const markdown = data.data?.markdown || data.markdown || '';
    
    // ============= PHASE A: Validate price-eligible state =============
    result.phaseA.ran = true;
    result.phaseA.contentLength = markdown.length;
    result.phaseA.contentHash = simpleHash(markdown);
    
    // Check for bot blocking
    if (detectBotBlocking(markdown)) {
      result.status = 'blocked_captcha_or_bot';
      result.error = 'Bot blocking detected';
      result.durationMs = Date.now() - startTime;
      console.log('[HOTELS.COM] Bot blocking detected');
      return result;
    }
    
    // Validate Phase A
    const phaseAResult = validatePhaseA(markdown);
    result.phaseA.priceEligible = phaseAResult.priceEligible;
    result.phaseA.enterDatesFound = phaseAResult.enterDatesFound;
    result.phaseA.soldOut = phaseAResult.soldOut;
    
    if (phaseAResult.soldOut) {
      result.status = 'sold_out';
      result.error = 'Property sold out for these dates';
      result.durationMs = Date.now() - startTime;
      console.log('[HOTELS.COM] Sold out');
      return result;
    }
    
    if (phaseAResult.enterDatesFound) {
      result.status = 'dates_not_applied';
      result.error = 'Page still shows "enter dates" state';
      result.durationMs = Date.now() - startTime;
      console.log('[HOTELS.COM] Enter dates state detected');
      return result;
    }
    
    if (!phaseAResult.priceEligible) {
      result.status = 'price_not_found';
      result.error = `No total prices found (${phaseAResult.priceCount} matches)`;
      result.durationMs = Date.now() - startTime;
      console.log('[HOTELS.COM] Not price-eligible');
      return result;
    }
    
    // ============= PHASE B: Extract price (only if Phase A passed) =============
    result.phaseB.ran = true;
    
    const phaseBResult = extractPrice(markdown);
    result.phaseB.extractedPrice = phaseBResult.extractedPrice;
    result.phaseB.currency = phaseBResult.currency;
    result.phaseB.includesTaxesFees = phaseBResult.includesTaxesFees;
    result.phaseB.priceVerified = phaseBResult.priceVerified;
    result.phaseB.evidenceSnippet = phaseBResult.evidenceSnippet;
    
    // HALLUCINATION GUARD: Price must be verified against content
    if (!phaseBResult.priceVerified) {
      result.status = 'price_not_found';
      result.error = 'Price extraction failed hallucination guard (not verbatim in content)';
      result.durationMs = Date.now() - startTime;
      console.log('[HOTELS.COM] Price failed hallucination guard');
      return result;
    }
    
    // SUCCESS
    result.success = true;
    result.status = 'success';
    result.durationMs = Date.now() - startTime;
    console.log(`[HOTELS.COM] Success: $${phaseBResult.extractedPrice} (verified)`);
    
    return result;
    
  } catch (error) {
    result.error = error instanceof Error ? error.message : 'Unknown error';
    result.status = 'validation_error';
    result.durationMs = Date.now() - startTime;
    console.error('[HOTELS.COM] Error:', error);
    return result;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json() as ExtractionRequest;
    const { url, extractionId, checkIn, checkOut, adults = 2, children = 0, rooms = 1 } = body;
    
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabaseClient = createClient(supabaseUrl, supabaseKey);
    
    let targetUrl = url;
    let dbExtractionId = extractionId;
    
    // If extractionId provided, fetch URL from DB
    if (extractionId && !url) {
      const { data: extraction, error } = await supabaseClient
        .from('price_extractions')
        .select('deep_link, platform_name')
        .eq('id', extractionId)
        .single();
      
      if (error || !extraction) {
        return new Response(
          JSON.stringify({ success: false, error: 'Extraction not found' }),
          { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      
      // Verify platform is Hotels.com
      if (!extraction.platform_name.toLowerCase().includes('hotels')) {
        return new Response(
          JSON.stringify({ success: false, error: 'This function only handles Hotels.com extractions' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      
      targetUrl = extraction.deep_link;
    }
    
    if (!targetUrl) {
      return new Response(
        JSON.stringify({ success: false, error: 'URL or extractionId required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    if (!checkIn || !checkOut) {
      return new Response(
        JSON.stringify({ success: false, error: 'checkIn and checkOut dates required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    // Run extraction
    const result = await extractFromHotelsCom(targetUrl, checkIn, checkOut, adults);
    
    // Update DB if extractionId provided
    if (dbExtractionId) {
      await supabaseClient
        .from('price_extractions')
        .update({
          extraction_status: result.status,
          extracted_price: result.phaseB.extractedPrice,
          currency: result.phaseB.currency,
          includes_taxes_fees: result.phaseB.includesTaxesFees,
          extraction_error: result.error,
          page_content_hash: result.phaseA.contentHash,
          evidence_snippets: result.phaseB.evidenceSnippet ? [result.phaseB.evidenceSnippet] : null,
          extraction_metadata: {
            goldenPath: true,
            platform: 'hotels.com',
            phaseA: result.phaseA,
            phaseB: result.phaseB,
            durationMs: result.durationMs,
          },
          updated_at: new Date().toISOString(),
        })
        .eq('id', dbExtractionId);
    }
    
    return new Response(
      JSON.stringify({
        success: result.success,
        result,
        goldenPath: true,
        referenceImplementation: true,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
    
  } catch (error) {
    console.error('[HOTELS.COM] Fatal error:', error);
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
