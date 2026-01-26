# Booking.com Price Extraction Working Baseline

**Baseline Identifier:** `booking-price-extraction-golden-path-v1`  
**Version:** 1.0.0  
**Locked:** 2026-01-26  
**Status:** WORKING

---

## Purpose

This document freezes the proven Booking.com extraction behavior as an authoritative, restorable baseline. Any deviation from this behavior constitutes a regression requiring investigation.

---

## Preconditions

1. **Entry URL:** Booking.com property page (e.g., `https://www.booking.com/hotel/us/example-property.html`)
2. **Provider Priority:** Firecrawl (primary) → Zyte (fallback) → Browserless (last resort)
3. **Platform Configuration:**
   - `platform_adapters.coverage_tier = 'A'`
   - `platform_adapters.dedicated_extractor = 'extract-booking'`
   - `platform_adapters.retry_policy = 'standard'`
4. **Golden Path Routing:**
   - `GOLDEN_PATH_PLATFORMS` includes `'booking.com': 'extract-booking'`
   - `getDedicatedExtractor()` returns `'extract-booking'` for any platform containing "booking"
5. **Required Parameters:**
   - `checkIn` (YYYY-MM-DD format)
   - `checkOut` (YYYY-MM-DD format)
   - `adults` (integer, default 2)

---

## Golden Path Steps

### Step 1: Construct Dated Property URL
```
https://www.booking.com/hotel/{region}/{property-slug}.html?checkin={checkIn}&checkout={checkOut}&group_adults={adults}&no_rooms=1&selected_currency=USD
```

### Step 2: Provider Cascade
1. **Firecrawl (Primary):** Call `/v1/scrape` with markdown format, 8s waitFor, US location
2. **Zyte (Fallback):** Call `/v1/extract` with browserHtml, JavaScript enabled, US geolocation
3. **Browserless (Last Resort):** Call `/content` with stealth mode, networkidle0

### Step 3: Content Validation
- Minimum 3000 chars for Firecrawl, 5000 chars for Zyte/Browserless
- Bot block detection (captcha, unusual traffic, access denied)
- Availability classification (sold_out signals)

### Step 4: VAT Exclusion Detection
If content contains "Excluded: X% VAT" or similar:
- Trigger checkout navigation via Browserless `/function`
- Navigate through room selection → reserve button → checkout page
- Extract total from checkout page (includes VAT)

### Step 5: Price Extraction with Structural Proof
From page content, extract:
- Breakdown container patterns (price breakdown, booking summary)
- Total label patterns (grand total, amount due, you pay)
- Price with nights context (`$X for N nights`)

---

## TOTAL_PROVEN Gate

A Booking.com price is considered TOTAL_PROVEN if and only if ALL of the following core checks pass:

| Core Check | Description |
|------------|-------------|
| `breakdown_found` | Breakdown container detected on page |
| `total_label_found` | Total/Grand Total/Amount Due label found |
| `extracted_from_breakdown_total` | Price extracted from breakdown context |
| `dates_validated` | Requested check-in/check-out visible on page |

### Additional Checks (Non-Blocking)
| Check | Description |
|-------|-------------|
| `nightsMatched` | Nights count matches requested duration |
| `includesTaxesFees` | Taxes/fees confirmed included |

---

## Success Criteria

A Booking.com extraction is considered successful if and only if ALL of the following are true:

| Criterion | Expected Value |
|-----------|----------------|
| `status` | `success_total_stay` |
| `extractedPrice` | Numeric value > 0 |
| `currency` | `USD` (or detected currency) |
| `includesTaxesFees` | `true` |
| `totalProven` | `true` |
| `structuralProof.breakdown_found` | `true` |
| `structuralProof.total_label_found` | `true` |
| `structuralProof.extracted_from_breakdown_total` | `true` |
| `datesValidated` | `true` |
| `price_type` | `TOTAL_STAY` |

### Example Successful Extraction

```json
{
  "success": true,
  "status": "success_total_stay",
  "extractedPrice": 265.72,
  "currency": "USD",
  "includesTaxesFees": true,
  "totalProven": true,
  "providerUsed": "firecrawl",
  "structuralProof": {
    "breakdown_found": true,
    "total_label_found": true,
    "extracted_from_breakdown_total": true
  },
  "datesValidated": true,
  "nightsMatched": true,
  "failedChecks": []
}
```

---

## Terminal Status Mapping

| Status | Bucket | Meaning |
|--------|--------|---------|
| `success_total_stay` | `cheaper` / `more_expensive` | ✅ Full success - total with taxes extracted and TOTAL_PROVEN |
| `unverified` | `not_comparable` | Price found but TOTAL_PROVEN=false or taxes not confirmed |
| `dates_unavailable` | `sold_out` | Property not available for requested dates |
| `blocked_captcha_or_bot` | `blocked` | Bot detection triggered |
| `blocked_rate_limit` | `blocked` | Provider rate limited |
| `page_not_reached` | `blocked` | Could not reach property page |
| `price_not_found` | `price_not_found` | Reached page but no total found |
| `render_failed` | `service_error` | Page render failure |
| `timeout` | `service_error` | Request exceeded timeout |
| `validation_error` | `service_error` | Missing required parameters |

