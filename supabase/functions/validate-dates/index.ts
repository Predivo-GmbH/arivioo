import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Date application strategies
type DateApplicationStrategy = 'url_only' | 'url_then_navigate' | 'navigate_only';

// Validation result states
type ValidationStatus = 
  | 'dates_validated'
  | 'dates_not_applied'
  | 'no_availability_for_dates'
  | 'blocked_captcha_or_bot'
  | 'blocked_rate_limit'
  | 'render_failed'
  | 'failed_unknown';

interface ValidationRequest {
  extractionId: string;
  deepLink: string;
  platformName: string;
  requestedCheckIn: string;
  requestedCheckOut: string;
  strategy?: DateApplicationStrategy;
}

interface ValidationResult {
  success: boolean;
  status: ValidationStatus;
  detectedCheckIn?: string;
  detectedCheckOut?: string;
  finalUrl?: string;
  strategyUsed: DateApplicationStrategy;
  requiresNavigation?: boolean;
  navigationStepsUsed?: string[];
  error?: string;
  contentHash?: string;
}

// Simple hash for content deduplication
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}

// Normalize date string for comparison
function normalizeDate(dateStr: string): string {
  // Handle various formats: YYYY-MM-DD, MM/DD/YYYY, DD-MM-YYYY, etc.
  const cleaned = dateStr.replace(/[^\d-/]/g, '').trim();
  
  // Try to parse as Date and return YYYY-MM-DD
  try {
    const date = new Date(cleaned);
    if (!isNaN(date.getTime())) {
      return date.toISOString().split('T')[0];
    }
  } catch {
    // Fall through to regex parsing
  }
  
  // Try YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) {
    return cleaned;
  }
  
  // Try DD-MM-YYYY or DD/MM/YYYY
  const euMatch = cleaned.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (euMatch) {
    return `${euMatch[3]}-${euMatch[2].padStart(2, '0')}-${euMatch[1].padStart(2, '0')}`;
  }
  
  // Try MM-DD-YYYY or MM/DD/YYYY
  const usMatch = cleaned.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (usMatch) {
    return `${usMatch[3]}-${usMatch[1].padStart(2, '0')}-${usMatch[2].padStart(2, '0')}`;
  }
  
  return cleaned;
}

// Check if dates in content match requested dates
function datesMatch(detected: string, requested: string): boolean {
  const normalizedDetected = normalizeDate(detected);
  const normalizedRequested = normalizeDate(requested);
  return normalizedDetected === normalizedRequested;
}

// Default navigation hints per platform for date selection
const PLATFORM_NAVIGATION_HINTS: Record<string, string[]> = {
  'booking.com': ['See availability', 'Check availability', 'Reserve', 'Select dates'],
  'expedia.com': ['Check availability', 'See prices', 'Select dates'],
  'hotels.com': ['Check availability', 'See prices', 'Reserve'],
  'vrbo.com': ['Check availability', 'Request to book', 'Book now'],
  'agoda.com': ['See availability', 'Check rooms', 'Select dates'],
  'tripadvisor.com': ['Check availability', 'View deal', 'See prices'],
  'hostelworld.com': ['Check availability', 'See prices'],
  'hrs.com': ['Check availability', 'See prices', 'Book now'],
  'holidaycheck.de': ['Verfügbarkeit prüfen', 'Check availability', 'Preise anzeigen'],
};

// Firecrawl actions for navigation-based date application
function buildFirecrawlActions(navigationHints: string[]): any[] {
  const actions: any[] = [
    { type: 'wait', milliseconds: 2000 },
  ];
  
  // Add click actions for navigation hints
  for (const hint of navigationHints.slice(0, 3)) {
    actions.push({
      type: 'click',
      selector: `button:has-text("${hint}"), a:has-text("${hint}"), [role="button"]:has-text("${hint}")`,
    });
    actions.push({ type: 'wait', milliseconds: 1500 });
  }
  
  return actions;
}

