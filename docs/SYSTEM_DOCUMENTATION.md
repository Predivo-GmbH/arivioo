# Arivioo System Documentation

**Version**: 2.0.0  
**Last Updated**: 2026-02-04  
**Purpose**: Complete technical reference for AI agents (Cursor) and human developers

---

## 1. System Purpose

### What the System Does

Arivioo is an automated price comparison system for vacation rentals. Given an Airbnb listing URL with specific dates, the system:

1. Extracts the total stay price from Airbnb (including taxes and fees)
2. Discovers the same property on alternative booking platforms via visual reverse image search
3. Verifies matches using AI-powered image comparison
4. Extracts verified total prices from each alternative platform
5. Presents a comparison showing potential savings

The core requirement is **fully automated, reliable, and explainable price comparison** with no manual intervention. All extracted prices must be real, comparable, and grounded in actual page content.

### What the System Does NOT Do

- Does NOT convert currencies (prices must be in USD to be comparable)
- Does NOT use AI to extract or interpret prices (uses DOM parsing and regex only)
- Does NOT allow manual user intervention during the search pipeline
- Does NOT display results until the search is fully finalized
- Does NOT re-compute result buckets after finalization (snapshot is immutable)
- Does NOT support platforms outside of its coverage tier system
- Does NOT use OpenAI models (exclusively uses Google Gemini)

---

## 2. Tech Stack Overview

### 2.1 Frontend

| Component | Technology | Notes |
|-----------|------------|-------|
| Framework | React 18.3 with TypeScript | Single-page application |
| Build Tool | Vite | Development and production builds |
| Styling | Tailwind CSS | Semantic design tokens in `index.css` |
| UI Components | shadcn/ui (Radix primitives) | Located in `src/components/ui/` |
| State Management | React hooks + TanStack Query | No Redux or global state store |
| Routing | react-router-dom v6 | Client-side routing |
| Animations | framer-motion | Used for UI transitions |
| Icons | lucide-react | Icon library |

**Key Frontend Files**:
- `src/pages/Dashboard.tsx` - Search input and history display
- `src/pages/SearchResults.tsx` - Results display and real-time progress (4,788 lines)
- `src/lib/pipelineStages.ts` - Pipeline stage definitions and status mapping
- `src/lib/priceVerification.ts` - Price verification logic
- `src/lib/resultCategorization.ts` - Result bucket assignment (frontend mirror)
- `src/lib/canonicalPrice.ts` - Price normalization model
- `src/lib/airbnbUrlNormalizer.ts` - URL normalization (frontend)

### 2.2 Backend

| Component | Technology | Notes |
|-----------|------------|-------|
| Platform | Supabase (Lovable Cloud) | Managed PostgreSQL + Edge Functions |
| Runtime | Deno | Edge Functions execute in Deno runtime |
| Language | TypeScript | All edge functions are TypeScript |
| Execution Model | Request-response | 150-second timeout per function invocation |

### 2.3 Database

| Component | Technology | Notes |
|-----------|------------|-------|
| Type | PostgreSQL | Supabase-managed |
| ORM | None | Raw SQL via Supabase client |
| Realtime | Supabase Realtime | postgres_changes for live updates |
| RLS | Enabled | Row-level security on all user tables |

**Key Tables**:
- `searches` - Search requests, Airbnb data, status, and final snapshot
- `search_platforms` - Verified platform matches (authoritative set)
- `price_extractions` - Extraction attempts, statuses, and results
- `platform_adapters` - Platform configuration and coverage tiers
- `blocked_platforms` - Admin-managed domain blocklist
- `search_stage_runs` - Stage timing telemetry
- `api_request_logs` - Provider request logging for quota tracking

### 2.4 Edge Functions

