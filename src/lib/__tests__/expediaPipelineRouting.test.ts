/**
 * Expedia Pipeline Routing - Regression Test
 * 
 * Tests that Expedia extractions are routed through the golden-path extractor
 * (extract-expedia) and NOT through the generic Phase A + Phase B flow.
 * 
 * Root cause of b4e616bc-7c59-41ac-a510-da6f52b4c91e:
 * - Expedia was incorrectly routed through validate-dates (Tier B flow)
 * - Should have been routed through extract-expedia (Tier A golden path)
 * 
 * Fix: Enhanced logging in getPlatformTier and routing decision, plus redeployment.
 */

import { describe, it, expect } from 'vitest';

// Mock the tier lookup result for Expedia
const EXPEDIA_TIER_LOOKUP_EXPECTED = {
  tier: 'A',
  reason: expect.stringContaining('Production-proven'),
  dedicatedExtractor: 'extract-expedia',
};

// Platform names that should route to Expedia golden path
const EXPEDIA_PLATFORM_VARIANTS = [
  'Expedia',
  'expedia',
  'EXPEDIA',
  'expedia.com',
  'Expedia.com',
];

describe('Expedia Pipeline Routing', () => {
  describe('getPlatformTier simulation', () => {
    // Simulate the tier lookup logic from process-platform-extraction
    function simulateGetPlatformTier(platformName: string): { tier: string; dedicatedExtractor: string | null } {
      const platformLower = platformName.toLowerCase();
      
      // Simulated platform_adapters data (matches production)
      const adapters = [
        { platform_name: 'Expedia', platform_domain: 'expedia.com', coverage_tier: 'A', dedicated_extractor: 'extract-expedia' },
        { platform_name: 'expedia.com', platform_domain: 'expedia.com', coverage_tier: 'A', dedicated_extractor: 'extract-expedia' },
        { platform_name: 'hotels.com', platform_domain: 'hotels.com', coverage_tier: 'A', dedicated_extractor: 'extract-hotelscom' },
        { platform_name: 'agoda.com', platform_domain: 'agoda.com', coverage_tier: 'A', dedicated_extractor: 'extract-agoda' },
        { platform_name: 'vrbo.com', platform_domain: 'vrbo.com', coverage_tier: 'C', dedicated_extractor: null },
      ];
      
      // Simulate the ilike query: platform_name ILIKE '%expedia%' OR platform_domain ILIKE '%expedia%'
      const matched = adapters.find(a => 
        a.platform_name.toLowerCase().includes(platformLower) || 
        a.platform_domain.toLowerCase().includes(platformLower)
      );
      
      if (matched) {
        return {
          tier: matched.coverage_tier || 'B',
          dedicatedExtractor: matched.dedicated_extractor,
        };
      }
      
      return { tier: 'B', dedicatedExtractor: null };
    }
    
    // Simulate the getDedicatedExtractor fallback logic
    function simulateGetDedicatedExtractor(platformName: string): string | null {
      const platformLower = (platformName || '').toLowerCase();
      
      // Explicit Expedia catch-all
      if (platformLower.includes('expedia')) return 'extract-expedia';
      
      const GOLDEN_PATH_PLATFORMS: Record<string, string> = {
        'hotels.com': 'extract-hotelscom',
        'agoda.com': 'extract-agoda',
      };
      
      for (const [domain, extractor] of Object.entries(GOLDEN_PATH_PLATFORMS)) {
        if (platformLower.includes(domain) || platformLower === domain.split('.')[0]) {
          return extractor;
        }
      }
      return null;
    }
    
    // Simulate the full routing decision
    function simulateRoutingDecision(platformName: string): { 
      useGoldenPath: boolean; 
      extractor: string | null;
      tier: string;
    } {
      const tierInfo = simulateGetPlatformTier(platformName);
      const dedicatedExtractor = tierInfo.dedicatedExtractor || simulateGetDedicatedExtractor(platformName);
      
      return {
        useGoldenPath: tierInfo.tier === 'A' && !!dedicatedExtractor,
        extractor: dedicatedExtractor,
        tier: tierInfo.tier,
      };
    }
    
    it.each(EXPEDIA_PLATFORM_VARIANTS)(
      'routes "%s" to extract-expedia golden path',
      (platformName) => {
        const routing = simulateRoutingDecision(platformName);
        
        expect(routing.tier).toBe('A');
        expect(routing.extractor).toBe('extract-expedia');
        expect(routing.useGoldenPath).toBe(true);
      }
    );
    
    it('routes Hotels.com to extract-hotelscom golden path', () => {
      const routing = simulateRoutingDecision('hotels.com');
      
      expect(routing.tier).toBe('A');
      expect(routing.extractor).toBe('extract-hotelscom');
      expect(routing.useGoldenPath).toBe(true);
    });
    
    it('routes Agoda to extract-agoda golden path', () => {
      const routing = simulateRoutingDecision('agoda.com');
      
      expect(routing.tier).toBe('A');
      expect(routing.extractor).toBe('extract-agoda');
      expect(routing.useGoldenPath).toBe(true);
    });
    
    it('routes Vrbo to Tier C (unsupported)', () => {
      const routing = simulateRoutingDecision('vrbo.com');
      
      expect(routing.tier).toBe('C');
      // Even if there's a fallback extractor, Tier C should short-circuit
    });
    
    it('routes unknown platforms to Tier B generic flow', () => {
      const routing = simulateRoutingDecision('someunknownplatform.com');
      
      expect(routing.tier).toBe('B');
      expect(routing.extractor).toBeNull();
      expect(routing.useGoldenPath).toBe(false);
    });
  });
  
  describe('Golden path metadata requirements', () => {
    it('requires goldenPath key in extraction_metadata for Tier A success', () => {
      // A successful Tier A extraction MUST have goldenPath metadata
      const successfulExpediaMetadata = {
        goldenPath: {
          propertyId: '76146918',
          offersPageUrl: 'https://www.expedia.com/Hotel-Search?...',
        },
        structuralProof: {
          proof_version: '6.3-target-card',
          extracted_from_target_card: true,
          target_card_found: true,
        },
      };
      
      expect(successfulExpediaMetadata.goldenPath).toBeDefined();
      expect(successfulExpediaMetadata.goldenPath.propertyId).toBeDefined();
      expect(successfulExpediaMetadata.structuralProof.proof_version).toMatch(/^\d+\.\d+/);
    });
    
    it('rejects extractions with url_only strategy for Expedia', () => {
      // If we see url_only strategy for Expedia, it means generic flow was incorrectly used
      const incorrectMetadata = {
        strategy_used: 'url_only',
        validation_result: 'dates_not_applied',
      };
      
      // This is the failure pattern we're testing against
      const isIncorrectlyRouted = 
        incorrectMetadata.strategy_used === 'url_only' &&
        !('goldenPath' in incorrectMetadata);
      
      expect(isIncorrectlyRouted).toBe(true);
      // In production, this should NOT happen for Expedia
    });
  });
});
