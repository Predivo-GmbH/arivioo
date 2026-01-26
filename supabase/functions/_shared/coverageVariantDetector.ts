/**
 * COVERAGE VARIANT DETECTOR
 * 
 * Detects and registers platform coverage variants based on region/country/extraction flow.
 * A variant represents a DISTINCT extraction logic requirement for the same platform domain.
 * 
 * Used to recognize when the SAME platform domain uses DIFFERENT extraction logic
 * depending on region/country (e.g., VRBO US vs VRBO Canada).
 */

// Failure classification for variant detection
export type FailureType = 'transient' | 'structural';

export interface ExtractionFlowSignature {
  // URL structure indicators
  checkout_url_pattern?: string;      // e.g., "/checkout", "/book", "/reserve"
  locale_path_segment?: string;       // e.g., "/en-ca/", "/de/"
  tld?: string;                       // e.g., ".com", ".ca", ".co.uk"
  
  // Navigation flow indicators
  requires_drawer_click?: boolean;
  requires_calendar_interaction?: boolean;
  has_price_breakdown?: boolean;
  has_total_before_checkout?: boolean;
  
  // DOM structure indicators
  price_container_class?: string;
  currency_symbol?: string;
  date_format_detected?: string;
  
  // Booking flow type
  booking_flow_type?: 'instant' | 'request' | 'inquiry' | 'unknown';
}

export interface VariantDetectionResult {
  platform_domain: string;
  detected_country: string | null;
  detected_locale: string | null;
  detected_tld: string | null;
  extraction_flow_signature: ExtractionFlowSignature;
  coverage_variant_key: string;
}

export interface VariantRegistrationResult {
  variant_key: string;
  is_new: boolean;
  variant_id: string | null;
  error?: string;
}

/**
 * Extract country/locale signals from a URL
 */
export function detectCountrySignals(url: string): {
  country: string | null;
  locale: string | null;
  tld: string | null;
} {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();
    const pathname = urlObj.pathname.toLowerCase();
    
    // Extract TLD
    const tldMatch = hostname.match(/\.([a-z]{2,3})$/);
    const tld = tldMatch ? tldMatch[1] : null;
    
    // Map TLDs to countries
    const tldToCountry: Record<string, string> = {
      'ca': 'CA',
      'uk': 'GB',
      'de': 'DE',
      'fr': 'FR',
      'es': 'ES',
      'it': 'IT',
      'nl': 'NL',
      'au': 'AU',
      'nz': 'NZ',
      'za': 'ZA',
      'jp': 'JP',
      'kr': 'KR',
      'mx': 'MX',
      'br': 'BR',
      'ar': 'AR',
      'in': 'IN',
      'sg': 'SG',
      'hk': 'HK',
    };
    
    let country: string | null = null;
    let locale: string | null = null;
    
    // Check TLD for country
    if (tld && tldToCountry[tld]) {
      country = tldToCountry[tld];
    }
    
    // Check pathname for locale segments (e.g., /en-ca/, /de/, /fr-fr/)
    const localePatterns = [
      /^\/(en|fr|de|es|it|pt|nl|ja|ko|zh)[-_]([a-z]{2})\//i,  // e.g., /en-ca/, /fr-fr/
      /^\/([a-z]{2})[-_]([a-z]{2})\//i,                        // e.g., /pt-br/
      /^\/([a-z]{2})\//i,                                       // e.g., /de/, /fr/
    ];
    
    for (const pattern of localePatterns) {
      const match = pathname.match(pattern);
      if (match) {
        if (match[2]) {
          // Full locale like en-ca
          locale = `${match[1].toLowerCase()}-${match[2].toUpperCase()}`;
          country = country || match[2].toUpperCase();
        } else if (match[1]) {
          // Just language code
          locale = match[1].toLowerCase();
        }
        break;
      }
    }
    
    // Check query params for locale/country hints
    const currencyParam = urlObj.searchParams.get('currency');
    const localeParam = urlObj.searchParams.get('locale');
    
    if (currencyParam) {
      const currencyToCountry: Record<string, string> = {
        'CAD': 'CA',
        'GBP': 'GB',
        'EUR': 'EU',
        'AUD': 'AU',
        'NZD': 'NZ',
        'ZAR': 'ZA',
        'JPY': 'JP',
        'KRW': 'KR',
        'MXN': 'MX',
        'BRL': 'BR',
        'INR': 'IN',
        'SGD': 'SG',
        'HKD': 'HK',
      };
      if (!country && currencyToCountry[currencyParam.toUpperCase()]) {
        country = currencyToCountry[currencyParam.toUpperCase()];
      }
    }
    
    if (localeParam && !locale) {
      locale = localeParam;
      // Extract country from locale if not set
      const localeParts = localeParam.split(/[-_]/);
      if (localeParts.length > 1 && !country) {
        country = localeParts[1].toUpperCase();
      }
    }
    
    // Default to US for .com without other signals
    if (!country && tld === 'com') {
      country = 'US';
    }
    
    return { country, locale, tld };
  } catch (err) {
    console.error('[VariantDetector] Error parsing URL:', err);
    return { country: null, locale: null, tld: null };
  }
}

