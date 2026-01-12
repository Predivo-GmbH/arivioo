# Backend Finalization Contract

## Overview

The search finalization architecture ensures deterministic results by having the **backend pipeline** (not frontend) create and persist the final results snapshot.

## Key Invariants

1. **`finalised_at` is set ONLY by backend pipeline** - specifically in `search-alternatives` at the moment `status: "completed"` is set
2. **`final_results_snapshot` is immutable** - once set, it never changes
3. **Frontend only reads** - it never calls any endpoint to create/modify the snapshot
4. **Refresh is deterministic** - same snapshot = same UI every time

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
│       └─► SET status = "completed"                              │
│           └─► buildAndPersistFinalSnapshot()                    │
│               ├─► Fetch search_results + price_extractions      │
│               ├─► Build denormalized snapshot                   │
│               └─► SET final_results_snapshot + finalised_at     │
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
│       └─► When finalised_at is SET:                             │
│               ├─► Fetch final_results_snapshot from DB          │
│               ├─► Render results (single-shot, no mutations)    │
│               └─► Refresh shows identical output                │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Files

- `supabase/functions/_shared/buildFinalSnapshot.ts` - Shared helper that builds and persists the snapshot
- `supabase/functions/search-alternatives/index.ts` - Calls `buildAndPersistFinalSnapshot()` at completion points
- `supabase/functions/finalize-search-snapshot/index.ts` - DEPRECATED read-only endpoint (for backwards compat)
- `src/pages/SearchResults.tsx` - Frontend reads `final_results_snapshot` directly from DB

## Terminal Statuses

These statuses indicate the search is complete:
- `completed`
- `error`
- `cancelled`
- `price_unavailable`
- `dates_unavailable`

## Database Columns

```sql
searches.finalised_at      -- TIMESTAMP: When the snapshot was created (NULL = still running)
searches.final_results_snapshot -- JSONB: The immutable snapshot used for UI rendering
```

## Testing

1. Start a search, close browser mid-run, reopen later → results still finalize correctly
2. Refresh after completion → identical output every time
3. No "Loading final results..." stuck state - bounded retry with timeout
