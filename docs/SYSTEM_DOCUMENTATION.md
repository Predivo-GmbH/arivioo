# Arivioo System Documentation

**Version**: 3.0.0 (Comprehensive)  
**Last Validated**: 2026-02-04  
**Authority**: This document describes observed runtime behavior, not design intent.  
**Purpose**: Persistent context for AI coding assistants (Cursor, Lovable)

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Technical Stack](#2-technical-stack)
3. [External APIs & Services](#3-external-apis--services)
4. [AI Image Verification System](#4-ai-image-verification-system)
5. [Search Lifecycle](#5-search-lifecycle)
6. [Price Extraction Pipeline](#6-price-extraction-pipeline)
7. [Finalization & Snapshot Architecture](#7-finalization--snapshot-architecture)
8. [Result Categorization](#8-result-categorization)
9. [Terminal States](#9-terminal-states)
10. [Stage Determination](#10-stage-determination)
11. [Known Limitations](#11-known-limitations)
12. [Appendices](#appendices)

---

## 1. System Overview

### 1.1 Purpose

Arivioo is a vacation rental price comparison system. Given an Airbnb listing URL with specific dates, the system:

1. Extracts the Airbnb total stay price as the baseline (MANDATORY GATE)
2. Discovers the same property on alternative platforms via **visual reverse image search** (Google Lens)
3. Verifies property matches using **AI-powered image comparison** (purely visual, no text matching)
4. Extracts prices from verified platforms for the same dates
5. Presents a ranked comparison showing potential savings

### 1.2 What the System Explicitly Does NOT Do

| Capability | Status |
|------------|--------|
| Currency conversion | ❌ All prices compared in extracted currency (USD assumed) |
| Real-time monitoring | ❌ Each search is a one-time snapshot |
| Booking facilitation | ❌ Deep links only; no transactions |
| Property verification beyond visual | ❌ No address or legal entity verification |
| Mobile app | ❌ Web-only |
| Manual date input | ❌ Dates derived exclusively from Airbnb URL parameters |
| AI-based price extraction | ❌ All price extraction is DOM/regex-based (AI only for fallback) |
| Use of OpenAI models | ❌ Exclusively uses Google Gemini |
| Name/location matching | ❌ Purely visual matching - text/name similarity is explicitly ignored |

### 1.3 Core Product Invariants

These are **NON-NEGOTIABLE** rules enforced throughout the codebase:

1. **Visual-Only Matching**: If images do not clearly match with ≥75% probability, the candidate is NOT a valid alternative, regardless of text similarity, naming, or location.

2. **Airbnb Baseline Gate**: If Airbnb total stay price cannot be extracted, the entire search terminates immediately.

3. **Fully Automated Pipeline**: Once visual matches are found, price extraction happens automatically with zero manual user intervention.

4. **Atomic Finalization**: `status = 'completed'` is ONLY set when `final_results_snapshot` and `finalised_at` are successfully persisted atomically.

5. **Immutable Results**: Once `finalised_at` is set, the snapshot is frozen and results never re-derive on refresh.

---

## 2. Technical Stack

### 2.1 Frontend

| Component | Technology | Purpose |
|-----------|------------|---------|
| Framework | React 18.3.1 with TypeScript | UI rendering |
| Build Tool | Vite | Development server and bundling |
| Styling | Tailwind CSS + shadcn/ui | Design system |
| State Management | TanStack Query v5 + React hooks | Server state + local state |
| Routing | React Router DOM v6 | Navigation |
| Animations | framer-motion | Motion effects |
| Realtime | Supabase Realtime (postgres_changes) | Live progress updates |

**Key Frontend Files**:

| File | Purpose |
|------|---------|
| `src/pages/SearchResults.tsx` | Results page (snapshot renderer) |
| `src/hooks/useExtractionProgressRealtime.ts` | Realtime progress subscription |
| `src/hooks/useFinalizedSnapshot.ts` | Snapshot fetching with retry |
| `src/lib/pipelineStages.ts` | Stage definitions and terminal statuses |
| `src/lib/resultCategorization.ts` | Result bucket assignment |
| `src/lib/extractionOutcomeTaxonomy.ts` | Status-to-category mapping |
| `src/lib/canonicalPrice.ts` | Price comparability model |

### 2.2 Backend / Edge Functions

| Component | Technology | Constraint |
|-----------|------------|------------|
| Runtime | Deno (Supabase Edge Functions) | Stateless per-request |
| Language | TypeScript | — |
| Execution Model | Stateless per-request | No shared memory |
| Timeout | 150 seconds per invocation | Hard limit |

**Critical Edge Functions**:

| Function | Purpose | Tier |
|----------|---------|------|
| `search-alternatives` | Main orchestrator - discovery, verification, extraction dispatch | — |
| `run-price-pipeline` | Extraction dispatcher - creates price_extractions rows | — |
| `process-platform-extraction` | Per-platform worker (Phase A + B) | — |
| `extract-expedia` | Dedicated Expedia extractor | Tier A |
| `extract-booking` | Dedicated Booking.com extractor | Tier A |
| `extract-vrbo` | Dedicated VRBO extractor | Tier A |
| `extract-agoda` | Dedicated Agoda extractor | Tier A |
| `extract-hotelscom` | Dedicated Hotels.com extractor | Tier A |
| `finalize-search-snapshot` | Snapshot builder | — |
| `tier-a-retry-worker` | Background retry for Tier A | — |
| `skip-stuck-extractions` | Anti-stuck heartbeat worker | — |
| `search-finalization-watchdog` | Orphan recovery | — |

**Shared Modules** (`supabase/functions/_shared/`):

| Module | Purpose |
|--------|---------|
| `buildFinalSnapshot.ts` | Snapshot construction and result categorization |
| `browserlessGate.ts` | Distributed concurrency control (advisory lock `8675309`) |
| `tierARetryPolicy.ts` | Retry logic for Tier A platforms |
| `priceClassification.ts` | Price type determination |
| `platformNameNormalizer.ts` | Platform name standardization |

### 2.3 Database

| Component | Technology |
|-----------|------------|
| Type | PostgreSQL (Supabase) |
| Realtime | Supabase Realtime (postgres_changes) |
| RLS | Enabled on all user tables |

**Key Tables**:

| Table | Purpose | Key Fields |
|-------|---------|------------|
| `searches` | Search metadata, Airbnb baseline, final snapshot | `airbnb_price`, `finalised_at`, `final_results_snapshot` |
| `search_platforms` | Verified platform matches (AUTHORITATIVE) | `confidence_score`, `extraction_status_terminal`, `outcome_category` |
| `price_extractions` | Per-platform extraction state and results | `extraction_status`, `extracted_price`, `dates_validated`, `tier_a_state` |
| `search_stage_runs` | Stage telemetry | `stage_name`, `duration_ms` (sparsely populated) |
| `platform_adapters` | Platform configuration and tiers | `coverage_tier`, `dedicated_extractor` |
| `blocked_platforms` | Admin blocklist | `domain`, `reason` |

### 2.4 AI Models in Use

| Model | Provider | Endpoint | Purpose |
|-------|----------|----------|---------|
| `google/gemini-2.5-flash` | Google (via Lovable AI Gateway) | `https://ai.gateway.lovable.dev/v1/chat/completions` | Image verification, price extraction assist |

**Models NOT Used**:
- ❌ OpenAI GPT (any version)
- ❌ Anthropic Claude (any version)
- ❌ Any other AI provider

---

## 3. External APIs & Services

### 3.1 SerpAPI (Google Lens)

| Attribute | Value |
|-----------|-------|
| **Purpose** | Visual reverse image search for property discovery |
| **Called From** | `search-alternatives` edge function |
| **Input** | Airbnb property image URLs (up to 5 images) |
| **Output** | Array of visually similar images with source URLs |
| **Constraints** | Rate limited; budget allocation: MAX_AI = 65, MAX_CANDIDATES_PER_IMAGE = 50 |

**Discovery Flow**:
1. Each Airbnb image is sent to Google Lens
2. Results are filtered to known booking platform domains
3. Blocked platforms are rejected at discovery phase
4. Candidates proceed to AI verification

### 3.2 Browserless

| Attribute | Value |
|-----------|-------|
| **Purpose** | JavaScript-rendered page access for price extraction |
| **Called From** | Airbnb baseline, dedicated extractors |
| **Input** | URLs requiring JS rendering |
| **Output** | Rendered HTML, screenshots |
| **Global Concurrency Limit** | **1 concurrent session** |
| **Advisory Lock Key** | `8675309` (Postgres `pg_advisory_lock`) |
| **Max Retries** | **3** (not 4) |
| **Backoff Sequence** | 2s, 4s, 8s (with jitter 200-800ms) |
| **Lock Timeout** | 60 seconds |
| **Request Timeout** | 60-90 seconds |

**Rate Limit Classification**:
- HTTP 429 → `rate_limited` with reason `browserless_429`
- Bot detection → `access_blocked` (different classification)

### 3.3 Firecrawl

| Attribute | Value |
|-----------|-------|
| **Purpose** | Primary web scraping provider |
| **Called From** | All extractors (first in fallback chain) |
| **Input** | Platform URLs |
| **Output** | Markdown content, HTML |
| **Fallback Trigger** | 403, timeout, 500 errors |
| **Secret Names** | `FIRECRAWL_API_KEY`, `FIRECRAWL_API_KEY_1` (managed) |

### 3.4 Zyte

| Attribute | Value |
|-----------|-------|
| **Purpose** | Fallback scraping with browser rendering |
| **Called From** | Extractors (when Firecrawl fails with 403/timeout) |
| **Input** | Platform URLs |
| **Output** | Rendered HTML |
| **Timeout** | 60 seconds |
| **Browser Rendering** | Enabled for Airbnb specifically |

**Zyte Fallback Triggers**:
- Firecrawl 403 (forbidden)
- Firecrawl timeout
- Firecrawl 500 errors

### 3.5 Resend

| Attribute | Value |
|-----------|-------|
| **Purpose** | Transactional email delivery |
| **Called From** | Auth flows, notifications |
| **Input** | Email content, recipient |
| **Output** | Delivery status |

---

## 4. AI Image Verification System

### 4.1 Core Principle: Visual-Only Matching

**The system uses PURELY VISUAL matching.** Text similarity, property names, and location data are explicitly NOT used for matching decisions.

```typescript
// Core Product Principle (Non-Negotiable):
// The platform exists to identify the same property using reverse image search.
// If images do not clearly match with high probability, the candidate is NOT
// a valid alternative, regardless of text similarity, naming, or location.
```

### 4.2 Two-Pass Verification System

The system implements a **Two-Pass Verification** architecture for image matching:

| Pass | Purpose | Threshold | Prompt Style |
|------|---------|-----------|--------------|
| **PASS 1** | Discovery gate (high recall) | ≥75% (ImageGate) | "Balanced Identity Verification" |
| **PASS 2** | Authority gate (high precision) | ≥90% (Authoritative) | "Skeptical Forensic Analyst" |

**Decision Matrix**:

| PASS 1 Score | PASS 2 Score | Outcome | UI Badge |
|--------------|--------------|---------|----------|
| < 75% | — | **REJECTED** (not shown) | — |
| ≥ 75%, < 90% | < 90% | **DISCOVERED** (shown, needs review) | "Needs Review" (amber) |
| ≥ 90% | — | **AUTHORITATIVE** (high trust) | "Verified" (green) |
| ≥ 75%, < 90% | ≥ 90% | **AUTHORITATIVE** (confirmed by PASS 2) | "Verified" (green) |

### 4.3 PASS 1: Balanced Identity Verification

**Model**: `google/gemini-2.5-flash`  
**Timeout**: 30 seconds

**Prompt Focus** - Fixed Structural Elements:
- Stone fireplace patterns ("unique like fingerprints")
- Ceiling beam layout and spacing
- Window positions and frame styles
- Kitchen cabinet layout and counter shape
- Floor material and pattern
- Built-in architectural features

**What PASS 1 Explicitly IGNORES**:
- Different camera angles
- Different lighting conditions
- Furniture/staging changes
- Cropped versions of same image

**Scoring Guide**:
```
90-100%: Clearly same property - Multiple structural elements match exactly
75-89%:  Very likely same property - Key structural elements match, minor differences
60-74%:  Uncertain - Some structural similarities but can't confirm
40-59%:  Unlikely same property - Style similar but structural elements differ
0-39%:   Different properties - Clear structural differences
```

### 4.4 PASS 2: Adversarial Verification

**Model**: `google/gemini-2.5-flash`  
**Timeout**: 30 seconds

**Prompt Philosophy**: Skeptical forensic analyst whose **DEFAULT assumption is DIFFERENT properties**.

**Adversarial Rules**:
1. Default verdict is: NOT THE SAME PROPERTY
2. Must actively search for ANY structural differences
3. If ANY structural/layout difference found → verdict: NOT SAME
4. If structural evidence is insufficient in EITHER image → verdict: NOT SAME
5. Only conclude SAME if multiple fixed structural anchors clearly match

**Structural Differences to Detect**:
- Different window positions, sizes, or counts
- Different room shape or wall angles
- Different ceiling height or features
- Different door placements
- Different floor plan or layout
- Different architectural details (columns, beams, moldings)
- Different flooring type or pattern

**Evidence Requirements for "SAME" Verdict**:
- At least 3 matching fixed structural features clearly visible in both images
- No contradicting structural evidence
- Same room type and viewpoint

### 4.5 Image Optimization

Images are fetched once in PASS 1 and reused in PASS 2 to avoid duplicate network requests:

```typescript
// REUSE encoded images from PASS 1 (avoids duplicate fetch/encode)
const { airbnbDataUrl, altDataUrl, airbnbUrlHash, altUrlHash } = pass1.encodedImages;
```

### 4.6 AI Confidence Value Characteristics

**CRITICAL: AI confidence values are DISCRETE, not continuous 0-100.**

Observed clustering:
- `0` — No match / unable to compare
- `30` — Low confidence / uncertain
- `95-98` — High confidence match

The system does NOT produce evenly distributed values. Thresholds account for this bucketing behavior.

### 4.7 Text Search: Visual-Gated Only

The `addTargetedTextMatches()` function performs text-based property searches but:
- Results are **NEVER added directly** to alternatives
- Results only surface if they **pass 90%+ visual AI verification**
- This is strictly enforced:

```typescript
// STRICT: Only high-confidence visual matches (90%+) are valid
if (ai.isMatch && ai.score >= 90) {
  // This is the ONLY path where text search can produce a result
  opts.alternatives.push({
    match_type: 'visual', // CRITICAL: Must be 'visual' since AI verified it
    ...
  });
}
```

---

## 5. Search Lifecycle

### 5.1 Logical Stages (As Designed)

The system was designed with 6 logical stages:

| Stage | Purpose | Typical Time |
|-------|---------|--------------|
| `analyze_listing` | Parse Airbnb URL, extract baseline price | 5-12s |
| `collect_photos` | Download Airbnb property images | 3-8s |
| `find_matches` | Visual search via Google Lens + AI verification | 15-35s |
| `validate_dates` | Apply dates to platform deep links (Phase A) | 8-20s |
| `collect_prices` | Extract prices from platforms (Phase B) | 12-30s |
| `finalize_results` | Build and persist immutable snapshot | 2-5s |

### 5.2 Observable Stages (As Actually Visible)

**Only ONE stage is currently observable in telemetry: `analyze_listing`**

The `search_stage_runs` table contains rows only for `analyze_listing`. All other stages execute but do not write telemetry records.

**Implication**: Stage progress cannot be reliably determined from `search_stage_runs` alone. This is the current state, not a bug.

### 5.3 Complete Execution Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. USER SUBMITS AIRBNB URL                                                  │
│    └─> search-alternatives edge function invoked                            │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│ 2. URL VALIDATION                                                           │
│    ├─> Normalize URL (airbnb-url-normalizer)                                │
│    │   - /rooms/ URLs → /book/stays/ (checkout page for total price)       │
│    │   - Fixed parameter order: checkin, checkout, numberOfAdults...        │
│    ├─> Extract dates from query params (check_in, check_out)                │
│    └─> FAIL if dates missing or invalid                                     │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│ 3. AIRBNB BASELINE EXTRACTION (GATING - MANDATORY)                          │
│    ├─> Provider chain: Firecrawl → Zyte (fallback on 403)                   │
│    ├─> Browserless for JS-rendered checkout page (if needed)               │
│    ├─> Extract total stay price (regex + AI fallback)                       │
│    │   - Priority patterns: "Pay $X now", "Total (USD) $X"                  │
│    │   - Must include taxes and fees                                        │
│    ├─> ★ FAIL ENTIRE SEARCH if baseline cannot be extracted ★               │
│    │   - Error codes: airbnb_blocked_or_captcha, airbnb_total_not_visible  │
│    └─> Store in searches.airbnb_price                                       │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│ 4. IMAGE COLLECTION                                                          │
│    ├─> Zyte fetches /rooms/ page (property page, not checkout)              │
│    │   - Ensures property-specific imagery (not checkout UI elements)       │
│    └─> Store in searches.airbnb_images (up to 5 images)                     │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│ 5. VISUAL DISCOVERY (Google Lens via SerpAPI)                               │
│    ├─> For each Airbnb image (up to 5):                                     │
│    │   └─> Send to Google Lens reverse image search                         │
│    ├─> Budget allocation:                                                    │
│    │   - MAX_AI = 65 total calls                                            │
│    │   - MAX_CANDIDATES_PER_IMAGE = 50                                      │
│    │   - TARGET_VISUAL_MATCHES = 15                                         │
│    │   - Hard reserve: 6 calls for late images                              │
│    │   - Image 1 can use up to 70% of available calls                       │
│    ├─> Filter results to known platform domains                             │
│    ├─> Check against blocked_platforms table                                │
│    │   - Domains normalized: strip protocol, www., trailing slashes         │
│    └─> Create candidates for AI verification                                │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│ 6. AI IMAGE VERIFICATION (Two-Pass System)                                   │
│    ├─> For each candidate (Google Lens result):                             │
│    │                                                                         │
│    │   PASS 1: Discovery Gate (Balanced Identity Verification)              │
│    │   ├─> Compare Airbnb image to candidate image                          │
│    │   ├─> Focus on fixed structural elements                               │
│    │   ├─> Threshold: 75% (ImageGate)                                       │
│    │   ├─> < 75% → REJECTED (not persisted)                                 │
│    │   └─> ≥ 75% → Proceed to PASS 2                                        │
│    │                                                                         │
│    │   PASS 2: Authority Gate (Adversarial Verification)                    │
│    │   ├─> Reuse encoded images from PASS 1 (no re-fetch)                   │
│    │   ├─> Skeptical forensic analyst prompt                                │
│    │   ├─> Default assumption: DIFFERENT properties                         │
│    │   ├─> Threshold: 90% (Authoritative)                                   │
│    │   ├─> < 90% → DISCOVERED but "Needs Review"                            │
│    │   └─> ≥ 90% → AUTHORITATIVE                                            │
│    │                                                                         │
│    ├─> Optimization: Skip verification for platforms already matched ≥75%  │
│    └─> Create search_platforms rows for verified candidates                 │
│        - confidence_score: final verification score                         │
│        - is_authoritative: true if PASS 1 ≥ 90% OR PASS 2 ≥ 90%            │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│ 7. PRICE EXTRACTION PIPELINE (Parallel Execution)                            │
│    ├─> run-price-pipeline creates price_extractions rows                    │
│    ├─> Concurrency limit: 3 parallel extractions                            │
│    ├─> Immediate trigger: As soon as platform verified (≥75%), enqueue     │
│    │                                                                         │
│    │   PHASE A: Date Application                                            │
│    │   ├─> Generate deep link with dates applied                            │
│    │   ├─> Fetch page (Firecrawl → Zyte fallback)                           │
│    │   ├─> Validate dates actually took effect on page                      │
│    │   ├─> Check for sold out / unavailable signals                         │
│    │   └─> dates_validated = true if detected dates match requested         │
│    │                                                                         │
│    │   PHASE B: Price Extraction (only if Phase A passed)                   │
│    │   ├─> Extract total stay price from DOM/regex                          │
│    │   ├─> Validate price type (TOTAL_STAY vs NIGHTLY)                      │
│    │   ├─> Check for taxes/fees inclusion                                   │
│    │   └─> Persist extracted_price, price_type, includes_taxes_fees         │
│    │                                                                         │
│    ├─> Tier A platforms get retry logic:                                    │
│    │   - Max 4 attempts (tier_a_attempt_count)                              │
│    │   - State machine: tier_a_state                                        │
│    │   - Backoff: tier_a_next_retry_at                                      │
│    │                                                                         │
│    └─> Every platform reaches terminal state OR timeout                     │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│ 8. FINALIZATION (Atomic Operation)                                           │
│    ├─> Trigger: All Tier A platforms terminal (lower tiers non-blocking)   │
│    ├─> finalize-search-snapshot or finalizeAndCompleteSearch helper         │
│    │                                                                         │
│    │   Snapshot Construction:                                               │
│    │   ├─> Read from search_platforms (AUTHORITATIVE set)                   │
│    │   ├─> Join with price_extractions for pricing data                     │
│    │   ├─> Compute canonical_price for each result                          │
│    │   ├─> Categorize into buckets (cheaper, more_expensive, etc.)          │
│    │   ├─> Generate dynamic bucket labels                                   │
│    │   └─> Build final_results_snapshot (version 2)                         │
│    │                                                                         │
│    │   Atomic Write:                                                        │
│    │   ├─> Persist final_results_snapshot + finalised_at together           │
│    │   ├─> Set status = 'completed'                                         │
│    │   └─> If fails: status = 'finalization_failed' with error payload      │
│    │                                                                         │
│    └─> Results are now IMMUTABLE                                            │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 5.4 Platform Blocking

The system maintains a dynamic blocklist (`blocked_platforms` table):

```typescript
// Domains normalized to bare form: tripadvisor.com (no protocol, www, or trailing slash)
// Blocking enforced at TWO phases:
// 1. Discovery phase (Visual, Knowledge Graph, legacy JSON paths)
// 2. Verification phase (Image Match)
// Blocked listings are immediately rejected and never created as candidates
```

---

## 6. Price Extraction Pipeline

### 6.1 Platform Tiers

| Tier | Platforms | Characteristics |
|------|-----------|-----------------|
| **A** | Expedia, Booking.com, VRBO, Agoda, Hotels.com | Dedicated extractors, retry logic, priority |
| **B** | Most other booking platforms | Generic extraction, no retry |
| **C** | Blocked platforms | Immediately rejected |

### 6.2 Dedicated Extractors (Tier A)

Each Tier A platform has a dedicated edge function:

| Extractor | Platform | Key Features |
|-----------|----------|--------------|
| `extract-expedia` | Expedia | Offers page navigation, TOTAL_PROVEN verification |
| `extract-booking` | Booking.com | Diagnose-first funnel, VAT handling, checkout navigation |
| `extract-vrbo` | VRBO | success_total_stay status, drawer-based flows |
| `extract-agoda` | Agoda | /book/ link detection, checkout page navigation |
| `extract-hotelscom` | Hotels.com | (Effectively non-functional - high failure rate) |

### 6.3 Two-Phase Enforcement

**Phase A: Date Application and Validation**
```typescript
// Purpose: Verify that requested dates are actually applied on the platform
// - Generate deep link with dates in URL parameters
// - Fetch rendered page
// - Extract detected check-in/check-out from page content
// - Compare against requested dates
// - dates_validated = true ONLY if dates match
```

**Phase B: Price Extraction**
```typescript
// Purpose: Extract the total stay price
// - Only runs if Phase A succeeded (dates_validated = true)
// - DOM/regex-based extraction (not AI)
// - Validates price_type (TOTAL_STAY, NIGHTLY, etc.)
// - Checks includes_taxes_fees
// - Persists extracted_price, currency, confidence
```

### 6.4 Tier A Retry Logic

Tier A platforms use a durable retry driver:

| Field | Purpose |
|-------|---------|
| `tier_a_attempt_count` | Current attempt number (max: 4) |
| `tier_a_state` | State machine: pending, running, success, failed |
| `tier_a_next_retry_at` | Scheduled retry time with backoff |
| `tier_a_last_transient_reason` | Reason for last transient failure |

**Success Invariant**: Retries only stop when BOTH:
1. Verified success status is achieved
2. Price is confirmed (including DB re-check)

### 6.5 Anti-Stuck System

The pipeline uses tier-aware heartbeat monitoring:

**Tier A Platforms**:
- High patience: 4 min running / 2 min queue / 90s retry grace
- Rescheduled/retried if attempts remain

**Lower Tiers (B/C)**:
- Aggressive skip: 90s running / 45s queue
- Immediately skipped to `service_error` (stalled_timeout)

**Finalization Gating**:
- Only Tier A platforms block finalization
- Slow/stalled lower-tier platforms are auto-skipped

### 6.6 USD-First Strategy

All Tier A extractors implement "USD-first" extraction:

```typescript
// 1. Attempt to force USD pricing via URL parameters and locale settings
// 2. Rewrite international paths (e.g., /en-ca/ → US root)
// 3. If USD fails, capture local currency
// 4. Non-USD prices categorized as "Match Found - Price Not Comparable"
// 5. Display foreign amount as evidence with dynamic label
```

---

## 7. Finalization & Snapshot Architecture

### 7.1 Atomic Finalization Invariant

```typescript
// CRITICAL INVARIANT:
// status = 'completed' is ONLY set when snapshot persistence succeeds
// If snapshot fails, status = 'finalization_failed' with error details
// Once finalised_at is set, the snapshot is immutable
```

### 7.2 Snapshot Structure (Version 2)

```typescript
interface FinalSnapshot {
  version: 2;                    // Current version (not 4)
  generated_at: string;          // ISO timestamp
  search_id: string;
  airbnb: {
    price: number | null;
    currency: string | null;
    title: string | null;
  };
  dates: {
    check_in: string | null;
    check_out: string | null;
    nights: number | null;
  };
  results: FinalResultRow[];     // Categorized results with frozen buckets
  result_count: number;
  expected_platform_count: number;
  finalized_platform_count: number;
  render_debug: {
    candidates_total_after_merge: number;
    candidates_rendered: number;
    included_platform_keys: string[];
    excluded_platform_keys: string[]; // Must always be empty
  };
}
```

### 7.3 Result Row Structure

Each result in the snapshot contains:

```typescript
interface FinalResultRow {
  // Identity
  id: string;
  platform_name: string;
  listing_url: string;
  listing_title: string | null;
  
  // Pricing
  price: number | null;
  original_price: number | null;
  savings_amount: number | null;
  savings_percentage: number | null;
  
  // Verification
  confidence_score: number | null;
  is_authoritative: boolean;        // PASS 2 >= 90%
  
  // Extraction metadata
  extraction_status: string | null;
  extraction_error: string | null;
  canonical_price: Record<string, unknown> | null;
  price_type: string;               // TOTAL_STAY, NIGHTLY, etc.
  includes_taxes_fees: boolean;
  dates_validated: boolean;
  
  // FROZEN BUCKET (determined at finalization, immutable)
  final_bucket: ResultBucket;
  final_bucket_label: string;
  
  // Foreign currency fallback
  original_currency: string | null;
  original_amount: number | null;
  
  // Deep link with dates applied
  deep_link: string | null;
}
```

---

## 8. Result Categorization

### 8.1 Result Buckets

Results are categorized into mutually exclusive buckets:

| Bucket | Description | Icon | Color |
|--------|-------------|------|-------|
| `cheaper` | Found and cheaper than Airbnb | TrendingDown | success |
| `more_expensive` | Found but more expensive | TrendingUp | muted |
| `not_comparable` | Price found but not comparable | ArrowLeftRight | warning |
| `sold_out` | Unavailable for selected dates | Calendar | muted |
| `price_not_found` | Price couldn't be extracted | DollarSign | warning |
| `blocked` | Access was blocked (captcha/bot) | Ban | error |
| `requires_action` | Requires user action (login, etc.) | Lock | warning |
| `service_error` | Temporary error (timeout, 5xx) | AlertTriangle | error |
| `platform_blocked` | Tier C / not supported | Ban | muted |
| `additional_issues` | Unmapped terminal outcomes | HelpCircle | warning |

### 8.2 Categorization Logic

```typescript
// Order of evaluation:
1. Tier C platforms → platform_blocked
2. outcome_category === 'unavailable_for_dates' → sold_out
3. outcome_category === 'access_blocked' → blocked
4. outcome_category === 'requires_action' → requires_action
5. outcome_category === 'service_error' → service_error
6. Sold out extraction statuses → sold_out
7. No price:
   - Known "price not found" statuses → price_not_found
   - Service error statuses → service_error
   - Unknown terminal status → price_not_found (safe default)
8. Has price but not comparable → not_comparable
9. Has comparable price:
   - Lower than Airbnb → cheaper
   - Higher or equal → more_expensive
```

### 8.3 Price Comparability Rules

A price is only comparable if ALL conditions are met:

| Condition | Requirement |
|-----------|-------------|
| Currency | Same as Airbnb (USD) |
| Date Range | Matches requested dates |
| Nights Count | Matches requested duration |
| Price Type | `total_proven` OR `total_derived` |
| Taxes/Fees | Included |

**Non-comparable results display**:
- Currency mismatch: "Price in CAD (not comparable)"
- Subtotal only: "Subtotal only (taxes not included)"
- Dates not confirmed: "Dates not confirmed"

### 8.4 Price Type Hierarchy

```typescript
type PriceType = 
  | 'total_proven'        // Highest trust - structural verification passed
  | 'total_derived'       // Inferred total with taxes/fees
  | 'subtotal_nights_only'// Accommodation only, no taxes
  | 'nightly_only'        // Per-night rate, not total
  | 'unknown';            // Cannot determine
```

---

## 9. Terminal States

### 9.1 Search-Level Terminal Statuses

Defined in `src/lib/pipelineStages.ts`:

```typescript
const TERMINAL_STATUSES = [
  'completed',           // Success - all platforms processed
  'done',                // Alias for completed
  'error',               // Fatal pipeline error
  'failed',              // Fatal pipeline error (legacy)
  'cancelled',           // User cancelled the search
  'price_unavailable',   // No prices could be extracted
  'dates_unavailable',   // Listing not available for dates
  'finalization_failed', // Snapshot persistence failed
];
```

### 9.2 Extraction-Level Terminal Statuses

Each `price_extractions` row reaches one of:

| Category | Statuses |
|----------|----------|
| **Success** | `success`, `success_total_stay`, `price_extracted` |
| **Sold Out** | `dates_unavailable`, `sold_out`, `no_availability_for_dates` |
| **Access Blocked** | `blocked_captcha_or_bot`, `blocked_captcha`, `bot_blocked_abort` |
| **Rate Limited** | `rate_limited`, `blocked_rate_limit`, `browserless_429` |
| **Service Error** | `service_error`, `timeout`, `retry_budget_exhausted` |
| **Price Not Found** | `price_not_found`, `checkout_link_not_found`, `total_price_not_found` |
| **Platform Unsupported** | `platform_unsupported`, `blocked` |

### 9.3 Dominant Outcome: `platform_unsupported`

**~32% of extractions terminate as `platform_unsupported`.**

This is the single most common non-success outcome. It occurs when:
- Platform has no dedicated extractor
- Platform adapter is inactive or misconfigured
- Platform domain variant is not recognized

### 9.4 Tier A Platform Reliability (Observed Reality)

Despite being classified as Tier A (highest priority), these platforms show variable success rates:

| Platform | Observed Behavior |
|----------|-------------------|
| **Expedia** | Frequently returns `service_error` after exhausting retries |
| **Hotels.com** | Often returns `platform_unsupported` (effectively non-functional) |
| **Booking.com** | Most reliable of Tier A |
| **VRBO** | Variable success rate |
| **Agoda** | Moderate reliability |

---

## 10. Stage Determination

### 10.1 Why "Current Stage" Is Not a First-Class Concept

- **No canonical `current_stage` field** exists anywhere in the system
- `searches.status` contains pipeline status values but these do not map 1:1 to the 6 logical stages
- Stage telemetry (`search_stage_runs`) is sparsely populated - **only `analyze_listing` is reliably written**

### 10.2 Available Signals for Stage Inference

| Signal | Location | What It Indicates |
|--------|----------|-------------------|
| `searches.status` | `searches` table | High-level pipeline phase |
| `searches.airbnb_price` | `searches` table | Baseline extraction complete if > 0 |
| `searches.airbnb_images` | `searches` table | Image collection complete if populated |
| `search_platforms` count | `search_platforms` table | Discovery complete if > 0 rows exist |
| `price_extractions` statuses | `price_extractions` table | Extraction progress per platform |
| `searches.finalised_at` | `searches` table | Finalization complete if non-null |
| `search_stage_runs` | `search_stage_runs` table | **Only `analyze_listing` is observable** |

### 10.3 Deterministic Stage Inference Table

| Evidence | Inferred Stage | Confidence | Meaning |
|----------|----------------|------------|---------|
| `status = 'pending'` AND no `airbnb_price` | `analyze_listing` | High | Search just started |
| `airbnb_price > 0` AND `airbnb_images` empty | `collect_photos` | Medium | Baseline done, collecting images |
| `airbnb_images` populated AND no `search_platforms` rows | `find_matches` | Medium | Images ready, discovery in progress |
| `search_platforms` rows exist AND all `price_extractions` pending | `validate_dates` | Medium | Discovery done, extraction starting |
| Some `price_extractions` have non-pending status | `collect_prices` | High | Extraction in progress |
| All `price_extractions` terminal AND `finalised_at` null | `finalize_results` | High | Awaiting finalization |
| `finalised_at` non-null | Complete | High | Search fully finished |

### 10.4 Stage Inference Code

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

### 10.5 Status Values → Pipeline Phases

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

## 11. Known Limitations

### 11.1 Telemetry Gaps

- **Only `analyze_listing` stage writes to `search_stage_runs`**
- No telemetry for: `collect_photos`, `find_matches`, `validate_dates`, `collect_prices`, `finalize_results`
- Stage timing estimates use hardcoded fallbacks, not real telemetry
- This is incomplete by design today

### 11.2 Snapshot Version

The current `final_results_snapshot` schema is **version 2** (not 4 as some code comments suggest).

### 11.3 Browserless Constraints

| Constraint | Value |
|------------|-------|
| Global concurrency limit | 1 concurrent session |
| Advisory lock key | `8675309` |
| Retry count | **3** (not 4) |
| Backoff sequence | 2s, 4s, 8s |
| Lock timeout | 60 seconds |

### 11.4 Platform Extraction Reality

- Tier A classification does NOT guarantee extraction success
- Dedicated extractors exist but may fail due to site changes
- Hotels.com extractor is effectively non-functional
- `platform_adapters.is_active` may not reflect actual extractability

### 11.5 Price Verification Constraints

A price is only marked "verified" if ALL conditions are met:
- `extraction_status` is success variant
- `price_type` is `TOTAL_STAY` or `NIGHTLY_BREAKDOWN`
- `includes_taxes_fees` is true OR `breakdown_found` metadata is true
- `dates_validated` is true OR detected dates match requested dates

If any condition fails, the price is "unverified" and marked for manual check.

### 11.6 Currency Assumptions

- All prices assumed USD unless explicitly tagged
- No currency conversion performed
- Cross-currency comparisons are not supported (categorized as `not_comparable`)

### 11.7 Date Handling

- Dates ONLY derived from Airbnb URL query parameters
- Manual date input is not supported
- If Airbnb URL lacks `check_in`/`check_out` params, search fails

### 11.8 Finalization Atomicity

`finalised_at` and `final_results_snapshot` are written atomically.

If `finalised_at` is non-null, the snapshot is guaranteed to exist and be immutable.

If snapshot building fails, search status becomes `finalization_failed` with error details in `searches.finalization_error`.

### 11.9 No Canonical Current Stage Field

There is no `current_stage` column. Stage must be inferred from multiple signals as described in Section 10.

---

## Appendices

### Appendix A: Quick Reference Code

#### Terminal Status Check

```typescript
import { isTerminalStatus } from '@/lib/pipelineStages';

if (isTerminalStatus(search.status)) {
  // Search is complete, use snapshot
}
```

#### Stage Inference

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

#### Extraction Terminal Check

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

### Appendix B: File Reference

#### Edge Functions (Critical Path)

| File | Purpose |
|------|---------|
| `supabase/functions/search-alternatives/index.ts` | Main orchestrator (~10,000 lines) |
| `supabase/functions/run-price-pipeline/index.ts` | Extraction dispatcher |
| `supabase/functions/process-platform-extraction/index.ts` | Per-platform worker |
| `supabase/functions/finalize-search-snapshot/index.ts` | Snapshot builder |
| `supabase/functions/_shared/buildFinalSnapshot.ts` | Snapshot assembly (~1,300 lines) |
| `supabase/functions/_shared/browserlessGate.ts` | Concurrency control (~570 lines) |
| `supabase/functions/_shared/tierARetryPolicy.ts` | Retry logic |

#### Dedicated Extractors

| File | Platform |
|------|----------|
| `supabase/functions/extract-expedia/index.ts` | Expedia |
| `supabase/functions/extract-booking/index.ts` | Booking.com |
| `supabase/functions/extract-vrbo/index.ts` | VRBO |
| `supabase/functions/extract-agoda/index.ts` | Agoda |
| `supabase/functions/extract-hotelscom/index.ts` | Hotels.com |

#### Frontend (Critical Path)

| File | Purpose |
|------|---------|
| `src/pages/SearchResults.tsx` | Results page (snapshot renderer) |
| `src/hooks/useExtractionProgressRealtime.ts` | Realtime progress |
| `src/hooks/useFinalizedSnapshot.ts` | Snapshot fetching |
| `src/lib/pipelineStages.ts` | Stage definitions, terminal statuses |
| `src/lib/resultCategorization.ts` | Result bucket assignment (~580 lines) |
| `src/lib/extractionOutcomeTaxonomy.ts` | Status-to-category mapping (~560 lines) |
| `src/lib/canonicalPrice.ts` | Price comparability model |

### Appendix C: Database Schema (Key Tables)

#### searches
```sql
id, user_id, airbnb_url, airbnb_title, airbnb_price, airbnb_currency,
airbnb_images, check_in_date, check_out_date, nights_count,
status, finalised_at, final_results_snapshot, finalization_error,
activity_log, created_at, updated_at
```

#### search_platforms
```sql
id, search_id, platform_name, listing_url, listing_title,
images, confidence_score, match_type, extraction_id_latest,
extraction_status_terminal, outcome_category, matched_at, updated_at
```

#### price_extractions
```sql
id, search_id, platform_name, deep_link, extracted_price, currency,
extraction_status, extraction_error, extraction_stage, extraction_metadata,
dates_validated, detected_checkin, detected_checkout,
includes_taxes_fees, confidence_score, price_type, provider_used,
tier_a_state, tier_a_attempt_count, tier_a_next_retry_at,
created_at, updated_at
```

#### search_stage_runs
```sql
id, search_id, stage_name, started_at, finished_at, duration_ms,
outcome_status, error_message, metadata, created_at
```
Note: Only `analyze_listing` is reliably populated.

---

**END OF DOCUMENT**

*This document reflects observed system behavior as of 2026-02-04. It does not represent design intent, future plans, or recommendations.*
