# Extraction State Machine - Canonical Definition

**Version**: 1.0.0  
**Last Updated**: 2026-01-04  
**Scope**: Airbnb baseline + Expedia alternative

This document defines the **single source of truth** for extraction outcome states. Both Admin Diagnostics and Frontend must use this state machine identically.

---

## Canonical Outcome States

### SUCCESS_VERIFIED
**Definition**: Extraction succeeded with complete structural proof.

| Field | Required Value |
|-------|----------------|
| `extraction_status` | `'success'` |
| `dates_validated` | `true` |
| `includes_taxes_fees` | `true` |
| `confidence_score` | `>= 0.5` |
| `extraction_metadata.breakdown_found` | `true` |
| `extraction_metadata.total_label_found` | `true` |
| `extraction_metadata.rendered_dates_match` | `true` |
| `extraction_metadata.extracted_from_breakdown_total` | `true` |

**Frontend Behavior**:
- Displayed as "Verified" with green checkmark badge
- Eligible for savings calculation and "Best Deal" badge
- Grouped under "Verified alternatives"

---

### SUCCESS_UNVERIFIED
**Definition**: Extraction returned a price, but structural verification failed.

| Field | Required Value |
|-------|----------------|
| `extraction_status` | `'success'` |
| `extracted_price` | `> 0` |
| `verification_failures` | Non-empty array with reasons |

**Required Metadata**:
- `missing_proof_reasons`: Array of specific failure reasons from `verifyStructuralTotal()`

**Frontend Behavior**:
- Displayed as "Unverified" with amber warning badge
- Shows concise reason derived from `verification_failures[0]`
- NOT eligible for savings calculations
- Grouped under "Price fetched (unverified)"
- Shows "Manual check recommended"

---

### TERMINAL_DATES_UNAVAILABLE
**Definition**: Property exists but is not available for the requested dates.

**Triggering Statuses**:
- `dates_unavailable`
- `expedia_dates_unavailable_for_target`
- `no_availability_for_dates`
- `sold_out`

**Frontend Behavior**:
- Shows `TerminalErrorPanel` with type `dates_unavailable`
- Message: "Dates Not Available"
- Tips: Change dates, check listing directly
- Does NOT show "No Alternative Listings Found"

---

### TERMINAL_ACCESS_ABORTED
**Definition**: Platform blocked access due to rate limiting or bot detection. Pipeline stopped.

**Triggering Statuses**:
- `rate_limited` / `blocked_rate_limit` / `rate_limited_abort`
- `bot_detected` / `blocked_captcha_or_bot` / `bot_blocked_abort`
- `expedia_access_blocked`

**Frontend Behavior**:
- Shows `TerminalErrorPanel` with type `rate_limited` or `bot_detected`
- Message: "Rate Limit Reached" or "Access Blocked"
- Tips: Wait 10-15 minutes, view directly on platform
- Does NOT show "No price" messaging

---

### TERMINAL_EXTRACTION_FAILED
**Definition**: Attempted extraction but could not extract any price candidate.

**Triggering Statuses**:
- `render_failed`
- `price_not_found` / `price_not_found_after_dates_applied`
- `expedia_target_offer_not_found`
- `expedia_target_offer_mismatch`
- `expedia_target_total_not_found`
- `expedia_offers_page_not_reached`
- `expedia_total_not_found_on_offers_page`
- `property_id_not_found`
- `validation_error` / `extraction_error`

**Frontend Behavior**:
- Grouped under "Extraction failed"
- Shows reason: "Page failed to load", "Price not visible", etc.
- Triggers manual override when appropriate (if Airbnb baseline succeeded)
- Photo comparison button available

---

### TERMINAL_NOT_ATTEMPTED
**Definition**: Platform was skipped due to orchestration routing (e.g., Tier C blocked).

**Triggering Statuses**:
- `platform_unsupported`
- Coverage tier = 'C'

**Frontend Behavior**:
- Grouped under "Blocked by platform"
- Shows "Platform not supported" with explicit reason
- Does NOT silently collapse into "No Alternative Listings Found"
- Photo comparison button available if images exist

---

## Critical Invariants

