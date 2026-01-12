# Backend Finalization Contract

## Overview

The search finalization architecture ensures deterministic results by having the **backend pipeline** (not frontend) create and persist the final results snapshot **atomically** with setting status='completed'.

## Critical Invariant

**STATUS = 'completed' MUST ONLY BE SET WHEN:**
1. `final_results_snapshot` is persisted (non-null)
2. `finalised_at` is set (non-null)

This is enforced by the `finalizeAndCompleteSearch()` helper which performs an **atomic update** setting all three values in a single database call.

## Failure Handling

If snapshot persistence fails:
- `status` is set to `'finalization_failed'` (NOT 'completed')
- `api_error` contains the error message
- `api_error_code` is set to `'finalization_failed'`
- Frontend shows an error state with the Activity Log

## Terminal Statuses

```typescript
const TERMINAL_STATUSES = [
  'completed',             // Success - snapshot exists
  'done',                  // Alias for completed
  'error',                 // Fatal pipeline error
  'failed',                // Fatal pipeline error (legacy)
  'cancelled',             // User cancelled the search
  'price_unavailable',     // No prices could be extracted
  'dates_unavailable',     // Listing not available for dates
  'finalization_failed',   // Snapshot persistence failed
];
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    BACKEND PIPELINE                              │
│                                                                  │
│  search-alternatives                                             │
│       │                                                          │
│       ├─► Scrape Airbnb                                         │
│       ├─► Find alternatives                                     │
│       ├─► Extract prices                                        │
│       │                                                          │
│       └─► finalizeAndCompleteSearch()  ◄── SINGLE ATOMIC CALL   │
│               │                                                  │
│               ├─► Fetch search_results + price_extractions      │
│               ├─► Build denormalized snapshot                   │
│               │                                                  │
│               └─► ATOMIC UPDATE:                                │
│                   - status = 'completed'                        │
│                   - final_results_snapshot = <snapshot>         │
│                   - finalised_at = now()                        │
│                                                                  │
│               IF UPDATE FAILS:                                   │
│                   - status = 'finalization_failed'              │
│                   - api_error_code = 'finalization_failed'      │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                       FRONTEND                                   │
│                                                                  │
│  SearchResults.tsx                                               │
│       │                                                          │
│       ├─► While finalised_at is NULL:                           │
│       │       Show "Finding better deals" + Activity Log        │
│       │                                                          │
│       ├─► If status = 'finalization_failed':                    │
│       │       Show error state with api_error message           │
│       │                                                          │
│       └─► When finalised_at is SET:                             │
│               ├─► Fetch final_results_snapshot from DB          │
│               ├─► Render results (single-shot, no mutations)    │
│               └─► Refresh shows identical output                │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Files

- `supabase/functions/_shared/buildFinalSnapshot.ts` - `finalizeAndCompleteSearch()` atomic helper
- `supabase/functions/search-alternatives/index.ts` - Calls atomic helper at completion points
- `supabase/functions/finalize-search-snapshot/index.ts` - DEPRECATED read-only endpoint
- `src/pages/SearchResults.tsx` - Frontend reads `final_results_snapshot` directly from DB
- `src/lib/pipelineStages.ts` - Defines `TERMINAL_STATUSES` including `finalization_failed`

## Database Columns

```sql
searches.status                 -- Current status (completed/finalization_failed/etc)
searches.finalised_at           -- TIMESTAMP: When snapshot was created (NULL = running)
searches.final_results_snapshot -- JSONB: Immutable snapshot for UI rendering
searches.api_error              -- Error message if finalization failed
searches.api_error_code         -- 'finalization_failed' if snapshot persistence failed
```

## Testing

1. Start a search, close browser mid-run, reopen later → results finalize correctly
2. Refresh after completion → identical output every time
3. No "Search not yet finalized" error during normal flow
4. If finalization fails → user sees clear error with Activity Log details
