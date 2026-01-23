# VRBO Price Extraction Working Baseline

**Baseline Identifier:** `vrbo-price-extraction-golden-path-v1`  
**Version:** 1.0.0  
**Locked:** 2026-01-23  
**Status:** WORKING

---

## Purpose

This document freezes the proven VRBO extraction behavior as an authoritative, restorable baseline. Any deviation from this behavior constitutes a regression requiring investigation.

---

## Preconditions

1. **Entry URL:** VRBO property page (e.g., `https://www.vrbo.com/9836046ha`)
2. **Provider:** Zyte-first (Browserless captcha-blocked; Firecrawl quota/credits)
3. **Platform Configuration:**
   - `platform_adapters.coverage_tier = 'A'`
   - `platform_adapters.dedicated_extractor = 'extract-vrbo'`
   - `platform_adapters.retry_policy = 'standard'`
4. **Golden Path Routing:**
   - `GOLDEN_PATH_PLATFORMS` includes `'vrbo.com': 'extract-vrbo'`
   - `getDedicatedExtractor()` returns `'extract-vrbo'` for any platform containing "vrbo"
5. **Required Parameters:**
   - `checkIn` (YYYY-MM-DD format)
   - `checkOut` (YYYY-MM-DD format)
   - `guests` (integer, typically 2)

---

## Golden Path Steps

### Step 1: Construct Dated Property URL
```
https://www.vrbo.com/{propertyId}?chkin={checkIn}&chkout={checkOut}&x_pwa=1&rfrr=HSR&pwa_ts=...&regionId=...&destination=...&destType=MARKET&latLong=...&semdtl=&sort=RECOMMENDED&top_dp=...&top_cur=USD&userIntent=&expediaPropertyId=...&semcid=...&hgRecSortModel=...&selectedRoomType=...&selectedRatePlan=...&searchId=...
```

### Step 2: Zyte BrowserActions Request
- Use Zyte `/browser/html` endpoint with `browserActions`
- Action: Click "Begin booking" / "Reserve" button
- Wait for checkout drawer/page to load

### Step 3: Navigate to Checkout Session
- Automatic navigation after button click
- Final URL pattern: Contains checkout/booking session indicators

### Step 4: Extract Total Price
From checkout page content, look for:
- "Trip total" label
- "Total" with currency amount
- Pattern: `$X,XXX.XX` following total label

---

## Success Criteria

A VRBO extraction is considered successful if and only if ALL of the following are true:

| Criterion | Expected Value |
|-----------|----------------|
| `status` | `success_total_stay` |
| `extractedPrice` | Numeric value > 0 |
| `currency` | `USD` (or detected currency) |
| `includesTaxesFees` | `true` |
| `directlyComparable` | `true` |
| `structuralProof.checkout_session_reached` | `true` |
| `structuralProof.total_label_found` | `true` |
| `structuralProof.dates_visible_on_page` | `true` |
| `goldenPath` | `true` |
| `datesValidated` | `true` |
| `price_type` | `TOTAL_STAY` |
| `confidence_score` | `90` |

### Example Successful Extraction

```json
{
  "success": true,
  "status": "success_total_stay",
  "extractedPrice": 2167.40,
  "currency": "USD",
  "includesTaxesFees": true,
  "directlyComparable": true,
  "goldenPath": true,
  "structuralProof": {
    "property_page_reached": true,
    "checkout_session_reached": true,
    "dates_injected": true,
    "dates_visible_on_page": true,
    "total_label_found": true,
    "nightly_rate_found": true,
    "subtotal_found": true,
    "taxes_visible": true,
    "directly_comparable": true,
    "currency_detected": "USD",
    "nights_detected": 5,
    "failure_category": "success",
    "extraction_method": "zyte-click-checkout",
    "competing_amounts": {
      "nightlyRate": 398.08,
      "subtotal": 1990.40,
      "taxesAmount": 177.00
    }
  }
}
```

