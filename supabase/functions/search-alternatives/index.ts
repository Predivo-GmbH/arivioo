import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// SSE helper to send streaming events
type SSEController = ReadableStreamDefaultController<Uint8Array>;
const encoder = new TextEncoder();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = 12_000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

// Generic timeout wrapper for any async operation - prevents stuck processes
async function withTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  fallback: T,
  operationName: string
): Promise<T> {
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      console.log(`TIMEOUT: ${operationName} exceeded ${timeoutMs}ms - skipping`);
      resolve(fallback);
    }, timeoutMs);

    operation()
      .then((result) => {
        clearTimeout(timeoutId);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timeoutId);
        console.log(`ERROR in ${operationName}:`, error.message || error);
        resolve(fallback);
      });
  });
}

// ============================================================================
// Zyte Scraper for Airbnb - Fallback when Firecrawl blocks Airbnb
// ============================================================================

interface ZyteAirbnbResult {
  ok: boolean;
  markdown: string;
  html: string;
  screenshot: string | null;
  providerUsed: 'zyte';
  botIndicators: string[];
  error: string | null;
}

// Detect bot/captcha indicators in content
// IMPORTANT: Only detect real bot walls, not CSS class names or script content
function detectBotIndicators(content: string): string[] {
  const indicators: string[] = [];
  
  // Strip out CSS, scripts, and style blocks to avoid false positives from class names
  const visibleContent = content
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/\{[^}]*\}/g, ' ') // Remove CSS rule blocks
    .replace(/class\s*=\s*["'][^"']*["']/gi, ' ') // Remove class attributes
    .replace(/id\s*=\s*["'][^"']*["']/gi, ' '); // Remove id attributes
  
  // These patterns must appear in visible text context, not CSS/class names
  const patterns = [
    { pattern: /please\s+complete\s+the\s+captcha/i, label: "captcha" },
    { pattern: /solve\s+the\s+captcha/i, label: "captcha" },
    { pattern: /verify\s+you['']?re\s+human/i, label: "human_verification" },
    { pattern: /verify\s+you\s+are\s+human/i, label: "human_verification" },
    { pattern: /i['']?m\s+not\s+a\s+robot/i, label: "captcha" },
    { pattern: /checking\s+your\s+browser/i, label: "browser_check" },
    { pattern: /just\s+a\s+moment[\.\!\s]/i, label: "cloudflare_wait" },
    { pattern: /please\s+wait\s+while\s+we\s+verify/i, label: "verification_wait" },
    { pattern: /unusual\s+traffic\s+from\s+your/i, label: "unusual_traffic" },
    { pattern: /too\s+many\s+requests/i, label: "too_many_requests" },
    { pattern: /access\s+to\s+this\s+page\s+has\s+been\s+denied/i, label: "access_denied" },
    { pattern: /ray\s+id[:\s]+[a-f0-9]+/i, label: "cloudflare" },
    { pattern: /performance\s+&\s+security\s+by\s+cloudflare/i, label: "cloudflare" },
  ];
  
  for (const { pattern, label } of patterns) {
    if (pattern.test(visibleContent)) {
      indicators.push(label);
    }
  }
  
  return indicators;
}

// Scrape Airbnb using Zyte API with browser rendering
async function scrapeAirbnbWithZyte(url: string, zyteApiKey: string): Promise<ZyteAirbnbResult> {
  const result: ZyteAirbnbResult = {
    ok: false,
    markdown: '',
    html: '',
    screenshot: null,
    providerUsed: 'zyte',
    botIndicators: [],
    error: null,
  };
  
  try {
    const zyteAuth = btoa(zyteApiKey + ":");
    
    console.log("Scraping Airbnb with Zyte:", url.slice(0, 100));
    
    const response = await fetchWithTimeout(
      "https://api.zyte.com/v1/extract",
      {
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
          // Click "Show price breakdown" to reveal total with taxes, then wait
          actions: [
            { action: "waitForTimeout", timeout: 5 }, // Wait for initial render
            { 
              action: "click", 
              selector: { type: "css", value: "button[aria-label*='for'][aria-label*='nights']" },
              onError: "ignore" // Continue if button not found
            },
            { action: "waitForTimeout", timeout: 3 }, // Wait for modal to open
          ],
        }),
      },
      60_000 // 60 second timeout for Zyte
    );
    
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      result.error = `Zyte HTTP ${response.status}: ${errText.slice(0, 200)}`;
      console.error("Zyte scrape failed:", result.error);
      return result;
    }
    
    const data = await response.json();
    const html = data.browserHtml || "";
    const screenshot = data.screenshot || null;
    
    if (!html || html.length < 500) {
      result.error = "Zyte returned insufficient content";
      return result;
    }
    
    // Check for bot indicators
    result.botIndicators = detectBotIndicators(html);
    
    if (result.botIndicators.length > 0) {
      console.log("Zyte: Bot indicators detected:", result.botIndicators.join(', '));
      result.error = `Bot detection: ${result.botIndicators.join(', ')}`;
      result.html = html;
      return result;
    }
    
    result.ok = true;
    result.html = html;
    result.screenshot = screenshot;
    
    // Generate simple markdown from HTML (strip tags)
    result.markdown = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    
    console.log("Zyte scrape successful. HTML length:", html.length, "Has screenshot:", !!screenshot);
    
    return result;
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    console.error("Zyte scrape error:", result.error);
    return result;
  }
}

// Track if controller is still valid
const controllerValid = new WeakSet<SSEController>();

function sendSSE(controller: SSEController, event: string, data: any): boolean {
  try {
    if (!controllerValid.has(controller)) return false;
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    controller.enqueue(encoder.encode(message));
    return true;
  } catch (e) {
    console.log("SSE send failed (stream closed):", event);
    controllerValid.delete(controller);
    return false;
  }
}

function sendProgress(controller: SSEController, step: string, detail?: string, meta?: Record<string, any>): boolean {
  return sendSSE(controller, "progress", { step, detail, timestamp: Date.now(), ...meta });
}

function markControllerValid(controller: SSEController) {
  controllerValid.add(controller);
}

function markControllerInvalid(controller: SSEController) {
  controllerValid.delete(controller);
}

// ============================================================================
// Stage Telemetry - Records timing for each pipeline stage
// ============================================================================

type PipelineStageId = 
  | 'analyze_listing'
  | 'collect_photos'
  | 'find_matches'
  | 'validate_dates'
  | 'collect_prices'
  | 'finalize_results';

type StageOutcome = 'running' | 'success' | 'partial' | 'failed' | 'skipped' | 'cancelled';

interface StageRun {
  id: string;
  stageId: PipelineStageId;
  startedAt: number; // timestamp ms
}

// Track active stage runs per search
const activeStageRuns = new Map<string, StageRun>();

async function startStageRun(
  supabase: any,
  searchId: string,
  stageId: PipelineStageId,
  metadata?: Record<string, any>
): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('search_stage_runs')
      .insert({
        search_id: searchId,
        stage_name: stageId,
        started_at: new Date().toISOString(),
        outcome_status: 'running',
        metadata: metadata || {},
      })
      .select('id')
      .single();

    if (error) {
      console.error(`Failed to start stage ${stageId}:`, error.message);
      return null;
    }

    const runId = data.id;
    activeStageRuns.set(`${searchId}:${stageId}`, {
      id: runId,
      stageId,
      startedAt: Date.now(),
    });

    console.log(`STAGE START: ${stageId} for search ${searchId.slice(0, 8)}...`);
    return runId;
  } catch (e) {
    console.error(`Failed to start stage ${stageId}:`, e);
    return null;
  }
}

async function finishStageRun(
  supabase: any,
  searchId: string,
  stageId: PipelineStageId,
  outcome: StageOutcome,
  errorMessage?: string
): Promise<void> {
  try {
    const key = `${searchId}:${stageId}`;
    const activeRun = activeStageRuns.get(key);
    
    if (!activeRun) {
      console.warn(`No active stage run found for ${stageId}`);
      return;
    }

    const durationMs = Date.now() - activeRun.startedAt;
    
    await supabase
      .from('search_stage_runs')
      .update({
        finished_at: new Date().toISOString(),
        outcome_status: outcome,
        error_message: errorMessage || null,
      })
      .eq('id', activeRun.id);

    activeStageRuns.delete(key);
    console.log(`STAGE END: ${stageId} (${outcome}) - ${durationMs}ms`);
  } catch (e) {
    console.error(`Failed to finish stage ${stageId}:`, e);
  }
}

// Convenience wrapper for running a stage with automatic timing
async function withStageTelemetry<T>(
  supabase: any,
  searchId: string,
  stageId: PipelineStageId,
  operation: () => Promise<T>,
  options?: { metadata?: Record<string, any> }
): Promise<{ result: T | null; outcome: StageOutcome; error?: string }> {
  await startStageRun(supabase, searchId, stageId, options?.metadata);
  
  try {
    const result = await operation();
    await finishStageRun(supabase, searchId, stageId, 'success');
    return { result, outcome: 'success' };
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : 'Unknown error';
    await finishStageRun(supabase, searchId, stageId, 'failed', errorMsg);
    return { result: null, outcome: 'failed', error: errorMsg };
  }
}

// ============================================================================


// SerpAPI error types for proper error handling
type SerpApiErrorType = 
  | 'invalid_key'      // 401 - Invalid API key
  | 'quota_exceeded'   // 402 - Account quota exhausted
  | 'rate_limited'     // 429 - Too many requests
  | 'server_error'     // 5xx - SerpAPI server error
  | 'timeout'          // Request timeout
  | 'network_error'    // Network/fetch error
  | 'unknown';         // Unknown error

interface SerpApiResult<T> {
  success: boolean;
  data?: T;
  error?: {
    type: SerpApiErrorType;
    message: string;
    statusCode?: number;
  };
}

// Helper function to make SerpAPI requests with proper error handling
async function fetchSerpApi<T = any>(
  endpoint: string,
  apiKey: string,
  timeoutMs = 30000
): Promise<SerpApiResult<T>> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    
    const response = await fetch(`https://serpapi.com/search.json?${endpoint}&api_key=${apiKey}`, {
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    
    // Handle specific HTTP error codes
    if (!response.ok) {
      const statusCode = response.status;
      let errorType: SerpApiErrorType = 'unknown';
      let message = `SerpAPI request failed with status ${statusCode}`;
      
      switch (statusCode) {
        case 401:
          errorType = 'invalid_key';
          message = 'SerpAPI key is invalid or expired';
          break;
        case 402:
          errorType = 'quota_exceeded';
          message = 'SerpAPI account quota has been exhausted';
          break;
        case 429:
          errorType = 'rate_limited';
          message = 'SerpAPI rate limit exceeded - too many requests';
          break;
        default:
          if (statusCode >= 500) {
            errorType = 'server_error';
            message = `SerpAPI server error (${statusCode})`;
          }
      }
      
      console.error(`SERPAPI_ERROR [${errorType}]: ${message}`);
      return { success: false, error: { type: errorType, message, statusCode } };
    }
    
    const data = await response.json();
    
    // Check for error in response body (SerpAPI sometimes returns 200 with error)
    if (data.error) {
      console.error(`SERPAPI_RESPONSE_ERROR: ${data.error}`);
      return { 
        success: false, 
        error: { 
          type: 'unknown', 
          message: typeof data.error === 'string' ? data.error : JSON.stringify(data.error) 
        } 
      };
    }
    
    return { success: true, data: data as T };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    let errorType: SerpApiErrorType = 'network_error';
    
    if (errorMessage.includes('aborted') || errorMessage.includes('timeout')) {
      errorType = 'timeout';
    }
    
    console.error(`SERPAPI_FETCH_ERROR [${errorType}]: ${errorMessage}`);
    return { success: false, error: { type: errorType, message: errorMessage } };
  }
}

// Track SerpAPI errors during a search session
interface ApiErrorTracker {
  serpApiErrors: Array<{ type: SerpApiErrorType; message: string; timestamp: number }>;
  hasQuotaError: boolean;
  hasRateLimitError: boolean;
  consecutiveErrors: number;
}

function createApiErrorTracker(): ApiErrorTracker {
  return {
    serpApiErrors: [],
    hasQuotaError: false,
    hasRateLimitError: false,
    consecutiveErrors: 0,
  };
}

function recordApiError(tracker: ApiErrorTracker, error: { type: SerpApiErrorType; message: string }): void {
  tracker.serpApiErrors.push({ ...error, timestamp: Date.now() });
  tracker.consecutiveErrors++;
  
  if (error.type === 'quota_exceeded') {
    tracker.hasQuotaError = true;
  }
  if (error.type === 'rate_limited') {
    tracker.hasRateLimitError = true;
  }
}

function resetConsecutiveErrors(tracker: ApiErrorTracker): void {
  tracker.consecutiveErrors = 0;
}

function shouldAbortDueToApiErrors(tracker: ApiErrorTracker): boolean {
  // Abort if we hit quota or have too many consecutive errors
  return tracker.hasQuotaError || tracker.consecutiveErrors >= 5;
}

function getApiErrorSummary(tracker: ApiErrorTracker): string | null {
  if (tracker.serpApiErrors.length === 0) return null;
  
  if (tracker.hasQuotaError) {
    return 'Search service quota exceeded - please try again later';
  }
  if (tracker.hasRateLimitError) {
    return 'Search service temporarily rate limited';
  }
  if (tracker.consecutiveErrors >= 5) {
    return 'Search service experiencing connectivity issues';
  }
  
  return `Search API errors: ${tracker.serpApiErrors.length}`;
}

interface SearchResult {
  platform_name: string;
  listing_url: string;
  listing_title: string | null;
  price: number | null;
  confidence_score: number | null; // null for text-only matches (no visual confirmation)
  image_url: string | null;
  images: string[];
  match_type: 'visual' | 'text'; // Track how match was found
  total_price?: number | null;
  per_night_rate?: number | null;
  source_airbnb_image?: string | null; // The Airbnb image that was used for this match
  price_check_in?: string | null; // Actual dates used for price (may differ from original)
  price_check_out?: string | null;
  dates_differ?: boolean; // True if different dates were used due to unavailability
}

// Use Lovable AI to compare two images and return similarity score (0-100)
// STRICT COMPARISON: Prefers false negatives over false positives
async function compareImagesWithAI(
  airbnbImageUrl: string, 
  alternativeImageUrl: string
): Promise<{ score: number; isMatch: boolean; explanation: string }> {
  const lovableApiKey = Deno.env.get("LOVABLE_API_KEY");
  if (!lovableApiKey) {
    console.log("LOVABLE_API_KEY not available for AI image comparison");
    return { score: 0, isMatch: false, explanation: "AI comparison unavailable" };
  }
  
  try {
    // Enhanced prompt with strict, evidence-driven comparison
    const prompt = `You are a strict forensic image analyst. Your task is to determine whether these two property photos show the EXACT SAME real-world property (same apartment, room, house, building).

CRITICAL RULES - BE CONSERVATIVE:
1. High trust scores (90%+) are RARE and require STRONG evidence
2. It is BETTER to rate a match too LOW than to incorrectly confirm different properties as the same
3. If you have ANY doubt, reduce the score significantly
4. Similar-looking properties are NOT the same property

FOCUS ON FIXED/PERMANENT FEATURES (these rarely change):
- Room geometry: exact wall angles, ceiling height, room shape
- Window placement: exact position, size, shape, number
- Door placement and type
- Architectural details: columns, beams, moldings, built-in shelving
- Kitchen layout: counter shape, cabinet arrangement, appliance positions
- Bathroom fixtures: exact toilet/sink/tub positions
- Flooring pattern and type
- View from windows (if visible)

DO NOT rely heavily on:
- Colors (can be edited, lighting changes)
- Lighting conditions (photos at different times)
- Movable furniture (beds, chairs, tables, decorations)
- Plants, artwork, curtains, rugs (easily changed)
- Photo angle alone (similar angles don't prove same property)

STRUCTURAL DIFFERENCES = NOT THE SAME:
If you see ANY structural difference (different window positions, different room shape, different ceiling, different floor plan), the score MUST be below 70%.

SCORING GUIDELINES:
- 95-100%: Absolutely certain - identical structural features, unmistakable match
- 90-94%: Very confident - same structure, minor angle/lighting differences
- 70-89%: Uncertain - similar but not confirmed (DO NOT mark as match)
- 40-69%: Unlikely - some similarities but notable differences
- 0-39%: Different properties

Compare these images:
Image 1 (Source/Airbnb): ${airbnbImageUrl}
Image 2 (Alternative): ${alternativeImageUrl}

Analyze the STRUCTURAL features carefully. List specific evidence for or against a match.

Return ONLY valid JSON in this format:
{"score": NUMBER_0_TO_100, "isMatch": BOOLEAN, "explanation": "Evidence-based reason citing specific structural features"}

isMatch must be true ONLY if score >= 90 AND you have strong structural evidence.`;

    const response = await fetchWithTimeout(
      "https://ai.gateway.lovable.dev/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${lovableApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                { type: "image_url", image_url: { url: airbnbImageUrl } },
                { type: "image_url", image_url: { url: alternativeImageUrl } },
              ],
            },
          ],
          max_tokens: 300,
        }),
      },
      15_000
    );
    
    if (!response.ok) {
      console.error("Lovable AI image comparison failed:", response.status);
      return { score: 0, isMatch: false, explanation: "AI comparison request failed" };
    }
    
    const data = await response.json();
    const resultText = data.choices?.[0]?.message?.content?.trim();
    
    if (!resultText) {
      console.log("AI returned empty response for image comparison");
      return { score: 0, isMatch: false, explanation: "Empty AI response" };
    }
    
    // Parse JSON response
    try {
      // Extract JSON from response (may have markdown formatting)
      const jsonMatch = resultText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        let score = Number(parsed.score) || 0;
        score = Math.min(100, Math.max(0, score));
        
        // Extra conservative check: only mark as match if BOTH score >= 90 AND AI explicitly said isMatch
        const aiSaidMatch = parsed.isMatch === true;
        const scoreIsHigh = score >= 90;
        const isMatch = aiSaidMatch && scoreIsHigh;
        
        // Log comparison result for debugging
        console.log(`AI comparison: score=${score}, aiSaidMatch=${aiSaidMatch}, final isMatch=${isMatch}`);
        
        return {
          score,
          isMatch,
          explanation: parsed.explanation || "No explanation provided"
        };
      }
    } catch (parseError) {
      console.error("Failed to parse AI comparison response:", resultText);
    }
    
    return { score: 0, isMatch: false, explanation: "Failed to parse AI response" };
  } catch (error) {
    console.error("AI image comparison error:", error);
    return { score: 0, isMatch: false, explanation: "Comparison error" };
  }
}

// Try to extract price from JSON-LD structured data (most reliable for Airbnb)
function extractPriceFromJsonLD(content: string): number | null {
  try {
    // Look for JSON-LD script tags
    const jsonLdMatches = content.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
    if (jsonLdMatches) {
      for (const match of jsonLdMatches) {
        const jsonContent = match.replace(/<script[^>]*>|<\/script>/gi, '');
        try {
          const data = JSON.parse(jsonContent);
          // Check for offers/price in structured data
          if (data.offers?.price) {
            const price = parseFloat(data.offers.price);
            if (price >= 15 && price <= 5000) {
              console.log("JSON-LD extracted price:", price);
              return price;
            }
          }
          if (data.priceRange) {
            const priceMatch = data.priceRange.match(/\$?(\d+)/);
            if (priceMatch) {
              const price = parseFloat(priceMatch[1]);
              if (price >= 15 && price <= 5000) {
                console.log("JSON-LD priceRange extracted:", price);
                return price;
              }
            }
          }
        } catch (e) {
          // Continue to next JSON-LD block
        }
      }
    }
  } catch (e) {
    console.error("JSON-LD extraction error:", e);
  }
  return null;
}

// Try to extract TOTAL STAY PRICE with regex patterns first (faster, more reliable for common formats)
// Returns TOTAL price for the entire stay, NOT per-night
function extractTotalPriceWithRegex(content: string, nights: number): number | null {
  console.log("Attempting regex TOTAL price extraction, content length:", content.length, "nights:", nights);
  
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
  
  // Collect all potential final totals and pick the highest reasonable one
  // (taxes will make the final total higher than the subtotal)
  let potentialTotals: number[] = [];
  
  for (const pattern of finalTotalPatterns) {
    const matches = [...content.matchAll(pattern)];
    for (const match of matches) {
      const totalPrice = parseFloat((match[1] || "").replace(/,/g, ''));
      if (totalPrice >= 30 && totalPrice <= 200000) {
        potentialTotals.push(totalPrice);
        console.log("Found potential final total:", totalPrice, "from pattern:", match[0].slice(0, 50));
      }
    }
  }
  
  // Priority 1: Look for "X for Y nights" pattern - this is the subtotal (before taxes)
  const totalNightsPatterns = [
    // aria-label="$137 for 2 nights" - Airbnb's common format
    /aria-label=["']?\$?\s*(\d{1,5}(?:,\d{3})?(?:\.\d{2})?)\s+(?:for\s+)?(\d+)\s*nights?["']?/gi,
    // "$137 for 2 nights" in visible text
    /\$\s*(\d{1,5}(?:,\d{3})?(?:\.\d{2})?)\s+for\s+(\d+)\s*nights?/gi,
    // "€137 for 2 nights"
    /[€£]\s*(\d{1,5}(?:,\d{3})?(?:\.\d{2})?)\s+for\s+(\d+)\s*nights?/gi,
  ];
  
  let subtotalForNights: number | null = null;
  
  for (const pattern of totalNightsPatterns) {
    const matches = [...content.matchAll(pattern)];
    for (const match of matches) {
      const totalPrice = parseFloat((match[1] || "").replace(/,/g, ''));
      const detectedNights = parseInt(match[2], 10);
      if (totalPrice >= 20 && totalPrice <= 100000 && detectedNights > 0) {
        console.log("Found subtotal for nights:", totalPrice, "for", detectedNights, "nights");
        subtotalForNights = totalPrice;
        potentialTotals.push(totalPrice);
        break;
      }
    }
    if (subtotalForNights) break;
  }
  
  // If we found multiple totals, prefer the highest one (likely includes taxes)
  // but only if it's within 30% higher than the subtotal (reasonable tax range)
  if (potentialTotals.length > 0) {
    const maxTotal = Math.max(...potentialTotals);
    const minTotal = Math.min(...potentialTotals);
    
    // If we have a subtotal and a higher total (within 30%), use the higher one
    if (subtotalForNights && maxTotal > subtotalForNights && maxTotal <= subtotalForNights * 1.3) {
      console.log("Using final total with taxes:", maxTotal, "(subtotal was", subtotalForNights, ")");
      return maxTotal;
    }
    
    // Otherwise use the subtotal if available
    if (subtotalForNights) {
      console.log("Using subtotal (no valid tax-inclusive total found):", subtotalForNights);
      return subtotalForNights;
    }
    
    // Fallback to highest found
    console.log("Using highest potential total:", maxTotal);
    return maxTotal;
  }
  
  // Priority 2: Look for explicit "total" price indicators
  
  // Priority 3: If we only find a per-night price, DO NOT compute totals.
  // We must show the total Airbnb shows; if it's not visible as a total, treat as unavailable.
  // (Prevents incorrect values like "$X/night" being multiplied into a fake "total".)
  return null;
}

// Use Lovable AI to extract Airbnb TOTAL STAY PRICE (including mandatory fees) from scraped content.
// Returns the TOTAL price for the entire stay, NOT per-night.
async function extractAirbnbTotalPriceWithAI(content: string, nights: number): Promise<number | null> {
  // Try regex extraction first (fast path)
  const regexTotal = extractTotalPriceWithRegex(content, nights);
  if (regexTotal) {
    console.log("Using regex-extracted TOTAL price:", regexTotal);
    return regexTotal;
  }

  const lovableApiKey = Deno.env.get("LOVABLE_API_KEY");
  if (!lovableApiKey) {
    console.log("LOVABLE_API_KEY not available for AI price extraction");
    return null;
  }

  try {
  const prompt = `You are analyzing text scraped from an Airbnb listing page.
The stay is for exactly ${nights} night(s).

Goal: Extract the TOTAL price for the ENTIRE stay as shown by Airbnb (including mandatory fees/taxes if included in the displayed total).

Rules:
- Return the TOTAL price for the whole stay, NOT per-night.
- Look for patterns like "$X for Y nights", "Total: $X", "Trip total: $X", "Total before taxes: $X".
- IMPORTANT: If the page only shows a per-night rate and no total, return "null" (do NOT multiply).
- If you find "Total before taxes", return that number.

Content:
${content.slice(0, 12000)}

Return ONLY a single number representing the TOTAL price for the entire stay (no currency symbol).
If you cannot find a reliable total, return "null".`;

    const response = await fetchWithTimeout(
      "https://ai.gateway.lovable.dev/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${lovableApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [{ role: "user", content: prompt }],
          max_tokens: 50,
        }),
      },
      15_000
    );

    if (!response.ok) {
      console.error("Lovable AI request failed:", response.status);
      return null;
    }

    const data = await response.json();
    const totalText = data.choices?.[0]?.message?.content?.trim();

    if (!totalText || totalText.toLowerCase() === "null") {
      console.log("AI could not extract total price from content");
      return null;
    }

    const total = parseFloat(totalText.replace(/[^0-9.]/g, ""));
    if (isNaN(total) || total < 20 || total > 500000) {
      console.log("AI returned invalid total:", totalText);
      return null;
    }

    console.log("AI extracted TOTAL price:", total, "for", nights, "nights");
    return total;
  } catch (error) {
    console.error("AI price extraction error:", error);
    return null;
  }
}