| Function | Purpose | Approx. Lines |
|----------|---------|---------------|
| `search-alternatives` | Main orchestrator - Airbnb baseline, discovery, verification, extraction triggers | ~10,153 |
| `process-platform-extraction` | Per-platform worker (Phase A + B) | ~1,614 |
| `finalize-search-snapshot` | Snapshot persistence endpoint (called by orchestrator) | ~115 |
| `extract-expedia` | Expedia dedicated extractor (Tier A) | ~2,602 |
| `extract-booking` | Booking.com dedicated extractor (Tier A) | - |
| `extract-agoda` | Agoda dedicated extractor (Tier A) | - |
| `extract-vrbo` | VRBO dedicated extractor (Tier A) | - |
| `extract-airpaz` | Airpaz dedicated extractor | - |
| `extract-hotelscom` | Hotels.com dedicated extractor | - |
| `extract-prices` | Generic Firecrawl/Zyte extractor (Tier B) | - |
| `validate-dates` | Phase A date validation | - |
| `airbnb-url-normalizer` | URL normalization service | - |
| `tier-a-retry-worker` | Background retry for Tier A platforms | - |
| `skip-stuck-extractions` | Anti-stuck watchdog | - |
| `search-finalization-watchdog` | Orphan search recovery | - |

**Shared Modules** (`supabase/functions/_shared/`):
- `buildFinalSnapshot.ts` - Snapshot construction and result categorization (~1,338 lines)
- `browserlessGate.ts` - Distributed concurrency control for Browserless
- `tierARetryPolicy.ts` - Retry logic for Tier A platforms
- `coverageVariantDetector.ts` - Regional/locale variant detection
- `platformNameNormalizer.ts` - Platform name normalization
- `priceClassification.ts` - Price type classification

### 2.5 Hosting / Infrastructure

- **Frontend**: Lovable CDN (preview and published URLs)
- **Backend**: Supabase Edge Functions (Deno runtime)
- **Database**: Supabase-managed PostgreSQL

---

## 3. External APIs & Services

### 3.1 SerpAPI (Google Lens)

| Aspect | Detail |
|--------|--------|
| **Purpose** | Visual reverse image search to discover property listings on other platforms |
| **Called From** | `search-alternatives/index.ts` |
| **Data In** | Airbnb property image URL |
| **Data Out** | `visual_matches` array with candidate URLs, titles, thumbnails |
| **Constraints** | Rate limited (429 responses possible); used only for discovery phase |
| **Secret** | `SERPAPI_API_KEY` |

**Usage Pattern**:
```
GET https://serpapi.com/search.json?engine=google_lens&url=<airbnb_image_url>&api_key=<key>
```

### 3.2 Browserless

| Aspect | Detail |
|--------|--------|
| **Purpose** | Headless Chrome browser for JavaScript-rendered pages |
| **Called From** | `search-alternatives/index.ts` (Airbnb baseline), dedicated extractors |
| **Data In** | Target URL, custom JavaScript function code |
| **Data Out** | HTML content, screenshots, extracted data via `page.evaluate()` |
| **Constraints** | **Global concurrency limit of 1** (Postgres advisory lock `8675309`); 429 triggers exponential backoff (2s, 4s, 8s, 20s); HTML limit 350k chars; screenshot quality 75% JPEG |
| **Secret** | `BROWSERLESS_API_KEY` |

**Endpoints Used**:
- `https://chrome.browserless.io/function` - Custom function execution
- `https://chrome.browserless.io/content` - Page content retrieval

**Content Validity Gate**: Requires 400+ characters of innerText within 25 seconds.

### 3.3 Firecrawl

| Aspect | Detail |
|--------|--------|
| **Purpose** | Web scraping with automatic JavaScript rendering |
| **Called From** | `extract-prices/index.ts`, `process-platform-extraction/index.ts`, `scrapePriceFromListing()` |
| **Data In** | Target URL, format options (markdown, html, screenshot), wait time |
| **Data Out** | Rendered markdown, HTML, optional screenshot |
| **Constraints** | `waitFor` must be ≤ `timeout/2`; used as primary scraper with Zyte as fallback |
| **Secret** | `FIRECRAWL_API_KEY` / `FIRECRAWL_API_KEY_1` |

### 3.4 Zyte

| Aspect | Detail |
|--------|--------|
| **Purpose** | Browser-based scraping with anti-bot capabilities |
| **Called From** | `search-alternatives/index.ts` (Airbnb fallback), extractors as fallback |
| **Data In** | Target URL with `browserHtml: true`, `javascript: true`, `screenshot: true` |
| **Data Out** | Browser-rendered HTML, screenshot |
| **Constraints** | 60-second timeout; used when Firecrawl fails with 403/timeout/500 |
| **Secret** | `ZYTE_API_KEY` |

