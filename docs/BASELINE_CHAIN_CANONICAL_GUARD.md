# Baseline Chain Canonical Guard — Do Not Modify Without Comparison

> ⚠️ **CRITICAL**: Any orchestration or provider selection fix MUST start by comparing against this canonical state.  
> Do NOT make changes until you've identified what differs from this baseline.

---

## Enforcement Mechanism

This baseline is protected by a **multi-layer enforcement strategy**:

### Primary: Runtime Self-Test (Automatic)
The `airbnb-selftest` edge function validates canonical chain orchestration on every deploy.
- **Endpoint**: `POST /airbnb-selftest?mode=baseline-chain-canonical-check`
- **Execution**: Runs deterministic checks using mocked provider outputs
- **Failure**: Returns `baseline_chain_canonical_violation` status
- **Surfaced**: Admin dashboard shows health status

### Secondary: Regression Test Suite
- **File**: `src/lib/__tests__/extractionStateMachine.test.ts`
- **Test**: "Test M: Baseline Chain Canonical Regression Guard"
- **Command**: `npx vitest run`
- **Blocks**: Must pass before any orchestration code changes

### Enforcement Rules
1. Edge function deploy triggers automatic self-test
2. Any `baseline_chain_canonical_violation` blocks the feature from working
3. Regression tests must pass locally before modifying chain logic
4. This document MUST be consulted before any orchestration fix

---

## Last Known Working State

**Date Verified**: 2026-01-11  
**Provider Chain Order**: Browserless → Zyte → Firecrawl  
**Success Criterion**: `status === 'total_price_including_taxes_and_fees'`

---

## Provider Chain Order

The Airbnb baseline extraction uses a strict provider chain:

