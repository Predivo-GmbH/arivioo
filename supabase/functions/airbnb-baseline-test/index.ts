import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { gatedBrowserlessFetch, isFetchRateLimited } from '../_shared/browserlessGate.ts';

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
  | 'price_not_available_in_content'
  | 'dates_unavailable'
  | 'rate_limited';

type ProviderName = 'firecrawl' | 'zyte' | 'browserless';

interface ProviderAttemptResult {
  provider: ProviderName;
  status: AirbnbBaselineStatus | 'provider_fetch_failed' | 'provider_not_supported' | 'airbnb_blocked_or_captcha' | 'dates_unavailable' | 'rate_limited';
  price: number | null;
  currency: string | null;
  includes_taxes_fees: boolean;
  evidence_snippet: string;
  click_log?: string;
  raw_matched_string?: string;
  error?: string;
  duration_ms: number;
  candidates_summary: Array<{
    amount: number;
    currency: string;
    kind: string;
    label_hint: string;
    rejected_reason?: string;
    candidate_type?: string;
    raw_matched_string?: string;
  }>;
  // OCR validation fields
  ocr_reference?: OcrVisualReference | null;
  ocr_validation?: OcrValidationResult | null;
}

// OCR Visual Reference from screenshots
interface OcrVisualReference {
  bookingCardAmount: number | null;
  bookingCardNights: number | null;
  bookingCardSnippet: string | null;
  breakdownTotalAmount: number | null;
  breakdownTotalSnippet: string | null;
  breakdownTaxesAmount: number | null;
  breakdownOpened: boolean;
}