**Usage Pattern**:
```json
POST https://api.zyte.com/v1/extract
{
  "url": "...",
  "browserHtml": true,
  "javascript": true,
  "screenshot": true
}
```

### 3.5 Lovable AI Gateway

| Aspect | Detail |
|--------|--------|
| **Purpose** | AI-powered image verification (property matching) |
| **Model Used** | `google/gemini-2.5-flash` (exclusively) |
| **Endpoint** | `https://ai.gateway.lovable.dev/v1/chat/completions` |
| **Called From** | `search-alternatives/index.ts` (verification passes) |
| **Data In** | Two image URLs (Airbnb source + candidate), verification prompt |
| **Data Out** | JSON with confidence score (0-100) and justification |
| **Secret** | `LOVABLE_API_KEY` (auto-provisioned) |

### 3.6 Resend

| Aspect | Detail |
|--------|--------|
| **Purpose** | Transactional email (notifications, password reset) |
| **Called From** | `send-notify-me-email`, `email-hook`, auth functions |
| **Secret** | `RESEND_API_KEY` |

---

## 4. AI Usage Overview

### 4.1 Exact Models Used

| Model | Provider | Location |
|-------|----------|----------|
| `google/gemini-2.5-flash` | Google (via Lovable AI Gateway) | `search-alternatives/index.ts` |

**No other AI models are used.** OpenAI models are NOT used anywhere in the system. Legacy code comments referencing "GPT" are outdated.

### 4.2 Where AI IS Used

| Use Case | Function | Prompt Strategy |
|----------|----------|-----------------|
| **Image Verification PASS 1** | `compareImagesWithAI()` | "Balanced Identity Verification" - focuses on fixed structural elements (geometry, patterns) while tolerating camera angles and lighting |
| **Image Verification PASS 2** | `adversarialImageCheck()` | Adversarial check for high-confidence matches (≥90%) |
| **OCR Visual Reference** (limited) | `extractOcrVisualReference()` | Screenshot OCR for Airbnb checkout totals |

**Verification Logic**:
- PASS 1: Returns confidence score 0-100
- Threshold: ≥75% to proceed to extraction
- If PASS 1 ≥90%: Marked as `is_authoritative: true`
- PASS 2: Adversarial check only runs if PASS 1 ≥90%

**Budget Allocation**:
- `MAX_AI = 50` calls per search
- Hard minimum of 6 calls reserved for late images
- Image 1 can use up to 70% of spendable calls
- Verification skipped for platforms already matched at ≥75%

### 4.3 Where AI is Explicitly NOT Used

| Task | Method Used Instead |
|------|---------------------|
| **Price Extraction** | DOM parsing, regex patterns, structured CSS selectors |
| **Date Validation** | URL parameter inspection, rendered text matching |
| **URL Normalization** | Deterministic string manipulation |
| **Result Categorization** | Rule-based bucket assignment (numeric thresholds) |
| **Platform Matching Decisions** | Numeric confidence thresholds (75%, 90%) |
| **Currency Detection** | Regex pattern matching |

### 4.4 AI Decision Boundaries

**AI IS ALLOWED to**:
- Output a confidence score (0-100) for image similarity
- Provide a brief textual justification for the score

**AI is EXPLICITLY NOT ALLOWED to**:
- Make final match/reject decisions (threshold logic is deterministic)
- Extract or interpret prices
- Validate dates
- Override blocklist rules
- Determine result bucket categorization
- Make any decision that affects the final snapshot

---

## 5. Core System Invariants

These rules MUST NEVER be violated:

### 5.1 Airbnb Baseline Gate

The Airbnb total stay price extraction is the **mandatory gatekeeper**. If extraction fails, the entire search terminates immediately with an explicit error code. No subsequent pipeline stages execute.

**Valid Airbnb Price Statuses**:
- `total_price_including_taxes_and_fees` → Proceed
- `needs_user_confirmation` → Requires user input (currently blocks)
- All other statuses → Search terminates

### 5.2 No Results Until Final

