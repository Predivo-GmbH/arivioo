# Finalization Canonical Baseline — Do Not Modify Without Comparison

> ⚠️ **CRITICAL**: This baseline represents the canonical "No Results Until Final" behaviour.  
> Any change to finalization logic MUST be compared against this baseline first.

---

## Baseline Identity

**Name**: `search-results-finalization-baseline-v1`  
**Version**: `1.0.0`  
**Declared**: 2026-01-12  
**Status**: ACTIVE

---

## Enforcement Mechanism

This baseline is protected by a **multi-layer enforcement strategy**:

### Primary: Runtime Self-Test (Automatic)
The `airbnb-selftest` edge function validates finalization behaviour.
- **Endpoint**: `GET /airbnb-selftest?mode=finalization-canonical-check`
- **Execution**: Runs deterministic checks against fixture expectations
- **Failure**: Returns `finalization_baseline_violation` status
- **Surfaced**: Admin dashboard shows health status in BaselineInfoPanel

### Secondary: Regression Test Suite
- **File**: `src/lib/__tests__/extractionStateMachine.test.ts`
- **Test**: "Test Q: Finalization Baseline Regression Guard"
- **Command**: `npx vitest run`
- **Blocks**: Must pass before any finalization logic changes

### Enforcement Rules
1. All finalization invariants are tested on deploy
2. Any `finalization_baseline_violation` is visible in Admin Dashboard
3. Regression tests must pass locally before modifying finalization logic
4. This document MUST be consulted before any finalization fix

---

## Core Invariants (Protected)

### Invariant 1: No Results Before finalised_at
```
RULE: Results page MUST NOT render results until finalised_at IS NOT NULL
OBSERVABLE: User sees "Finding Better Deals" with Activity Log until finalization completes
```

### Invariant 2: Atomic Backend Finalization
```
RULE: status='completed' can ONLY be set atomically with final_results_snapshot and finalised_at
OBSERVABLE: finalizeAndCompleteSearch() performs single atomic DB update
FAILURE STATE: finalization_failed with api_error populated
```

### Invariant 3: Deterministic Snapshot Rendering
```
RULE: After finalised_at is set, results MUST come from final_results_snapshot only
OBSERVABLE: Refreshing page shows identical results
```

### Invariant 4: No Background Mutation After Terminal
```
RULE: Once isTerminalFrozen=true, no setState calls can modify results
OBSERVABLE: No UI flicker or change after terminal status reached
```

### Invariant 5: All Matched Platforms Appear in Final Results
```
RULE: Every platform in search_platforms MUST appear in final_results_snapshot
OBSERVABLE: Matched platforms never disappear from results, even if extraction failed
```

### Invariant 6: Finalization Progress Indicator
```
RULE: During terminalHydrating state, show "X/Y platforms finalized" progress
OBSERVABLE: User sees platform count updating until all reach terminal status
```

---

## Canonical Data Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      FINALIZATION CANONICAL FLOW                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  PHASE 1: Pipeline Running                                                   │
│  ├── Frontend: Shows "Finding Better Deals" + Activity Log                   │
│  ├── Backend: Processes platforms, updates search_platforms                  │
│  └── State: isTerminalFrozen=false, results=[]                               │
│                                                                              │
│  PHASE 2: All Platforms Terminal                                             │
│  ├── Backend: Checks all search_platforms have terminal extraction status    │
│  ├── Backend: Calls finalizeAndCompleteSearch()                              │
│  └── Backend: ATOMIC update: status, finalised_at, final_results_snapshot    │
│                                                                              │
│  PHASE 3: Frontend Hydration (terminalHydrating=true)                        │
│  ├── Frontend: Detects terminal status                                       │
│  ├── Frontend: Shows "Finalization Gate" progress indicator                  │
│  ├── Frontend: Polls search_platforms for terminal count                     │
│  └── Frontend: Displays "X/Y platforms finalized"                            │
│                                                                              │
│  PHASE 4: Snapshot Render (isTerminalFrozen=true)                            │
│  ├── Frontend: Fetches final_results_snapshot                                │
│  ├── Frontend: Renders deterministic results from snapshot                   │
│  ├── Frontend: Sets isTerminalFrozen=true                                    │
│  └── Frontend: Blocks ALL subsequent setState calls                          │
│                                                                              │
│  PHASE 5: Stable State                                                       │
│  ├── Refresh: Returns identical results from snapshot                        │
│  ├── Background: All polling/SSE updates are ignored                         │
│  └── Mutation: Impossible (isTerminalFrozen guard)                           │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Key Implementation Files

| Component | File | Description |
|-----------|------|-------------|
| Atomic Finalization | `supabase/functions/_shared/buildFinalSnapshot.ts` | `finalizeAndCompleteSearch()` helper |
| Pipeline Orchestration | `supabase/functions/search-alternatives/index.ts` | Calls finalization at pipeline end |
| Terminal Status Definitions | `src/lib/pipelineStages.ts` | `TERMINAL_STATUSES` array |
| Frontend Hydration | `src/pages/SearchResults.tsx` | Terminal freeze and snapshot rendering |
| Snapshot Hook | `src/hooks/useFinalizedSnapshot.ts` | Fetches authoritative snapshot |
| Self-Test | `supabase/functions/airbnb-selftest/index.ts` | `finalization-canonical-check` mode |
| Regression Tests | `src/lib/__tests__/extractionStateMachine.test.ts` | Test Q |

