import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  corsHeaders,
  detectBotIndicators,
  SHARED_MODULES_VERSION,
} from "../_shared/mod.ts";

interface ProviderAttempt {
  provider: "firecrawl" | "zyte" | "direct";
  success: boolean;
  httpStatus: number | null;
  responseSize: number;
  contentHash: string | null;
  botIndicators: string[];
  evidenceSnippet: string | null;
  priceFound: boolean;
  priceValue: number | null;
  priceType: 'total' | 'nightly' | null;
  priceEvidence: string | null;
  nightsDetected: number | null;
  durationMs: number;
  error: string | null;
  finalUrl: string | null;
}

interface DiagnosticResult {
  url: string;
  checkIn: string | null;
  checkOut: string | null;
  timestamp: string;
  correlationId: string;
  attempts: ProviderAttempt[];
  recommendation: string;
  bestProvider: string | null;
}

// Log shared module version for debugging
console.log(`[airbnb-diagnostic] Using _shared modules version: ${SHARED_MODULES_VERSION}`);

// Extract evidence snippet around bot indicator or price
function extractEvidenceSnippet(content: string, maxLength: number = 500): string {
  // Strip CSS/style content for cleaner evidence
  const cleanContent = content
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/\{[^}]*\}/g, ' ');
  
  // Try to find context around price (more useful evidence)
  const priceMatch = cleanContent.match(/(\$\s*\d{1,5}[,\d]*(?:\.\d{2})?).{0,150}/i);
  if (priceMatch) {
    const start = Math.max(0, priceMatch.index! - 50);
    return cleanContent.slice(start, start + maxLength);
  }
  
  // Try to find night rate context
  const nightMatch = cleanContent.match(/.{0,50}(?:per\s+night|\/night|night).{0,100}/i);
  if (nightMatch) {
    return nightMatch[0];
  }
  
  // Look for total context
  const totalMatch = cleanContent.match(/.{0,50}total.{0,150}/i);
  if (totalMatch) {
    return totalMatch[0];
  }
  
  // Return first meaningful chunk (skip leading whitespace)
  const trimmed = cleanContent.trim();
  return trimmed.slice(0, maxLength);
}

// Simple hash for content comparison
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(16);
}