- Search `status = 'completed'` is ONLY set when `final_results_snapshot` persistence succeeds in the same transaction
- Frontend never renders results until `finalised_at` is non-null
- Once finalized, the snapshot is **immutable** - never re-derived, never modified
- If snapshot persistence fails, status becomes `finalization_failed`, NOT `completed`

### 5.3 No Silent Suppression

Every extraction outcome MUST be explicitly surfaced in the UI:
- A platform cannot silently disappear from results
- Terminal states have explicit error panels
- No collapsing distinct failure modes into generic "No Price" labels

### 5.4 Structural Verification Required (Tier A)

A price can ONLY be marked "Verified" (bucket: `cheaper` or `more_expensive`) if:
- `breakdown_found: true`
- `total_label_found: true`
- `rendered_dates_match: true`
- `extracted_from_breakdown_total: true`
- `includes_taxes_fees: true`
- `dates_validated: true`

### 5.5 USD-First Strategy

All Tier A extractors attempt to force USD pricing via URL parameters and locale settings. If extraction returns a foreign currency, the result is categorized as `not_comparable` with explicit currency labeling.

### 5.6 75% ImageGate Threshold

A listing is only considered a valid match if it passes the 75% AI confidence threshold. Matches ≥90% are marked `is_authoritative: true`.

### 5.7 Terminal Status Contract

Every `price_extractions` row MUST end in a terminal status:
```
'success', 'success_total_stay', 'dates_not_applied', 'no_availability_for_dates', 
'blocked_captcha_or_bot', 'blocked_rate_limit', 'render_failed',
'listing_unavailable', 'price_not_found_after_dates_applied',
'total_not_available_pre_checkout', 'validation_error',
'extraction_error', 'timeout', 'platform_unsupported'
```

### 5.8 Authoritative Platform Set

The `search_platforms` table is the authoritative source for matched platforms. Every candidate passing the 75% ImageGate threshold is inserted here. The final snapshot includes ALL platforms from this set, even if price extraction failed.

---

## 6. SEARCH WORKFLOW (Critical Section)

### 6.1 User Submits Airbnb URL

**Location**: `src/pages/Dashboard.tsx`

**Trigger**: User clicks "Compare Prices" button

**Validation Performed** (client-side):
1. URL format validation (URL constructor)
2. Protocol check (http/https only)
3. Domain allowlist check (40+ Airbnb domains)
4. Room ID extraction (`/rooms/<id>` or `/book/stays/<id>`)
5. Date presence check (`check_in` and `check_out` params required)
6. Date format validation (YYYY-MM-DD)
7. Date logic check (checkout > checkin)
8. URL length limit (2048 chars, SSRF protection)

**Failure Handling**: Toast error displayed, search not created

**Success**: Insert row to `searches` table:
```sql
INSERT INTO searches (user_id, airbnb_url, status)
VALUES ($user_id, $url, 'searching')
```

**Navigation**: Redirect to `/search/{searchId}`

### 6.2 Search Orchestration Initialization

**Location**: `supabase/functions/search-alternatives/index.ts`

**Trigger**: Frontend calls edge function with `searchId`

**Data Read**: None (receives searchId from request)

**Data Written**:
```sql
UPDATE searches SET status = 'searching', updated_at = now() WHERE id = $searchId
```

**Stage Telemetry**: Inserts row to `search_stage_runs` with `stage_name = 'analyze_listing'`

### 6.3 Stage 1: Analyze Listing (Airbnb Baseline)

**Trigger**: Immediately after initialization

**Backend Status Progression**: `scraping_airbnb` → `extracting_price`

**Code Execution**:
1. `buildBookStaysUrl()` - Normalizes URL to canonical `/book/stays/<id>` format
2. Provider fallback chain: Firecrawl → Zyte → Browserless

**Browserless Extraction Logic** (primary for Airbnb):
1. Navigate to rooms page first (extract title, images)
2. Navigate to `/book/stays/<id>` page (extract total price)
3. Execute `page.evaluate()` with custom JavaScript:
   - Pattern 1: "Pay $X now" (primary - direct text search)
   - Pattern 2: "Total (USD) $X" (secondary)
   - Subtotal fallback: "$X for N nights"

**Bot Detection**: Checks for captcha indicators, rate limiting patterns in HTML

