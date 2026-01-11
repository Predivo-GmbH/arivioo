# Expedia Golden Path Contract

## Overview

The Expedia golden path is the reference implementation for platform-specific price extraction. It ensures reliable extraction of canonical total prices (including taxes and fees) from Expedia's Hotel-Search offers page.

## Extraction Flow

```
generate-deep-links
    └── process-platform-extraction (worker)
            └── getPlatformTier() → Tier A
                    └── extract-expedia (golden path)
                            ├── Property ID extraction
                            ├── Hotel-Search URL construction (USD-first)
                            ├── Provider cascade (Browserless → Zyte → Firecrawl)
                            ├── Offers page gate validation
                            ├── Target card anchoring
                            └── Price extraction with structural proof
```

## CRITICAL: Routing Requirement

Expedia extractions MUST be routed through `process-platform-extraction`, which checks the platform tier and routes Tier A platforms to their dedicated extractors.

**WRONG (causes `strategy_used: url_only` in metadata):**
```
generate-deep-links → validate-dates → extract-prices
```

**CORRECT (causes `goldenPath: {...}` in metadata):**
```
generate-deep-links → process-platform-extraction → extract-expedia
```

## Canonical Price Requirements

A valid Expedia extraction MUST produce:

| Field | Requirement |
|-------|-------------|
| `price_type` | `total_proven` |
| `total_price` | Non-null, > 0 |
| `currency` | Normalized to USD |
| `evidence_snippet` | Contains `TARGET_CARD [propertyId]` |
| `extraction_metadata.goldenPath` | Contains `propertyId`, `offersPageUrl` |
| `extraction_metadata.structuralProof` | `proof_version: 6.3-target-card`, `extracted_from_target_card: true` |

## Success Criteria

An Expedia extraction is successful if:

1. **Offers page reached**: `structuralProof.offers_page_gate_passed === true`
2. **Target card found**: `structuralProof.target_card_found === true`
3. **Total extracted from target card**: `structuralProof.extracted_from_target_card === true`
4. **Includes taxes and fees**: Price comes from "total with taxes and fees" label
5. **Dates validated**: URL-injected dates match requested dates

## Terminal Statuses

| Status | Meaning | Retryable |
|--------|---------|-----------|
| `success` | Total price extracted with full proof | No |
| `dates_unavailable` | Property sold out or unavailable for dates (detected via "sold out" text) | No |
| `sold_out` | Property explicitly sold out | No |
| `expedia_target_offer_not_found` | Property card not on offers page | No |
| `expedia_target_offer_mismatch` | Property card found but title mismatch | No |
| `expedia_dates_unavailable_for_target` | Property unavailable for dates | No |
| `expedia_target_total_not_found` | No total price in target card | No |
| `expedia_offers_page_not_reached` | Could not navigate to offers page | Yes |
| `blocked_captcha_or_bot` | All providers blocked | Yes |
| `property_id_not_found` | Cannot extract property ID from URL | No |

Note: `dates_unavailable` is a **legitimate terminal status** indicating the property genuinely isn't available on Expedia for the requested dates. This is NOT an extraction failure - the golden path correctly detected unavailability.

## USD-First Strategy

Expedia extraction uses a USD-first strategy:

1. **Primary**: `https://www.expedia.com/Hotel-Search?currency=USD&locale=en_US&siteid=1&...`
2. **Fallback**: `https://www.expedia.co.jp/Hotel-Search?...` (only if USD fails)

This ensures consistent currency handling without conversion.

## Implementation Files

| File | Purpose |
|------|---------|
| `supabase/functions/extract-expedia/index.ts` | Golden path extractor |
| `supabase/functions/process-platform-extraction/index.ts` | Tier-based routing |
| `supabase/functions/generate-deep-links/index.ts` | Triggers worker (NOT validate-dates) |
| `src/lib/__tests__/expediaPipelineRouting.test.ts` | Regression tests |
| `docs/GOLDEN_PATH_CONTRACT.md` | Cross-platform contract |

## Regression Protection

The test file `src/lib/__tests__/expediaPipelineRouting.test.ts` validates:

1. Expedia routes to `extract-expedia` golden path
2. Tier lookup returns Tier A for Expedia
3. Metadata contains `goldenPath` (not `strategy_used`)
4. `generate-deep-links` uses `process-platform-extraction` (not `validate-dates`)

Run tests with:
```bash
npx vitest run src/lib/__tests__/expediaPipelineRouting.test.ts
```

## Debugging Checklist

If Expedia extraction fails with `strategy_used: url_only` in metadata:

1. ❌ Flow went through `validate-dates` (wrong path)
2. ✓ Check `generate-deep-links` is calling `process-platform-extraction`
3. ✓ Check `platform_adapters` has Expedia as Tier A with `dedicated_extractor: extract-expedia`

If Expedia extraction fails with `blocked_captcha_or_bot`:

1. Check Browserless, Zyte, Firecrawl provider health
2. Review `providerAttemptTrace` in extraction metadata
3. Consider if rate limiting is occurring

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 6.3 | 2026-01 | Target card anchoring, USD-first strategy |
| 5.1 | 2025-12 | Offers page hard gate |
| 5.0 | 2025-12 | Golden path with Hotel-Search URL |
| 3.0 | 2025-11 | Initial golden path implementation |