// OCR Validation Result
interface OcrValidationResult {
  status: 'accepted' | 'rejected' | 'no_ocr_data';
  acceptedVia?: string;
  mismatchReason?: string;
  validationNote?: string;
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

// Normalize amount (locale-safe)
function normalizeAmount(raw: string): number | null {
  const s = (raw || '').trim();
  if (!s) return null;

  // Keep only digits and separators
  const cleaned = s.replace(/[^0-9.,]/g, '');
  if (!cleaned) return null;

  const hasDot = cleaned.includes('.');
  const hasComma = cleaned.includes(',');

  let normalized = cleaned;

  // If both separators exist, decide decimal separator by last occurrence
  if (hasDot && hasComma) {
    const lastDot = cleaned.lastIndexOf('.');
    const lastComma = cleaned.lastIndexOf(',');

    if (lastComma > lastDot) {
      // 1.976,20 -> thousands='.' decimal=','
      normalized = cleaned.replace(/\./g, '').replace(/,/g, '.');
    } else {
      // 1,976.20 -> thousands=',' decimal='.'
      normalized = cleaned.replace(/,/g, '');
    }
  } else if (hasComma && !hasDot) {
    // If only comma exists and looks like decimal (two digits), treat as decimal separator
    if (/,[0-9]{1,2}$/.test(cleaned)) normalized = cleaned.replace(/,/g, '.');
    else normalized = cleaned.replace(/,/g, '');
  } else {
    // Only dot or none -> remove thousands commas just in case
    normalized = cleaned.replace(/,(?=\d{3}(?:\D|$))/g, '');
  }

  const n = Number.parseFloat(normalized);
  return Number.isFinite(n) ? n : null;
}

// Candidate classification types
type CandidateType = 
  | 'total_final'           // Explicit "Total USD $X" - the only selectable type
  | 'subtotal_nights'       // "X nights × $Y" or "$Z for X nights" - always reject
  | 'taxes_only'            // "Taxes $X" - always reject
  | 'nightly_rate'          // "per night" - always reject
  | 'unknown';              // No clear classification - reject

// Extract price candidates with strict classification
function extractPriceCandidates(content: string, nights: number): Array<{
  amount: number;
  currency: string;
  kind: AirbnbBaselineStatus;
  includesTaxesFees: boolean;
  labelHint: string;
  context: string;
  rejectedReason?: string;
  candidateType: CandidateType;
  rawMatchedString: string;
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

      // Get context window around the price
      const start = Math.max(0, index - 150);
      const end = Math.min(content.length, index + rawMatch.length + 150);
      const context = content.slice(start, end);
      const ctxLower = context.toLowerCase();

      // ============================================================
      // STEP 1: Classify candidate type using strict rules
      // ============================================================
      let candidateType: CandidateType = 'unknown';
      let rejectedReason: string | undefined;

      // Rule A: Detect nightly rate - ALWAYS REJECT
      const hasNightlyRate = /\bper\s+night\b|\/night|\bnightly\b|\bnight\s+rate\b/i.test(context);
      if (hasNightlyRate) {
        candidateType = 'nightly_rate';
        rejectedReason = 'nightly_price_only';
      }

      // Rule B: Detect subtotal (nights × amount or amount for X nights) - ALWAYS REJECT
      // This is the key fix: "$1,977 for 4 nights" is a SUBTOTAL, not the total
      const hasMultiplicationPattern = /\d+\s*nights?\s*[×x]\s*[\$€£]|[\$€£][\d,.]+\s*[×x]\s*\d+\s*nights?/i.test(context);
      const hasForNightsPattern = /\bfor\s+\d+\s+nights?\b/i.test(context);
      const hasNightsTimesPattern = /\d+\s+nights?\s+at\b/i.test(context);
      
      if (!rejectedReason && (hasMultiplicationPattern || hasForNightsPattern || hasNightsTimesPattern)) {
        candidateType = 'subtotal_nights';
        rejectedReason = 'subtotal_nights_only';
      }

      // Rule C: Detect taxes line - ALWAYS REJECT
      const hasTaxesOnlyPattern = /\btaxes?\s*[\$€£]|^taxes?\s*$/i.test(context) &&
                                   !/\btotal\b/i.test(context);
      if (!rejectedReason && hasTaxesOnlyPattern) {
        candidateType = 'taxes_only';
        rejectedReason = 'taxes_line_only';
      }

      // Rule C2: Reject payment/transaction fee contexts (e.g. "total transaction amount", credit card surcharge)
      // This prevents bogus totals like "Upon booking, $300, plus the c/c fee" from being classified as total_final.
      const hasPaymentFeeContext =
        /\btransaction\b|\bsurcharge\b|\bcredit\s*card\b|\bc\/c\b|\bcard\s+is\s+charged\b|\bdue\s+immediately\b/i.test(context) &&
        /\bfee\b|\bcharged\b|\bsurcharge\b/i.test(context);
      if (!rejectedReason && hasPaymentFeeContext) {
        candidateType = 'unknown';
        rejectedReason = 'fee_or_deposit_not_total';
      }

      // Rule D: Detect explicit TOTAL - the ONLY selectable type
      // Must have "Total" or "Pay $X now" (book/stays checkout page)
      const hasPayNow = /\bPay\s+[\$€£]\s*[\d,]+.*now\b/i.test(context);
      const hasExplicitTotal = /\b(total\s*\([A-Z]{3}\)|total\s+USD|total\s+EUR|total\s+GBP|trip\s+total|grand\s+total|you\s+pay)\b/i.test(context);
      const hasGenericTotal = /\btotal\b/i.test(context) && !hasForNightsPattern;
      const hasTotalBeforeTaxes = /\btotal\s+before\s+taxes\b/i.test(context);

      if (!rejectedReason && (hasPayNow || hasExplicitTotal || (hasGenericTotal && !hasTotalBeforeTaxes))) {
        candidateType = 'total_final';
        // No rejection - this is valid
      }

      // ============================================================
      // STEP 2: Determine if includes taxes/fees
      // ============================================================
      const hasTaxesFeesIncluded = /\b(includes?\s+taxes|incl\.?\s+taxes|taxes\s+and\s+fees\s+included|including\s+taxes)\b/i.test(context);
      const hasTaxesLineNearby = /\btaxes?\s*[\$€£]\s*[\d,.]+/i.test(context);
      
      // If we see "Total" AND "Taxes" as separate line items, the total includes taxes
      const includesTaxesFees = hasTaxesFeesIncluded || 
                                 (hasExplicitTotal && hasTaxesLineNearby) ||
                                 (hasGenericTotal && hasTaxesLineNearby);

      // ============================================================
      // STEP 3: Ignore terms that indicate non-prices
      // ============================================================
      const ignoreTerms = ['from ', 'starting at', 'save ', 'discount', 'was ', 'original', 'compare at'];
      const ignoreHit = ignoreTerms.find((t) => ctxLower.includes(t));
      if (!rejectedReason && ignoreHit) {
        candidateType = 'unknown';
        rejectedReason = `ignored_term:${ignoreHit}`;
      }

      // ============================================================
      // STEP 3B: Reject pet fees, cleaning fees, deposits - CRITICAL
      // ============================================================
      const hasPetFeePattern = /\bpet\b.*\bfee\b|\bfee\b.*\bpet\b|\bpet\s+friendly\b.*\$|\$[\d,.]+\s*fee\s*charged\s*to\s*card/i.test(context);
      const hasCleaningFeePattern = /\bcleaning\s+fee\b/i.test(context);
      const hasDepositPattern = /\bdeposit\b|\bsecurity\b.*\bfee\b/i.test(context);
      const hasDamageFeePattern = /\bdamage\b.*\bfee\b|\bprotection\b.*\bfee\b/i.test(context);
      
      if (!rejectedReason && (hasPetFeePattern || hasCleaningFeePattern || hasDepositPattern || hasDamageFeePattern)) {
        candidateType = 'unknown';
        rejectedReason = 'fee_or_deposit_not_total';
      }

      // ============================================================
      // STEP 4: Final classification and kind assignment
      // ============================================================
      let kind: AirbnbBaselineStatus = 'price_not_available_in_content';

      if (candidateType === 'total_final' && !rejectedReason) {
        kind = includesTaxesFees 
          ? 'total_price_including_taxes_and_fees' 
          : 'total_price_excluding_taxes_and_fees';
      } else if (!rejectedReason) {
        // If not explicitly classified as total_final, reject it
        rejectedReason = 'no_explicit_total_label';
      }

      candidates.push({
        amount,
        currency,
        kind,
        includesTaxesFees: candidateType === 'total_final' ? includesTaxesFees : false,
        labelHint: safeSnippet(context, 100),
        context: safeSnippet(context, 200),
        rejectedReason,
        candidateType,
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

// ========== OCR VISUAL REFERENCE EXTRACTION ==========
// Uses Lovable AI (multimodal) to extract price info from screenshots

async function extractOcrVisualReference(
  bookingCardScreenshot: string | null,
  breakdownScreenshot: string | null,
  breakdownOpened: boolean
): Promise<OcrVisualReference | null> {
  if (!bookingCardScreenshot && !breakdownScreenshot) {
    return null;
  }

  try {
    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) {
      console.log('[OCR] No LOVABLE_API_KEY configured');
      return null;
    }

    const messages: any[] = [];
    const content: any[] = [
      {
        type: 'text',
        text: `Analyze these Airbnb price screenshots and extract the visible price information.

Return a JSON object with these fields (use null if not found):
{
  "bookingCardAmount": <number or null - the total amount shown on the booking card, e.g. "$2,214 for 4 nights" -> 2214>,
  "bookingCardNights": <number or null - number of nights shown>,
  "bookingCardSnippet": <string or null - the exact text showing the price, e.g. "$2,214 for 4 nights">,
  "breakdownTotalAmount": <number or null - the "Total" amount from price breakdown if visible>,
  "breakdownTotalSnippet": <string or null - the exact "Total" line text, e.g. "Total (USD) $2,213.34">,
  "breakdownTaxesAmount": <number or null - taxes/fees amount if shown separately>
}

CRITICAL RULES:
- Extract ONLY prices that are clearly visible in the screenshots
- The booking card amount is typically shown as "$X for Y nights" 
- The breakdown total is typically shown as "Total (USD) $X" or "Total $X"
- Do NOT calculate or infer prices - only extract what you see
- Return valid JSON only, no markdown or explanation`
      }
    ];

    if (bookingCardScreenshot) {
      content.push({
        type: 'image_url',
        image_url: {
          url: `data:image/png;base64,${bookingCardScreenshot}`
        }
      });
    }

    if (breakdownScreenshot) {
      content.push({
        type: 'image_url', 
        image_url: {
          url: `data:image/png;base64,${breakdownScreenshot}`
        }
      });
    }

    messages.push({ role: 'user', content });

    // OCR via AI is not available from edge functions (network restrictions)
    // Instead, extract booking card amount from DOM content using regex
    console.log('[OCR] Using DOM-based extraction fallback');
    
    // Return empty reference - the booking card amount will be extracted from HTML
    return {
      bookingCardAmount: null,
      bookingCardNights: null,
      bookingCardSnippet: null,
      breakdownTotalAmount: null,
      breakdownTotalSnippet: null,
      breakdownTaxesAmount: null,
      breakdownOpened,
    };
  } catch (error) {
    console.error('[OCR] Extraction error:', error);
    return null;
  }
}

// ========== DOM-BASED OCR EXTRACTION ==========
// Extracts booking card amount from HTML content using regex patterns

function extractOcrFromHtml(html: string, nights: number): OcrVisualReference | null {
  try {
    const text = html || '';

    // --------------------
    // Booking card baseline
    // --------------------
    // Airbnb commonly shows a booking-card summary like:
    // - "$2,214 for 4 nights"
    // - "$2,214 total" (sometimes)
    // - "$553 × 4 nights" / "$553 x 4 nights" (rare)
    // We treat this as the "visible baseline" (not necessarily the final trip total).
    const bookingCardCandidates: Array<{ amount: number; nights: number; snippet: string }> = [];

    const bookingCardPatterns: RegExp[] = [
      // "$2,214 for 4 nights"
      /(?:US\$|\$|€|£)\s*([\d][\d.,]*)\s+for\s+(\d+)\s+nights?/gi,
      /\bCHF\s*([\d][\d.,]*)\s+for\s+(\d+)\s+nights?/gi,

      // "$2,214 total" + detect nights elsewhere in the snippet window later (fallback)
      /(?:US\$|\$|€|£)\s*([\d][\d.,]*)\s+total\b/gi,
      /\bCHF\s*([\d][\d.,]*)\s+total\b/gi,

      // "$553 × 4 nights" / "$553 x 4 nights"
      /(?:US\$|\$|€|£)\s*([\d][\d.,]*)\s*[×x]\s*(\d+)\s+nights?/gi,
      /\bCHF\s*([\d][\d.,]*)\s*[×x]\s*(\d+)\s+nights?/gi,

      // "4 nights × $553" / "4 nights x $553"
      /(\d+)\s+nights?\s*[×x]\s*(?:US\$|\$|€|£)\s*([\d][\d.,]*)/gi,
      /(\d+)\s+nights?\s*[×x]\s*CHF\s*([\d][\d.,]*)/gi,
    ];

    for (const re of bookingCardPatterns) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        // Patterns vary in capture groups:
        // - price-first: (amount, nights)
        // - nights-first: (nights, amount)
        const maybeNightsFirst = /^\d+\s+nights?/i.test(m[0]);
        const amountRaw = maybeNightsFirst ? (m[2] ?? '') : (m[1] ?? '');
        const nightsRaw = maybeNightsFirst ? (m[1] ?? '') : (m[2] ?? '');

        const amount = normalizeAmount(amountRaw);
        let n = nightsRaw ? Number.parseInt(nightsRaw, 10) : NaN;

        // For "total"-only patterns (no nights captured), try to infer nights from nearby text
        if (!Number.isFinite(n)) {
          const snippetWindow = text.slice(Math.max(0, m.index - 80), Math.min(text.length, m.index + m[0].length + 80));
          const nMatch = snippetWindow.match(/\b(\d+)\s+nights?\b/i);
          if (nMatch?.[1]) n = Number.parseInt(nMatch[1], 10);
        }

        if (!amount || !Number.isFinite(n)) continue;
        if (amount < 50 || amount > 500000) continue;

        bookingCardCandidates.push({
          amount,
          nights: n,
          snippet: safeSnippet(m[0], 140),
        });
      }
    }

    // Choose best booking card candidate:
    // 1) nights match expected nights
    // 2) otherwise closest nights
    // 3) if tie, highest amount (tends to be the stay subtotal, not a small fee)
    let bookingCardBest: { amount: number; nights: number; snippet: string } | null = null;
    if (bookingCardCandidates.length > 0) {
      const exact = bookingCardCandidates.filter((c) => c.nights === nights);
      const pool = exact.length > 0 ? exact : bookingCardCandidates;
      pool.sort((a, b) => {
        const aDelta = Math.abs(a.nights - nights);
        const bDelta = Math.abs(b.nights - nights);
        if (aDelta !== bDelta) return aDelta - bDelta;
        return b.amount - a.amount;
      });
      bookingCardBest = pool[0] ?? null;
    }

    const bookingCardAmount = bookingCardBest?.amount ?? null;
    const bookingCardNights = bookingCardBest?.nights ?? null;
    const bookingCardSnippet = bookingCardBest?.snippet ?? null;

    if (bookingCardBest) {
      console.log(`[OCR-DOM] Found booking card baseline: ${bookingCardAmount} for ${bookingCardNights} nights`);
    }

// --------------------
    // Breakdown total (also handles book/stays checkout page)
    // --------------------
    // STRICT PATTERNS: Only match explicit Airbnb breakdown totals
    // These patterns MUST include currency code/symbol + "Total" or "Pay" in close proximity
    // Examples: "Total (USD) $2,213.34", "Total USD $2,213", "Pay $2,213.34 now"
    const breakdownTotalCandidates: Array<{ amount: number; snippet: string; priority: number }> = [];

    // Priority 0: "Pay $X now" - book/stays checkout page pattern (highest priority)
    const pattern0 = /\bPay\s+(?:US\$|\$|€|£|CHF)\s*([\d][\d.,]+)\s+now\b/gi;
    let m: RegExpExecArray | null;
    pattern0.lastIndex = 0;
    while ((m = pattern0.exec(text)) !== null) {
      const amount = normalizeAmount(m[1]);
      if (!amount || amount < 100 || amount > 500000) continue;
      breakdownTotalCandidates.push({ amount, snippet: safeSnippet(m[0], 160), priority: 0 });
    }

    // Priority 1: "Total (USD) $X" - the gold standard Airbnb pattern
    const pattern1 = /\bTotal\s*\(\s*(USD|EUR|GBP|CHF)\s*\)\s*(?:US\$|\$|€|£|CHF)?\s*([\d][\d.,]+)/gi;
    pattern1.lastIndex = 0;
    while ((m = pattern1.exec(text)) !== null) {
      const amount = normalizeAmount(m[2]);
      if (!amount || amount < 100 || amount > 500000) continue;
      const snippetWindow = text.slice(Math.max(0, m.index - 30), Math.min(text.length, m.index + m[0].length + 30));
      // Reject if it's "Total before taxes" or has "for X nights"
      if (/before\s+taxes/i.test(snippetWindow) || /for\s+\d+\s+nights?/i.test(snippetWindow)) continue;
      breakdownTotalCandidates.push({ amount, snippet: safeSnippet(m[0], 160), priority: 1 });
    }

    // Priority 2: "Total USD $X" or "Total $X" near currency context
    const pattern2 = /\bTotal\s+(?:USD|EUR|GBP)\s*(?:US\$|\$|€|£)\s*([\d][\d.,]+)/gi;
    pattern2.lastIndex = 0;
    while ((m = pattern2.exec(text)) !== null) {
      const amount = normalizeAmount(m[1]);
      if (!amount || amount < 100 || amount > 500000) continue;
      const snippetWindow = text.slice(Math.max(0, m.index - 30), Math.min(text.length, m.index + m[0].length + 30));
      if (/before\s+taxes/i.test(snippetWindow) || /for\s+\d+\s+nights?/i.test(snippetWindow)) continue;
      breakdownTotalCandidates.push({ amount, snippet: safeSnippet(m[0], 160), priority: 2 });
    }

    // Priority 3: "Total CHF X" (Swiss Franc specific)
    const pattern3 = /\bTotal\s+CHF\s*([\d][\d.,]+)/gi;
    pattern3.lastIndex = 0;
    while ((m = pattern3.exec(text)) !== null) {
      const amount = normalizeAmount(m[1]);
      if (!amount || amount < 100 || amount > 500000) continue;
      const snippetWindow = text.slice(Math.max(0, m.index - 30), Math.min(text.length, m.index + m[0].length + 30));
      if (/before\s+taxes/i.test(snippetWindow) || /for\s+\d+\s+nights?/i.test(snippetWindow)) continue;
      breakdownTotalCandidates.push({ amount, snippet: safeSnippet(m[0], 160), priority: 3 });
    }

    // Select best candidate (highest priority, then highest amount to avoid fees)
    let breakdownTotalAmount: number | null = null;
    let breakdownTotalSnippet: string | null = null;

    if (breakdownTotalCandidates.length > 0) {
      breakdownTotalCandidates.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return b.amount - a.amount; // Higher amount wins (stay total > fees)
      });
      
      const best = breakdownTotalCandidates[0];
      
      // CRITICAL: The breakdown total must be >= booking card amount
      // If booking card shows "$2,214 for 4 nights", breakdown total cannot be $300
      if (bookingCardAmount && best.amount < bookingCardAmount * 0.8) {
        console.log(`[OCR-DOM] Rejecting breakdown total ${best.amount} - below 80% of booking card ${bookingCardAmount}`);
      } else {
        breakdownTotalAmount = best.amount;
        breakdownTotalSnippet = best.snippet;
        console.log(`[OCR-DOM] Found breakdown total: ${breakdownTotalAmount} (priority ${best.priority})`);
      }
    }

