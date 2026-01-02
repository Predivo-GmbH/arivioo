# Search Flow Debugging Guide

## Overview
This document captures the canonical search flow behavior and common issues for future debugging reference.

## Search Flow Architecture

### SSE Stream + Polling Hybrid
The search results page (`/search/:id`) uses a **hybrid approach**:
1. **SSE Stream**: Real-time updates from the backend via `search-alternatives` edge function
2. **Background Polling**: Fallback mechanism that polls the database every 5 seconds

### Key State Variables
- `searchPhase`: 'loading' | 'searching' | 'done' | 'error'
- `showConfirmationModal`: Boolean for Airbnb total confirmation modal
- `subtotalInfo`: Contains subtotal data when modal is open
- `search`: The search object from database
- `results`: Array of enriched search results

## Critical Flow Points

### 1. Stream Completion Handler (lines ~706-720)
When SSE stream ends with a completed status:
```typescript
// Close any open modals since search is complete
setShowConfirmationModal(false);
setSubtotalInfo(null);

setSearch(updatedSearch as SearchData);
setResults(enrichedResults);
```

### 2. Polling Handler (lines ~903-920)
When background polling detects completed status:
```typescript
// CRITICAL: Update search state with latest data before transitioning
setSearch(data as SearchData);
setResults(enrichedResults);

// Close any open modals since search is complete
setShowConfirmationModal(false);
setSubtotalInfo(null);
```

## Common Issues & Solutions

### Issue: UI Stuck in "Thinking" State
**Symptoms**:
- Search shows `completed` in database
- UI still shows loading/thinking modal
- `AirbnbTotalConfirmationModal` stays open

**Root Cause**: Race condition where:
1. `AIRBNB_PARSING_TIMEOUT` triggers `needs_confirmation` SSE event
2. Modal opens expecting user input
3. Search continues and completes in background
4. SSE stream disconnects before "complete" event reaches frontend
5. Modal never closes

**Fix**: Ensure BOTH the stream-ended handler AND polling handler explicitly close modals:
```typescript
setShowConfirmationModal(false);
setSubtotalInfo(null);
```

### Issue: Results Not Displaying
**Symptoms**:
- Search completed
- Results exist in database
- UI shows empty results

**Root Cause**: `setSearch()` not called before `setSearchPhase('done')`

**Fix**: Always update search state BEFORE transitioning phase:
```typescript
setSearch(data as SearchData);  // Must come first
setResults(enrichedResults);
setSearchPhase("done");
```

## Key SSE Events
- `status_update`: Pipeline stage progress
- `needs_confirmation`: Requires user confirmation modal
- `stream_ended`: Normal stream termination
- `error`: Stream error occurred

## Debugging Checklist
1. Check search status in database: `SELECT status FROM searches WHERE id = ?`
2. Check if results exist: `SELECT * FROM search_results WHERE search_id = ?`
3. Check console logs for SSE events
4. Check network tab for polling requests
5. Verify modal state variables in React DevTools

## Related Files
- `src/pages/SearchResults.tsx` - Main search results page
- `supabase/functions/search-alternatives/index.ts` - SSE stream source
- `src/components/AirbnbTotalConfirmationModal.tsx` - Confirmation modal