**Data Extracted**:
- `airbnb_price`: Total stay price (including taxes/fees)
- `airbnb_title`: Property title
- `airbnb_images`: Array of image URLs (up to 5)
- `airbnb_image_url`: Primary image
- `check_in_date`, `check_out_date`, `nights_count`

**Data Written**:
```sql
UPDATE searches SET 
  airbnb_price = $price,
  airbnb_title = $title,
  airbnb_images = $images,
  airbnb_image_url = $primaryImage,
  check_in_date = $checkIn,
  check_out_date = $checkOut,
  nights_count = $nights,
  status = 'extracting_photos'
WHERE id = $searchId
```

**Failure Modes**:
| Status | Meaning | Effect |
|--------|---------|--------|
| `airbnb_blocked_or_captcha` | Bot wall detected | Search terminates |
| `airbnb_total_not_visible` | Price not extractable | Search terminates |
| `dates_unavailable` | Listing unavailable for dates | Search terminates |
| `needs_user_confirmation` | Only subtotal found | Search terminates (currently) |

### 6.4 Stage 2: Collect Photos

**Trigger**: Successful Airbnb baseline extraction

**Backend Status**: `extracting_photos` → `collecting_photos`

**Code Execution**:
- Parse `airbnb_images` from Airbnb page scrape
- Select up to 5 high-quality images (filter by size, type)
- Download/validate image URLs

**Data Written**: Image URLs stored in `searches.airbnb_images` (already done in Stage 1)

**Stage Telemetry**: Updates `search_stage_runs` with duration

### 6.5 Stage 3: Find Matches (Discovery + Verification)

**Trigger**: Photos collected

**Backend Status**: `searching_platforms` → `ai_verifying_*`

#### 6.5.1 Discovery Methods

**SerpAPI Google Lens** (per image, up to 5 images):
```
GET https://serpapi.com/search?engine=google_lens&url=<image_url>
```

- Process `visual_matches` from response
- Extract candidates with: URL, title, thumbnail
- Also extract from `knowledge_graph` section

**Candidate Filtering**:
1. URL validation (must be valid HTTP/HTTPS)
2. Domain extraction and normalization
3. Blocklist check against `blocked_platforms` table
4. Deduplication by domain

#### 6.5.2 AI Image Verification

**For Each Candidate** (subject to budget limits):

**PASS 1 - Balanced Identity Verification**:
```typescript
const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
  body: JSON.stringify({
    model: "google/gemini-2.5-flash",
    messages: [{ role: "user", content: verificationPrompt }],
    max_tokens: 150,
  }),
});
```

- Prompt focuses on fixed structural elements (geometry, patterns)
- Tolerates camera angles and lighting differences
- Returns confidence score 0-100

**Threshold Logic**:
- `score < 75`: Candidate rejected, not inserted
- `score >= 75 AND score < 90`: Inserted as verified match
- `score >= 90`: PASS 2 triggered

**PASS 2 - Adversarial Check** (only if PASS 1 ≥ 90%):
- Looks for reasons candidates might NOT be the same property
- If still ≥90%, mark `is_authoritative: true`

**Data Written** (for each verified match):
```sql
INSERT INTO search_platforms (
  search_id, platform_name, listing_url, listing_title,
  images, confidence_score, match_type, matched_at
) VALUES ($searchId, $platform, $url, $title, $images, $score, 'visual', now())
```

**Budget Exhaustion Handling**: If AI budget exhausted, remaining candidates are not verified.

### 6.6 Stage 4: Validate Dates (Phase A)

**Trigger**: Platform inserted into `search_platforms` with confidence ≥75%

**Location**: `process-platform-extraction/index.ts` → calls `validate-dates`

**Backend Status**: `validating_dates` / `phase_a`

**Code Execution**:
1. Insert or reset `price_extractions` row for this platform
2. Apply date parameters to platform URL (`applyDatesToDeepLink()`)
3. Scrape page with Firecrawl (primary) or Zyte (fallback)
4. Parse rendered dates from page content
5. Compare against requested dates

**Data Written**:
```sql
UPDATE price_extractions SET
  dates_validated = $validated,
  detected_checkin = $detectedCheckIn,
  detected_checkout = $detectedCheckOut,
  extraction_stage = 'phase_a_complete'
WHERE id = $extractionId
```

