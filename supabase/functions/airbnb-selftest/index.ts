import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-selftest-secret',
};

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

// Normalize amount (locale-safe)
function normalizeAmount(raw: string): number | null {
  const s = (raw || '').trim();
  if (!s) return null;

  const cleaned = s.replace(/[^0-9.,]/g, '');
  if (!cleaned) return null;

  const hasDot = cleaned.includes('.');
  const hasComma = cleaned.includes(',');

  let normalized = cleaned;

  if (hasDot && hasComma) {
    const lastDot = cleaned.lastIndexOf('.');
    const lastComma = cleaned.lastIndexOf(',');

    if (lastComma > lastDot) {
      normalized = cleaned.replace(/\./g, '').replace(/,/g, '.');
    } else {
      normalized = cleaned.replace(/,/g, '');
    }
  } else if (hasComma && !hasDot) {
    if (/,[0-9]{1,2}$/.test(cleaned)) normalized = cleaned.replace(/,/g, '.');
    else normalized = cleaned.replace(/,/g, '');
  } else {
    normalized = cleaned.replace(/,(?=\d{3}(?:\D|$))/g, '');
  }

  const n = Number.parseFloat(normalized);
  return Number.isFinite(n) ? n : null;
}

type CandidateType = 'total_final' | 'subtotal_nights' | 'taxes_only' | 'nightly_rate' | 'unknown';

