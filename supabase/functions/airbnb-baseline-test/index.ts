import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Verify admin session
async function verifyAdminSession(supabase: any, token: string): Promise<{ valid: boolean; admin?: any; error?: string }> {
  if (!token) return { valid: false, error: 'No token provided' };

  const { data: session, error } = await supabase
    .from('admin_sessions')
    .select('*, admin_users(*)')
    .eq('session_token', token)
    .gt('expires_at', new Date().toISOString())
    .single();

  if (error || !session) return { valid: false, error: 'Invalid or expired session' };
  if (!session.admin_users.is_active) return { valid: false, error: 'Account is disabled' };

  return { valid: true, admin: session.admin_users };
}

// Types matching search-alternatives
type AirbnbBaselineStatus =
  | 'total_price_including_taxes_and_fees'
  | 'total_price_excluding_taxes_and_fees'
  | 'price_not_available_in_content';

type ProviderName = 'firecrawl' | 'zyte' | 'browserless';

interface ProviderAttemptResult {
  provider: ProviderName;
  status: AirbnbBaselineStatus | 'provider_fetch_failed' | 'provider_not_supported' | 'airbnb_blocked_or_captcha';
  price: number | null;
  currency: string | null;
  includes_taxes_fees: boolean;
  evidence_snippet: string;
  error?: string;
  duration_ms: number;
  candidates_summary: Array<{
    amount: number;
    currency: string;
    kind: string;
    label_hint: string;
    rejected_reason?: string;
  }>;
}

interface ValidationRunResult {
  run_number: number;
  timestamp: string;
  provider_order: ProviderName[];
  provider_results: ProviderAttemptResult[];
  final_status: string;
  final_price: number | null;
  final_currency: string | null;
  final_includes_taxes_fees: boolean;
  final_evidence_snippet: string;
  selected_provider?: ProviderName;
}