// Use AI to extract price from alternative booking platforms (Booking.com, TripAdvisor, etc.)
async function extractAlternativePlatformPriceWithAI(
  content: string,
  platformName: string,
  checkIn: string,
  checkOut: string,
  nights: number,
): Promise<{
  perNight: number | null;
  total: number | null;
  currency: string | null;
  confidence: "high" | "medium" | "low";
  datesConfirmed: boolean;
  reasoning?: string;
}> {
  const lovableApiKey = Deno.env.get("LOVABLE_API_KEY");
  if (!lovableApiKey) {
    console.log("LOVABLE_API_KEY not available for AI price extraction");
    return { perNight: null, total: null, currency: null, confidence: "low", datesConfirmed: false };
  }

  try {
    const prompt = `You are analyzing text scraped from a ${platformName} booking page.
The dates being checked are: ${checkIn} to ${checkOut} (${nights} night(s)).

Goal: Extract the booking price for THESE specific dates.

CRITICAL REQUIREMENT:
- You must first decide if the page content indicates the property is available AND the page is showing pricing for the requested dates.
- If you cannot CONFIRM the dates in the content, set datesConfirmed=false and do not guess a price.

Rules:
1) Look for prices clearly associated with booking this property.
2) Prefer TOTAL price for the stay (incl. mandatory fees/taxes if shown).
3) If only per-night is shown, return perNight.
4) Ignore prices that are review counts, distances, guest counts, or prices for other properties.
5) Be conservative: if you are not sure the price is for ${checkIn} to ${checkOut}, return nulls.

Scraped content (first 10000 chars):
${content.slice(0, 10000)}

Return ONLY JSON in this exact format:
{"total": <number|null>, "perNight": <number|null>, "currency": <string|null>, "confidence": "high"|"medium"|"low", "datesConfirmed": <true|false>, "reasoning": <string>}`;

    const response = await fetchWithTimeout(
      "https://ai.gateway.lovable.dev/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${lovableApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [{ role: "user", content: prompt }],
          max_tokens: 240,
        }),
      },
      20_000,
    );

    if (!response.ok) {
      console.error("AI price extraction failed:", response.status);
      return { perNight: null, total: null, currency: null, confidence: "low", datesConfirmed: false };
    }

    const data = await response.json();
    const responseText = data.choices?.[0]?.message?.content?.trim() || "";

    // Parse JSON from response (handle markdown code blocks)
    let jsonStr = responseText;
    const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    } else if (responseText.startsWith("{")) {
      jsonStr = responseText;
    }

    try {
      const parsed = JSON.parse(jsonStr);
      console.log(`AI price extraction for ${platformName}:`, parsed);

      const confidenceRaw = String(parsed.confidence || "low").toLowerCase();
      const confidence = (confidenceRaw === "high" || confidenceRaw === "medium" || confidenceRaw === "low")
        ? (confidenceRaw as "high" | "medium" | "low")
        : "low";

      const datesConfirmed = Boolean(parsed.datesConfirmed);

      // If dates are not confirmed, do not accept any price.
      if (!datesConfirmed) {
        return {
          perNight: null,
          total: null,
          currency: parsed.currency || null,
          confidence,
          datesConfirmed: false,
          reasoning: parsed.reasoning || undefined,
        };
      }

      // Validate the extracted prices
      let total = typeof parsed.total === "number" ? parsed.total : null;
      let perNight = typeof parsed.perNight === "number" ? parsed.perNight : null;

      // If only total is provided, calculate per-night
      if (total && !perNight && nights > 0) {
        perNight = Math.round(total / nights);
      }

      // If only per-night is provided, calculate total
      if (perNight && !total && nights > 0) {
        total = perNight * nights;
      }

      // Validate reasonable price ranges
      if (perNight && (perNight < 5 || perNight > 10000)) {
        console.log(`AI extracted unreasonable per-night price: ${perNight}`);
        return { perNight: null, total: null, currency: null, confidence: "low", datesConfirmed: false };
      }

      if (confidence === "low" && !perNight && !total) {
        return { perNight: null, total: null, currency: null, confidence: "low", datesConfirmed: false };
      }

      return {
        perNight: perNight || null,
        total: total || null,
        currency: parsed.currency || null,
        confidence,
        datesConfirmed,
        reasoning: parsed.reasoning || undefined,
      };
    } catch (parseErr) {
      console.error("Failed to parse AI response:", responseText.slice(0, 200));
      return { perNight: null, total: null, currency: null, confidence: "low", datesConfirmed: false };
    }
  } catch (error) {
    console.error("AI price extraction error:", error);
    return { perNight: null, total: null, currency: null, confidence: "low", datesConfirmed: false };
  }
}

// Screenshot-based fallback: ask the multimodal model to read the total from the rendered page.
async function extractAirbnbTotalFromScreenshotBase64(screenshotBase64: string, nights: number): Promise<number | null> {
  const lovableApiKey = Deno.env.get("LOVABLE_API_KEY");
  if (!lovableApiKey) return null;

  try {
    const prompt = `This is a screenshot of an Airbnb listing page with dates already selected.

Task:
1) Read the TOTAL price for the stay shown on the page (prefer the final total a guest pays; if only "Total before taxes" is visible, return that).
2) Return ONLY the total number (no currency symbols).
If you cannot find a total price in the screenshot, return "null".`;

    const imageUrl = `data:image/png;base64,${screenshotBase64}`;

    const response = await fetchWithTimeout(
      "https://ai.gateway.lovable.dev/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${lovableApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                { type: "image_url", image_url: { url: imageUrl } },
              ],
            },
          ],
          max_tokens: 50,
        }),
      },
      20_000
    );

    if (!response.ok) {
      console.error("Screenshot AI request failed:", response.status);
      return null;
    }

    const data = await response.json();
    const totalText = data.choices?.[0]?.message?.content?.trim();
    if (!totalText || totalText.toLowerCase() === "null") return null;

    const total = parseFloat(totalText.replace(/[^0-9.]/g, ""));
    if (isNaN(total) || total < 20 || total > 200000) return null;

    console.log("Screenshot extracted total:", total);
    return total;
  } catch (e) {
    console.error("Screenshot price extraction error:", e);
    return null;
  }
}

// ===============================================
// PLATFORM ADAPTER SYSTEM - Deep Link Generation
// ===============================================

// Platform capability classification
type PlatformCapability = "url_driven" | "api_driven" | "session_driven";
type LinkReliability = "high" | "medium" | "low";

interface PlatformAdapter {
  name: string;
  capability: PlatformCapability;
  reliability: LinkReliability;
  domains: string[];
  // Generate the best deep link for a property with dates
  generateDeepLink: (
    baseUrl: string,
    checkIn: string,
    checkOut: string,
    adults?: number,
    children?: number,
    rooms?: number
  ) => string;
  // Platform-specific wait time for JS rendering
  scrapeWaitTime: number;
  // Whether to use screenshot fallback for pricing
  useScreenshotFallback: boolean;
  // Platform-specific price extraction hints
  pricePatterns?: RegExp[];
}

