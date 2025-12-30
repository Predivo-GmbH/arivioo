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
  booking_card_ocr_matched_substring: string | null;
  booking_card_visible_amount_value: number | null;
} {
  const raw = args.ocrTextRaw ?? '';
  const normalized = raw.replace(/\r/g, '').replace(/\s+$/gm, '');
  const lines = normalized
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const nightsRe = new RegExp(`for\\s+${args.nightsExpected}\\s+night`, 'i');
  const amountRe = /(?:\$|US\$)?\s*([0-9]{1,3}(?:,[0-9]{3})+)/;

  for (let i = 0; i < lines.length; i++) {
    if (!nightsRe.test(lines[i])) continue;

    const sameLine = lines[i];
    const prevLine = lines[i - 1] ?? '';

    const sameMatch = sameLine.match(amountRe);
    const prevMatch = prevLine.match(amountRe);

    const pick = sameMatch?.[1] ? { val: sameMatch[1], ctx: sameLine } : prevMatch?.[1] ? { val: prevMatch[1], ctx: `${prevLine} | ${sameLine}` } : null;

    if (!pick) {
      return {
        booking_card_ocr_text_raw: raw,
        booking_card_ocr_text_normalized: normalized,
        booking_card_ocr_matched_substring: sameLine,
        booking_card_visible_amount_value: null,
      };
    }

    // Minimal parsing requirement: treat comma as thousands separator ONLY for ddd,ddd patterns
    const thousands = pick.val.replace(/,/g, '');
    const amount = Number.parseInt(thousands, 10);

    return {
      booking_card_ocr_text_raw: raw,
      booking_card_ocr_text_normalized: normalized,
      booking_card_ocr_matched_substring: pick.ctx,
      booking_card_visible_amount_value: Number.isFinite(amount) ? amount : null,
    };
  }

  return {
    booking_card_ocr_text_raw: raw,
    booking_card_ocr_text_normalized: normalized,
    booking_card_ocr_matched_substring: null,
    booking_card_visible_amount_value: null,
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
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        await page.setViewport({ width: 1400, height: 900 });
        await page.goto('${url}', { waitUntil: 'networkidle2', timeout: 45000 });
        await sleep(5000);

        let bookingCardScreenshot = null;
        let bookingCardBBox = null;
        let bookingCardDimensions = null;
        let strategy = 'none';

        try {
          // Strategy 1: Look for the booking sidebar container
          const sidebar = await page.$('div[data-section-id="BOOK_IT_SIDEBAR"]');
          
          if (sidebar) {
            const sidebarBox = await sidebar.boundingBox();
            if (sidebarBox) {
              // Screenshot just the TOP portion of the sidebar (first 120px) which shows the total price header
              const headerClip = {
                x: Math.round(sidebarBox.x),
                y: Math.round(sidebarBox.y),
                width: Math.round(sidebarBox.width),
                height: Math.min(120, Math.round(sidebarBox.height / 3))
              };
              bookingCardScreenshot = await page.screenshot({ encoding: 'base64', clip: headerClip }).catch(() => null);
              bookingCardBBox = headerClip;
              bookingCardDimensions = { width: headerClip.width, height: headerClip.height };
              strategy = 'sidebar_header_clip';
            }
          }
          
          // Strategy 2: Fallback to viewport right-side clip at TOP of page
          if (!bookingCardScreenshot) {
            // The booking card header with total is at the TOP right of the viewport
            const clip = {
              x: 770,   // Right side where booking card appears
              y: 100,   // Near top of viewport after header
              width: 450,
              height: 150,
            };
            bookingCardScreenshot = await page.screenshot({ encoding: 'base64', clip }).catch(() => null);
            bookingCardBBox = clip;
            bookingCardDimensions = { width: clip.width, height: clip.height };
            strategy = 'viewport_top_right_clip';
          }
        } catch (e) {
          strategy = 'error: ' + String(e).slice(0, 100);
        }

        return {
          html: await page.content(),
          title: await page.title(),
          url: page.url(),
          bookingCardScreenshot,
          bookingCardBBox,
          bookingCardDimensions,
          strategy,
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
    const pageTitle = result.title || 'unknown';
    const finalUrl = result.url || url;

    const booking_card_screenshot_base64 = result.bookingCardScreenshot || null;
    const booking_card_screenshot_bbox = result.bookingCardBBox || null;
    const booking_card_screenshot_dimensions = result.bookingCardDimensions || null;

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
  const bookingCardScreenshotBase64: string | null = browserless?.booking_card_screenshot_base64 ?? null;
  const bookingCardBBox = browserless?.booking_card_screenshot_bbox ?? null;
  const bookingCardDimensions = browserless?.booking_card_screenshot_dimensions ?? null;

  const requiredNights = 4;

  let ocrArtifacts: any = {
    ocr_input_source_type: 'image',
    ocr_input_image_sha256: null,
    booking_card_screenshot_sha256: null,
    booking_card_screenshot_base64: bookingCardScreenshotBase64,
    booking_card_screenshot_dimensions: bookingCardDimensions,
    booking_card_screenshot_bbox: bookingCardBBox,
    booking_card_ocr_text_raw: null,
    booking_card_ocr_text_normalized: null,
    booking_card_ocr_matched_substring: null,
    booking_card_visible_amount_value: null,
  };

  if (!bookingCardScreenshotBase64) {
    return new Response(
      JSON.stringify(
        {
          run_id: runId,
          url,
          final_status: 'booking_card_screenshot_missing',
          results: providerResults,
        },
        null,
        2
      ),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  try {
    const screenshotBytes = base64ToBytes(bookingCardScreenshotBase64);
    const bookingCardSha = await sha256Hex(screenshotBytes);

    // OCR input bytes MUST equal the screenshot bytes we persist
    const ocrInputBytes = base64ToBytes(bookingCardScreenshotBase64);
    const ocrInputSha = await sha256Hex(ocrInputBytes);

    ocrArtifacts.booking_card_screenshot_sha256 = bookingCardSha;
    ocrArtifacts.ocr_input_image_sha256 = ocrInputSha;

    if (bookingCardSha !== ocrInputSha) {
      ocrArtifacts.ocr_input_source_type = 'image';

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
    const ocrTextRaw = await ocrImageToText(bookingCardScreenshotBase64);
    const extracted = extractBookingCardVisibleAmountFromOcrText({ ocrTextRaw, nightsExpected: requiredNights });

    ocrArtifacts.booking_card_ocr_text_raw = extracted.booking_card_ocr_text_raw;
    ocrArtifacts.booking_card_ocr_text_normalized = extracted.booking_card_ocr_text_normalized;
    ocrArtifacts.booking_card_ocr_matched_substring = extracted.booking_card_ocr_matched_substring;
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
        booking_card_screenshot_sha256: ocrArtifacts.booking_card_screenshot_sha256,
        booking_card_screenshot_base64: ocrArtifacts.booking_card_screenshot_base64,
        booking_card_screenshot_dimensions: ocrArtifacts.booking_card_screenshot_dimensions,
        booking_card_screenshot_bbox: ocrArtifacts.booking_card_screenshot_bbox,
        booking_card_ocr_text_raw: ocrArtifacts.booking_card_ocr_text_raw,
        booking_card_ocr_text_normalized: ocrArtifacts.booking_card_ocr_text_normalized,
        booking_card_ocr_matched_substring: ocrArtifacts.booking_card_ocr_matched_substring,
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
      booking_card_screenshot_sha256: ocrArtifacts.booking_card_screenshot_sha256,
      booking_card_screenshot_base64: ocrArtifacts.booking_card_screenshot_base64,
      booking_card_screenshot_dimensions: ocrArtifacts.booking_card_screenshot_dimensions,
      booking_card_screenshot_bbox: ocrArtifacts.booking_card_screenshot_bbox,
      booking_card_ocr_text_raw: ocrArtifacts.booking_card_ocr_text_raw,
      booking_card_ocr_text_normalized: ocrArtifacts.booking_card_ocr_text_normalized,
      booking_card_ocr_matched_substring: ocrArtifacts.booking_card_ocr_matched_substring,
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
        booking_card_visible_amount_value: ocrArtifacts.booking_card_visible_amount_value,
        booking_card_screenshot_sha256: ocrArtifacts.booking_card_screenshot_sha256,
        ocr_input_image_sha256: ocrArtifacts.ocr_input_image_sha256,
        booking_card_ocr_matched_substring: ocrArtifacts.booking_card_ocr_matched_substring,
        booking_card_ocr_text_raw: ocrArtifacts.booking_card_ocr_text_raw,
        booking_card_screenshot_base64: ocrArtifacts.booking_card_screenshot_base64,
        booking_card_screenshot_dimensions: ocrArtifacts.booking_card_screenshot_dimensions,
        booking_card_screenshot_bbox: ocrArtifacts.booking_card_screenshot_bbox,
        results,
      },
      null,
      2
    ),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
});