// Extract price candidates with strict classification
function extractPriceCandidates(content: string, nights: number): Array<{
  amount: number;
  currency: string;
  candidateType: CandidateType;
  includesTaxesFees: boolean;
  context: string;
  rejectedReason?: string;
  rawMatchedString: string;
}> {
  const moneyPatterns: Array<{ currency: string; re: RegExp }> = [
    { currency: 'USD', re: /(\$\s*[\d,.]+(?:\.\d{2})?)/g },
    { currency: 'EUR', re: /(€\s*[\d,.]+(?:\.\d{2})?)/g },
    { currency: 'GBP', re: /(£\s*[\d,.]+(?:\.\d{2})?)/g },
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

      const start = Math.max(0, index - 150);
      const end = Math.min(content.length, index + rawMatch.length + 150);
      const context = content.slice(start, end);
      const ctxLower = context.toLowerCase();

      let candidateType: CandidateType = 'unknown';
      let rejectedReason: string | undefined;

      // Rule A: Detect nightly rate
      const hasNightlyRate = /\bper\s+night\b|\/night|\bnightly\b|\bnight\s+rate\b/i.test(context);
      if (hasNightlyRate) {
        candidateType = 'nightly_rate';
        rejectedReason = 'nightly_price_only';
      }

      // Rule B: Detect subtotal (nights × amount or amount for X nights)
      const hasMultiplicationPattern = /\d+\s*nights?\s*[×x]\s*[\$€£]|[\$€£][\d,.]+\s*[×x]\s*\d+\s*nights?/i.test(context);
      const hasForNightsPattern = /\bfor\s+\d+\s+nights?\b/i.test(context);
      const hasNightsTimesPattern = /\d+\s+nights?\s+at\b/i.test(context);
      
      if (!rejectedReason && (hasMultiplicationPattern || hasForNightsPattern || hasNightsTimesPattern)) {
        candidateType = 'subtotal_nights';
        rejectedReason = 'subtotal_nights_only';
      }

      // Rule C: Detect taxes line
      const hasTaxesOnlyPattern = /\btaxes?\s*[\$€£]|^taxes?\s*$/i.test(context) && 
                                   !/\btotal\b/i.test(context);
      if (!rejectedReason && hasTaxesOnlyPattern) {
        candidateType = 'taxes_only';
        rejectedReason = 'taxes_line_only';
      }

      // Rule D: Detect explicit TOTAL
      const hasExplicitTotal = /\b(total\s*\([A-Z]{3}\)|total\s+USD|total\s+EUR|total\s+GBP|trip\s+total|grand\s+total|you\s+pay)\b/i.test(context);
      const hasGenericTotal = /\btotal\b/i.test(context) && !hasForNightsPattern;
      const hasTotalBeforeTaxes = /\btotal\s+before\s+taxes\b/i.test(context);

      if (!rejectedReason && (hasExplicitTotal || (hasGenericTotal && !hasTotalBeforeTaxes))) {
        candidateType = 'total_final';
      }

      // Taxes included detection
      const hasTaxesFeesIncluded = /\b(includes?\s+taxes|incl\.?\s+taxes|taxes\s+and\s+fees\s+included|including\s+taxes)\b/i.test(context);
      const hasTaxesLineNearby = /\btaxes?\s*[\$€£]\s*[\d,.]+/i.test(context);
      const includesTaxesFees = hasTaxesFeesIncluded || (hasExplicitTotal && hasTaxesLineNearby) || (hasGenericTotal && hasTaxesLineNearby);

      // Ignore terms
      const ignoreTerms = ['from ', 'starting at', 'save ', 'discount', 'was ', 'original', 'compare at'];
      const ignoreHit = ignoreTerms.find((t) => ctxLower.includes(t));
      if (!rejectedReason && ignoreHit) {
        candidateType = 'unknown';
        rejectedReason = `ignored_term:${ignoreHit}`;
      }

      // If not explicitly classified as total_final, reject it
      if (candidateType !== 'total_final' && !rejectedReason) {
        rejectedReason = 'no_explicit_total_label';
      }

      candidates.push({
        amount,
        currency,
        candidateType,
        includesTaxesFees: candidateType === 'total_final' ? includesTaxesFees : false,
        context: safeSnippet(context, 200),
        rejectedReason,
        rawMatchedString: rawMatch,
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // Auth: require service role key OR bypass secret
  const authHeader = req.headers.get('authorization');
  const bypassSecret = req.headers.get('x-selftest-secret');
  const expectedBypass = Deno.env.get('BYPASS_PASSWORD');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  const isServiceRole = authHeader === `Bearer ${serviceRoleKey}`;
  const isBypass = bypassSecret && expectedBypass && bypassSecret === expectedBypass;

  if (!isServiceRole && !isBypass) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized. Provide service role key or x-selftest-secret header.' }),
      { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabase = createClient(supabaseUrl, serviceRoleKey!);

  // Fixed test URL
  const testUrl = 'https://www.airbnb.com/rooms/16720582?check_in=2026-01-04&check_out=2026-01-08&guests=2';
  const nights = 4;
  const runId = crypto.randomUUID();

  console.log(`[Selftest] Starting Browserless test on: ${testUrl}`);
  console.log(`[Selftest] Run ID: ${runId}`);

  const apiKey = Deno.env.get('BROWSERLESS_API_KEY');
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: 'No BROWSERLESS_API_KEY configured' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const start = Date.now();
  
  try {
    const browserlessFnUrl = `https://chrome.browserless.io/function?token=${apiKey}`;

    const functionPayload = {
      code: `
        export default async function({ page, context }) {
          const url = context.url;
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const clickLog = [];

          clickLog.push('STEP1: Loading page');
          await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
          await sleep(4000);
          
          const hasBookingCard = await page.$('[data-section-id="BOOK_IT_SIDEBAR"]') || 
                                  await page.$('[data-testid="book-it-default"]') ||
                                  await page.$('div[class*="book"]');
          clickLog.push('Booking card found: ' + !!hasBookingCard);
          
          let breakdownOpened = false;
          let totalRowFound = false;
          
          // STRATEGY A: Click explicit "Price breakdown" or "Show price details" link
          clickLog.push('STEP2A: Looking for Price breakdown link');
          try {
            const allLinks = await page.$$('a, button, span, div[role="button"]');
            for (const el of allLinks) {
              const text = await el.textContent().catch(() => '');
              const textLower = (text || '').toLowerCase().trim();
              if (textLower.includes('price breakdown') || 
                  textLower.includes('show price details') ||
                  textLower.includes('price details')) {
                clickLog.push('Found breakdown link: ' + textLower.slice(0, 40));
                await el.click({ delay: 100 });
                await sleep(2500);
                breakdownOpened = true;
                break;
              }
            }
          } catch (e) {
            clickLog.push('Strategy A error: ' + e.message);
          }
          
          if (breakdownOpened) {
            const htmlAfterA = await page.content();
            totalRowFound = /Total\\s*(USD|EUR|GBP|\\(USD\\))?[\\s:]*[\\$€£][\\d,.]+/i.test(htmlAfterA) ||
                            /trip\\s+total/i.test(htmlAfterA);
            clickLog.push('Strategy A Total found: ' + totalRowFound);
          }
          
          // STRATEGY B: Click the "$X for Y nights" price line
          if (!totalRowFound) {
            clickLog.push('STEP2B: Looking for price line to click');
            try {
              const ariaElements = await page.$$('[aria-label]');
              for (const el of ariaElements) {
                const aria = await el.getAttribute('aria-label');
                if (aria && /\\$[\\d,]+.*for.*\\d+.*night/i.test(aria)) {
                  clickLog.push('Clicking aria-label: ' + aria.slice(0, 50));
                  await el.click({ delay: 100 });
                  await sleep(2500);
                  breakdownOpened = true;
                  break;
                }
              }
              
              if (!breakdownOpened) {
                const priceElements = await page.$$('span, button, div');
                for (const el of priceElements) {
                  const text = await el.textContent().catch(() => '');
                  if (text && /\\$[\\d,]+\\s+(for|×)\\s+\\d+\\s+night/i.test(text)) {
                    clickLog.push('Clicking price text: ' + text.slice(0, 50));
                    await el.click({ delay: 100 });
                    await sleep(2500);
                    breakdownOpened = true;
                    break;
                  }
                }
              }
            } catch (e) {
              clickLog.push('Strategy B error: ' + e.message);
            }
            
            if (breakdownOpened) {
              const htmlAfterB = await page.content();
              totalRowFound = /Total\\s*(USD|EUR|GBP|\\(USD\\))?[\\s:]*[\\$€£][\\d,.]+/i.test(htmlAfterB) ||
                              /trip\\s+total/i.test(htmlAfterB);
              clickLog.push('Strategy B Total found: ' + totalRowFound);
            }
          }

          await sleep(1000);
          
          let breakdownContainerHtml = '';
          let fullHtml = await page.content();
          
          if (totalRowFound) {
            clickLog.push('STEP3: Extracting breakdown container');
            try {
              const containerSelectors = [
                '[data-testid="price-item-breakdown"]',
                '[aria-label*="Price breakdown"]',
                '[class*="price-breakdown"]',
                'div[role="dialog"]',
                'section[aria-label*="price"]',
              ];
              
              for (const sel of containerSelectors) {
                try {
                  const container = await page.$(sel);
                  if (container) {
                    breakdownContainerHtml = await container.innerHTML();
                    if (breakdownContainerHtml && breakdownContainerHtml.length > 100) {
                      clickLog.push('Found container: ' + sel + ' (len=' + breakdownContainerHtml.length + ')');
                      break;
                    }
                  }
                } catch (e) {}
              }
              
              if (!breakdownContainerHtml) {
                const allSections = await page.$$('div, section');
                for (const section of allSections) {
                  const html = await section.innerHTML().catch(() => '');
                  if (html && 
                      /\\d+\\s*nights?/i.test(html) && 
                      /Total\\s*(USD|EUR|GBP)?/i.test(html) &&
                      html.length < 10000) {
                    breakdownContainerHtml = html;
                    clickLog.push('Found breakdown section by content (len=' + html.length + ')');
                    break;
                  }
                }
              }
            } catch (e) {
              clickLog.push('Container extraction error: ' + e.message);
            }
          }
          
          const contentToReturn = breakdownContainerHtml || fullHtml;
          clickLog.push('Final: breakdownOpened=' + breakdownOpened + ', totalRowFound=' + totalRowFound + ', containerLen=' + breakdownContainerHtml.length);

          return { 
            html: contentToReturn,
            fullHtml: fullHtml,
            breakdownContainerHtml: breakdownContainerHtml,
            breakdownOpened: breakdownOpened,
            totalRowFound: totalRowFound,
            clickLog: clickLog.join(' | ')
          };
        }
      `,
      context: { url: testUrl },
    };

    const resp = await fetchWithTimeout(
      browserlessFnUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(functionPayload),
      },
      70000
    );

    const durationMs = Date.now() - start;

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      const result = {
        run_id: runId,
        provider: 'browserless',
        status: 'provider_fetch_failed',
        extracted_price: null,
        currency: null,
        includes_taxes_fees: false,
        evidence_snippet: `HTTP ${resp.status}: ${errText.slice(0, 200)}`,
        click_log: 'Request failed',
        candidates_summary: [],
        duration_ms: durationMs,
      };
      
      await supabase.from('airbnb_baseline_debug').insert({
        run_id: runId,
        run_number: 1,
        provider: 'browserless',
        provider_order: 1,
        status: 'provider_fetch_failed',
        duration_ms: durationMs,
        extracted_price: null,
        currency: null,
        includes_taxes_fees: false,
        evidence_snippet: result.evidence_snippet,
        candidates_summary: [],
        click_log: 'Request failed',
        airbnb_url: testUrl,
        check_in_date: '2026-01-04',
        check_out_date: '2026-01-08',
        nights_count: 4,
      });

      return new Response(JSON.stringify(result), { 
        status: 200, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      });
    }

    const fnJson = await resp.json().catch(() => null);
    const html = fnJson?.html || '';
    const breakdownContainerHtml = fnJson?.breakdownContainerHtml || '';
    const totalRowFound = fnJson?.totalRowFound || false;
    const clickLog = fnJson?.clickLog || 'no click log';

    console.log(`[Selftest] Click log: ${clickLog}`);
    console.log(`[Selftest] HTML length: ${html.length}, breakdown container: ${breakdownContainerHtml.length}`);
    console.log(`[Selftest] Total row found: ${totalRowFound}`);

    // Check for bot
    const botPatterns = [
      /please\s+complete\s+the\s+captcha/i,
      /verify\s+you['']?re\s+human/i,
      /checking\s+your\s+browser/i,
    ];
    const isBlocked = botPatterns.some(p => p.test(html));
    
    if (isBlocked) {
      const result = {
        run_id: runId,
        provider: 'browserless',
        status: 'airbnb_blocked_or_captcha',
        extracted_price: null,
        currency: null,
        includes_taxes_fees: false,
        evidence_snippet: safeSnippet(html, 300),
        click_log: clickLog,
        candidates_summary: [],
        duration_ms: durationMs,
      };
      
      await supabase.from('airbnb_baseline_debug').insert({
        run_id: runId,
        run_number: 1,
        provider: 'browserless',
        provider_order: 1,
        status: 'airbnb_blocked_or_captcha',
        duration_ms: durationMs,
        evidence_snippet: result.evidence_snippet,
        click_log: clickLog,
        candidates_summary: [],
        airbnb_url: testUrl,
        check_in_date: '2026-01-04',
        check_out_date: '2026-01-08',
        nights_count: 4,
      });

      return new Response(JSON.stringify(result), { 
        status: 200, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      });
    }

    // If Total row was not found, fail
    if (!totalRowFound) {
      const result = {
        run_id: runId,
        provider: 'browserless',
        status: 'price_not_available_in_content',
        extracted_price: null,
        currency: null,
        includes_taxes_fees: false,
        evidence_snippet: `Total row not found after both strategies. Click log: ${clickLog}`,
        click_log: clickLog,
        raw_matched_string: null,
        candidates_summary: [],
        duration_ms: durationMs,
      };
      
      await supabase.from('airbnb_baseline_debug').insert({
        run_id: runId,
        run_number: 1,
        provider: 'browserless',
        provider_order: 1,
        status: 'price_not_available_in_content',
        duration_ms: durationMs,
        evidence_snippet: result.evidence_snippet,
        click_log: clickLog,
        candidates_summary: [],
        airbnb_url: testUrl,
        check_in_date: '2026-01-04',
        check_out_date: '2026-01-08',
        nights_count: 4,
      });

      return new Response(JSON.stringify(result), { 
        status: 200, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      });
    }

    // Extract candidates
    const extractionContent = breakdownContainerHtml.length > 100 ? breakdownContainerHtml : html;
    const candidates = extractPriceCandidates(extractionContent, nights);
    
    console.log(`[Selftest] Found ${candidates.length} candidates`);
    candidates.slice(0, 8).forEach((c, i) => {
      console.log(`  Candidate ${i+1}: $${c.amount} type=${c.candidateType} rejected=${c.rejectedReason || 'no'}`);
    });
    
    // STRICT SELECTION
    const totalFinalCandidates = candidates.filter(c => c.candidateType === 'total_final' && !c.rejectedReason);
    console.log(`[Selftest] total_final candidates: ${totalFinalCandidates.length}`);
    
    const sorted = totalFinalCandidates.sort((a, b) => {
      if (a.includesTaxesFees && !b.includesTaxesFees) return -1;
      if (!a.includesTaxesFees && b.includesTaxesFees) return 1;
      return b.amount - a.amount;
    });

    const selected = sorted[0];

    // FINAL GUARDRAIL OVERRIDE
    if (selected) {
      const evidenceContext = selected.context || '';
      const subtotalPatterns = [
        /for\s+\d+\s+nights?/i,
        /\d+\s+nights?\s*[×x]/i,
        /nights?\s*[×x]\s*\$/i,
        /per\s+night/i,
      ];
      
      const hasSubtotalPattern = subtotalPatterns.some(p => p.test(evidenceContext));
      
      if (hasSubtotalPattern) {
        console.log(`[Selftest] GUARDRAIL: Evidence contains subtotal pattern`);
        const result = {
          run_id: runId,
          provider: 'browserless',
          status: 'price_not_available_in_content',
          extracted_price: null,
          currency: null,
          includes_taxes_fees: false,
          evidence_snippet: `GUARDRAIL: Evidence contains subtotal pattern. Context: ${evidenceContext.slice(0, 200)}`,
          click_log: clickLog,
          raw_matched_string: selected.rawMatchedString,
          candidates_summary: candidates.slice(0, 10).map(c => ({
            amount: c.amount,
            currency: c.currency,
            candidate_type: c.candidateType,
            rejected_reason: c.rejectedReason || 'guardrail_subtotal_in_evidence',
            raw_matched_string: c.rawMatchedString,
          })),
          duration_ms: durationMs,
        };
        
        await supabase.from('airbnb_baseline_debug').insert({
          run_id: runId,
          run_number: 1,
          provider: 'browserless',
          provider_order: 1,
          status: 'price_not_available_in_content',
          duration_ms: durationMs,
          evidence_snippet: result.evidence_snippet,
          click_log: clickLog,
          raw_matched_string: selected.rawMatchedString,
          candidates_summary: result.candidates_summary,
          airbnb_url: testUrl,
          check_in_date: '2026-01-04',
          check_out_date: '2026-01-08',
          nights_count: 4,
        });

        return new Response(JSON.stringify(result), { 
          status: 200, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        });
      }
    }

    // Build final result
    const finalStatus = selected ? 'total_price_including_taxes_and_fees' : 'price_not_available_in_content';
    const evidenceSnippet = selected?.context || `No total_final candidate found. Click: ${clickLog}`;

    const result = {
      run_id: runId,
      provider: 'browserless',
      status: finalStatus,
      extracted_price: selected?.amount || null,
      currency: selected?.currency || null,
      includes_taxes_fees: selected?.includesTaxesFees || false,
      evidence_snippet: evidenceSnippet,
      click_log: clickLog,
      raw_matched_string: selected?.rawMatchedString || null,
      candidates_summary: candidates.slice(0, 10).map(c => ({
        amount: c.amount,
        currency: c.currency,
        candidate_type: c.candidateType,
        rejected_reason: c.rejectedReason,
        raw_matched_string: c.rawMatchedString,
      })),
      duration_ms: durationMs,
    };

    // Persist
    await supabase.from('airbnb_baseline_debug').insert({
      run_id: runId,
      run_number: 1,
      provider: 'browserless',
      provider_order: 1,
      status: finalStatus,
      duration_ms: durationMs,
      extracted_price: selected?.amount || null,
      currency: selected?.currency || null,
      includes_taxes_fees: selected?.includesTaxesFees || false,
      evidence_snippet: evidenceSnippet.slice(0, 2000),
      click_log: clickLog,
      raw_matched_string: selected?.rawMatchedString || null,
      candidates_summary: result.candidates_summary,
      airbnb_url: testUrl,
      check_in_date: '2026-01-04',
      check_out_date: '2026-01-08',
      nights_count: 4,
    });

    console.log(`[Selftest] Result persisted with run_id: ${runId}`);

    return new Response(JSON.stringify(result), { 
      status: 200, 
      headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    });

  } catch (e) {
    console.error('[Selftest] Error:', e);
    return new Response(
      JSON.stringify({ error: String(e), run_id: runId }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});