// Minimal content hash
function hashContent(content: string): string {
  let hash = 0;
  for (let i = 0; i < Math.min(content.length, 1000); i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

// Safe snippet
function safeSnippet(s: string, max = 260): string {
  return (s || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Normalize amount
function normalizeAmount(raw: string): number | null {
  const cleaned = raw.replace(/\s/g, '').replace(/,(?=\d{3}(?:\D|$))/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

// Extract price candidates
function extractPriceCandidates(content: string, nights: number): Array<{
  amount: number;
  currency: string;
  kind: AirbnbBaselineStatus;
  includesTaxesFees: boolean;
  labelHint: string;
  context: string;
  rejectedReason?: string;
}> {
  const moneyPatterns: Array<{ currency: string; re: RegExp }> = [
    { currency: 'USD', re: /(\$\s*[\d,.]+(?:\.\d{2})?)/g },
    { currency: 'EUR', re: /(€\s*[\d,.]+(?:\.\d{2})?)/g },
    { currency: 'GBP', re: /(£\s*[\d,.]+(?:\.\d{2})?)/g },
    { currency: 'CHF', re: /(CHF\s*[\d,.]+(?:\.\d{2})?)/gi },
  ];

  const candidates: Array<any> = [];

  for (const { currency, re } of moneyPatterns) {
    let match: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((match = re.exec(content)) !== null) {
      const rawMatch = match[1];
      const index = match.index;
      const amountRaw = rawMatch.replace(/[^0-9.,]/g, '');
      const amount = normalizeAmount(amountRaw);
      if (!amount || amount < 10 || amount > 500000) continue;

      const start = Math.max(0, index - 120);
      const end = Math.min(content.length, index + rawMatch.length + 120);
      const context = content.slice(start, end);
      const ctxLower = context.toLowerCase();

      // Nightly detection = immediate rejection
      const hasNightOnly = /\bper\s+night\b|\/night|\bnightly\b/i.test(context);
      if (hasNightOnly) {
        candidates.push({
          amount,
          currency,
          kind: 'price_not_available_in_content',
          includesTaxesFees: false,
          labelHint: safeSnippet(context, 100),
          context: safeSnippet(context, 200),
          rejectedReason: `nightly_price_only`,
        });
        continue;
      }

      // Ignore terms
      const ignoreTerms = ['from ', 'starting at', 'save ', 'discount', 'was ', 'original'];
      const ignoreHit = ignoreTerms.find((t) => ctxLower.includes(t));
      if (ignoreHit) {
        candidates.push({
          amount,
          currency,
          kind: 'price_not_available_in_content',
          includesTaxesFees: false,
          labelHint: safeSnippet(context, 100),
          context: safeSnippet(context, 200),
          rejectedReason: `ignored_term:${ignoreHit}`,
        });
        continue;
      }

      // Classify
      const hasTotalLabel = /\b(trip total|grand total|total before taxes|total|you pay)\b/i.test(context);
      const hasTaxesFeesLabel = /\b(includes\s+taxes|incl\.?\s+taxes|taxes\s+and\s+fees|including\s+taxes)\b/i.test(context);
      const hasBeforeTaxesLabel = /\btotal\s+before\s+taxes\b/i.test(context);
      const hasForNights = new RegExp(`\\bfor\\s+${nights}\\s+nights?\\b`, 'i').test(context) || /\bfor\s+\d+\s+nights?\b/i.test(context);

      let kind: AirbnbBaselineStatus = 'price_not_available_in_content';
      let includesTaxesFees = false;

      if (hasTotalLabel || hasForNights) {
        kind = hasBeforeTaxesLabel ? 'total_price_excluding_taxes_and_fees' : 'total_price_excluding_taxes_and_fees';
      }

      if (hasTaxesFeesLabel) {
        includesTaxesFees = true;
        kind = 'total_price_including_taxes_and_fees';
      }

      if (kind === 'price_not_available_in_content') {
        candidates.push({
          amount,
          currency,
          kind,
          includesTaxesFees: false,
          labelHint: safeSnippet(context, 100),
          context: safeSnippet(context, 200),
          rejectedReason: 'no_total_label_found',
        });
        continue;
      }

      candidates.push({
        amount,
        currency,
        kind,
        includesTaxesFees,
        labelHint: safeSnippet(context, 100),
        context: safeSnippet(context, 200),
      });
    }
  }

  return candidates;
}

// Fetch with timeout
async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

// Log provider request
async function logProviderRequest(supabase: any, provider: ProviderName, success: boolean, durationMs: number, url: string, errorMessage?: string): Promise<void> {
  try {
    await supabase.from('api_request_logs').insert({
      provider_name: provider,
      endpoint_type: 'airbnb_baseline_test',
      request_url: url.slice(0, 500),
      success,
      duration_ms: durationMs,
      error_message: errorMessage?.slice(0, 500) || null,
      cost_units: 1,
    });
  } catch (e) {
    console.error('[ProviderLog] Failed:', e);
  }
}

// Test with Firecrawl
async function testFirecrawl(url: string, nights: number, supabase: any): Promise<ProviderAttemptResult> {
  const start = Date.now();
  const provider: ProviderName = 'firecrawl';
  
  try {
    const apiKey = Deno.env.get('FIRECRAWL_API_KEY');
    if (!apiKey) {
      return {
        provider,
        status: 'provider_fetch_failed',
        price: null,
        currency: null,
        includes_taxes_fees: false,
        evidence_snippet: 'No API key configured',
        error: 'No API key',
        duration_ms: Date.now() - start,
        candidates_summary: [],
      };
    }

    const resp = await fetchWithTimeout(
      'https://api.firecrawl.dev/v1/scrape',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url,
          formats: ['markdown', 'html', 'rawHtml'],
          onlyMainContent: false,
          waitFor: 8000,
          timeout: 25000,
        }),
      },
      35000
    );

    const durationMs = Date.now() - start;

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      const isNotSupported = resp.status === 403;
      
      await logProviderRequest(supabase, provider, false, durationMs, url, `HTTP ${resp.status}`);
      
      return {
        provider,
        status: isNotSupported ? 'provider_not_supported' : 'provider_fetch_failed',
        price: null,
        currency: null,
        includes_taxes_fees: false,
        evidence_snippet: `HTTP ${resp.status}: ${errText.slice(0, 200)}`,
        error: `HTTP ${resp.status}`,
        duration_ms: durationMs,
        candidates_summary: [],
      };
    }

    await logProviderRequest(supabase, provider, true, durationMs, url);

    const data = await resp.json();
    const html = data?.data?.rawHtml || data?.data?.html || '';
    const markdown = data?.data?.markdown || '';
    const content = html || markdown;

    if (content.length < 500) {
      return {
        provider,
        status: 'price_not_available_in_content',
        price: null,
        currency: null,
        includes_taxes_fees: false,
        evidence_snippet: 'Insufficient content returned',
        duration_ms: durationMs,
        candidates_summary: [],
      };
    }

    // Check for bot indicators
    const botPatterns = [
      /please\s+complete\s+the\s+captcha/i,
      /verify\s+you['']?re\s+human/i,
      /checking\s+your\s+browser/i,
    ];
    const isBlocked = botPatterns.some(p => p.test(content));
    if (isBlocked) {
      return {
        provider,
        status: 'airbnb_blocked_or_captcha',
        price: null,
        currency: null,
        includes_taxes_fees: false,
        evidence_snippet: safeSnippet(content, 300),
        duration_ms: durationMs,
        candidates_summary: [],
      };
    }

    const candidates = extractPriceCandidates(content, nights);
    const accepted = candidates.filter(c => !c.rejectedReason);
    const sorted = accepted.sort((a, b) => {
      const kindRank = (k: string) => k === 'total_price_including_taxes_and_fees' ? 3 : k === 'total_price_excluding_taxes_and_fees' ? 2 : 0;
      return kindRank(b.kind) - kindRank(a.kind) || b.amount - a.amount;
    });

    const selected = sorted[0];

    return {
      provider,
      status: selected ? selected.kind : 'price_not_available_in_content',
      price: selected?.amount || null,
      currency: selected?.currency || null,
      includes_taxes_fees: selected?.includesTaxesFees || false,
      evidence_snippet: selected?.context || safeSnippet(content, 300),
      duration_ms: durationMs,
      candidates_summary: candidates.slice(0, 5).map(c => ({
        amount: c.amount,
        currency: c.currency,
        kind: c.kind,
        label_hint: c.labelHint,
        rejected_reason: c.rejectedReason,
      })),
    };
  } catch (e) {
    const durationMs = Date.now() - start;
    await logProviderRequest(supabase, provider, false, durationMs, url, String(e));
    return {
      provider,
      status: 'provider_fetch_failed',
      price: null,
      currency: null,
      includes_taxes_fees: false,
      evidence_snippet: String(e),
      error: String(e),
      duration_ms: durationMs,
      candidates_summary: [],
    };
  }
}

// Test with Zyte
async function testZyte(url: string, nights: number, supabase: any): Promise<ProviderAttemptResult> {
  const start = Date.now();
  const provider: ProviderName = 'zyte';
  
  try {
    const apiKey = Deno.env.get('ZYTE_API_KEY');
    if (!apiKey) {
      return {
        provider,
        status: 'provider_fetch_failed',
        price: null,
        currency: null,
        includes_taxes_fees: false,
        evidence_snippet: 'No API key configured',
        error: 'No API key',
        duration_ms: Date.now() - start,
        candidates_summary: [],
      };
    }

    const zyteAuth = btoa(apiKey + ':');
    const resp = await fetchWithTimeout(
      'https://api.zyte.com/v1/extract',
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${zyteAuth}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url,
          browserHtml: true,
          javascript: true,
          actions: [{ action: 'waitForTimeout', timeout: 8 }],
        }),
      },
      60000
    );

    const durationMs = Date.now() - start;

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      await logProviderRequest(supabase, provider, false, durationMs, url, `HTTP ${resp.status}`);
      return {
        provider,
        status: 'provider_fetch_failed',
        price: null,
        currency: null,
        includes_taxes_fees: false,
        evidence_snippet: `HTTP ${resp.status}: ${errText.slice(0, 200)}`,
        error: `HTTP ${resp.status}`,
        duration_ms: durationMs,
        candidates_summary: [],
      };
    }

    await logProviderRequest(supabase, provider, true, durationMs, url);

    const data = await resp.json();
    const html = data.browserHtml || '';

    if (html.length < 500) {
      return {
        provider,
        status: 'price_not_available_in_content',
        price: null,
        currency: null,
        includes_taxes_fees: false,
        evidence_snippet: 'Insufficient content returned',
        duration_ms: durationMs,
        candidates_summary: [],
      };
    }

    // Check for bot indicators
    const botPatterns = [
      /please\s+complete\s+the\s+captcha/i,
      /verify\s+you['']?re\s+human/i,
      /checking\s+your\s+browser/i,
    ];
    const isBlocked = botPatterns.some(p => p.test(html));
    if (isBlocked) {
      return {
        provider,
        status: 'airbnb_blocked_or_captcha',
        price: null,
        currency: null,
        includes_taxes_fees: false,
        evidence_snippet: safeSnippet(html, 300),
        duration_ms: durationMs,
        candidates_summary: [],
      };
    }

    const candidates = extractPriceCandidates(html, nights);
    const accepted = candidates.filter(c => !c.rejectedReason);
    const sorted = accepted.sort((a, b) => {
      const kindRank = (k: string) => k === 'total_price_including_taxes_and_fees' ? 3 : k === 'total_price_excluding_taxes_and_fees' ? 2 : 0;
      return kindRank(b.kind) - kindRank(a.kind) || b.amount - a.amount;
    });

    const selected = sorted[0];

    return {
      provider,
      status: selected ? selected.kind : 'price_not_available_in_content',
      price: selected?.amount || null,
      currency: selected?.currency || null,
      includes_taxes_fees: selected?.includesTaxesFees || false,
      evidence_snippet: selected?.context || safeSnippet(html, 300),
      duration_ms: durationMs,
      candidates_summary: candidates.slice(0, 5).map(c => ({
        amount: c.amount,
        currency: c.currency,
        kind: c.kind,
        label_hint: c.labelHint,
        rejected_reason: c.rejectedReason,
      })),
    };
  } catch (e) {
    const durationMs = Date.now() - start;
    await logProviderRequest(supabase, provider, false, durationMs, url, String(e));
    return {
      provider,
      status: 'provider_fetch_failed',
      price: null,
      currency: null,
      includes_taxes_fees: false,
      evidence_snippet: String(e),
      error: String(e),
      duration_ms: durationMs,
      candidates_summary: [],
    };
  }
}

