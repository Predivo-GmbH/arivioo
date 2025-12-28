# Golden Path Contract

**Version**: 2.0  
**Last Updated**: 2025-12-28  
**Status**: ENFORCED

## Core Requirement

> Given an Airbnb stay with dates, reliably apply those exact dates on matching listings across other platforms and extract real, comparable total stay prices, or explicitly explain why that is not possible, fully automatically.

---

## Platform Coverage Tiers (SLA)

All platforms are classified into exactly ONE coverage tier. Tier classification is **authoritative** and enforced in the pipeline.

### Tier A – Supported (Production SLA)

**Criteria (ALL must be true):**
- ✅ Dates apply deterministically (URL params or minimal navigation)
- ✅ Total stay price visible pre-payment
- ✅ Production extractor exists
- ✅ Hallucination guard passes
- ✅ Repeatability proven (≥3 runs consistent)
- ✅ `reliability_score >= 0.9`

**Behavior:**
- Always attempted first
- Uses dedicated production extractor
- `requireValidation=true` enforced
- Covered by reliability monitoring

**Current Tier A Platforms:**
| Platform | Extractor | Repeatability | Notes |
|----------|-----------|---------------|-------|
| Hotels.com | `extract-hotelscom` | 3/3 ($175, hash `601625a2`) | Reference golden path |
| Expedia | `extract-expedia` | 3/3 ($630, hash `631f3b1a`) | Proven production |

---

### Tier B – Attempted (Best Effort)

**Criteria:**
- Platform matched by search
- No proven extractor yet, OR unstable behavior
- Not classified as blocked or non-compliant

**Behavior:**
- Attempt Phase A + Phase B automatically
- Uses generic extraction flow
- Explicit failure outcomes expected and acceptable
- **No SLA on price availability**

**Default for new platforms.**

#### Tier B Handling Rules

1. **Self-Triaging**: Every Tier B extraction automatically updates:
   - `last_attempt_at` - timestamp of last extraction attempt
   - `last_outcome_type` - outcome classification (success, dates_not_applied, blocked, etc.)
   - `total_attempts` / `total_successes` / `total_failures` - cumulative counters

2. **Evidence Accumulation**: The system tracks outcomes over time without manual intervention
   - Successful extractions increment `total_successes`
   - Failures increment `total_failures` and update `last_failure_at`

3. **Promotion Readiness Signals** (computed, not stored):
   - `success_rate` = successes / attempts
   - `dominant_failure_reason` = most recent failure type
   - `promotion_candidate` = true if:
     - At least one successful extraction
     - Failure reasons are NOT blocking/login/payment-flow
     - ≥3 attempts with ≥50% success rate

4. **Why Tier B Platforms Are Not Manually Tuned**:
   - Manual tuning creates technical debt
   - Evidence must drive promotion decisions
   - "Dead ends" self-identify through failure patterns
   - Dashboard visibility replaces ad-hoc investigation

5. **When a Tier B Platform Becomes Eligible for Promotion Work**:
   - `promotion_candidate = true` visible in dashboard
   - Consistent success pattern (multiple runs)
   - No blocking failure reasons in recent attempts
   - Business value justifies extractor investment

6. **When a Tier B Platform Is Likely Demoted to Tier C**:
   - Consistent `blocked` outcomes across Firecrawl + Zyte
   - `login_required` or `reserve_required` patterns emerge
   - Zero successes after ≥5 attempts
   - Network blocking confirmed (403, CAPTCHA)

---

### Tier C – Unsupported (Short-Circuited)

**Criteria (ANY of the following):**
- ❌ Network blocked (403, bot detection)
- ❌ Requires payment/login to see totals
- ❌ Inquiry-based pricing only
- ❌ Compliance constraints

**Behavior:**
- **Immediately short-circuited** – no extraction attempted
- Returns explicit `platform_unsupported` status with reason
- No retries, no escalations
- `retry_policy = disabled`

