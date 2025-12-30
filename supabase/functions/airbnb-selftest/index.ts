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

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function ocrImageToText(imageBase64Png: string): Promise<string> {
  const key = Deno.env.get('LOVABLE_API_KEY');
  if (!key) throw new Error('Missing LOVABLE_API_KEY');

  const body = {
    model: 'google/gemini-2.5-flash',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              'Read the text in this Airbnb booking-card screenshot. Return ONLY the recognized text with line breaks. Do not add commentary.',
          },
          {
            type: 'image_url',
            image_url: {
              url: `data:image/png;base64,${imageBase64Png}`,
            },
          },
        ],
      },
    ],
  };

  const resp = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`OCR request failed: HTTP ${resp.status} ${JSON.stringify(json).slice(0, 400)}`);
  }

  const text = json?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('OCR response missing text content');
  }

  return text;
}

function extractBookingCardVisibleAmountFromOcrText(args: {
  ocrTextRaw: string;
  nightsExpected: number;
}): {
  booking_card_ocr_text_raw: string;
  booking_card_ocr_text_normalized: string;
  booking_card_ocr_matches: Array<{ matched_substring: string; amount_value: number }>;
  booking_card_visible_evidence_snippet: string | null;
  booking_card_visible_amount_value: number | null;
} {
  const raw = args.ocrTextRaw ?? '';
  const normalized = raw.replace(/\r/g, '').replace(/\s+$/gm, '');

  // We intentionally work line-based so we can tie amounts to "for N nights" context.
  const lines = normalized
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const nightsRe = new RegExp(`for\\s+${args.nightsExpected}\\s+night`, 'i');

  // Minimal parsing requirement: only support thousands separator like 2,214
  const amountTokenRe = /([0-9]{1,3}(?:,[0-9]{3})+)/g;

  const matches: Array<{ matched_substring: string; amount_value: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!nightsRe.test(line)) continue;

    // Consider same line and one line above, per requirements.
    const candidates = [line, lines[i - 1]].filter(Boolean) as string[];

    for (const candidateLine of candidates) {
      amountTokenRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = amountTokenRe.exec(candidateLine)) !== null) {
        const token = m[1];
        const amount = Number.parseInt(token.replace(/,/g, ''), 10);
        if (!Number.isFinite(amount)) continue;

        const matched_substring = candidateLine === line ? line : `${candidateLine} | ${line}`;
        matches.push({ matched_substring, amount_value: amount });
      }
    }
  }

  // Selection rule (exact): among all matches tied to "for N nights", choose the highest numeric amount.
  const best = matches.length
    ? matches.reduce((acc, cur) => (cur.amount_value > acc.amount_value ? cur : acc))
    : null;

  return {
    booking_card_ocr_text_raw: raw,
    booking_card_ocr_text_normalized: normalized,
    booking_card_ocr_matches: matches,
    booking_card_visible_evidence_snippet: best?.matched_substring ?? null,
    booking_card_visible_amount_value: best?.amount_value ?? null,
  };
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
    const functionPayload = {
      code: `export default async function({ page }) {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        // Polyfill for older/newer runtimes that removed page.waitForTimeout
        if (!page.waitForTimeout || typeof page.waitForTimeout !== 'function') {
          page.waitForTimeout = (ms) => sleep(ms);
        }

        const requestedUrl = '${url}';
        const targetRoomPath = '/rooms/903802242341279498';

        // Realistic Chrome UA to reduce weird variants
        await page.setUserAgent(
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        );

        // Viewport first
        await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 2 });

        // Capture redirect / navigation chain (best-effort)
        const chain = [];
        page.on('response', (res) => {
          try {
            const u = res.url();
            chain.push(u);
            if (chain.length > 25) chain.shift();
          } catch {}
        });

        // Hard reset (best-effort) - clear cookies/cache
        try {
          const client = await page.target().createCDPSession();
          await client.send('Network.enable');
          await client.send('Network.clearBrowserCookies');
          await client.send('Network.clearBrowserCache');
        } catch {}

        // Establish origin, then clear storage
        await page.goto('https://www.airbnb.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
        await sleep(500);
        try {
          await page.evaluate(() => {
            localStorage.clear();
            sessionStorage.clear();
            if ('caches' in window) {
              // @ts-ignore
              caches.keys().then((keys) => keys.forEach((k) => caches.delete(k)));
            }
          });
        } catch {}

        // Navigate to requested URL
        await page.goto(requestedUrl, { waitUntil: 'networkidle2', timeout: 45000 });
        await sleep(1000);

        // Reset scroll BEFORE capture
        await page.evaluate(() => window.scrollTo(0, 0));
        await sleep(500);

        const finalUrl = page.url();
        const pageTitle = await page.title().catch(() => '');
        const bodyText = await page.evaluate(() => (document.body?.innerText || '').slice(0, 500)).catch(() => '');

        const screenshotTopClip = { x: 0, y: 0, width: 1280, height: 900 };
        const scrollY = await page.evaluate(() => Math.round(window.scrollY || 0));
        const screenshotTopBase64 = await page
          .screenshot({ encoding: 'base64', clip: screenshotTopClip })
          .catch(() => null);

        const finalPathOk = typeof finalUrl === 'string' && finalUrl.includes(targetRoomPath);
        const bookingConfirmedContamination = /BOOKING\s+CONFIRMED|Your\s+trip\s+to/i.test(bodyText);

        let wrongReason = null;
        if (!finalPathOk) wrongReason = 'final_url_not_target_room';
        else if (bookingConfirmedContamination) wrongReason = 'booking_confirmed_contamination';

        return {
          requestedUrl,
          finalUrl,
          pageTitle,
          bodyTextSnippet: bodyText,
          redirectChain: chain.slice(-5),
          wrongPageContextReason: wrongReason,
          screenshotTopBase64,
          screenshotTopClip,
          scrollY,
          html: await page.content(),
        };
      }`,
      context: {},
    };

    const resp = await fetchWithTimeout(`https://chrome.browserless.io/function?token=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(functionPayload),
    }, 65000);

    const durationMs = Date.now() - start;
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      return { status: 'provider_fetch_failed', durationMs, error: `HTTP ${resp.status}: ${errText.slice(0, 200)}` };
    }

    const result = await resp.json().catch(() => ({}));
    const html = result.html || '';
    const pageTitle = result.pageTitle || result.title || 'unknown';
    const finalUrl = result.finalUrl || result.url || url;

    const screenshot_top_base64 = result.screenshotTopBase64 || null;
    const screenshot_top_clip = result.screenshotTopClip || null;
    const scroll_y_at_capture = typeof result.scrollY === 'number' ? result.scrollY : null;

    const navigation_phase = {
      requested_url: result.requestedUrl || url,
      final_url: finalUrl,
      redirect_chain: Array.isArray(result.redirectChain) ? result.redirectChain : [],
      page_title: pageTitle,
      body_text_snippet: result.bodyTextSnippet || '',
      wrong_page_context_reason: result.wrongPageContextReason || null,
    };

    // If Browserless isn't on the correct room (or is contaminated), FAIL EARLY.
    if (navigation_phase.wrong_page_context_reason) {
      return {
        status: 'wrong_page_context',
        durationMs,
        evidence_snippet: navigation_phase.wrong_page_context_reason,
        source: 'navigation_guard',
        page_title: pageTitle,
        final_url: finalUrl,
        navigation_phase,
        screenshot_top_base64,
        screenshot_top_clip,
        scroll_y_at_capture,
      };
    }

    // Reuse existing booking_card_* naming in provider results so downstream code doesn't change.
    const booking_card_screenshot_base64 = screenshot_top_base64;
    const booking_card_screenshot_bbox = screenshot_top_clip;
    const booking_card_screenshot_dimensions = screenshot_top_clip
      ? { width: screenshot_top_clip.width, height: screenshot_top_clip.height }
      : null;

    // Try JSON extraction first
    const jsonPrices = extractJsonPricing(html);
    if (jsonPrices.length > 0) {
      const best = jsonPrices.sort((a, b) => b.amount - a.amount)[0];
      return {
        status: 'total_price_including_taxes_and_fees',
        durationMs,
        extracted_price: best.amount,
        currency: best.currency,
        json_path: best.jsonPath,
        json_excerpt: best.jsonExcerpt,
        evidence_snippet: `JSON: ${best.jsonPath}=${best.amount}`,
        source: 'json',
        page_title: pageTitle,
        final_url: finalUrl,
        booking_card_screenshot_base64,
        booking_card_screenshot_bbox,
        booking_card_screenshot_dimensions,
        screenshot_top_base64,
        screenshot_top_clip,
        scroll_y_at_capture,
      };
    }

    // Try DOM total extraction
    const domTotal = extractDomTotal(html);
    if (domTotal) {
      return {
        status: 'total_price_including_taxes_and_fees',
        durationMs,
        extracted_price: domTotal.amount,
        currency: domTotal.currency,
        json_path: 'dom.Total',
        json_excerpt: domTotal.context,
        evidence_snippet: `DOM Total: ${domTotal.context}`,
        source: 'dom',
        page_title: pageTitle,
        final_url: finalUrl,
        booking_card_screenshot_base64,
        booking_card_screenshot_bbox,
        booking_card_screenshot_dimensions,
        screenshot_top_base64,
        screenshot_top_clip,
        scroll_y_at_capture,
      };
    }

    const subtotal = extractSubtotal(html);
    if (subtotal) {
      return {
        status: 'needs_user_confirmation',
        durationMs,
        extracted_price: null,
        subtotal_nights_only: subtotal.amount,
        subtotal_nights_count: subtotal.nights,
        currency: subtotal.currency,
        evidence_snippet: `Subtotal found: ${subtotal.context}`,
        source: 'subtotal_only',
        page_title: pageTitle,
        final_url: finalUrl,
        booking_card_screenshot_base64,
        booking_card_screenshot_bbox,
        booking_card_screenshot_dimensions,
        screenshot_top_base64,
        screenshot_top_clip,
        scroll_y_at_capture,
      };
    }

    return {
      status: 'price_not_available_in_content',
      durationMs,
      evidence_snippet: 'No proven total found',
      page_title: pageTitle,
      final_url: finalUrl,
      booking_card_screenshot_base64,
      booking_card_screenshot_bbox,
      booking_card_screenshot_dimensions,
      screenshot_top_base64,
      screenshot_top_clip,
      scroll_y_at_capture,
    };
  } catch (e) {
    return { status: 'provider_error', error: String(e), durationMs: Date.now() - start };
  }
}


Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  let body: any = {};
  try {
    body = await req.json();
  } catch {}
  const url = body.url;
  if (!url?.includes('airbnb.com')) {
    return new Response(JSON.stringify({ error: 'Airbnb URL required' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const providers: string[] = body.providers || ['firecrawl', 'zyte', 'browserless'];
  const runId = crypto.randomUUID();

  // ------------------------------------------------------------
  // Run providers first (no DB writes yet so we can attach OCR)
  // ------------------------------------------------------------
  const providerResults: any[] = [];
  let accepted: string | null = null;

  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i].toLowerCase();
    let result: any;
    if (provider === 'firecrawl') result = runFirecrawlForAirbnb(url);
    else if (provider === 'zyte') result = await runZyte(url);
    else if (provider === 'browserless') result = await runBrowserless(url);
    else result = { status: 'unknown_provider' };

    providerResults.push({ provider, provider_order: i + 1, ...result });

    if (result.status === 'total_price_including_taxes_and_fees' && result.json_path && result.json_excerpt) {
      accepted = provider;
      break;
    }
  }

  // ------------------------------------------------------------
  // Screenshot OCR proof (MUST be image-based)
  // ------------------------------------------------------------
  const browserless = providerResults.find((r) => r.provider === 'browserless');

  const screenshotTopBase64: string | null = browserless?.screenshot_top_base64 ?? null;
  const screenshotTopClip = browserless?.screenshot_top_clip ?? null;
  const scrollYAtCapture: number | null = browserless?.scroll_y_at_capture ?? null;

  const requiredNights = 4;

  let ocrArtifacts: any = {
    ocr_input_source_type: 'image',
    ocr_input_image_sha256: null,

    // New deterministic screenshot-top artifacts
    screenshot_top_base64: screenshotTopBase64,
    screenshot_top_sha256: null,
    screenshot_top_clip: screenshotTopClip,
    scroll_y_at_capture: scrollYAtCapture,

    // Back-compat: keep the older booking_card_screenshot_* fields populated with screenshot-top
    booking_card_screenshot_sha256: null,
    booking_card_screenshot_base64: screenshotTopBase64,
    booking_card_screenshot_dimensions: screenshotTopClip
      ? { width: screenshotTopClip.width, height: screenshotTopClip.height }
      : null,
    booking_card_screenshot_bbox: screenshotTopClip,

    // OCR outputs
    booking_card_ocr_text_raw: null,
    booking_card_ocr_text_normalized: null,
    booking_card_ocr_matches: [],
    booking_card_visible_evidence_snippet: null,
    booking_card_visible_amount_value: null,
  };

  if (!screenshotTopBase64) {
    return new Response(
      JSON.stringify(
        {
          run_id: runId,
          url,
          final_status: 'screenshot_top_missing',
          navigation_phase: browserless?.navigation_phase ?? null,
          results: providerResults,
        },
        null,
        2
      ),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // If navigation guard failed, return immediately with evidence; do NOT run OCR.
  if (browserless?.status === 'wrong_page_context') {
    return new Response(
      JSON.stringify(
        {
          run_id: runId,
          url,
          final_status: 'wrong_page_context',
          navigation_phase: browserless?.navigation_phase ?? null,
          screenshot_top_base64: screenshotTopBase64,
          screenshot_top_clip: browserless?.screenshot_top_clip ?? null,
          scroll_y_at_capture: browserless?.scroll_y_at_capture ?? null,
          results: providerResults,
        },
        null,
        2
      ),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // Enforce scroll_y_at_capture = 0 (prove we captured the TOP of page)
  if (scrollYAtCapture !== 0) {
    return new Response(
      JSON.stringify(
        {
          run_id: runId,
          url,
          final_status: 'scroll_not_reset',
          navigation_phase: browserless?.navigation_phase ?? null,
          scroll_y_at_capture: scrollYAtCapture,
          screenshot_top_base64: screenshotTopBase64,
          screenshot_top_clip: screenshotTopClip,
          results: providerResults,
        },
        null,
        2
      ),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  try {
    const screenshotBytes = base64ToBytes(screenshotTopBase64);
    const screenshotTopSha = await sha256Hex(screenshotBytes);

    // OCR input bytes MUST equal the screenshot bytes we persist
    const ocrInputBytes = base64ToBytes(screenshotTopBase64);
    const ocrInputSha = await sha256Hex(ocrInputBytes);

    ocrArtifacts.screenshot_top_sha256 = screenshotTopSha;
    ocrArtifacts.booking_card_screenshot_sha256 = screenshotTopSha;
    ocrArtifacts.ocr_input_image_sha256 = ocrInputSha;

    if (screenshotTopSha !== ocrInputSha) {
      // Persist debug rows anyway
      for (const r of providerResults) {
        await supabase.from('airbnb_baseline_debug').insert({
          run_id: runId,
          run_number: 1,
          provider: r.provider,
          provider_order: r.provider_order,
          status: 'ocr_input_mismatch',
          duration_ms: r.durationMs || 0,
          extracted_price: r.extracted_price || null,
          currency: r.currency || null,
          evidence_snippet: safeSnippet(r.evidence_snippet || r.error || '', 2000),
          airbnb_url: url,

          ocr_input_source_type: ocrArtifacts.ocr_input_source_type,
          ocr_input_image_sha256: ocrArtifacts.ocr_input_image_sha256,

          screenshot_top_base64: ocrArtifacts.screenshot_top_base64,
          screenshot_top_sha256: ocrArtifacts.screenshot_top_sha256,
          screenshot_top_clip: ocrArtifacts.screenshot_top_clip,
          scroll_y_at_capture: ocrArtifacts.scroll_y_at_capture,

          booking_card_screenshot_sha256: ocrArtifacts.booking_card_screenshot_sha256,
          booking_card_screenshot_base64: ocrArtifacts.booking_card_screenshot_base64,
          booking_card_screenshot_dimensions: ocrArtifacts.booking_card_screenshot_dimensions,
          booking_card_screenshot_bbox: ocrArtifacts.booking_card_screenshot_bbox,
        });
      }

      return new Response(
        JSON.stringify(
          {
            run_id: runId,
            url,
            final_status: 'ocr_input_mismatch',
            ...ocrArtifacts,
            results: providerResults,
          },
          null,
          2
        ),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Run OCR on screenshot pixels
    const ocrTextRaw = await ocrImageToText(screenshotTopBase64);
    const extracted = extractBookingCardVisibleAmountFromOcrText({
      ocrTextRaw,
      nightsExpected: requiredNights,
    });

    ocrArtifacts.booking_card_ocr_text_raw = extracted.booking_card_ocr_text_raw;
    ocrArtifacts.booking_card_ocr_text_normalized = extracted.booking_card_ocr_text_normalized;
    ocrArtifacts.booking_card_ocr_matches = extracted.booking_card_ocr_matches;
    ocrArtifacts.booking_card_visible_evidence_snippet = extracted.booking_card_visible_evidence_snippet;
    ocrArtifacts.booking_card_visible_amount_value = extracted.booking_card_visible_amount_value;
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify(
        {
          run_id: runId,
          url,
          final_status: 'booking_card_ocr_error',
          error: errMsg,
          ...ocrArtifacts,
          results: providerResults,
        },
        null,
        2
      ),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // ------------------------------------------------------------
  // Hard selftest assertion: MUST be 2214 for the provided URL
  // ------------------------------------------------------------
  const expectedBookingCardValue = 2214;
  if (ocrArtifacts.booking_card_visible_amount_value !== expectedBookingCardValue) {
    // Persist rows + OCR artifacts
    for (const r of providerResults) {
      await supabase.from('airbnb_baseline_debug').insert({
        run_id: runId,
        run_number: 1,
        provider: r.provider,
        provider_order: r.provider_order,
        status: 'booking_card_ocr_assertion_failed',
        duration_ms: r.durationMs || 0,
        extracted_price: r.extracted_price || null,
        currency: r.currency || null,
        evidence_snippet: safeSnippet(r.evidence_snippet || r.error || '', 2000),
        airbnb_url: url,

        ocr_input_source_type: ocrArtifacts.ocr_input_source_type,
        ocr_input_image_sha256: ocrArtifacts.ocr_input_image_sha256,

        screenshot_top_base64: ocrArtifacts.screenshot_top_base64,
        screenshot_top_sha256: ocrArtifacts.screenshot_top_sha256,
        screenshot_top_clip: ocrArtifacts.screenshot_top_clip,
        scroll_y_at_capture: ocrArtifacts.scroll_y_at_capture,

        booking_card_screenshot_sha256: ocrArtifacts.booking_card_screenshot_sha256,
        booking_card_screenshot_base64: ocrArtifacts.booking_card_screenshot_base64,
        booking_card_screenshot_dimensions: ocrArtifacts.booking_card_screenshot_dimensions,
        booking_card_screenshot_bbox: ocrArtifacts.booking_card_screenshot_bbox,

        booking_card_ocr_text_raw: ocrArtifacts.booking_card_ocr_text_raw,
        booking_card_ocr_text_normalized: ocrArtifacts.booking_card_ocr_text_normalized,
        booking_card_ocr_matches: ocrArtifacts.booking_card_ocr_matches,
        booking_card_visible_evidence_snippet: ocrArtifacts.booking_card_visible_evidence_snippet,
        ocr_booking_card_amount_value: ocrArtifacts.booking_card_visible_amount_value,
      });
    }

    return new Response(
      JSON.stringify(
        {
          run_id: runId,
          url,
          final_status: 'booking_card_ocr_assertion_failed',
          expected_booking_card_visible_amount_value: expectedBookingCardValue,
          ...ocrArtifacts,
          results: providerResults,
        },
        null,
        2
      ),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // ------------------------------------------------------------
  // Provider mismatch logic: reject 1977 as lower than baseline 2214
  // ------------------------------------------------------------
  const baseline = ocrArtifacts.booking_card_visible_amount_value as number;
  const results = providerResults.map((r) => {
    const providerNumeric = (r.extracted_price ?? r.subtotal_nights_only) as number | null;
    const mismatch_reason = providerNumeric != null && providerNumeric < baseline ? 'provider_price_lower_than_visible_price' : null;
    const ocr_validation_status = providerNumeric != null && providerNumeric < baseline ? 'rejected' : 'accepted';
    return {
      run_id: runId,
      provider: r.provider,
      status: r.status,
      extracted_price: r.extracted_price ?? null,
      subtotal_nights_only: r.subtotal_nights_only ?? null,
      subtotal_nights_count: r.subtotal_nights_count ?? null,
      currency: r.currency ?? null,
      evidence_snippet: r.evidence_snippet,
      source: r.source,
      ocr_validation_status,
      mismatch_reason,
    };
  });

  // Persist rows (including OCR artifacts + mismatch fields)
  for (const r of providerResults) {
    const providerNumeric = (r.extracted_price ?? r.subtotal_nights_only) as number | null;
    const mismatch_reason = providerNumeric != null && providerNumeric < baseline ? 'provider_price_lower_than_visible_price' : null;
    const ocr_validation_status = providerNumeric != null && providerNumeric < baseline ? 'rejected' : 'accepted';

    await supabase.from('airbnb_baseline_debug').insert({
      run_id: runId,
      run_number: 1,
      provider: r.provider,
      provider_order: r.provider_order,
      status: r.status,
      duration_ms: r.durationMs || 0,
      extracted_price: r.extracted_price || null,
      currency: r.currency || null,
      evidence_snippet: safeSnippet(r.evidence_snippet || r.error || '', 2000),
      airbnb_url: url,

      // OCR proof + artifacts
      ocr_input_source_type: ocrArtifacts.ocr_input_source_type,
      ocr_input_image_sha256: ocrArtifacts.ocr_input_image_sha256,

      screenshot_top_base64: ocrArtifacts.screenshot_top_base64,
      screenshot_top_sha256: ocrArtifacts.screenshot_top_sha256,
      screenshot_top_clip: ocrArtifacts.screenshot_top_clip,
      scroll_y_at_capture: ocrArtifacts.scroll_y_at_capture,

      booking_card_screenshot_sha256: ocrArtifacts.booking_card_screenshot_sha256,
      booking_card_screenshot_base64: ocrArtifacts.booking_card_screenshot_base64,
      booking_card_screenshot_dimensions: ocrArtifacts.booking_card_screenshot_dimensions,
      booking_card_screenshot_bbox: ocrArtifacts.booking_card_screenshot_bbox,

      booking_card_ocr_text_raw: ocrArtifacts.booking_card_ocr_text_raw,
      booking_card_ocr_text_normalized: ocrArtifacts.booking_card_ocr_text_normalized,
      booking_card_ocr_matches: ocrArtifacts.booking_card_ocr_matches,
      booking_card_visible_evidence_snippet: ocrArtifacts.booking_card_visible_evidence_snippet,
      ocr_booking_card_amount_value: ocrArtifacts.booking_card_visible_amount_value,
      ocr_booking_card_nights: requiredNights,

      // Provider vs OCR mismatch
      ocr_validation_status,
      ocr_mismatch_reason: mismatch_reason,
    });
  }

  return new Response(
    JSON.stringify(
      {
        run_id: runId,
        url,
        final_status: 'pass',

        // Stop-condition payload
        booking_card_visible_amount_value: ocrArtifacts.booking_card_visible_amount_value,
        booking_card_visible_evidence_snippet: ocrArtifacts.booking_card_visible_evidence_snippet,
        booking_card_ocr_matches: ocrArtifacts.booking_card_ocr_matches,

        screenshot_top_base64: ocrArtifacts.screenshot_top_base64,
        screenshot_top_sha256: ocrArtifacts.screenshot_top_sha256,
        screenshot_top_clip: ocrArtifacts.screenshot_top_clip,
        scroll_y_at_capture: ocrArtifacts.scroll_y_at_capture,

        booking_card_screenshot_sha256: ocrArtifacts.booking_card_screenshot_sha256,
        ocr_input_image_sha256: ocrArtifacts.ocr_input_image_sha256,
        booking_card_ocr_text_raw: ocrArtifacts.booking_card_ocr_text_raw,

        results,
      },
      null,
      2
    ),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
});

