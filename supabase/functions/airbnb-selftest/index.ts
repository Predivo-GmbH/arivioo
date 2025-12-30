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

function extractPriceCandidates(content: string): Array<{
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

      const hasNightlyRate = /\bper\s+night\b|\/night|\bnightly\b|\bnight\s+rate\b/i.test(context);
      if (hasNightlyRate) {
        candidateType = 'nightly_rate';
        rejectedReason = 'nightly_price_only';
      }

      const hasMultiplicationPattern = /\d+\s*nights?\s*[×x]\s*[\$€£]|[\$€£][\d,.]+\s*[×x]\s*\d+\s*nights?/i.test(context);
      const hasForNightsPattern = /\bfor\s+\d+\s+nights?\b/i.test(context);
      const hasNightsTimesPattern = /\d+\s+nights?\s+at\b/i.test(context);
      
      if (!rejectedReason && (hasMultiplicationPattern || hasForNightsPattern || hasNightsTimesPattern)) {
        candidateType = 'subtotal_nights';
        rejectedReason = 'subtotal_nights_only';
      }

      const hasTaxesOnlyPattern = /\btaxes?\s*[\$€£]|^taxes?\s*$/i.test(context) && !/\btotal\b/i.test(context);
      if (!rejectedReason && hasTaxesOnlyPattern) {
        candidateType = 'taxes_only';
        rejectedReason = 'taxes_line_only';
      }

      // POLICY/FEE REJECTION - must come before total classification
      const policyFeePatterns = [
        /\bpet\s+(policy|fee)/i,
        /\bfee\s+charged\b/i,
        /\btransaction\s+(charge|fee|amount)/i,
        /\bdeposit\b/i,
        /\bcleaning\s+(fee|cost)/i,
        /\bsurcharge\b/i,
        /\bpenalty\b/i,
        /\b(cancellation|refund)\s+policy/i,
        /\bif.*pet.*brought/i,
        /\bprofessional\s+.*cleaning\s+cost/i,
      ];
      const isPolicyFee = policyFeePatterns.some(p => p.test(context));
      if (!rejectedReason && isPolicyFee) {
        candidateType = 'unknown';
        rejectedReason = 'policy_or_fee_context';
      }

      const hasExplicitTotal = /\b(total\s*\([A-Z]{3}\)|total\s+USD|total\s+EUR|total\s+GBP|trip\s+total|grand\s+total|you\s+pay)\b/i.test(context);
      const hasGenericTotal = /\btotal\b/i.test(context) && !hasForNightsPattern;

      // Only mark as total_final if NOT already rejected and has explicit total label
      if (!rejectedReason && (hasExplicitTotal || hasGenericTotal)) {
        candidateType = 'total_final';
      }

      const hasTaxesFeesIncluded = /\b(includes?\s+taxes|incl\.?\s+taxes|taxes\s+and\s+fees\s+included|including\s+taxes)\b/i.test(context);
      const hasTaxesLineNearby = /\btaxes?\s*[\$€£]\s*[\d,.]+/i.test(context);
      const includesTaxesFees = hasTaxesFeesIncluded || (hasExplicitTotal && hasTaxesLineNearby) || (hasGenericTotal && hasTaxesLineNearby);

      const ignoreTerms = ['from ', 'starting at', 'save ', 'discount', 'was ', 'original', 'compare at'];
      const ignoreHit = ignoreTerms.find((t) => ctxLower.includes(t));
      if (!rejectedReason && ignoreHit) {
        candidateType = 'unknown';
        rejectedReason = `ignored_term:${ignoreHit}`;
      }

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

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = 60000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

// Apply final guardrail - blocks subtotals AND policy fees
function applyGuardrail(selected: any): { blocked: boolean; reason?: string } {
  if (!selected) return { blocked: false };
  const evidenceContext = selected.context || '';
  
  // Block subtotal patterns
  const subtotalPatterns = [
    /for\s+\d+\s+nights?/i,
    /\d+\s+nights?\s*[×x]/i,
    /nights?\s*[×x]\s*\$/i,
    /per\s+night/i,
  ];
  const hasSubtotalPattern = subtotalPatterns.some(p => p.test(evidenceContext));
  if (hasSubtotalPattern) {
    return { blocked: true, reason: 'GUARDRAIL: Evidence contains subtotal pattern' };
  }
  
  // Block policy/fee patterns
  const policyFeePatterns = [
    /\bpet\s*(policy|fee)/i,
    /\bfee\s+charged\b/i,
    /\btransaction\s+(charge|fee|amount)/i,
    /\bif.*pet.*brought/i,
    /\bprofessional\s+.*cleaning\b/i,
    /\bsurcharge\b/i,
    /\bdeposit\b/i,
    /\bpenalty\b/i,
  ];
  const hasPolicyFeePattern = policyFeePatterns.some(p => p.test(evidenceContext));
  if (hasPolicyFeePattern) {
    return { blocked: true, reason: 'GUARDRAIL: Evidence contains policy/fee context, not booking total' };
  }
  
  return { blocked: false };
}

// ============ PROVIDER FUNCTIONS ============

async function runFirecrawl(url: string, runId: string): Promise<any> {
  const apiKey = Deno.env.get('FIRECRAWL_API_KEY_1') || Deno.env.get('FIRECRAWL_API_KEY');
  if (!apiKey) {
    return { status: 'provider_not_configured', error: 'No FIRECRAWL_API_KEY configured' };
  }

  const start = Date.now();
  try {
    const resp = await fetchWithTimeout('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url,
        formats: ['html'],
        onlyMainContent: false,
        waitFor: 3000,
      }),
    }, 45000);

    const durationMs = Date.now() - start;
    const data = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      // Check if Firecrawl explicitly blocks Airbnb (enterprise policy)
      const errorMsg = data.error || '';
      if (/not.*currently\s+supported|enterprise/i.test(errorMsg)) {
        return {
          status: 'provider_not_supported_for_airbnb',
          durationMs,
          page_title: null,
          final_url: url,
          body_snippet: safeSnippet(JSON.stringify(data), 300),
          error: errorMsg,
          evidence_snippet: `Firecrawl explicitly blocks Airbnb: ${errorMsg}`,
        };
      }
      return {
        status: 'provider_fetch_failed',
        durationMs,
        page_title: null,
        final_url: url,
        body_snippet: safeSnippet(JSON.stringify(data), 300),
        error: `HTTP ${resp.status}`,
      };
    }

    const html = data.data?.html || data.html || '';
    const metadata = data.data?.metadata || data.metadata || {};
    const pageTitle = metadata.title || 'unknown';
    const finalUrl = metadata.sourceURL || url;

    // Check for block/404
    if (/404|not found|page doesn't exist/i.test(pageTitle) || resp.status === 404) {
      return {
        status: 'listing_not_found_404',
        durationMs,
        page_title: pageTitle,
        final_url: finalUrl,
        body_snippet: safeSnippet(html, 300),
      };
    }

    // Sanitize for bot detection (strip tags to avoid false positives from class names)
    const textOnly = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                         .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                         .replace(/<[^>]+>/g, ' ');
    const botPatterns = [
      /please\s+complete.*captcha/i,
      /verify\s+you.*human/i,
      /checking\s+your\s+browser/i,
      /access\s+denied/i,
    ];
    if (botPatterns.some(p => p.test(textOnly))) {
      return {
        status: 'airbnb_blocked_or_captcha',
        durationMs,
        page_title: pageTitle,
        final_url: finalUrl,
        body_snippet: safeSnippet(textOnly, 300),
      };
    }

    const candidates = extractPriceCandidates(html);
    const totalFinal = candidates.filter(c => c.candidateType === 'total_final' && !c.rejectedReason);
    const selected = totalFinal.sort((a, b) => b.amount - a.amount)[0];

    const guardrail = applyGuardrail(selected);
    if (guardrail.blocked) {
      return {
        status: 'price_not_available_in_content',
        durationMs,
        page_title: pageTitle,
        final_url: finalUrl,
        body_snippet: safeSnippet(html, 300),
        evidence_snippet: `${guardrail.reason}. Context: ${selected?.context?.slice(0, 200)}`,
        candidates: candidates.slice(0, 5),
        raw_matched_string: selected?.rawMatchedString,
      };
    }

    if (!selected) {
      return {
        status: 'price_not_available_in_content',
        durationMs,
        page_title: pageTitle,
        final_url: finalUrl,
        body_snippet: safeSnippet(html, 300),
        evidence_snippet: 'No total_final candidate found',
        candidates: candidates.slice(0, 5),
      };
    }

    return {
      status: 'total_price_including_taxes_and_fees',
      durationMs,
      page_title: pageTitle,
      final_url: finalUrl,
      extracted_price: selected.amount,
      currency: selected.currency,
      includes_taxes_fees: selected.includesTaxesFees,
      raw_matched_string: selected.rawMatchedString,
      evidence_snippet: selected.context,
      candidates: candidates.slice(0, 5),
    };
  } catch (e) {
    return { status: 'provider_error', error: String(e), durationMs: Date.now() - start };
  }
}

