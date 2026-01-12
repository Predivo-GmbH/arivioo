# Terminal State Freeze - Deterministic Search Results

## Overview

Once a search reaches a **terminal status**, the frontend freezes all results and stops polling. This ensures deterministic display that doesn't change on refresh.

## Terminal Statuses

Defined in `src/lib/pipelineStages.ts`:

```typescript
export const TERMINAL_STATUSES = [
  'completed',           // Success - all platforms processed
  'done',                // Alias for completed
  'error',               // Fatal pipeline error
  'failed',              // Fatal pipeline error (legacy)
  'cancelled',           // User cancelled the search
  'price_unavailable',   // No prices could be extracted but search finished
  'dates_unavailable',   // The listing is not available for the requested dates
];
```

## Freeze Behavior

Once `isTerminalStatus(search.status)` returns true:

1. **Heartbeat polling stops** - No more DB queries for search status
2. **Extraction polling stops** - No more price_extractions updates
3. **Results are frozen** - `setResults()` is not called again
4. **State is stable** - Refreshing shows identical data

## Data Source of Truth

For terminal searches, the authoritative data comes from:

- `searches` table: status, airbnb_price, dates, etc.
- `search_results` table: matched platforms
- `price_extractions` table: extraction status and prices

The `fetchEnrichedResults()` hook joins these tables once at terminal and that snapshot is frozen.

## Implementation

Key state variables in `SearchResults.tsx`:

```typescript
const isTerminalFrozenRef = useRef(false);  // Ref for sync checks in callbacks
const [isTerminalFrozen, setIsTerminalFrozen] = useState(false);
```

Freeze is triggered at:
- Initial load if search is already terminal
- SSE `complete` event
- Heartbeat poll detecting terminal status
- Stream ended with terminal status

## Debugging

Console logs prefixed with `[TerminalFreeze]` indicate when freeze activates:

```
[TerminalFreeze] Search already completed on load, freezing immediately
[TerminalFreeze] SSE complete event received, freezing
[TerminalFreeze] terminal status detected via heartbeat: completed
```

## Validation

To verify determinism:
1. Complete a search
2. Note the exact results (buckets, prices, statuses)
3. Refresh the page
4. Results should be identical
