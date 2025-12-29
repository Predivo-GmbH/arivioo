import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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

// Detect bot/captcha indicators in content
function detectBotIndicators(content: string): string[] {
  const indicators: string[] = [];
  const lowerContent = content.toLowerCase();
  
  const patterns = [
    { pattern: /captcha/i, label: "captcha" },
    { pattern: /robot|bot\s+check/i, label: "robot_check" },
    { pattern: /verify you['']?re human/i, label: "human_verification" },
    { pattern: /cloudflare/i, label: "cloudflare" },
    { pattern: /please\s+wait\s+while\s+we\s+verify/i, label: "verification_wait" },
    { pattern: /access\s+denied/i, label: "access_denied" },
    { pattern: /blocked/i, label: "blocked" },
    { pattern: /unusual\s+traffic/i, label: "unusual_traffic" },
    { pattern: /rate\s+limit/i, label: "rate_limited" },
    { pattern: /too\s+many\s+requests/i, label: "too_many_requests" },
    { pattern: /just\s+a\s+moment/i, label: "cloudflare_wait" },
    { pattern: /checking\s+your\s+browser/i, label: "browser_check" },
  ];
  
  for (const { pattern, label } of patterns) {
    if (pattern.test(content)) {
      indicators.push(label);
    }
  }
  
  return indicators;
}

// Extract evidence snippet around bot indicator or price
function extractEvidenceSnippet(content: string, maxLength: number = 500): string {
  // Try to find context around prices or bot messages
  const botMatch = content.match(/(captcha|robot|verify|blocked|access denied).{0,200}/i);
  if (botMatch) {
    const start = Math.max(0, botMatch.index! - 100);
    return content.slice(start, start + maxLength);
  }
  
  // Try to find context around price
  const priceMatch = content.match(/\$\s*\d{1,5}[,\d]*(\.\d{2})?/);
  if (priceMatch) {
    const start = Math.max(0, priceMatch.index! - 100);
    return content.slice(start, start + maxLength);
  }
  
  // Return first chunk
  return content.slice(0, maxLength);
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
function extractAirbnbPrice(content: string): number | null {
  // Try JSON-LD first
  const jsonLdMatch = content.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  if (jsonLdMatch) {
    for (const match of jsonLdMatch) {
      try {
        const json = JSON.parse(match.replace(/<\/?script[^>]*>/gi, ''));
        if (json.offers?.price) {
          return parseFloat(json.offers.price);
        }
      } catch {}
    }
  }
  
  // Try common Airbnb price patterns
  const patterns = [
    /\$\s*(\d{1,4}(?:,\d{3})?(?:\.\d{2})?)\s*(?:night|\/night|per night)/gi,
    /"(?:price|priceString|priceForDisplay)"[:\s]*"\$?(\d{1,4}(?:,\d{3})?(?:\.\d{2})?)"/gi,
    /"(?:amount|pricePerNight|nightlyPrice)"[:\s]*(\d{1,4}(?:\.\d{2})?)/gi,
    /total[:\s]*\$?\s*(\d{1,5}(?:,\d{3})?(?:\.\d{2})?)/gi,
  ];
  
  for (const pattern of patterns) {
    const matches = [...content.matchAll(pattern)];
    for (const match of matches) {
      const priceStr = (match[1] || match[2] || "").replace(/,/g, '');
      const price = parseFloat(priceStr);
      if (price >= 15 && price <= 10000) {
        return price;
      }
    }
  }
  
  return null;
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
    
    const price = extractAirbnbPrice(content);
    if (price) {
      attempt.priceFound = true;
      attempt.priceValue = price;
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
        actions: [
          { action: "waitForTimeout", timeout: 8000 },
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
    
    const price = extractAirbnbPrice(html);
    if (price) {
      attempt.priceFound = true;
      attempt.priceValue = price;
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
    
    const price = extractAirbnbPrice(html);
    if (price) {
      attempt.priceFound = true;
      attempt.priceValue = price;
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
