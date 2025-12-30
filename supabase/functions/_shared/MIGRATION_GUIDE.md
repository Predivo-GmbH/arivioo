# Migration Guide: Adopting Shared Modules

This guide explains how to migrate existing edge functions to use the canonical `_shared/` modules.

## Quick Start

Replace local implementations with imports from `_shared/`:

```typescript
// BEFORE: Local implementation
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// AFTER: Import from shared module
import { corsHeaders, handleCorsPreFlight } from "../_shared/mod.ts";
```

## Migration Steps by Module

### 1. CORS Headers (Highest Priority)

**Files to update:** ALL edge functions

```typescript
// Remove this block from each edge function:
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "...",
};

// Add this import:
import { corsHeaders, handleCorsPreFlight } from "../_shared/mod.ts";

// Replace OPTIONS handling:
// BEFORE:
if (req.method === "OPTIONS") {
  return new Response(null, { headers: corsHeaders });
}

// AFTER:
const corsResponse = handleCorsPreFlight(req);
if (corsResponse) return corsResponse;
```

### 2. Fetch Utilities

**Files to update:** All functions using `fetchWithTimeout`

```typescript
// Remove local fetchWithTimeout function

// Add import:
import { fetchWithTimeout, withTimeout, sleep } from "../_shared/mod.ts";
```

### 3. Airbnb URL Utilities

**Files to update:** `search-alternatives`, `airbnb-baseline-test`, `airbnb-selftest`, `airbnb-diagnostic`

```typescript
// Remove local buildBookStaysUrl function

// Add import:
import { 
  buildBookStaysUrl, 
  parseAirbnbUrl, 
  calculateNights 
} from "../_shared/mod.ts";
```

### 4. Image Extraction

**Files to update:** `search-alternatives`, all scrapers

```typescript
// Remove local muscache patterns and isValidPropertyImage

// Add import:
import { 
  extractAirbnbImages, 
  isValidPropertyImage,
  extractListingTitle 
} from "../_shared/mod.ts";

// Replace image extraction logic:
// BEFORE:
const imagePatterns = [
  /https:\/\/a\d+\.muscache\.com\/im\/pictures\/[^"'\s\)]+/gi,
  // ... more patterns
];
// ... extraction logic

// AFTER:
const imageUrls = extractAirbnbImages(html, 5);
```

### 5. Bot Detection

**Files to update:** All Airbnb scrapers

```typescript
// Remove local detectBotIndicators function

// Add import:
import { detectBotIndicators, hasBotWall } from "../_shared/mod.ts";
```

### 6. Provider Logging

**Files to update:** `search-alternatives`, all extraction functions

```typescript
// Remove local logProviderRequest function and types

// Add import:
import { logProviderRequest, type ProviderLogParams } from "../_shared/mod.ts";
```

## Verification Checklist

After migrating each function:

- [ ] Function builds without errors
- [ ] No duplicate definitions of shared logic
- [ ] All imports resolve correctly
- [ ] Function behavior is identical to before
- [ ] Logs show correct module version

## Common Issues

### Import Path Issues

Ensure import paths are correct relative to function location:

```typescript
// From supabase/functions/my-function/index.ts:
import { corsHeaders } from "../_shared/mod.ts";  // ✓ Correct

// NOT:
import { corsHeaders } from "./_shared/mod.ts";   // ✗ Wrong
import { corsHeaders } from "_shared/mod.ts";     // ✗ Wrong
```

### Type Conflicts

If you have local type definitions that conflict, remove them and use shared types:

```typescript
// Remove local types
// type AirbnbProvider = ...

// Import shared types
import type { AirbnbProvider, AirbnbScrapeResult } from "../_shared/mod.ts";
```

### Function Signature Changes

Some shared functions may have slightly different signatures. Check the module documentation.

## Gradual Migration

You can migrate incrementally:

1. Start with CORS (least risk, most impact)
2. Then fetch utilities
3. Then Airbnb URL utilities
4. Then image extraction
5. Finally, complex extraction logic

## Testing

After each migration step:

1. Deploy the function
2. Test with a real request
3. Verify logs show expected behavior
4. Check that results match previous behavior