**Current Tier C Platforms:**
| Platform | Reason | Classification Date |
|----------|--------|---------------------|
| Vrbo | Network blocked (403 Firecrawl + Zyte) | 2025-12-28 |

---

## System-Wide Success Semantics

> **A pipeline run is successful if every matched platform produces either:**
> 1. A grounded total stay price, OR
> 2. An explicit, classified terminal failure

Absence of a price is **not a failure** if it is explained with evidence.

### Terminal Statuses (Exhaustive)

```
success                          - Price extracted and verified
dates_not_applied               - Could not apply requested dates
no_availability_for_dates       - Property unavailable for dates
sold_out                        - Property sold out
blocked_captcha_or_bot          - Bot/CAPTCHA detection
blocked_rate_limit              - Rate limited
render_failed                   - Page did not render
listing_unavailable             - Listing no longer exists
price_not_found_after_dates_applied - Dates applied but no price visible
total_not_available_pre_checkout - Only nightly price visible
validation_error                - Phase A validation failed
extraction_error                - Phase B extraction failed
timeout                         - Operation timed out
platform_unsupported            - Tier C platform (short-circuited)
```

### Normalized Outcome Types (Gate 3 Evaluation)

For consistent gate evaluation, extraction statuses are normalized to:

| Normalized Type | Raw Statuses | Gate 3 Impact |
|-----------------|--------------|---------------|
| `success` | success | ✅ Passes |
| `blocked` | blocked_captcha_or_bot, blocked_rate_limit, bot detected | ❌ Blocks promotion |
| `login_required` | login errors, sign-in required | ❌ Blocks promotion |
| `reserve_required` | inquiry-based, request to book | ❌ Blocks promotion |
| `payment_flow_required` | total_not_available_pre_checkout | ❌ Blocks promotion |
| `dates_not_applied` | dates_not_applied, could not validate dates | ✅ Passes |
| `no_availability` | sold_out, listing_unavailable, no_availability_for_dates | ✅ Passes |
| `price_not_found` | price_not_found_after_dates_applied | ✅ Passes |
| `render_failed` | render_failed, firecrawl/zyte errors | ✅ Passes |
| `timeout` | timeout | ✅ Passes |
| `unknown` | unclassified | ✅ Passes |

**Only blocking outcomes (`blocked`, `login_required`, `reserve_required`, `payment_flow_required`) prevent Gate 3 from passing.**

---

## Proven Reference Implementation: Hotels.com

| Property | Status | Evidence |
|----------|--------|----------|
| Date Application | ✅ URL parameters | `chkin`, `chkout` params work |
| Price Visibility | ✅ Pre-payment | Total prices visible before reserve flow |
| Content Verification | ✅ Verbatim | "The price is $175 total" in content |
| Determinism | ✅ 100% | 3/3 runs identical ($175, hash `601625a2`) |
| Retries Required | ❌ None | First attempt success |
| Zyte Escalation | ❌ Not needed | Firecrawl alone sufficient |
| Hallucination Guard | ✅ Passed | All prices verified against content |

---

## Required Platform Properties (for Tier A)

### 1. Dates Can Be Applied Deterministically
- URL parameters OR minimal navigation applies dates
- Page leaves "enter dates" state reliably
- Detected check-in/check-out match requested dates

### 2. Total Stay Prices Are Visible Pre-Payment
- Total price (not just nightly) is displayed
- No "reserve" or "book" flow required to see price
- No room selection required to see price

### 3. Prices Appear Verbatim in Captured Content
- Extracted price matches exact string in markdown/HTML
- No AI inference or estimation
- Evidence snippet contains the extracted value

### 4. Pricing Is Stable Enough to Pass Repeatability Tests
- 3 consecutive runs produce consistent results
- If prices differ, content hashes must also differ (real dynamic pricing)
- No unexplained extraction failures

---

## Required Pipeline Guarantees

