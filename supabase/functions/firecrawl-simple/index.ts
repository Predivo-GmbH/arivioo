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
 * SIMPLE DIAGNOSTIC: Just capture and return raw content for manual inspection
 */
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { url } = await req.json();

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

    console.log(`[SIMPLE] Scraping: ${url}`);

    const response = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${firecrawlApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url,
        formats: ['markdown'],
        onlyMainContent: false, // Get FULL page to see all content
        waitFor: 5000,
      }),
    });

    const data = await response.json();
    
    if (!response.ok) {
      console.error(`[SIMPLE] Firecrawl error: ${response.status}`);
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: `Firecrawl error: ${response.status}`,
          data 
        }),
        { status: response.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    const markdown = data.data?.markdown || data.markdown || '';
    
    // Search for price patterns with context
    const priceLines: string[] = [];
    const lines = markdown.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/\$[\d,]+|\bUSD\s*[\d,]+/i.test(line)) {
        // Get context: previous line, current line, next line
        const context = [
          lines[i-2] || '',
          lines[i-1] || '',
          line,
          lines[i+1] || '',
          lines[i+2] || ''
        ].join(' | ');
        priceLines.push(`Line ${i}: ${context.slice(0, 200)}`);
      }
    }
    
    // Search for total-related text
    const totalLines: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (/total|trip|stay|night|fee|tax/i.test(lines[i]) && lines[i].length > 10) {
        totalLines.push(`Line ${i}: ${lines[i].slice(0, 200)}`);
      }
    }
    
    // Search for room/property related text
    const roomLines: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (/room|property|book|reserve|select/i.test(lines[i]) && lines[i].length > 20) {
        roomLines.push(`Line ${i}: ${lines[i].slice(0, 200)}`);
      }
    }
    
    console.log(`[SIMPLE] Captured ${markdown.length} chars, ${priceLines.length} price lines`);

    return new Response(
      JSON.stringify({ 
        success: true,
        markdownLength: markdown.length,
        priceLines: priceLines.slice(0, 20),
        totalLines: totalLines.slice(0, 10),
        roomLines: roomLines.slice(0, 10),
        markdownStart: markdown.slice(0, 3000),
        markdownEnd: markdown.slice(-2000),
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[SIMPLE] Error:', error);
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