// Extract Airbnb price from content using regex patterns
function extractAirbnbPrice(content: string): { price: number | null; type: 'total' | 'nightly' | null; evidence: string | null; nights: number | null } {
  const result = { price: null as number | null, type: null as 'total' | 'nightly' | null, evidence: null as string | null, nights: null as number | null };
  
  // Priority 0: Look for FINAL TOTAL with taxes (most accurate)
  // Airbnb often shows "Total (USD)" or similar in the price breakdown
  const finalTotalPatterns = [
    // "Total (USD)" or "Total" followed by price - this is the FINAL amount
    /(?:total\s*(?:\([A-Z]{3}\))?|grand\s+total)[:\s]*\$?\s*(\d{1,6}(?:,\d{3})?(?:\.\d{2})?)/gi,
    // Price breakdown JSON patterns - look for final totals
    /"totalPrice"[:\s]*["\$]*(\d{1,6}(?:,\d{3})?(?:\.\d{2})?)/gi,
    /"total"[:\s]*["\$]*(\d{1,6}(?:,\d{3})?(?:\.\d{2})?)/gi,
    // "You pay $X" or similar final confirmation
    /you\s+(?:will\s+)?pay[:\s]*\$?\s*(\d{1,6}(?:,\d{3})?(?:\.\d{2})?)/gi,
  ];
  
  // Collect all potential final totals
  let potentialTotals: Array<{price: number; evidence: string}> = [];
  
  for (const pattern of finalTotalPatterns) {
    const matches = [...content.matchAll(pattern)];
    for (const match of matches) {
      const price = parseFloat((match[1] || "").replace(/,/g, ''));
      if (price >= 30 && price <= 200000) {
        potentialTotals.push({ price, evidence: match[0].slice(0, 100) });
      }
    }
  }
  
  // Priority 1: Look for "X for Y nights" pattern in aria-label or visible text
  // This is the subtotal (before taxes) Airbnb shows
  const totalNightsMatch = content.match(/aria-label=["']?\$?\s*(\d{1,5}(?:,\d{3})?(?:\.\d{2})?)\s+(?:for\s+)?(\d+)\s*nights?["']?/i);
  let subtotalForNights: number | null = null;
  let nightsDetected: number | null = null;
  
  if (totalNightsMatch) {
    subtotalForNights = parseFloat(totalNightsMatch[1].replace(/,/g, ''));
    nightsDetected = parseInt(totalNightsMatch[2], 10);
    if (subtotalForNights >= 20 && subtotalForNights <= 50000 && nightsDetected > 0) {
      potentialTotals.push({ price: subtotalForNights, evidence: totalNightsMatch[0].slice(0, 100) });
    }
  }
  
  // If we found multiple totals, prefer the highest one (likely includes taxes)
  // but only if it's within 30% higher than the subtotal (reasonable tax range)
  if (potentialTotals.length > 0) {
    const maxEntry = potentialTotals.reduce((a, b) => a.price > b.price ? a : b);
    
    // If we have a subtotal and a higher total (within 30%), use the higher one
    if (subtotalForNights && maxEntry.price > subtotalForNights && maxEntry.price <= subtotalForNights * 1.3) {
      return { 
        price: maxEntry.price, 
        type: 'total', 
        evidence: maxEntry.evidence + ' (with taxes)',
        nights: nightsDetected 
      };
    }
    
    // Otherwise use the subtotal if available
    if (subtotalForNights && nightsDetected) {
      return { 
        price: subtotalForNights, 
        type: 'total', 
        evidence: totalNightsMatch![0].slice(0, 100),
        nights: nightsDetected 
      };
    }
    
    // Fallback to highest found
    return { 
      price: maxEntry.price, 
      type: 'total', 
      evidence: maxEntry.evidence,
      nights: nightsDetected 
    };
  }
  
  // Priority 2: Look for total price indicators
  
  // Priority 3: Do NOT derive totals from nightly rates.
  // We must report the total Airbnb actually shows; if only a nightly rate is present, treat as not found.
  return result;
}

// Test Firecrawl provider
async function testFirecrawl(url: string, apiKey: string): Promise<ProviderAttempt> {
  const start = Date.now();
  const attempt: ProviderAttempt = {
    provider: "firecrawl",
    success: false,
    httpStatus: null,
    responseSize: 0,
    contentHash: null,
    botIndicators: [],
    evidenceSnippet: null,
    priceFound: false,
    priceValue: null,
    priceType: null,
    priceEvidence: null,
    nightsDetected: null,
    durationMs: 0,
    error: null,
    finalUrl: null,
  };
  
  try {
    const response = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        formats: ["markdown", "html", "screenshot"],
        onlyMainContent: false,
        waitFor: 10000,
        timeout: 30000,
      }),
    });
    
    attempt.httpStatus = response.status;
    attempt.durationMs = Date.now() - start;
    
    const data = await response.json();
    
    if (!response.ok) {
      attempt.error = data.error || `HTTP ${response.status}`;
      attempt.evidenceSnippet = JSON.stringify(data).slice(0, 500);
      return attempt;
    }
    
    const markdown = data.data?.markdown || "";
    const html = data.data?.html || "";
    const content = markdown + html;
    
    attempt.success = true;
    attempt.responseSize = content.length;
    attempt.contentHash = simpleHash(content);
    attempt.botIndicators = detectBotIndicators(content);
    attempt.evidenceSnippet = extractEvidenceSnippet(content);
    attempt.finalUrl = data.data?.metadata?.sourceURL || url;
    
    const priceResult = extractAirbnbPrice(content);
    if (priceResult.price) {
      attempt.priceFound = true;
      attempt.priceValue = priceResult.price;
      attempt.priceType = priceResult.type;
      attempt.priceEvidence = priceResult.evidence;
      attempt.nightsDetected = priceResult.nights;
    }
    
  } catch (e) {
    attempt.durationMs = Date.now() - start;
    attempt.error = e instanceof Error ? e.message : String(e);
  }
  
  return attempt;
}

