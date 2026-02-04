# Arivioo System Documentation

**Version**: 2.1.0 (Validated)  
**Last Validated**: 2026-02-04  
**Authority**: This document describes observed runtime behavior, not design intent.  
**Purpose**: Persistent context for AI coding assistants (Cursor)

---

## 1. System Overview

### 1.1 Purpose

Arivioo is a vacation rental price comparison system. Given an Airbnb listing URL with specific dates, the system:

1. Extracts the Airbnb total stay price as the baseline
2. Discovers the same property on alternative platforms via visual reverse image search
3. Verifies property matches using AI-powered image comparison
4. Extracts prices from verified platforms for the same dates
5. Presents a ranked comparison showing potential savings

### 1.2 What the System Explicitly Does NOT Do

- **Currency conversion**: All prices compared in extracted currency (USD assumed)
- **Real-time monitoring**: Each search is a one-time snapshot
- **Booking facilitation**: Deep links only; no transactions
- **Property verification beyond visual**: No address or legal entity verification
- **Mobile app**: Web-only
- **Manual date input**: Dates derived exclusively from Airbnb URL parameters
- **AI-based price extraction**: All price extraction is DOM/regex-based
- **Use of OpenAI models**: Exclusively uses Google Gemini

---

## 2. Technical Stack (As Implemented)

### 2.1 Frontend

| Component | Technology |
|-----------|------------|
| Framework | React 18.3.1 with TypeScript |
| Build Tool | Vite |
| Styling | Tailwind CSS + shadcn/ui |
| State Management | TanStack Query v5 + React hooks |
| Routing | React Router DOM v6 |
| Animations | framer-motion |

**Key Files**:
- `src/pages/SearchResults.tsx` — Results page (snapshot renderer)
- `src/hooks/useExtractionProgressRealtime.ts` — Realtime progress
- `src/hooks/useFinalizedSnapshot.ts` — Snapshot fetching with retry
- `src/lib/pipelineStages.ts` — Stage definitions and terminal statuses

### 2.2 Backend / Edge Functions

| Component | Technology |
|-----------|------------|
| Runtime | Deno (Supabase Edge Functions) |
| Language | TypeScript |
| Execution Model | Stateless per-request |
| Timeout | 150 seconds per invocation |

**Critical Edge Functions**:

| Function | Purpose |
|----------|---------|
| `search-alternatives` | Main orchestrator |
| `run-price-pipeline` | Extraction dispatcher |
| `process-platform-extraction` | Per-platform worker (Phase A + B) |
| `extract-expedia` | Dedicated Expedia extractor (Tier A) |
| `extract-booking` | Dedicated Booking.com extractor (Tier A) |
| `extract-vrbo` | Dedicated VRBO extractor (Tier A) |
| `extract-agoda` | Dedicated Agoda extractor (Tier A) |
| `extract-hotelscom` | Dedicated Hotels.com extractor (Tier A) |
| `finalize-search-snapshot` | Snapshot builder |
| `tier-a-retry-worker` | Background retry for Tier A |

**Shared Modules** (`supabase/functions/_shared/`):
- `buildFinalSnapshot.ts` — Snapshot construction
- `browserlessGate.ts` — Concurrency control (advisory lock `8675309`)
- `tierARetryPolicy.ts` — Retry logic for Tier A

### 2.3 Database

| Component | Technology |
|-----------|------------|
| Type | PostgreSQL (Supabase) |
| Realtime | Supabase Realtime (postgres_changes) |
| RLS | Enabled on all user tables |

**Key Tables**:
- `searches` — Search metadata, Airbnb baseline, final snapshot
- `search_platforms` — Verified platform matches
- `price_extractions` — Per-platform extraction state and results
- `search_stage_runs` — Stage telemetry (sparsely populated)
- `platform_adapters` — Platform configuration and tiers

### 2.4 External Services

| Service | Purpose | Called From | Constraint |
|---------|---------|-------------|------------|
| **SerpAPI** | Google Lens visual discovery | `search-alternatives` | Rate limited |
| **Browserless** | JS-rendered page access | Extractors, Airbnb baseline | Global limit: 1 concurrent (lock `8675309`) |
| **Firecrawl** | Primary web scraping | Extractors | Primary provider |
| **Zyte** | Fallback scraping with browser rendering | Fallback on 403/timeout | 60s timeout |
| **Resend** | Transactional email | Auth flows | — |

**Browserless Retry Policy**:
- **Max retries: 3** (not 4)
- Backoff sequence: 2s, 4s, 8s

### 2.5 AI Models in Use

| Model | Provider | Purpose |
|-------|----------|---------|
| `google/gemini-2.5-flash` | Google (via Lovable AI Gateway) | Image verification |

**Endpoint**: `https://ai.gateway.lovable.dev/v1/chat/completions`

