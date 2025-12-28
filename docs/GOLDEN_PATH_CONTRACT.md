# Golden Path Contract

**Version**: 1.0  
**Last Updated**: 2025-12-27  
**Status**: PROVEN

## Core Requirement

> Given an Airbnb stay with dates, reliably apply those exact dates on matching listings across other platforms and extract real, comparable total stay prices, or explicitly explain why that is not possible, fully automatically.

## Proven Reference Implementation: Hotels.com

Hotels.com has been validated as the **reference golden path** with the following proven properties:

| Property | Status | Evidence |
|----------|--------|----------|
| Date Application | ✅ URL parameters | `chkin`, `chkout` params work |
| Price Visibility | ✅ Pre-payment | Total prices visible before reserve flow |
| Content Verification | ✅ Verbatim | "The price is $175 total" in content |
| Determinism | ✅ 100% | 3/3 runs identical ($175, hash `601625a2`) |
| Retries Required | ❌ None | First attempt success |
| Zyte Escalation | ❌ Not needed | Firecrawl alone sufficient |
| Hallucination Guard | ✅ Passed | All prices verified against content |

---

## Required Platform Properties

A platform can only be considered **supported** if ALL of the following are true:

### 1. Dates Can Be Applied Deterministically

- URL parameters OR minimal navigation applies dates
- Page leaves "enter dates" state reliably
- Detected check-in/check-out match requested dates

### 2. Total Stay Prices Are Visible Pre-Payment

- Total price (not just nightly) is displayed
- No "reserve" or "book" flow required to see price
- No room selection required to see price

### 3. Prices Appear Verbatim in Captured Content

- Extracted price matches exact string in markdown/HTML
- No AI inference or estimation
- Evidence snippet contains the extracted value

### 4. Pricing Is Stable Enough to Pass Repeatability Tests

- 3 consecutive runs produce consistent results
- If prices differ, content hashes must also differ (real dynamic pricing)
- No unexplained extraction failures

---

## Required Pipeline Guarantees

### No Price Without Date Validation

```
Phase A MUST pass before Phase B runs.
If dates are not validated, return explicit failure status.
```

### No Price Without Content Verification

```
Extracted price MUST appear verbatim in captured content.
If price cannot be verified, return price_not_found.
```

### No Silent Failure

```
Every extraction attempt MUST end in a terminal status:
- success
- dates_not_applied
- no_availability_for_dates
- sold_out
- blocked_captcha_or_bot
- price_not_found
- render_failed
- validation_error
```

### Explicit Terminal Status for Every Attempt

```
Status must be written to database.
No extraction may remain in "pending" state.
Error field must explain the failure.
```

---

## Platform Classification System

When testing a new platform, classify it into exactly ONE category:

| Classification | Description | Support Status |
|----------------|-------------|----------------|
| **A** | Prices visible and extractable pre-payment | ✅ Supported |
| **B** | Prices only visible after reserve/room selection | ❌ Not Supported |
| **C** | Dates cannot be applied reliably | ❌ Not Supported |
| **D** | Bot/anti-automation blocking | ❌ Not Supported |

### Classification Evidence Requirements

Each classification must include:
- Verbatim evidence snippets
- Content hash before/after navigation
- Date application state confirmation
- Strategy used (URL_PARAMS, FIRECRAWL_ACTIONS, ZYTE_BROWSER)

---

## Expansion Protocol

When adding a new platform:

1. **Run Diagnostic** - Use existing diagnostic framework (see `hotelscom-diagnostic`)
2. **Classify A/B/C/D** - With evidence
3. **Repeatability Test** - 3 consecutive runs if Classification A
4. **Lock Adapter** - Update `platform_adapters` with proven settings
5. **Create Production Extractor** - Only if Classification A and repeatability passes

### Expansion Blockers

Do NOT expand to a new platform if:
- Reference implementation (Hotels.com) is unstable
- No clear Classification A evidence
- Hallucination guard cannot be satisfied
- Payment/reserve flow required for prices

---

## Current Platform Status

| Platform | Classification | Status | Notes |
|----------|---------------|--------|-------|
| **Hotels.com** | A | ✅ **REFERENCE** | Golden path proven, 3/3 runs |
| **Expedia** | A | ✅ **PROVEN** | 3/3 runs ($630, hash `631f3b1a`) |
| Booking.com | B | ❌ Unsupported | Prices require reserve flow |
| Agoda | C | ❌ Unsupported | Prices not exposed pre-interaction |
| Vrbo | D | ❌ NO-GO | 403 blocked by Firecrawl+Zyte, first fail: render_failed |

---

## Implementation Files

| Component | File | Purpose |
|-----------|------|---------|
| Reference Extractor | `supabase/functions/extract-hotelscom/index.ts` | Production Hotels.com extraction |
| Diagnostic | `supabase/functions/hotelscom-diagnostic/index.ts` | Testing & repeatability |
| Adapter Config | `platform_adapters` table | Platform-specific settings |
| Pipeline Worker | `supabase/functions/process-platform-extraction/index.ts` | Multi-platform orchestration |

---

## Failure Mode Documentation

### Acceptable Failures (Explicit & Evidence-Backed)

- `sold_out` - Property not available for dates (evidence: "Sold out" in content)
- `no_availability_for_dates` - Platform shows unavailable (evidence: explicit unavailability message)
- `blocked_captcha_or_bot` - Anti-automation (evidence: CAPTCHA/block message)
- `dates_not_applied` - URL params didn't work (evidence: "enter dates" still present)

### Unacceptable Failures (Must Be Eliminated)

- Silent pending status
- Price without content verification
- AI-inferred prices without verbatim match
- Extraction without Phase A validation

---

## Contract Enforcement

This contract is enforced by:

1. **Hallucination Guard** - Prices must be verified against captured content
2. **Phase Sequencing** - Phase B only runs after Phase A success
3. **Terminal Status Requirement** - All paths lead to explicit status
4. **Evidence Storage** - All extractions store evidence snippets and content hashes

Any violation of this contract should be treated as a system bug, not a platform limitation.