/**
 * Extract platform domain from URL
 */
export function extractPlatformDomain(url: string): string {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();
    
    // Remove www. prefix
    const domain = hostname.replace(/^www\./, '');
    
    // For known platforms, normalize to base domain
    const platformPatterns: Array<{ pattern: RegExp; domain: string }> = [
      { pattern: /vrbo\.(com|ca|co\.uk|de|fr|es|it|nl|com\.au|co\.nz)$/i, domain: 'vrbo.com' },
      { pattern: /expedia\.(com|ca|co\.uk|de|fr|es|it|nl|com\.au|co\.nz|co\.jp)$/i, domain: 'expedia.com' },
      { pattern: /booking\.com$/i, domain: 'booking.com' },
      { pattern: /hotels\.com$/i, domain: 'hotels.com' },
      { pattern: /agoda\.com$/i, domain: 'agoda.com' },
      { pattern: /airpaz\.com$/i, domain: 'airpaz.com' },
    ];
    
    for (const { pattern, domain: baseDomain } of platformPatterns) {
      if (pattern.test(domain)) {
        return baseDomain;
      }
    }
    
    // Return the full domain for unknown platforms
    return domain;
  } catch (err) {
    console.error('[VariantDetector] Error extracting domain:', err);
    return 'unknown';
  }
}

/**
 * Generate a deterministic coverage variant key
 * 
 * IMPORTANT: Variant key should be stable for the same platform+country+locale combination.
 * We only add a flow signature hash when the booking flow type differs significantly
 * (e.g., "instant" vs "request" which require different extraction logic).
 */
export function generateVariantKey(
  platformDomain: string,
  country: string | null,
  flowSignature: ExtractionFlowSignature
): string {
  // Base key: domain:country (or domain:country:locale if locale differs)
  const parts = [
    platformDomain,
    country || 'unknown',
  ];
  
  // Only add locale if it differs from default (e.g., en-GB instead of just GB)
  if (flowSignature.locale_path_segment) {
    const normalizedLocale = flowSignature.locale_path_segment.toLowerCase().replace('_', '-');
    // Only add if it's a full locale like "en-gb" not just a country code
    if (normalizedLocale.includes('-')) {
      parts.push(normalizedLocale);
    }
  }
  
  // Only add booking flow type hash if it's a fundamentally different flow
  // (e.g., "request" or "inquiry" which require different extraction strategies)
  if (flowSignature.booking_flow_type && 
      flowSignature.booking_flow_type !== 'unknown' && 
      flowSignature.booking_flow_type !== 'instant') {
    parts.push(flowSignature.booking_flow_type);
  }
  
  return parts.join(':');
}

/**
 * Create a stable hash of the flow signature
 */
function hashFlowSignature(signature: ExtractionFlowSignature): string {
  // Create a deterministic string from key properties
  const keyParts = [
    signature.checkout_url_pattern || '',
    signature.locale_path_segment || '',
    signature.tld || '',
    signature.requires_drawer_click ? 'drawer' : '',
    signature.has_price_breakdown ? 'breakdown' : '',
    signature.has_total_before_checkout ? 'pretotal' : '',
    signature.booking_flow_type || '',
  ].filter(Boolean);
  
  // Simple hash for now - in production could use crypto.subtle
  const str = keyParts.join('|');
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36).slice(0, 8);
}