// Test Zyte provider
async function testZyte(url: string, apiKey: string): Promise<ProviderAttempt> {
  const start = Date.now();
  const attempt: ProviderAttempt = {
    provider: "zyte",
    success: false,
    httpStatus: null,
    responseSize: 0,
    contentHash: null,
    botIndicators: [],
    evidenceSnippet: null,
    priceFound: false,
    priceValue: null,
    priceType: null,
    priceEvidence: null,
    nightsDetected: null,
    durationMs: 0,
    error: null,
    finalUrl: null,
  };
  
  try {
    const zyteAuth = btoa(apiKey + ":");
    
    const response = await fetch("https://api.zyte.com/v1/extract", {
      method: "POST",
      headers: {
        "Authorization": `Basic ${zyteAuth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        browserHtml: true,
        javascript: true,
        screenshot: true,
        screenshotOptions: { fullPage: false },
        // Click "Show price breakdown" to reveal total with taxes
        actions: [
          { action: "waitForTimeout", timeout: 5 },
          { 
            action: "click", 
            selector: { type: "css", value: "button[aria-label*='for'][aria-label*='nights']" },
            onError: "ignore"
          },
          { action: "waitForTimeout", timeout: 3 },
        ],
      }),
    });
    
    attempt.httpStatus = response.status;
    attempt.durationMs = Date.now() - start;
    
    if (!response.ok) {
      const errText = await response.text();
      attempt.error = `HTTP ${response.status}: ${errText.slice(0, 200)}`;
      return attempt;
    }
    
    const data = await response.json();
    const html = data.browserHtml || "";
    
    attempt.success = true;
    attempt.responseSize = html.length;
    attempt.contentHash = simpleHash(html);
    attempt.botIndicators = detectBotIndicators(html);
    attempt.evidenceSnippet = extractEvidenceSnippet(html);
    attempt.finalUrl = data.url || url;
    
    const priceResult = extractAirbnbPrice(html);
    if (priceResult.price) {
      attempt.priceFound = true;
      attempt.priceValue = priceResult.price;
      attempt.priceType = priceResult.type;
      attempt.priceEvidence = priceResult.evidence;
      attempt.nightsDetected = priceResult.nights;
    }
    
  } catch (e) {
    attempt.durationMs = Date.now() - start;
    attempt.error = e instanceof Error ? e.message : String(e);
  }
  
  return attempt;
}

// Test direct fetch (no JS rendering)
async function testDirectFetch(url: string): Promise<ProviderAttempt> {
  const start = Date.now();
  const attempt: ProviderAttempt = {
    provider: "direct",
    success: false,
    httpStatus: null,
    responseSize: 0,
    contentHash: null,
    botIndicators: [],
    evidenceSnippet: null,
    priceFound: false,
    priceValue: null,
    priceType: null,
    priceEvidence: null,
    nightsDetected: null,
    durationMs: 0,
    error: null,
    finalUrl: null,
  };
  
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
    });
    
    attempt.httpStatus = response.status;
    attempt.durationMs = Date.now() - start;
    attempt.finalUrl = response.url;
    
    if (!response.ok) {
      attempt.error = `HTTP ${response.status}`;
      return attempt;
    }
    
    const html = await response.text();
    
    attempt.success = true;
    attempt.responseSize = html.length;
    attempt.contentHash = simpleHash(html);
    attempt.botIndicators = detectBotIndicators(html);
    attempt.evidenceSnippet = extractEvidenceSnippet(html);
    
    const priceResult = extractAirbnbPrice(html);
    if (priceResult.price) {
      attempt.priceFound = true;
      attempt.priceValue = priceResult.price;
      attempt.priceType = priceResult.type;
      attempt.priceEvidence = priceResult.evidence;
      attempt.nightsDetected = priceResult.nights;
    }
    
  } catch (e) {
    attempt.durationMs = Date.now() - start;
    attempt.error = e instanceof Error ? e.message : String(e);
  }
  
  return attempt;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  
  try {
    const { url } = await req.json();
    
    if (!url || !url.includes("airbnb.")) {
      return new Response(
        JSON.stringify({ error: "Valid Airbnb URL required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    
    // Extract dates from URL
    const urlObj = new URL(url);
    const checkIn = urlObj.searchParams.get("check_in");
    const checkOut = urlObj.searchParams.get("check_out");
    
    const correlationId = crypto.randomUUID().slice(0, 8);
    console.log(`[${correlationId}] Starting Airbnb diagnostic for: ${url.slice(0, 100)}`);
    
    const firecrawlKey = Deno.env.get("FIRECRAWL_API_KEY_1") || Deno.env.get("FIRECRAWL_API_KEY");
    const zyteKey = Deno.env.get("ZYTE_API_KEY");
    
    const attempts: ProviderAttempt[] = [];
    
    // Test Firecrawl
    if (firecrawlKey) {
      console.log(`[${correlationId}] Testing Firecrawl...`);
      const firecrawlResult = await testFirecrawl(url, firecrawlKey);
      attempts.push(firecrawlResult);
      console.log(`[${correlationId}] Firecrawl: success=${firecrawlResult.success}, status=${firecrawlResult.httpStatus}, price=${firecrawlResult.priceValue}, botIndicators=${firecrawlResult.botIndicators.join(',')}`);
    }
    
    // Test Zyte
    if (zyteKey) {
      console.log(`[${correlationId}] Testing Zyte...`);
      const zyteResult = await testZyte(url, zyteKey);
      attempts.push(zyteResult);
      console.log(`[${correlationId}] Zyte: success=${zyteResult.success}, status=${zyteResult.httpStatus}, price=${zyteResult.priceValue}, botIndicators=${zyteResult.botIndicators.join(',')}`);
    }
    
    // Test direct fetch
    console.log(`[${correlationId}] Testing direct fetch...`);
    const directResult = await testDirectFetch(url);
    attempts.push(directResult);
    console.log(`[${correlationId}] Direct: success=${directResult.success}, status=${directResult.httpStatus}, price=${directResult.priceValue}, botIndicators=${directResult.botIndicators.join(',')}`);
    
    // Determine best provider and recommendation
    let bestProvider: string | null = null;
    let recommendation = "";
    
    const successfulWithPrice = attempts.filter(a => a.success && a.priceFound && a.botIndicators.length === 0);
    const successfulWithoutPrice = attempts.filter(a => a.success && !a.priceFound && a.botIndicators.length === 0);
    const blocked = attempts.filter(a => a.botIndicators.length > 0 || a.httpStatus === 403);
    
    if (successfulWithPrice.length > 0) {
      // Prefer Zyte if it works, as Firecrawl may be blocking Airbnb
      const zyte = successfulWithPrice.find(a => a.provider === "zyte");
      const firecrawl = successfulWithPrice.find(a => a.provider === "firecrawl");
      
      if (zyte) {
        bestProvider = "zyte";
        recommendation = `Zyte successfully extracted price ($${zyte.priceValue}). Use Zyte as primary provider for Airbnb.`;
      } else if (firecrawl) {
        bestProvider = "firecrawl";
        recommendation = `Firecrawl successfully extracted price ($${firecrawl.priceValue}). Firecrawl is working.`;
      }
    } else if (successfulWithoutPrice.length > 0) {
      bestProvider = successfulWithoutPrice[0].provider;
      recommendation = `Content fetched but no price found. Dates may not be applied or price not visible. Evidence: ${successfulWithoutPrice[0].evidenceSnippet?.slice(0, 200) || 'N/A'}`;
    } else if (blocked.length > 0) {
      const blockedProviders = blocked.map(a => `${a.provider} (${a.botIndicators.join(', ') || a.error})`).join(', ');
      recommendation = `All providers blocked or errored: ${blockedProviders}. Need to wait or use different approach.`;
    } else {
      recommendation = "All providers failed. Check API keys and network connectivity.";
    }
    
    const result: DiagnosticResult = {
      url,
      checkIn,
      checkOut,
      timestamp: new Date().toISOString(),
      correlationId,
      attempts,
      recommendation,
      bestProvider,
    };
    
    console.log(`[${correlationId}] Diagnostic complete. Recommendation: ${recommendation}`);
    
    return new Response(
      JSON.stringify(result, null, 2),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
    
  } catch (e) {
    console.error("Diagnostic error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