**Models NOT Used**:
- OpenAI GPT (any version)
- Anthropic Claude (any version)
- Any other AI provider

---

## 3. Search Lifecycle (Reality-Based)

### 3.1 Logical Stages (As Designed)

The system was designed with 6 logical stages:

1. `analyze_listing` — Parse Airbnb URL, extract baseline price
2. `collect_photos` — Download Airbnb property images
3. `find_matches` — Visual search via Google Lens + AI verification
4. `validate_dates` — Apply dates to platform deep links (Phase A)
5. `collect_prices` — Extract prices from platforms (Phase B)
6. `finalize_results` — Build and persist immutable snapshot

### 3.2 Observable Stages (As Actually Visible)

**Only ONE stage is currently observable in telemetry: `analyze_listing`**

The `search_stage_runs` table contains rows only for `analyze_listing`. All other stages execute but do not write telemetry records.

**Implication**: Stage progress cannot be reliably determined from `search_stage_runs` alone. This is the current state, not a bug.

### 3.3 Actual Execution Flow

```
1. User submits Airbnb URL
   └─> search-alternatives edge function invoked

2. URL Validation
   ├─> Normalize URL (airbnb-url-normalizer)
   ├─> Extract dates from query params (check_in, check_out)
   └─> FAIL if dates missing or invalid

3. Airbnb Baseline Extraction (GATING)
   ├─> Firecrawl scrape → Zyte fallback on 403
   ├─> AI extracts total stay price
   ├─> FAIL ENTIRE SEARCH if baseline cannot be extracted
   └─> Store in searches.airbnb_price

4. Image Collection
   └─> Download and store Airbnb images (searches.airbnb_images)

5. Visual Discovery
   ├─> SerpAPI Google Lens call with primary image
   ├─> Filter results to known platform domains
   └─> Create search_platforms rows for candidates

6. AI Image Verification
   ├─> For each candidate: compare images via Gemini 2.5 Flash
   ├─> Threshold: 75% confidence to pass
   ├─> 90%+ confidence = "authoritative" match
   └─> Candidates below 75% are excluded

7. Price Extraction Pipeline
   ├─> run-price-pipeline creates price_extractions rows
   ├─> process-platform-extraction invoked per platform
   ├─> Phase A: Apply dates, validate they took effect
   ├─> Phase B: Extract price if Phase A passed
   └─> Tier A platforms get retry logic (max 3 retries)

8. Finalization
   ├─> All platforms reach terminal state OR timeout
   ├─> finalize-search-snapshot builds snapshot
   ├─> Atomic write: final_results_snapshot + finalised_at
   └─> Search status set to 'completed'
```

---

## 4. Current Stage Determination (CRITICAL SECTION)

### 4.1 Why "Current Stage" Is Not a First-Class Concept

There is **no canonical `current_stage` field** anywhere in the system.

The `searches.status` field contains pipeline status values but these do not map 1:1 to the 6 logical stages.

Stage telemetry (`search_stage_runs`) is sparsely populated. **Only `analyze_listing` is reliably written.**

### 4.2 Available Signals for Stage Inference

| Signal | Location | What It Indicates |
|--------|----------|-------------------|
| `searches.status` | `searches` table | High-level pipeline phase |
| `searches.airbnb_price` | `searches` table | Baseline extraction complete if > 0 |
| `searches.airbnb_images` | `searches` table | Image collection complete if populated |
| `search_platforms` count | `search_platforms` table | Discovery complete if > 0 rows exist |
| `price_extractions` statuses | `price_extractions` table | Extraction progress per platform |
| `searches.finalised_at` | `searches` table | Finalization complete if non-null |
| `search_stage_runs` | `search_stage_runs` table | **Only `analyze_listing` is observable** |

### 4.3 Deterministic Stage Inference Table

| Evidence | Inferred Stage | Confidence | Meaning |
|----------|----------------|------------|---------|
| `status = 'pending'` AND no `airbnb_price` | `analyze_listing` | High | Search just started |
| `airbnb_price > 0` AND `airbnb_images` empty | `collect_photos` | Medium | Baseline done, collecting images |
| `airbnb_images` populated AND no `search_platforms` rows | `find_matches` | Medium | Images ready, discovery in progress |
| `search_platforms` rows exist AND all `price_extractions` pending | `validate_dates` | Medium | Discovery done, extraction starting |
| Some `price_extractions` have non-pending status | `collect_prices` | High | Extraction in progress |
| All `price_extractions` terminal AND `finalised_at` null | `finalize_results` | High | Awaiting finalization |
| `finalised_at` non-null | Complete | High | Search fully finished |

### 4.4 Status Values → Pipeline Phases

