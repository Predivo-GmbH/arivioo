# No Results Until Final Contract

## Overview

The search results page implements a strict "No Results Until Final" contract. Users stay on the "Finding Better Deals" page until the search is fully finalized, then see deterministic results that never change.

## Key Invariants

1. **No partial results displayed** - Users never see intermediate bucket states
2. **Finalization marker** - `searches.finalised_at` indicates when snapshot is ready
3. **Immutable snapshot** - Once `finalised_at` is set, `final_results_snapshot` never changes
4. **Bounded hydration** - Loading never hangs; shows retry UI after timeout

## Database Schema

```sql
-- Added columns to searches table
finalised_at TIMESTAMP WITH TIME ZONE DEFAULT NULL
final_results_snapshot JSONB DEFAULT NULL
```

## Terminal Statuses

Defined in `src/lib/pipelineStages.ts`:
- `completed`, `done`, `error`, `failed`, `cancelled`, `price_unavailable`, `dates_unavailable`

## Flow

### While Pipeline Running
1. User sees "Finding Better Deals" with real-time Activity Log
2. No results UI is rendered
3. SSE stream provides progress updates

### On Completion
1. Backend sets `status = 'completed'`
2. Frontend calls `finalize-search-snapshot` edge function
3. Edge function persists `final_results_snapshot` and sets `finalised_at`
4. Frontend fetches snapshot and renders results

### On Refresh (Terminal Search)
1. Frontend detects terminal status immediately
2. Shows "Loading final results" with retry counter
3. Fetches authoritative snapshot (max 5 retries, 30s timeout)
4. Renders deterministic results
5. Sets `isTerminalFrozen` to prevent any mutations

## Bounded Retry Logic

```typescript
MAX_RETRIES = 5
INITIAL_BACKOFF_MS = 1000
TOTAL_TIMEOUT_MS = 30000
```

If all retries fail, shows error UI with Retry button instead of hanging.

## Files

- `src/pages/SearchResults.tsx` - Main component with terminal hydration
- `src/hooks/useFinalizedSnapshot.ts` - Snapshot fetch hook
- `supabase/functions/finalize-search-snapshot/index.ts` - Finalization endpoint
- `src/lib/pipelineStages.ts` - Terminal status definitions