    if (!bookingCardAmount && !breakdownTotalAmount) {
      console.log('[OCR-DOM] No booking card baseline or breakdown total found in content');
      return null;
    }

    return {
      bookingCardAmount,
      bookingCardNights,
      bookingCardSnippet,
      breakdownTotalAmount,
      breakdownTotalSnippet,
      breakdownTaxesAmount: null,
      breakdownOpened: !!breakdownTotalAmount,
    };
  } catch (error) {
    console.error('[OCR-DOM] Extraction error:', error);
    return null;
  }
}

// ========== OCR VALIDATION RULES ==========
// Validates provider-extracted price against OCR visual reference

function validateProviderPriceWithOcr(
  providerPrice: number | null,
  ocrReference: OcrVisualReference | null
): OcrValidationResult {
  if (!ocrReference) {
    return { status: 'no_ocr_data' };
  }

  if (!providerPrice) {
    return { status: 'no_ocr_data', validationNote: 'no_provider_price' };
  }

  const breakdownTotal = ocrReference.breakdownTotalAmount;
  const bookingCardAmount = ocrReference.bookingCardAmount;
  const bookingCardNights = ocrReference.bookingCardNights;
  const tolerance = 1; // Allow $1 rounding tolerance

  // Rule A: Breakdown Total has absolute priority (this IS the trip total)
  if (breakdownTotal) {
    const diff = Math.abs(providerPrice - breakdownTotal);
    if (diff <= tolerance) {
      return {
        status: 'accepted',
        acceptedVia: 'breakdown_total_match',
        validationNote: `Provider $${providerPrice} matches OCR breakdown $${breakdownTotal}`
      };
    } else {
      return {
        status: 'rejected',
        mismatchReason: 'provider_price_differs_from_breakdown_total',
        validationNote: `Provider $${providerPrice} differs from OCR breakdown $${breakdownTotal}`
      };
    }
  }

  // Rule B: No breakdown found - booking card is our only reference
  if (bookingCardAmount) {
    // CRITICAL FIX: If bookingCardNights is set, the booking card shows a SUBTOTAL
    // (e.g., "$1977 for 4 nights"), NOT the trip total including taxes/fees.
    // We MUST NOT accept a price that merely equals this subtotal.
    const isSubtotalDisplay = bookingCardNights && bookingCardNights > 0;
    
    if (isSubtotalDisplay) {
      // The booking card is showing subtotal - require provider to find a HIGHER price
      // (the true total including taxes/fees) or we need manual confirmation
      if (Math.abs(providerPrice - bookingCardAmount) <= tolerance) {
        return {
          status: 'rejected',
          mismatchReason: 'subtotal_match_requires_breakdown',
          validationNote: `Provider $${providerPrice} equals subtotal "$${bookingCardAmount} for ${bookingCardNights} nights" - need breakdown total for verification`
        };
      }
      
      // Provider found higher price than subtotal - this COULD be the total with taxes
      // But without breakdown, we can't verify, so require confirmation
      if (providerPrice > bookingCardAmount + tolerance) {
        return {
          status: 'rejected',
          mismatchReason: 'no_breakdown_to_verify_total',
          validationNote: `Provider $${providerPrice} > subtotal $${bookingCardAmount} but no breakdown to verify`
        };
      }
      
      // Provider price lower than subtotal - definitely wrong
      if (providerPrice < bookingCardAmount - tolerance) {
        return {
          status: 'rejected',
          mismatchReason: 'provider_price_lower_than_subtotal',
          validationNote: `Provider $${providerPrice} < subtotal $${bookingCardAmount}`
        };
      }
    } else {
      // Booking card shows a raw price without nights context - could be total
      // B1: Provider price lower than OCR baseline -> REJECT
      if (providerPrice < bookingCardAmount - tolerance) {
        return {
          status: 'rejected',
          mismatchReason: 'provider_price_lower_than_visible_price',
          validationNote: `Provider $${providerPrice} < OCR baseline $${bookingCardAmount}`
        };
      }

      // B2: Provider price equal to OCR baseline -> ACCEPT (excluding taxes)
      if (Math.abs(providerPrice - bookingCardAmount) <= tolerance) {
        return {
          status: 'accepted',
          acceptedVia: 'equal_to_baseline',
          validationNote: `Provider $${providerPrice} equals OCR baseline $${bookingCardAmount}`
        };
      }

      // B3: Provider price higher than OCR baseline -> ACCEPT (including taxes)
      if (providerPrice > bookingCardAmount + tolerance) {
        return {
          status: 'accepted',
          acceptedVia: 'higher_than_baseline_includes_fees',
          validationNote: `Provider $${providerPrice} > OCR baseline $${bookingCardAmount} (includes fees)`
        };
      }
    }
  }

  return { status: 'no_ocr_data', validationNote: 'no_baseline_for_comparison' };
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
    const apiKey = Deno.env.get('FIRECRAWL_API_KEY_1') || Deno.env.get('FIRECRAWL_API_KEY');
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
      candidates_summary: candidates.slice(0, 10).map(c => ({
        amount: c.amount,
        currency: c.currency,
        kind: c.kind,
        label_hint: c.labelHint,
        rejected_reason: c.rejectedReason,
        candidate_type: c.candidateType,
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
      candidates_summary: candidates.slice(0, 10).map(c => ({
        amount: c.amount,
        currency: c.currency,
        kind: c.kind,
        label_hint: c.labelHint,
        rejected_reason: c.rejectedReason,
        candidate_type: c.candidateType,
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

// ============================================================================
// CANONICAL URL NORMALIZER - Shared Logic (Golden Path)
// This is the SINGLE SOURCE OF TRUTH for Airbnb URL normalization.
// Keep in sync with supabase/functions/airbnb-url-normalizer/index.ts
// ============================================================================

interface NormalizedAirbnbUrls {
  book_stays_url: string;
  rooms_url: string;
  room_id: string;
  check_in: string;
  check_out: string;
  nights_count: number;
  adults: number;
  children: number;
  infants: number;
  pets: number;
}

function buildBookStaysUrl(inputUrl: string, guestCurrency = 'USD'): NormalizedAirbnbUrls | null {
  try {
    const parsed = new URL(inputUrl);
    
    // Extract room ID from /rooms/<id> or /book/stays/<id>
    let roomId: string | null = null;
    const roomsMatch = parsed.pathname.match(/\/rooms\/(\d+)/);
    if (roomsMatch) roomId = roomsMatch[1];
    const bookStaysMatch = parsed.pathname.match(/\/book\/stays\/(\d+)/);
    if (bookStaysMatch) roomId = bookStaysMatch[1];
    if (!roomId) return null;
    
    // Extract dates (handle both formats)
    const checkIn = parsed.searchParams.get('checkin') || parsed.searchParams.get('check_in') || '';
    const checkOut = parsed.searchParams.get('checkout') || parsed.searchParams.get('check_out') || '';
    if (!checkIn || !checkOut) return null;
    
    // Validate dates
    const checkInDate = new Date(checkIn + 'T00:00:00Z');
    const checkOutDate = new Date(checkOut + 'T00:00:00Z');
    if (isNaN(checkInDate.getTime()) || isNaN(checkOutDate.getTime())) return null;
    if (checkOutDate <= checkInDate) return null;
    
    const nightsCount = Math.round((checkOutDate.getTime() - checkInDate.getTime()) / (1000 * 60 * 60 * 24));
    
    // Extract guest parameters
    const adults = parseInt(
      parsed.searchParams.get('numberOfAdults') || 
      parsed.searchParams.get('adults') || 
      '1', 
      10
    ) || 1;
    
    const children = parseInt(
      parsed.searchParams.get('numberOfChildren') || 
      parsed.searchParams.get('children') || 
      '0', 
      10
    ) || 0;
    
    const infants = parseInt(
      parsed.searchParams.get('numberOfInfants') || 
      parsed.searchParams.get('infants') || 
      '0', 
      10
    ) || 0;
    
    const pets = parseInt(
      parsed.searchParams.get('numberOfPets') || 
      parsed.searchParams.get('pets') || 
      '0', 
      10
    ) || 0;
    
    // Calculate numberOfGuests (pets don't count)
    const existingGuests = parsed.searchParams.get('numberOfGuests') || parsed.searchParams.get('guests');
    const numberOfGuests = existingGuests 
      ? parseInt(existingGuests, 10) || (adults + children + infants)
      : adults + children + infants;
    
    // Build canonical book/stays URL with FIXED PARAMETER ORDER
    const bookStaysUrl = new URL(`https://www.airbnb.com/book/stays/${roomId}`);
    bookStaysUrl.searchParams.set('numberOfGuests', String(numberOfGuests));
    bookStaysUrl.searchParams.set('numberOfAdults', String(adults));
    bookStaysUrl.searchParams.set('checkin', checkIn);
    bookStaysUrl.searchParams.set('checkout', checkOut);
    bookStaysUrl.searchParams.set('guestCurrency', guestCurrency);
    bookStaysUrl.searchParams.set('productId', roomId);
    bookStaysUrl.searchParams.set('isWorkTrip', 'false');
    bookStaysUrl.searchParams.set('numberOfChildren', String(children));
    bookStaysUrl.searchParams.set('numberOfInfants', String(infants));
    bookStaysUrl.searchParams.set('numberOfPets', String(pets));
    
    // Build canonical rooms URL
    const roomsUrl = new URL(`https://www.airbnb.com/rooms/${roomId}`);
    roomsUrl.searchParams.set('check_in', checkIn);
    roomsUrl.searchParams.set('check_out', checkOut);
    roomsUrl.searchParams.set('adults', String(adults));
    if (children > 0) roomsUrl.searchParams.set('children', String(children));
    if (infants > 0) roomsUrl.searchParams.set('infants', String(infants));
    if (pets > 0) roomsUrl.searchParams.set('pets', String(pets));
    
    return {
      book_stays_url: bookStaysUrl.toString(),
      rooms_url: roomsUrl.toString(),
      room_id: roomId,
      check_in: checkIn,
      check_out: checkOut,
      nights_count: nightsCount,
      adults,
      children,
      infants,
      pets,
    };
  } catch {
    return null;
  }
}

// Test with Browserless - PRIMARY: book/stays page, FALLBACK: rooms page
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

    // Build book/stays URL from rooms URL
    const bookStaysParams = buildBookStaysUrl(url);
    const bookStaysUrl = bookStaysParams?.book_stays_url || null;
    const roomId = bookStaysParams?.room_id || '';
    
    console.log(`[Browserless] Rooms URL: ${url}`);
    // Use distributed gate for Browserless calls
    const browserlessFnUrl = `https://chrome.browserless.io/function?token=${apiKey}`;

    // BOOK/STAYS PRIMARY SCRIPT
    const functionPayload = {
      code: `
        export default async function({ page, context }) {
          const bookStaysUrl = context.bookStaysUrl;
          const roomsUrl = context.roomsUrl;
          const roomId = context.roomId;
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const clickLog = [];

          // Session setup
          await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
          await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
          await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
          
          try {
            const client = await page.target().createCDPSession();
            await client.send('Emulation.setTimezoneOverride', { timezoneId: 'America/New_York' });
            await client.send('Network.enable');
            await client.send('Network.clearBrowserCookies');
            await client.send('Network.clearBrowserCache');
          } catch (e) {
            clickLog.push('CDP setup partial: ' + e.message);
          }

          // Clear storage
          await page.goto('https://www.airbnb.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
          await sleep(500);
          try {
            await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
          } catch {}

          let usedFallback = false;
          let finalUrl = '';
          let pageTitle = '';
          let totalRowFound = false;
          let bookingCardScreenshot = null;

          // ========== PRIMARY: Navigate to book/stays ==========
          let isUnavailable = false;
          if (bookStaysUrl) {
            clickLog.push('PRIMARY: Navigating to book/stays');
            await page.goto(bookStaysUrl, { waitUntil: 'networkidle2', timeout: 60000 });
            await sleep(2000);
            
            finalUrl = page.url();
            pageTitle = await page.title().catch(() => '');
            
            const isBookStaysPage = finalUrl.includes('/book/stays/' + roomId);
            const isLoginRedirect = finalUrl.includes('/login') || finalUrl.includes('/signin');
            
            // Check for unavailable dates (terminal state)
            const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
            isUnavailable = /no longer available|dates are no longer available|unavailable for your dates|not available for these dates|someone else just requested|this listing is no longer|this home isn't available/i.test(bodyText);
            
            if (isUnavailable) {
              clickLog.push('DATES_UNAVAILABLE detected');
            } else if (!isBookStaysPage || isLoginRedirect) {
              clickLog.push('Book/stays failed: ' + (isLoginRedirect ? 'login_redirect' : 'wrong_path'));
              usedFallback = true;
            } else {
              // Check for Total on book/stays page
              // NOTE: Use proper regex literals with single backslashes (not double-escaped)
              // because this regex is evaluated inside page.evaluate, not sent as a string
              totalRowFound = /Total\s*(USD|EUR|GBP|\(USD\))?[\s:]*[\$€£][\d,.]+/i.test(bodyText) ||
                              /Pay\s+\$[\d,]+/i.test(bodyText);
              clickLog.push('Book/stays Total found: ' + totalRowFound);
            }
          } else {
            clickLog.push('No book/stays URL, using fallback');
            usedFallback = true;
          }

          // ========== FALLBACK: rooms page with breakdown click ==========
          if (usedFallback) {
            clickLog.push('FALLBACK: Navigating to rooms page');
            await page.goto(roomsUrl, { waitUntil: 'networkidle2', timeout: 45000 });
            await sleep(4000);
            
            finalUrl = page.url();
            pageTitle = await page.title().catch(() => '');
            
            // Try to open price breakdown
            try {
              const allLinks = await page.$$('a, button, span, div[role="button"]');
              for (const el of allLinks) {
                const text = await el.textContent().catch(() => '');
                const textLower = (text || '').toLowerCase().trim();
                if (textLower.includes('price breakdown') || textLower.includes('price details')) {
                  await el.click({ delay: 100 });
                  await sleep(2500);
                  clickLog.push('Clicked: ' + textLower.slice(0, 30));
                  break;
                }
              }
            } catch (e) {
              clickLog.push('Click failed: ' + e.message);
            }
            
            const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
            // NOTE: Use proper regex literals with single backslashes
            totalRowFound = /Total\s*(USD|EUR|GBP|\(USD\))?[\s:]*[\$€£][\d,.]+/i.test(bodyText);
            clickLog.push('Fallback Total found: ' + totalRowFound);
          }

          // Take screenshot
          await page.evaluate(() => window.scrollTo(0, 0));
          await sleep(300);
          bookingCardScreenshot = await page.screenshot({ encoding: 'base64', clip: { x: 0, y: 0, width: 1440, height: 900 } }).catch(() => null);

          const html = await page.content();

          return {
            html,
            fullHtml: html,
            bookStaysUrl: bookStaysUrl,
            usedFallback,
            finalUrl,
            pageTitle,
            totalRowFound,
            clickLog: clickLog.join(' | '),
            bookingCardScreenshot,
            breakdownOpened: !usedFallback,
            isUnavailable
          };
        }
      `,
      context: { bookStaysUrl, roomsUrl: url, roomId },
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
      await logProviderRequest(supabase, provider, false, durationMs, url, `HTTP ${resp.status}`);
      
      // Detect HTTP 429 rate limiting
      const isRateLimited = resp.status === 429 || 
        errText.includes('429 Too Many Requests') || 
        (errText.includes('openresty') && errText.includes('Too Many Requests'));
      
      if (isRateLimited) {
        console.log(`[Browserless] RATE LIMITED (429) - will be returned as rate_limited status`);
        return {
          provider,
          status: 'rate_limited',
          price: null,
          currency: null,
          includes_taxes_fees: false,
          evidence_snippet: `Rate limited (HTTP 429): ${errText.slice(0, 200)}`,
          error: 'HTTP 429 rate_limited',
          duration_ms: durationMs,
          candidates_summary: [],
          click_log: 'Rate limited before script ran',
        };
      }
      
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
        click_log: 'Request failed before script ran',
      };
    }

    await logProviderRequest(supabase, provider, true, durationMs, url);

    const fnJson = await resp.json().catch(() => null);
    const html = fnJson?.html || '';
    const breakdownContainerHtml = fnJson?.breakdownContainerHtml || '';
    const totalRowFound = fnJson?.totalRowFound || false;
    const clickLog = fnJson?.clickLog || 'no click log';
    const bookingCardScreenshot = fnJson?.bookingCardScreenshot || null;
    const breakdownScreenshot = fnJson?.breakdownScreenshot || null;
    const breakdownOpened = fnJson?.breakdownOpened || false;
    const isUnavailable = fnJson?.isUnavailable || false;

    console.log(`[Browserless] Click log: ${clickLog}`);
    console.log(`[Browserless] HTML length: ${html.length}, breakdown container: ${breakdownContainerHtml.length}`);
    console.log(`[Browserless] Total row found: ${totalRowFound}`);
    console.log(`[Browserless] Is unavailable: ${isUnavailable}`);
    console.log(`[Browserless] Screenshots: bookingCard=${!!bookingCardScreenshot}, breakdown=${!!breakdownScreenshot}`);

    // ========== CHECK FOR DATES UNAVAILABLE (terminal state) ==========
    if (isUnavailable) {
      return {
        provider,
        status: 'dates_unavailable',
        price: null,
        currency: null,
        includes_taxes_fees: false,
        evidence_snippet: `Property not available for selected dates. Click log: ${clickLog}`,
        duration_ms: durationMs,
        candidates_summary: [],
        click_log: clickLog,
      };
    }

    // ========== OCR EXTRACTION (DOM-based, fallback to screenshot if available) ==========
    let ocrReference: OcrVisualReference | null = null;
    
    // First try DOM-based extraction from the full HTML
    const fullHtml = fnJson?.fullHtml || html;
    ocrReference = extractOcrFromHtml(fullHtml, nights);
    
    if (ocrReference) {
      console.log(`[Browserless] OCR-DOM result: bookingCard=$${ocrReference.bookingCardAmount}, breakdown=$${ocrReference.breakdownTotalAmount}`);
    } else if (bookingCardScreenshot || breakdownScreenshot) {
      // Fallback to screenshot-based extraction (currently returns null)
      console.log('[Browserless] DOM extraction failed, trying screenshot-based OCR...');
      ocrReference = await extractOcrVisualReference(bookingCardScreenshot, breakdownScreenshot, breakdownOpened);
      if (ocrReference) {
        console.log(`[Browserless] OCR-Screenshot result: bookingCard=$${ocrReference.bookingCardAmount}, breakdown=$${ocrReference.breakdownTotalAmount}`);
      }
    }

    if (html.length < 500) {
      return {
        provider,
        status: 'price_not_available_in_content',
        price: null,
        currency: null,
        includes_taxes_fees: false,
        evidence_snippet: `Insufficient content. Click log: ${clickLog}`,
        duration_ms: durationMs,
        candidates_summary: [],
        click_log: clickLog,
        // Still return OCR reference so other providers can be validated against it
        ocr_reference: ocrReference,
        ocr_validation: validateProviderPriceWithOcr(null, ocrReference),
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
        click_log: clickLog,
        ocr_reference: ocrReference,
        ocr_validation: validateProviderPriceWithOcr(null, ocrReference),
      };
    }

    // If Total row was not found, fail immediately
    if (!totalRowFound) {
      return {
        provider,
        status: 'price_not_available_in_content',
        price: null,
        currency: null,
        includes_taxes_fees: false,
        evidence_snippet: `Total row not found after both strategies. Click log: ${clickLog}`,
        duration_ms: durationMs,
        candidates_summary: [],
        click_log: clickLog,
        // Return OCR reference even on failure (critical for Zyte/Firecrawl validation)
        ocr_reference: ocrReference,
        ocr_validation: validateProviderPriceWithOcr(null, ocrReference),
      };
    }

    // Extract candidates from breakdown container (or full HTML if no container)
    const extractionContent = breakdownContainerHtml.length > 100 ? breakdownContainerHtml : html;
    const candidates = extractPriceCandidates(extractionContent, nights);
    
    console.log(`[Browserless] Found ${candidates.length} candidates`);
    candidates.slice(0, 8).forEach((c, i) => {
      console.log(`  Candidate ${i+1}: $${c.amount} type=${c.candidateType} rejected=${c.rejectedReason || 'no'}`);
    });
    
    // STRICT SELECTION: Only accept total_final candidates
    const totalFinalCandidates = candidates.filter(c => c.candidateType === 'total_final' && !c.rejectedReason);
    
    console.log(`[Browserless] total_final candidates: ${totalFinalCandidates.length}`);
    
    // Sort by: includes_taxes_fees first (prefer totals with taxes), then by amount (highest)
    const sorted = totalFinalCandidates.sort((a, b) => {
      if (a.includesTaxesFees && !b.includesTaxesFees) return -1;
      if (!a.includesTaxesFees && b.includesTaxesFees) return 1;
      return b.amount - a.amount;
    });

    const selected = sorted[0];

    // ========== FINAL GUARDRAIL OVERRIDE ==========
    // If evidence contains subtotal patterns, FORCE failure even if we think we found a total
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
        console.log(`[Browserless] GUARDRAIL: Evidence contains subtotal pattern, rejecting: ${evidenceContext.slice(0, 100)}`);
        return {
          provider,
          status: 'price_not_available_in_content',
          price: null,
          currency: null,
          includes_taxes_fees: false,
          evidence_snippet: `GUARDRAIL: Evidence contains subtotal pattern. Context: ${evidenceContext.slice(0, 200)} | Click: ${clickLog.slice(0, 100)}`,
          duration_ms: durationMs,
          candidates_summary: candidates.slice(0, 10).map(c => ({
            amount: c.amount,
            currency: c.currency,
            kind: c.kind,
            label_hint: c.labelHint,
            rejected_reason: c.rejectedReason || 'guardrail_subtotal_in_evidence',
            candidate_type: c.candidateType,
            raw_matched_string: c.rawMatchedString,
          })),
          click_log: clickLog,
          raw_matched_string: selected.rawMatchedString,
        };
      }
    }

    // Build final evidence snippet
    const evidenceWithLog = selected?.context 
      ? `${selected.context}`
      : `No total_final candidate found. Click: ${clickLog}`;

    // ========== OCR VALIDATION ==========
    const ocrValidation = validateProviderPriceWithOcr(selected?.amount || null, ocrReference);
    console.log(`[Browserless] OCR validation: ${ocrValidation.status} - ${ocrValidation.acceptedVia || ocrValidation.mismatchReason || ''}`);

    // If OCR rejects the price, override the status
    let finalStatus = selected ? selected.kind : 'price_not_available_in_content';
    let finalPrice = selected?.amount || null;
    
    if (ocrValidation.status === 'rejected' && finalPrice) {
      console.log(`[Browserless] OCR REJECTED price $${finalPrice}: ${ocrValidation.mismatchReason}`);
      finalStatus = 'price_not_available_in_content';
      finalPrice = null;
    }

    return {
      provider,
      status: finalStatus,
      price: finalPrice,
      currency: selected?.currency || null,
      includes_taxes_fees: selected?.includesTaxesFees || false,
      evidence_snippet: evidenceWithLog,
      duration_ms: durationMs,
      candidates_summary: candidates.slice(0, 10).map(c => ({
        amount: c.amount,
        currency: c.currency,
        kind: c.kind,
        label_hint: c.labelHint,
        rejected_reason: c.rejectedReason,
        candidate_type: c.candidateType,
        raw_matched_string: c.rawMatchedString,
      })),
      click_log: clickLog,
      raw_matched_string: selected?.rawMatchedString || undefined,
      ocr_reference: ocrReference,
      ocr_validation: ocrValidation,
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
      click_log: 'Exception: ' + String(e),
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
      
      // OCR reference captured by Browserless (shared with other providers for validation)
      let sharedOcrReference: OcrVisualReference | null = null;

      for (const provider of providerOrder) {
        console.log(`Testing ${provider}...`);
        
        let result: ProviderAttemptResult;
        if (provider === 'firecrawl') {
          result = await testFirecrawl(url, nights, supabase);
          // Apply shared OCR validation to Firecrawl result
          if (sharedOcrReference && result.price) {
            const ocrVal = validateProviderPriceWithOcr(result.price, sharedOcrReference);
            result.ocr_reference = sharedOcrReference;
            result.ocr_validation = ocrVal;
            if (ocrVal.status === 'rejected') {
              console.log(`[Firecrawl] OCR REJECTED price $${result.price}: ${ocrVal.mismatchReason}`);
              result.status = 'price_not_available_in_content';
              result.price = null;
            }
          }
        } else if (provider === 'zyte') {
          result = await testZyte(url, nights, supabase);
          // Apply shared OCR validation to Zyte result
          if (sharedOcrReference && result.price) {
            const ocrVal = validateProviderPriceWithOcr(result.price, sharedOcrReference);
            result.ocr_reference = sharedOcrReference;
            result.ocr_validation = ocrVal;
            if (ocrVal.status === 'rejected') {
              console.log(`[Zyte] OCR REJECTED price $${result.price}: ${ocrVal.mismatchReason}`);
              result.status = 'price_not_available_in_content';
              result.price = null;
            }
          }
        } else {
          result = await testBrowserless(url, nights, supabase);
          // Capture OCR reference from Browserless for other providers
          if (result.ocr_reference) {
            sharedOcrReference = result.ocr_reference;
            console.log(`[Main] Captured OCR reference: bookingCard=$${sharedOcrReference.bookingCardAmount}, breakdown=$${sharedOcrReference.breakdownTotalAmount}`);
          }
        }

        providerResults.push(result);
        console.log(`${provider}: ${result.status}, price: ${result.price || 'N/A'}, OCR: ${result.ocr_validation?.status || 'none'}`);

        // Persist debug bundle for this provider attempt (including OCR fields)
        try {
          const ocrRef = result.ocr_reference;
          const ocrVal = result.ocr_validation;
          
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
            click_log: result.click_log || null,
            raw_matched_string: result.raw_matched_string || null,
            airbnb_url: url,
            check_in_date: checkIn,
            check_out_date: checkOut,
            nights_count: nights,
            // OCR fields
            ocr_booking_card_amount_value: ocrRef?.bookingCardAmount || null,
            ocr_booking_card_nights: ocrRef?.bookingCardNights || null,
            ocr_booking_card_snippet: ocrRef?.bookingCardSnippet || null,
            ocr_breakdown_total_amount_value: ocrRef?.breakdownTotalAmount || null,
            ocr_breakdown_total_snippet: ocrRef?.breakdownTotalSnippet || null,
            ocr_breakdown_taxes_amount_value: ocrRef?.breakdownTaxesAmount || null,
            breakdown_opened: ocrRef?.breakdownOpened || false,
            ocr_validation_status: ocrVal?.status || null,
            ocr_accepted_via: ocrVal?.acceptedVia || null,
            ocr_mismatch_reason: ocrVal?.mismatchReason || null,
          });
          console.log(`Persisted debug bundle for ${provider} run ${runNumber} with OCR: ${ocrVal?.status || 'none'}`);
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
        
        // Check for terminal states that should halt the chain
        if (result.status === 'dates_unavailable' || result.status === 'rate_limited') {
          finalStatus = result.status;
          finalEvidenceSnippet = result.evidence_snippet;
          console.log(`[Main] Terminal state reached: ${result.status} - stopping provider chain`);
          break;
        }
      }

      // If no success, use priority: rate_limited > dates_unavailable > needs_user_confirmation
      if (!selectedProvider && providerResults.length > 0) {
        // Check if any provider hit rate_limited (takes priority)
        const rateLimitedResult = providerResults.find(r => r.status === 'rate_limited');
        const unavailableResult = providerResults.find(r => r.status === 'dates_unavailable');
        
        if (rateLimitedResult) {
          finalStatus = 'rate_limited';
          finalEvidenceSnippet = rateLimitedResult.evidence_snippet;
          console.log(`[Main] Final status: rate_limited (from ${rateLimitedResult.provider})`);
        } else if (unavailableResult) {
          finalStatus = 'dates_unavailable';
          finalEvidenceSnippet = unavailableResult.evidence_snippet;
          console.log(`[Main] Final status: dates_unavailable (from ${unavailableResult.provider})`);
        } else {
          // No verified total from any provider - trigger manual confirmation
          // Check if we have OCR subtotal info to help the user
          const ocrRef = sharedOcrReference;
          if (ocrRef?.bookingCardAmount && ocrRef?.bookingCardNights) {
            finalStatus = 'needs_user_confirmation';
            finalEvidenceSnippet = `Subtotal: $${ocrRef.bookingCardAmount} for ${ocrRef.bookingCardNights} nights. Manual total required.`;
            console.log(`[Main] Final status: needs_user_confirmation (subtotal=$${ocrRef.bookingCardAmount} for ${ocrRef.bookingCardNights} nights)`);
          } else {
            const last = providerResults[providerResults.length - 1];
            finalStatus = 'needs_user_confirmation';
            finalEvidenceSnippet = last.evidence_snippet || 'No verified total found. Manual confirmation required.';
            console.log(`[Main] Final status: needs_user_confirmation (no verified total from any provider)`);
          }
        }
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

    // Summary with version marker for deployment verification
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
      // Version marker for deployment verification
      _version: 'subtotal-rejection-v2',
      _deployed_at: new Date().toISOString(),
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