1. **No Silent Suppression**: Every outcome MUST be explicitly surfaced in the UI. A platform cannot silently disappear.

2. **No "No Price" Collapse**: Terminal states MUST NOT be collapsed into generic "no price" messaging. Each state has its own TerminalErrorPanel or grouping.

3. **Explicit Diagnostics**: `TERMINAL_NOT_ATTEMPTED` must include `failure_reason` explaining why the platform was skipped.

4. **Structural Proof Required**: A price can ONLY be `SUCCESS_VERIFIED` if all 4 structural proof flags are `true`. This is enforced in `src/lib/priceVerification.ts`.

---

## State Mapping Table

| Backend Status | Canonical State | Frontend UI Behavior |
|----------------|-----------------|---------------------|
| `success` + all structural proof | `SUCCESS_VERIFIED` | ✓ Verified badge, savings eligible |
| `success` + missing proof | `SUCCESS_UNVERIFIED` | ⚠ Unverified badge, reason shown |
| `dates_unavailable` | `TERMINAL_DATES_UNAVAILABLE` | TerminalErrorPanel: Dates Not Available |
| `expedia_dates_unavailable_for_target` | `TERMINAL_DATES_UNAVAILABLE` | TerminalErrorPanel: Dates Not Available |
| `rate_limited` / `blocked_rate_limit` | `TERMINAL_ACCESS_ABORTED` | TerminalErrorPanel: Rate Limited |
| `blocked_captcha_or_bot` / `bot_blocked_abort` | `TERMINAL_ACCESS_ABORTED` | TerminalErrorPanel: Access Blocked |
| `expedia_access_blocked` | `TERMINAL_ACCESS_ABORTED` | TerminalErrorPanel: Expedia Access Blocked |
| `render_failed` | `TERMINAL_EXTRACTION_FAILED` | Grouped: Extraction failed |
| `price_not_found` | `TERMINAL_EXTRACTION_FAILED` | Grouped: Price not visible |
| `expedia_target_offer_not_found` | `TERMINAL_EXTRACTION_FAILED` | Grouped: Property not found on Expedia |
| `platform_unsupported` | `TERMINAL_NOT_ATTEMPTED` | Grouped: Platform not supported |

---

## Implementation Files

| Component | File Path |
|-----------|-----------|
| Price Verification (SSOT) | `src/lib/priceVerification.ts` |
| Frontend State Enrichment | `src/hooks/useEnrichedSearchResults.ts` |
| Frontend Results Display | `src/pages/SearchResults.tsx` |
| Terminal Error Panel | `src/components/TerminalErrorPanel.tsx` |
| Expedia Extractor | `supabase/functions/extract-expedia/index.ts` |
| Platform Worker | `supabase/functions/process-platform-extraction/index.ts` |
| Search Orchestration | `supabase/functions/search-alternatives/index.ts` |

---

## Manual Override Modal Rule

The `AirbnbTotalConfirmationModal` must appear **if and only if**:

1. Airbnb baseline **succeeded** or produced a clear abort state (rate limit/bot block with no price), AND
2. The alternative provider(s) either:
   - Failed to extract any candidate, OR
   - Returned unverified prices AND the product requires manual confirmation

The modal must **NOT** appear when:
- A verified alternative exists
- The search status is a terminal error (dates_unavailable, rate_limited, bot_detected)
- The Airbnb baseline has a valid `airbnb_price > 0`

**Implementation**: See `SearchResults.tsx` lines 1669-1682 and 1684-1726.

---

## Telemetry Alignment

For frontend-initiated runs, the following must be persisted and visible in Admin Diagnostics:

| Field | Table | Purpose |
|-------|-------|---------|
| `extraction_metadata.goldenPath` | `price_extractions` | Expedia golden path proof |
| `extraction_metadata.structuralProof` | `price_extractions` | Structural verification flags |
| `extraction_metadata.providerAttemptTrace` | `price_extractions` | Provider fallback chain |
| `extraction_status` | `price_extractions` | Terminal status |
| `extraction_error` | `price_extractions` | Error message |
| `confidence_score` | `price_extractions` | Extraction confidence |

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-01-04 | Initial canonical definition |
