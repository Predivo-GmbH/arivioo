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

## TODO: Future Coverage Program Hooks

These are planned but not yet implemented:

- [ ] Automatic adapter candidate backlog creation when new platforms appear
- [ ] Platform classification persistence (audit trail)
- [ ] `reliability_score` decay over time without successful extractions
- [ ] Scheduled revalidation for Tier B platforms
- [ ] Automatic promotion alerts when Tier B reaches Tier A criteria
