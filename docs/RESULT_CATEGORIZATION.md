# Result Categorization and Price Comparison

## Overview

This document describes how search results are categorized into user-friendly buckets based on the canonical price model and extraction outcomes.

## Key Principle: Price Type ≠ Confidence

**CRITICAL**: The `price_type` (what kind of price was found) is determined by *what* was extracted, NOT by confidence scores.

- **`total_proven`**: A verified total price including taxes and fees, with structural proof
- **`total_derived`**: A total price calculated from components with explicit derivation
- **`subtotal_nights_only`**: Sum of nightly rates without fees/taxes
- **`nightly_only`**: Single night rate only

**Low confidence does NOT mean partial price**. A structurally verified total with low confidence is still a total—it just needs manual verification recommended.

## Bucket Hierarchy (Precedence Order)

1. **Platform Blocked** - Tier C platforms, always first check
2. **Sold Out** - Dates unavailable (NOT an error)
3. **Blocked** - Captcha, bot detection, access denied
4. **Requires Action** - Login, confirmation needed
5. **Service Error** - Timeouts, 5xx errors
6. **Price Not Found** - Platform accessible but price not extracted
7. **Cheaper** - Comparable total, lower than Airbnb
8. **More Expensive** - Comparable total, higher than Airbnb
9. **Not Comparable** - Price exists but can't compare (subtotal, currency mismatch, etc.)

## Comparability Rules

A price is **comparable** only when:
- `price_type` is `total_proven` or `total_derived`
- Same currency as Airbnb
- Same date range and nights count
- Taxes/fees are included
- Extraction status is success

**Note**: Low confidence does NOT block comparability when `price_type` is `total_proven` (structural verification exists). It only adds a "manual check recommended" badge.

## Verified vs Unverified

A result is **verified** when:
- `price_type` is `total_proven` or `total_derived`
- Either: `is_comparable` is true OR structural proof exists

A result with low confidence but structural verification is still "verified"—the low confidence just adds a note.

## Key Files

- `src/lib/resultCategorization.ts` - Bucket logic and display config
- `src/lib/canonicalPrice.ts` - Price normalization and comparison
- `src/lib/extractionOutcomeTaxonomy.ts` - Outcome classification
- `src/hooks/useEnrichedSearchResults.ts` - Result enrichment
- `src/pages/SearchResults.tsx` - Frontend categorization

## UI Buckets

| Bucket | User Label | When to Show |
|--------|------------|--------------|
| `cheaper` | "Found and cheaper" | Comparable total < Airbnb |
| `more_expensive` | "Found but more expensive" | Comparable total > Airbnb |
| `not_comparable` | "Price not comparable" | Has price, fails comparability |
| `sold_out` | "Not available for these dates" | dates_unavailable status |
| `price_not_found` | "Price not found" | Extraction incomplete |
| `blocked` | "Access blocked" | Bot detection, captcha |
| `requires_action` | "Requires action" | Login needed, confirmation required |
| `service_error` | "Temporary error" | Timeout, 5xx, provider error |
| `platform_blocked` | "Platform not supported" | Tier C blocked |

## Regression Test

Test N in `src/lib/__tests__/extractionStateMachine.test.ts` ensures:
- A total_proven price with null/low confidence is correctly classified
- The bucket is "more_expensive" or "cheaper" (not "not_comparable")
- The verification_label is "Verified" (not "Unverified")
- No "partial price" messaging appears for proven totals
