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
import {
  normalizeExtraction,
  type CanonicalPrice,
  type PriceType,
  type ExtractionInput,
} from '@/lib/canonicalPrice';
import {
  classifyOutcome,
  getOutcomeUserLabel,
  FAILURE_CATEGORY_LABELS as TAXONOMY_FAILURE_LABELS,
  type OutcomeCategory,
} from '@/lib/extractionOutcomeTaxonomy';

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
  // NEW: Outcome taxonomy
  outcome_category: OutcomeCategory | null;
  outcome_label: string | null;
  // Price verification metadata (legacy)
  price_status: PriceStatus;
  price_source: PriceSource;
  price_verified_at: string | null;
  eligible_for_comparison: boolean;
  verification_failures: string[];
  // NEW: Canonical price model
  canonical_price: CanonicalPrice | null;
  price_type: PriceType;
  price_type_label: string;
  is_total_price: boolean;
}

// Maps extraction errors to human-readable failure categories using canonical taxonomy
function classifyFailure(
  extractionStatus: string | null, 
  extractionError: string | null, 
  coverageTier: string | null,
  metadata?: { unavailabilityMarker?: string; priceStatus?: 'verified' | 'unverified' | 'unavailable'; hasPrice?: boolean }
): { category: string | null; reason: string | null; outcomeCategory: OutcomeCategory | null } {
  if (!extractionStatus || extractionStatus === 'success' || extractionStatus === 'pending') {
    return { category: null, reason: null, outcomeCategory: null };
  }

  // Use canonical taxonomy for classification
  const outcome = classifyOutcome(extractionStatus, extractionError, {
    coverageTier,
    unavailabilityMarker: metadata?.unavailabilityMarker,
    priceStatus: metadata?.priceStatus,
    hasPrice: metadata?.hasPrice,
  });

  const outcomeLabel = getOutcomeUserLabel(outcome);
  
  // Map outcome category to legacy category for backwards compatibility
  const legacyCategoryMap: Record<OutcomeCategory, string> = {
    'price_verified': 'success',
    'price_unverified': 'unverified',
    'unavailable_for_dates': 'sold_out',
    'requires_action': 'dates_not_applied',
    'access_blocked': 'blocked',
    'price_not_found': 'price_not_visible',
    'service_error': 'provider_error',
    'platform_unsupported': 'unsupported',
  };

  return { 
    category: legacyCategoryMap[outcome.category] || 'unknown', 
    reason: outcomeLabel,
    outcomeCategory: outcome.category,
  };
}