```
┌─────────────────────────────────────────────────────────────┐
│                 BASELINE CHAIN ORCHESTRATION                 │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  STEP 1: BROWSERLESS (Primary)                              │
│  ├── Attempt extraction via Browserless headless browser    │
│  ├── If status = total_price_including_taxes_and_fees       │
│  │   └── STOP: Use Browserless result (verified)            │
│  └── Else: Continue to Step 2                               │
│                                                              │
│  STEP 2: ZYTE (First Fallback)                              │
│  ├── Attempt extraction via Zyte API                        │
│  ├── If status = total_price_including_taxes_and_fees       │
│  │   └── STOP: Use Zyte result (verified)                   │
│  └── Else: Continue to Step 3                               │
│                                                              │
│  STEP 3: FIRECRAWL (Second Fallback)                        │
│  ├── Attempt extraction via Firecrawl API                   │
│  ├── If status = total_price_including_taxes_and_fees       │
│  │   └── STOP: Use Firecrawl result (verified)              │
│  └── Else: Return final non-verified status                 │
│                                                              │
│  FINAL STATUS DETERMINATION:                                 │
│  ├── If any provider returned verified → Use that result    │
│  ├── If all subtotal-only → needs_user_confirmation         │
│  ├── If all failed → Most specific terminal status          │
│  └── NEVER promote subtotal to verified total               │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## Success Criterion

A provider result is considered **verified** when:
```typescript
status === 'total_price_including_taxes_and_fees'
```

Any other status triggers fallback to the next provider.

---

## Failure vs "Try Next Provider"

### Statuses that trigger fallback:
- `needs_user_confirmation` (subtotal only)
- `price_not_available_in_content`
- `blocked_captcha_or_bot`
- `rate_limited`
- `provider_error`
- `provider_timeout`
- `provider_not_configured`

### Statuses that STOP the chain (success):
- `total_price_including_taxes_and_fees` (verified total)

---

## Invariant Rules (MUST Always Hold)

### 1. Subtotal Never Promoted to Verified Total
```typescript
// INVARIANT: Even if all providers return subtotals, 
// the final status must NOT be verified
if (allProvidersReturnedSubtotalOnly) {
  finalStatus = 'needs_user_confirmation';
  // NOT 'total_price_including_taxes_and_fees'
}
```

### 2. Browserless Verified → No Fallback
```typescript
// INVARIANT: If Browserless returns verified, chain stops
if (browserlessResult.status === 'total_price_including_taxes_and_fees') {
  // Zyte and Firecrawl must NOT be called
  return browserlessResult;
}
```

### 3. Zyte Only When Browserless Not Verified
```typescript
// INVARIANT: Zyte is only attempted after Browserless failure
if (browserlessResult.status !== 'total_price_including_taxes_and_fees') {
  // Now try Zyte
}
```

### 4. Firecrawl Only When Both Previous Not Verified
```typescript
// INVARIANT: Firecrawl is only attempted after both fail
if (browserlessResult.status !== 'total_price_including_taxes_and_fees' &&
    zyteResult.status !== 'total_price_including_taxes_and_fees') {
  // Now try Firecrawl
}
```

### 5. First Verified Wins
```typescript
// INVARIANT: The first verified result in the chain is the final result
// Order: Browserless → Zyte → Firecrawl
```

### 6. Explicit Final Status When None Verified
```typescript
// INVARIANT: If no provider returns verified, final status must be explicit
// Possible values: needs_user_confirmation, blocked_captcha_or_bot, 
//                  price_not_available_in_content, provider_error
```

### 7. Currency Normalisation Consistent
```typescript
// INVARIANT: All providers normalize currency the same way
// $1,658.94 → 1658.94 (USD)
// CHF 2,500.00 → 2500.00 (CHF)
// £999.99 → 999.99 (GBP)
// €1234.56 → 1234.56 (EUR)
```

---

## Protected Invariants (Regression Tests)

These invariants are protected by `src/lib/__tests__/extractionStateMachine.test.ts`:

1. **browserless_wins_when_verified**: Browserless verified → chain stops, result used
2. **zyte_used_when_browserless_not_verified**: Browserless fails → Zyte attempted
3. **firecrawl_used_when_both_not_verified**: Both fail → Firecrawl attempted
4. **subtotal_never_promoted_across_chain**: All subtotals → non-verified final
5. **currency_normalisation_consistent**: Same normalization across all providers

---

## Comparison Workflow

When chain orchestration fails unexpectedly, follow this mandatory workflow:

### Step 1: Identify Which Invariant Broke
- [ ] Did Browserless verified result get ignored?
- [ ] Did Zyte run when Browserless was verified?
- [ ] Did Firecrawl run when Zyte was verified?
- [ ] Was subtotal promoted to verified?
- [ ] Was currency normalized inconsistently?

### Step 2: Compare Against Canonical State
| Rule | Expected | Actual |
|------|----------|--------|
| Browserless verified → stop | ✓ | |
| Zyte only after Browserless fails | ✓ | |
| Firecrawl only after both fail | ✓ | |
| Subtotal never promoted | ✓ | |
| First verified wins | ✓ | |

### Step 3: Document Delta Before Fix
Before changing anything, write down:
1. What differs from canonical behaviour?
2. Why did this difference occur?
3. Does the fix restore canonical behaviour or intentionally change it?

---

## Code Location Reference

| Component | File | Key Function |
|-----------|------|--------------|
| Chain orchestration | `search-alternatives/index.ts` | Main extraction flow |
| Browserless extraction | `airbnb-selftest/index.ts` | runBrowserlessBookStays |
| Regression tests | `extractionStateMachine.test.ts` | Test M |

---

## History

| Date | Event | Notes |
|------|-------|-------|
| 2026-01-11 | Baseline established | Chain order and invariants documented |
| 2026-01-11 | Enforcement implemented | Runtime self-test + regression guard |

---

## Future-Proofing

This enforcement mechanism remains valid when:

1. **CI is added later**: Regression tests become part of CI pipeline
2. **New providers added**: Chain logic must be updated, tests extended
3. **Orchestration evolves**: Any change that breaks canonical checks is immediately visible

---

*This baseline is the canonical reference point. Future fixes MUST compare against it first.*