// Booking.com Adapter - IMPROVED with better URL handling
const bookingComAdapter: PlatformAdapter = {
  name: "Booking.com",
  capability: "session_driven",
  reliability: "medium",
  domains: ["booking.com"],
  scrapeWaitTime: 15000, // Increased wait time for dynamic content
  useScreenshotFallback: true,
  generateDeepLink: (baseUrl, checkIn, checkOut, adults = 2, children = 0, rooms = 1) => {
    try {
      const url = new URL(baseUrl);
      
      // Remove ALL existing date/session params to avoid conflicts
      const paramsToRemove = [
        "checkin", "checkout", "checkin_month", "checkin_monthday", "checkin_year",
        "checkout_month", "checkout_monthday", "checkout_year",
        "all_sr_blocks", "sr_pri_blocks", "matching_block_id", "srpvid", "srepoch",
        "dist", "type", "ucfs", "highlighted_blocks"
      ];
      paramsToRemove.forEach(p => url.searchParams.delete(p));
      
      // Booking.com uses YYYY-MM-DD format
      url.searchParams.set("checkin", checkIn);
      url.searchParams.set("checkout", checkOut);
      url.searchParams.set("group_adults", adults.toString());
      url.searchParams.set("group_children", children.toString());
      url.searchParams.set("no_rooms", rooms.toString());
      url.searchParams.set("selected_currency", "EUR");
      
      // Force fresh search without cached session data
      url.searchParams.set("req_adults", adults.toString());
      url.searchParams.set("req_children", children.toString());
      
      console.log(`[BOOKING.COM] Generated deep link: ${url.toString().slice(0, 200)}`);
      return url.toString();
    } catch (e) {
      console.error(`[BOOKING.COM] Deep link generation failed:`, e);
      return baseUrl;
    }
  },
  pricePatterns: [
    /€\s*(\d{1,3}(?:[,.']\d{3})*(?:[.,]\d{2})?)/gi,
    /(\d{1,3}(?:[,.']\d{3})*(?:[.,]\d{2})?)\s*€/gi,
    /EUR\s*(\d{1,3}(?:[,.']\d{3})*)/gi,
    /price["\s:]+(\d{2,6})/gi,
  ],
};

// Vrbo/HomeAway Adapter (Expedia Group) - IMPROVED
const vrboAdapter: PlatformAdapter = {
  name: "Vrbo",
  capability: "url_driven",
  reliability: "high",
  domains: ["vrbo.com", "homeaway.com", "homeaway.de", "homeaway.fr", "homeaway.es", "homeaway.it", "homeaway.co.uk"],
  scrapeWaitTime: 10000,
  useScreenshotFallback: true,
  generateDeepLink: (baseUrl, checkIn, checkOut, adults = 2, children = 0) => {
    try {
      const url = new URL(baseUrl);
      // Clear existing date params
      ["arrival", "departure", "startDate", "endDate", "adults", "children"].forEach(p => url.searchParams.delete(p));
      
      // Vrbo uses arrival/departure format (YYYY-MM-DD)
      url.searchParams.set("arrival", checkIn);
      url.searchParams.set("departure", checkOut);
      url.searchParams.set("adults", adults.toString());
      if (children > 0) {
        url.searchParams.set("children", children.toString());
      }
      
      console.log(`[VRBO] Generated deep link: ${url.toString().slice(0, 200)}`);
      return url.toString();
    } catch (e) {
      console.error(`[VRBO] Deep link generation failed:`, e);
      return baseUrl;
    }
  },
};

// Expedia Adapter - IMPROVED
const expediaAdapter: PlatformAdapter = {
  name: "Expedia",
  capability: "url_driven",
  reliability: "high",
  domains: ["expedia.com", "expedia.de", "expedia.fr", "expedia.co.uk", "expedia.es", "expedia.it", "expedia.nl", "expedia.be"],
  scrapeWaitTime: 10000,
  useScreenshotFallback: true,
  generateDeepLink: (baseUrl, checkIn, checkOut, adults = 2, children = 0, rooms = 1) => {
    try {
      const url = new URL(baseUrl);
      // Clear existing params
      ["chkin", "chkout", "rm1", "startDate", "endDate"].forEach(p => url.searchParams.delete(p));
      
      // Expedia uses chkin/chkout format (YYYY-MM-DD)
      url.searchParams.set("chkin", checkIn);
      url.searchParams.set("chkout", checkOut);
      url.searchParams.set("rm1", `a${adults}${children > 0 ? `c${children}` : ""}`);
      
      console.log(`[EXPEDIA] Generated deep link: ${url.toString().slice(0, 200)}`);
      return url.toString();
    } catch (e) {
      console.error(`[EXPEDIA] Deep link generation failed:`, e);
      return baseUrl;
    }
  },
};

// Hotels.com Adapter (Expedia Group) - IMPROVED
const hotelsComAdapter: PlatformAdapter = {
  name: "Hotels.com",
  capability: "url_driven",
  reliability: "high",
  domains: ["hotels.com", "hotels.de", "hotels.fr", "hotels.co.uk"],
  scrapeWaitTime: 10000,
  useScreenshotFallback: true,
  generateDeepLink: (baseUrl, checkIn, checkOut, adults = 2, children = 0, rooms = 1) => {
    try {
      const url = new URL(baseUrl);
      ["checkIn", "checkOut", "adults", "children", "rooms"].forEach(p => url.searchParams.delete(p));
      
      url.searchParams.set("checkIn", checkIn);
      url.searchParams.set("checkOut", checkOut);
      url.searchParams.set("adults", adults.toString());
      url.searchParams.set("children", children.toString());
      url.searchParams.set("rooms", rooms.toString());
      
      console.log(`[HOTELS.COM] Generated deep link: ${url.toString().slice(0, 200)}`);
      return url.toString();
    } catch (e) {
      console.error(`[HOTELS.COM] Deep link generation failed:`, e);
      return baseUrl;
    }
  },
};

// Agoda Adapter - IMPROVED with better date handling
const agodaAdapter: PlatformAdapter = {
  name: "Agoda",
  capability: "url_driven",
  reliability: "medium",
  domains: ["agoda.com", "agoda.de", "agoda.fr", "agoda.co.uk"],
  scrapeWaitTime: 12000,
  useScreenshotFallback: true,
  generateDeepLink: (baseUrl, checkIn, checkOut, adults = 2, children = 0, rooms = 1) => {
    try {
      const url = new URL(baseUrl);
      ["checkIn", "checkOut", "los", "rooms", "adults", "children"].forEach(p => url.searchParams.delete(p));
      
      // Agoda prefers checkIn/checkOut (YYYY-MM-DD)
      url.searchParams.set("checkIn", checkIn);
      url.searchParams.set("checkOut", checkOut);
      url.searchParams.set("rooms", rooms.toString());
      url.searchParams.set("adults", adults.toString());
      url.searchParams.set("children", children.toString());
      url.searchParams.set("cid", "1844104"); // Affiliate tracking (generic)
      
      console.log(`[AGODA] Generated deep link: ${url.toString().slice(0, 200)}`);
      return url.toString();
    } catch (e) {
      console.error(`[AGODA] Deep link generation failed:`, e);
      return baseUrl;
    }
  },
};

// TripAdvisor Adapter - IMPROVED with better URL pattern handling
const tripAdvisorAdapter: PlatformAdapter = {
  name: "TripAdvisor",
  capability: "session_driven",
  reliability: "medium", // Upgraded from low - better handling now
  domains: ["tripadvisor.com", "tripadvisor.de", "tripadvisor.fr", "tripadvisor.co.uk", "tripadvisor.ch", "tripadvisor.co.za", "tripadvisor.it", "tripadvisor.es"],
  scrapeWaitTime: 15000, // Increased for dynamic content
  useScreenshotFallback: true,
  generateDeepLink: (baseUrl, checkIn, checkOut, adults = 2, children = 0, rooms = 1) => {
    try {
      const url = new URL(baseUrl);
      
      // TripAdvisor has multiple URL formats - handle the common ones
      // Clear existing params
      ["checkin", "checkout", "adults", "rooms", "checkIn", "checkOut"].forEach(p => url.searchParams.delete(p));
      
      // TripAdvisor uses YYYY-MM-DD format
      url.searchParams.set("checkin", checkIn);
      url.searchParams.set("checkout", checkOut);
      url.searchParams.set("adults", adults.toString());
      url.searchParams.set("rooms", rooms.toString());
      
      // Add currency parameter for consistent pricing
      url.searchParams.set("currency", "EUR");
      
      console.log(`[TRIPADVISOR] Generated deep link: ${url.toString().slice(0, 200)}`);
      return url.toString();
    } catch (e) {
      console.error(`[TRIPADVISOR] Deep link generation failed:`, e);
      return baseUrl;
    }
  },
};

// HolidayCheck Adapter - IMPROVED
const holidayCheckAdapter: PlatformAdapter = {
  name: "HolidayCheck",
  capability: "session_driven",
  reliability: "medium", // Upgraded from low
  domains: ["holidaycheck.de", "holidaycheck.at", "holidaycheck.ch"],
  scrapeWaitTime: 15000,
  useScreenshotFallback: true,
  generateDeepLink: (baseUrl, checkIn, checkOut, adults = 2, children = 0, rooms = 1) => {
    try {
      const url = new URL(baseUrl);
      ["checkin", "checkout", "adults", "rooms", "departureDate", "returnDate"].forEach(p => url.searchParams.delete(p));
      
      url.searchParams.set("departureDate", checkIn);
      url.searchParams.set("returnDate", checkOut);
      url.searchParams.set("adults", adults.toString());
      url.searchParams.set("rooms", rooms.toString());
      
      console.log(`[HOLIDAYCHECK] Generated deep link: ${url.toString().slice(0, 200)}`);
      return url.toString();
    } catch (e) {
      console.error(`[HOLIDAYCHECK] Deep link generation failed:`, e);
      return baseUrl;
    }
  },
};

// NEW: Hostelworld Adapter
const hostelworldAdapter: PlatformAdapter = {
  name: "Hostelworld",
  capability: "url_driven",
  reliability: "medium",
  domains: ["hostelworld.com"],
  scrapeWaitTime: 10000,
  useScreenshotFallback: true,
  generateDeepLink: (baseUrl, checkIn, checkOut, adults = 2) => {
    try {
      const url = new URL(baseUrl);
      ["from", "to", "guests"].forEach(p => url.searchParams.delete(p));
      
      // Hostelworld uses from/to with YYYY-MM-DD
      url.searchParams.set("from", checkIn);
      url.searchParams.set("to", checkOut);
      url.searchParams.set("guests", adults.toString());
      
      console.log(`[HOSTELWORLD] Generated deep link: ${url.toString().slice(0, 200)}`);
      return url.toString();
    } catch (e) {
      console.error(`[HOSTELWORLD] Deep link generation failed:`, e);
      return baseUrl;
    }
  },
};

// NEW: Rentbyowner Adapter (common in visual search results)
const rentbyownerAdapter: PlatformAdapter = {
  name: "Rentbyowner",
  capability: "url_driven",
  reliability: "medium",
  domains: ["rentbyowner.com", "rentbyowner.net"],
  scrapeWaitTime: 10000,
  useScreenshotFallback: true,
  generateDeepLink: (baseUrl, checkIn, checkOut, adults = 2) => {
    try {
      const url = new URL(baseUrl);
      ["checkin", "checkout", "arrival", "departure"].forEach(p => url.searchParams.delete(p));
      
      url.searchParams.set("arrival", checkIn);
      url.searchParams.set("departure", checkOut);
      url.searchParams.set("guests", adults.toString());
      
      console.log(`[RENTBYOWNER] Generated deep link: ${url.toString().slice(0, 200)}`);
      return url.toString();
    } catch (e) {
      console.error(`[RENTBYOWNER] Deep link generation failed:`, e);
      return baseUrl;
    }
  },
};

// NEW: HRS Adapter
const hrsAdapter: PlatformAdapter = {
  name: "HRS",
  capability: "url_driven",
  reliability: "medium",
  domains: ["hrs.de", "hrs.com"],
  scrapeWaitTime: 10000,
  useScreenshotFallback: true,
  generateDeepLink: (baseUrl, checkIn, checkOut, adults = 2, children = 0, rooms = 1) => {
    try {
      const url = new URL(baseUrl);
      ["arrivalDate", "departureDate", "adults", "children", "rooms"].forEach(p => url.searchParams.delete(p));
      
      url.searchParams.set("arrivalDate", checkIn);
      url.searchParams.set("departureDate", checkOut);
      url.searchParams.set("adults", adults.toString());
      url.searchParams.set("rooms", rooms.toString());
      
      console.log(`[HRS] Generated deep link: ${url.toString().slice(0, 200)}`);
      return url.toString();
    } catch (e) {
      console.error(`[HRS] Deep link generation failed:`, e);
      return baseUrl;
    }
  },
};

// Generic/Direct Booking Adapter - IMPROVED with multiple param attempts
const genericAdapter: PlatformAdapter = {
  name: "Direct Booking",
  capability: "url_driven",
  reliability: "low",
  domains: [],
  scrapeWaitTime: 10000,
  useScreenshotFallback: true,
  generateDeepLink: (baseUrl, checkIn, checkOut, adults = 2) => {
    try {
      const url = new URL(baseUrl);
      
      // Try to add dates with common parameter names (most sites use at least one)
      // Don't add ALL params - pick the most common ones
      if (!url.searchParams.has("checkin") && !url.searchParams.has("check_in") && !url.searchParams.has("arrival")) {
        url.searchParams.set("checkin", checkIn);
        url.searchParams.set("checkout", checkOut);
      }
      
      console.log(`[GENERIC] Generated deep link: ${url.toString().slice(0, 200)}`);
      return url.toString();
    } catch (e) {
      console.error(`[GENERIC] Deep link generation failed:`, e);
      return baseUrl;
    }
  },
};

// Platform adapter registry - EXPANDED
const platformAdapters: PlatformAdapter[] = [
  bookingComAdapter,
  vrboAdapter,
  expediaAdapter,
  hotelsComAdapter,
  agodaAdapter,
  tripAdvisorAdapter,
  holidayCheckAdapter,
  hostelworldAdapter,
  rentbyownerAdapter,
  hrsAdapter,
];

// Get the appropriate adapter for a URL
function getPlatformAdapter(url: string): PlatformAdapter {
  const lowercaseUrl = url.toLowerCase();
  for (const adapter of platformAdapters) {
    if (adapter.domains.some(domain => lowercaseUrl.includes(domain))) {
      return adapter;
    }
  }
  return genericAdapter;
}

// Generate optimized deep link using platform adapter
function generatePricedDeepLink(
  url: string,
  checkIn: string,
  checkOut: string,
  adults: number = 2,
  children: number = 0,
  rooms: number = 1
): { deepLink: string; adapter: PlatformAdapter; reliability: LinkReliability } {
  const adapter = getPlatformAdapter(url);
  const deepLink = adapter.generateDeepLink(url, checkIn, checkOut, adults, children, rooms);
  return { deepLink, adapter, reliability: adapter.reliability };
}

// Expanded platform list for better coverage - including international variants
function getPlatformName(url: string): string {
  const lowercaseUrl = url.toLowerCase();
  if (lowercaseUrl.includes("vrbo.com")) return "Vrbo";
  if (lowercaseUrl.includes("booking.com")) return "Booking.com";
  if (lowercaseUrl.includes("expedia.")) return "Expedia";
  if (lowercaseUrl.includes("hotels.com")) return "Hotels.com";
  if (lowercaseUrl.includes("tripadvisor.")) return "TripAdvisor";
  if (lowercaseUrl.includes("homeaway.")) return "HomeAway";
  if (lowercaseUrl.includes("vacasa.com")) return "Vacasa";
  if (lowercaseUrl.includes("agoda.")) return "Agoda";
  if (lowercaseUrl.includes("hometogo.")) return "HomeToGo";
  if (lowercaseUrl.includes("holidu.")) return "Holidu";
  if (lowercaseUrl.includes("holidaycheck.")) return "HolidayCheck";
  if (lowercaseUrl.includes("hrs.")) return "HRS";
  if (lowercaseUrl.includes("hostelworld.")) return "Hostelworld";
  if (lowercaseUrl.includes("rentbyowner.")) return "Rentbyowner";
  if (lowercaseUrl.includes("interhome.")) return "Interhome";
  if (lowercaseUrl.includes("flipkey.")) return "FlipKey";
  if (lowercaseUrl.includes("atraveo.")) return "Atraveo";
  if (lowercaseUrl.includes("fewo-direkt.")) return "FeWo-direkt";
  if (lowercaseUrl.includes("traum-ferienwohnungen.")) return "Traum-Ferienwohnungen";
  if (lowercaseUrl.includes("casamundo.")) return "Casamundo";
  if (lowercaseUrl.includes("kayak.")) return "Kayak";
  if (lowercaseUrl.includes("trivago.")) return "Trivago";
  if (lowercaseUrl.includes("trip.com")) return "Trip.com";
  if (lowercaseUrl.includes("makemytrip.")) return "MakeMyTrip";
  if (lowercaseUrl.includes("hostel.com")) return "Hostel.com";
  if (lowercaseUrl.includes("priceline.")) return "Priceline";
  if (lowercaseUrl.includes("travelocity.")) return "Travelocity";
  if (lowercaseUrl.includes("orbitz.")) return "Orbitz";
  if (lowercaseUrl.includes("hotwire.")) return "Hotwire";
  if (lowercaseUrl.includes("cheaptickets.")) return "CheapTickets";
  if (lowercaseUrl.includes("hotelstonight.")) return "Hotels Tonight";
  if (lowercaseUrl.includes("getaroom.")) return "GetARoom";
  if (lowercaseUrl.includes("hotel.")) return "Hotel.com";
  
  try {
    const domain = new URL(url).hostname.replace("www.", "");
    const name = domain.split(".")[0];
    return name.charAt(0).toUpperCase() + name.slice(1);
  } catch {
    return "Other Platform";
  }
}

// Expanded booking platform check with all international TLDs - comprehensive list
function isBookingPlatform(url: string): boolean {
  const lowercaseUrl = url.toLowerCase();
  const platforms = [
    // Major global platforms
    "vrbo.com", "booking.com", "expedia.", "hotels.com", 
    "tripadvisor.", // covers .com, .ch, .de, .fr, .it, .co.za, etc.
    "homeaway.", "vacasa.com", "agoda.", "hometogo.", "holidu.",
    "rentbyowner.", // Common in visual search results
    // European platforms
    "interhome.", "flipkey.", "atraveo.", "holidaycheck.", 
    "hrs.", "hrs.com", "hrs.de", // HRS variations
    "hostelworld.", "fewo-direkt.", "traum-ferienwohnungen.",
    "casamundo.", "kayak.", "trivago.", "trip.com", "makemytrip.",
    "priceline.", "travelocity.", "orbitz.", "hotwire.", "cheaptickets.",
    "hotelstonight.", "getaroom.",
    // Additional international platforms
    "hotel.de", "hotel.info", "hotel-mix.",
    "easyjet.com/en/hotels", "lastminute.",
    "laterooms.", "opodo.", "edreams.", "destinia.",
    "centraldereservas.", "logitravel.",
    // Regional South Africa platforms
    "safarinow.", "lekkeslaap.", "nightsbridge.",
    "sa-venues.", "wheretostay.", "travelground.",
    // Metasearch that show direct links
    "skyscanner.", "momondo.", "cheapflights.",
    // Direct hotel booking aggregators
    "-hotels-", "hotels-", // Pattern for regional hotel sites like "capetown-hotels-za.com"
  ];
  return platforms.some(p => lowercaseUrl.includes(p));
}

// Additional check for regional hotel booking domains (like maison-b.capetown-hotels-za.com)
function isRegionalHotelSite(url: string): boolean {
  const lowercaseUrl = url.toLowerCase();
  // Pattern: property-name.location-hotels-countrycode.com
  const hotelDomainPattern = /[a-z0-9-]+\.[a-z]+-hotels-[a-z]{2}\.com/;
  if (hotelDomainPattern.test(lowercaseUrl)) return true;
  
  // Other regional booking patterns
  const regionalPatterns = [
    /[a-z]+\.hotels-[a-z]+\.com/,
    /book[a-z]*\.[a-z]+\.com/,
    /reserve\.[a-z]+\.com/,
  ];
  return regionalPatterns.some(p => p.test(lowercaseUrl));
}

// Enhanced direct property site detection - more permissive for hotel/guesthouse sites
function isDirectPropertySite(url: string): boolean {
  const lowercaseUrl = url.toLowerCase();
  
  // Exclude major platforms, social media, generic sites, and search engines
  const excludePatterns = [
    "airbnb.", "google.", "facebook.", "instagram.", "twitter.", "pinterest.",
    "youtube.", "wikipedia.", "yelp.", "maps.", "cloudflare.",
    ".gov", ".edu", "amazon.", "ebay.", "craigslist.", "tiktok.",
    "linkedin.", "reddit.", "quora.", "medium.", "tumblr.",
    "serpapi.", "bing.", "yahoo.", "duckduckgo."
  ];
  
  if (excludePatterns.some(p => lowercaseUrl.includes(p))) return false;
  
  // Look for property-related keywords in URL - expanded list
  const propertyKeywords = [
    "villa", "cottage", "cabin", "chalet", "apartment", "flat", "house",
    "rental", "holiday", "vacation", "stay", "lodge", "guest", "bnb",
    "ferienwohnung", "ferienhaus", "gite", "chambre", "pension",
    "hotel", "hostel", "inn", "resort", "maison", "casa", "haus",
    "suite", "room", "accommodation", "zimmer", "unterkunft",
    "guesthouse", "bed-and-breakfast", "b-and-b", "bandb",
    "african", "home", "place", "retreat", "escape", "haven",
    "-hotels-", "hotels-"
  ];
  
  // Check if URL contains property keywords
  if (propertyKeywords.some(k => lowercaseUrl.includes(k))) return true;
  
  // Also accept URLs that look like direct booking sites (short domain with specific path)
  try {
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split('/').filter(Boolean);
    // If it has a short path and the domain doesn't look like a major site
    if (pathParts.length <= 3 && urlObj.hostname.split('.').length <= 3) {
      // Check for booking-related paths
      const bookingPaths = ["book", "reserve", "rates", "availability", "rooms", "contact"];
      if (pathParts.some(p => bookingPaths.some(bp => p.toLowerCase().includes(bp)))) {
        return true;
      }
    }
  } catch {
    // Ignore URL parsing errors
  }
  
  return false;
}

// Blocklist of non-booking platforms (stock photo sites, social media, etc.)
function isBlockedNonBookingPlatform(url: string): boolean {
  const lowercaseUrl = url.toLowerCase();
  const blockedDomains = [
    // Stock photo and image sites
    "shutterstock.", "istockphoto.", "gettyimages.", "dreamstime.", "123rf.",
    "depositphotos.", "adobestock.", "stock.adobe.", "canstockphoto.", "bigstockphoto.",
    "alamy.", "stocksy.", "pond5.", "vecteezy.", "freepik.", "pexels.", "unsplash.",
    "pixabay.", "flickr.", "500px.", "smugmug.", "photobucket.",
    // Social media
    "facebook.", "instagram.", "twitter.", "x.com", "pinterest.", "tiktok.",
    "linkedin.", "reddit.", "tumblr.", "snapchat.",
    // Search engines and maps
    "google.", "bing.", "yahoo.", "duckduckgo.", "maps.", "serpapi.",
    // Video platforms
    "youtube.", "vimeo.", "dailymotion.",
    // News and encyclopedias
    "wikipedia.", "wikimedia.", "news.", "cnn.", "bbc.",
    // E-commerce (non-travel)
    "amazon.", "ebay.", "etsy.", "alibaba.", "aliexpress.",
    // Other non-booking sites
    "cloudflare.", "archive.org", "quora.", "medium.", "yelp.",
    ".gov", ".edu", "craigslist.",
    // Travel magazines, blogs and editorial sites (can't book here)
    "cntraveller.", "cntraveler.", "condenast.", "travelandleisure.", "afar.",
    "lonelyplanet.", "fodors.", "frommers.", "roughguides.", "timeout.",
    "theinfatuation.", "eater.", "departures.", "traveler.", "nationalgeographic.",
    "culturetrip.", "atlasobscura.", "roadtrippers.", "matadornetwork.",
    "nomadicmatt.", "theblondeabroad.", "handluggageonly.", "travelingmom.",
    "travelweekly.", "skift.", "phocuswire.", "tnooz.", "webintravel.",
    // Real estate and property info sites (listings, not bookable)
    "zillow.", "trulia.", "realtor.", "redfin.", "rightmove.", "zoopla.",
    "idealista.", "immobilienscout24.", "seloger.", "funda.", "daft.",
    // Price comparison / aggregators without direct booking
    "trivago.", "kayak.", "skyscanner.", "momondo.", "hipmunk.",
    "hotelscombined.", "hotwire.", "priceline.",
  ];
  return blockedDomains.some(d => lowercaseUrl.includes(d));
}

// UUID v4 validation regex
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Maximum URL length to prevent DoS
const MAX_URL_LENGTH = 2048;

// Strict allowlist of valid Airbnb domains (prevents SSRF via subdomain tricks)
const AIRBNB_DOMAINS = [
  "airbnb.com", "airbnb.co.uk", "airbnb.de", "airbnb.fr", "airbnb.es",
  "airbnb.it", "airbnb.nl", "airbnb.pt", "airbnb.at", "airbnb.ch",
  "airbnb.be", "airbnb.ie", "airbnb.se", "airbnb.no", "airbnb.dk",
  "airbnb.fi", "airbnb.pl", "airbnb.cz", "airbnb.hu", "airbnb.gr",
  "airbnb.ca", "airbnb.com.au", "airbnb.co.nz", "airbnb.co.za",
  "airbnb.jp", "airbnb.kr", "airbnb.cn", "airbnb.com.hk", "airbnb.com.sg",
  "airbnb.co.in", "airbnb.com.br", "airbnb.mx", "airbnb.com.ar",
  "airbnb.ru", "airbnb.com.tr", "airbnb.ae", "airbnb.co.il"
];

// Check if hostname is a private/internal IP (SSRF protection)
function isPrivateOrInternalIP(hostname: string): boolean {
  // Block localhost variants
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    return true;
  }
  
  // Block private IP ranges (RFC 1918)
  const privateIPPatterns = [
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,           // 10.0.0.0/8
    /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/, // 172.16.0.0/12
    /^192\.168\.\d{1,3}\.\d{1,3}$/,              // 192.168.0.0/16
    /^169\.254\.\d{1,3}\.\d{1,3}$/,              // Link-local
    /^0\.0\.0\.0$/,                               // Any address
  ];
  
  return privateIPPatterns.some(pattern => pattern.test(hostname));
}

// Validate Airbnb URL format with strict domain allowlist (prevents SSRF)
function isValidAirbnbUrl(url: string): boolean {
  // Check URL length limit
  if (!url || url.length > MAX_URL_LENGTH) {
    return false;
  }
  
  try {
    const parsed = new URL(url);
    
    // Only allow http/https protocols
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    
    // Block userinfo in URL (prevents SSRF like airbnb.com@evil.com)
    if (parsed.username || parsed.password) {
      return false;
    }
    
    // Block private/internal IPs
    if (isPrivateOrInternalIP(parsed.hostname)) {
      return false;
    }
    
    // Extract the base domain (handles www. prefix)
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
    
    // Check against strict allowlist
    const isAllowedDomain = AIRBNB_DOMAINS.some(domain => 
      hostname === domain || hostname.endsWith('.' + domain)
    );
    
    if (!isAllowedDomain) {
      return false;
    }
    
    // Must have /rooms/ path
    return parsed.pathname.includes("/rooms/");
  } catch {
    return false;
  }
}

// Check if an image URL is a valid property photo (not logo/favicon)
function isValidPropertyImage(url: string): boolean {
  const lowercaseUrl = url.toLowerCase();

  // Exclude favicons, logos, and platform assets
  const excludePatterns = [
    "favicon",
    "logo",
    "icon",
    "brand",
    "platform-assets",
    "airbnbplatformassets",
    "airbnb-platform-assets",
    "sprite",
    "button",
    "arrow",
    "avatar",
    "profile",
    "social",
    "badge",
    "marker",
    "pin",
    "placeholder",
  ];

  if (excludePatterns.some((p) => lowercaseUrl.includes(p))) return false;

  // Airbnb listing photos are hosted on muscache; accept any pictures URL.
  if (!lowercaseUrl.includes("muscache.com")) return false;
  if (!lowercaseUrl.includes("/im/pictures/")) return false;

  // Accept common image types OR long CDN URLs with query params.
  return /\.(jpg|jpeg|png|webp)(\?|$)/i.test(lowercaseUrl) || lowercaseUrl.length > 80;
}


// Extract dates from Airbnb URL
function extractDatesFromUrl(url: string): { checkIn: string | null; checkOut: string | null } {
  try {
    const urlObj = new URL(url);
    return {
      checkIn: urlObj.searchParams.get('check_in'),
      checkOut: urlObj.searchParams.get('check_out')
    };
  } catch {
    return { checkIn: null, checkOut: null };
  }
}

// Generate default dates (2 weeks from now, 3 nights)
function generateDefaultDates(): { checkIn: string; checkOut: string } {
  const today = new Date();
  const checkIn = new Date(today);
  checkIn.setDate(today.getDate() + 14);
  
  const checkOut = new Date(checkIn);
  checkOut.setDate(checkIn.getDate() + 3);
  
  return {
    checkIn: checkIn.toISOString().split('T')[0],
    checkOut: checkOut.toISOString().split('T')[0]
  };
}

// Calculate nights between dates
function calculateNights(checkIn: string, checkOut: string): number {
  const start = new Date(checkIn);
  const end = new Date(checkOut);
  const diffTime = Math.abs(end.getTime() - start.getTime());
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

// Format dates for different platforms
function formatDateForPlatform(date: string, platform: string): string {
  const d = new Date(date);
  // Most platforms use YYYY-MM-DD
  return d.toISOString().split('T')[0];
}

// Validate if a URL is an actual bookable property page (not category/search/info page)
function isValidBookablePropertyUrl(url: string): { valid: boolean; reason?: string } {
  const lowercaseUrl = url.toLowerCase();
  
  // Booking.com: must be /hotel/ path with specific property
  if (lowercaseUrl.includes("booking.com")) {
    // Valid: booking.com/hotel/xx/property-name.html
    // Invalid: booking.com/searchresults.html, booking.com/city/xx/hotels/
    if (lowercaseUrl.includes("/searchresults.")) {
      return { valid: false, reason: "Booking.com search results page" };
    }
    if (lowercaseUrl.includes("/hotels/") && !lowercaseUrl.includes("/hotel/")) {
      return { valid: false, reason: "Booking.com category page" };
    }
    if (!lowercaseUrl.includes("/hotel/") && !lowercaseUrl.includes(".html")) {
      return { valid: false, reason: "Booking.com non-property page" };
    }
    return { valid: true };
  }
  
  // TripAdvisor: must be Hotel_Review or VacationRentalReview
  if (lowercaseUrl.includes("tripadvisor.")) {
    // Valid: tripadvisor.com/Hotel_Review-xxx or VacationRentalReview-xxx
    // Invalid: tripadvisor.com/Hotels-xxx (category), Tourism-xxx, Attractions-xxx
    if (lowercaseUrl.includes("/hotel_review-") || lowercaseUrl.includes("/vacationrentalreview-")) {
      return { valid: true };
    }
    if (lowercaseUrl.includes("/hotels-") || lowercaseUrl.includes("/tourism-")) {
      return { valid: false, reason: "TripAdvisor category/search page" };
    }
    if (lowercaseUrl.includes("/attraction") || lowercaseUrl.includes("/restaurant")) {
      return { valid: false, reason: "TripAdvisor non-accommodation page" };
    }
    // Generic TripAdvisor pages without review marker are likely not bookable
    return { valid: false, reason: "TripAdvisor non-property page" };
  }
  
  // HolidayCheck: must be hotel detail page
  if (lowercaseUrl.includes("holidaycheck.")) {
    // Valid: holidaycheck.de/hi/hotel-name/xxx
    // Invalid: holidaycheck.de/hri/ (search), /dh/ (destination)
    if (lowercaseUrl.includes("/hi/") || lowercaseUrl.includes("/hotel/")) {
      return { valid: true };
    }
    if (lowercaseUrl.includes("/hri/") || lowercaseUrl.includes("/dh/") || lowercaseUrl.includes("/search")) {
      return { valid: false, reason: "HolidayCheck search/category page" };
    }
    return { valid: false, reason: "HolidayCheck non-property page" };
  }
  
  // Vrbo/HomeAway: must have property ID
  if (lowercaseUrl.includes("vrbo.") || lowercaseUrl.includes("homeaway.")) {
    // Valid: vrbo.com/123456 or vrbo.com/property-name/123456
    // Invalid: vrbo.com/search/ or category pages
    if (lowercaseUrl.includes("/search") || lowercaseUrl.includes("/results")) {
      return { valid: false, reason: "Vrbo search results page" };
    }
    // Must have numeric property ID in path
    if (/\/\d{4,}/.test(lowercaseUrl)) {
      return { valid: true };
    }
    return { valid: false, reason: "Vrbo non-property page" };
  }
  
  // Expedia: must be hotel detail page
  if (lowercaseUrl.includes("expedia.")) {
    if (lowercaseUrl.includes("/hotel-search") || lowercaseUrl.includes("/hotel-reviews")) {
      return { valid: false, reason: "Expedia search/review page" };
    }
    // Valid pattern: /h12345.hotel-information or /Hotel-Name.h12345
    if (/\.h\d+\./.test(lowercaseUrl) || /\.h\d+$/.test(lowercaseUrl)) {
      return { valid: true };
    }
    return { valid: false, reason: "Expedia non-property page" };
  }
  
  // Hotels.com: similar to Expedia
  if (lowercaseUrl.includes("hotels.com")) {
    if (lowercaseUrl.includes("/search.") || lowercaseUrl.includes("/hotel-search")) {
      return { valid: false, reason: "Hotels.com search page" };
    }
    // Valid: hotels.com/ho123456/ 
    if (/\/ho\d+/.test(lowercaseUrl)) {
      return { valid: true };
    }
    return { valid: false, reason: "Hotels.com non-property page" };
  }
  
  // Agoda: must have property path
  if (lowercaseUrl.includes("agoda.")) {
    if (lowercaseUrl.includes("/searchresults") || lowercaseUrl.includes("/search/")) {
      return { valid: false, reason: "Agoda search results page" };
    }
    // Valid if has specific property path
    if (lowercaseUrl.includes("/hotel/") || /\/[\w-]+-[\w-]+\//.test(lowercaseUrl)) {
      return { valid: true };
    }
    return { valid: false, reason: "Agoda non-property page" };
  }
  
  // For unknown platforms, be lenient but reject obvious non-property patterns
  const invalidPatterns = [
    "/search", "/results", "/list", "/category", "/browse", 
    "/hotels/", "/properties/", "/listings/", "/destination/",
    "?q=", "?query=", "?search="
  ];
  
  if (invalidPatterns.some(p => lowercaseUrl.includes(p))) {
    return { valid: false, reason: "Appears to be search/category page" };
  }
  
  return { valid: true };
}

// Add date parameters to a URL using platform adapter system
function addDatesToUrl(url: string, checkIn: string, checkOut: string): string {
  // Only attach dates to sites that are likely to actually use them
  const shouldAttach =
    isBookingPlatform(url) ||
    isRegionalHotelSite(url) ||
    isDirectPropertySite(url) ||
    /booking\.com|vrbo\.com|homeaway\.|expedia\.|hotels\.com|agoda\.|tripadvisor\.|holidaycheck\./i.test(url);

  if (!shouldAttach) return url;

  // Use the platform adapter system for consistent deep link generation
  const { deepLink } = generatePricedDeepLink(url, checkIn, checkOut);
  return deepLink;
}

// Detect if content indicates dates are unavailable
function detectUnavailability(content: string): boolean {
  const unavailablePatterns = [
    /not available/i,
    /unavailable/i,
    /sold out/i,
    /no (rooms?|availability|vacancies)/i,
    /fully booked/i,
    /keine verfügbarkeit/i, // German
    /non disponible/i, // French
    /no disponible/i, // Spanish
    /ausgebucht/i, // German "sold out"
    /complet/i, // French "full"
    /select (different|other|new) dates/i,
    /try different dates/i,
    /change your dates/i,
    /sorry.*dates/i,
    /dates.*not available/i,
  ];
  return unavailablePatterns.some(p => p.test(content));
}

// Generate alternative date ranges to try
function generateAlternativeDates(checkIn: string, checkOut: string): Array<{ checkIn: string; checkOut: string; offset: number }> {
  const nights = calculateNights(checkIn, checkOut);
  const baseCheckIn = new Date(checkIn);
  const alternatives: Array<{ checkIn: string; checkOut: string; offset: number }> = [];
  
  // Try offsets: +1, -1, +2, -2, +3, -3, +7 days
  const offsets = [1, -1, 2, -2, 3, -3, 7];
  
  for (const offset of offsets) {
    const newCheckIn = new Date(baseCheckIn);
    newCheckIn.setDate(baseCheckIn.getDate() + offset);
    
    const newCheckOut = new Date(newCheckIn);
    newCheckOut.setDate(newCheckIn.getDate() + nights);
    
    // Don't try dates in the past
    if (newCheckIn > new Date()) {
      alternatives.push({
        checkIn: newCheckIn.toISOString().split('T')[0],
        checkOut: newCheckOut.toISOString().split('T')[0],
        offset,
      });
    }
  }
  
  return alternatives;
}

// Screenshot-based price extraction for any platform (multimodal AI)
async function extractPriceFromScreenshot(
  screenshotBase64: string,
  platformName: string,
  checkIn: string,
  checkOut: string,
  nights: number
): Promise<{
  perNight: number | null;
  total: number | null;
  currency: string | null;
  confidence: "high" | "medium" | "low";
  datesConfirmed: boolean;
}> {
  const lovableApiKey = Deno.env.get("LOVABLE_API_KEY");
  if (!lovableApiKey) return { perNight: null, total: null, currency: null, confidence: "low", datesConfirmed: false };

  try {
    const prompt = `This is a screenshot of a ${platformName} property booking page.
The dates being searched are: ${checkIn} to ${checkOut} (${nights} night(s)).

Task:
1) Look for the TOTAL price or per-night price displayed for booking this property.
2) Verify if the displayed dates match or are close to ${checkIn} - ${checkOut}.
3) Extract the most prominent/final price shown (prefer total price if available).

Return ONLY JSON:
{"total": <number|null>, "perNight": <number|null>, "currency": "<EUR|USD|GBP|CHF|etc>", "confidence": "high"|"medium"|"low", "datesConfirmed": <true|false>}

Rules:
- If you see a clear price with dates matching ${checkIn}-${checkOut}, set datesConfirmed=true.
- If dates are different but close (within 3 days), still extract the price but set datesConfirmed=false.
- Ignore prices for other properties, recommendations, or ads.
- "high" confidence = clear price displayed, dates match.
- "medium" confidence = price visible but dates unclear.
- "low" confidence = no clear price found.`;

    const imageUrl = `data:image/png;base64,${screenshotBase64}`;

    const response = await fetchWithTimeout(
      "https://ai.gateway.lovable.dev/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${lovableApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                { type: "image_url", image_url: { url: imageUrl } },
              ],
            },
          ],
          max_tokens: 150,
        }),
      },
      25_000
    );

    if (!response.ok) {
      console.error("Screenshot AI request failed:", response.status);
      return { perNight: null, total: null, currency: null, confidence: "low", datesConfirmed: false };
    }

    const data = await response.json();
    const responseText = data.choices?.[0]?.message?.content?.trim() || "";

    // Parse JSON from response
    let jsonStr = responseText;
    const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    } else if (responseText.startsWith("{")) {
      jsonStr = responseText;
    }

    const parsed = JSON.parse(jsonStr);
    console.log(`Screenshot price extraction for ${platformName}:`, parsed);

    const confidence = (["high", "medium", "low"].includes(parsed.confidence)) 
      ? parsed.confidence as "high" | "medium" | "low" 
      : "low";

    let total = typeof parsed.total === "number" ? parsed.total : null;
    let perNight = typeof parsed.perNight === "number" ? parsed.perNight : null;

    // Calculate missing value
    if (total && !perNight && nights > 0) perNight = Math.round(total / nights);
    if (perNight && !total && nights > 0) total = perNight * nights;

    // Validate ranges
    if (perNight && (perNight < 5 || perNight > 10000)) {
      return { perNight: null, total: null, currency: null, confidence: "low", datesConfirmed: false };
    }

    return {
      perNight,
      total,
      currency: parsed.currency || null,
      confidence,
      datesConfirmed: Boolean(parsed.datesConfirmed),
    };
  } catch (e) {
    console.error("Screenshot price extraction error:", e);
    return { perNight: null, total: null, currency: null, confidence: "low", datesConfirmed: false };
  }
}

// Enhanced scrape price from a listing page using Platform Adapters + Firecrawl + Screenshot fallback
async function scrapePriceFromListing(
  url: string,
  checkIn: string,
  checkOut: string,
  firecrawlApiKey: string,
  platformName: string = "Unknown Platform",
  shouldSkip?: () => Promise<boolean>,
): Promise<{ 
  price: number | null; 
  totalPrice: number | null; 
  perNightRate: number | null;
  usedCheckIn: string;
  usedCheckOut: string;
  datesDiffer: boolean;
  extractionMethod?: string;
  reliability?: LinkReliability;
  skipped?: boolean;
}> {
  const nights = calculateNights(checkIn, checkOut);
  
  // Get platform adapter for optimized deep link generation
  const adapter = getPlatformAdapter(url);
  console.log(`Using ${adapter.name} adapter (capability: ${adapter.capability}, reliability: ${adapter.reliability})`);

  const normalizeNumber = (raw: string): number | null => {
    let s = raw.replace(/\u00a0/g, " ").replace(/[\s'']/g, "").trim();
    const lastComma = s.lastIndexOf(",");
    const lastDot = s.lastIndexOf(".");

    if (lastComma !== -1 && lastDot !== -1) {
      if (lastComma > lastDot) {
        s = s.replace(/\./g, "").replace(/,/g, ".");
      } else {
        s = s.replace(/,/g, "");
      }
    } else if (lastComma !== -1 && lastDot === -1) {
      const decimals = s.slice(lastComma + 1);
      if (decimals.length === 2) s = s.replace(/,/g, ".");
      else s = s.replace(/,/g, "");
    } else {
      const dotParts = s.split(".");
      if (dotParts.length === 2 && dotParts[1].length === 3) {
        s = s.replace(/\./g, "");
      }
    }

    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    return n;
  };

  const tryExtract = (content: string): { extracted: number | null; isPerNight: boolean } => {
    const currency = String.raw`(?:\$|€|£|CHF|USD|EUR|GBP|ZAR|AUD|CAD|NZD|SEK|NOK|DKK|PLN|CZK|HUF|R\$|R)`;
    const amount = String.raw`(\d{1,3}(?:[\s,.']\d{3})*(?:[\.,]\d{2})?|\d{2,6})`;
    const reAll = new RegExp(String.raw`${currency}\s*${amount}|${amount}\s*${currency}`, "gi");
    const candidates: Array<{ value: number; perNightHint: boolean }> = [];

    let match: RegExpExecArray | null;
    while ((match = reAll.exec(content)) !== null) {
      const raw = match[1] || match[2];
      const parsed = raw ? normalizeNumber(raw) : null;
      if (!parsed || parsed <= 0 || parsed >= 50000) continue;

      const windowStart = Math.max(0, match.index - 25);
      const windowEnd = Math.min(content.length, match.index + match[0].length + 25);
      const windowText = content.slice(windowStart, windowEnd).toLowerCase();
      const perNightHint = /per\s*night|\/night|night/.test(windowText);

      candidates.push({ value: parsed, perNightHint });
    }

    if (candidates.length === 0) return { extracted: null, isPerNight: false };

    const perNightCandidates = candidates.filter((c) => c.perNightHint);
    if (perNightCandidates.length > 0) {
      const best = perNightCandidates.map((c) => c.value).filter((v) => v >= 10 && v <= 5000).sort((a, b) => b - a)[0];
      return best ? { extracted: best, isPerNight: true } : { extracted: null, isPerNight: false };
    }

    const bestTotal = candidates.map((c) => c.value).filter((v) => v >= 20 && v <= 50000).sort((a, b) => b - a)[0];
    return bestTotal ? { extracted: bestTotal, isPerNight: false } : { extracted: null, isPerNight: false };
  };

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // Enhanced Firecrawl fetch with screenshot support
  const fetchFirecrawlWithScreenshot = async (
    targetUrl: string,
    opts: { formats: string[]; onlyMainContent: boolean; waitFor: number },
  ): Promise<{ markdown: string; html: string; screenshot: string | null }> => {
    console.log("Scraping price from:", targetUrl.slice(0, 160));

    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // NOTE: Firecrawl requires waitFor <= timeout/2. Calculate timeout as 2.5x waitFor.
      const timeout = Math.max(30000, Math.ceil(opts.waitFor * 2.5));
      const resp = await fetch("https://api.firecrawl.dev/v1/scrape", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${firecrawlApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url: targetUrl,
          formats: opts.formats,
          onlyMainContent: opts.onlyMainContent,
          waitFor: opts.waitFor,
          timeout, // Required: waitFor must be <= timeout/2
        }),
      });

      if (!resp.ok) {
        console.log("Firecrawl request failed:", resp.status);
        if ((resp.status === 429 || resp.status === 503 || resp.status === 504) && attempt < MAX_ATTEMPTS) {
          const backoff = 800 * attempt * attempt + Math.floor(Math.random() * 250);
          console.log(`Retrying Firecrawl in ${backoff}ms (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
          await sleep(backoff);
          continue;
        }
        return { markdown: "", html: "", screenshot: null };
      }

      const data = await resp.json();
      const markdown: string = data.data?.markdown || data.markdown || "";
      const html: string = data.data?.html || data.html || "";
      const screenshot: string | null = data.data?.screenshot || data.screenshot || null;

      await sleep(150);
      return { markdown, html, screenshot };
    }

    return { markdown: "", html: "", screenshot: null };
  };

  const tryScrapeDates = async (tryCheckIn: string, tryCheckOut: string): Promise<{
    extracted: number | null;
    isPerNight: boolean;
    isUnavailable: boolean;
    extractionMethod: string;
  }> => {
    // Use platform adapter to generate optimized deep link
    const { deepLink } = generatePricedDeepLink(url, tryCheckIn, tryCheckOut);
    const tryNights = calculateNights(tryCheckIn, tryCheckOut);

    console.log(`Scraping ${platformName} with adapter-generated deep link: ${deepLink.slice(0, 180)}`);

    // Use adapter's recommended wait time and include screenshot for session-driven platforms
    const includeScreenshot = adapter.useScreenshotFallback || adapter.capability === "session_driven";
    const formats = includeScreenshot ? ["markdown", "html", "screenshot"] : ["markdown", "html"];
    
    const scrapeResult = await fetchFirecrawlWithScreenshot(deepLink, {
      formats,
      onlyMainContent: false,
      waitFor: adapter.scrapeWaitTime,
    });

    let content = scrapeResult.markdown || "";
    const htmlText = (scrapeResult.html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");
    content = [content, htmlText].join("\n");

    // Check for unavailability first
    if (detectUnavailability(content)) {
      console.log(`Dates ${tryCheckIn} - ${tryCheckOut} appear unavailable on ${platformName}`);
      return { extracted: null, isPerNight: false, isUnavailable: true, extractionMethod: "unavailable" };
    }

    // Strategy 1: AI text extraction
    console.log(`Using AI to extract price from ${platformName} content (${content.length} chars)`);
    const aiResult = await extractAlternativePlatformPriceWithAI(content, platformName, tryCheckIn, tryCheckOut, tryNights);

    const aiAcceptable =
      aiResult.datesConfirmed &&
      (aiResult.confidence === "high" || aiResult.confidence === "medium") &&
      !!aiResult.perNight &&
      aiResult.perNight >= 5;

    if (aiAcceptable) {
      console.log(`AI text extracted ${platformName} price: ${aiResult.perNight}/night (confidence: ${aiResult.confidence})`);
      return { extracted: aiResult.perNight!, isPerNight: true, isUnavailable: false, extractionMethod: "ai_text" };
    }

    // Strategy 2: Screenshot-based extraction (for session-driven platforms)
    if (scrapeResult.screenshot && adapter.useScreenshotFallback) {
      console.log(`Attempting screenshot-based price extraction for ${platformName}`);
      const screenshotResult = await extractPriceFromScreenshot(
        scrapeResult.screenshot,
        platformName,
        tryCheckIn,
        tryCheckOut,
        tryNights
      );

      if (screenshotResult.perNight && screenshotResult.confidence !== "low") {
        console.log(`Screenshot extracted ${platformName} price: ${screenshotResult.perNight}/night (confidence: ${screenshotResult.confidence})`);
        return { 
          extracted: screenshotResult.perNight, 
          isPerNight: true, 
          isUnavailable: false, 
          extractionMethod: "screenshot" 
        };
      }
    }

    // Strategy 3: Regex fallback (only if content mentions dates)
    const mentionsDates = content.includes(tryCheckIn) || content.includes(tryCheckOut);
    if (mentionsDates) {
      const { extracted, isPerNight } = tryExtract(content);
      if (extracted) {
        console.log(`Regex extracted ${platformName} price: ${extracted} (isPerNight: ${isPerNight})`);
        return { extracted, isPerNight, isUnavailable: false, extractionMethod: "regex" };
      }
    }

    console.log(`No price extracted for ${platformName} (AI datesConfirmed=${aiResult.datesConfirmed}, confidence=${aiResult.confidence})`);
    return { extracted: null, isPerNight: false, isUnavailable: false, extractionMethod: "none" };
  };

  try {
    // First try with exact dates
    let result = await tryScrapeDates(checkIn, checkOut);
    let extractionMethod = result.extractionMethod;
    
    // If unavailable or no price found, try alternative dates
    if (result.isUnavailable || !result.extracted) {
      const alternatives = generateAlternativeDates(checkIn, checkOut);
      
      for (const alt of alternatives) {
        // Check for skip request BEFORE each alternative date attempt
        if (shouldSkip && await shouldSkip()) {
          console.log(`SKIP requested during ${platformName} alternative date loop - aborting`);
          return {
            price: null,
            totalPrice: null,
            perNightRate: null,
            usedCheckIn: checkIn,
            usedCheckOut: checkOut,
            datesDiffer: false,
            extractionMethod: "skipped",
            reliability: adapter.reliability,
            skipped: true,
          };
        }
        
        console.log(`Trying alternative dates: ${alt.checkIn} - ${alt.checkOut} (offset ${alt.offset > 0 ? '+' : ''}${alt.offset} days)`);
        result = await tryScrapeDates(alt.checkIn, alt.checkOut);
        extractionMethod = result.extractionMethod;
        
        if (result.extracted && !result.isUnavailable) {
          console.log(`Found price with alternative dates: ${alt.checkIn} - ${alt.checkOut}`);
          const altNights = calculateNights(alt.checkIn, alt.checkOut);
          
          if (result.isPerNight) {
            return { 
              price: result.extracted, 
              totalPrice: result.extracted * altNights, 
              perNightRate: result.extracted,
              usedCheckIn: alt.checkIn,
              usedCheckOut: alt.checkOut,
              datesDiffer: true,
              extractionMethod,
              reliability: adapter.reliability,
            };
          }
          
          const perNight = Math.round(result.extracted / altNights);
          return { 
            price: perNight, 
            totalPrice: result.extracted, 
            perNightRate: perNight,
            usedCheckIn: alt.checkIn,
            usedCheckOut: alt.checkOut,
            datesDiffer: true,
            extractionMethod,
            reliability: adapter.reliability,
          };
        }
      }
    }
    
    // Original dates worked (or no alternatives worked either)
    if (!result.extracted) {
      return { 
        price: null, 
        totalPrice: null, 
        perNightRate: null,
        usedCheckIn: checkIn,
        usedCheckOut: checkOut,
        datesDiffer: false,
        extractionMethod: "none",
        reliability: adapter.reliability,
      };
    }

    if (result.isPerNight) {
      return { 
        price: result.extracted, 
        totalPrice: result.extracted * nights, 
        perNightRate: result.extracted,
        usedCheckIn: checkIn,
        usedCheckOut: checkOut,
        datesDiffer: false,
        extractionMethod,
        reliability: adapter.reliability,
      };
    }

    const perNight = Math.round(result.extracted / nights);
    return { 
      price: perNight, 
      totalPrice: result.extracted, 
      perNightRate: perNight,
      usedCheckIn: checkIn,
      usedCheckOut: checkOut,
      datesDiffer: false,
      extractionMethod,
      reliability: adapter.reliability,
    };
  } catch (error) {
    console.error("Price scraping error:", error);
    return { 
      price: null, 
      totalPrice: null, 
      perNightRate: null,
      usedCheckIn: checkIn,
      usedCheckOut: checkOut,
      datesDiffer: false,
      extractionMethod: "error",
      reliability: adapter.reliability,
    };
  }
}

function isLikelyPropertyImage(url: string): boolean {
  const u = url.toLowerCase();
  if (!u.startsWith("http")) return false;
  if (!/\.(jpg|jpeg|png|webp)(\?|$)/i.test(u)) return false;
  const exclude = ["logo", "favicon", "sprite", "icon", "avatar", "profile", "brand", "placeholder", "analytics", "doubleclick"]; 
  if (exclude.some((k) => u.includes(k))) return false;
  return true;
}

// For some platforms (Booking/TripAdvisor), Lens thumbnails can be too small/cropped and cause false negatives.
// This scrapes the page to pull a higher-quality image for AI verification.
async function scrapeBestImageFromListing(url: string, firecrawlApiKey: string): Promise<string | null> {
  try {
    // NOTE: Firecrawl requires waitFor <= timeout/2. Use timeout=15000, waitFor=2500.
    const response = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${firecrawlApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        formats: ["html"],
        onlyMainContent: false,
        waitFor: 2500,
        timeout: 15000, // Required: waitFor must be <= timeout/2
      }),
    });

    if (!response.ok) return null;
    const data = await response.json();
    const html: string = data.data?.html || data.html || "";
    if (!html) return null;

    // Prefer OG images
    const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/i)
      || html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["'][^>]*>/i);
    if (ogMatch?.[1] && isLikelyPropertyImage(ogMatch[1])) return ogMatch[1];

    // Fallback: first few img src candidates
    const imgMatches = [...html.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi)].slice(0, 40);
    for (const m of imgMatches) {
      const src = m[1];
      if (src && isLikelyPropertyImage(src)) return src;
    }

    return null;
  } catch (e) {
    console.error("scrapeBestImageFromListing error:", e);
    return null;
  }
}

// Extract location info from title/URL
function extractLocationFromTitle(title: string): { city: string | null; country: string | null } {
  // Common location patterns in Airbnb titles
  const locationPatterns = [
    /in\s+([A-Za-z\s]+),\s*([A-Za-z\s]+)$/i,
    /([A-Za-z\s]+),\s*([A-Za-z\s]+)$/,
    /·\s*([A-Za-z\s]+)$/i,
  ];
  
  for (const pattern of locationPatterns) {
    const match = title.match(pattern);
    if (match) {
      return { city: match[1]?.trim() || null, country: match[2]?.trim() || null };
    }
  }
  
  // Try to find city names in the title
  const knownCities = [
    "Cape Town", "Johannesburg", "Durban", "Paris", "London", "Berlin", "Rome",
    "Barcelona", "Madrid", "Amsterdam", "Vienna", "Prague", "Budapest", "Lisbon",
    "Zurich", "Geneva", "Munich", "Frankfurt", "Milan", "Venice", "Florence",
    "Nice", "Marseille", "Lyon", "Hamburg", "Cologne", "Stuttgart", "Salzburg"
  ];
  
  const lowerTitle = title.toLowerCase();
  for (const city of knownCities) {
    if (lowerTitle.includes(city.toLowerCase())) {
      return { city, country: null };
    }
  }
  
  return { city: null, country: null };
}

// Targeted text search fallback (used when visual matches are missing/insufficient)
async function addTargetedTextMatches(opts: {
  serpApiKey: string;
  title: string;
  cityHint?: string | null;
  imageUrlForVerification?: string | null;
  alternatives: SearchResult[];
  foundUrls: Set<string>;
  controller?: SSEController;
  errorTracker?: ApiErrorTracker;
}) {
  const { serpApiKey, title, cityHint, imageUrlForVerification, alternatives, foundUrls, controller, errorTracker } = opts;

  const cleanTitle = title.replace(/\s+/g, " ").trim();
  const queries = [
    `${cleanTitle} ${cityHint ?? ""} site:rentbyowner.com`,
    `${cleanTitle} ${cityHint ?? ""} site:booking.com`,
    `${cleanTitle} ${cityHint ?? ""} site:tripadvisor.`,
  ].map(q => q.replace(/\s+/g, " ").trim());

  for (const q of queries) {
    // Check if we should abort due to API errors
    if (errorTracker && shouldAbortDueToApiErrors(errorTracker)) {
      console.log("Aborting text search due to API errors");
      controller && sendProgress(controller, "Search paused", getApiErrorSummary(errorTracker) || "API error");
      break;
    }

    controller && sendProgress(controller, "Running text search", q);

    const result = await fetchSerpApi(`engine=google&q=${encodeURIComponent(q)}&num=10`, serpApiKey);
    
    if (!result.success) {
      if (errorTracker && result.error) {
        recordApiError(errorTracker, result.error);
        controller && sendProgress(controller, "Search API issue", result.error.message, { 
          errorType: result.error.type,
          isQuotaError: result.error.type === 'quota_exceeded'
        });
      }
      continue;
    }
    
    // Reset consecutive errors on success
    if (errorTracker) resetConsecutiveErrors(errorTracker);

    const data = result.data;
    const organic = (data?.organic_results || []) as Array<any>;

    for (const r of organic) {
      const url: string | undefined = r.link;
      if (!url) continue;
      if (url.toLowerCase().includes("airbnb.")) continue;
      if (foundUrls.has(url)) continue;

      // Only accept URLs that match our platform heuristics and aren't blocked
      if (isBlockedNonBookingPlatform(url)) continue;
      if (!isBookingPlatform(url) && !isRegionalHotelSite(url) && !isDirectPropertySite(url)) continue;
      
      // Validate URL is an actual bookable property page (not category/search page)
      const urlValidation = isValidBookablePropertyUrl(url);
      if (!urlValidation.valid) {
        console.log(`Text search: Skipping non-bookable URL: ${urlValidation.reason} - ${url.slice(0, 100)}`);
        continue;
      }

      // If we have an image thumbnail + a reference Airbnb image, try to visually verify it.
      const thumb: string | null = r.thumbnail || null;
      let match_type: 'visual' | 'text' = 'text';
      let confidence_score: number | null = null;

      if (imageUrlForVerification && thumb) {
        const ai = await compareImagesWithAI(imageUrlForVerification, thumb);
        if (ai.isMatch && ai.score >= 90) {
          match_type = 'visual';
          confidence_score = ai.score;
        }
      }

      foundUrls.add(url);
      alternatives.push({
        platform_name: getPlatformName(url),
        listing_url: url,
        listing_title: r.title || r.snippet || null,
        price: null,
        confidence_score,
        image_url: thumb,
        images: thumb ? [thumb] : [],
        match_type,
        source_airbnb_image: imageUrlForVerification || null,
      });

      controller && sendProgress(controller, "Found candidate listing", `${getPlatformName(url)} · ${match_type === 'visual' ? `${confidence_score}% verified` : 'text-only'}`);
    }
  }
}

// Streaming search implementation
async function runSearchWithStreaming(
  controller: SSEController,
  opts: {
    search: any;
    searchId: string;
    supabase: any; // Use any to avoid complex type inference
    serpApiKey: string;
    firecrawlApiKey?: string;
  }
) {
  const { search, searchId, supabase, serpApiKey, firecrawlApiKey } = opts;

  sendProgress(controller, "Starting search", `Analyzing ${search.airbnb_url.slice(0, 60)}...`);

  const roomIdMatch = search.airbnb_url.match(/rooms\/(\d+)/);
  const roomId = roomIdMatch ? roomIdMatch[1] : null;

  // Extract dates - REQUIRED in URL
  const { checkIn, checkOut } = extractDatesFromUrl(search.airbnb_url);
  if (!checkIn || !checkOut) {
    console.log("Missing dates in URL - dates are required for price comparison");
    await supabase.from("searches").update({ 
      status: "dates_required" 
    }).eq("id", searchId);
    sendProgress(controller, "Dates required", "Please include check-in and check-out dates in your Airbnb URL to compare prices");
    sendSSE(controller, "error", { 
      message: "Dates are required for price comparison. Please copy a full Airbnb URL that includes your check-in and check-out dates (e.g., airbnb.com/rooms/123?check_in=2025-01-15&check_out=2025-01-18)." 
    });
    sendSSE(controller, "complete", { searchId, status: "dates_required" });
    return;
  }

  const nights = calculateNights(checkIn, checkOut);
  const alternatives: SearchResult[] = [];
  const foundUrls = new Set<string>();
  let airbnbTitle = "Vacation Rental";
  let airbnbPrice: number | null = null;
  let imageUrls: string[] = [];
  let skipAirbnbPrice = false;
  // Track scraped content for failure diagnosis
  let lastScrapedContent: { markdown: string; html: string; hasScreenshot: boolean } = { 
    markdown: '', html: '', hasScreenshot: false 
  };

  // IMPORTANT: Save dates immediately after extraction so they're available even if search stalls
  console.log(`Extracted dates from URL: checkIn=${checkIn}, checkOut=${checkOut}, nights=${nights}`);
  await supabase.from("searches").update({ 
    check_in_date: checkIn, 
    check_out_date: checkOut, 
    nights_count: nights,
    last_progress_at: new Date().toISOString() 
  }).eq("id", searchId);

  // Heartbeat helper - updates last_progress_at so UI can detect stalls
  const heartbeat = async () => {
    await supabase.from("searches").update({ last_progress_at: new Date().toISOString() }).eq("id", searchId);
  };

  // Allow UI to request skipping a stuck step (via skip_requested column)
  // IMPORTANT: This must only skip ONE upcoming check, not the entire remainder of the run.
  // We implement this as an atomic "claim" operation: if skip_requested=true, flip it to false and return true.
  const claimSkipNow = async (): Promise<boolean> => {
    const { data, error } = await supabase
      .from("searches")
      .update({ skip_requested: false })
      .eq("id", searchId)
      .eq("skip_requested", true)
      .select("id");

    if (error) {
      console.log("claimSkipNow error:", error.message || error);
      return false;
    }

    return Array.isArray(data) && data.length > 0;
  };

  // Heartbeat on start
  await heartbeat();

  // Stage 1 telemetry + hard timeout guard
  const AIRBNB_STAGE_TIMEOUT_MS = 30_000;
  const stage1StartedAt = Date.now();
  const checkStage1Timeout = () => {
    if (Date.now() - stage1StartedAt > AIRBNB_STAGE_TIMEOUT_MS) {
      throw new Error("AIRBNB_PARSING_TIMEOUT");
    }
  };

  let stage1Outcome: StageOutcome = 'success';
  let stage1Error: string | undefined;
  await startStageRun(supabase, searchId, 'analyze_listing', {
    airbnb_url: search.airbnb_url,
    check_in: checkIn,
    check_out: checkOut,
  });

  try {
    // Step 1: Extract Airbnb data
    sendProgress(controller, "Extracting property photos", "Downloading images from Airbnb listing");
    await supabase.from("searches").update({ status: "extracting_photos", last_progress_at: new Date().toISOString() }).eq("id", searchId);

    if (firecrawlApiKey) {
      checkStage1Timeout();
      sendProgress(controller, "Loading Airbnb listing", "Using JavaScript rendering to capture dynamic content");
      await supabase.from("searches").update({ status: "scraping_airbnb_page" }).eq("id", searchId);

      // If the user clicks "Skip", we should advance to the next phase and keep going (even if Airbnb price is missing).

      const scrapeWithFirecrawl = async (formats: string[], waitForMs: number) => {
        // NOTE: Claiming skip here may occur while we're between attempts.
        // For in-flight requests, we also poll and abort the fetch.
        const fetchAbort = new AbortController();
        const pollId = setInterval(async () => {
          try {
            if (await claimSkipNow()) {
              skipAirbnbPrice = true;
              fetchAbort.abort();
            }
          } catch {
            // ignore
          }
        }, 750);

        try {
          await heartbeat();
          checkStage1Timeout();

          const resp = await fetchWithTimeout(
            "https://api.firecrawl.dev/v1/scrape",
            {
              method: "POST",
              signal: fetchAbort.signal,
              headers: {
                Authorization: `Bearer ${firecrawlApiKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                url: search.airbnb_url,
                formats,
                onlyMainContent: false,
                waitFor: waitForMs,
                // NOTE: Firecrawl requires waitFor <= timeout/2. Use 2.5x waitFor.
                timeout: Math.max(30000, Math.ceil(waitForMs * 2.5)),
              }),
            },
            // Strict client-side timeout (required to prevent stuck stage 1)
            28_000
          );

          if (!resp.ok) {
            const errText = await resp.text().catch(() => "");
            console.error("Firecrawl scrape failed:", resp.status, errText.slice(0, 800));
            return { ok: false as const, status: resp.status, errorText: errText };
          }

          const data = await resp.json().catch(() => null);
          return { ok: true as const, data };
        } catch (e) {
          if ((e as any)?.name === "AbortError" && skipAirbnbPrice) {
            return { ok: false as const, status: 499, errorText: "skipped" };
          }
          throw e;
        } finally {
          clearInterval(pollId);
        }
      };

      try {
        // Attempt 1: full content + screenshot (waitFor=10s, timeout=30s to satisfy waitFor <= timeout/2)
        let attempt = await scrapeWithFirecrawl(["markdown", "html", "rawHtml", "screenshot"], 10000);

        if (attempt.status === 499) {
          console.log("SKIP requested during Airbnb scrape");
          sendProgress(controller, "Skipped current step", "Skipping Airbnb price extraction and continuing", { skipped: true });
          // We'll fall back to direct fetch for images, but we won't block the entire run on Airbnb pricing.
          skipAirbnbPrice = true;
          throw new Error("__SKIP_AIRBNB_PRICE__");
        }

        // Attempt 2: retry with longer wait (Airbnb sometimes renders totals very late)
        if (!attempt.ok) {
          checkStage1Timeout();
          sendProgress(controller, "Loading Airbnb listing", "Retrying with longer wait");
          // Retry with waitFor=15s (timeout will be 37.5s)
          attempt = await scrapeWithFirecrawl(["screenshot", "html", "rawHtml"], 15000);
        }

        if (attempt.status === 499) {
          console.log("SKIP requested during Airbnb scrape (retry)");
          sendProgress(controller, "Skipped current step", "Skipping Airbnb price extraction and continuing", { skipped: true });
          skipAirbnbPrice = true;
          throw new Error("__SKIP_AIRBNB_PRICE__");
        }

        if (attempt.ok) {
          const firecrawlData = attempt.data;
          const markdown = firecrawlData?.data?.markdown || "";
          const html = firecrawlData?.data?.html || "";
          const rawHtml = firecrawlData?.data?.rawHtml || html;
          const screenshotBase64: string | null = firecrawlData?.data?.screenshot || null;

          console.log(
            "Firecrawl received. markdown:",
            markdown.length,
            "html:",
            html.length,
            "screenshot:",
            !!screenshotBase64
          );
          
          // Track content for failure diagnosis
          lastScrapedContent = { 
            markdown, 
            html: rawHtml || html, 
            hasScreenshot: !!screenshotBase64 
          };

          // Extract title
          const metaTitle = firecrawlData?.data?.metadata?.title;
          if (metaTitle) {
            airbnbTitle = metaTitle.replace(" - Airbnb", "").replace(" · Airbnb", "").trim();
          }

          // Extract images (Airbnb rotates subdomains and path variants frequently)
          const imagePatterns = [
            /https:\/\/a\d+\.muscache\.com\/im\/pictures\/[^"'\s\)]+/gi,
            /https:\/\/.*?\.muscache\.com\/im\/pictures\/[^"'\s\)]+/gi,
          ];

          const canonicalize = (url: string) => url.replace(/\\u002F/g, "/").split("?")[0];
          let allImages: string[] = [];
          for (const pattern of imagePatterns) {
            allImages.push(...((rawHtml || html).match(pattern) || []));
          }
          const unique = [...new Set(allImages.map(canonicalize))];
          imageUrls = unique.filter(isValidPropertyImage).map((u) => `${u}?im_w=1200`).slice(0, 5);

          sendProgress(controller, "Found property photos", `Extracted ${imageUrls.length} images`, {
            imageCount: imageUrls.length,
          });

          if (!skipAirbnbPrice) {
            // Extract price
            checkStage1Timeout();
            sendProgress(controller, "Extracting Airbnb price", "Reading the total price shown for your dates");
            await supabase.from("searches").update({ status: "extracting_price" }).eq("id", searchId);

            // 1) HTML/Raw HTML (JSON-LD / embedded data) - Extract TOTAL price
            airbnbPrice = extractTotalPriceWithRegex(rawHtml || html, nights);

            // 2) Markdown
            if (!airbnbPrice && markdown.length > 100) {
              airbnbPrice = extractTotalPriceWithRegex(markdown, nights);
            }

            // 3) Screenshot (dynamic totals)
            if (!airbnbPrice && screenshotBase64) {
              checkStage1Timeout();
              sendProgress(controller, "Extracting Airbnb price", "Price is dynamic — reading it from the rendered page");
              airbnbPrice = await extractAirbnbTotalFromScreenshotBase64(screenshotBase64, nights);
              if (airbnbPrice) {
                console.log("Screenshot extracted TOTAL price:", airbnbPrice);
              }
            }

            // 4) AI over combined text
            if (!airbnbPrice && (markdown.length > 100 || html.length > 100)) {
              checkStage1Timeout();
              sendProgress(controller, "Using AI for price extraction", "Fallback analysis of page text");
              airbnbPrice = await extractAirbnbTotalPriceWithAI(
                [markdown, (rawHtml || html).slice(0, 12000)].filter(Boolean).join("\n\n"),
                nights
              );
            }

            if (airbnbPrice) {
              sendProgress(controller, "Price extracted", `Found Airbnb TOTAL: $${airbnbPrice}`, { airbnbPrice });

              await supabase
                .from("searches")
                .update({
                  // Ensure DB reflects we're past the initial parsing stage.
                  // The UI stepper depends on status transitions; missing these makes it look stuck.
                  status: "searching_platforms",
                  last_progress_at: new Date().toISOString(),
                  airbnb_title: airbnbTitle,
                  airbnb_price: airbnbPrice,
                  airbnb_image_url: imageUrls[0] || null,
                  airbnb_images: imageUrls.slice(0, 5),
                  check_in_date: checkIn,
                  check_out_date: checkOut,
                  nights_count: nights,
                })
                .eq("id", searchId);
            } else {
              console.log("Price extraction failed for URL:", search.airbnb_url);
            }
          }
        } else {
          // Firecrawl failed (likely 403 blocking Airbnb) - try Zyte as fallback
          console.log("Firecrawl failed for Airbnb, attempting Zyte fallback...");
          sendProgress(controller, "Switching providers", "Primary scraper blocked, using fallback provider");
          
          const zyteApiKey = Deno.env.get("ZYTE_API_KEY");
          if (zyteApiKey && !skipAirbnbPrice) {
            const zyteResult = await scrapeAirbnbWithZyte(search.airbnb_url, zyteApiKey);
            
            if (zyteResult.ok) {
              console.log("Zyte Airbnb scrape succeeded. HTML:", zyteResult.html.length, "Screenshot:", !!zyteResult.screenshot);
              
              // Track content for failure diagnosis
              lastScrapedContent = { 
                markdown: zyteResult.markdown, 
                html: zyteResult.html, 
                hasScreenshot: !!zyteResult.screenshot,
                providerUsed: 'zyte',
              } as any;

              // Extract title
              const titleMatch = zyteResult.html.match(/<title>([^<]+)<\/title>/i);
              if (titleMatch) {
                airbnbTitle = titleMatch[1].replace(" - Airbnb", "").replace(" · Airbnb", "").trim();
              }

              // Extract images
              const imagePatterns = [
                /https:\/\/a\d+\.muscache\.com\/im\/pictures\/[^"'\s\)]+/gi,
                /https:\/\/.*?\.muscache\.com\/im\/pictures\/[^"'\s\)]+/gi,
              ];
              const canonicalize = (url: string) => url.replace(/\\u002F/g, "/").split("?")[0];
              let allImages: string[] = [];
              for (const pattern of imagePatterns) {
                allImages.push(...(zyteResult.html.match(pattern) || []));
              }
              const unique = [...new Set(allImages.map(canonicalize))];
              imageUrls = unique.filter(isValidPropertyImage).map((u) => `${u}?im_w=1200`).slice(0, 5);

              sendProgress(controller, "Found property photos", `Extracted ${imageUrls.length} images via fallback`, {
                imageCount: imageUrls.length,
                provider: 'zyte',
              });

              // Extract price from Zyte content
              checkStage1Timeout();
              sendProgress(controller, "Extracting Airbnb price", "Reading price from fallback provider");
              await supabase.from("searches").update({ status: "extracting_price" }).eq("id", searchId);

              // 1) HTML extraction - TOTAL price
              airbnbPrice = extractTotalPriceWithRegex(zyteResult.html, nights);

              // 2) Markdown
              if (!airbnbPrice && zyteResult.markdown.length > 100) {
                airbnbPrice = extractTotalPriceWithRegex(zyteResult.markdown, nights);
              }

              // 3) Screenshot
              if (!airbnbPrice && zyteResult.screenshot) {
                checkStage1Timeout();
                sendProgress(controller, "Extracting Airbnb price", "Price is dynamic — reading from screenshot");
                airbnbPrice = await extractAirbnbTotalFromScreenshotBase64(zyteResult.screenshot, nights);
                if (airbnbPrice) {
                  console.log("Zyte screenshot extracted TOTAL:", airbnbPrice);
                }
              }

              // 4) AI fallback
              if (!airbnbPrice && (zyteResult.markdown.length > 100 || zyteResult.html.length > 100)) {
                checkStage1Timeout();
                sendProgress(controller, "Using AI for price extraction", "Analyzing page content from fallback");
                airbnbPrice = await extractAirbnbTotalPriceWithAI(
                  [zyteResult.markdown, zyteResult.html.slice(0, 12000)].filter(Boolean).join("\n\n"),
                  nights
                );
              }

              if (airbnbPrice) {
                sendProgress(controller, "Price extracted", `Found Airbnb TOTAL: $${airbnbPrice} (via fallback)`, { airbnbPrice, provider: 'zyte' });

                await supabase
                  .from("searches")
                  .update({
                    status: "searching_platforms",
                    last_progress_at: new Date().toISOString(),
                    airbnb_title: airbnbTitle,
                    airbnb_price: airbnbPrice,
                    airbnb_image_url: imageUrls[0] || null,
                    airbnb_images: imageUrls.slice(0, 5),
                    check_in_date: checkIn,
                    check_out_date: checkOut,
                    nights_count: nights,
                  })
                  .eq("id", searchId);
              } else {
                console.log("Zyte price extraction failed for URL:", search.airbnb_url);
              }
            } else {
              console.log("Zyte Airbnb scrape failed:", zyteResult.error);
              // Track the Zyte failure for diagnosis
              (lastScrapedContent as any).zyteError = zyteResult.error;
              (lastScrapedContent as any).zyteBotIndicators = zyteResult.botIndicators;
              sendProgress(controller, "Fallback extraction", "Both scrapers failed, trying direct page fetch");
            }
          } else {
            sendProgress(controller, "Fallback extraction", "Dynamic scrape failed, trying direct page fetch");
          }
        }
      } catch (e) {
        if ((e as Error)?.message === "__SKIP_AIRBNB_PRICE__") {
          // intentional; continue
        } else {
          console.error("Firecrawl error:", e);
          // Try Zyte as fallback on Firecrawl exception
          const zyteApiKey = Deno.env.get("ZYTE_API_KEY");
          if (zyteApiKey && !skipAirbnbPrice) {
            console.log("Firecrawl threw exception, trying Zyte fallback...");
            sendProgress(controller, "Switching providers", "Primary scraper failed, using fallback provider");
            
            try {
              const zyteResult = await scrapeAirbnbWithZyte(search.airbnb_url, zyteApiKey);
              
              if (zyteResult.ok) {
                // Same extraction logic as above
                lastScrapedContent = { 
                  markdown: zyteResult.markdown, 
                  html: zyteResult.html, 
                  hasScreenshot: !!zyteResult.screenshot,
                  providerUsed: 'zyte',
                } as any;

                const titleMatch = zyteResult.html.match(/<title>([^<]+)<\/title>/i);
                if (titleMatch) {
                  airbnbTitle = titleMatch[1].replace(" - Airbnb", "").replace(" · Airbnb", "").trim();
                }

                const imagePatterns = [
                  /https:\/\/a\d+\.muscache\.com\/im\/pictures\/[^"'\s\)]+/gi,
                  /https:\/\/.*?\.muscache\.com\/im\/pictures\/[^"'\s\)]+/gi,
                ];
                const canonicalize = (url: string) => url.replace(/\\u002F/g, "/").split("?")[0];
                let allImages: string[] = [];
                for (const pattern of imagePatterns) {
                  allImages.push(...(zyteResult.html.match(pattern) || []));
                }
                const unique = [...new Set(allImages.map(canonicalize))];
                imageUrls = unique.filter(isValidPropertyImage).map((u) => `${u}?im_w=1200`).slice(0, 5);

                airbnbPrice = extractTotalPriceWithRegex(zyteResult.html, nights);
                if (!airbnbPrice && zyteResult.markdown.length > 100) {
                  airbnbPrice = extractTotalPriceWithRegex(zyteResult.markdown, nights);
                }
                if (!airbnbPrice && zyteResult.screenshot) {
                  airbnbPrice = await extractAirbnbTotalFromScreenshotBase64(zyteResult.screenshot, nights);
                }
                if (!airbnbPrice && (zyteResult.markdown.length > 100 || zyteResult.html.length > 100)) {
                  airbnbPrice = await extractAirbnbTotalPriceWithAI(
                    [zyteResult.markdown, zyteResult.html.slice(0, 12000)].filter(Boolean).join("\n\n"),
                    nights
                  );
                }

                if (airbnbPrice) {
                  sendProgress(controller, "Price extracted", `Found Airbnb TOTAL: $${airbnbPrice} (via fallback)`, { airbnbPrice, provider: 'zyte' });
                  await supabase
                    .from("searches")
                    .update({
                      status: "searching_platforms",
                      last_progress_at: new Date().toISOString(),
                      airbnb_title: airbnbTitle,
                      airbnb_price: airbnbPrice,
                      airbnb_image_url: imageUrls[0] || null,
                      airbnb_images: imageUrls.slice(0, 5),
                      check_in_date: checkIn,
                      check_out_date: checkOut,
                      nights_count: nights,
                    })
                    .eq("id", searchId);
                }
              }
            } catch (zyteError) {
              console.error("Zyte fallback also failed:", zyteError);
            }
          }
          sendProgress(controller, "Fallback extraction", "Dynamic scrape failed, trying direct page fetch");
        }
      }
    }

    // Fallback direct fetch if needed
    if (imageUrls.length === 0 || !airbnbPrice) {
      checkStage1Timeout();
      sendProgress(controller, "Fallback extraction", "Trying direct page fetch");
      try {
        const resp = await fetchWithTimeout(
          search.airbnb_url,
          {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0" },
          },
          20_000
        );
        if (resp.ok) {
          const html = await resp.text();
          const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
          if (titleMatch && (!airbnbTitle || airbnbTitle === "Vacation Rental")) {
            airbnbTitle = titleMatch[1].replace(" - Airbnb", "").trim();
          }

          if (imageUrls.length === 0) {
            const patterns = [
              /https:\/\/a\d+\.muscache\.com\/im\/pictures\/[^"'\s\)]+/gi,
              /https:\/\/.*?\.muscache\.com\/im\/pictures\/[^"'\s\)]+/gi,
            ];
            let found: string[] = [];
            for (const p of patterns) found.push(...(html.match(p) || []));
            imageUrls = [...new Set(found.map((u) => u.split("?")[0]))]
              .filter(isValidPropertyImage)
              .map((u) => `${u}?im_w=1200`)
              .slice(0, 5);
          }

          if (!airbnbPrice) {
            checkStage1Timeout();
            sendProgress(controller, "Extracting Airbnb price", "Using AI to find the exact price");
            airbnbPrice = await extractAirbnbTotalPriceWithAI(html.slice(0, 15000), nights);
            if (airbnbPrice) sendProgress(controller, "Price extracted", `Found TOTAL: €${airbnbPrice}`);
          }
        }
      } catch (e) {
        console.error("Direct fetch error:", e);
      }
    }

    // Abort if no price (unless the user explicitly skipped this step)
    if (!airbnbPrice) {
      if (typeof skipAirbnbPrice !== "undefined" && skipAirbnbPrice === true) {
        sendProgress(controller, "Continuing without Airbnb price", "Proceeding to find alternatives (savings may be unavailable)", { skipped: true });
        await supabase
          .from("searches")
          .update({
            status: "searching_platforms",
            airbnb_title: airbnbTitle,
            airbnb_price: null,
            airbnb_image_url: imageUrls[0] || null,
            airbnb_images: imageUrls.slice(0, 5),
            check_in_date: checkIn,
            check_out_date: checkOut,
            nights_count: nights,
            last_progress_at: new Date().toISOString(),
          })
          .eq("id", searchId);
        // Continue the pipeline.
      } else {
        // Determine specific failure reason based on what we observed
        let failureCode = 'airbnb_price_element_missing';
        let failureMessage = "We couldn't find the total price on the Airbnb listing.";
        let userMessage = "Airbnb didn't show a total price for your selected dates. This can happen when dates are unavailable or the listing requires interaction to show pricing.";
        
        // Check what content we got to determine failure reason
        const hasContent = lastScrapedContent.markdown.length > 100 || lastScrapedContent.html.length > 100;
        const hasScreenshot = lastScrapedContent.hasScreenshot;
        
        if (!hasContent && !hasScreenshot) {
          failureCode = 'airbnb_blocked_or_captcha';
          failureMessage = "Airbnb blocked the page request (captcha or bot detection).";
          userMessage = "Airbnb is blocking automated requests. Please try again in a few minutes.";
        } else if (hasContent) {
          // Content available - analyze for specific issues
          const content = lastScrapedContent.markdown || lastScrapedContent.html;
          if (content.toLowerCase().includes('captcha') || content.toLowerCase().includes('robot') || content.toLowerCase().includes('verify you')) {
            failureCode = 'airbnb_blocked_or_captcha';
            failureMessage = "Airbnb requested human verification.";
            userMessage = "Airbnb is requiring verification. Please try again in a few minutes.";
          } else if (content.includes('Enter dates') || content.includes('Add dates') || content.includes('Check availability')) {
            failureCode = 'airbnb_dates_not_applied';
            failureMessage = "The dates from your URL weren't applied to the listing.";
            userMessage = "The dates in your Airbnb link weren't applied. Make sure check_in and check_out parameters are in the URL.";
          } else if ((content.includes('night') || content.includes('/night')) && !content.toLowerCase().includes('total')) {
            failureCode = 'airbnb_total_not_visible';
            failureMessage = "Airbnb shows per-night pricing but no total for your dates.";
            userMessage = "Airbnb isn't showing the total price for your dates. The property may require interaction to reveal pricing.";
          }
        }
        
        stage1Outcome = 'failed';
        stage1Error = failureCode.toUpperCase();
        
        // Update search with explicit failure info
        await supabase.from("searches").update({ 
          status: "error",
          api_error: failureMessage,
          api_error_code: failureCode,
          airbnb_title: airbnbTitle || null,
          airbnb_image_url: imageUrls[0] || null,
          airbnb_images: imageUrls.slice(0, 5),
          check_in_date: checkIn,
          check_out_date: checkOut,
          nights_count: nights,
          last_progress_at: new Date().toISOString(),
        }).eq("id", searchId);
        
        sendProgress(controller, "Price unavailable", failureMessage);
        sendSSE(controller, "error", {
          message: userMessage,
          code: failureCode,
          canRetry: failureCode === 'airbnb_blocked_or_captcha' || failureCode === 'airbnb_timeout',
        });
        sendSSE(controller, "complete", { success: false, error: failureCode });
        return;
      }
    }

    // Abort if no images
    if (imageUrls.length === 0) {
      sendProgress(controller, "No images found", "Could not extract property images");
      await supabase
        .from("searches")
        .update({
          status: "completed",
          airbnb_title: airbnbTitle,
          airbnb_price: airbnbPrice,
          airbnb_image_url: null,
          airbnb_images: [],
          check_in_date: checkIn,
          check_out_date: checkOut,
          nights_count: nights,
        })
        .eq("id", searchId);
      sendSSE(controller, "complete", {
        success: true,
        results: [],
        airbnb: { title: airbnbTitle, price: airbnbPrice, url: search.airbnb_url, images: [] },
        dates: { checkIn, checkOut, nights },
      });
      return;
    }

    // Step 2: Google Lens visual search
    sendProgress(controller, "Starting visual search", `Searching ${imageUrls.length} images across booking platforms`);
    await supabase.from("searches").update({ status: "searching_platforms", last_progress_at: new Date().toISOString() }).eq("id", searchId);
  } catch (e) {
    stage1Outcome = 'failed';
    stage1Error = e instanceof Error ? e.message : 'Unknown error';

    const failureCode = stage1Error === 'AIRBNB_PARSING_TIMEOUT' ? 'timeout' : 'provider_error';
    const message = stage1Error === 'AIRBNB_PARSING_TIMEOUT'
      ? 'Could not retrieve Airbnb listing details (timeout)'
      : `Could not retrieve Airbnb listing details (${stage1Error})`;

    console.error('Stage 1 failed:', stage1Error);

    await supabase.from('searches').update({
      status: 'error',
      api_error: message,
      api_error_code: `airbnb_parsing_${failureCode}`,
      last_progress_at: new Date().toISOString(),
    }).eq('id', searchId);

    sendSSE(controller, 'error', { message });
    sendSSE(controller, 'complete', { success: false, error: stage1Error, failureCode });
    return;
  } finally {
    await finishStageRun(supabase, searchId, 'analyze_listing', stage1Outcome, stage1Error);
  }

  const searchStartTime = Date.now();
  const MAX_TIME = 120000;
  const MAX_AI = 30;
  let aiCount = 0;

  // Initialize API error tracker
  const apiErrorTracker = createApiErrorTracker();

  // Track the best match per platform (by confidence score)
  // Key: normalized platform name, Value: best alternative found so far
  const bestMatchPerPlatform = new Map<string, typeof alternatives[number]>();

  for (let idx = 0; idx < imageUrls.length && Date.now() - searchStartTime < MAX_TIME; idx++) {
    // Check if we should abort due to API errors
    if (shouldAbortDueToApiErrors(apiErrorTracker)) {
      console.log("Aborting visual search due to API errors:", getApiErrorSummary(apiErrorTracker));
      sendProgress(controller, "Search API issue", getApiErrorSummary(apiErrorTracker) || "API error", { 
        isQuotaError: apiErrorTracker.hasQuotaError,
        errorCount: apiErrorTracker.serpApiErrors.length
      });
      // Store the error in database
      await supabase.from("searches").update({ 
        api_error: getApiErrorSummary(apiErrorTracker),
        api_error_code: apiErrorTracker.hasQuotaError ? 'quota_exceeded' : 'api_error',
        last_progress_at: new Date().toISOString() 
      }).eq("id", searchId);
      break;
    }

    if (await claimSkipNow()) {
      console.log("SKIP requested - skipping remaining visual search");
      sendProgress(controller, "Skipped current step", "Skipping remaining image search and continuing", { skipped: true });
      break;
    }

    await heartbeat();
    const imageUrl = imageUrls[idx];
    sendProgress(controller, `Searching image ${idx + 1} of ${imageUrls.length}`, "Running AI reverse image search on Booking.com, Vrbo, TripAdvisor...", { imageIndex: idx + 1, totalImages: imageUrls.length });
    await supabase.from("searches").update({ status: `searching_platforms_lens_${idx + 1}_of_${imageUrls.length}`, last_progress_at: new Date().toISOString() }).eq("id", searchId);
    
    // Use the new SerpAPI helper with proper error handling
    const lensResult = await fetchSerpApi(
      `engine=google_lens&url=${encodeURIComponent(imageUrl)}`,
      serpApiKey
    );

    if (!lensResult.success) {
      if (lensResult.error) {
        recordApiError(apiErrorTracker, lensResult.error);
        console.error(`Google Lens API error for image ${idx + 1}:`, lensResult.error.message);
        sendProgress(controller, "Search API issue", lensResult.error.message, { 
          errorType: lensResult.error.type,
          isQuotaError: lensResult.error.type === 'quota_exceeded'
        });
      }
      continue;
    }
    
    // Reset consecutive errors on success
    resetConsecutiveErrors(apiErrorTracker);
    
    const lensData = lensResult.data;
    const visualMatches = lensData?.visual_matches || [];
    sendProgress(controller, `Found ${visualMatches.length} potential matches`, "Verifying with AI comparison", { matchCount: visualMatches.length });

    let matchesThisImage = 0;
    for (const match of visualMatches) {
      if (await claimSkipNow()) {
        console.log("SKIP requested - stopping match verification for this image");
        sendProgress(controller, "Skipped current step", "Skipping remaining match verification", { skipped: true });
        matchesThisImage = 999;
        break;
      }

      if (aiCount >= MAX_AI || matchesThisImage >= 8) break;
      if (Date.now() - searchStartTime > MAX_TIME) break;

      const matchUrl = match.link;
      if (!matchUrl || matchUrl.toLowerCase().includes("airbnb.") || foundUrls.has(matchUrl)) continue;
      if (isBlockedNonBookingPlatform(matchUrl)) continue;
      if (!isBookingPlatform(matchUrl) && !isRegionalHotelSite(matchUrl) && !isDirectPropertySite(matchUrl)) continue;
      
      const platformName = getPlatformName(matchUrl);
      const platformKey = platformName.toLowerCase().replace(/[^a-z0-9]/g, '');
      
      // Check if we already have a match for this platform with high confidence
      const existingMatch = bestMatchPerPlatform.get(platformKey);
      if (existingMatch && existingMatch.confidence_score && existingMatch.confidence_score >= 0.98) {
        // Already have an excellent match for this platform, skip
        console.log(`Skipping ${platformName} verification - already have 98%+ match`);
        continue;
      }

      sendProgress(controller, `Verifying match on ${platformName}`, "AI comparing property photos to confirm it's the same place", { platform: platformName });
      await supabase.from("searches").update({ status: `ai_verifying_${platformName.toLowerCase().replace(/[^a-z0-9]/g, "_")}`, last_progress_at: new Date().toISOString() }).eq("id", searchId);
      await heartbeat();

      aiCount++;
      matchesThisImage++;
      foundUrls.add(matchUrl);

      const aiResult = await compareImagesWithAI(imageUrl, match.thumbnail || matchUrl);
      
      if (aiResult.isMatch && aiResult.score >= 90) {
        const newConfidence = aiResult.score / 100;
        
        // Only keep this match if it's better than what we have for this platform
        if (!existingMatch || newConfidence > (existingMatch.confidence_score || 0)) {
          const newMatch = {
            platform_name: platformName,
            listing_url: matchUrl,
            listing_title: match.title || null,
            price: null,
            confidence_score: newConfidence,
            image_url: match.thumbnail || null,
            images: match.thumbnail ? [match.thumbnail] : [],
            match_type: 'visual' as const,
            source_airbnb_image: imageUrl,
          };
          
          bestMatchPerPlatform.set(platformKey, newMatch);
          
          if (existingMatch) {
            sendProgress(controller, `Better match on ${platformName}`, `${aiResult.score}% confidence (was ${Math.round((existingMatch.confidence_score || 0) * 100)}%)`, { platform: platformName, confidence: aiResult.score });
          } else {
            sendProgress(controller, `Verified match on ${platformName}`, `${aiResult.score}% confidence - same property confirmed`, { platform: platformName, confidence: aiResult.score });
          }
        }
      }
    }
  }

  // After all verification, collect best matches into alternatives array
  alternatives.push(...bestMatchPerPlatform.values());

  const visualCount = bestMatchPerPlatform.size;
  sendProgress(controller, `Found ${visualCount} verified platforms`, "Each platform verified once - now collecting prices");

  // If we got no visual matches, run a targeted text search across likely platforms
  if (visualCount === 0) {
    const location = extractLocationFromTitle(airbnbTitle);
    await addTargetedTextMatches({
      serpApiKey,
      title: airbnbTitle,
      cityHint: location.city,
      imageUrlForVerification: imageUrls[0] || null,
      alternatives,
      foundUrls,
      controller,
      errorTracker: apiErrorTracker,
    });
  }

  // Store any API errors that occurred during the search
  if (apiErrorTracker.serpApiErrors.length > 0) {
    const errorSummary = getApiErrorSummary(apiErrorTracker);
    await supabase.from("searches").update({ 
      api_error: errorSummary,
      api_error_code: apiErrorTracker.hasQuotaError ? 'quota_exceeded' : 
                      apiErrorTracker.hasRateLimitError ? 'rate_limited' : 'api_error',
    }).eq("id", searchId);
  }

  const visualCountAfterFallback = alternatives.filter(a => a.match_type === 'visual').length;
  const totalCandidates = alternatives.length;

  if (totalCandidates === 0) {
    await supabase.from("searches").update({ status: "completed", airbnb_title: airbnbTitle, airbnb_price: airbnbPrice }).eq("id", searchId);
    sendSSE(controller, "complete", { success: true, results: [], airbnb: { title: airbnbTitle, price: airbnbPrice, images: imageUrls } });
    return;
  }

  sendProgress(controller, `Proceeding with ${totalCandidates} candidate listings`, visualCountAfterFallback > 0 ? "Includes visually verified matches" : "Text-only candidates (no photo verification)");

  // Step 3: Scrape prices
  sendProgress(controller, "Collecting prices", `Getting prices from ${alternatives.length} platforms for dates ${checkIn} to ${checkOut}`);
  await supabase.from("searches").update({ status: "comparing_prices", last_progress_at: new Date().toISOString() }).eq("id", searchId);

  // Keep it bounded: price scraping is the slowest + most rate-limited step.
  // Scrape more candidates (and prioritize major booking platforms) so we don't miss cheaper listings.
  const prioritizedForPricing = [...alternatives].sort((a, b) => {
    const score = (x: typeof alternatives[number]) => {
      const u = x.listing_url.toLowerCase();
      if (u.includes("booking.com")) return 5;
      if (u.includes("tripadvisor.")) return 5;
      if (u.includes("vrbo.com") || u.includes("homeaway.")) return 4;
      if (u.includes("holidaycheck.")) return 4;
      if (isRegionalHotelSite(x.listing_url) || isDirectPropertySite(x.listing_url)) return 3;
      return 0;
    };
    return score(b) - score(a);
  });

  // Fetch platform adapters to check coverage tier
  interface PlatformAdapterInfo {
    platform_domain: string;
    coverage_tier: string | null;
    coverage_status: string | null;
    coverage_reason: string | null;
  }
  const { data: platformAdapters } = await supabase
    .from("platform_adapters")
    .select("platform_domain, coverage_tier, coverage_status, coverage_reason") as { data: PlatformAdapterInfo[] | null };
  
  const tierCDomains = new Set<string>();
  platformAdapters?.forEach((adapter: PlatformAdapterInfo) => {
    if (adapter.coverage_tier === 'C' || adapter.coverage_status === 'blocked') {
      tierCDomains.add(adapter.platform_domain.toLowerCase());
    }
  });

  // Helper to check if a URL belongs to a Tier C platform
  const isTierCPlatform = (url: string): { isTierC: boolean; reason?: string } => {
    const urlLower = url.toLowerCase();
    for (const domain of tierCDomains) {
      if (urlLower.includes(domain)) {
        const adapter = platformAdapters?.find((a: PlatformAdapterInfo) => a.platform_domain.toLowerCase() === domain);
        return { 
          isTierC: true, 
          reason: adapter?.coverage_reason || 'Platform not supported (Tier C)' 
        };
      }
    }
    return { isTierC: false };
  };

  const toScrape = prioritizedForPricing.slice(0, 20);
  for (let i = 0; i < toScrape.length; i++) {
    // Check for skip request before each price scrape
    if (await claimSkipNow()) {
      console.log("SKIP requested - stopping price scraping");
      sendProgress(controller, "Skipped price collection", "Moving to results with data collected so far", { skipped: true });
      break;
    }
    await heartbeat();

    const alt = toScrape[i];
    
    // SHORT-CIRCUIT: Check if platform is Tier C (blocked/unsupported) BEFORE any extraction attempt
    const tierCCheck = isTierCPlatform(alt.listing_url);
    if (tierCCheck.isTierC) {
      console.log(`Skipping extraction for ${alt.platform_name}: Tier C - ${tierCCheck.reason}`);
      sendProgress(
        controller,
        `Skipped ${alt.platform_name}`,
        `Platform unsupported (Tier C): ${tierCCheck.reason}`,
        { platform: alt.platform_name, skipped: true, tier: 'C', reason: tierCCheck.reason }
      );
      // Mark in alternatives so it's saved with explicit unsupported status
      (alt as any)._tierCSkipped = true;
      (alt as any)._tierCReason = tierCCheck.reason;
      continue;
    }
    
    // Validate URL is an actual bookable property page before scraping
    const urlValidation = isValidBookablePropertyUrl(alt.listing_url);
    if (!urlValidation.valid) {
      console.log(`Skipping price scrape for ${alt.platform_name}: ${urlValidation.reason} - ${alt.listing_url.slice(0, 100)}`);
      sendProgress(
        controller,
        `Skipped ${alt.platform_name}`,
        urlValidation.reason || "Not a bookable property page",
        { platform: alt.platform_name, skipped: true }
      );
      continue;
    }
    
    sendProgress(
      controller,
      `Getting price from ${alt.platform_name}`,
      `Checking availability for ${checkIn} to ${checkOut} (${i + 1}/${toScrape.length})`,
      { platform: alt.platform_name, index: i + 1, total: toScrape.length }
    );
    await supabase
      .from("searches")
      .update({ status: `scraping_price_${alt.platform_name.toLowerCase().replace(/[^a-z0-9]/g, "_")}_${i + 1}_of_${toScrape.length}`, last_progress_at: new Date().toISOString() })
      .eq("id", searchId);

    if (!firecrawlApiKey) continue;

    const priceData = await scrapePriceFromListing(alt.listing_url, checkIn, checkOut, firecrawlApiKey, alt.platform_name, claimSkipNow);
    
    // If price scraping was skipped, break out of the loop
    if (priceData.skipped) {
      console.log(`Price scraping skipped for ${alt.platform_name} - breaking out of loop`);
      sendProgress(controller, "Skipped price collection", "Moving to results with data collected so far", { skipped: true });
      break;
    }
    
    alt.price = priceData.perNightRate;
    alt.price_check_in = priceData.usedCheckIn;
    alt.price_check_out = priceData.usedCheckOut;
    alt.dates_differ = priceData.datesDiffer;

    if (priceData.perNightRate && priceData.perNightRate >= 10) {
      if (priceData.datesDiffer) {
        sendProgress(
          controller,
          `Found price on ${alt.platform_name}`,
          `€${priceData.perNightRate}/night (dates ${priceData.usedCheckIn} - ${priceData.usedCheckOut}, original dates unavailable)`,
          { platform: alt.platform_name, price: priceData.perNightRate, datesDiffer: true }
        );
      } else {
        sendProgress(controller, `Found price on ${alt.platform_name}`, `€${priceData.perNightRate}/night`, {
          platform: alt.platform_name,
          price: priceData.perNightRate,
        });
      }
    } else {
      sendProgress(controller, `No price on ${alt.platform_name}`, "No valid price found for the selected dates", {
        platform: alt.platform_name,
      });
    }
  }

  // Calculate savings for all alternatives (including those without prices)
  const allResultsWithMeta = alternatives.map((alt) => ({
    ...alt,
    original_price: airbnbPrice,
    savings_amount: airbnbPrice && alt.price && alt.price < airbnbPrice ? airbnbPrice - alt.price : null,
    savings_percentage: airbnbPrice && alt.price && alt.price < airbnbPrice ? Math.round(((airbnbPrice - alt.price) / airbnbPrice) * 100) : null,
  }));

  // Separate results with and without prices for sorting
  const resultsWithPrices = allResultsWithMeta.filter((a) => !!a.price && a.price >= 10);
  const resultsWithoutPrices = allResultsWithMeta.filter((a) => !a.price || a.price < 10);

  // Sort priced results by savings
  resultsWithPrices.sort((a, b) => (b.savings_percentage ?? 0) - (a.savings_percentage ?? 0));

  // Combine: priced results first, then priceless results (still valuable photo matches)
  const allResultsSorted = [...resultsWithPrices, ...resultsWithoutPrices];

  // Save ALL results to DB (including those without prices - they're still valuable photo matches)
  console.log(`Attempting to save ${allResultsSorted.length} results to DB (${resultsWithPrices.length} with prices, ${resultsWithoutPrices.length} without) for search ${searchId}`);
  if (allResultsSorted.length > 0) {
    // BACKEND GUARD: Tier C platforms must NEVER have prices persisted
    // This is defense-in-depth - even if upstream logic fails, prices cannot leak
    const insertData = allResultsSorted.map((r) => {
      const tierCCheck = isTierCPlatform(r.listing_url);
      const isTierC = tierCCheck.isTierC || (r as any)._tierCSkipped;
      
      if (isTierC && r.price) {
        console.log(`GUARD: Nulling price for Tier C platform ${r.platform_name} (was ${r.price})`);
      }
      
      return {
        search_id: searchId,
        platform_name: r.platform_name,
        listing_url: r.listing_url,
        listing_title: r.listing_title,
        // CRITICAL: Null price for Tier C platforms
        price: isTierC ? null : r.price,
        original_price: r.original_price,
        savings_amount: isTierC ? null : r.savings_amount,
        savings_percentage: isTierC ? null : r.savings_percentage,
        confidence_score: r.confidence_score,
        image_url: r.image_url,
        images: r.images,
        match_type: r.match_type,
        source_airbnb_image: r.source_airbnb_image || null,
        price_check_in: r.price_check_in || checkIn,
        price_check_out: r.price_check_out || checkOut,
        dates_differ: r.dates_differ || false,
      };
    });
    console.log(
      "Insert data:",
      JSON.stringify(insertData.map((d) => ({ platform: d.platform_name, url: d.listing_url.slice(0, 50), price: d.price, datesDiffer: d.dates_differ })))
    );
    const { data: insertedData, error: insertError } = await supabase.from("search_results").insert(insertData).select();
    if (insertError) {
      console.error("CRITICAL: Failed to insert search results:", insertError.message, insertError.details);
    } else {
      console.log(`SUCCESS: Inserted ${insertedData?.length || 0} results to search_results table`);
      
      // After saving results, trigger deep link generation for price extraction
      // This runs in the background and doesn't block the response
      if (insertedData && insertedData.length > 0) {
        sendProgress(controller, "Generating booking links", "Creating deep links with dates for each platform");
        
        try {
          // Call generate-deep-links function to create proper booking links
          const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
          const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
          
          const deepLinkResponse = await fetch(`${supabaseUrl}/functions/v1/generate-deep-links`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${supabaseServiceKey}`,
            },
            body: JSON.stringify({
              searchId,
              checkIn,
              checkOut,
              adults: 2, // Default occupancy
              children: 0,
              rooms: 1,
            }),
          });
          
          if (deepLinkResponse.ok) {
            const deepLinkData = await deepLinkResponse.json();
            console.log(`Generated ${deepLinkData.deepLinks?.length || 0} deep links`);
            sendProgress(controller, "Booking links ready", `Created ${deepLinkData.deepLinks?.length || 0} platform-specific links`);
          } else {
            console.error("Failed to generate deep links:", await deepLinkResponse.text());
          }
        } catch (deepLinkError) {
          console.error("Error generating deep links:", deepLinkError);
          // Don't fail the search if deep link generation fails
        }
      }
    }
  }

  await supabase.from("searches").update({
    status: "completed",
    airbnb_title: airbnbTitle,
    airbnb_price: airbnbPrice,
    airbnb_image_url: imageUrls[0] || null,
    airbnb_images: imageUrls.slice(0, 5),
    check_in_date: checkIn,
    check_out_date: checkOut,
    nights_count: nights,
  }).eq("id", searchId);

  sendProgress(controller, "Search complete", allResultsSorted.length > 0 ? `Found ${allResultsSorted.length} alternatives (${resultsWithPrices.length} with prices)` : "No alternatives found");
  sendSSE(controller, "complete", {
    success: true,
    results: allResultsSorted,
    airbnb: { title: airbnbTitle, price: airbnbPrice, url: search.airbnb_url, imageUrl: imageUrls[0], images: imageUrls },
    dates: { checkIn, checkOut, nights },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Extract and verify JWT token
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Authentication required" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const serpApiKey = Deno.env.get("SERPAPI_API_KEY");
    const firecrawlApiKey = Deno.env.get("FIRECRAWL_API_KEY_1") || Deno.env.get("FIRECRAWL_API_KEY");

    if (!serpApiKey) {
      return new Response(
        JSON.stringify({ error: "Search service temporarily unavailable" }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    
    console.log("Firecrawl API available:", !!firecrawlApiKey);

    // Create a user-scoped client to verify the user
    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } }
    });

    // Get authenticated user
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) {
      console.error("Auth error:", userError?.message);
      return new Response(
        JSON.stringify({ error: "Invalid authentication token" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log("Authenticated user:", user.id);

    let body;
    try {
      body = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid request body" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    
    const { searchId, stream = false } = body;
    
    if (!searchId) {
      return new Response(
        JSON.stringify({ error: "Search ID is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validate searchId is a valid UUID
    if (typeof searchId !== "string" || !UUID_REGEX.test(searchId)) {
      return new Response(
        JSON.stringify({ error: "Invalid search ID format" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Use service role client for database operations
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Fetch the search and verify ownership
    const { data: search, error: searchError } = await supabase
      .from("searches")
      .select("*")
      .eq("id", searchId)
      .single();

    if (searchError || !search) {
      return new Response(
        JSON.stringify({ error: "Search not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // CRITICAL: Verify the search belongs to the authenticated user
    if (search.user_id !== user.id) {
      console.error("User", user.id, "attempted to access search owned by", search.user_id);
      return new Response(
        JSON.stringify({ error: "Access denied" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validate the Airbnb URL from the database
    if (!search.airbnb_url || !isValidAirbnbUrl(search.airbnb_url)) {
      console.error("Invalid Airbnb URL in database:", search.airbnb_url);
      return new Response(
        JSON.stringify({ error: "Invalid Airbnb URL" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ============================================================
    // If streaming mode requested, use SSE
    // ============================================================
    if (stream) {
      const sseHeaders = {
        ...corsHeaders,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      };

      const readableStream = new ReadableStream({
        async start(controller) {
          markControllerValid(controller);
          try {
            await runSearchWithStreaming(controller, {
              search,
              searchId,
              supabase,
              serpApiKey: serpApiKey!,
              firecrawlApiKey,
            });
          } catch (error) {
            console.error("Streaming search error:", error);
            const errorMessage = (error as Error).message || "Search failed";
            
            // CRITICAL: Always update DB to terminal state on error
            // This prevents searches from being stuck indefinitely
            try {
              await supabase.from("searches").update({ 
                status: "error",
                api_error: errorMessage,
                api_error_code: "pipeline_error",
              }).eq("id", searchId);
              console.log(`Search ${searchId} marked as error in DB`);
            } catch (dbError) {
              console.error("Failed to update search status to error:", dbError);
            }
            
            sendSSE(controller, "error", { message: errorMessage });
            sendSSE(controller, "complete", { success: false, error: errorMessage });
          } finally {
            markControllerInvalid(controller);
            try { controller.close(); } catch { /* already closed */ }
          }
        },
      });

      return new Response(readableStream, { headers: sseHeaders });
    }

    // ============================================================
    // Non-streaming mode (legacy) - existing code path
    // ============================================================
    console.log("Processing search for URL:", search.airbnb_url);

    const roomIdMatch = search.airbnb_url.match(/rooms\/(\d+)/);
    const roomId = roomIdMatch ? roomIdMatch[1] : null;
    console.log("Airbnb room ID:", roomId);

    // Extract dates from URL - REQUIRED for price comparison
    const { checkIn, checkOut } = extractDatesFromUrl(search.airbnb_url);
    if (!checkIn || !checkOut) {
      console.log("Missing dates in URL - dates are required for price comparison");
      await supabase.from("searches").update({ 
        status: "dates_required" 
      }).eq("id", searchId);
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: "Dates are required for price comparison. Please copy a full Airbnb URL that includes your check-in and check-out dates (e.g., airbnb.com/rooms/123?check_in=2025-01-15&check_out=2025-01-18).",
          status: "dates_required"
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 }
      );
    }
    console.log("Using URL dates:", checkIn, "to", checkOut);
    
    // Calculate nights
    const nights = calculateNights(checkIn, checkOut);

    // IMPORTANT: Save dates immediately after extraction so they're available even if search stalls
    console.log(`Extracted dates from URL: checkIn=${checkIn}, checkOut=${checkOut}, nights=${nights}`);
    await supabase.from("searches").update({ 
      check_in_date: checkIn, 
      check_out_date: checkOut, 
      nights_count: nights,
      status: "extracting_photos",
      last_progress_at: new Date().toISOString() 
    }).eq("id", searchId);

    const alternatives: SearchResult[] = [];
    const foundUrls = new Set<string>();
    let airbnbTitle = "Vacation Rental";
    let airbnbPrice: number | null = null;
    let firecrawlMarkdown = "";
    let firecrawlHtml = "";
    let directHtml = "";


    // Step 1: Fetch Airbnb page and extract property data using Firecrawl for JS rendering
    console.log("Step 1: Extracting property data from Airbnb...");
    
    let imageUrls: string[] = [];
    
    // Use Firecrawl if available (handles JS-rendered content like prices)
    if (firecrawlApiKey) {
      await supabase.from("searches").update({ status: "scraping_airbnb_page" }).eq("id", searchId);
      console.log("Using Firecrawl to scrape Airbnb (with JS rendering)...");
      try {
        console.log("Firecrawl scraping Airbnb with extended wait time...");
        // NOTE: Firecrawl requires waitFor <= timeout/2. Use timeout=60000, waitFor=25000.
        const firecrawlResponse = await fetch('https://api.firecrawl.dev/v1/scrape', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${firecrawlApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            url: search.airbnb_url,
            formats: ['markdown', 'html', 'rawHtml'],
            onlyMainContent: false,
            waitFor: 25000, // Must be <= timeout/2. Airbnb needs time for JS.
            timeout: 60000, // Overall timeout
          }),
        });
        
        if (firecrawlResponse.ok) {
          const firecrawlData = await firecrawlResponse.json();
          const markdown = firecrawlData.data?.markdown || '';
          const html = firecrawlData.data?.html || '';
          const rawHtml = firecrawlData.data?.rawHtml || html;

          // Keep copies for potential AI-based price extraction later
          firecrawlMarkdown = markdown;
          firecrawlHtml = rawHtml || html;

          
          console.log("Firecrawl response - markdown length:", markdown.length, "html length:", html.length);
          
          // Extract title from metadata or content
          const metaTitle = firecrawlData.data?.metadata?.title;
          if (metaTitle) {
            airbnbTitle = metaTitle
              .replace(" - Airbnb", "")
              .replace(" · Airbnb", "")
              .replace(/\s*-\s*(Houses|Apartments|Homes|Villas|Cabins|Cottages|Condos)?\s*(for Rent|to Rent|zur Miete|in)?\s*.*$/i, "")
              .trim();
            console.log("Extracted title from metadata:", airbnbTitle);
          }
          
          // Extract price from Firecrawl content - multiple patterns for different currencies
          const pricePatterns = [
            // Total price patterns (most reliable)
            /total[:\s]*€\s*(\d{1,5}(?:,\d{3})*)/i,
            /total[:\s]*\$\s*(\d{1,5}(?:,\d{3})*)/i,
            /total[:\s]*CHF\s*(\d{1,5}(?:,\d{3})*)/i,
            /gesamt[:\s]*€\s*(\d{1,5}(?:,\d{3})*)/i,
            // Per night patterns
            /€\s*(\d{1,5}(?:,\d{3})*)\s*(?:per night|\/night|night|pro nacht)/i,
            /\$\s*(\d{1,5}(?:,\d{3})*)\s*(?:per night|\/night|night)/i,
            /CHF\s*(\d{1,5}(?:,\d{3})*)\s*(?:per night|\/night|night|pro nacht)/i,
            // Generic price patterns
            /€(\d{1,5}(?:,\d{3})*)\s*x\s*\d+\s*nights?/i,
            /\$(\d{1,5}(?:,\d{3})*)\s*x\s*\d+\s*nights?/i,
            // Fallback: any price-like number after currency
            /€\s*(\d{2,4})/,
            /\$\s*(\d{2,4})/,
            /CHF\s*(\d{2,4})/,
          ];
          
          // Try markdown first (cleaner), then HTML
          const contentToSearch = markdown + ' ' + html;
          
          for (const pattern of pricePatterns) {
            const priceMatch = contentToSearch.match(pattern);
            if (priceMatch) {
              const priceStr = priceMatch[1].replace(/,/g, '');
              const extractedPrice = parseInt(priceStr);
              // Validate price is reasonable (between 10 and 5000 per night)
              if (extractedPrice >= 10 && extractedPrice <= 5000) {
                airbnbPrice = extractedPrice;
                console.log("Extracted Airbnb price from Firecrawl:", airbnbPrice);
                break;
              }
            }
          }
          
          // Extract images from HTML content - comprehensive patterns for all Airbnb CDN formats
          const imagePatterns = [
            // Standard hosting images
            /https:\/\/a0\.muscache\.com\/im\/pictures\/hosting\/Hosting-[^"'\s\)\]\\<>]+/gi,
            /https:\/\/a0\.muscache\.com\/im\/pictures\/miso\/[^"'\s\)\]\\<>]+/gi,
            /https:\/\/a0\.muscache\.com\/im\/pictures\/BnbProperty\/[^"'\s\)\]\\<>]+/gi,
            /https:\/\/a0\.muscache\.com\/im\/pictures\/prohost-api\/[^"'\s\)\]\\<>]+/gi,
            // UUID format images
            /https:\/\/a0\.muscache\.com\/im\/pictures\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}[^"'\s\)\]\\<>]*/gi,
            // Airbnb media URLs (newer format)
            /https:\/\/a0\.muscache\.com\/im\/ml\/[^"'\s\)\]\\<>]+/gi,
            // Alternative subdomains (a1, a2, etc.)
            /https:\/\/a[0-9]\.muscache\.com\/im\/pictures\/[^"'\s\)\]\\<>]+/gi,
            // Generic muscache with any path to /pictures/
            /https:\/\/[a-z0-9]+\.muscache\.com\/[^"'\s\)\]\\<>]*pictures[^"'\s\)\]\\<>]+/gi,
            // Newer airbnbusercontent.com domain
            /https:\/\/[a-z0-9-]+\.airbnbusercontent\.com\/[^"'\s\)\]\\<>]+/gi,
          ];

          const canonicalizeMuscacheUrl = (url: string) => {
            let cleaned = url.replace(/\\u002F/g, "/").replace(/\\/g, "");
            // Remove trailing punctuation that might have been captured
            cleaned = cleaned.replace(/[,;:]+$/, "");
            // Remove query params like ?im_w=1200 to dedupe correctly
            return cleaned.split("?")[0];
          };

          let allImageUrls: string[] = [];
          const htmlContent = rawHtml || html;

          // Log content length for debugging
          console.log(`Searching for images in ${htmlContent.length} chars of HTML content`);

          for (const pattern of imagePatterns) {
            const matches = htmlContent.match(pattern) || [];
            if (matches.length > 0) {
              console.log(`Pattern ${pattern.source.substring(0, 50)}... found ${matches.length} matches`);
            }
            allImageUrls.push(...matches);
          }

          // Also check markdown for image URLs
          const markdownImageMatches = markdown.match(/https:\/\/[a-z0-9-]+\.(muscache|airbnbusercontent)\.com\/[^\s\)"\]\\<>]+/gi) || [];
          if (markdownImageMatches.length > 0) {
            console.log(`Markdown found ${markdownImageMatches.length} potential image URLs`);
          }
          allImageUrls.push(...markdownImageMatches);

          // Extract from embedded JSON data (more reliable for modern Airbnb pages)
          const jsonImagePatterns = [
            /"(?:pictureUrl|baseUrl|url)"\s*:\s*"(https:\/\/[^"]+muscache\.com[^"]+)"/gi,
            /"(?:pictureUrl|baseUrl|url)"\s*:\s*"(https:\/\/[^"]+airbnbusercontent\.com[^"]+)"/gi,
          ];
          for (const pattern of jsonImagePatterns) {
            let match;
            while ((match = pattern.exec(htmlContent)) !== null) {
              if (match[1]) {
                allImageUrls.push(match[1].replace(/\\u002F/g, "/").replace(/\\/g, ""));
              }
            }
          }

          // Log total found before filtering
          console.log(`Total raw image URLs found: ${allImageUrls.length}`);
          if (allImageUrls.length > 0) {
            console.log(`Sample URLs: ${allImageUrls.slice(0, 3).join(", ")}`);
          }

          const uniqueBases = [...new Set(allImageUrls.map(canonicalizeMuscacheUrl))];
          console.log(`Unique base URLs after deduplication: ${uniqueBases.length}`);

          // More lenient filter - accept muscache or airbnbusercontent
          const filteredUrls = uniqueBases.filter(url => {
            if (!url.includes("muscache.com") && !url.includes("airbnbusercontent.com")) return false;
            // Exclude obvious non-property images
            const excludePatterns = ["favicon", "logo", "icon", "brand", "sprite", "button", "avatar", "profile"];
            if (excludePatterns.some(p => url.toLowerCase().includes(p))) return false;
            return true;
          });
          
          console.log(`Filtered URLs after basic validation: ${filteredUrls.length}`);

          imageUrls = filteredUrls
            .map((base) => base.includes("?") ? base : `${base}?im_w=1200`)
            .slice(0, 5);

          console.log(`Final image URLs for search: ${imageUrls.length}`);
        } else {
          console.log("Firecrawl request failed:", firecrawlResponse.status);
        }
      } catch (e) {
        console.error("Firecrawl error:", e);
      }
    }
    
    // Fallback: direct fetch if Firecrawl didn't work
    if (imageUrls.length === 0 || !airbnbPrice) {
      console.log("Fallback: Direct fetch for Airbnb page...");
      try {
        const airbnbResponse = await fetch(search.airbnb_url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
          },
        });
        
        if (airbnbResponse.ok) {
          const html = await airbnbResponse.text();
          directHtml = html;
          console.log("Fetched Airbnb page directly, length:", html.length);
          
          // Extract title if not already set
          if (!airbnbTitle || airbnbTitle === "Vacation Rental") {
            const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
            if (titleMatch) {
              airbnbTitle = titleMatch[1]
                .replace(" - Airbnb", "")
                .replace(" · Airbnb", "")
                .replace(/\s*-\s*(Houses|Apartments|Homes|Villas|Cabins|Cottages|Condos)?\s*(for Rent|to Rent|zur Miete|in)?\s*.*$/i, "")
                .trim();
            }
          }
          
          // Extract images if not already found
          if (imageUrls.length === 0) {
            const imagePatterns = [
              /https:\/\/a0\.muscache\.com\/im\/pictures\/hosting\/Hosting-[^"'\s\)\]\\<>]+/gi,
              /https:\/\/a0\.muscache\.com\/im\/pictures\/miso\/[^"'\s\)\]\\<>]+/gi,
              /https:\/\/a0\.muscache\.com\/im\/pictures\/BnbProperty\/[^"'\s\)\]\\<>]+/gi,
              /https:\/\/a0\.muscache\.com\/im\/pictures\/prohost-api\/[^"'\s\)\]\\<>]+/gi,
              /https:\/\/a0\.muscache\.com\/im\/pictures\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}[^"'\s\)\]\\<>]*/gi,
              /https:\/\/a0\.muscache\.com\/im\/ml\/[^"'\s\)\]\\<>]+/gi,
              /https:\/\/a[0-9]\.muscache\.com\/im\/pictures\/[^"'\s\)\]\\<>]+/gi,
              /https:\/\/[a-z0-9]+\.muscache\.com\/[^"'\s\)\]\\<>]*pictures[^"'\s\)\]\\<>]+/gi,
              /https:\/\/[a-z0-9-]+\.airbnbusercontent\.com\/[^"'\s\)\]\\<>]+/gi,
            ];

            const canonicalizeMuscacheUrl = (url: string) => {
              let cleaned = url.replace(/\\u002F/g, "/").replace(/\\/g, "");
              cleaned = cleaned.replace(/[,;:]+$/, "");
              return cleaned.split("?")[0];
            };

            let allImageUrls: string[] = [];

            for (const pattern of imagePatterns) {
              const matches = html.match(pattern) || [];
              allImageUrls.push(...matches);
            }

            const jsonMatches = html.match(/"pictureUrl"\s*:\s*"([^"]+)"/g) || [];
            for (const match of jsonMatches) {
              const urlMatch = match.match(/"pictureUrl"\s*:\s*"([^"]+)"/);
              if (urlMatch && urlMatch[1]) {
                allImageUrls.push(urlMatch[1].replace(/\\u002F/g, "/"));
              }
            }

            const uniqueBases = [...new Set(allImageUrls.map(canonicalizeMuscacheUrl))];
            
            // More lenient filter - accept muscache or airbnbusercontent
            const filteredUrls = uniqueBases.filter(url => {
              if (!url.includes("muscache.com") && !url.includes("airbnbusercontent.com")) return false;
              const excludePatterns = ["favicon", "logo", "icon", "brand", "sprite", "button", "avatar", "profile"];
              if (excludePatterns.some(p => url.toLowerCase().includes(p))) return false;
              return true;
            });

            // Also extract from embedded JSON with broader pattern
            const jsonMatches2 = html.match(/"(?:pictureUrl|baseUrl|url)"\s*:\s*"(https:\/\/[^"]+(?:muscache|airbnbusercontent)\.com[^"]+)"/gi) || [];
            for (const match of jsonMatches2) {
              const urlMatch = match.match(/"(?:pictureUrl|baseUrl|url)"\s*:\s*"([^"]+)"/);
              if (urlMatch && urlMatch[1]) {
                const cleanUrl = urlMatch[1].replace(/\\u002F/g, "/").replace(/\\/g, "");
                if (!filteredUrls.includes(cleanUrl)) {
                  filteredUrls.push(cleanUrl);
                }
              }
            }

            imageUrls = filteredUrls
              .map((base) => base.includes("?") ? base : `${base}?im_w=1200`)
              .slice(0, 5);
            
            console.log(`Fallback found ${imageUrls.length} images from direct fetch`);
          }
          
          // Try to extract price from JSON data if not already found
          if (!airbnbPrice) {
            const pricePatterns = [
              /"priceString"\s*:\s*"[€$CHF]\s*(\d+)"/,
              /"price"\s*:\s*(\d+)/,
              /"basePrice"\s*:\s*(\d+)/,
              /"priceForDisplay"\s*:\s*"[€$CHF]?\s*(\d+)/,
            ];
            
            for (const pattern of pricePatterns) {
              const priceMatch = html.match(pattern);
              if (priceMatch) {
                const price = parseInt(priceMatch[1]);
                if (price >= 10 && price <= 5000) {
                  airbnbPrice = price;
                  console.log("Extracted price from direct fetch:", airbnbPrice);
                  break;
                }
              }
            }
          }
          
          console.log(`Direct fetch found ${imageUrls.length} images, price: ${airbnbPrice}`);
        }
      } catch (e) {
        console.error("Error fetching Airbnb page directly:", e);
      }
    }
    
    // CRITICAL: If we still don't have a price, try AI extraction as last resort
    if (!airbnbPrice) {
      await supabase.from("searches").update({ status: "extracting_price_with_ai" }).eq("id", searchId);
      console.log("Attempting AI-based price extraction...");
      
      // Prefer previously scraped content before making another network call
      let contentForAI = "";
      if (firecrawlMarkdown) {
        contentForAI = firecrawlMarkdown;
      } else if (firecrawlHtml) {
        contentForAI = firecrawlHtml;
      } else if (directHtml) {
        contentForAI = directHtml;
      } else if (firecrawlApiKey) {
        try {
          // NOTE: Firecrawl requires waitFor <= timeout/2. Use timeout=30000, waitFor=5000.
          const aiScrapeResponse = await fetch('https://api.firecrawl.dev/v1/scrape', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${firecrawlApiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              url: search.airbnb_url,
              formats: ['markdown'],
              onlyMainContent: true,
              waitFor: 5000,
              timeout: 30000, // Required: waitFor must be <= timeout/2
            }),
          });
          
          if (aiScrapeResponse.ok) {
            const aiData = await aiScrapeResponse.json();
            contentForAI = aiData.data?.markdown || '';
          }
        } catch (e) {
          console.error("Error fetching content for AI:", e);
        }
      }
      
      if (contentForAI) {
        await supabase.from("searches").update({ status: "extracting_price_with_ai" }).eq("id", searchId);
        const nights = calculateNights(checkIn, checkOut);
        airbnbPrice = await extractAirbnbTotalPriceWithAI(contentForAI, nights);
      }
    }

    
    // Log final price status and abort comparison if missing
    if (!airbnbPrice) {
      console.warn("FATAL: Could not extract Airbnb price - aborting comparison");
      const airbnbImageUrl = imageUrls.length > 0 ? imageUrls[0] : null;
      const airbnbImages = imageUrls.slice(0, 5);
      const nights = calculateNights(checkIn, checkOut);

      // Determine specific failure reason
      let errorCode = "airbnb_price_element_missing";
      let errorMessage = "Could not find price information on the Airbnb page";
      
      if (!firecrawlMarkdown && !firecrawlHtml && !directHtml) {
        errorCode = "airbnb_scrape_failed";
        errorMessage = "Failed to load Airbnb page content";
      } else if (firecrawlMarkdown.length < 500 && firecrawlHtml.length < 500) {
        errorCode = "airbnb_blocked";
        errorMessage = "Airbnb may have blocked or limited the request";
      }

      await supabase.from("searches").update({
        status: "price_unavailable",
        airbnb_title: airbnbTitle,
        airbnb_price: null,
        airbnb_image_url: airbnbImageUrl,
        airbnb_images: airbnbImages,
        check_in_date: checkIn,
        check_out_date: checkOut,
        nights_count: nights,
        api_error: errorMessage,
        api_error_code: errorCode,
      }).eq("id", searchId);

      return new Response(
        JSON.stringify({
          success: false,
          error: "AIRBNB_PRICE_UNAVAILABLE",
          message: errorMessage,
          code: errorCode,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    } else {
      console.log("SUCCESS: Airbnb price extracted:", airbnbPrice, "per night");
    }

    // EARLY TERMINATION: If no images found, we can't do visual search - abort early
    if (imageUrls.length === 0) {
      console.warn("FATAL: No property images found - aborting comparison");
      const nights = calculateNights(checkIn, checkOut);

      await supabase.from("searches").update({
        status: "completed",
        airbnb_title: airbnbTitle,
        airbnb_price: airbnbPrice,
        airbnb_image_url: null,
        airbnb_images: [],
        check_in_date: checkIn,
        check_out_date: checkOut,
        nights_count: nights,
      }).eq("id", searchId);

      return new Response(
        JSON.stringify({
          success: true,
          results: [],
          airbnb: {
            title: airbnbTitle,
            price: airbnbPrice,
            url: search.airbnb_url,
            imageUrl: null,
            images: [],
          },
          dates: { checkIn, checkOut, nights },
          message: "Could not extract property images for visual search.",
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Update status to step 2
    await supabase.from("searches").update({ 
      status: "searching_platforms" 
    }).eq("id", searchId);

    // Step 2: Use Google Lens for visual matching (much better than reverse image search)
    // CRITICAL: Track time and AI comparison budget to avoid timeout
    const searchStartTime = Date.now();
    const MAX_SEARCH_TIME_MS = 120000; // 2 minute limit for visual search phase (better coverage)
    const MAX_AI_COMPARISONS = 45; // More AI comparisons to capture more platforms
    const TARGET_VISUAL_MATCHES = 12; // Target more matches before stopping
    let aiComparisonCount = 0;

    const isTimeBudgetExceeded = () => {
      const elapsed = Date.now() - searchStartTime;
      if (elapsed > MAX_SEARCH_TIME_MS) {
        console.log(`TIME BUDGET EXCEEDED: ${elapsed}ms > ${MAX_SEARCH_TIME_MS}ms`);
        return true;
      }
      return false;
    };

    const isAIBudgetExceeded = () => {
      if (aiComparisonCount >= MAX_AI_COMPARISONS) {
        console.log(`AI COMPARISON BUDGET EXCEEDED: ${aiComparisonCount} >= ${MAX_AI_COMPARISONS}`);
        return true;
      }
      return false;
    };

    const hasEnoughMatches = () => {
      const visualCount = alternatives.filter(a => a.match_type === 'visual').length;
      if (visualCount >= TARGET_VISUAL_MATCHES) {
        console.log(`ENOUGH MATCHES FOUND: ${visualCount} >= ${TARGET_VISUAL_MATCHES}`);
        return true;
      }
      return false;
    };

    if (imageUrls.length > 0) {
      console.log("Step 2: Running Google Lens visual matching...");
      console.log(`Budget: ${MAX_AI_COMPARISONS} AI comparisons, ${MAX_SEARCH_TIME_MS}ms time, target ${TARGET_VISUAL_MATCHES} matches`);
      
      // Use up to 5 images for Lens (better recall) but still bounded by budgets
      const lensImages = imageUrls.slice(0, 5);

      for (let idx = 0; idx < lensImages.length; idx++) {
        const imageUrl = lensImages[idx];
        // Check budgets before starting new image
        if (isTimeBudgetExceeded() || hasEnoughMatches()) break;

        // Update status so the UI can show *exactly* what we're doing
        await supabase
          .from("searches")
          .update({ status: `searching_platforms_lens_${idx + 1}_of_${lensImages.length}` })
          .eq("id", searchId);

        try {
          console.log("Google Lens searching:", imageUrl.slice(0, 80));

          // Use Google Lens engine with proper error handling
          const lensResult = await fetchSerpApi(
            `engine=google_lens&url=${encodeURIComponent(imageUrl)}`,
            serpApiKey!
          );

          if (!lensResult.success) {
            console.log("Lens search failed:", lensResult.error?.message || "unknown error");
            // Check for quota/rate limit errors
            if (lensResult.error?.type === 'quota_exceeded' || lensResult.error?.type === 'rate_limited') {
              console.error(`SERPAPI ${lensResult.error.type.toUpperCase()}: ${lensResult.error.message}`);
              await supabase.from("searches").update({ 
                api_error: lensResult.error.message,
                api_error_code: lensResult.error.type,
              }).eq("id", searchId);
              break; // Stop searching if quota exceeded
            }
            continue;
          }

          const lensData = lensResult.data;

          // Log what we got
          console.log(
            "Lens results - visual_matches:",
            lensData.visual_matches?.length || 0,
            "knowledge_graph:",
            lensData.knowledge_graph ? "yes" : "no",
            "text_results:",
            lensData.text_results?.length || 0,
          );

          // Process visual matches - these are the key results with VISUAL CONFIRMATION
          // Prioritize likely booking-platform domains first to spend the AI budget where it matters.
          const visualMatchesRaw = (lensData.visual_matches || []).slice(0, 15);

          const urlPriority = (u: string | null | undefined) => {
            if (!u) return 0;
            const lower = u.toLowerCase();
            if (lower.includes("booking.com")) return 100;
            if (lower.includes("tripadvisor.")) return 95;
            if (isBookingPlatform(u)) return 80;
            if (isRegionalHotelSite(u)) return 70;
            if (isDirectPropertySite(u)) return 60;
            return 0;
          };

          const visualMatches = visualMatchesRaw
            .slice()
            .sort((a: any, b: any) => urlPriority(b.link) - urlPriority(a.link));

          for (const match of visualMatches) {
            // Check budgets before each comparison
            if (isTimeBudgetExceeded() || isAIBudgetExceeded() || hasEnoughMatches()) break;

            const url = match.link;
            if (!url) continue;
            if (url.toLowerCase().includes("airbnb.") || foundUrls.has(url)) continue;

            // Quick filter: only check booking platforms and direct sites, exclude blocked platforms
            if (isBlockedNonBookingPlatform(url)) continue;
            if (!isBookingPlatform(url) && !isRegionalHotelSite(url) && !isDirectPropertySite(url)) {
              continue;
            }
            
            // Validate URL is an actual bookable property page (not category/search page)
            const urlValidation = isValidBookablePropertyUrl(url);
            if (!urlValidation.valid) {
              console.log(`Skipping non-bookable URL: ${urlValidation.reason} - ${url.slice(0, 100)}`);
              continue;
            }

            console.log("Checking visual match:", url.slice(0, 100));

            // Get thumbnail/image URL from the match for AI comparison
            const matchImageUrl = match.thumbnail || match.original || null;

            if (!matchImageUrl) {
              console.log("No image available for AI comparison, skipping:", url.slice(0, 60));
              continue;
            }

            // Use AI to compare images and get similarity score
            // Wrap with timeout to prevent stuck AI comparisons (20s max)
            const platformSlug = getPlatformName(url).toLowerCase().replace(/[^a-z0-9]/g, "_");
            await supabase.from("searches").update({ status: `ai_verifying_${platformSlug}` }).eq("id", searchId);
            console.log(`Running AI comparison ${aiComparisonCount + 1}/${MAX_AI_COMPARISONS}...`);
            aiComparisonCount++;
            
            const AI_COMPARISON_TIMEOUT_MS = 20_000;
            let aiComparison = await withTimeout(
              () => compareImagesWithAI(imageUrl, matchImageUrl),
              AI_COMPARISON_TIMEOUT_MS,
              { score: 0, isMatch: false, explanation: "Timeout" },
              `AI comparison for ${platformSlug}`
            );
            console.log(
              `AI result: score=${aiComparison.score}, isMatch=${aiComparison.isMatch}, reason: ${aiComparison.explanation}`,
            );

            // Some platforms provide tiny/cropped thumbnails -> if we fail, retry with a high-res image from the page.
            if (
              !aiComparison.isMatch &&
              firecrawlApiKey &&
              (url.toLowerCase().includes("booking.com") || url.toLowerCase().includes("tripadvisor.")) &&
              !isAIBudgetExceeded() &&
              !isTimeBudgetExceeded()
            ) {
              console.log("Retrying AI match with scraped high-res image for:", url.slice(0, 80));
              // Wrap image scraping with timeout (15s max)
              const betterImage = await withTimeout(
                () => scrapeBestImageFromListing(url, firecrawlApiKey),
                15_000,
                null,
                `Scrape high-res image from ${platformSlug}`
              );
              if (betterImage) {
                console.log(`Running AI comparison ${aiComparisonCount + 1}/${MAX_AI_COMPARISONS} (hi-res retry)...`);
                aiComparisonCount++;
                aiComparison = await withTimeout(
                  () => compareImagesWithAI(imageUrl, betterImage),
                  AI_COMPARISON_TIMEOUT_MS,
                  { score: 0, isMatch: false, explanation: "Timeout" },
                  `AI comparison retry for ${platformSlug}`
                );
                console.log(
                  `AI retry result: score=${aiComparison.score}, isMatch=${aiComparison.isMatch}, reason: ${aiComparison.explanation}`,
                );

                // If it matches on retry, use the better image for display
                if (aiComparison.isMatch) {
                  match.thumbnail = betterImage;
                }
              }
            }

            // ONLY include matches with ≥90% AI confidence
            if (!aiComparison.isMatch) {
              console.log("AI rejected match (score < 90%):", url.slice(0, 60));
              continue;
            }

            // Use AI-verified confidence score (converted to 0-1 scale)
            const verifiedConfidence = aiComparison.score / 100;

            // Check if it's a known booking platform OR regional hotel site (skip blocked platforms)
            if (isBlockedNonBookingPlatform(url)) continue;
            if (isBookingPlatform(url) || isRegionalHotelSite(url)) {
              foundUrls.add(url);
              const resultImages: string[] = [];
              if (match.thumbnail) resultImages.push(match.thumbnail);

              alternatives.push({
                platform_name: getPlatformName(url),
                listing_url: url,
                listing_title: match.title || match.source || null,
                price: null,
                confidence_score: verifiedConfidence, // AI-verified confidence
                image_url: match.thumbnail || null,
                images: resultImages.slice(0, 5),
                match_type: "visual",
                source_airbnb_image: imageUrl, // Store the Airbnb image that matched
              });
              console.log(
                "✓ AI-VERIFIED match on platform:",
                getPlatformName(url),
                "confidence:",
                (verifiedConfidence * 100).toFixed(0) + "%",
              );
            }
            // Also check for direct property websites
            else if (isDirectPropertySite(url)) {
              foundUrls.add(url);
              const resultImages: string[] = [];
              if (match.thumbnail) resultImages.push(match.thumbnail);

              alternatives.push({
                platform_name: getPlatformName(url) + " (Direct)",
                listing_url: url,
                listing_title: match.title || match.source || null,
                price: null,
                confidence_score: verifiedConfidence, // AI-verified confidence
                image_url: match.thumbnail || null,
                images: resultImages.slice(0, 5),
                match_type: "visual",
                source_airbnb_image: imageUrl, // Store the Airbnb image that matched
              });
              console.log("✓ AI-VERIFIED direct site match:", url.slice(0, 80));
            }
          }

          // Also check knowledge graph for additional context - requires AI verification too
          if (!isTimeBudgetExceeded() && !isAIBudgetExceeded() && !hasEnoughMatches()) {
            if (lensData.knowledge_graph?.source?.link) {
              const kgUrl = lensData.knowledge_graph.source.link;
              const kgImage = lensData.knowledge_graph.thumbnail;

              if (!kgUrl.toLowerCase().includes("airbnb.") && !foundUrls.has(kgUrl) && kgImage) {
                if (isBookingPlatform(kgUrl) || isDirectPropertySite(kgUrl) || isRegionalHotelSite(kgUrl)) {
                  // AI verify knowledge graph match too
                  console.log(`Running AI comparison ${aiComparisonCount + 1}/${MAX_AI_COMPARISONS} (knowledge graph)...`);
                  aiComparisonCount++;
                  const kgComparison = await compareImagesWithAI(imageUrl, kgImage);

                  if (kgComparison.isMatch) {
                    foundUrls.add(kgUrl);
                    alternatives.push({
                      platform_name: getPlatformName(kgUrl),
                      listing_url: kgUrl,
                      listing_title: lensData.knowledge_graph.title || null,
                      price: null,
                      confidence_score: kgComparison.score / 100, // AI-verified
                      image_url: kgImage,
                      images: [kgImage],
                      match_type: "visual",
                      source_airbnb_image: imageUrl,
                    });
                    console.log("✓ AI-VERIFIED knowledge graph match:", kgUrl.slice(0, 80));
                  }
                }
              }
            }
          }

          // Small delay between searches to avoid rate limiting
          await new Promise((r) => setTimeout(r, 300));
        } catch (e) {
          console.error("Lens search error:", e);
        }
      }
      // If Lens didn't find enough and we still have budget, try reverse image search as backup
      if (alternatives.length < 3 && !isTimeBudgetExceeded() && !isAIBudgetExceeded()) {
        await supabase.from("searches").update({ status: "reverse_image_search_backup" }).eq("id", searchId);
        console.log("Running reverse image search as backup...");
        
        for (const imageUrl of imageUrls.slice(0, 2)) {
          // Check budgets before each image
          if (isTimeBudgetExceeded() || isAIBudgetExceeded() || hasEnoughMatches()) break;

          try {
            console.log("Reverse searching:", imageUrl.slice(0, 80));
            
            const reverseResult = await fetchSerpApi(
              `engine=google_reverse_image&image_url=${encodeURIComponent(imageUrl)}`,
              serpApiKey!
            );
            
            if (!reverseResult.success) {
              if (reverseResult.error?.type === 'quota_exceeded' || reverseResult.error?.type === 'rate_limited') {
                console.error(`SERPAPI ${reverseResult.error.type.toUpperCase()}: ${reverseResult.error.message}`);
                await supabase.from("searches").update({ 
                  api_error: reverseResult.error.message,
                  api_error_code: reverseResult.error.type,
                }).eq("id", searchId);
                break;
              }
              continue;
            }
            
            const reverseData = reverseResult.data;
            console.log("Reverse results - image:", reverseData?.image_results?.length || 0);
            
            // LIMIT results to check
            const allResults = [
              ...(reverseData.image_results || []),
              ...(reverseData.inline_images || []),
              ...(reverseData.organic_results || []),
            ].slice(0, 8);
            
            for (const result of allResults) {
              // Check budgets before each comparison
              if (isTimeBudgetExceeded() || isAIBudgetExceeded() || hasEnoughMatches()) break;

              const url = result.link || result.source;
              if (!url) continue;
              if (url.toLowerCase().includes("airbnb.") || foundUrls.has(url)) continue;
              
              const resultImage = result.thumbnail || result.original;
              if (!resultImage) continue;
              
              if (isBookingPlatform(url) || isDirectPropertySite(url) || isRegionalHotelSite(url)) {
                // AI verify reverse image match
                console.log(`Running AI comparison ${aiComparisonCount + 1}/${MAX_AI_COMPARISONS} (reverse)...`);
                aiComparisonCount++;
                const reverseComparison = await compareImagesWithAI(imageUrl, resultImage);
                
                if (!reverseComparison.isMatch) {
                  console.log("AI rejected reverse image match (score < 90%):", url.slice(0, 60));
                  continue;
                }
                
                foundUrls.add(url);
                alternatives.push({
                  platform_name: isBookingPlatform(url) || isRegionalHotelSite(url) ? getPlatformName(url) : getPlatformName(url) + " (Direct)",
                  listing_url: url,
                  listing_title: result.title || result.snippet || null,
                  price: null,
                  confidence_score: reverseComparison.score / 100, // AI-verified confidence
                  image_url: resultImage,
                  images: [result.thumbnail, result.original].filter(Boolean).slice(0, 5),
                  match_type: 'visual',
                  source_airbnb_image: imageUrl,
                });
                console.log("✓ AI-VERIFIED reverse image match:", url.slice(0, 80));
              }
            }
            
            await new Promise(r => setTimeout(r, 200));
          } catch (e) {
            console.error("Reverse search error:", e);
          }
        }
      }
    }

    console.log(`Search phase complete. AI comparisons used: ${aiComparisonCount}/${MAX_AI_COMPARISONS}, Time: ${Date.now() - searchStartTime}ms`);

    // If no visual matches were found, do a targeted text search on major platforms
    // so we can still surface obvious alternatives (even if not photo-verified).
    const visualMatchCount = alternatives.filter(a => a.match_type === 'visual').length;
    console.log(`Visual search complete: found ${visualMatchCount} AI-verified matches`);

    if (visualMatchCount === 0) {
      console.log("No visual matches found - running targeted text search fallback");

      const location = extractLocationFromTitle(airbnbTitle);
      await addTargetedTextMatches({
        serpApiKey: serpApiKey!,
        title: airbnbTitle,
        cityHint: location.city,
        imageUrlForVerification: imageUrls[0] || null,
        alternatives,
        foundUrls,
      });

      const nights = calculateNights(checkIn, checkOut);
      const airbnbImageUrl = imageUrls.length > 0 ? imageUrls[0] : null;
      const airbnbImages = imageUrls.slice(0, 5);

      // Filter to only results with valid prices before persisting
      const resultsWithValidPrices = alternatives.filter(a => a.price && a.price >= 10);
      
      if (resultsWithValidPrices.length > 0) {
        await supabase.from("search_results").insert(
          resultsWithValidPrices.map(r => ({
            search_id: searchId,
            platform_name: r.platform_name,
            listing_url: r.listing_url,
            listing_title: r.listing_title,
            price: r.price,
            original_price: airbnbPrice,
            savings_amount: null,
            savings_percentage: null,
            confidence_score: r.confidence_score,
            image_url: r.image_url,
            images: r.images,
            match_type: r.match_type,
            source_airbnb_image: r.source_airbnb_image || null,
            price_check_in: checkIn,
            price_check_out: checkOut,
            dates_differ: false,
          }))
        );
      }

      await supabase.from("searches").update({
        status: "completed",
        airbnb_title: airbnbTitle,
        airbnb_price: airbnbPrice,
        airbnb_image_url: airbnbImageUrl,
        airbnb_images: airbnbImages,
        check_in_date: checkIn,
        check_out_date: checkOut,
        nights_count: nights,
      }).eq("id", searchId);

      return new Response(
        JSON.stringify({
          success: true,
          results: alternatives,
          airbnb: {
            title: airbnbTitle,
            price: airbnbPrice,
            url: search.airbnb_url,
            imageUrl: airbnbImageUrl,
            images: airbnbImages,
          },
          dates: { checkIn, checkOut, nights },
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Update status to step 3
    await supabase.from("searches").update({ 
      status: "comparing_prices" 
    }).eq("id", searchId);

    // Step 3: Multi-strategy text search if we still need more results (only if we have some visual matches)
    if (alternatives.length < 5) {
      console.log("Step 3: Multi-strategy text search...");
      
      // Extract location info for better searches
      const location = extractLocationFromTitle(airbnbTitle);
      console.log("Extracted location:", location);
      
      // Clean up the title for searches
      const cleanTitle = airbnbTitle
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      
      // Multiple search strategies - expanded for better coverage
      const searchStrategies = [
        // Strategy 1: Exact property name + booking sites (including HolidayCheck explicitly)
        `"${cleanTitle.slice(0, 40)}" (booking.com OR tripadvisor OR holidaycheck OR agoda OR hrs) -airbnb`,
        // Strategy 2: Property name + location with broader hotel/guesthouse terms
        location.city ? `"${cleanTitle.slice(0, 30)}" ${location.city} (hotel OR guesthouse OR pension) -airbnb` : null,
        // Strategy 3: Site-specific searches for key platforms
        `${cleanTitle.slice(0, 30)} site:holidaycheck.de OR site:holidaycheck.com`,
        `${cleanTitle.slice(0, 30)} site:tripadvisor.com OR site:tripadvisor.ch OR site:tripadvisor.de`,
        // Strategy 4: Location + property type for regional sites
        location.city ? `${location.city} "${cleanTitle.slice(0, 25)}" (reviews OR booking) -airbnb -pinterest` : null,
        // Strategy 5: Direct site search across multiple platforms
        location.city ? `${cleanTitle.slice(0, 20)} ${location.city} site:booking.com OR site:hrs.de OR site:hotel.de` : null,
      ].filter(Boolean) as string[];
      
      for (const searchQuery of searchStrategies) {
        if (alternatives.length >= 10) break; // Stop if we have enough
        
        console.log("Text search:", searchQuery);
        
        try {
          const textResult = await fetchSerpApi(
            `engine=google&q=${encodeURIComponent(searchQuery)}&num=20`,
            serpApiKey!
          );
          
          if (!textResult.success) {
            if (textResult.error?.type === 'quota_exceeded' || textResult.error?.type === 'rate_limited') {
              console.error(`SERPAPI ${textResult.error.type.toUpperCase()}: ${textResult.error.message}`);
              await supabase.from("searches").update({ 
                api_error: textResult.error.message,
                api_error_code: textResult.error.type,
              }).eq("id", searchId);
              break;
            }
            continue;
          }
          
          const textData = textResult.data;
          const results = textData?.organic_results || [];
          
          for (const result of results) {
            const url = result.link;
            if (!url || url.toLowerCase().includes("airbnb.") || foundUrls.has(url)) continue;
            if (isBlockedNonBookingPlatform(url)) continue;
            
            if (isBookingPlatform(url) || isRegionalHotelSite(url)) {
              foundUrls.add(url);
              alternatives.push({
                platform_name: getPlatformName(url),
                listing_url: url,
                listing_title: result.title || null,
                price: null,
                confidence_score: null, // TEXT MATCH = NO VISUAL CONFIRMATION = NO TRUST SCORE
                image_url: result.thumbnail || null,
                images: result.thumbnail ? [result.thumbnail] : [],
                match_type: 'text',
              });
              console.log("Text match found (no visual confirmation):", getPlatformName(url));
            } else if (isDirectPropertySite(url)) {
              foundUrls.add(url);
              alternatives.push({
                platform_name: getPlatformName(url) + " (Direct)",
                listing_url: url,
                listing_title: result.title || null,
                price: null,
                confidence_score: null, // TEXT MATCH = NO VISUAL CONFIRMATION = NO TRUST SCORE
                image_url: result.thumbnail || null,
                images: result.thumbnail ? [result.thumbnail] : [],
                match_type: 'text',
              });
              console.log("Direct site text match (no visual confirmation):", url.slice(0, 80));
            }
          }
          
          await new Promise(r => setTimeout(r, 300));
        } catch (e) {
          console.error("Text search error:", e);
        }
      }
    }

    console.log(`Total alternatives found: ${alternatives.length}`);

    // Sort by confidence (visual matches first, then by score) and limit results
    // Visual matches with high confidence come first, text matches (null confidence) come last
    alternatives.sort((a, b) => {
      // Visual matches always before text matches
      if (a.match_type === 'visual' && b.match_type === 'text') return -1;
      if (a.match_type === 'text' && b.match_type === 'visual') return 1;
      // Within same type, sort by confidence (null = lowest)
      const scoreA = a.confidence_score ?? 0;
      const scoreB = b.confidence_score ?? 0;
      return scoreB - scoreA;
    });
    const topAlternatives = alternatives.slice(0, 10);

    // Use filtered property images (no logos)
    const airbnbImageUrl = imageUrls.length > 0 ? imageUrls[0] : null;
    const airbnbImages = imageUrls.slice(0, 5);

    console.log("Results breakdown - Visual matches:", alternatives.filter(a => a.match_type === 'visual').length,
                "Text matches:", alternatives.filter(a => a.match_type === 'text').length);

    // nights is already calculated above (line 3054)
    console.log(`Comparing prices for ${nights} nights: ${checkIn} to ${checkOut}`);

    // Step 4: Scrape prices from alternatives using Firecrawl (if available)
    // IMPORTANT: Store ALL visual matches - prices are optional, not required for display
    let resultsWithPriceAttempts: Array<typeof topAlternatives[0] & { 
      price_check_in?: string; 
      price_check_out?: string; 
      dates_differ?: boolean;
    }> = [];
    
    if (firecrawlApiKey && topAlternatives.length > 0) {
      await supabase.from("searches").update({ status: "comparing_prices" }).eq("id", searchId);
      console.log("Step 4: Scraping prices from alternatives...");

      // Prioritize Booking.com + TripAdvisor if present.
      const prioritized = [...topAlternatives].sort((a, b) => {
        const score = (p: string) => {
          const l = p.toLowerCase();
          if (l.includes("booking")) return 2;
          if (l.includes("tripadvisor")) return 2;
          return 0;
        };
        return score(b.platform_name) - score(a.platform_name);
      });

      const toScrape = prioritized.slice(0, 10); // Scrape more to increase chance of getting prices

      // Per-platform timeout: 25 seconds max per price scrape to prevent stuck searches
      const PRICE_SCRAPE_TIMEOUT_MS = 25_000;
      
      // Respect skip requests (manual/auto) while scraping prices
      async function shouldSkipPriceStep(): Promise<boolean> {
        const { data } = await supabase
          .from("searches")
          .select("status")
          .eq("id", searchId)
          .single();
        return data?.status === "skip_current_step";
      }

      for (let i = 0; i < toScrape.length; i++) {
        // Check if user requested to skip before starting this platform
        const skipRequested = await shouldSkipPriceStep();
        if (skipRequested) {
          console.log(`SKIP requested by user - skipping remaining ${toScrape.length - i} price scrapes`);
          // Reset status and break out of loop
          await supabase.from("searches").update({ status: "comparing_prices" }).eq("id", searchId);
          break;
        }
        
        const alt = toScrape[i];
        const platformSlug = alt.platform_name.toLowerCase().replace(/[^a-z0-9]/g, "_");
        await supabase.from("searches").update({
          status: `scraping_price_${platformSlug}_${i + 1}_of_${toScrape.length}`
        }).eq("id", searchId);
        console.log(`Scraping price ${i + 1}/${toScrape.length} from ${alt.platform_name}...`);

        // Wrap price scraping with timeout to prevent stuck searches
        const fallbackPriceData = {
          price: null,
          totalPrice: null,
          perNightRate: null,
          usedCheckIn: checkIn,
          usedCheckOut: checkOut,
          datesDiffer: false,
        };
        
        const priceData = await withTimeout(
          () => scrapePriceFromListing(alt.listing_url, checkIn, checkOut, firecrawlApiKey),
          PRICE_SCRAPE_TIMEOUT_MS,
          fallbackPriceData,
          `Price scrape for ${alt.platform_name}`
        );
        
        // Store ALL results - price is optional (null is OK)
        const hasValidPrice = priceData.perNightRate && priceData.perNightRate >= 10;
        if (hasValidPrice) {
          console.log(`✓ Valid price found: €${priceData.perNightRate}/night for ${alt.platform_name}`);
        } else {
          console.log(`○ No price extracted for ${alt.platform_name} - will still store match`);
        }
        
        resultsWithPriceAttempts.push({
          ...alt,
          price: hasValidPrice ? priceData.perNightRate : null,
          total_price: hasValidPrice ? priceData.totalPrice : null,
          per_night_rate: hasValidPrice ? priceData.perNightRate : null,
          price_check_in: priceData.usedCheckIn || checkIn,
          price_check_out: priceData.usedCheckOut || checkOut,
          dates_differ: priceData.datesDiffer || false,
        });
      }
      
      const withPrices = resultsWithPriceAttempts.filter(r => r.price && r.price >= 10).length;
      console.log(`Price scraping complete. ${withPrices}/${toScrape.length} listings have valid prices.`);
    } else if (topAlternatives.length > 0) {
      // No Firecrawl API key - store all matches without prices
      console.log("No Firecrawl API key available - storing visual matches without prices");
      resultsWithPriceAttempts = topAlternatives.map(alt => ({
        ...alt,
        price_check_in: checkIn,
        price_check_out: checkOut,
        dates_differ: false,
      }));
    }

    // Calculate savings based on Airbnb price
    const resultsWithSavings = resultsWithPriceAttempts.map(alt => {
      let savingsAmount: number | null = null;
      let savingsPercentage: number | null = null;
      
      if (airbnbPrice && alt.price && alt.price < airbnbPrice) {
        savingsAmount = airbnbPrice - alt.price;
        savingsPercentage = Math.round((savingsAmount / airbnbPrice) * 100);
      }
      
      return {
        ...alt,
        original_price: airbnbPrice,
        savings_amount: savingsAmount,
        savings_percentage: savingsPercentage,
      };
    });

    // Sort by savings (best deals first), then by confidence
    resultsWithSavings.sort((a, b) => {
      // First, prioritize results with actual savings
      const savingsA = a.savings_percentage ?? 0;
      const savingsB = b.savings_percentage ?? 0;
      if (savingsA !== savingsB) return savingsB - savingsA;
      
      // Then by match type (visual first)
      if (a.match_type === 'visual' && b.match_type === 'text') return -1;
      if (a.match_type === 'text' && b.match_type === 'visual') return 1;
      
      // Finally by confidence
      const scoreA = a.confidence_score ?? 0;
      const scoreB = b.confidence_score ?? 0;
      return scoreB - scoreA;
    });

    // Only store results that have valid prices (this is already filtered in step 4)
    if (resultsWithSavings.length > 0) {
      console.log(`Storing ${resultsWithSavings.length} results with valid prices`);
      await supabase.from("search_results").insert(
        resultsWithSavings.map(r => ({
          search_id: searchId,
          platform_name: r.platform_name,
          listing_url: r.listing_url,
          listing_title: r.listing_title,
          price: r.price,
          original_price: r.original_price,
          savings_amount: r.savings_amount,
          savings_percentage: r.savings_percentage,
          confidence_score: r.confidence_score,
          image_url: r.image_url,
          images: r.images,
          match_type: r.match_type,
          source_airbnb_image: r.source_airbnb_image || null,
          price_check_in: r.price_check_in || checkIn,
          price_check_out: r.price_check_out || checkOut,
          dates_differ: r.dates_differ || false,
        }))
      );
    } else {
      console.log("No results with valid prices to store");
    }

    await supabase.from("searches").update({ 
      status: "completed",
      airbnb_title: airbnbTitle,
      airbnb_price: airbnbPrice,
      airbnb_image_url: airbnbImageUrl,
      airbnb_images: airbnbImages,
      check_in_date: checkIn,
      check_out_date: checkOut,
      nights_count: nights,
    }).eq("id", searchId);

    console.log("Search completed with", resultsWithSavings.length, "results");

    return new Response(
      JSON.stringify({ 
        success: true, 
        results: resultsWithSavings,
        airbnb: { 
          title: airbnbTitle, 
          price: airbnbPrice, 
          url: search.airbnb_url, 
          imageUrl: airbnbImageUrl, 
          images: airbnbImages 
        },
        dates: { checkIn, checkOut, nights }
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Search error:", error);
    return new Response(
      JSON.stringify({ error: "An error occurred processing your request. Please try again." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