| `searches.status` Value | Logical Phase |
|-------------------------|---------------|
| `pending` | Pre-start or early `analyze_listing` |
| `searching` | Discovery phase |
| `extracting_price`, `extracting_photos` | Active extraction |
| `searching_platforms`, `searching_platforms_lens_*` | Visual discovery |
| `ai_verifying_*` | AI image verification |
| `phase_a`, `phase_b` | Price extraction phases |
| `collecting_prices`, `comparing_prices` | Late extraction |
| `finalizing` | Building snapshot |
| `completed`, `done` | Terminal success |
| `error`, `failed`, `cancelled` | Terminal failure |
| `price_unavailable`, `dates_unavailable` | Terminal (no results) |
| `finalization_failed` | Terminal (snapshot failed) |

---

## 5. Terminal States

### 5.1 Search-Level Terminal Statuses

Defined in `src/lib/pipelineStages.ts`:

```typescript
const TERMINAL_STATUSES = [
  'completed',
  'done',
  'error',
  'failed',
  'cancelled',
  'price_unavailable',
  'dates_unavailable',
  'finalization_failed',
];
```

### 5.2 Extraction-Level Terminal Statuses

Each `price_extractions` row reaches one of these terminal states:

| Status | Meaning |
|--------|---------|
| `success` | Price extracted and verified |
| `success_total_stay` | Total stay price found |
| `price_extracted` | Price found (legacy) |
| `dates_unavailable` | Platform shows sold out |
| `sold_out` | Alias for dates unavailable |
| `service_error` | Provider timeout or failure |
| `timeout` | Extraction exceeded time limit |
| `stalled_timeout` | Marked stale by cleanup |
| `platform_unsupported` | Platform not extractable |
| `render_failed` | Browserless could not render |
| `access_blocked` | Bot detection triggered |

### 5.3 Dominant Outcome: `platform_unsupported`

**~32% of extractions terminate as `platform_unsupported`.**

This is the single most common non-success outcome. It occurs when:
- Platform has no dedicated extractor
- Platform adapter is inactive or misconfigured
- Platform domain variant is not recognized

### 5.4 Tier A Platform Reliability (Observed Reality)

Despite being classified as Tier A (highest priority), these platforms show high failure rates:

| Platform | Observed Behavior |
|----------|-------------------|
| **Expedia** | Frequently returns `service_error` after exhausting retries |
| **Hotels.com** | Often returns `platform_unsupported` |
| **Booking.com** | Most reliable of Tier A |
| **VRBO** | Variable success rate |
| **Agoda** | Moderate reliability |

---

## 6. AI Usage & Decision Boundaries

### 6.1 Where AI Is Used

| Location | AI Task |
|----------|---------|
| Image verification | Compare Airbnb image to platform image |
| Price extraction assist | Extract price from HTML when selectors fail |
| Airbnb baseline | Extract total stay price from page content |

### 6.2 What AI Decides

- Whether two property images show the same physical property (confidence score)
- The total price value when structured parsing fails
- Whether a price represents a total stay or per-night rate

### 6.3 What AI Explicitly Does NOT Decide

- Platform routing or selection
- Retry logic
- Search termination conditions
- Result ordering (deterministic by price)
- Whether to trust a price (verification rules are code-based)
- Final match/reject decisions (threshold logic is deterministic)

### 6.4 AI Confidence Value Characteristics

**AI confidence values are DISCRETE, not continuous 0-100.**

Observed clustering:
- `0` — No match / unable to compare
- `30` — Low confidence / uncertain
- `95-98` — High confidence match

The system does NOT produce evenly distributed values. Thresholds must account for this bucketing behavior.

**Thresholds**:
- `< 75%` — Candidate excluded
- `≥ 75%` — Candidate included in results
- `≥ 90%` — Marked as "authoritative" match

---

## 7. Known Limitations & Unknowns

### 7.1 Telemetry Gaps

- **Only `analyze_listing` stage writes to `search_stage_runs`**
- No telemetry for: `collect_photos`, `find_matches`, `validate_dates`, `collect_prices`, `finalize_results`
- Stage timing estimates use hardcoded fallbacks, not real telemetry
- This is incomplete by design today

### 7.2 Snapshot Version

The current `final_results_snapshot` schema is **version 2** (not 4 as some code comments suggest).

### 7.3 Browserless Constraints

| Constraint | Value |
|------------|-------|
| Global concurrency limit | 1 concurrent session |
| Advisory lock key | `8675309` |
| Retry count | **3** (not 4) |
| Backoff sequence | 2s, 4s, 8s |

### 7.4 Platform Extraction Reality

- Tier A classification does NOT guarantee extraction success
- Dedicated extractors exist but may fail due to site changes
- Hotels.com extractor is effectively non-functional
- `platform_adapters.is_active` may not reflect actual extractability

### 7.5 Price Verification Constraints