/**
 * Build extraction flow signature from extraction context
 */
export function buildFlowSignature(context: {
  finalUrl?: string;
  hasDrawerInteraction?: boolean;
  hasBreakdown?: boolean;
  hasTotalBeforeCheckout?: boolean;
  checkoutUrlPattern?: string;
  detectedCurrency?: string;
  bookingFlowType?: string;
  domIndicators?: Record<string, boolean>;
}): ExtractionFlowSignature {
  const signature: ExtractionFlowSignature = {};
  
  if (context.finalUrl) {
    try {
      const urlObj = new URL(context.finalUrl);
      signature.tld = urlObj.hostname.split('.').pop() || undefined;
      
      // Detect locale path segment
      const localeMatch = urlObj.pathname.match(/^\/([a-z]{2}(?:[-_][a-z]{2})?)\//i);
      if (localeMatch) {
        signature.locale_path_segment = localeMatch[1];
      }
      
      // Detect checkout URL pattern
      if (urlObj.pathname.includes('/checkout')) {
        signature.checkout_url_pattern = 'checkout';
      } else if (urlObj.pathname.includes('/book')) {
        signature.checkout_url_pattern = 'book';
      } else if (urlObj.pathname.includes('/reserve')) {
        signature.checkout_url_pattern = 'reserve';
      }
    } catch (e) {
      // Ignore URL parsing errors
    }
  }
  
  signature.requires_drawer_click = context.hasDrawerInteraction || false;
  signature.has_price_breakdown = context.hasBreakdown || false;
  signature.has_total_before_checkout = context.hasTotalBeforeCheckout || false;
  signature.currency_symbol = context.detectedCurrency || undefined;
  signature.booking_flow_type = (context.bookingFlowType as any) || 'unknown';
  
  return signature;
}

/**
 * Classify failure type for variant detection
 */
export function classifyFailureForVariant(
  status: string,
  error: string | null,
  httpStatus: number | null
): FailureType {
  const statusLower = (status || '').toLowerCase();
  const errorLower = (error || '').toLowerCase();
  
  // Transient failures - temporary issues that may resolve on retry
  const transientPatterns = [
    'timeout',
    'network',
    'connection',
    'rate_limit',
    'rate limited',
    '429',
    '500',
    '502',
    '503',
    '504',
    'temporarily unavailable',
    'try again',
    'service unavailable',
  ];
  
  for (const pattern of transientPatterns) {
    if (statusLower.includes(pattern) || errorLower.includes(pattern)) {
      return 'transient';
    }
  }
  
  // HTTP 5xx or 429 are transient
  if (httpStatus && (httpStatus >= 500 || httpStatus === 429)) {
    return 'transient';
  }
  
  // Everything else is structural - indicates different page/flow structure
  return 'structural';
}

/**
 * Detect variant from extraction attempt
 */
export function detectVariant(
  originalUrl: string,
  finalResolvedUrl: string | null,
  flowSignature: ExtractionFlowSignature
): VariantDetectionResult {
  const effectiveUrl = finalResolvedUrl || originalUrl;
  const platformDomain = extractPlatformDomain(effectiveUrl);
  const { country, locale, tld } = detectCountrySignals(effectiveUrl);
  
  // Merge TLD into flow signature if not set
  if (!flowSignature.tld && tld) {
    flowSignature.tld = tld;
  }
  
  const variantKey = generateVariantKey(platformDomain, country, flowSignature);
  
  return {
    platform_domain: platformDomain,
    detected_country: country,
    detected_locale: locale,
    detected_tld: tld,
    extraction_flow_signature: flowSignature,
    coverage_variant_key: variantKey,
  };
}

/**
 * Register a new coverage variant in the database
 */
export async function registerVariant(
  supabaseClient: any,
  detection: VariantDetectionResult,
  sampleUrl: string,
  failureType: FailureType
): Promise<VariantRegistrationResult> {
  const variantKey = detection.coverage_variant_key;
  
  try {
    // First check if variant already exists
    const { data: existing, error: fetchError } = await supabaseClient
      .from('platform_coverage_variants')
      .select('id, detection_count, sample_urls, total_attempts, structural_failures, transient_failures')
      .eq('coverage_variant_key', variantKey)
      .maybeSingle();
    
    if (fetchError) {
      console.error('[VariantDetector] Error fetching variant:', fetchError);
      return { variant_key: variantKey, is_new: false, variant_id: null, error: fetchError.message };
    }
    
    if (existing) {
      // Update existing variant
      const sampleUrls = existing.sample_urls || [];
      if (!sampleUrls.includes(sampleUrl) && sampleUrls.length < 5) {
        sampleUrls.push(sampleUrl);
      }
      
      const updates: Record<string, any> = {
        last_seen_at: new Date().toISOString(),
        detection_count: (existing.detection_count || 0) + 1,
        total_attempts: (existing.total_attempts || 0) + 1,
        sample_urls: sampleUrls,
      };
      
      if (failureType === 'structural') {
        updates.structural_failures = (existing.structural_failures || 0) + 1;
      } else {
        updates.transient_failures = (existing.transient_failures || 0) + 1;
      }
      
      await supabaseClient
        .from('platform_coverage_variants')
        .update(updates)
        .eq('id', existing.id);
      
      console.log(`[VariantDetector] Updated existing variant: ${variantKey}`);
      return { variant_key: variantKey, is_new: false, variant_id: existing.id };
    }
    
    // Find parent adapter
    const { data: parentAdapter } = await supabaseClient
      .from('platform_adapters')
      .select('id, coverage_tier')
      .ilike('platform_domain', `%${detection.platform_domain}%`)
      .limit(1)
      .maybeSingle();
    
    // Create new variant
    const newVariant = {
      parent_adapter_id: parentAdapter?.id || null,
      parent_platform_domain: detection.platform_domain,
      coverage_variant_key: variantKey,
      detected_country: detection.detected_country,
      detected_locale: detection.detected_locale,
      detected_tld: detection.detected_tld,
      extraction_flow_signature: detection.extraction_flow_signature,
      variant_status: 'needs_coverage',
      variant_reason: `Structural mismatch detected. Different regional booking/extraction logic.`,
      inherited_tier: parentAdapter?.coverage_tier || 'B',
      total_attempts: 1,
      structural_failures: failureType === 'structural' ? 1 : 0,
      transient_failures: failureType === 'transient' ? 1 : 0,
      sample_urls: [sampleUrl],
    };
    
    const { data: inserted, error: insertError } = await supabaseClient
      .from('platform_coverage_variants')
      .insert(newVariant)
      .select('id')
      .single();
    
    if (insertError) {
      // Handle race condition - variant may have been created by another request
      if (insertError.code === '23505') { // Unique violation
        console.log(`[VariantDetector] Variant already exists (race condition): ${variantKey}`);
        return { variant_key: variantKey, is_new: false, variant_id: null };
      }
      console.error('[VariantDetector] Error inserting variant:', insertError);
      return { variant_key: variantKey, is_new: false, variant_id: null, error: insertError.message };
    }
    
    console.log(`[VariantDetector] Registered NEW variant: ${variantKey} (${detection.detected_country || 'unknown country'})`);
    return { variant_key: variantKey, is_new: true, variant_id: inserted?.id || null };
    
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[VariantDetector] Error registering variant:', err);
    return { variant_key: variantKey, is_new: false, variant_id: null, error: errorMsg };
  }
}

/**
 * Check if a known variant exists and is covered
 */
export async function checkVariantCoverage(
  supabaseClient: any,
  variantKey: string
): Promise<{ exists: boolean; status: string | null; isCovered: boolean }> {
  try {
    const { data: variant, error } = await supabaseClient
      .from('platform_coverage_variants')
      .select('variant_status')
      .eq('coverage_variant_key', variantKey)
      .maybeSingle();
    
    if (error || !variant) {
      return { exists: false, status: null, isCovered: false };
    }
    
    return {
      exists: true,
      status: variant.variant_status,
      isCovered: variant.variant_status === 'covered',
    };
  } catch (err) {
    console.error('[VariantDetector] Error checking variant coverage:', err);
    return { exists: false, status: null, isCovered: false };
  }
}