### Price Calculation Validation
- Nightly rate × nights = subtotal: `$398.08 × 5 = $1,990.40`
- Subtotal + taxes = total: `$1,990.40 + $177.00 = $2,167.40`

---

## Database Persistence

Upon successful extraction, the following fields MUST be set in `price_extractions`:

| Field | Value |
|-------|-------|
| `extraction_status` | `success_total_stay` |
| `extracted_price` | Total amount (e.g., `2167.40`) |
| `currency` | Detected currency (e.g., `USD`) |
| `includes_taxes_fees` | `true` |
| `dates_validated` | `true` |
| `detected_checkin` | Check-in date |
| `detected_checkout` | Check-out date |
| `price_type` | `TOTAL_STAY` |
| `confidence_score` | `90` |
| `provider_used` | `zyte` |
| `extraction_metadata.verification` | `VERIFIED` |
| `extraction_metadata.goldenPath` | `true` |
| `extraction_metadata.structuralProof.checkout_session_reached` | `true` |

---

## UI Behavior

When VRBO extraction succeeds:

1. **Result Inclusion:** VRBO appears in `final_results_snapshot`
2. **Bucket Classification:** Classified as `cheaper` or `more_expensive` (never `additional_issues`)
3. **Verification Badge:** Shows "Verified" status with 90%+ confidence
4. **Price Display:** Shows extracted total price with currency symbol
5. **Comparison:** Included in savings calculation against Airbnb baseline

---

## Terminal Statuses

| Status | Meaning |
|--------|---------|
| `success_total_stay` | ✅ Full success - total with taxes extracted |
| `dates_unavailable` | Property not available for requested dates |
| `blocked_captcha_or_bot` | Zyte blocked by captcha |
| `blocked_rate_limit` | Provider rate limited |
| `checkout_not_reached` | Could not navigate to checkout page |
| `total_price_not_found` | Reached checkout but no total label found |
| `nightly_only_rejected` | Only nightly rate found, no total |
| `render_failed` | Page render failure |
| `timeout` | Request exceeded timeout |

---

## Explicit Non-Goals

This baseline does NOT cover:

1. **Async pricing** - No background refresh or delayed extraction
2. **Partial totals** - Subtotals without taxes are rejected
3. **Nightly prices** - Per-night rates are not persisted as final prices
4. **Deposit amounts** - "Due now" amounts are not used as total
5. **Alternative providers** - Browserless and Firecrawl are not used for VRBO
6. **Live-check/probe modes** - No speculative access validation

---

## Safeguard Assertions

### Invariant 1: Snapshot Inclusion
If `extract-vrbo` returns `status = success_total_stay`, the result MUST be included in `final_results_snapshot` with a non-null `final_bucket`.

### Invariant 2: UI Rendering
A successful VRBO extraction MUST appear in the search results UI in either the "cheaper" or "more_expensive" bucket, never in "additional_issues" or "Outcome not classified".

### Invariant 3: No Silent Drops
Failure to classify a `success_total_stay` VRBO result MUST throw a loud error or log a critical warning. Silent drops are forbidden.

---

## Related Files

| File | Purpose |
|------|---------|
| `supabase/functions/extract-vrbo/index.ts` | Dedicated VRBO extractor |
| `supabase/functions/process-platform-extraction/index.ts` | Routing logic with `GOLDEN_PATH_PLATFORMS` |
| `supabase/functions/_shared/buildFinalSnapshot.ts` | Snapshot construction |
| `src/lib/baselineExpectations.ts` | Baseline registration |
| `src/lib/canonicalPrice.ts` | Price type classification |

---

## Restore Instructions

To restore this baseline:

1. Verify `platform_adapters` configuration matches preconditions
2. Verify `GOLDEN_PATH_PLATFORMS` includes `vrbo.com`
3. Verify `extract-vrbo` is deployed with Zyte-first flow
4. Run regression test with known VRBO property
5. Confirm `success_total_stay` status and correct bucket classification
