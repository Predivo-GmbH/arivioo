# Shared Modules — Single Source of Truth

> **ARCHITECTURAL RULE**: All shared logic MUST be defined here and imported by consumers.  
> Duplicating logic outside `_shared/` is prohibited and will cause build failures.

## Purpose

This directory contains **canonical implementations** of shared concerns. Any logic that:
- Is used by more than one edge function
- Is conceptually global (extraction, pricing, branding, validation)

**MUST** live here and be imported by all consumers.

## Module Structure

```
_shared/
├── airbnb/
│   ├── url-utils.ts          # URL parsing, buildBookStaysUrl
│   ├── image-extraction.ts   # muscache patterns, isValidPropertyImage
│   ├── price-extraction.ts   # extractBaselineFromContent, price candidates
│   ├── ocr-validation.ts     # OCR reference extraction and validation
│   ├── bot-detection.ts      # detectBotIndicators
│   └── mod.ts                # Re-exports all Airbnb utilities
│
├── scraping/
│   ├── browserless.ts        # Browserless client wrapper
│   ├── zyte.ts               # Zyte client wrapper
│   ├── firecrawl.ts          # Firecrawl client wrapper
│   └── mod.ts                # Re-exports all scraping utilities
│
├── logging/
│   ├── provider-logs.ts      # logProviderRequest
│   └── mod.ts
│
├── http/
│   ├── cors.ts               # corsHeaders, handleCorsPreFlight
│   ├── fetch-utils.ts        # fetchWithTimeout, withTimeout
│   └── mod.ts
│
├── types/
│   └── mod.ts                # Shared TypeScript interfaces
│
└── mod.ts                    # Main entry point, re-exports everything
```

## How to Import

From any edge function:

```typescript
// Import specific utilities
import { buildBookStaysUrl, isValidPropertyImage } from "../_shared/airbnb/mod.ts";
import { corsHeaders, handleCorsPreFlight } from "../_shared/http/mod.ts";
import { logProviderRequest } from "../_shared/logging/mod.ts";

// Or import everything from main entry
import { buildBookStaysUrl, corsHeaders } from "../_shared/mod.ts";
```

## Module Ownership

| Module | Owns | Consumers |
|--------|------|-----------|
| `airbnb/url-utils` | `buildBookStaysUrl`, `parseAirbnbUrl`, `extractRoomId` | search-alternatives, airbnb-baseline-test, airbnb-selftest, airbnb-diagnostic |
| `airbnb/image-extraction` | `extractAirbnbImages`, `isValidPropertyImage`, `MUSCACHE_PATTERNS` | search-alternatives, all scrapers |
| `airbnb/price-extraction` | `extractBaselineFromContent`, `extractPriceCandidates`, `extractOcrFromHtml` | search-alternatives, airbnb-baseline-test, airbnb-selftest |
| `airbnb/ocr-validation` | `extractOcrVisualReference`, `validateProviderPriceWithOcr` | search-alternatives, airbnb-baseline-test, airbnb-selftest |
| `airbnb/bot-detection` | `detectBotIndicators`, `BOT_PATTERNS` | All Airbnb scrapers |
| `http/cors` | `corsHeaders`, `handleCorsPreFlight` | ALL edge functions |
| `http/fetch-utils` | `fetchWithTimeout`, `withTimeout` | ALL edge functions |
| `logging/provider-logs` | `logProviderRequest` | search-alternatives, all extraction functions |

## Versioning

Each module exports a `MODULE_VERSION` constant for debugging:

```typescript
export const MODULE_VERSION = "1.0.0";
```

When debugging, log the version:
```typescript
console.log(`Using airbnb/url-utils v${MODULE_VERSION}`);
```

## Enforcement

### Build-Time Guard

A lint script scans for forbidden patterns outside `_shared/`:

```bash
# Run before deploy
deno task lint:shared
```

Fails if:
- `buildBookStaysUrl` is defined outside `_shared/airbnb/url-utils.ts`
- `corsHeaders` is defined outside `_shared/http/cors.ts`
- muscache regex patterns appear outside `_shared/airbnb/image-extraction.ts`

### Runtime Guard (Deprecated Stubs)

Old locations should contain stubs that throw:

```typescript
// DEPRECATED: Use import from _shared/airbnb/mod.ts
export function buildBookStaysUrl() {
  throw new Error(
    "DEPRECATED: buildBookStaysUrl must be imported from '../_shared/airbnb/mod.ts'. " +
    "Do not reimplement shared logic."
  );
}
```

## Adding New Shared Logic

1. Identify the concern and appropriate module
2. Implement in the canonical location only
3. Export from the module's `mod.ts`
4. Export from `_shared/mod.ts` if widely used
5. Update this README's ownership table
6. Add enforcement pattern to lint script

## Migration Checklist

When migrating existing duplicated logic:

- [ ] Identify all current locations of the logic
- [ ] Create canonical implementation in `_shared/`
- [ ] Add `MODULE_VERSION` export
- [ ] Update all consumers to import from `_shared/`
- [ ] Remove duplicated implementations
- [ ] Add deprecated stub if removal is gradual
- [ ] Add pattern to lint enforcement
- [ ] Test all affected edge functions

## Current Migration Status

### Consumers

| Edge Function | Status | Notes |
|---------------|--------|-------|
| `search-alternatives` | 🟢 Migrated | corsHeaders, fetchWithTimeout, buildBookStaysUrl, detectBotIndicators, logProviderRequest |
| `airbnb-baseline-test` | ⚪ Pending | |
| `airbnb-selftest` | ⚪ Pending | |
| `airbnb-diagnostic` | ⚪ Pending | |
| `extract-prices` | ⚪ Pending | |

### Modules

| Module | Status | Notes |
|--------|--------|-------|
| `http/cors` | 🟢 Ready | Canonical implementation active |
| `http/fetch-utils` | 🟢 Ready | Canonical implementation active |
| `airbnb/url-utils` | 🟢 Ready | Canonical implementation active |
| `airbnb/image-extraction` | 🟡 Ready | Canonical implementation ready |
| `airbnb/price-extraction` | ⚪ Pending | Complex, requires careful extraction |
| `airbnb/ocr-validation` | ⚪ Pending | Depends on price-extraction |
| `airbnb/bot-detection` | 🟢 Ready | Canonical implementation active |
| `logging/provider-logs` | 🟢 Ready | Canonical implementation active |
| `scraping/*` | ⚪ Pending | Large refactor needed |

Legend: 🟢 Active | 🟡 Ready (not yet consumed) | ⚪ Pending

---

**This is the single source of truth. Do not duplicate. Import.**
