# Zyte Canonical Baseline — Do Not Modify Without Comparison

> ⚠️ **CRITICAL**: Any Zyte fix MUST start by comparing against this canonical state.  
> Do NOT make changes until you've identified what differs from this baseline.

---

## Enforcement Mechanism

This baseline is protected by a **multi-layer enforcement strategy**:

### Primary: Runtime Self-Test (Automatic)
The `airbnb-selftest` edge function validates canonical baseline behaviour on every deploy.
- **Endpoint**: `POST /airbnb-selftest?mode=zyte-canonical-check`
- **Execution**: Runs deterministic checks against fixture expectations
- **Failure**: Returns `zyte_canonical_violation` status
- **Surfaced**: Admin dashboard shows health status

### Secondary: Regression Test Suite
- **File**: `src/lib/__tests__/extractionStateMachine.test.ts`
- **Test**: "Test K: Zyte Canonical Baseline Regression Guard"
- **Command**: `npx vitest run`
- **Blocks**: Must pass before any Zyte code changes

### Enforcement Rules
1. Edge function deploy triggers automatic self-test
2. Any `zyte_canonical_violation` blocks the feature from working
3. Regression tests must pass locally before modifying Zyte logic
4. This document MUST be consulted before any Zyte fix

---

## Last Known Working State

**Date Verified**: 2026-01-11  
**Status**: `total_price_including_taxes_and_fees` (when total found)  
**Fallback Role**: Secondary provider after Browserless failure

---

## Canonical Extraction Flow

Zyte serves as the fallback when Browserless fails to extract a verified total.

```
┌─────────────────────────────────────────────────────────────┐
│                     ZYTE EXTRACTION                          │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  INPUT: book/stays URL with browserHtml + screenshot         │
│  ├── browserHtml: true                                       │
│  ├── javascript: true                                        │
│  ├── screenshot: true (viewport only)                        │
│  └── actions: waitForTimeout 8s                              │
│                                                              │
│  PRIORITY 1: OCR Total Extraction                            │
│  ├── Uses screenshot + Lovable AI OCR                        │
│  ├── Searches for: "Total (USD)", "Trip total", "Pay now"    │
│  └── Success: total_price_including_taxes_and_fees          │
│                                                              │
│  PRIORITY 2: HTML Text Extraction                            │
│  ├── Parses browserHtml for price patterns                   │
│  ├── Regex: Total\s+\([A-Z]{3}\)\s*[$€£]\s*[\d,]+           │
│  └── Success: total_price_including_taxes_and_fees          │
│                                                              │
│  PRIORITY 3: Subtotal Detection (fallback)                   │
│  ├── Detects: "$X for N nights" pattern                      │
│  └── Result: needs_user_confirmation (NOT promoted!)         │
│                                                              │
│  FAILURE MODES:                                              │
│  ├── Bot detection: blocked_captcha_or_bot                   │
│  ├── Rate limit: rate_limited                                │
│  ├── No content: price_not_available_in_content              │
│  └── HTTP error: provider_error                              │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## Expected Structured Output Fields

| Field | Type | Description |
|-------|------|-------------|
| `ok` | boolean | True if extraction succeeded |
| `html` | string | Raw browserHtml from Zyte |
| `screenshot` | string\|null | Base64 screenshot for OCR |
| `providerUsed` | string | Always `'zyte'` |
| `botIndicators` | string[] | Detected bot/captcha patterns |
| `statusCode` | number | HTTP response code |
| `error` | string\|null | Error message if failed |
| `evidenceSnippet` | string\|null | Text evidence of price |

---

## Success Criteria

**Verified Total** (`total_price_including_taxes_and_fees`):
- HTML or OCR contains explicit total label ("Total (USD)", "Trip total")
- Amount extracted is > $50 (sanity check)
- No bot indicators detected
- HTTP status 200

**Needs Confirmation** (`needs_user_confirmation`):
- Only subtotal found ("$X for N nights")
- No total label present
- Subtotal is NEVER promoted to verified

**Failure States**:
- `blocked_captcha_or_bot`: Bot indicators detected in content
- `rate_limited`: HTTP 429 received
- `provider_error`: HTTP 4xx/5xx or timeout
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

### 3. Bot Detection Aborts
```typescript
// If bot indicators found, abort immediately
if (botIndicators.length > 0) {
  return { ok: false, error: 'blocked_captcha_or_bot' };
}
```

### 4. Null Safety
```typescript
// Empty/malformed input must not crash
if (!html || html.length < 500) {
  return { ok: false, error: 'insufficient_content' };
}
```

### 5. Output Shape Validation
All responses must include: `ok`, `providerUsed`, `error` (or null).

---

## Comparison Workflow

When Zyte fails, follow this mandatory workflow:

### Step 1: Identify the Failure Type
- [ ] Bot indicators detected
- [ ] HTTP error (403, 429, timeout)
- [ ] Insufficient content
- [ ] No price patterns found
- [ ] Unexpected response shape

### Step 2: Compare Against Canonical State
| Field | Expected | Actual |
|-------|----------|--------|
| Request URL | `/book/stays/...` checkout page | |
| browserHtml | `true` | |
| screenshot | `true` | |
| waitForTimeout | 8s | |
| Bot check performed | ✓ | |
| OCR attempted (if screenshot) | ✓ | |

### Step 3: Document Delta Before Fix
Before changing anything, write down:
1. What differs from canonical behaviour?
2. Why did this difference occur?
3. Does the fix restore canonical behaviour or intentionally change it?

---

## Protected Invariants (Regression Tests)

These invariants are protected by `src/lib/__tests__/extractionStateMachine.test.ts`:

1. **Subtotal never promoted**: `$X for N nights` → `needs_user_confirmation`, NOT verified
2. **Currency normalization**: USD, EUR, CHF formats parsed correctly
3. **Bot detection respected**: Bot indicators trigger abort
4. **Null safety**: Empty input doesn't crash
5. **Output shape valid**: Required fields always present

---

## Code Location Reference

| Component | File | Key Lines |
|-----------|------|-----------|
| scrapeAirbnbWithZyte | `search-alternatives/index.ts` | ~379-468 |
| Bot indicator detection | `search-alternatives/index.ts` | ~344-372 |
| Zyte request config | `search-alternatives/index.ts` | ~404-414 |
| Regression tests | `extractionStateMachine.test.ts` | Test K |

---

## History

| Date | Event | Notes |
|------|-------|-------|
| 2026-01-11 | Baseline established | After confirming Zyte fallback works correctly |
| 2026-01-11 | Enforcement implemented | Runtime self-test + regression guard |

---

## Future-Proofing

This enforcement mechanism remains valid when:

1. **CI is added later**: Regression tests become part of CI pipeline; runtime self-test remains as secondary check
2. **Developer workflows change**: Runtime enforcement cannot be bypassed regardless of local practices
3. **Zyte logic evolves**: Any change that breaks canonical checks is immediately visible in production

---

*This baseline is the canonical reference point. Future fixes MUST compare against it first.*
