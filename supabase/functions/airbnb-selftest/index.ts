import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function safeSnippet(s: string, max = 300): string {
  return (s || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeAmount(raw: string): number | null {
  const s = (raw || '').trim();
  if (!s) return null;
  const cleaned = s.replace(/[^0-9.,]/g, '');
  if (!cleaned) return null;
  const n = Number.parseFloat(cleaned.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Global guardrail patterns to reject for TOTAL extraction
const REJECT_PATTERNS = [
  /for\s+\d+\s+nights?/i,
  /\d+\s+nights?\s*[×x]/i,
  /per\s+night/i,
  /\bpet\s*(policy|fee|deposit)?/i,
  /\bpets?\b/i,
  /\btransaction\s+(charge|fee)/i,
  /\bdeposit\b/i,
  /\bcleaning\s+fee\b/i,
  /\bservice\s+fee\b/i,
  /\bdamage\b/i,
  /\bsecurity\b/i,
];

// Patterns to reject based on JSON path (key names in the path)
const REJECT_PATH_PATTERNS = [
  /pet/i,
  /deposit/i,
  /damage/i,
  /security/i,
  /fee(?!s?\b)/i, // "fee" but not at end of word (avoids "fees" in totals)
  /cleaning/i,
  /service/i,
];

function isRejectedContext(context: string): boolean {
  return REJECT_PATTERNS.some(p => p.test(context));
}

function isRejectedPath(path: string): boolean {
  return REJECT_PATH_PATTERNS.some(p => p.test(path));
}

// Extract subtotal (nights only) from HTML - this is NOT the final total
function extractSubtotal(html: string): { amount: number; currency: string; nights: number | null; context: string } | null {
  // Pattern: $X,XXX for N nights or similar
  const patterns = [
    /(\$|€|£)([\d,.]+)\s+for\s+(\d+)\s+nights?/i,
    /(\$|€|£)([\d,.]+)\s*[×x]\s*(\d+)\s+nights?/i,
    /(\d+)\s+nights?\s*[×x]\s*(\$|€|£)([\d,.]+)/i,
  ];
  
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      let amount: number | null = null;
      let currency = 'USD';
      let nights: number | null = null;
      
      if (pattern === patterns[0] || pattern === patterns[1]) {
        currency = match[1] === '$' ? 'USD' : match[1] === '€' ? 'EUR' : 'GBP';
        amount = normalizeAmount(match[2]);
        nights = parseInt(match[3], 10);
      } else {
        nights = parseInt(match[1], 10);
        currency = match[2] === '$' ? 'USD' : match[2] === '€' ? 'EUR' : 'GBP';
        amount = normalizeAmount(match[3]);
      }
      
      if (amount && amount > 50) {
        const idx = html.indexOf(match[0]);
        const context = html.slice(Math.max(0, idx - 50), idx + match[0].length + 50);
        return { amount, currency, nights, context: safeSnippet(context, 200) };
      }
    }
  }
  return null;
}

// Extract total prices from embedded JSON
function extractJsonPricing(html: string): Array<{ amount: number; currency: string; jsonPath: string; jsonExcerpt: string }> {
  const results: Array<any> = [];
  try {
    const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = scriptRegex.exec(html)) !== null) {
      const content = match[1];
      if (!content.includes('"total"') && !content.includes('"price"')) continue;
      try {
        const json = JSON.parse(content);
        findTotalsInJson(json, 'script', results);
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return results;
}

function findTotalsInJson(obj: any, path: string, results: any[], depth = 0): void {
  if (depth > 10 || !obj || typeof obj !== 'object') return;
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    const newPath = `${path}.${key}`;
    const keyLower = key.toLowerCase();
    
    // Skip if path contains rejected keywords (pet, deposit, etc.)
    if (isRejectedPath(newPath)) continue;
    
    if (keyLower.includes('total') && !keyLower.includes('subtotal') && typeof val === 'number' && val > 50 && val < 500000) {
      const excerpt = JSON.stringify(obj).slice(0, 200);
      // Double-check excerpt doesn't contain pet/deposit references
      if (!isRejectedContext(excerpt) && !isRejectedPath(excerpt)) {
        results.push({ amount: val, currency: obj.currency || 'USD', jsonPath: newPath, jsonExcerpt: excerpt });
      }
    }
    if (typeof val === 'object') findTotalsInJson(val, newPath, results, depth + 1);
  }
}

// DOM-based extraction with strict Total label
function extractDomTotal(html: string): { amount: number; currency: string; context: string } | null {
  const pattern = /Total\s*(USD|EUR|GBP|\(USD\))?\s*[\s:]*(\$|€|£)([\d,.]+)/i;
  const match = html.match(pattern);
  if (!match) return null;
  const amount = normalizeAmount(match[3]);
  if (!amount || amount < 50) return null;
  const idx = html.indexOf(match[0]);
  const context = html.slice(Math.max(0, idx - 100), idx + match[0].length + 100);
  if (isRejectedContext(context)) return null;
  return { amount, currency: match[2] === '$' ? 'USD' : match[2] === '€' ? 'EUR' : 'GBP', context: safeSnippet(context, 200) };
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = 60000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(input, { ...init, signal: controller.signal }); }
  finally { clearTimeout(timeoutId); }
}

// Firecrawl: SKIP for Airbnb
function runFirecrawlForAirbnb(url: string): any {
  return { status: 'provider_not_supported_for_airbnb', durationMs: 0, extracted_price: null, evidence_snippet: 'Firecrawl stays not supported for Airbnb' };
}

async function runZyte(url: string): Promise<any> {
  const apiKey = Deno.env.get('ZYTE_API_KEY');
  if (!apiKey) return { status: 'provider_not_configured', error: 'No ZYTE_API_KEY' };
  const start = Date.now();
  try {
    const resp = await fetchWithTimeout('https://api.zyte.com/v1/extract', {
      method: 'POST',
      headers: { 'Authorization': `Basic ${btoa(apiKey + ':')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, browserHtml: true, javascript: true }),
    }, 55000);
    const durationMs = Date.now() - start;
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) return { status: 'provider_fetch_failed', durationMs, error: `HTTP ${resp.status}` };
    const html = data.browserHtml || '';
    
    // Try JSON extraction first
    const jsonPrices = extractJsonPricing(html);
    if (jsonPrices.length > 0) {
      const best = jsonPrices.sort((a, b) => b.amount - a.amount)[0];
      return { status: 'total_price_including_taxes_and_fees', durationMs, extracted_price: best.amount, currency: best.currency, json_path: best.jsonPath, json_excerpt: best.jsonExcerpt, evidence_snippet: `JSON: ${best.jsonPath}=${best.amount}`, source: 'json' };
    }
    
    // Try DOM total extraction
    const domTotal = extractDomTotal(html);
    if (domTotal) {
      return { status: 'total_price_including_taxes_and_fees', durationMs, extracted_price: domTotal.amount, currency: domTotal.currency, json_path: 'dom.Total', json_excerpt: domTotal.context, evidence_snippet: `DOM Total: ${domTotal.context}`, source: 'dom' };
    }
    
    // Check for subtotal (nights only) - triggers needs_user_confirmation
    const subtotal = extractSubtotal(html);
    if (subtotal) {
      return { 
        status: 'needs_user_confirmation', 
        durationMs, 
        extracted_price: null, // Never return subtotal as price
        subtotal_nights_only: subtotal.amount,
        subtotal_nights_count: subtotal.nights,
        currency: subtotal.currency, 
        evidence_snippet: `Subtotal found: ${subtotal.context}`,
        source: 'subtotal_only'
      };
    }
    
    return { status: 'price_not_available_in_content', durationMs, evidence_snippet: 'No proven total found' };
  } catch (e) { return { status: 'provider_error', error: String(e), durationMs: Date.now() - start }; }
}

async function runBrowserless(url: string): Promise<any> {
  const apiKey = Deno.env.get('BROWSERLESS_API_KEY');
  if (!apiKey) return { status: 'provider_not_configured', error: 'No BROWSERLESS_API_KEY' };
  const start = Date.now();
  try {
    // Use /function endpoint with Playwright for full page interaction
    const functionPayload = {
      code: `export default async function({ page }) {
        await page.goto('${url}', { waitUntil: 'networkidle2', timeout: 40000 });
        await new Promise(r => setTimeout(r, 5000));
        return { html: await page.content(), title: await page.title(), url: page.url() };
      }`,
      context: {},
    };
    const resp = await fetchWithTimeout(`https://chrome.browserless.io/function?token=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(functionPayload),
    }, 60000);
    const durationMs = Date.now() - start;
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      return { status: 'provider_fetch_failed', durationMs, error: `HTTP ${resp.status}: ${errText.slice(0,200)}` };
    }
    const result = await resp.json().catch(() => ({}));
    const html = result.html || '';
    const pageTitle = result.title || 'unknown';
    const finalUrl = result.url || url;
    
    // Try JSON extraction first
    const jsonPrices = extractJsonPricing(html);
    if (jsonPrices.length > 0) {
      const best = jsonPrices.sort((a, b) => b.amount - a.amount)[0];
      return { status: 'total_price_including_taxes_and_fees', durationMs, extracted_price: best.amount, currency: best.currency, json_path: best.jsonPath, json_excerpt: best.jsonExcerpt, evidence_snippet: `JSON: ${best.jsonPath}=${best.amount}`, source: 'json', page_title: pageTitle, final_url: finalUrl };
    }
    
    // Try DOM total extraction
    const domTotal = extractDomTotal(html);
    if (domTotal) {
      return { status: 'total_price_including_taxes_and_fees', durationMs, extracted_price: domTotal.amount, currency: domTotal.currency, json_path: 'dom.Total', json_excerpt: domTotal.context, evidence_snippet: `DOM Total: ${domTotal.context}`, source: 'dom', page_title: pageTitle, final_url: finalUrl };
    }
    
    // Check for subtotal (nights only) - triggers needs_user_confirmation
    const subtotal = extractSubtotal(html);
    if (subtotal) {
      return { 
        status: 'needs_user_confirmation', 
        durationMs, 
        extracted_price: null, // Never return subtotal as price
        subtotal_nights_only: subtotal.amount,
        subtotal_nights_count: subtotal.nights,
        currency: subtotal.currency, 
        evidence_snippet: `Subtotal found: ${subtotal.context}`,
        source: 'subtotal_only',
        page_title: pageTitle,
        final_url: finalUrl
      };
    }
    
    return { status: 'price_not_available_in_content', durationMs, evidence_snippet: 'No proven total found', page_title: pageTitle, final_url: finalUrl };
  } catch (e) { return { status: 'provider_error', error: String(e), durationMs: Date.now() - start }; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  let body: any = {};
  try { body = await req.json(); } catch {}
  const url = body.url;
  if (!url?.includes('airbnb.com')) return new Response(JSON.stringify({ error: 'Airbnb URL required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  
  const providers: string[] = body.providers || ['firecrawl', 'zyte', 'browserless'];
  const runId = crypto.randomUUID();
  const results: any[] = [];
  let accepted: string | null = null;

  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i].toLowerCase();
    let result: any;
    if (provider === 'firecrawl') result = runFirecrawlForAirbnb(url);
    else if (provider === 'zyte') result = await runZyte(url);
    else if (provider === 'browserless') result = await runBrowserless(url);
    else result = { status: 'unknown_provider' };

    await supabase.from('airbnb_baseline_debug').insert({
      run_id: runId, run_number: 1, provider, provider_order: i + 1, status: result.status,
      duration_ms: result.durationMs || 0, extracted_price: result.extracted_price || null,
      currency: result.currency || null, evidence_snippet: safeSnippet(result.evidence_snippet || result.error || '', 2000),
      airbnb_url: url,
    });

    results.push({ 
      run_id: runId, 
      provider, 
      status: result.status, 
      extracted_price: result.extracted_price, 
      subtotal_nights_only: result.subtotal_nights_only || null,
      subtotal_nights_count: result.subtotal_nights_count || null,
      currency: result.currency, 
      json_path: result.json_path, 
      json_excerpt: result.json_excerpt, 
      evidence_snippet: result.evidence_snippet, 
      source: result.source 
    });

    // Accept only proven totals with evidence
    if (result.status === 'total_price_including_taxes_and_fees' && result.json_path && result.json_excerpt) {
      accepted = provider;
      break;
    }
  }

  // Determine final status based on all results
  const hasNeedsConfirmation = results.some(r => r.status === 'needs_user_confirmation');
  const subtotalResult = results.find(r => r.subtotal_nights_only);
  
  return new Response(JSON.stringify({ 
    run_id: runId, 
    url, 
    accepted_provider: accepted, 
    final_status: accepted ? 'total_price_including_taxes_and_fees' : (hasNeedsConfirmation ? 'needs_user_confirmation' : 'price_not_available_in_content'),
    subtotal_nights_only: subtotalResult?.subtotal_nights_only || null,
    subtotal_nights_count: subtotalResult?.subtotal_nights_count || null,
    subtotal_currency: subtotalResult?.currency || null,
    results 
  }, null, 2), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
