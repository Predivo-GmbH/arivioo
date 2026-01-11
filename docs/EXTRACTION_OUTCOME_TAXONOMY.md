# Extraction Outcome Taxonomy

**Version**: 1.0.0  
**Last Updated**: 2026-01-11  

This document defines the canonical taxonomy for extraction outcomes shared across Admin and Frontend.

## Outcome Categories

| Category | User Label | Admin Label | Description |
|----------|-----------|-------------|-------------|
| `price_verified` | Verified | Price Verified | Price available and structurally verified |
| `price_unverified` | Manual check recommended | Price Unverified | Price found but not verified for dates |
| `unavailable_for_dates` | Not available for these dates | Unavailable for Dates | Found but sold out / unavailable |
| `requires_action` | Manual check needed | Requires User Action | Needs user interaction |
| `access_blocked` | Temporarily blocked | Access Blocked | Bot detection or rate limiting |
| `price_not_found` | Price not visible | Price Not Found | Couldn't extract price from page |
| `service_error` | Temporary error | Service Error | Provider timeout or server error |
| `platform_unsupported` | Platform not supported | Platform Unsupported | Tier C blocked |

## Key Improvement

**Sold out is NOT an error.** When a platform shows "sold out" for selected dates:
- Frontend shows: "Found on [platform], but not available for your selected dates"
- Admin shows: "Sold Out for Dates" (not "Internal Error" or "Unavailable")
- Grouped separately from extraction failures

## Implementation Files

| File | Purpose |
|------|---------|
| `src/lib/extractionOutcomeTaxonomy.ts` | Canonical classification logic |
| `src/hooks/useEnrichedSearchResults.ts` | Frontend enrichment |
| `src/pages/admin/ExtractionDiagnostics.tsx` | Admin status display |
| `src/pages/SearchResults.tsx` | User-facing results |