---

## Database Persistence

Upon successful extraction, the following fields MUST be set in `price_extractions`:

| Field | Value |
|-------|-------|
| `extraction_status` | `success_total_stay` |
| `extracted_price` | Total amount (e.g., `265.72`) |
| `currency` | Detected currency (e.g., `USD`) |
| `includes_taxes_fees` | `true` |
| `dates_validated` | `true` |
| `detected_checkin` | Check-in date |
| `detected_checkout` | Check-out date |
| `price_type` | `TOTAL_STAY` |
| `provider_used` | `firecrawl` / `zyte` / `browserless` |
| `extraction_metadata.totalProven` | `true` |
| `extraction_metadata.structuralProof.breakdown_found` | `true` |
| `extraction_metadata.structuralProof.total_label_found` | `true` |
| `extraction_metadata.structuralProof.extracted_from_breakdown_total` | `true` |

---

## UI Behavior

When Booking.com extraction succeeds:

1. **Result Inclusion:** Booking.com appears in `final_results_snapshot`
2. **Bucket Classification:** Classified as `cheaper` or `more_expensive` (never `additional_issues`)
3. **Verification Badge:** Shows "Verified" status when TOTAL_PROVEN
4. **Price Display:** Shows extracted total price with currency symbol
5. **Comparison:** Included in savings calculation against Airbnb baseline

---

## Explicit Non-Goals

This baseline does NOT cover:

1. **Partial totals** - Prices without taxes are marked `unverified` and bucketed as `not_comparable`
2. **Nightly prices** - Per-night rates are not persisted as final prices
3. **VAT-excluded prices** - If checkout navigation fails, result is marked `unverified`
4. **Alternative currencies** - Non-USD prices go to `not_comparable`
5. **Deposit amounts** - "Due now" amounts are not used as total
6. **Live-check/probe modes** - No speculative access validation

---

## Safeguard Assertions

### Invariant 1: TOTAL_PROVEN Requirement
`extract-booking` MUST only return `success_total_stay` when TOTAL_PROVEN=true.

If TOTAL_PROVEN=false, status MUST be `unverified` (maps to `not_comparable` bucket).

### Invariant 2: Snapshot Inclusion
If `extract-booking` returns `status = success_total_stay`, the result MUST be included in `final_results_snapshot` with a non-null `final_bucket`.

### Invariant 3: UI Rendering
A successful Booking.com extraction MUST appear in the search results UI in either the "cheaper" or "more_expensive" bucket, never in "additional_issues" or "Outcome not classified".

### Invariant 4: No Silent Drops
Failure to classify a `success_total_stay` Booking.com result MUST throw a loud error or log a critical warning. Silent drops are forbidden.

### Invariant 5: VAT Handling
If VAT exclusion is detected but checkout navigation fails:
- `includesTaxesFees` MUST be `false`
- `status` MUST be `unverified`
- Result MUST be bucketed as `not_comparable`

---

## Checkout Navigation (VAT Recovery)

When VAT exclusion is detected on the property page:

### Steps
1. Use Browserless `/function` endpoint with ESM function code
2. Select room quantity (1 room)
3. Click "I'll reserve" / "Book" button
4. Wait for checkout page navigation
5. Extract total from checkout summary

### Success Criteria
- `checkoutReached` = true (URL contains `book.html`, `checkout`, `yourdetails`, or `secure`)
- `totalPrice` extracted from checkout page
- All structural proof set to `true`

### Fallback
If checkout navigation fails, fall back to standard extraction but mark:
- `includesTaxesFees` = `false`
- `status` = `unverified`
- Add `vat_excluded_checkout_failed` to `failedChecks`

---

## Related Files

| File | Purpose |
|------|---------|
| `supabase/functions/extract-booking/index.ts` | Dedicated Booking.com extractor |
| `supabase/functions/process-platform-extraction/index.ts` | Routing logic with `GOLDEN_PATH_PLATFORMS` |
| `supabase/functions/_shared/buildFinalSnapshot.ts` | Snapshot construction with safeguard assertion |
| `src/lib/baselineExpectations.ts` | Baseline registration |
| `src/lib/canonicalPrice.ts` | Price type classification |

---

## Restore Instructions

To restore this baseline:

1. Verify `platform_adapters` configuration matches preconditions
2. Verify `GOLDEN_PATH_PLATFORMS` includes `booking.com`
3. Verify `extract-booking` is deployed with Firecrawl-first flow
4. Run regression test with known Booking.com property
5. Confirm `success_total_stay` status and correct bucket classification
6. Verify TOTAL_PROVEN gate is enforced (4 core checks)