**Failure Modes**:
| Status | Meaning |
|--------|---------|
| `dates_not_applied` | Dates not found in rendered page |
| `no_availability_for_dates` | Platform shows "sold out" |

### 6.7 Stage 5: Collect Prices (Phase B)

**Trigger**: Phase A complete with `dates_validated = true`

**Backend Status**: `collecting_prices` / `phase_b`

**Routing Logic**:
```typescript
const GOLDEN_PATH_PLATFORMS = {
  'hotels.com': 'extract-hotelscom',
  'expedia': 'extract-expedia',
  'agoda.com': 'extract-agoda',
  'vrbo.com': 'extract-vrbo',
  'airpaz.com': 'extract-airpaz',
  'booking.com': 'extract-booking',
};
```

**Tier Definitions**:
| Tier | Behavior |
|------|----------|
| **A** | Dedicated extractor, high patience, 4 retry attempts, gates finalization |
| **B** | Generic extractor (Firecrawl/Zyte), best effort |
| **C** | Blocked/unsupported, skipped immediately |

**Dedicated Extractor Pattern** (e.g., Expedia):
1. Parse property ID from URL
2. Build Hotel-Search offers page URL with dates
3. Navigate via Browserless (gated concurrency)
4. Extract "total includes taxes & fees" price from DOM
5. Detect and handle currency if non-USD

**Data Written**:
```sql
UPDATE price_extractions SET
  extracted_price = $price,
  currency = $currency,
  includes_taxes_fees = $includesTaxesFees,
  extraction_status = $status,
  extraction_metadata = $metadata,
  confidence_score = $confidence,
  provider_used = $provider
WHERE id = $extractionId
```

**Tier A Retry Policy**:
- Max 4 attempts (`tier_a_attempt_count`)
- Exponential backoff
- Persisted state: `tier_a_state`, `tier_a_next_retry_at`
- Retries for: navigation failures, timeouts
- Hard terminal on: bot detection, date unavailability

### 6.8 Stage 6: Finalize Results

**Trigger**: All platforms reach terminal status (Tier A gates finalization)

**Backend Status**: `finalizing` → `completed`

**Location**: `_shared/buildFinalSnapshot.ts` → `finalizeAndCompleteSearch()`

**Steps**:

1. **Gather Authoritative Platform Set**:
```sql
SELECT * FROM search_platforms WHERE search_id = $searchId
```

2. **Join Extraction Data**:
```sql
SELECT * FROM price_extractions 
WHERE search_id = $searchId 
ORDER BY updated_at DESC
```

3. **Categorize Each Result** (immutable bucket assignment):
```typescript
function categorizeResultForSnapshot(result, airbnbPrice): ResultBucket {
  // Tier C → 'platform_blocked'
  // Sold out statuses → 'sold_out'
  // Rate limited → 'service_error'
  // Bot blocked → 'blocked'
  // No price → 'price_not_found'
  // Foreign currency → 'not_comparable'
  // Price < airbnb → 'cheaper'
  // Price ≥ airbnb → 'more_expensive'
}
```

4. **Build Snapshot Object**:
```typescript
const snapshot: FinalSnapshot = {
  version: 4,
  generated_at: new Date().toISOString(),
  search_id,
  airbnb: { price, currency, title },
  dates: { check_in, check_out, nights },
  results: categorizedResults,  // Each has frozen final_bucket
  result_count: results.length,
  expected_platform_count,
  finalized_platform_count,
  render_debug: { ... },
};
```

5. **Atomic Persistence**:
```sql
UPDATE searches SET
  status = 'completed',
  finalised_at = now(),
  final_results_snapshot = $snapshot
WHERE id = $searchId
```

**CRITICAL INVARIANT**: If snapshot persistence fails:
```sql
UPDATE searches SET
  status = 'finalization_failed',
  finalization_error = $errorPayload
WHERE id = $searchId
```

### 6.9 Failure Handling and Degraded Modes

| Failure | Behavior |
|---------|----------|
| Airbnb extraction fails | Search terminates immediately with explicit error |
| SerpAPI rate limited | Search continues with 0 alternatives (not terminal if Airbnb succeeded) |
| Single platform bot-blocked | Platform marked `blocked`, search continues |
| All platforms fail extraction | Search completes with results showing failures |
| Finalization fails | Status = `finalization_failed`, UI shows retry option |
| Edge function timeout (150s) | Watchdog auto-finalizes after 15 minutes |

