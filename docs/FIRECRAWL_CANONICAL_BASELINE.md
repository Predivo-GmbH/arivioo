# Firecrawl Canonical Baseline — Do Not Modify Without Comparison

> ⚠️ **CRITICAL**: Any Firecrawl fix MUST start by comparing against this canonical state.  
> Do NOT make changes until you've identified what differs from this baseline.

---

## Enforcement Mechanism

This baseline is protected by a **multi-layer enforcement strategy**:

### Primary: Runtime Self-Test (Automatic)
The `airbnb-selftest` edge function validates canonical baseline behaviour on every deploy.
- **Endpoint**: `POST /airbnb-selftest?mode=firecrawl-canonical-check`
- **Execution**: Runs deterministic checks against fixture expectations
- **Failure**: Returns `firecrawl_canonical_violation` status
- **Surfaced**: Admin dashboard shows health status

### Secondary: Regression Test Suite
- **File**: `src/lib/__tests__/extractionStateMachine.test.ts`
- **Test**: "Test L: Firecrawl Canonical Baseline Regression Guard"
- **Command**: `npx vitest run`
- **Blocks**: Must pass before any Firecrawl code changes

### Enforcement Rules
1. Edge function deploy triggers automatic self-test
2. Any `firecrawl_canonical_violation` blocks the feature from working
3. Regression tests must pass locally before modifying Firecrawl logic
4. This document MUST be consulted before any Firecrawl fix

---

## Last Known Working State

**Date Verified**: 2026-01-11  
**Status**: `total_price_including_taxes_and_fees` (when total found)  
**Fallback Role**: Tertiary provider after Browserless and Zyte failure

---

## Canonical Extraction Flow

Firecrawl serves as the tertiary fallback when both Browserless and Zyte fail.

```
┌─────────────────────────────────────────────────────────────┐
│                   FIRECRAWL EXTRACTION                       │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  INPUT: book/stays or rooms URL with scrape options          │
│  ├── formats: ['markdown', 'html', 'screenshot']             │
│  ├── waitFor: calculated dynamically (<=timeout/2)          │
│  ├── timeout: 2.5x waitFor minimum                           │
│  └── onlyMainContent: false (need full page)                 │
│                                                              │
│  PRIORITY 1: Screenshot OCR Extraction                       │
│  ├── Uses screenshot + Lovable AI OCR                        │
│  ├── Searches for: "Total (USD)", "Trip total", "Pay now"    │
│  └── Success: total_price_including_taxes_and_fees          │
│                                                              │
│  PRIORITY 2: Markdown Text Extraction                        │
│  ├── Parses markdown for price patterns                      │
│  ├── Regex: Total\s+\([A-Z]{3}\)\s*[$€£]\s*[\d,]+           │
│  └── Success: total_price_including_taxes_and_fees          │
│                                                              │
│  PRIORITY 3: HTML Fallback Extraction                        │
│  ├── Parses raw HTML if markdown insufficient                │
│  ├── Same regex patterns                                     │
│  └── Success: total_price_including_taxes_and_fees          │
│                                                              │
│  PRIORITY 4: Subtotal Detection (fallback)                   │
│  ├── Detects: "$X for N nights" pattern                      │
│  └── Result: needs_user_confirmation (NOT promoted!)         │
│                                                              │
│  FAILURE MODES:                                              │
│  ├── Bot detection: blocked_captcha_or_bot                   │
│  ├── Rate limit: rate_limited                                │
│  ├── No content: price_not_available_in_content              │
│  ├── Timeout: provider_timeout                               │
│  └── API error: provider_error                               │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## Expected Structured Output Fields

| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | True if Firecrawl API call succeeded |
| `markdown` | string\|null | Markdown content of the page |
| `html` | string\|null | Raw HTML content |
| `screenshot` | string\|null | Base64 screenshot for OCR |
| `providerUsed` | string | Always `'firecrawl'` |
| `statusCode` | number | HTTP response code |
| `error` | string\|null | Error message if failed |
| `evidenceSnippet` | string\|null | Text evidence of price |

---

## Success Criteria

**Verified Total** (`total_price_including_taxes_and_fees`):
- Markdown, HTML, or OCR contains explicit total label ("Total (USD)", "Trip total")
- Amount extracted is > $50 (sanity check)
- HTTP status 200
- Success flag is true

**Needs Confirmation** (`needs_user_confirmation`):
- Only subtotal found ("$X for N nights")
- No total label present
- Subtotal is NEVER promoted to verified

**Failure States**:
- `blocked_captcha_or_bot`: Bot indicators detected in content
- `rate_limited`: HTTP 429 received
- `provider_error`: HTTP 4xx/5xx or API error
- `provider_timeout`: Request exceeded timeout
- `price_not_available_in_content`: No price patterns found

---

## Invariant Rules (Protected by Tests)

### 1. Subtotal Never Promoted
```typescript
// If only subtotal exists, NEVER return as verified total
if (hasSubtotal && !hasTotal) {
  return { status: 'needs_user_confirmation', price: null };
}
```

### 2. Currency Normalization
```typescript
// Must handle: $, €, £, CHF, thousand separators
const normalized = rawPrice
  .replace(/[^0-9.,]/g, '')  // Strip currency symbols
  .replace(/,/g, '');         // Remove thousand separators