A price is only marked "verified" if ALL conditions are met:
- `extraction_status` is success variant
- `price_type` is `TOTAL_STAY` or `NIGHTLY_BREAKDOWN`
- `includes_taxes_fees` is true OR `breakdown_found` metadata is true
- `dates_validated` is true OR detected dates match requested dates

If any condition fails, the price is "unverified" and marked for manual check.

### 7.6 Currency Assumptions

- All prices assumed USD unless explicitly tagged
- No currency conversion performed
- Cross-currency comparisons may be inaccurate

### 7.7 Date Handling

- Dates ONLY derived from Airbnb URL query parameters
- Manual date input is not supported
- If Airbnb URL lacks `check_in`/`check_out` params, search fails

### 7.8 Finalization Atomicity

`finalised_at` and `final_results_snapshot` are written atomically.

If `finalised_at` is non-null, the snapshot is guaranteed to exist and be immutable.

If snapshot building fails, search status becomes `finalization_failed` with error details in `searches.finalization_error`.

### 7.9 No Canonical Current Stage Field

There is no `current_stage` column. Stage must be inferred from multiple signals as described in Section 4.

---

## Appendix A: Quick Reference Code

### Terminal Status Check

```typescript
import { isTerminalStatus } from '@/lib/pipelineStages';

if (isTerminalStatus(search.status)) {
  // Search is complete, use snapshot
}
```

### Stage Inference (Best Effort)

```typescript
function inferCurrentStage(search, platforms, extractions) {
  if (!search.airbnb_price) return 'analyze_listing';
  if (!search.airbnb_images?.length) return 'collect_photos';
  if (!platforms.length) return 'find_matches';
  if (extractions.every(e => e.extraction_status === 'pending')) return 'validate_dates';
  if (extractions.some(e => !isTerminalExtractionStatus(e.extraction_status))) return 'collect_prices';
  if (!search.finalised_at) return 'finalize_results';
  return 'complete';
}
```

### Extraction Terminal Check

```typescript
const TERMINAL_EXTRACTION_STATUSES = [
  'success', 'success_total_stay', 'price_extracted',
  'dates_unavailable', 'sold_out', 'unavailable_for_dates',
  'service_error', 'timeout', 'stalled_timeout',
  'platform_unsupported', 'render_failed', 'access_blocked'
];

function isTerminalExtractionStatus(status) {
  return TERMINAL_EXTRACTION_STATUSES.includes(status);
}
```

---

## Appendix B: File Reference

### Edge Functions (Critical Path)

| File | Purpose |
|------|---------|
| `supabase/functions/search-alternatives/index.ts` | Main orchestrator |
| `supabase/functions/run-price-pipeline/index.ts` | Extraction dispatcher |
| `supabase/functions/process-platform-extraction/index.ts` | Per-platform worker |
| `supabase/functions/finalize-search-snapshot/index.ts` | Snapshot builder |
| `supabase/functions/_shared/buildFinalSnapshot.ts` | Snapshot assembly |
| `supabase/functions/_shared/browserlessGate.ts` | Concurrency control |
| `supabase/functions/_shared/tierARetryPolicy.ts` | Retry logic |

### Frontend (Critical Path)

| File | Purpose |
|------|---------|
| `src/pages/SearchResults.tsx` | Results page (snapshot renderer) |
| `src/hooks/useExtractionProgressRealtime.ts` | Realtime progress |
| `src/hooks/useFinalizedSnapshot.ts` | Snapshot fetching |
| `src/lib/pipelineStages.ts` | Stage definitions, terminal statuses |
| `src/lib/resultCategorization.ts` | Result bucket assignment |
| `src/lib/extractionOutcomeTaxonomy.ts` | Status-to-category mapping |

---

## Appendix C: Database Schema (Key Tables)

### searches
```
id, user_id, airbnb_url, airbnb_title, airbnb_price, airbnb_currency,
airbnb_images, check_in_date, check_out_date, nights_count,
status, finalised_at, final_results_snapshot, finalization_error,
activity_log, created_at, updated_at
```

### search_platforms
```
id, search_id, platform_name, listing_url, listing_title,
images, confidence_score, match_type, extraction_id_latest,
extraction_status_terminal, outcome_category, matched_at, updated_at
```

### price_extractions
```
id, search_id, platform_name, deep_link, extracted_price, currency,
extraction_status, extraction_error, extraction_stage, extraction_metadata,
dates_validated, detected_checkin, detected_checkout,
includes_taxes_fees, confidence_score, price_type, provider_used,
tier_a_state, tier_a_attempt_count, tier_a_next_retry_at,
created_at, updated_at
```

### search_stage_runs
```
id, search_id, stage_name, started_at, finished_at, duration_ms,
outcome_status, error_message, metadata, created_at
```

Note: Only `analyze_listing` is reliably populated.

---

**END OF DOCUMENT**

*This document reflects observed system behavior as of 2026-02-04. It does not represent design intent, future plans, or recommendations.*