// Test with Browserless
async function testBrowserless(url: string, nights: number, supabase: any): Promise<ProviderAttemptResult> {
  const start = Date.now();
  const provider: ProviderName = 'browserless';
  
  try {
    const apiKey = Deno.env.get('BROWSERLESS_API_KEY');
    if (!apiKey) {
      return {
        provider,
        status: 'provider_fetch_failed',
        price: null,
        currency: null,
        includes_taxes_fees: false,
        evidence_snippet: 'No API key configured',
        error: 'No API key',
        duration_ms: Date.now() - start,
        candidates_summary: [],
      };
    }

    const browserlessFnUrl = `https://chrome.browserless.io/function?token=${apiKey}`;

    const functionPayload = {
      code: `
        export default async function({ page, context }) {
          const url = context.url;
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

          await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
          await sleep(8000);

          // Try to expand price breakdown
          const clickSelectors = [
            "button[data-testid='price-breakdown-trigger']",
            "button[aria-label*='Show price breakdown']",
          ];

          for (const sel of clickSelectors) {
            try {
              const el = await page.$(sel);
              if (el) {
                await el.click({ delay: 30 });
                await sleep(1500);
                break;
              }
            } catch (e) {}
          }

          await sleep(2000);
          const html = await page.content();

          return { html };
        }
      `,
      context: { url },
    };

    const resp = await fetchWithTimeout(
      browserlessFnUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(functionPayload),
      },
      60000
    );

    const durationMs = Date.now() - start;

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      await logProviderRequest(supabase, provider, false, durationMs, url, `HTTP ${resp.status}`);
      return {
        provider,
        status: 'provider_fetch_failed',
        price: null,
        currency: null,
        includes_taxes_fees: false,
        evidence_snippet: `HTTP ${resp.status}: ${errText.slice(0, 200)}`,
        error: `HTTP ${resp.status}`,
        duration_ms: durationMs,
        candidates_summary: [],
      };
    }

    await logProviderRequest(supabase, provider, true, durationMs, url);

    const fnJson = await resp.json().catch(() => null);
    const html = fnJson?.html || '';

    if (html.length < 500) {
      return {
        provider,
        status: 'price_not_available_in_content',
        price: null,
        currency: null,
        includes_taxes_fees: false,
        evidence_snippet: 'Insufficient content returned',
        duration_ms: durationMs,
        candidates_summary: [],
      };
    }

    // Check for bot indicators
    const botPatterns = [
      /please\s+complete\s+the\s+captcha/i,
      /verify\s+you['']?re\s+human/i,
      /checking\s+your\s+browser/i,
    ];
    const isBlocked = botPatterns.some(p => p.test(html));
    if (isBlocked) {
      return {
        provider,
        status: 'airbnb_blocked_or_captcha',
        price: null,
        currency: null,
        includes_taxes_fees: false,
        evidence_snippet: safeSnippet(html, 300),
        duration_ms: durationMs,
        candidates_summary: [],
      };
    }

    const candidates = extractPriceCandidates(html, nights);
    const accepted = candidates.filter(c => !c.rejectedReason);
    const sorted = accepted.sort((a, b) => {
      const kindRank = (k: string) => k === 'total_price_including_taxes_and_fees' ? 3 : k === 'total_price_excluding_taxes_and_fees' ? 2 : 0;
      return kindRank(b.kind) - kindRank(a.kind) || b.amount - a.amount;
    });

    const selected = sorted[0];

    return {
      provider,
      status: selected ? selected.kind : 'price_not_available_in_content',
      price: selected?.amount || null,
      currency: selected?.currency || null,
      includes_taxes_fees: selected?.includesTaxesFees || false,
      evidence_snippet: selected?.context || safeSnippet(html, 300),
      duration_ms: durationMs,
      candidates_summary: candidates.slice(0, 5).map(c => ({
        amount: c.amount,
        currency: c.currency,
        kind: c.kind,
        label_hint: c.labelHint,
        rejected_reason: c.rejectedReason,
      })),
    };
  } catch (e) {
    const durationMs = Date.now() - start;
    await logProviderRequest(supabase, provider, false, durationMs, url, String(e));
    return {
      provider,
      status: 'provider_fetch_failed',
      price: null,
      currency: null,
      includes_taxes_fees: false,
      evidence_snippet: String(e),
      error: String(e),
      duration_ms: durationMs,
      candidates_summary: [],
    };
  }
}

