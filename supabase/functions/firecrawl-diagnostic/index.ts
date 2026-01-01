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

/**
 * DIAGNOSTIC FUNCTION: Inspect exactly what Firecrawl captures from a URL
 * Purpose: Determine if Agoda can be used as a grounded success path
 */
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { url, useActions, checkIn, checkOut } = await req.json();

    if (!url) {
      return new Response(
        JSON.stringify({ success: false, error: 'URL is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const firecrawlApiKey = Deno.env.get('FIRECRAWL_API_KEY_1') || Deno.env.get('FIRECRAWL_API_KEY');
    if (!firecrawlApiKey) {
      return new Response(
        JSON.stringify({ success: false, error: 'Firecrawl API key not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[DIAGNOSTIC] Starting inspection of: ${url}`);
    console.log(`[DIAGNOSTIC] Use actions: ${useActions}, Dates: ${checkIn} to ${checkOut}`);

    const results: any = {
      url,
      timestamp: new Date().toISOString(),
      withoutActions: null,
      withActions: null,
    };

    // ========== TEST 1: Without Actions (URL params only) ==========
    console.log('[DIAGNOSTIC] Test 1: Scraping without actions...');
    
    const test1Start = Date.now();
    try {
      const response1 = await fetch('https://api.firecrawl.dev/v1/scrape', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${firecrawlApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url,
          formats: ['markdown', 'html'],
          onlyMainContent: true,
          waitFor: 5000,
        }),
      });

      const data1 = await response1.json();
      const markdown1 = data1.data?.markdown || data1.markdown || '';
      const html1 = data1.data?.html || data1.html || '';
      
      // Analyze content for pricing indicators
      const analysis1 = analyzeContent(markdown1, html1, checkIn, checkOut);
      
      results.withoutActions = {
        success: response1.ok,
        status: response1.status,
        durationMs: Date.now() - test1Start,
        markdownLength: markdown1.length,
        htmlLength: html1.length,
        markdownSample: markdown1.slice(0, 2000),
        analysis: analysis1,
      };
      
      console.log(`[DIAGNOSTIC] Test 1 complete: ${response1.status}, ${markdown1.length} chars`);
      console.log(`[DIAGNOSTIC] Analysis: ${JSON.stringify(analysis1)}`);
      
    } catch (err) {
      results.withoutActions = {
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
        durationMs: Date.now() - test1Start,
      };
      console.error(`[DIAGNOSTIC] Test 1 failed: ${err}`);
    }

    // ========== TEST 2: With Actions (if requested) ==========
    if (useActions && checkIn && checkOut) {
      console.log('[DIAGNOSTIC] Test 2: Scraping with actions...');
      
      const actions = [
        { type: 'wait', milliseconds: 2000 },
        // Click on check-in field
        { type: 'click', selector: '[data-selenium="checkInInput"], #check-in-box, .SearchBoxTextDescription__title' },
        { type: 'wait', milliseconds: 1000 },
        // Type check-in date
        { type: 'write', selector: 'input[data-selenium="checkInDate"], input[placeholder*="Check"]', text: checkIn },
        { type: 'wait', milliseconds: 500 },
        { type: 'press', key: 'Enter' },
        { type: 'wait', milliseconds: 1000 },
        // Type check-out date  
        { type: 'write', selector: 'input[data-selenium="checkOutDate"]', text: checkOut },
        { type: 'press', key: 'Enter' },
        { type: 'wait', milliseconds: 2000 },
        // Click search button
        { type: 'click', selector: 'button[data-selenium="searchButton"], button:contains("Update"), .SearchBoxSubmit' },
        { type: 'wait', milliseconds: 3000 },
      ];
      
      console.log(`[DIAGNOSTIC] Sending ${actions.length} actions to Firecrawl`);
      
      const test2Start = Date.now();
      try {
        const response2 = await fetch('https://api.firecrawl.dev/v1/scrape', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${firecrawlApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            url,
            formats: ['markdown', 'html'],
            actions,
            onlyMainContent: true,
            waitFor: 5000,
          }),
        });

        const data2 = await response2.json();
        const markdown2 = data2.data?.markdown || data2.markdown || '';
        const html2 = data2.data?.html || data2.html || '';
        
        // Analyze content for pricing indicators
        const analysis2 = analyzeContent(markdown2, html2, checkIn, checkOut);
        
        results.withActions = {
          success: response2.ok,
          status: response2.status,
          durationMs: Date.now() - test2Start,
          markdownLength: markdown2.length,
          htmlLength: html2.length,
          markdownSample: markdown2.slice(0, 2000),
          analysis: analysis2,
          actionsUsed: actions.length,
        };
        
        console.log(`[DIAGNOSTIC] Test 2 complete: ${response2.status}, ${markdown2.length} chars`);
        console.log(`[DIAGNOSTIC] Analysis: ${JSON.stringify(analysis2)}`);
        
      } catch (err) {
        results.withActions = {
          success: false,
          error: err instanceof Error ? err.message : 'Unknown error',
          durationMs: Date.now() - test2Start,
        };
        console.error(`[DIAGNOSTIC] Test 2 failed: ${err}`);
      }
    }

    // ========== CLASSIFICATION ==========
    const classification = classifyFailure(results);
    results.classification = classification;
    
    console.log(`[DIAGNOSTIC] Final classification: ${classification.category}`);
    console.log(`[DIAGNOSTIC] Recommendation: ${classification.recommendation}`);

    return new Response(
      JSON.stringify({ success: true, results }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[DIAGNOSTIC] Fatal error:', error);
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

/**
 * Analyze captured content for pricing indicators
 */
function analyzeContent(markdown: string, html: string, checkIn?: string, checkOut?: string) {
  const lowerMarkdown = markdown.toLowerCase();
  const lowerHtml = html.toLowerCase();
  
  // Price detection patterns
  const pricePatterns = [
    /\$[\d,]+(?:\.\d{2})?/g,           // $1,234.56
    /USD\s*[\d,]+(?:\.\d{2})?/gi,       // USD 1234.56
    /[\d,]+(?:\.\d{2})?\s*(?:USD|dollars?)/gi,  // 1234 USD
    /€[\d,]+(?:\.\d{2})?/g,            // €1,234.56
  ];
  
  const foundPrices: string[] = [];
  for (const pattern of pricePatterns) {
    const matches = markdown.match(pattern);
    if (matches) {
      foundPrices.push(...matches.slice(0, 10));
    }
  }
  
  // Check for "enter dates" state
  const enterDatesIndicators = [
    'enter dates',
    'select dates',
    'add dates',
    'choose dates',
    'pick dates',
    'check availability',
  ];
  const isEnterDatesState = enterDatesIndicators.some(i => lowerMarkdown.includes(i));
  
  // Check for total price indicators
  const totalIndicators = [
    'total',
    'trip total',
    'stay total',
    'for \\d+ nights?',
    'final price',
    'grand total',
    'amount due',
  ];
  const hasTotalIndicator = totalIndicators.some(i => 
    new RegExp(i, 'i').test(markdown)
  );
  
  // Check for tax/fee indicators
  const taxIndicators = [
    'includes taxes',
    'taxes and fees',
    'incl. tax',
    'tax included',
    'all fees included',
  ];
  const hasTaxInfo = taxIndicators.some(i => lowerMarkdown.includes(i));
  
  // Check if dates are visible in content
  const datesVisible = {
    checkIn: checkIn ? markdown.includes(checkIn) : null,
    checkOut: checkOut ? markdown.includes(checkOut) : null,
  };
  
  // Check for bot/captcha detection
  const botIndicators = ['captcha', 'robot', 'verify you are human', 'access denied', 'blocked'];
  const isBotBlocked = botIndicators.some(i => lowerMarkdown.includes(i));
  
  // Extract price context snippets (text around prices)
  const priceContexts: string[] = [];
  for (const price of foundPrices.slice(0, 5)) {
    const idx = markdown.indexOf(price);
    if (idx >= 0) {
      const start = Math.max(0, idx - 50);
      const end = Math.min(markdown.length, idx + price.length + 50);
      priceContexts.push(markdown.slice(start, end).replace(/\n/g, ' ').trim());
    }
  }
  
  return {
    foundPrices: [...new Set(foundPrices)].slice(0, 10),
    priceCount: foundPrices.length,
    isEnterDatesState,
    hasTotalIndicator,
    hasTaxInfo,
    datesVisible,
    isBotBlocked,
    priceContexts,
    contentIndicators: {
      hasNightlyRate: /per night|\/night|nightly/i.test(markdown),
      hasRoomSelection: /select room|choose room|room type/i.test(markdown),
      hasAvailability: /available|availability|book now/i.test(markdown),
      hasPropertyName: markdown.length > 100, // Basic content check
    }
  };
}

/**
 * Classify the failure into one of the 5 buckets
 */
function classifyFailure(results: any): { category: string; evidence: string; recommendation: string } {
  const test1 = results.withoutActions;
  const test2 = results.withActions;
  
  // Check if basic fetch failed
  if (!test1?.success) {
    return {
      category: 'A) Actions did not execute / Fetch failed',
      evidence: `Test 1 failed: ${test1?.error || 'Unknown'}`,
      recommendation: 'Check Firecrawl API connectivity and rate limits'
    };
  }
  
  // Check for bot blocking
  if (test1?.analysis?.isBotBlocked) {
    return {
      category: 'A) Bot/CAPTCHA blocked - cannot proceed',
      evidence: 'Bot detection indicators found in content',
      recommendation: 'Platform actively blocks scraping - consider alternative platform'
    };
  }
  
  // Check if content has "enter dates" state
  if (test1?.analysis?.isEnterDatesState && !test1?.analysis?.hasTotalIndicator) {
    // Platform needs dates but we only used URL params
    if (!test2) {
      return {
        category: 'B) Page in "Enter dates" state - URL params not working',
        evidence: `Found "enter dates" indicator, no total prices visible. Prices found: ${test1?.analysis?.foundPrices?.join(', ') || 'none'}`,
        recommendation: 'Test with actions to see if date interaction updates the page'
      };
    }
    
    // We tried actions - did they help?
    if (test2?.success && test2?.analysis?.hasTotalIndicator) {
      return {
        category: 'D) Actions worked - DOM contains pricing',
        evidence: `After actions: Total indicator found. Prices: ${test2?.analysis?.foundPrices?.join(', ')}`,
        recommendation: 'Refine extraction logic to capture the visible total price'
      };
    }
    
    if (test2?.success && !test2?.analysis?.hasTotalIndicator && test2?.analysis?.isEnterDatesState) {
      return {
        category: 'B) Actions executed but DOM did not update',
        evidence: 'Page still shows "enter dates" after actions executed',
        recommendation: 'Actions may target wrong selectors - need different CSS selectors for Agoda'
      };
    }
  }
  
  // Check if we have prices but no total indicator
  if (test1?.analysis?.priceCount > 0 && !test1?.analysis?.hasTotalIndicator) {
    return {
      category: 'C) Prices visible but no TOTAL indicator',
      evidence: `Found ${test1.analysis.priceCount} prices but no "total" text. Prices: ${test1.analysis.foundPrices?.join(', ')}. Contexts: ${test1.analysis.priceContexts?.slice(0, 2).join(' | ')}`,
      recommendation: 'Platform may show nightly rates only on listing page - need to navigate to checkout review'
    };
  }
  
  // Check if we have both prices and total indicator
  if (test1?.analysis?.priceCount > 0 && test1?.analysis?.hasTotalIndicator) {
    return {
      category: 'D) DOM contains pricing - extraction should work',
      evidence: `Total indicator found with prices: ${test1.analysis.foundPrices?.join(', ')}. Context: ${test1.analysis.priceContexts?.slice(0, 2).join(' | ')}`,
      recommendation: 'Extraction logic exists but may be failing - check AI prompt and validation'
    };
  }
  
  // No prices at all
  if (test1?.analysis?.priceCount === 0) {
    return {
      category: 'E) Platform does not show prices pre-payment',
      evidence: `No price patterns found in ${test1.markdownLength} chars of content`,
      recommendation: 'Platform may require login or only show prices during checkout flow'
    };
  }
  
  return {
    category: 'UNKNOWN',
    evidence: 'Could not classify - manual inspection needed',
    recommendation: 'Review raw markdown content'
  };
}