### No Price Without Date Validation
```
Phase A MUST pass before Phase B runs.
If dates are not validated, return explicit failure status.
```

### No Price Without Content Verification
```
Extracted price MUST appear verbatim in captured content.
If price cannot be verified, return price_not_found.
```

### No Silent Failure
```
Every extraction attempt MUST end in a terminal status.
No extraction may remain in "pending" state.
Error field must explain the failure.
```

### Tier-Based Routing
```
Tier A → Dedicated production extractor
Tier B → Generic Phase A + Phase B flow
Tier C → Immediate short-circuit with platform_unsupported
```

---

## Adapter Onboarding Workflow

### New Platform Appears

1. **Default Classification**: Tier B (Best Effort)
2. **Evidence Collection**: Automatic via generic extraction attempts
3. **Metrics Tracked**:
   - Success rate
   - Date validation rate
   - Content hash stability

### Promotion to Tier A (Supported)

**Requirements:**
- [ ] Golden Path Contract satisfied (all 4 properties)
- [ ] Repeatability test passed (3/3 runs consistent)
- [ ] Production extractor implemented
- [ ] `reliability_score >= 0.9` achieved
- [ ] Hallucination guard verified

**Process:**
1. Run diagnostic sequence
2. Create production extractor (mirror `extract-hotelscom`)
3. Run 3-run repeatability test
4. Update `platform_adapters`:
   - `coverage_tier = 'A'`
   - `dedicated_extractor = 'extract-{platform}'`
   - `reliability_score = 1.0`
   - `tier_reason = 'Production-proven...'`

### Demotion to Tier C (Unsupported)

**Triggers:**
- Consistent blocking (403, CAPTCHA) across Firecrawl + Zyte
- Prices only visible after payment/login
- Inquiry-based pricing confirmed
- Compliance constraints identified

**Process:**
1. Run single diagnostic (no tuning)
2. Document first failing criterion
3. Update `platform_adapters`:
   - `coverage_tier = 'C'`
   - `coverage_status = 'blocked' | 'unsupported'`
   - `retry_policy = 'disabled'`
   - `is_active = false`
   - `tier_reason = 'Explicit reason...'`

---

## Automated Promotion Candidate Nomination

### How Promotion Candidates Are Nominated

The system automatically nominates **exactly one** promotion candidate from Tier B platforms. Nomination is based on evidence, not assumptions.

#### Eligibility Gates (All Must Pass)

| Gate | Name | Requirement |
|------|------|-------------|
| G1 | Date Application Viability | `dates_validated = true` at least once |
| G2 | Price Presence | At least one grounded price extraction (verbatim, hallucination guard passed) |
| G3 | Failure Quality | Dominant failure reason is NOT: `blocked`, `login_required`, `reserve_required`, `payment_flow_required` |

Platforms failing any gate are **not eligible** for promotion.

#### Promotion Score (Eligible Platforms Only)

For platforms passing all gates, a transparent score is computed:

```
promotion_score = (success_rate × 0.5) + (recency_score × 0.3) + (stability_score × 0.2)
```

| Component | Weight | Meaning |
|-----------|--------|---------|
| success_rate | 0.5 | total_successes / total_attempts |
| recency_score | 0.3 | 1.0 if success ≤7 days, 0.5 if ≤30 days, 0.1 otherwise |
| stability_score | 0.2 | 1.0 if success_rate ≥ 50% and G3 passed |

**No ML. No tuning magic. Deterministic and explainable only.**

#### Single Candidate Rule

- At most **one** platform can be `promotion_candidate = true` at any time
- The highest-scoring eligible platform is nominated
- If no platform passes all gates, no candidate exists
- Candidate status is **recalculated** after every extraction

### Why Promotion Is Never Automatic

Automatic promotion would:
- Risk production instability from unvalidated extractors
- Skip repeatability testing (3-run consistency)
- Bypass hallucination guard verification
- Create extractors without human review