async function runZyte(url: string, runId: string): Promise<any> {
  const apiKey = Deno.env.get('ZYTE_API_KEY');
  if (!apiKey) {
    return { status: 'provider_not_configured', error: 'No ZYTE_API_KEY' };
  }

  const start = Date.now();
  try {
    const resp = await fetchWithTimeout('https://api.zyte.com/v1/extract', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${btoa(apiKey + ':')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url,
        browserHtml: true,
        javascript: true,
      }),
    }, 60000);

    const durationMs = Date.now() - start;
    const data = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      return {
        status: 'provider_fetch_failed',
        durationMs,
        page_title: null,
        final_url: url,
        body_snippet: safeSnippet(JSON.stringify(data), 300),
        error: `HTTP ${resp.status}`,
      };
    }

    const html = data.browserHtml || '';
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const pageTitle = titleMatch ? titleMatch[1].trim() : 'unknown';
    const finalUrl = data.url || url;

    if (/404|not found|page doesn't exist/i.test(pageTitle)) {
      return {
        status: 'listing_not_found_404',
        durationMs,
        page_title: pageTitle,
        final_url: finalUrl,
        body_snippet: safeSnippet(html, 300),
      };
    }

    // Sanitize for bot detection (strip tags to avoid false positives from class names)
    const textOnly = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                         .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                         .replace(/<[^>]+>/g, ' ');
    const botPatterns = [
      /please\s+complete.*captcha/i,
      /verify\s+you.*human/i,
      /checking\s+your\s+browser/i,
      /access\s+denied/i,
    ];
    if (botPatterns.some(p => p.test(textOnly))) {
      return {
        status: 'airbnb_blocked_or_captcha',
        durationMs,
        page_title: pageTitle,
        final_url: finalUrl,
        body_snippet: safeSnippet(textOnly, 300),
      };
    }

    const candidates = extractPriceCandidates(html);
    const totalFinal = candidates.filter(c => c.candidateType === 'total_final' && !c.rejectedReason);
    const selected = totalFinal.sort((a, b) => b.amount - a.amount)[0];

    const guardrail = applyGuardrail(selected);
    if (guardrail.blocked) {
      return {
        status: 'price_not_available_in_content',
        durationMs,
        page_title: pageTitle,
        final_url: finalUrl,
        body_snippet: safeSnippet(html, 300),
        evidence_snippet: `${guardrail.reason}. Context: ${selected?.context?.slice(0, 200)}`,
        candidates: candidates.slice(0, 5),
        raw_matched_string: selected?.rawMatchedString,
      };
    }

    if (!selected) {
      return {
        status: 'price_not_available_in_content',
        durationMs,
        page_title: pageTitle,
        final_url: finalUrl,
        body_snippet: safeSnippet(html, 300),
        evidence_snippet: 'No total_final candidate found',
        candidates: candidates.slice(0, 5),
      };
    }

    return {
      status: 'total_price_including_taxes_and_fees',
      durationMs,
      page_title: pageTitle,
      final_url: finalUrl,
      extracted_price: selected.amount,
      currency: selected.currency,
      includes_taxes_fees: selected.includesTaxesFees,
      raw_matched_string: selected.rawMatchedString,
      evidence_snippet: selected.context,
      candidates: candidates.slice(0, 5),
    };
  } catch (e) {
    return { status: 'provider_error', error: String(e), durationMs: Date.now() - start };
  }
}