---

## Database Columns

| Column | Table | Purpose |
|--------|-------|---------|
| `status` | searches | Current search status |
| `finalised_at` | searches | Timestamp when snapshot was persisted |
| `final_results_snapshot` | searches | Immutable JSONB snapshot of results |
| `api_error` | searches | Error message if finalization failed |
| `api_error_code` | searches | Error code if finalization failed |
| `extraction_status_terminal` | search_platforms | Terminal extraction status per platform |

---

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
  'dates_unavailable',   // Listing not available for requested dates
  'finalization_failed', // Snapshot persistence failed
];
```

---

## Regression Comparison Workflow

When finalization behaviour deviates, follow this mandatory workflow:

### Step 1: Identify the Deviation
- [ ] Results rendered before `finalised_at` was set
- [ ] Results changed after page refresh
- [ ] Matched platform missing from final results
- [ ] Finalization progress indicator not shown
- [ ] Background mutation observed after terminal

### Step 2: Compare Against Canonical State
| Invariant | Expected | Actual |
|-----------|----------|--------|
| Results hidden until finalised_at | ✓ | |
| Atomic snapshot update | ✓ | |
| Snapshot is authoritative source | ✓ | |
| isTerminalFrozen blocks mutations | ✓ | |
| All search_platforms in snapshot | ✓ | |
| Progress indicator visible | ✓ | |

### Step 3: Document Delta Before Fix
Before changing anything, write down:
1. What differs from canonical behaviour?
2. Why did this difference occur?
3. Does the fix restore canonical behaviour or intentionally change it?

---

## Protected Test Assertions

These assertions are protected by regression tests in `Test Q`:

1. **No render before finalization**: `expect(resultsRendered).toBe(false)` when `finalised_at === null`
2. **Snapshot is authoritative**: `expect(displayedResults).toEqual(final_results_snapshot.results)`
3. **Terminal freeze blocks mutations**: `expect(setResultsCalled).toBe(false)` after `isTerminalFrozen`
4. **All platforms present**: `expect(snapshotPlatforms.length).toBe(searchPlatforms.length)`
5. **Refresh stability**: `expect(resultsAfterRefresh).toEqual(resultsBeforeRefresh)`

---

## History

| Date | Event | Notes |
|------|-------|-------|
| 2026-01-12 | Baseline established | After completing atomic finalization implementation |
| 2026-01-12 | Enforcement implemented | Runtime self-test + regression guard |

---

## Future-Proofing

This enforcement mechanism remains valid when:

1. **CI is added later**: Regression tests become part of CI pipeline; runtime self-test remains as secondary check
2. **Developer workflows change**: Runtime enforcement cannot be bypassed regardless of local practices
3. **Finalization logic evolves**: Any change that breaks canonical checks is immediately visible in admin dashboard

---

## Adding New System Logic Baselines

To add a new system-level baseline (following the same pattern as this one):

1. **Define the baseline in `SYSTEM_LOGIC_BASELINES` array** (`BaselineInfoPanel.tsx`):
   ```typescript
   {
     id: 'your_baseline_id',
     name: 'Your Baseline Name',
     version: '1.0.0',
     description: 'What this baseline protects.',
     checkMode: 'your-canonical-check', // Edge function mode
     invariants: [
       { id: 'inv_1', label: 'Description shown in UI', description: 'Tooltip text' },
     ],
   }
   ```

2. **Add edge function handler** in `airbnb-selftest/index.ts`:
   - Create `runYourCanonicalCheck()` function returning same shape as `FinalizationCanonicalCheckResult`
   - Add handler for `mode === 'your-canonical-check'`
   - **CRITICAL**: Always return HTTP 200 with structured result (`ok`, `error`, `checks`, `meta` fields)
   - Failures must be `ok: false` with HTTP 200, NOT HTTP 500

3. **Stable Response Contract** (all baseline checks must follow):
   ```json
   {
     "ok": boolean,
     "passed": boolean,
     "status": "baseline_valid" | "baseline_violation" | "error",
     "checks": [{ "name": string, "expected": string, "actual": string, "passed": boolean }],
     "error": { "code": string, "message": string, "details": any[] } | null,
     "meta": { "evaluated_at": string, "duration_ms": number }
   }
   ```

4. **Add state + runner in `BaselineInfoPanel.tsx`**:
   - Add state: `[yourLogic, setYourLogic]` and `[checkingYourLogic, setCheckingYourLogic]`
   - Add runner function following `runFinalizationLogic` pattern
   - Include in `runAllChecks`

5. **Map invariants** in the UI render section using `checkNameMap` for reliable matching.

---

*This baseline is the canonical reference point. Future fixes MUST compare against it first.*