**Promotion requires manual implementation of a production extractor**, which must be tested for repeatability before Tier A classification.

---

## Promotion Execution Workflow

### Promotion Lifecycle States

| State | Meaning |
|-------|---------|
| `none` | Default, no promotion activity |
| `nominated` | Platform is the current promotion candidate |
| `in_progress` | Promotion work started, scoring locked |
| `promoted` | Successfully promoted to Tier A |
| `rejected` | Promotion rejected, remains Tier B |

### Starting Promotion Work

When an admin clicks **"Start Promotion Work"** on a nominated candidate:

1. `promotion_in_progress = true`
2. `promotion_status = 'in_progress'`
3. `promotion_started_at = now()`
4. `promotion_started_by = admin_id`
5. `promotion_source_score` = current score (locked)
6. `promotion_snapshot` = JSON snapshot of gates and evidence

**Scoring is locked**: No gate or score updates while in progress. This preserves the decision context.

### During Promotion Work

The engineering team must:
1. Build a dedicated extractor (mirror `extract-hotelscom`)
2. Run 3-run repeatability test
3. Verify hallucination guard passes
4. Document results in promotion notes

### Completing Promotion

#### Mark as Promoted
- `promotion_status = 'promoted'`
- `coverage_tier = 'A'`
- `tier_reason = 'Promoted from Tier B. <notes>'`
- `promotion_in_progress = false`

#### Mark as Rejected
- `promotion_status = 'rejected'`
- `promotion_notes = '<rejection reason>'`
- `promotion_in_progress = false`
- Remains Tier B, may be re-nominated later if evidence improves

### Traceability

All promotion decisions are auditable:
- `promotion_decision_at` - timestamp
- `promotion_decision_by` - who made the decision
- `promotion_notes` - human-written notes
- `promotion_snapshot` - evidence at decision time

### Why Only One Candidate Exists

Single candidate focus:
- Prevents scattered engineering effort
- Forces investment where evidence is strongest
- Makes "next platform" decision clear
- Avoids ad-hoc platform chasing

### How This Prevents Ad-Hoc Platform Chasing

| Before | After |
|--------|-------|
| "Let's try Booking.com" | "Booking.com is Tier B, no successful extractions yet" |
| "Can we support Agoda?" | "Agoda is eligible but not the top candidate" |
| Manual investigation | Dashboard shows gates, scores, reasons |
| Guessing which platform next | Top candidate is clearly nominated |

---

## Source of Truth Hierarchy

| Layer | Table | Purpose | Tier Rules |
|-------|-------|---------|------------|
| **Primary** | `price_extractions` | Authoritative pricing and extraction outcomes | Tier C = `platform_unsupported` status |
| **Secondary** | `search_results` | Display-oriented cache with photo match data | Tier C = NULL prices (enforced at write) |
| **Tertiary** | UI hooks (`useEnrichedSearchResults`) | Merged view for frontend | Tier C = filtered from pricing/ranking |

### Enforcement Points (Defense in Depth)

1. **Backend write guard** (`search-alternatives`): Tier C platforms have prices NULLed before insert
2. **Frontend read guard** (`useEnrichedSearchResults`): Tier C platforms filtered from price comparisons
3. **UI display guard** (`SearchResults.tsx`): Tier C platforms excluded from "Best Deal" badges

This ensures that even if one layer fails, Tier C platforms cannot surface prices.

---

## Implementation Files

| Component | File | Purpose |
|-----------|------|---------|
| Hotels.com Extractor | `supabase/functions/extract-hotelscom/index.ts` | Tier A production |
| Expedia Extractor | `supabase/functions/extract-expedia/index.ts` | Tier A production |
| Pipeline Worker | `supabase/functions/process-platform-extraction/index.ts` | Tier routing & enforcement |
| Adapter Config | `platform_adapters` table | Tier & coverage metadata |
| Admin Dashboard | `src/pages/admin/PlatformCoverage.tsx` | Visibility & governance |