export function useEnrichedSearchResults() {
  const fetchEnrichedResults = useCallback(async (searchId: string): Promise<EnrichedSearchResult[]> => {
    // Phase 1: fetch results + extractions in parallel (fast, scoped by search_id)
    const [resultsResponse, extractionsResponse] = await Promise.all([
      supabase
        .from('search_results')
        .select('*')
        .eq('search_id', searchId)
        .order('savings_percentage', { ascending: false, nullsFirst: false }),
      supabase
        .from('price_extractions')
        .select('id, search_result_id, platform_name, extraction_status, extraction_error, extracted_price, extraction_metadata, includes_taxes_fees, dates_validated, confidence_score, updated_at, evidence_snippets, extraction_stage, price_type')
        .eq('search_id', searchId),
    ]);

    const { data: resultsData, error: resultsError } = resultsResponse;
    const { data: extractionsData } = extractionsResponse;

    if (resultsError || !resultsData) {
      console.error('Failed to fetch search results:', resultsError);
      return [];
    }

    // Phase 2: fetch ONLY the adapter rows we might need.
    // The platform_adapters table can be large; fetching it all makes finalization slow.
    const platformNames = Array.from(new Set(resultsData.map(r => (r.platform_name || '').toLowerCase()))).filter(Boolean);

    // Heuristic: many adapters use a ".com" domain that matches the platform name.
    // We query a small candidate list instead of scanning the entire table.
    const domainCandidates = Array.from(
      new Set(
        platformNames
          .map(name => name.replace(/\s+/g, '').replace(/[^a-z0-9.]/g, ''))
          .flatMap(base => {
            // already contains a dot => likely a domain already
            if (base.includes('.')) return [base];
            return [`${base}.com`];
          })
      )
    );

    const { data: adaptersData } = domainCandidates.length
      ? await supabase
          .from('platform_adapters')
          .select('platform_domain, coverage_tier, coverage_status')
          .in('platform_domain', domainCandidates)
      : { data: [] as any[] };

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
      const extractionMetadata = extraction?.extraction_metadata as Record<string, any> | null;

      // Unavailability marker can live in multiple shapes depending on extractor/version
      const unavailabilityMarker =
        extractionMetadata?.unavailability_marker ??
        extractionMetadata?.unavailabilityMarker ??
        extractionMetadata?.structuralProof?.unavailability_marker ??
        extractionMetadata?.structural_proof?.unavailability_marker ??
        null;

      // Classify failure using canonical taxonomy
      const { category, reason, outcomeCategory } = classifyFailure(
        extractionStatus,
        extractionError,
        coverageTier,
        { unavailabilityMarker }
      );

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
        
        // Check if this is a Tier A golden path extraction with implicit structural proof
        // Expedia golden path extractions with success status + dates_matched imply structural verification
        const isExpediaGoldenPath = result.platform_name.toLowerCase().includes('expedia') && 
          extraction.extraction_status === 'success' &&
          extraction.dates_validated === true &&
          extraction.includes_taxes_fees === true &&
          metadata?.dates_matched === true;
        
        // Normalize structural proof fields to top level for verifyPrice
        // For Expedia golden path, infer structural proof from success + dates_matched
        const normalizedMetadata = metadata ? {
          ...metadata,
          // Extract from structuralProof or offersPage or top level, or infer from golden path
          breakdown_found: metadata.breakdown_found ?? structuralProof.breakdown_found ?? offersPage.hasOfferCards ?? (isExpediaGoldenPath ? true : null),
          total_label_found: metadata.total_label_found ?? structuralProof.total_label_found ?? offersPage.hasTotalWithTaxes ?? (isExpediaGoldenPath ? true : null),
          rendered_dates_match: metadata.rendered_dates_match ?? structuralProof.rendered_dates_match ?? offersPage.datesRenderedCorrectly ?? metadata.dates_matched ?? null,
          extracted_from_breakdown_total: metadata.extracted_from_breakdown_total ?? structuralProof.extracted_from_breakdown_total ?? (isExpediaGoldenPath ? true : null),
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

      // === CANONICAL PRICE MODEL ===
      // Normalize extraction to canonical price schema for consistent comparison
      let canonicalPrice: CanonicalPrice | null = null;
      let priceType: PriceType = 'unknown';
      let priceTypeLabel = 'Price';
      let isTotalPrice = false;

      if (extraction && !isTierCBlocked) {
        const extractionInput: ExtractionInput = {
          platform_name: result.platform_name,
          deep_link: extraction.deep_link || result.listing_url,
          extracted_price: extraction.extracted_price,
          currency: extraction.currency || null,
          includes_taxes_fees: extraction.includes_taxes_fees,
          dates_validated: extraction.dates_validated,
          detected_checkin: extraction.detected_checkin || result.price_check_in || null,
          detected_checkout: extraction.detected_checkout || result.price_check_out || null,
          confidence_score: extraction.confidence_score,
          extraction_status: extraction.extraction_status,
          extraction_metadata: extraction.extraction_metadata as Record<string, any> | null,
          evidence_snippets: Array.isArray(extraction.evidence_snippets) ? extraction.evidence_snippets : [],
          price_type: extraction.price_type || null,
          updated_at: extraction.updated_at || null,
        };

        canonicalPrice = normalizeExtraction(extractionInput);
        priceType = canonicalPrice.price_type;
        isTotalPrice = priceType === 'total_proven' || priceType === 'total_derived';
        
        // Set human-readable label
        switch (priceType) {
          case 'total_proven':
            priceTypeLabel = 'Total';
            break;
          case 'total_derived':
            priceTypeLabel = 'Total*';
            break;
          case 'subtotal_nights_only':
            priceTypeLabel = 'Subtotal';
            break;
          case 'nightly_only':
            priceTypeLabel = 'Per night';
            break;
          default:
            priceTypeLabel = 'Price';
        }
      } else if (result.price && result.price > 0 && !isTierCBlocked) {
        // Scraped price - treat as unknown type
        priceType = 'unknown';
        priceTypeLabel = 'Price';
        isTotalPrice = false;
      }

      return {
        ...result,
        price: effectivePrice,
        coverage_tier: coverageTier as 'A' | 'B' | 'C' | null,
        coverage_status: coverageStatus,
        extraction_status: extractionStatus,
        extraction_error: extractionError,
        failure_category: isTierCBlocked ? 'unsupported' : category,
        failure_reason: isTierCBlocked ? 'Platform not supported' : reason,
        is_tier_c_blocked: isTierCBlocked,
        // NEW: Outcome taxonomy
        outcome_category: isTierCBlocked ? 'platform_unsupported' as OutcomeCategory : outcomeCategory,
        outcome_label: isTierCBlocked ? 'Platform not supported' : reason,
        // Price verification metadata (legacy)
        price_status: verification.price_status,
        price_source: verification.price_source,
        price_verified_at: verification.price_verified_at,
        eligible_for_comparison: verification.eligible_for_comparison,
        verification_failures: verification.verification_failures,
        // NEW: Canonical price model
        canonical_price: canonicalPrice,
        price_type: priceType,
        price_type_label: priceTypeLabel,
        is_total_price: isTotalPrice,
      };
    });

    return enrichedResults;
  }, []);

  return { fetchEnrichedResults };
}

// Re-export FAILURE_CATEGORY_LABELS from taxonomy for backwards compatibility
export { TAXONOMY_FAILURE_LABELS as FAILURE_CATEGORY_LABELS };
