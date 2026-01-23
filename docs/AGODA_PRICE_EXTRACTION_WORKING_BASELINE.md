# Agoda Price Extraction Working Baseline

## Current Active Baseline: `agoda-price-extraction-golden-path-v1`

**Version:** 1.0.0  
**Declared:** 2026-01-23  
**Declared By:** user-declared  
**Status:** LOCKED - Do not modify without explicit baseline update

---

## Baseline Identity

| Field | Value |
|-------|-------|
| **Name** | `agoda-price-extraction-golden-path-v1` |
| **Version** | `1.0.0` |
| **Previous** | N/A (initial baseline) |

## Purpose

This baseline captures the **correct, validated behavior** of the Agoda price extraction system. It serves as a reference point for future changes and a safe revert target if regressions occur.

## Core Logic (DO NOT MODIFY)

### Golden Path Flow (v3.1)

The Agoda extractor implements a multi-phase discovery workflow optimized for reliability:

| Phase | Name | Action | Status |
|-------|------|--------|--------|
| **Phase 1** | Hotel Page Fetch | Fetch hotel page with date/occupancy params | ✅ Active |
| **Phase 2** | Static Checkout Discovery | Look for static `/book/` link on hotel page | ✅ Active |
| **Phase 2B** | Search Page Workflow | Fetch search page with `selectedproperty` param | ✅ Active |
| **Phase 2B-5** | Search Page Click | Browserless click on search page | ⛔ **SKIPPED** |
| **Phase 2C** | Hotel Page Click | Browserless `/function` API click on hotel page | ✅ **PRIMARY** |
| **Phase 4** | Hotel Page Fallback | Extract from hotel page if no checkout | ✅ Fallback |

### Critical Optimization (v1.0.0)

**Phase 2B-5 (Search Page Click) is intentionally SKIPPED** because:
1. Search page clicks are slow (~30s) and often timeout
2. Search page clicks frequently redirect to another search page, not checkout
3. Hotel page clicks (Phase 2C) reliably discover the encrypted checkout URL
4. This optimization reduces extraction time from timeout to ~20s

### Extraction Method

| Step | Description |
|------|-------------|
| 1 | Build hotel URL with params: `checkIn`, `checkOut`, `los`, `adults`, `children`, `rooms`, `currency=USD`, `locale=en-us` |
| 2 | Fetch hotel page via Firecrawl (primary) |
| 3 | Skip static checkout link discovery (rarely present on Agoda) |
| 4 | Use Browserless `/function` API to click "Book Now" button on hotel page |
| 5 | Capture resulting `/book/` URL with encrypted session params (`secdat`, `r0`, `sarg`) |
| 6 | Extract "Total Price" from checkout page content returned by Browserless |

### Success Criteria

| Criterion | Requirement |
|-----------|-------------|
| **Status** | `success_total_stay` |
| **Price Type** | Total price including taxes and fees |
| **Evidence Pattern** | Contains "Total Price" label in content |
| **Directly Comparable** | `true` |
| **Currency** | Explicit currency code (e.g., `USD`) |

### Evidence String Pattern

The extraction must find content matching this pattern:
```
Total Price USD X,XXX.XX
```

With supporting context:
```
Included in total price: Government Tax
```

Example verified evidence:
```
ights) USD 5,099.24 Total Price USD 5,099.24 Included in total price: Government Tax
```

## Key Files (Baseline Reference)

| File | Purpose | Critical Sections |
|------|---------|-------------------|
| `supabase/functions/extract-agoda/index.ts` | Golden Path extractor | Phase 2C click logic (lines 2065-2130) |
| `src/lib/baselineExpectations.ts` | Baseline identifiers | Agoda baseline constants |
| `docs/AGODA_PRICE_EXTRACTION_WORKING_BASELINE.md` | This document | Full baseline specification |

## Observable Behaviors (Acceptance Criteria)

### Discovery Phase

| ID | Behavior | Observable |
|----|----------|------------|
| `hotel_page_fetch` | Hotel page fetched successfully | Content length ≥ 2000 chars |
| `phase_2b5_skipped` | Search page click skipped | No Browserless attempt on search URL |
| `phase_2c_executed` | Hotel page click executed | Browserless `/function` called on hotel URL |
| `checkout_url_discovered` | Encrypted checkout URL found | URL contains `/book/` and `secdat` param |

### Price Extraction

| ID | Behavior | Observable |
|----|----------|------------|
| `total_price_extracted` | Total price found | `extractedPrice` is non-null number |
| `taxes_included` | Taxes included in total | `includesTaxesFees` is `true` |
| `directly_comparable` | Price is comparable | `directlyComparable` is `true` |
| `evidence_captured` | Evidence snippet saved | Contains "Total Price" text |

### Performance

| ID | Behavior | Observable |
|----|----------|------------|
| `completes_under_30s` | Extraction completes quickly | `durationMs` < 30000 |
| `no_timeout` | No timeout errors | `status` is not `timeout` |

## Structural Proof Contract

The extractor returns a `structuralProof` object with:

```typescript
{
  hotel_page_reached: true,
  checkout_link_found: true,
  checkout_url_found: "https://www.agoda.com/en-sg/book/...",
  checkout_page_reached: true,
  dates_injected: true,
  total_price_label_found: true,
  directly_comparable: true,
  proof_version: "agoda-golden-path-v3.1",
  extraction_method: "hotel_click_total_price_currency_amount",
  selector_matched: "total_price_currency_amount"
}
```

## Platform Configuration

| Field | Value |
|-------|-------|
| **Platform Name** | `agoda.com` |
| **Coverage Tier** | `A` (Supported) |
| **Dedicated Extractor** | `extract-agoda` |
| **Tier Reason** | Golden Path v3.1: Phase 2C hotel-page click; Phase 2B-5 search click intentionally skipped for reliability |

## Reverting to This Baseline

If future changes break behavior, revert using:

1. **Git History**: Restore files to commit containing this baseline
2. **Key Files to Restore**:
   - `supabase/functions/extract-agoda/index.ts` (Phase 2C logic, Phase 2B-5 skip)
3. **Redeploy**: Edge function `extract-agoda`

## Baseline History

| Version | Name | Declared | Key Changes |
|---------|------|----------|-------------|
| **1.0.0** | **agoda-price-extraction-golden-path-v1** | **2026-01-23** | Initial baseline: Phase 2C hotel click primary; Phase 2B-5 skipped; ~20s completion |

---

## Change Log Requirement

Any modification to Agoda price extraction logic MUST:

1. Document the change in this file
2. Update version number
3. Add entry to Baseline History
4. Get explicit user approval
5. Update `src/lib/baselineExpectations.ts`

---

*This baseline is LOCKED. Future prompts can safely say "Revert to agoda-price-extraction-golden-path-v1" and the system will restore this exact behavior.*