---

## Failure Mode Documentation

### Acceptable Failures (Explicit & Evidence-Backed)
- `sold_out` - Property not available for dates (evidence: "Sold out" in content)
- `no_availability_for_dates` - Platform shows unavailable (evidence: explicit message)
- `blocked_captcha_or_bot` - Anti-automation (evidence: CAPTCHA/block message)
- `dates_not_applied` - URL params didn't work (evidence: "enter dates" still present)
- `platform_unsupported` - Tier C platform (evidence: classification reason)

### Unacceptable Failures (Must Be Eliminated)
- Silent pending status
- Price without content verification
- AI-inferred prices without verbatim match
- Extraction without Phase A validation
- Tier C platform attempted instead of short-circuited

---

## Contract Enforcement

This contract is enforced by:

1. **Tier-Based Routing** - Pipeline checks `coverage_tier` before extraction
2. **Hallucination Guard** - Prices must be verified against captured content
3. **Phase Sequencing** - Phase B only runs after Phase A success
4. **Terminal Status Requirement** - All paths lead to explicit status
5. **Evidence Storage** - All extractions store evidence snippets and content hashes
6. **Admin Visibility** - Platform Coverage dashboard exposes tier status

Any violation of this contract should be treated as a system bug, not a platform limitation.

---

## Backfill & Evidence Maintenance

### Historical Data Backfill

The `backfill-platform-evidence` edge function computes gates and scores from existing `price_extractions`:

```bash
# Run once to populate gates from historical data
POST /functions/v1/backfill-platform-evidence
```

**Computes:**
- `total_attempts`, `total_successes`, `total_failures`
- `last_success_at`, `last_failure_at`, `last_attempt_at`
- Gates (G1, G2, G3) from historical outcomes
- `promotion_score` for eligible Tier B platforms
- Nominates exactly one promotion candidate

**Use after:**
- Initial system deployment
- Database migrations affecting extraction data
- Manual data corrections

---

## API Quotas Admin Page

### How Usage Values Are Computed

| Field | Source | Calculation |
|-------|--------|-------------|
| `used` | SerpAPI: Provider API | Direct from `total_searches_this_month` |
| `used` | Other providers: Telemetry | Count of rows in `api_request_logs` for current billing period |
| `remaining` | Known limit providers | `limit - used` |
| `remaining` | Unknown/unlimited | `null` (not displayed) |
| `limit` | Provider API (SerpAPI) | From `searches_per_month` |
| `limit` | Configured | From `api_providers.plan_limit` column |
| `limit` | Unknown | `null`, displayed as "Unknown limit" |

### Limit Types

| Type | Meaning | Display |
|------|---------|---------|
| `known_limit` | Exact quota available | Progress bar with remaining |
| `unlimited` | No quota enforced | "Unlimited" badge, usage shown |
| `unknown` | Limit not determinable | "Limit Unknown" badge, usage shown |

### Limit Source

| Source | Meaning |
|--------|---------|
| `provider_api` | Queried from provider's quota API (most accurate) |
| `configured` | Manually set in `api_providers.plan_limit` |
| `inferred` | Derived from plan documentation |
| `unknown` | No reliable source available |

### Firecrawl Aggregation

Firecrawl usage is aggregated across all active keys:
- Log entries for both `firecrawl` and `firecrawl_1` are combined
- Single "Firecrawl" row shown in UI with total usage
- `keysActive` field indicates number of configured keys

### Key Invariant

**Used count must never show 0 if API calls happened.** This is ensured by:
1. Counting `api_request_logs` rows as telemetry source of truth
2. For SerpAPI, using provider's own usage counter
3. For other providers, request count = used count

---

## Pipeline Stage Timing System

### Overview

The pipeline timing system provides data-driven "typical time" estimates for each stage of the search pipeline. This replaces static hardcoded estimates with real measurements from telemetry.

