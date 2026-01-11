# Browserless Canonical Baseline — Do Not Modify Without Comparison

> ⚠️ **CRITICAL**: Any Browserless fix MUST start by comparing against this canonical state.  
> Do NOT make changes until you've identified what differs from this baseline.

---

## Enforcement Mechanism

This baseline is protected by a **multi-layer enforcement strategy**:

### Primary: Runtime Self-Test (Automatic)
The `airbnb-selftest` edge function validates canonical baseline behaviour on every deploy.
- **Endpoint**: `POST /airbnb-selftest?mode=canonical-check`
- **Execution**: Runs deterministic checks against fixture expectations
- **Failure**: Returns `canonical_baseline_violation` status
- **Surfaced**: Admin dashboard shows health status

### Secondary: Regression Test Suite
- **File**: `src/lib/__tests__/extractionStateMachine.test.ts`
- **Test**: "Test J: Browserless Canonical Baseline Regression Guard"
- **Command**: `npx vitest run`
- **Blocks**: Must pass before any Browserless code changes

### Enforcement Rules
1. Edge function deploy triggers automatic self-test
2. Any `canonical_baseline_violation` blocks the feature from working
3. Regression tests must pass locally before modifying Browserless logic
4. This document MUST be consulted before any Browserless fix

---

## Last Known Working State

**Date Verified**: 2026-01-11  
**Status**: `total_price_including_taxes_and_fees`  
**Test Case**: CHF 1658.94 for 3 nights extracted from Airbnb checkout page

---

## Canonical Extraction Flow

The Browserless baseline follows a strict priority order:

```
┌─────────────────────────────────────────────────────────────┐
│                  BROWSERLESS EXTRACTION                      │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  PRIORITY 1: Direct Text Extraction (payNowExtraction)       │
│  ├── Searches: document.body.innerText + innerHTML           │
│  ├── Patterns: "Pay $X now", "Total (USD) $X", "Due today"   │
│  └── Success: total_price_including_taxes_and_fees          │
│                                                              │
│  PRIORITY 2: OCR Breakdown Total (ocrBreakdownTotal)         │
│  ├── Source: Full-page screenshot with enhanced prompts      │
│  ├── Target: "Total (USD)" label in price breakdown          │
│  └── Success: total_price_including_taxes_and_fees          │
│                                                              │
│  PRIORITY 3: OCR Booking Card (subtotal)                     │
│  ├── Source: Booking card screenshot                         │
│  ├── Detects: "$X for N nights" pattern                      │
│  └── Result: needs_user_confirmation (NOT promoted!)         │
│                                                              │
│  FALLBACK: No price found                                    │
│  └── Result: price_not_available_in_content                  │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## Accepted Success Status

**ONLY** `total_price_including_taxes_and_fees` is considered a verified Browserless success.

All other statuses trigger fallback (Zyte) or early stop (debug mode):
- `needs_user_confirmation`
- `price_not_available_in_content`
- `total_price_excluding_taxes_and_fees`
- Any HTTP/regex error

---

## Required Page Capture Behaviour

| Setting | Value | Notes |
|---------|-------|-------|
| `fullPage` | `true` | Captures entire checkout page |
| `scrollY` | Dynamic | Scrolls to bottom if booking card not found |
| `waitFor` | `div.checkout` or similar | Waits for checkout structure |
| `timeout` | 60000ms | Total page load timeout |
| `screenshotQuality` | 70% JPEG | Balance of size vs OCR accuracy |

---

## Evaluation Criteria

### Success (Verified Total)
```typescript
if (payNowData?.payNowAmount && payNowData.payNowAmount > 0) {
  return {
    status: 'total_price_including_taxes_and_fees',
    price: payNowData.payNowAmount,
    source: 'direct_text_extraction',
  };
}
```

### Needs User Confirmation (Subtotal Only)
```typescript
if (ocrBookingCardAmount && ocrBookingCardAmount > 0 && !ocrBreakdownTotal) {
  return {
    status: 'needs_user_confirmation',
    price: null,  // NEVER promote subtotal
    source: 'subtotal_only',
  };
}
```

---

## Regex Patterns (JSON-Safe)

All patterns must use double-escaping to survive JSON serialization:

```javascript
// Pay Now pattern (primary)
const payNowRe = new RegExp(
  'Pay\\s+(?:US\\s*)?[' + currencySymbols + ']\\s*([\\d,]+(?:\\.\\d{2})?)\\s*(?:now|today)',
  'i'
);