### 6.10 Timeouts and Limits

| Limit | Value |
|-------|-------|
| Edge function timeout | 150 seconds |
| Finalization timeout | 180 seconds |
| Phase A timeout | 60 seconds |
| Phase B timeout | 60 seconds |
| Dedicated extractor timeout | 120 seconds |
| Browserless concurrent requests | 1 (global via advisory lock) |
| Max AI calls per search | 50 |
| Max images for discovery | 5 |
| Tier A retry attempts | 4 |
| Watchdog auto-finalize threshold | 15 minutes |

### 6.11 Telemetry and Logging

**Activity Log** (`searches.activity_log` - JSONB array):
```json
[
  { "ts": 1706900000000, "message": "Starting search", "detail": "..." },
  { "ts": 1706900005000, "message": "Airbnb price extracted", "detail": "$2,214" },
  { "ts": 1706900020000, "message": "Found 3 verified matches" },
  { "ts": 1706900060000, "message": "Finalization complete" }
]
```

**API Request Logs** (`api_request_logs` table):
- Provider name, endpoint type, URL
- Success/failure, HTTP status, duration
- Cost units (for quota tracking)
- Correlation ID for request tracing

**Stage Runs** (`search_stage_runs` table):
- Stage name, started_at, finished_at
- Duration in ms, outcome_status
- Used for progress bar timing estimates

---

## 7. Search Results Page Behavior

### 7.1 Data Flow

**Location**: `src/pages/SearchResults.tsx`

**Two-Phase UX Model**:

| Phase | Name | Condition | Behavior |
|-------|------|-----------|----------|
| 1 | `discovery_pricing` | `finalised_at` is null | Shows progress, live status chips, "Fetching prices (X/N)" |
| 2 | `complete` | `finalised_at` is set | Read-only render of `final_results_snapshot` |

**Phase 1 (Progress View)**:
1. Subscribe to `price_extractions` via Supabase Realtime (`postgres_changes`)
2. Show live status chips for each platform (Queued, Fetching, Retrying, Done, etc.)
3. Display "Fetching prices (X / N)" counter
4. Poll every 3 seconds as fallback
5. Show "Last update" timestamp and "Prioritizing high-priority platforms" if stalled

**Phase 2 (Results View)**:
1. Triggered when `finalised_at` is non-null
2. Read-only render of `final_results_snapshot.results`
3. **No re-computation or live enrichment**
4. Each result's `final_bucket` and `final_bucket_label` are frozen

### 7.2 Result Buckets

| Bucket | Display | Meaning |
|--------|---------|---------|
| `cheaper` | ✓ Green badge | Verified lower price |
| `more_expensive` | Red badge | Verified higher price |
| `not_comparable` | Gray | Currency/type mismatch, dates not validated |
| `sold_out` | Orange | Dates unavailable on platform |
| `price_not_found` | Gray | Extraction ran but no price found |
| `blocked` | Red | Bot/CAPTCHA blocked |
| `service_error` | Gray | Rate limit, timeout, infrastructure error |
| `platform_blocked` | Gray | Tier C skipped |
| `requires_action` | Yellow | User action needed |

### 7.3 Guarantees

1. **Determinism**: Refresh shows identical results (snapshot is immutable)
2. **Completeness**: Every matched platform appears (even if price failed)
3. **Correctness**: Bucket labels frozen at finalization, never re-derived
4. **Transparency**: Terminal error panels explain every failure

### 7.4 Auto-Recovery

If UI detects `status: completed` but `finalised_at` is null:
- Automatically triggers forced finalization request to backend
- Prevents infinite loading states
- Logged as recovery event

---

## 8. Known Limitations

### 8.1 Current Constraints (Factual)

1. **Single Currency Comparison**: Only USD prices are fully comparable. Foreign currencies (CAD, EUR, GBP, ZAR, etc.) are labeled but NOT converted for comparison. Result is categorized as `not_comparable`.

2. **Browserless Concurrency**: Global limit of 1 concurrent request creates bottleneck during high traffic. Enforced via Postgres advisory lock.