### Canonical Pipeline Stages

The pipeline has 6 canonical stages defined in `src/lib/pipelineStages.ts`:

| Stage ID | Title | Description |
|----------|-------|-------------|
| `analyze_listing` | Analyzing Listing | Parse Airbnb URL, extract metadata, dates |
| `collect_photos` | Collecting Property Photos | Download images from Airbnb listing |
| `find_matches` | Finding Matches on Other Platforms | Visual search + text search across platforms |
| `validate_dates` | Applying Your Dates | Set check-in/check-out dates on each platform (Phase A) |
| `collect_prices` | Collecting Prices | Extract real-time prices from each platform (Phase B) |
| `finalize_results` | Finalizing Results | Compute savings and prepare results |

### Telemetry Storage

Stage timings are stored in `search_stage_runs` table:

```sql
CREATE TABLE search_stage_runs (
  id UUID PRIMARY KEY,
  search_id UUID REFERENCES searches(id),
  stage_name TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  duration_ms INTEGER,
  outcome_status TEXT DEFAULT 'running',  -- running, success, partial, failed, skipped, cancelled
  error_message TEXT,
  metadata JSONB
);
```

Aggregated statistics are cached in `search_stage_stats` for fast UI retrieval.

### "Typical Time" Calculation

The `get-stage-timings` edge function computes robust typical times using the following algorithm:

1. **Sample Selection**: Use the most recent 200 successful/partial runs per stage
2. **Outlier Removal**: Apply IQR-based filtering:
   - Compute Q1, Q3, and IQR = Q3 - Q1
   - Exclude durations outside [Q1 - 1.5×IQR, Q3 + 1.5×IQR]
3. **Percentile Calculation**:
   - If ≥10 samples remain after filtering: compute p50 and p80
   - If <10 samples: fall back to unfiltered p50 and p80
4. **Display Format**: Show range as "p50–p80" (e.g., "8s–15s")
5. **Caching**: Results are cached daily in `search_stage_stats`

### Fallback Values

Each stage has hardcoded fallback typical times used when insufficient telemetry exists:

| Stage | Fallback p50 | Fallback p80 |
|-------|--------------|--------------|
| analyze_listing | 8s | 15s |
| collect_photos | 5s | 12s |
| find_matches | 20s | 45s |
| validate_dates | 10s | 25s |
| collect_prices | 15s | 40s |
| finalize_results | 2s | 5s |

### Backend Instrumentation

Stage timings are recorded using helper functions in the orchestration code:

```typescript
import { startStageRun, finishStageRun } from './telemetry';

const stageRun = await startStageRun(supabase, searchId, 'collect_photos');
try {
  // ... stage work ...
  await finishStageRun(supabase, stageRun.id, 'success');
} catch (error) {
  await finishStageRun(supabase, stageRun.id, 'failed', error.message);
}
```

### Frontend Integration

The `useStageTimings` hook fetches timing data for display:

```typescript
const { stageTimings, isLoading } = useStageTimings();

// Get timing for a specific stage
const timing = stageTimings.find(t => t.stageId === 'collect_prices');
const display = formatTypicalTime(timing?.p50Seconds, timing?.p80Seconds);
// Returns: "15s–40s"
```

### Handling "Unknown" States

- **Unknown limit**: When we cannot determine the API provider's limit
- **Unknown timing**: Falls back to hardcoded values with "Calculating..." display
- **Skipped stages**: Marked with `outcome_status = 'skipped'` and explicit reason in metadata

---

## TODO: Future Coverage Program Hooks

These are planned but not yet implemented:

- [ ] Automatic adapter candidate backlog creation when new platforms appear
- [ ] Platform classification persistence (audit trail)
- [ ] `reliability_score` decay over time without successful extractions
- [ ] Scheduled revalidation for Tier B platforms
- [ ] Automatic promotion alerts when Tier B reaches Tier A criteria
