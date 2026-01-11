# Result Categorization

## Overview

The result categorization module (`src/lib/resultCategorization.ts`) provides unified classification of search results into user-friendly buckets based on the canonical price model.

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
- `confidence` is medium or high
- Taxes/fees are included

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