// Main handler
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  // Verify admin session
  const authHeader = req.headers.get('authorization');
  const token = authHeader?.replace('Bearer ', '');
  const authResult = await verifyAdminSession(supabase, token || '');

  if (!authResult.valid) {
    return new Response(
      JSON.stringify({ error: authResult.error }),
      { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  try {
    const body = await req.json();
    const { url, runs = 3, delay_seconds = 25 } = body;

    if (!url) {
      return new Response(
        JSON.stringify({ error: 'URL is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Extract dates from URL
    const checkInMatch = url.match(/check_in=(\d{4}-\d{2}-\d{2})/);
    const checkOutMatch = url.match(/check_out=(\d{4}-\d{2}-\d{2})/);
    
    if (!checkInMatch || !checkOutMatch) {
      return new Response(
        JSON.stringify({ error: 'URL must include check_in and check_out dates' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const checkIn = checkInMatch[1];
    const checkOut = checkOutMatch[1];
    const nights = Math.ceil((new Date(checkOut).getTime() - new Date(checkIn).getTime()) / (1000 * 60 * 60 * 24));

    const providerOrder: ProviderName[] = ['browserless', 'firecrawl', 'zyte'];
    const results: ValidationRunResult[] = [];
    const runId = crypto.randomUUID();

    for (let i = 0; i < runs; i++) {
      const runNumber = i + 1;
      console.log(`\n=== Run ${runNumber}/${runs} ===`);

      const providerResults: ProviderAttemptResult[] = [];
      let finalStatus = 'price_not_available_in_content';
      let finalPrice: number | null = null;
      let finalCurrency: string | null = null;
      let finalIncludesTaxesFees = false;
      let finalEvidenceSnippet = '';
      let selectedProvider: ProviderName | undefined;

      for (const provider of providerOrder) {
        console.log(`Testing ${provider}...`);
        
        let result: ProviderAttemptResult;
        if (provider === 'firecrawl') {
          result = await testFirecrawl(url, nights, supabase);
        } else if (provider === 'zyte') {
          result = await testZyte(url, nights, supabase);
        } else {
          result = await testBrowserless(url, nights, supabase);
        }

        providerResults.push(result);
        console.log(`${provider}: ${result.status}, price: ${result.price || 'N/A'}`);

        // Persist debug bundle for this provider attempt
        try {
          await supabase.from('airbnb_baseline_debug').insert({
            run_id: runId,
            run_number: runNumber,
            provider: provider,
            provider_order: providerOrder.indexOf(provider) + 1,
            status: result.status,
            duration_ms: result.duration_ms,
            extracted_price: result.price,
            currency: result.currency,
            includes_taxes_fees: result.includes_taxes_fees,
            evidence_snippet: result.evidence_snippet?.slice(0, 2000),
            candidates_summary: result.candidates_summary,
            rejected_reason: result.candidates_summary?.find(c => c.rejected_reason)?.rejected_reason || null,
            airbnb_url: url,
            check_in_date: checkIn,
            check_out_date: checkOut,
            nights_count: nights,
          });
          console.log(`Persisted debug bundle for ${provider} run ${runNumber}`);
        } catch (persistErr) {
          console.error(`Failed to persist debug bundle:`, persistErr);
        }

        // If we got a total price, use it and stop
        if (result.status === 'total_price_including_taxes_and_fees' || 
            result.status === 'total_price_excluding_taxes_and_fees') {
          finalStatus = result.status;
          finalPrice = result.price;
          finalCurrency = result.currency;
          finalIncludesTaxesFees = result.includes_taxes_fees;
          finalEvidenceSnippet = result.evidence_snippet;
          selectedProvider = provider;
          break;
        }
      }

      // If no success, use last result's evidence
      if (!selectedProvider && providerResults.length > 0) {
        const last = providerResults[providerResults.length - 1];
        finalStatus = last.status;
        finalEvidenceSnippet = last.evidence_snippet;
      }

      results.push({
        run_number: runNumber,
        timestamp: new Date().toISOString(),
        provider_order: providerOrder,
        provider_results: providerResults,
        final_status: finalStatus,
        final_price: finalPrice,
        final_currency: finalCurrency,
        final_includes_taxes_fees: finalIncludesTaxesFees,
        final_evidence_snippet: finalEvidenceSnippet,
        selected_provider: selectedProvider,
      });

      // Wait between runs (except last)
      if (i < runs - 1) {
        console.log(`Waiting ${delay_seconds}s before next run...`);
        await new Promise(r => setTimeout(r, delay_seconds * 1000));
      }
    }

    // Summary
    const summary = {
      run_id: runId,
      url,
      check_in: checkIn,
      check_out: checkOut,
      nights,
      total_runs: runs,
      consistent: results.every(r => r.final_status === results[0].final_status),
      all_prices_match: results.every(r => r.final_price === results[0].final_price),
      results,
    };

    console.log('\n=== SUMMARY ===');
    console.log(JSON.stringify(summary, null, 2));

    return new Response(
      JSON.stringify(summary),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (e) {
    console.error('Error:', e);
    return new Response(
      JSON.stringify({ error: String(e) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