// Total pattern (secondary)  
const totalRe = new RegExp(
  'Total\\s+\\([A-Z]{3}\\)\\s*(?:US\\s*)?[' + currencySymbols + ']\\s*([\\d,]+(?:\\.\\d{2})?)',
  'i'
);

// Due Today pattern (tertiary)
const dueTodayRe = new RegExp(
  'Due\\s+today\\s*(?:US\\s*)?[' + currencySymbols + ']\\s*([\\d,]+(?:\\.\\d{2})?)',
  'i'
);
```

⚠️ **NEVER** use unsupported regex constructs like `(?s)` or lookbehind.

---

## Debug Mode vs Normal Mode

| Aspect | Debug Mode (`BROWSERLESS_ONLY_BASELINE=true`) | Normal Mode |
|--------|-----------------------------------------------|-------------|
| Extraction call | **Identical** | **Identical** |
| Request payload | **Identical** | **Identical** |
| Success criteria | **Identical** | **Identical** |
| On failure | **STOPS** with `baseline_browserless_failed` | **Falls back** to Zyte |

The ONLY difference is control flow after extraction. The extraction itself MUST be identical.

---

## Regression Comparison Workflow

When Browserless fails, follow this mandatory workflow:

### Step 1: Identify the Failure Type
- [ ] Invalid regex compilation
- [ ] HTTP error (403, 429, timeout)
- [ ] `needs_user_confirmation` (subtotal only)
- [ ] `price_not_available_in_content`
- [ ] Unexpected status

### Step 2: Compare Against Canonical State
| Field | Expected | Actual |
|-------|----------|--------|
| Request URL | `/book/stays/...` checkout page | |
| Wait condition | Checkout div present | |
| Full page screenshot | `true` | |
| `payNowExtraction` passed through | ✓ | |
| `payNowAmount` extracted | ✓ (if present on page) | |
| Regex patterns compile | ✓ | |
| Status evaluation matches priority | ✓ | |

### Step 3: Document Delta Before Fix
Before changing anything, write down:
1. What differs from canonical behaviour?
2. Why did this difference occur?
3. Does the fix restore canonical behaviour or intentionally change it?

---

## Protected Invariants (Regression Tests)

These invariants are protected by `src/lib/__tests__/extractionStateMachine.test.ts`:

1. **Subtotal never promoted**: `$X for N nights` → `needs_user_confirmation`, NOT verified
2. **payNowExtraction passed through**: Interface includes field, consumer receives it
3. **Priority order respected**: Direct text → OCR breakdown → OCR card
4. **Debug/normal mode identical extraction**: Same input → same output
5. **Null safety**: Missing `payNowExtraction` doesn't crash

---

## Code Location Reference

| Component | File | Key Lines |
|-----------|------|-----------|
| AirbnbScrapeResult interface | `search-alternatives/index.ts` | ~153 |
| payNowExtraction patterns | `search-alternatives/index.ts` | ~760-890 |
| payNowExtraction assignment | `search-alternatives/index.ts` | ~965, ~1065 |
| Consumer evaluation | `search-alternatives/index.ts` | ~5185-5220 |
| Regression tests | `extractionStateMachine.test.ts` | Test J |

---

## History

| Date | Event | Notes |
|------|-------|-------|
| 2026-01-11 | Baseline established | After fix for payNowExtraction not being passed through |
| 2026-01-11 | Debug/normal mode unified | Single extraction path for both modes |
| 2026-01-11 | Enforcement implemented | Runtime self-test + regression guard |

---

## Future-Proofing

This enforcement mechanism remains valid when:

1. **CI is added later**: Regression tests become part of CI pipeline; runtime self-test remains as secondary check
2. **Developer workflows change**: Runtime enforcement cannot be bypassed regardless of local practices
3. **Browserless logic evolves**: Any change that breaks canonical checks is immediately visible in production

---

*This baseline is the canonical reference point. Future fixes MUST compare against it first.*