async function runBrowserless(url: string, runId: string): Promise<any> {
  const apiKey = Deno.env.get('BROWSERLESS_API_KEY');
  if (!apiKey) {
    return { status: 'provider_not_configured', error: 'No BROWSERLESS_API_KEY' };
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
          await sleep(5000);
          
          let fullHtml = await page.content();
          const pageTitle = await page.title();
          const finalUrl = page.url();
          clickLog.push('Page title: ' + pageTitle.slice(0, 60));
          clickLog.push('Final URL: ' + finalUrl.slice(0, 80));
          clickLog.push('HTML length: ' + fullHtml.length);
          
          // Quick check for 404
          if (/404|not found|page doesn't exist/i.test(pageTitle)) {
            return { 
              html: fullHtml.slice(0, 5000),
              pageTitle,
              finalUrl,
              is404: true,
              clickLog: clickLog.join(' | ')
            };
          }
          
          // Quick check for captcha/block - use text content only to avoid false positives from CSS class names
          const bodyText = await page.evaluate(() => document.body ? document.body.innerText : '');
          const explicitBlockPatterns = [
            /please\s+complete.*captcha/i,
            /verify\s+you\s+are\s+(human|a\s+human)/i,
            /checking\s+your\s+browser/i,
            /please\s+verify\s+you/i,
            /access\s+denied/i,
            /security\s+check/i,
          ];
          const isActuallyBlocked = explicitBlockPatterns.some(p => p.test(bodyText));
          
          if (isActuallyBlocked) {
            clickLog.push('BLOCKED: Explicit captcha/security check detected in page text');
            return { 
              html: fullHtml.slice(0, 5000),
              pageTitle,
              finalUrl,
              blocked: true,
              clickLog: clickLog.join(' | ')
            };
          }
          
          let breakdownOpened = false;
          let totalRowFound = false;
          
          // Check if Total is already visible
          const initialTotalCheck = /Total\\s*(USD|EUR|GBP|\\(USD\\))?[\\s:]*[\\$€£][\\d,.]+/i.test(fullHtml);
          clickLog.push('Initial Total visible: ' + initialTotalCheck);
          
          if (initialTotalCheck) {
            totalRowFound = true;
          }
          
          // STRATEGY A: Click "Price breakdown" link
          if (!totalRowFound) {
            clickLog.push('STEP2A: Looking for Price breakdown link');
            try {
              const clickedA = await page.evaluate(() => {
                const elements = document.querySelectorAll('a, button, span, div[role="button"]');
                for (const el of elements) {
                  const text = (el.textContent || '').toLowerCase().trim();
                  if (text.includes('price breakdown') || 
                      text.includes('show price details') ||
                      text.includes('price details')) {
                    el.click();
                    return text.slice(0, 40);
                  }
                }
                return null;
              });
              
              if (clickedA) {
                clickLog.push('Clicked: ' + clickedA);
                await sleep(2500);
                breakdownOpened = true;
                fullHtml = await page.content();
                totalRowFound = /Total\\s*(USD|EUR|GBP|\\(USD\\))?[\\s:]*[\\$€£][\\d,.]+/i.test(fullHtml);
                clickLog.push('Strategy A Total found: ' + totalRowFound);
              }
            } catch (e) {
              clickLog.push('Strategy A error: ' + e.message);
            }
          }
          
          // STRATEGY B: Click the "$X for Y nights" price line
          if (!totalRowFound) {
            clickLog.push('STEP2B: Looking for price line to click');
            try {
              const clickedB = await page.evaluate(() => {
                const ariaElements = document.querySelectorAll('[aria-label]');
                for (const el of ariaElements) {
                  const aria = el.getAttribute('aria-label') || '';
                  if (/\\$[\\d,]+.*for.*\\d+.*night/i.test(aria)) {
                    el.click();
                    return 'aria: ' + aria.slice(0, 50);
                  }
                }
                const priceElements = document.querySelectorAll('span, button, div');
                for (const el of priceElements) {
                  const text = el.textContent || '';
                  if (/\\$[\\d,]+\\s+(for|×)\\s+\\d+\\s+night/i.test(text)) {
                    el.click();
                    return 'text: ' + text.slice(0, 50);
                  }
                }
                return null;
              });
              
              if (clickedB) {
                clickLog.push('Clicked: ' + clickedB);
                await sleep(2500);
                breakdownOpened = true;
                fullHtml = await page.content();
                totalRowFound = /Total\\s*(USD|EUR|GBP|\\(USD\\))?[\\s:]*[\\$€£][\\d,.]+/i.test(fullHtml);
                clickLog.push('Strategy B Total found: ' + totalRowFound);
              }
            } catch (e) {
              clickLog.push('Strategy B error: ' + e.message);
            }
          }

          await sleep(1000);
          fullHtml = await page.content();
          
          // Extract breakdown container if available
          let breakdownContainerHtml = '';
          if (totalRowFound) {
            clickLog.push('STEP3: Extracting breakdown container');
            try {
              breakdownContainerHtml = await page.evaluate(() => {
                const selectors = [
                  '[data-testid="price-item-breakdown"]',
                  '[aria-label*="Price breakdown"]',
                  '[class*="price-breakdown"]',
                  'div[role="dialog"]',
                  'section[aria-label*="price"]'
                ];
                
                for (const sel of selectors) {
                  const container = document.querySelector(sel);
                  if (container && container.innerHTML.length > 100) {
                    return container.innerHTML;
                  }
                }
                
                const allSections = document.querySelectorAll('div, section');
                for (const section of allSections) {
                  const html = section.innerHTML || '';
                  if (html.length > 100 && 
                      html.length < 10000 && 
                      /\\d+\\s*nights?/i.test(html) && 
                      /Total\\s*(USD|EUR|GBP)?/i.test(html)) {
                    return html;
                  }
                }
                return '';
              });
              
              if (breakdownContainerHtml) {
                clickLog.push('Container len=' + breakdownContainerHtml.length);
              }
            } catch (e) {
              clickLog.push('Container error: ' + e.message);
            }
          }
          
          clickLog.push('Final: opened=' + breakdownOpened + ', totalFound=' + totalRowFound);

          return { 
            html: breakdownContainerHtml || fullHtml,
            fullHtml: fullHtml,
            pageTitle,
            finalUrl,
            breakdownOpened,
            totalRowFound,
            clickLog: clickLog.join(' | ')
          };
        }
      `,
      context: { url },
    };

    const resp = await fetchWithTimeout(browserlessFnUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(functionPayload),
    }, 70000);

    const durationMs = Date.now() - start;

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      return {
        status: 'provider_fetch_failed',
        durationMs,
        page_title: null,
        final_url: url,
        body_snippet: safeSnippet(errText, 300),
        error: `HTTP ${resp.status}`,
      };
    }

    const fnJson = await resp.json().catch(() => ({}));
    const html = fnJson.html || '';
    const pageTitle = fnJson.pageTitle || 'unknown';
    const finalUrl = fnJson.finalUrl || url;
    const clickLog = fnJson.clickLog || '';
    const totalRowFound = fnJson.totalRowFound || false;

    if (fnJson.is404) {
      return {
        status: 'listing_not_found_404',
        durationMs,
        page_title: pageTitle,
        final_url: finalUrl,
        body_snippet: safeSnippet(html, 300),
        click_log: clickLog,
      };
    }

    if (fnJson.blocked) {
      return {
        status: 'airbnb_blocked_or_captcha',
        durationMs,
        page_title: pageTitle,
        final_url: finalUrl,
        body_snippet: safeSnippet(html, 300),
        click_log: clickLog,
      };
    }

    if (!totalRowFound) {
      return {
        status: 'price_not_available_in_content',
        durationMs,
        page_title: pageTitle,
        final_url: finalUrl,
        body_snippet: safeSnippet(html, 300),
        evidence_snippet: 'Total row not found after both strategies',
        click_log: clickLog,
        candidates: [],
      };
    }

    const candidates = extractPriceCandidates(html);
    const totalFinal = candidates.filter(c => c.candidateType === 'total_final' && !c.rejectedReason);
    const selected = totalFinal.sort((a, b) => b.amount - a.amount)[0];

    const guardrail = applyGuardrail(selected);
    if (guardrail.blocked) {
      return {
        status: 'price_not_available_in_content',
        durationMs,
        page_title: pageTitle,
        final_url: finalUrl,
        body_snippet: safeSnippet(html, 300),
        evidence_snippet: `${guardrail.reason}. Context: ${selected?.context?.slice(0, 200)}`,
        click_log: clickLog,
        candidates: candidates.slice(0, 5),
        raw_matched_string: selected?.rawMatchedString,
      };
    }

    if (!selected) {
      return {
        status: 'price_not_available_in_content',
        durationMs,
        page_title: pageTitle,
        final_url: finalUrl,
        body_snippet: safeSnippet(html, 300),
        evidence_snippet: 'No total_final candidate found',
        click_log: clickLog,
        candidates: candidates.slice(0, 5),
      };
    }

    return {
      status: 'total_price_including_taxes_and_fees',
      durationMs,
      page_title: pageTitle,
      final_url: finalUrl,
      extracted_price: selected.amount,
      currency: selected.currency,
      includes_taxes_fees: selected.includesTaxesFees,
      raw_matched_string: selected.rawMatchedString,
      evidence_snippet: selected.context,
      click_log: clickLog,
      candidates: candidates.slice(0, 5),
    };
  } catch (e) {
    return { status: 'provider_error', error: String(e), durationMs: Date.now() - start };
  }
}

// ============ MAIN HANDLER ============

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    // empty body is OK
  }

  const url = body.url;
  if (!url || typeof url !== 'string' || !url.includes('airbnb.com')) {
    return new Response(
      JSON.stringify({ error: 'URL is required and must be an Airbnb URL' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const providers: string[] = body.providers || ['firecrawl', 'zyte', 'browserless'];
  const runId = crypto.randomUUID();

  console.log(`[Selftest] run_id=${runId} URL=${url}`);
  console.log(`[Selftest] Providers: ${providers.join(', ')}`);

  // Parse dates from URL
  const urlObj = new URL(url);
  const checkIn = urlObj.searchParams.get('check_in') || null;
  const checkOut = urlObj.searchParams.get('check_out') || null;
  const nights = checkIn && checkOut ? Math.round((new Date(checkOut).getTime() - new Date(checkIn).getTime()) / 86400000) : null;

  const results: any[] = [];

  // Run providers sequentially
  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i].toLowerCase();
    const providerOrder = i + 1;

    console.log(`[Selftest] Running provider ${providerOrder}: ${provider}`);

    let result: any;
    if (provider === 'firecrawl') {
      result = await runFirecrawl(url, runId);
    } else if (provider === 'zyte') {
      result = await runZyte(url, runId);
    } else if (provider === 'browserless') {
      result = await runBrowserless(url, runId);
    } else {
      result = { status: 'unknown_provider', error: `Unknown provider: ${provider}` };
    }

    // Persist to DB
    const dbRow = {
      run_id: runId,
      run_number: 1,
      provider,
      provider_order: providerOrder,
      status: result.status,
      duration_ms: result.durationMs || null,
      extracted_price: result.extracted_price || null,
      currency: result.currency || null,
      includes_taxes_fees: result.includes_taxes_fees || false,
      raw_matched_string: result.raw_matched_string || null,
      evidence_snippet: safeSnippet(result.evidence_snippet || result.body_snippet || '', 2000),
      click_log: result.click_log || null,
      candidates_summary: (result.candidates || []).map((c: any) => ({
        amount: c.amount,
        currency: c.currency,
        candidate_type: c.candidateType,
        rejected_reason: c.rejectedReason,
        raw_matched_string: c.rawMatchedString,
      })),
      airbnb_url: url,
      check_in_date: checkIn,
      check_out_date: checkOut,
      nights_count: nights,
    };

    await supabase.from('airbnb_baseline_debug').insert(dbRow);

    results.push({
      run_id: runId,
      provider,
      provider_order: providerOrder,
      status: result.status,
      extracted_price: result.extracted_price || null,
      currency: result.currency || null,
      includes_taxes_fees: result.includes_taxes_fees || false,
      raw_matched_string: result.raw_matched_string || null,
      evidence_snippet: safeSnippet(result.evidence_snippet || '', 500),
      candidates_summary: (result.candidates || []).slice(0, 5).map((c: any) => ({
        amount: c.amount,
        currency: c.currency,
        candidate_type: c.candidateType,
        rejected_reason: c.rejectedReason,
      })),
      click_log: result.click_log || null,
      page_title: result.page_title || null,
      final_url: result.final_url || null,
      duration_ms: result.durationMs || null,
    });

    console.log(`[Selftest] ${provider}: status=${result.status} price=${result.extracted_price}`);
  }

  return new Response(
    JSON.stringify({ run_id: runId, url, providers_run: providers, results }, null, 2),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
});