// Validate dates using Firecrawl with optional navigation
async function validateWithFirecrawl(
  url: string,
  platformName: string,
  requestedCheckIn: string,
  requestedCheckOut: string,
  useNavigation: boolean,
  navigationHints: string[]
): Promise<ValidationResult> {
  const firecrawlApiKey = Deno.env.get('FIRECRAWL_API_KEY_1') || Deno.env.get('FIRECRAWL_API_KEY');
  
  if (!firecrawlApiKey) {
    console.log('[VALIDATE-DATES] Firecrawl API key not configured');
    return {
      success: false,
      status: 'failed_unknown',
      strategyUsed: useNavigation ? 'url_then_navigate' : 'url_only',
      error: 'Firecrawl API key not configured',
    };
  }

  try {
    console.log(`[VALIDATE-DATES] Validating ${url} (navigation: ${useNavigation})`);
    
    const requestBody: any = {
      url,
      formats: [
        'markdown',
        {
          type: 'json',
          schema: {
            type: 'object',
            properties: {
              checkin_date_detected: { 
                type: 'string', 
                description: 'Check-in date shown on page (any format)' 
              },
              checkout_date_detected: { 
                type: 'string', 
                description: 'Check-out date shown on page (any format)' 
              },
              dates_visible: { 
                type: 'boolean', 
                description: 'Are the booking dates clearly visible on the page?' 
              },
              availability_status: {
                type: 'string',
                enum: ['available', 'unavailable', 'unknown'],
                description: 'Is the property available for these dates?'
              },
              price_visible: {
                type: 'boolean',
                description: 'Is a price visible for the detected dates?'
              },
            },
            required: ['dates_visible', 'availability_status'],
          },
          prompt: `Analyze this ${platformName} booking page.

CRITICAL: Look for the CHECK-IN and CHECK-OUT dates that are currently selected/displayed on this page.

Requested dates were: Check-in ${requestedCheckIn}, Check-out ${requestedCheckOut}

Report:
1. What check-in date is shown on the page (checkin_date_detected)
2. What check-out date is shown on the page (checkout_date_detected)
3. Are dates clearly visible (dates_visible)
4. Is the property available for the shown dates (availability_status)
5. Is a price visible for these dates (price_visible)

Return the exact dates you see on the page, not the requested dates.`,
        },
      ],
      onlyMainContent: true,
      waitFor: 3000,
    };

    // Add navigation actions if requested
    if (useNavigation) {
      requestBody.actions = buildFirecrawlActions(navigationHints);
    }

    const response = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${firecrawlApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[VALIDATE-DATES] Firecrawl error: ${response.status} - ${errorText}`);
      
      if (response.status === 429) {
        return { success: false, status: 'blocked_rate_limit', strategyUsed: useNavigation ? 'url_then_navigate' : 'url_only', error: 'Rate limit' };
      }
      
      return { success: false, status: 'render_failed', strategyUsed: useNavigation ? 'url_then_navigate' : 'url_only', error: `Firecrawl error: ${response.status}` };
    }

    const data = await response.json();
    const markdown = data.data?.markdown || data.markdown || '';
    const extractedJson = data.data?.json || data.json;
    const finalUrl = data.data?.metadata?.sourceURL || url;
    const contentHash = simpleHash(markdown.slice(0, 5000));

    // Check for bot detection
    const lowerMarkdown = markdown.toLowerCase();
    if (
      lowerMarkdown.includes('captcha') ||
      lowerMarkdown.includes('robot') ||
      lowerMarkdown.includes('verify you are human') ||
      lowerMarkdown.includes('access denied') ||
      lowerMarkdown.includes('blocked')
    ) {
      console.log('[VALIDATE-DATES] Bot/CAPTCHA detected');
      return {
        success: false,
        status: 'blocked_captcha_or_bot',
        strategyUsed: useNavigation ? 'url_then_navigate' : 'url_only',
        error: 'Bot/CAPTCHA detected',
        contentHash,
        finalUrl,
      };
    }

    // Check availability status
    if (extractedJson?.availability_status === 'unavailable') {
      console.log('[VALIDATE-DATES] Property unavailable for dates');
      return {
        success: false,
        status: 'no_availability_for_dates',
        strategyUsed: useNavigation ? 'url_then_navigate' : 'url_only',
        detectedCheckIn: extractedJson.checkin_date_detected,
        detectedCheckOut: extractedJson.checkout_date_detected,
        finalUrl,
        contentHash,
      };
    }

    // Validate dates match
    if (extractedJson?.dates_visible && extractedJson.checkin_date_detected && extractedJson.checkout_date_detected) {
      const checkInMatches = datesMatch(extractedJson.checkin_date_detected, requestedCheckIn);
      const checkOutMatches = datesMatch(extractedJson.checkout_date_detected, requestedCheckOut);
      
      if (checkInMatches && checkOutMatches) {
        console.log(`[VALIDATE-DATES] Dates validated: ${extractedJson.checkin_date_detected} - ${extractedJson.checkout_date_detected}`);
        return {
          success: true,
          status: 'dates_validated',
          strategyUsed: useNavigation ? 'url_then_navigate' : 'url_only',
          detectedCheckIn: extractedJson.checkin_date_detected,
          detectedCheckOut: extractedJson.checkout_date_detected,
          finalUrl,
          contentHash,
          navigationStepsUsed: useNavigation ? navigationHints : undefined,
        };
      } else {
        console.log(`[VALIDATE-DATES] Date mismatch: expected ${requestedCheckIn}-${requestedCheckOut}, got ${extractedJson.checkin_date_detected}-${extractedJson.checkout_date_detected}`);
        return {
          success: false,
          status: 'dates_not_applied',
          strategyUsed: useNavigation ? 'url_then_navigate' : 'url_only',
          detectedCheckIn: extractedJson.checkin_date_detected,
          detectedCheckOut: extractedJson.checkout_date_detected,
          requiresNavigation: !useNavigation,
          finalUrl,
          contentHash,
        };
      }
    }

    // Dates not visible - might need navigation
    console.log('[VALIDATE-DATES] Dates not clearly visible on page');
    return {
      success: false,
      status: 'dates_not_applied',
      strategyUsed: useNavigation ? 'url_then_navigate' : 'url_only',
      requiresNavigation: !useNavigation,
      finalUrl,
      contentHash,
      error: 'Dates not visible on page',
    };

  } catch (error) {
    console.error('[VALIDATE-DATES] Error:', error);
    return {
      success: false,
      status: 'failed_unknown',
      strategyUsed: useNavigation ? 'url_then_navigate' : 'url_only',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// Validate dates using Zyte with browser actions
async function validateWithZyte(
  url: string,
  platformName: string,
  requestedCheckIn: string,
  requestedCheckOut: string,
  navigationHints: string[]
): Promise<ValidationResult> {
  const zyteApiKey = Deno.env.get('ZYTE_API_KEY');
  
  if (!zyteApiKey) {
    console.log('[VALIDATE-DATES] Zyte API key not configured');
    return {
      success: false,
      status: 'failed_unknown',
      strategyUsed: 'navigate_only',
      error: 'Zyte API key not configured',
    };
  }

  try {
    console.log(`[VALIDATE-DATES] Zyte validation for ${url}`);
    
    // Simple Zyte request - just render the page and extract HTML
    // Zyte's actions API has strict selector requirements, so we skip complex navigation
    // and rely on the rendered HTML + AI analysis
    const response = await fetch('https://api.zyte.com/v1/extract', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${btoa(zyteApiKey + ':')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url,
        browserHtml: true,
        javascript: true,
        // Wait for page load - Zyte timeout is in seconds, max 15
        actions: [
          { action: 'waitForTimeout', timeout: 5 }
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[VALIDATE-DATES] Zyte error: ${response.status} - ${errorText}`);
      
      if (response.status === 429) {
        return { success: false, status: 'blocked_rate_limit', strategyUsed: 'navigate_only', error: 'Rate limit' };
      }
      
      return { success: false, status: 'render_failed', strategyUsed: 'navigate_only', error: `Zyte error: ${response.status}` };
    }

    const data = await response.json();
    const html = data.browserHtml || '';
    const contentHash = simpleHash(html.slice(0, 5000));

    // Check for bot detection
    const lowerHtml = html.toLowerCase();
    if (
      lowerHtml.includes('captcha') ||
      lowerHtml.includes('robot') ||
      lowerHtml.includes('verify you are human') ||
      lowerHtml.includes('access denied')
    ) {
      return { success: false, status: 'blocked_captcha_or_bot', strategyUsed: 'navigate_only', error: 'Bot detected', contentHash };
    }

    // Use AI to analyze the HTML for dates
    const lovableApiKey = Deno.env.get('LOVABLE_API_KEY');
    if (!lovableApiKey) {
      return { success: false, status: 'failed_unknown', strategyUsed: 'navigate_only', error: 'No AI API for analysis' };
    }

    const aiResponse = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${lovableApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [{
          role: 'user',
          content: `Analyze this ${platformName} HTML and extract booking dates.
Requested: Check-in ${requestedCheckIn}, Check-out ${requestedCheckOut}

HTML (first 10000 chars):
${html.slice(0, 10000)}

Return JSON: {"checkin_detected": "YYYY-MM-DD or null", "checkout_detected": "YYYY-MM-DD or null", "available": true/false/null}`,
        }],
        max_tokens: 200,
      }),
    });

    if (!aiResponse.ok) {
      return { success: false, status: 'failed_unknown', strategyUsed: 'navigate_only', error: 'AI analysis failed', contentHash };
    }

    const aiData = await aiResponse.json();
    const resultText = aiData.choices?.[0]?.message?.content?.trim();
    
    if (resultText) {
      const jsonMatch = resultText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        
        if (parsed.available === false) {
          return {
            success: false,
            status: 'no_availability_for_dates',
            strategyUsed: 'navigate_only',
            detectedCheckIn: parsed.checkin_detected,
            detectedCheckOut: parsed.checkout_detected,
            contentHash,
          };
        }
        
        if (parsed.checkin_detected && parsed.checkout_detected) {
          const checkInMatches = datesMatch(parsed.checkin_detected, requestedCheckIn);
          const checkOutMatches = datesMatch(parsed.checkout_detected, requestedCheckOut);
          
          if (checkInMatches && checkOutMatches) {
            return {
              success: true,
              status: 'dates_validated',
              strategyUsed: 'navigate_only',
              detectedCheckIn: parsed.checkin_detected,
              detectedCheckOut: parsed.checkout_detected,
              contentHash,
              navigationStepsUsed: navigationHints,
            };
          }
        }
      }
    }

    return {
      success: false,
      status: 'dates_not_applied',
      strategyUsed: 'navigate_only',
      contentHash,
      error: 'Could not validate dates via Zyte',
    };

  } catch (error) {
    console.error('[VALIDATE-DATES] Zyte error:', error);
    return {
      success: false,
      status: 'failed_unknown',
      strategyUsed: 'navigate_only',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// Main validation orchestrator
async function validateDates(
  url: string,
  platformName: string,
  requestedCheckIn: string,
  requestedCheckOut: string,
  preferredStrategy: DateApplicationStrategy,
  navigationHints: string[]
): Promise<ValidationResult> {
  console.log(`[VALIDATE-DATES] Starting validation: ${platformName}, strategy: ${preferredStrategy}`);
  
  // Step 1: URL-only attempt (fast, cheap)
  if (preferredStrategy === 'url_only' || preferredStrategy === 'url_then_navigate') {
    console.log('[VALIDATE-DATES] Attempting URL-only validation');
    const urlResult = await validateWithFirecrawl(
      url, platformName, requestedCheckIn, requestedCheckOut, false, navigationHints
    );
    
    if (urlResult.success) {
      return urlResult;
    }
    
    // If blocked or rate limited, don't retry with navigation
    if (urlResult.status === 'blocked_captcha_or_bot' || urlResult.status === 'blocked_rate_limit') {
      return urlResult;
    }
    
    // If URL-only failed and strategy allows navigation, proceed
    if (preferredStrategy === 'url_only') {
      return urlResult;
    }
  }
  
  // Step 2: Navigation-based attempt with Firecrawl
  console.log('[VALIDATE-DATES] Attempting navigation-based validation with Firecrawl');
  const navResult = await validateWithFirecrawl(
    url, platformName, requestedCheckIn, requestedCheckOut, true, navigationHints
  );
  
  if (navResult.success) {
    return navResult;
  }
  
  // If blocked, don't try Zyte
  if (navResult.status === 'blocked_captcha_or_bot' || navResult.status === 'blocked_rate_limit') {
    return navResult;
  }
  
  // Step 3: Zyte fallback with browser actions
  console.log('[VALIDATE-DATES] Attempting Zyte fallback');
  const zyteResult = await validateWithZyte(
    url, platformName, requestedCheckIn, requestedCheckOut, navigationHints
  );
  
  if (zyteResult.success) {
    return zyteResult;
  }
  
  // Return the best error we have
  return navResult.status !== 'dates_not_applied' ? navResult : zyteResult;
}

// Main handler
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const { extractionId, deepLink, platformName, requestedCheckIn, requestedCheckOut, strategy } = 
      await req.json() as ValidationRequest;

    console.log(`[VALIDATE-DATES] Request: ${platformName} - ${extractionId}`);

    // Fetch platform adapter for strategy and hints
    const { data: adapter } = await supabaseClient
      .from('platform_adapters')
      .select('date_application_strategy, navigation_hints, learned_navigation_steps')
      .eq('platform_name', platformName)
      .single();

    const preferredStrategy = (strategy || adapter?.date_application_strategy || 'url_then_navigate') as DateApplicationStrategy;
    
    // Get navigation hints from adapter or defaults
    const platformKey = platformName.toLowerCase().replace(/\s+/g, '');
    const learnedSteps = adapter?.learned_navigation_steps as string[] | null;
    const adapterHints = adapter?.navigation_hints as string[] | null;
    const navigationHints = (learnedSteps && learnedSteps.length > 0)
      ? learnedSteps
      : adapterHints
        || PLATFORM_NAVIGATION_HINTS[platformKey]
        || ['Check availability', 'See prices', 'Select dates'];

    // Create pipeline job for tracking
    const { data: job } = await supabaseClient
      .from('pipeline_jobs')
      .insert({
        job_type: 'validate_dates',
        extraction_id: extractionId,
        status: 'running',
        started_at: new Date().toISOString(),
        metadata: {
          deep_link: deepLink,
          platform_name: platformName,
          requested_checkin: requestedCheckIn,
          requested_checkout: requestedCheckOut,
          strategy: preferredStrategy,
        },
      })
      .select()
      .single();

    const jobId = job?.id;

    // Run validation
    const result = await validateDates(
      deepLink,
      platformName,
      requestedCheckIn,
      requestedCheckOut,
      preferredStrategy,
      navigationHints
    );

    // Update price_extractions with validation result
    await supabaseClient
      .from('price_extractions')
      .update({
        dates_validated: result.success,
        detected_checkin: result.detectedCheckIn,
        detected_checkout: result.detectedCheckOut,
        final_resolved_url: result.finalUrl,
        page_content_hash: result.contentHash,
        date_validation_attempts: 1,
        extraction_status: result.success ? 'pending' : result.status,
        extraction_error: result.error,
        extraction_metadata: {
          validation_result: result.status,
          strategy_used: result.strategyUsed,
          navigation_steps: result.navigationStepsUsed,
          validated_at: new Date().toISOString(),
        },
      })
      .eq('id', extractionId);

    // Update pipeline job
    if (jobId) {
      await supabaseClient
        .from('pipeline_jobs')
        .update({
          status: result.success ? 'completed' : 'failed',
          completed_at: new Date().toISOString(),
          error_message: result.error,
          error_category: result.status,
          metadata: {
            deep_link: deepLink,
            platform_name: platformName,
            requested_checkin: requestedCheckIn,
            requested_checkout: requestedCheckOut,
            strategy: result.strategyUsed,
            detected_checkin: result.detectedCheckIn,
            detected_checkout: result.detectedCheckOut,
          },
        })
        .eq('id', jobId);
    }

    // Learn successful strategy for future use
    if (result.success && result.strategyUsed !== preferredStrategy) {
      console.log(`[VALIDATE-DATES] Learning new strategy for ${platformName}: ${result.strategyUsed}`);
      await supabaseClient
        .from('platform_adapters')
        .update({
          last_successful_strategy: result.strategyUsed,
          learned_navigation_steps: result.navigationStepsUsed || [],
          strategy_updated_at: new Date().toISOString(),
        })
        .eq('platform_name', platformName);
    }

    console.log(`[VALIDATE-DATES] Complete: ${platformName} - ${result.status}`);

    return new Response(
      JSON.stringify({
        success: result.success,
        status: result.status,
        detectedCheckIn: result.detectedCheckIn,
        detectedCheckOut: result.detectedCheckOut,
        strategyUsed: result.strategyUsed,
        finalUrl: result.finalUrl,
        error: result.error,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[VALIDATE-DATES] Error:', error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
