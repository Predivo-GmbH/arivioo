# Canonical Price Model

## Overview

The canonical price model (`src/lib/canonicalPrice.ts`) provides a platform-agnostic foundation for price extraction, storage, and comparison. It enforces strict rules to prevent false "cheaper" claims.

## Price Types

| Type | Description | Comparable? |
|------|-------------|-------------|
| `total_proven` | Total verified via structural proof (breakdown, taxes included) | ✅ Yes |
| `total_derived` | Total calculated from components with explicit derivation | ✅ Yes |
| `subtotal_nights_only` | Sum of nightly rates without fees/taxes | ❌ No |
| `nightly_only` | Single night rate (no stay total available) | ❌ No |
| `unknown` | Cannot determine what this price represents | ❌ No |

## Comparison Rules

Two prices are **comparable** only if ALL of the following are true:

1. **Same currency** - No silent conversions
2. **Same nights_count** - Same stay duration
3. **Same date range** - check_in and check_out match
4. **Both have total prices** - total_price is not null
5. **Both are total types** - price_type is `total_proven` or `total_derived`
6. **Dates validated** - Platform confirmed dates applied
7. **Medium/High confidence** - Low confidence prices excluded

## Usage

```typescript
import { 
  normalizeExtraction, 
  comparePrices, 
  rankAlternatives,
  getPriceDisplayInfo 
} from '@/lib/canonicalPrice';

// Normalize extraction output
const canonical = normalizeExtraction(extractionInput);

// Compare prices
const comparison = comparePrices(baselinePrice, alternativePrice);
if (comparison.is_comparable && comparison.is_cheaper) {
  // Safe to claim savings
}

// Rank alternatives
const { comparable, not_comparable, cheapest } = rankAlternatives(baseline, alternatives);
```

## UI Display

- Always show `price_type_label` next to prices
- Non-comparable prices show "Manual check recommended"
- Never show "Best Deal" or savings for incompatible price types