3. **Rate Limits**: SerpAPI, Firecrawl, Zyte, and Browserless can rate-limit, causing reduced discovery coverage or extraction failures.

4. **Tier C Platforms**: Many platforms are blocked/unsupported and appear as "Platform not supported". No extraction is attempted.

5. **Date Validation Imprecision**: Some platforms apply dates correctly but render them differently (format, locale), causing false "dates not validated" states.

6. **Multi-Room Listings**: Airbnb listings with multiple room options require additional click handling. Partially implemented.

7. **Regional Variants**: International domains (e.g., `expedia.co.jp`, `booking.de`) may have different page structures than US versions.

8. **Point-in-Time Prices**: Prices are snapshots at extraction time; actual booking prices may differ.

9. **No AI for Price Extraction**: All price extraction is regex/DOM-based. This is intentional for reliability but may miss dynamically-rendered prices.

10. **Edge Function Timeout**: 150-second limit may be insufficient for complex searches with many platforms.

### 8.2 Implicit/Uncertain Behaviors

- Searches without dates in the Airbnb URL are rejected at input validation
- Searches with past dates are not explicitly blocked (may show "unavailable")
- Platform adapter configuration is static; no runtime learning or adaptation
- The system assumes all Airbnb URLs use `check_in`/`check_out` parameter names

---

## Appendix A: File Reference

| Path | Purpose |
|------|---------|
| `src/pages/Dashboard.tsx` | Search input page |
| `src/pages/SearchResults.tsx` | Results display and progress |
| `src/lib/pipelineStages.ts` | Stage definitions and status mapping |
| `src/lib/priceVerification.ts` | Price verification logic |
| `src/lib/resultCategorization.ts` | Bucket assignment (frontend mirror) |
| `src/lib/canonicalPrice.ts` | Canonical price model |
| `src/lib/airbnbUrlNormalizer.ts` | URL normalization |
| `supabase/functions/search-alternatives/index.ts` | Main orchestrator |
| `supabase/functions/process-platform-extraction/index.ts` | Platform worker |
| `supabase/functions/_shared/buildFinalSnapshot.ts` | Snapshot builder |
| `supabase/functions/extract-expedia/index.ts` | Expedia extractor |
| `supabase/functions/extract-booking/index.ts` | Booking.com extractor |
| `supabase/functions/_shared/browserlessGate.ts` | Concurrency control |
| `supabase/functions/_shared/tierARetryPolicy.ts` | Retry logic |
| `docs/EXTRACTION_STATE_MACHINE.md` | State definitions |
| `docs/CANONICAL_PRICE_MODEL.md` | Price model spec |
| `docs/BROWSERLESS_CANONICAL_BASELINE.md` | Browserless reference |

---

## Appendix B: Database Schema (Key Tables)

### searches
```sql
id, user_id, airbnb_url, airbnb_title, airbnb_price, airbnb_currency,
airbnb_images, airbnb_image_url, check_in_date, check_out_date, nights_count,
status, finalised_at, final_results_snapshot, finalization_error,
activity_log, api_error, api_error_code,
ocr_booking_card_amount, ocr_breakdown_total_amount, ocr_validation_status,
created_at, updated_at
```

### search_platforms
```sql
id, search_id, platform_name, listing_url, listing_title,
images, image_url, confidence_score, match_type, source_airbnb_image,
extraction_id_latest, extraction_status_terminal, outcome_category,
last_error, matched_at, updated_at
```

### price_extractions
```sql
id, search_id, platform_name, deep_link, extracted_price, currency,
extraction_status, extraction_error, extraction_stage, extraction_metadata,
dates_validated, detected_checkin, detected_checkout,
includes_taxes_fees, confidence_score, price_type, provider_used,
tier_a_state, tier_a_attempt_count, tier_a_next_retry_at, tier_a_last_transient_reason,
created_at, updated_at
```

### blocked_platforms
```sql
id, domain, reason, blocked_at
```

### platform_adapters
```sql
id, platform_name, platform_domain, coverage_tier, dedicated_extractor,
deep_link_template, date_format, requires_occupancy, reliability_score,
is_active, tier_reason, created_at, updated_at
```

---

*End of System Documentation v2.0.0*