const amount = parseFloat(normalized);
```

### 3. Timeout Safety
```typescript
// CRITICAL: waitFor must be <= timeout/2
const timeout = Math.max(waitFor * 2.5, 30000);
```

### 4. Null Safety
```typescript
// Empty/malformed input must not crash
if (!markdown && !html) {
  return { ok: false, error: 'insufficient_content' };
}
```

### 5. Output Shape Validation
All responses must include: `success`, `providerUsed`, `error` (or null).

---

## Comparison Workflow

When Firecrawl fails, follow this mandatory workflow:

### Step 1: Identify the Failure Type
- [ ] API error (non-200 status)
- [ ] Timeout exceeded
- [ ] Insufficient content
- [ ] No price patterns found
- [ ] Unexpected response shape

### Step 2: Compare Against Canonical State
| Field | Expected | Actual |
|-------|----------|--------|
| Request URL | `/book/stays/...` checkout page | |
| formats | `['markdown', 'html', 'screenshot']` | |
| waitFor | <= timeout/2 | |
| timeout | >= 30000ms | |
| OCR attempted (if screenshot) | ✓ | |

### Step 3: Document Delta Before Fix
Before changing anything, write down:
1. What differs from canonical behaviour?
2. Why did this difference occur?
3. Does the fix restore canonical behaviour or intentionally change it?

---

## Protected Invariants (Regression Tests)

These invariants are protected by `src/lib/__tests__/extractionStateMachine.test.ts`:

1. **Output shape valid**: Required fields always present (success, providerUsed, error)
2. **OCR total takes priority**: Screenshot OCR > markdown > HTML for total extraction
3. **Subtotal never promoted**: `$X for N nights` → `needs_user_confirmation`, NOT verified
4. **Currency normalization**: USD, EUR, CHF, GBP formats parsed correctly
5. **Null safety**: Empty input doesn't crash

---

## Code Location Reference

| Component | File | Key Lines |
|-----------|------|-----------|
| Firecrawl scrape | `firecrawl-simple/index.ts` | Main extraction |
| Price extraction | `extract-prices/index.ts` | Fallback chain |
| Timeout constraint | Documented in memory | waitFor <= timeout/2 |
| Regression tests | `extractionStateMachine.test.ts` | Test L |

---

## History

| Date | Event | Notes |
|------|-------|-------|
| 2026-01-11 | Baseline established | After confirming Firecrawl fallback works correctly |
| 2026-01-11 | Enforcement implemented | Runtime self-test + regression guard |

---

## Future-Proofing

This enforcement mechanism remains valid when:

1. **CI is added later**: Regression tests become part of CI pipeline; runtime self-test remains as secondary check
2. **Developer workflows change**: Runtime enforcement cannot be bypassed regardless of local practices
3. **Firecrawl logic evolves**: Any change that breaks canonical checks is immediately visible in production

---

*This baseline is the canonical reference point. Future fixes MUST compare against it first.*
