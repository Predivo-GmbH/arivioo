import { useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { Json } from '@/integrations/supabase/types';
import { 
  verifyPrice, 
  classifyScrapedPrice, 
  type PriceStatus, 
  type PriceSource,
  type PriceVerificationResult 
} from '@/lib/priceVerification';

export interface EnrichedSearchResult {
  id: string;
  platform_name: string;
  listing_url: string;
  listing_title: string | null;
  price: number | null;
  original_price: number | null;
  savings_amount: number | null;
  savings_percentage: number | null;
  confidence_score: number | null;
  image_url: string | null;
  images: Json;
  match_type?: string;
  source_airbnb_image?: string | null;
  price_check_in?: string | null;
  price_check_out?: string | null;
  dates_differ?: boolean;
  // Tier and extraction info
  coverage_tier: 'A' | 'B' | 'C' | null;
  coverage_status: string | null;
  extraction_status: string | null;
  extraction_error: string | null;
  failure_category: string | null;
  failure_reason: string | null;
  is_tier_c_blocked: boolean;
  // NEW: Price verification metadata
  price_status: PriceStatus;
  price_source: PriceSource;
  price_verified_at: string | null;
  eligible_for_comparison: boolean;
  verification_failures: string[];
}

// Maps extraction errors to human-readable failure categories
function classifyFailure(extractionStatus: string | null, extractionError: string | null, coverageTier: string | null): { category: string | null; reason: string | null } {
  if (!extractionStatus || extractionStatus === 'success' || extractionStatus === 'pending') {
    return { category: null, reason: null };
  }

  const error = extractionError || '';
  const status = extractionStatus;

  // ========== EXPEDIA-SPECIFIC TERMINAL STATUSES (v6.3 target card anchoring) ==========
  // These must be checked first as they are the canonical Expedia statuses
  
  // Target property card not found on offers page
  if (status === 'expedia_target_offer_not_found') {
    return { category: 'price_not_visible', reason: 'Property not found on Expedia' };
  }
  
  // Target property card title doesn't match (wrong property)
  if (status === 'expedia_target_offer_mismatch') {
    return { category: 'price_not_visible', reason: 'Property mismatch on Expedia' };
  }
  
  // Target property card shows unavailability (e.g., "Minimum stay not met")
  if (status === 'expedia_dates_unavailable_for_target' || status === 'dates_unavailable') {
    return { category: 'sold_out', reason: 'Not available for these dates on Expedia' };
  }
  
  // Target card found but couldn't extract total price
  if (status === 'expedia_target_total_not_found') {
    return { category: 'price_not_visible', reason: 'Total price not visible on Expedia' };
  }
  
  // Offers page not reached
  if (status === 'expedia_offers_page_not_reached' || status === 'expedia_total_not_found_on_offers_page') {
    return { category: 'render_failed', reason: 'Expedia offers page not loaded' };
  }
  
  // Expedia blocked access (CAPTCHA/bot detection)
  if (status === 'expedia_access_blocked') {
    return { category: 'blocked', reason: 'Blocked by Expedia' };
  }
  
  // Property ID not found in URL
  if (status === 'property_id_not_found') {
    return { category: 'price_not_visible', reason: 'Property not found on Expedia' };
  }

  // ========== GENERIC PROVIDER ERRORS ==========
  
  // Provider errors
  if (error.includes('Zyte error: 400') || error.includes('Zyte 400')) {
    return { category: 'provider_error', reason: 'Provider rejected request' };
  }
  if (error.includes('Zyte timeout') || error.includes('Zyte error: 5')) {
    return { category: 'provider_error', reason: 'Provider timeout' };
  }
  if (error.includes('Firecrawl error: 403') || error.includes('403')) {
    return { category: 'blocked', reason: 'Blocked by platform' };
  }
  if (error.includes('Firecrawl error: 5') || error.includes('Firecrawl timeout')) {
    return { category: 'provider_error', reason: 'Service timeout' };
  }

  // Bot/CAPTCHA
  if (status === 'blocked_captcha_or_bot' || status === 'blocked_captcha' || error.toLowerCase().includes('captcha') || error.toLowerCase().includes('bot')) {
    return { category: 'blocked', reason: 'Blocked by CAPTCHA' };
  }

  // Rate limiting / access abort
  if (status === 'blocked_rate_limit' || status === 'rate_limited_abort') {
    return { category: 'rate_limited', reason: 'Rate limited by platform' };
  }

  // Bot block abort (hard stop)
  if (status === 'bot_blocked_abort') {
    return { category: 'blocked', reason: 'Blocked by platform (stopped)' };
  }

  // Dates not applied
  if (status === 'dates_not_applied') {
    return { category: 'dates_not_applied', reason: 'Could not apply dates' };
  }

  // Sold out / unavailable
  if (status === 'sold_out' || status === 'no_availability_for_dates') {
    return { category: 'sold_out', reason: 'Not available for these dates' };
  }

  // Tier C / unsupported
  if (status === 'platform_unsupported' || coverageTier === 'C') {
    return { category: 'unsupported', reason: 'Platform not supported' };
  }

  // Render failed
  if (status === 'render_failed') {
    return { category: 'render_failed', reason: 'Page failed to load' };
  }

  // Price not found
  if (status === 'price_not_found' || status === 'price_not_found_after_dates_applied') {
    return { category: 'price_not_visible', reason: 'Price not visible on page' };
  }

  // Default
  return { category: 'unknown', reason: error || 'Unknown error' };
}

export function useEnrichedSearchResults() {
  const fetchEnrichedResults = useCallback(async (searchId: string): Promise<EnrichedSearchResult[]> => {
    // Fetch search_results
    const { data: resultsData, error: resultsError } = await supabase
      .from('search_results')
      .select('*')
      .eq('search_id', searchId)
      .order('savings_percentage', { ascending: false, nullsFirst: false });

    if (resultsError || !resultsData) {
      console.error('Failed to fetch search results:', resultsError);
      return [];
    }

    // Fetch price_extractions for this search - include verification fields
    const { data: extractionsData } = await supabase
      .from('price_extractions')
      .select('id, search_result_id, platform_name, extraction_status, extraction_error, extracted_price, extraction_metadata, includes_taxes_fees, dates_validated, confidence_score, updated_at, evidence_snippets, extraction_stage, price_type')
      .eq('search_id', searchId);

    // Fetch platform_adapters for tier info
    const { data: adaptersData } = await supabase
      .from('platform_adapters')
      .select('platform_domain, coverage_tier, coverage_status');

    // Create lookup maps
    const extractionByResultId = new Map<string, any>();
    const extractionByPlatform = new Map<string, any>();
    extractionsData?.forEach(e => {
      if (e.search_result_id) {
        extractionByResultId.set(e.search_result_id, e);
      }
      extractionByPlatform.set(e.platform_name.toLowerCase(), e);
    });

    const adapterByDomain = new Map<string, any>();
    adaptersData?.forEach(a => {
      adapterByDomain.set(a.platform_domain.toLowerCase(), a);
    });

    // Enrich results
    const enrichedResults: EnrichedSearchResult[] = resultsData.map(result => {
      // Find extraction by result ID first, then by platform name
      let extraction = extractionByResultId.get(result.id);
      if (!extraction) {
        extraction = extractionByPlatform.get(result.platform_name.toLowerCase());
      }

      // Find adapter by matching platform name to domain
      const platformLower = result.platform_name.toLowerCase().replace(/\s+/g, '');
      let adapter: any = null;
      for (const [domain, a] of adapterByDomain.entries()) {
        const domainBase = domain.replace('.com', '').replace('.', '');
        if (platformLower.includes(domainBase) || domainBase.includes(platformLower)) {
          adapter = a;
          break;
        }
      }

      const coverageTier = adapter?.coverage_tier || null;
      const coverageStatus = adapter?.coverage_status || null;
      const isTierCBlocked = coverageTier === 'C' || coverageStatus === 'blocked';

      // Get extraction info
      const extractionStatus = extraction?.extraction_status || null;
      const extractionError = extraction?.extraction_error || null;

      // Classify failure
      const { category, reason } = classifyFailure(extractionStatus, extractionError, coverageTier);

      // FRONTEND GUARD: Additional defense-in-depth
      // Even if a price somehow exists in data for Tier C, forcefully null it
      let effectivePrice = result.price;
      if (isTierCBlocked) {
        if (result.price !== null) {
          console.warn(`FRONTEND GUARD: Nulling leaked price for Tier C platform ${result.platform_name}`);
        }
        effectivePrice = null; // Never show price for Tier C
      } else if (extraction?.extracted_price && extraction.extracted_price > 0) {
        effectivePrice = extraction.extracted_price;
      }

      // === PRICE VERIFICATION ===
      // Apply central verification logic to determine if price is trustworthy
      let verification: PriceVerificationResult;
      
      if (isTierCBlocked) {
        // Tier C platforms are always unavailable
        verification = {
          price_status: 'unavailable',
          price_source: 'none',
          price_verified_at: null,
          eligible_for_comparison: false,
          verification_failures: ['platform_blocked'],
          structural_total_verified: false,
          semantic_total_verified: false,
          structural_proof: {
            breakdown_found: null,
            total_label_found: null,
            rendered_dates_match: null,
            extracted_from_breakdown_total: null,
          },
        };
      } else if (extraction) {
        // We have an extraction record - use verification logic with structural checks
        const evidenceSnippets = Array.isArray(extraction.evidence_snippets) 
          ? extraction.evidence_snippets 
          : [];
        const metadata = extraction.extraction_metadata as Record<string, any> | null;
        
        // CRITICAL: Extract structural proof fields from nested locations
        // The extract-expedia function stores these in multiple places for backwards compat
        const structuralProof = metadata?.structuralProof || {};
        const offersPage = metadata?.offersPage || {};
        
        // Normalize structural proof fields to top level for verifyPrice
        const normalizedMetadata = metadata ? {
          ...metadata,
          // Extract from structuralProof or offersPage or top level
          breakdown_found: metadata.breakdown_found ?? structuralProof.breakdown_found ?? offersPage.hasOfferCards ?? null,
          total_label_found: metadata.total_label_found ?? structuralProof.total_label_found ?? offersPage.hasTotalWithTaxes ?? null,
          rendered_dates_match: metadata.rendered_dates_match ?? structuralProof.rendered_dates_match ?? offersPage.datesRenderedCorrectly ?? null,
          extracted_from_breakdown_total: metadata.extracted_from_breakdown_total ?? structuralProof.extracted_from_breakdown_total ?? null,
        } : null;
        
        verification = verifyPrice({
          extraction_status: extraction.extraction_status,
          dates_validated: extraction.dates_validated,
          includes_taxes_fees: extraction.includes_taxes_fees,
          confidence_score: extraction.confidence_score,
          extracted_price: extraction.extracted_price,
          extraction_completed_at: extraction.updated_at,
          // Verification params
          price_type: extraction.price_type || metadata?.price_type || null,
          extraction_stage: extraction.extraction_stage || metadata?.extraction_stage || null,
          extraction_path: metadata?.extraction_path || null,
          evidence_snippets: evidenceSnippets,
          extraction_metadata: normalizedMetadata,
        });
      } else if (result.price && result.price > 0) {
        // Price exists but no extraction record - scraped price
        verification = classifyScrapedPrice(result.price);
      } else {
        // No price at all
        verification = {
          price_status: 'unavailable',
          price_source: 'none',
          price_verified_at: null,
          eligible_for_comparison: false,
          verification_failures: ['no_price'],
          structural_total_verified: false,
          semantic_total_verified: false,
          structural_proof: {
            breakdown_found: null,
            total_label_found: null,
            rendered_dates_match: null,
            extracted_from_breakdown_total: null,
          },
        };
      }

      return {
        ...result,
        price: effectivePrice,
        coverage_tier: coverageTier as 'A' | 'B' | 'C' | null,
        coverage_status: coverageStatus,
        extraction_status: extractionStatus,
        extraction_error: extractionError,
        failure_category: isTierCBlocked ? 'unsupported' : category,
        failure_reason: isTierCBlocked ? 'Platform blocked (Tier C)' : reason,
        is_tier_c_blocked: isTierCBlocked,
        // Price verification metadata
        price_status: verification.price_status,
        price_source: verification.price_source,
        price_verified_at: verification.price_verified_at,
        eligible_for_comparison: verification.eligible_for_comparison,
        verification_failures: verification.verification_failures,
      };
    });

    return enrichedResults;
  }, []);

  return { fetchEnrichedResults };
}

// Human-readable labels for failure categories
export const FAILURE_CATEGORY_LABELS: Record<string, string> = {
  'provider_error': 'Service unavailable',
  'blocked': 'Platform blocked access',
  'rate_limited': 'Rate limited (stopped)',
  'dates_not_applied': 'Dates could not be applied',
  'sold_out': 'Not available for dates',
  'unsupported': 'Platform not supported',
  'render_failed': 'Page failed to load',
  'price_not_visible': 'Price not visible',
  'unknown': 'Check failed',
};
