# Arivioo System Documentation

**Version**: 1.0.0  
**Last Updated**: 2026-02-04  
**Purpose**: Complete technical reference for AI agents (Cursor) and human developers

---

## 1. High-Level System Purpose

Arivioo is an automated price comparison system for vacation rentals. Given an Airbnb listing URL with specific dates, the system:

1. Extracts the total stay price from Airbnb (including taxes and fees)
2. Discovers the same property on alternative booking platforms via visual image matching
3. Extracts verified total prices from each alternative platform
4. Presents a comparison showing potential savings

The core requirement is **fully automated, reliable, and explainable price comparison** with no manual intervention. All extracted prices must be real, comparable, and grounded in actual page content. The system must never hallucinate prices or silently fail.

---

## 2. Tech Stack Overview

### 2.1 Frontend

| Component | Technology |
|-----------|------------|
| Framework | React 18.3 with TypeScript |
| Build Tool | Vite |
| Styling | Tailwind CSS with semantic design tokens |
| UI Components | shadcn/ui (Radix primitives) |
| State Management | React hooks + TanStack Query |
| Routing | react-router-dom v6 |
| Animations | framer-motion |
| Icons | lucide-react |

**Key Frontend Files**:
- `src/pages/Dashboard.tsx` - Search input and history
- `src/pages/SearchResults.tsx` - Results display (4,788 lines)
- `src/lib/pipelineStages.ts` - Pipeline stage definitions
- `src/lib/priceVerification.ts` - Price verification logic
- `src/lib/resultCategorization.ts` - Result bucket assignment
- `src/lib/canonicalPrice.ts` - Price normalization model

### 2.2 Backend

| Component | Technology |
|-----------|------------|
| Platform | Supabase (Lovable Cloud) |
| Runtime | Deno (Edge Functions) |
| Database | PostgreSQL |
| Auth | Supabase Auth (email/password) |
| Realtime | Supabase Realtime (postgres_changes) |

**Database Tables** (key ones):
- `searches` - Search requests and metadata
- `search_platforms` - Verified platform matches (authoritative set)
- `price_extractions` - Extraction attempts and results
- `platform_adapters` - Platform configuration and coverage tiers
- `blocked_platforms` - Admin-managed blocklist

### 2.3 Edge Functions (Deno)

| Function | Purpose | Lines |
|----------|---------|-------|
| `search-alternatives` | Main orchestrator - discovery, verification, price extraction | ~10,153 |
| `process-platform-extraction` | Per-platform worker (Phase A + B) | ~1,614 |
| `finalize-search-snapshot` | Snapshot persistence endpoint | ~115 |
| `extract-expedia` | Expedia dedicated extractor | ~2,602 |
| `extract-booking` | Booking.com dedicated extractor | - |
| `extract-agoda` | Agoda dedicated extractor | - |
| `extract-vrbo` | VRBO dedicated extractor | - |
| `extract-airpaz` | Airpaz dedicated extractor | - |
| `extract-hotelscom` | Hotels.com dedicated extractor | - |
| `extract-prices` | Generic Firecrawl/Zyte extractor | - |
| `validate-dates` | Phase A date validation | - |
| `airbnb-url-normalizer` | URL normalization service | - |

**Shared Modules** (`supabase/functions/_shared/`):
- `buildFinalSnapshot.ts` - Snapshot construction and categorization (~1,338 lines)
- `browserlessGate.ts` - Distributed concurrency control for Browserless
- `tierARetryPolicy.ts` - Retry logic for Tier A platforms
- `coverageVariantDetector.ts` - Regional/locale variant detection
- `platformNameNormalizer.ts` - Platform name normalization

---

## 3. External APIs & Services

### 3.1 SerpAPI (Google Lens)

**Purpose**: Visual reverse image search to find property matches on other platforms

**Called From**: `search-alternatives/index.ts`

**Usage Pattern**:
```
POST https://serpapi.com/search?engine=google_lens
```

**Constraints**:
- Rate limited (429 responses possible)
- Used for discovery phase only
- Results filtered against blocklist before processing

**Secret**: `SERPAPI_API_KEY`

### 3.2 Browserless

**Purpose**: Headless Chrome browser for JavaScript-rendered pages

**Called From**: 
- `search-alternatives/index.ts` (Airbnb baseline)
- `extract-expedia/index.ts`
- `extract-booking/index.ts`
- Other dedicated extractors

**Endpoints Used**:
- `https://chrome.browserless.io/function` - Custom function execution
- `https://chrome.browserless.io/content` - Page content retrieval

**Constraints**:
- **Global concurrency limit of 1** (enforced via Postgres advisory lock `8675309`)
- 429 responses trigger exponential backoff (2s, 4s, 8s, 20s)
- HTML limit: 350,000 characters
- Screenshot quality: 75% JPEG
- Content validity gate: 400+ characters innerText within 25s

**Secret**: `BROWSERLESS_API_KEY`

### 3.3 Firecrawl

**Purpose**: Web scraping with automatic JavaScript rendering

**Called From**: 
- `extract-prices/index.ts`
- `process-platform-extraction/index.ts` (Phase A/B)

**Usage**: Primary scraper with Zyte as fallback

**Secret**: `FIRECRAWL_API_KEY` / `FIRECRAWL_API_KEY_1`

### 3.4 Zyte

**Purpose**: Browser-based scraping with anti-bot capabilities

**Called From**: 
- `search-alternatives/index.ts` (Airbnb fallback)
- `extract-expedia/index.ts` (fallback)
- Various extractors as fallback

**Usage Pattern**:
```
POST https://api.zyte.com/v1/extract
{
  "url": "...",
  "browserHtml": true,
  "javascript": true,
  "screenshot": true
}
```

**Secret**: `ZYTE_API_KEY`

### 3.5 Lovable AI Gateway

**Purpose**: AI-powered image verification (property matching)

**Model Used**: `google/gemini-2.5-flash` (exclusively)

**Endpoint**: `https://ai.gateway.lovable.dev/v1/chat/completions`

**Called From**: `search-alternatives/index.ts` (verification passes)

**Secret**: `LOVABLE_API_KEY` (auto-provisioned)

### 3.6 Resend

**Purpose**: Transactional email (notifications, password reset)

**Secret**: `RESEND_API_KEY`

---

## 4. AI Usage Overview

### 4.1 Where AI IS Used

| Use Case | Model | Location |
|----------|-------|----------|
| Image Verification (PASS 1) | `google/gemini-2.5-flash` | `search-alternatives/index.ts` |
| Image Verification (PASS 2 - adversarial) | `google/gemini-2.5-flash` | `search-alternatives/index.ts` |

**Verification Prompt Strategy**:
- PASS 1: "Balanced Identity Verification" - focuses on fixed structural elements (geometry, patterns) while tolerating camera angles and lighting
- PASS 2: Adversarial check for high-confidence matches (≥90%)

**Budget Allocation**:
- MAX_AI = 50 calls per search
- Hard minimum of 6 calls reserved for late images
- Image 1 can use up to 70% of spendable calls
- Verification skipped for platforms already matched at ≥75% confidence

### 4.2 Where AI is NOT Used

- **Price extraction**: Uses DOM parsing, regex patterns, and structured selectors only
- **Date validation**: Uses explicit URL parameters and rendered text matching
- **URL normalization**: Deterministic string manipulation
- **Result categorization**: Rule-based bucket assignment
- **Platform matching decisions**: Confidence thresholds are numeric, not AI-determined

### 4.3 AI Decision Boundaries

AI is ALLOWED to:
- Output a confidence score (0-100) for image similarity
- Provide a brief justification for the score

AI is NOT ALLOWED to:
- Make final match/reject decisions (threshold logic is deterministic)
- Extract or interpret prices
- Validate dates
- Override blocklist rules

---

## 5. Core System Invariants

These rules MUST NEVER be violated:

### 5.1 Airbnb Baseline Gate
The Airbnb total stay price extraction is the **mandatory gatekeeper**. If extraction fails, the entire search terminates immediately. No subsequent pipeline stages execute.

### 5.2 No Results Until Final
- Search status = `completed` is ONLY set when `final_results_snapshot` persistence succeeds
- Frontend never renders results until `finalised_at` is set
- Once finalized, the snapshot is **immutable** - never re-derived

### 5.3 No Silent Suppression
Every extraction outcome MUST be explicitly surfaced in the UI:
- A platform cannot silently disappear
- Terminal states have explicit error panels
- No "No Price" collapse of distinct failure modes

### 5.4 Structural Verification Required
A price can ONLY be marked "Verified" if ALL structural proof flags are true:
- `breakdown_found: true`
- `total_label_found: true`
- `rendered_dates_match: true`
- `extracted_from_breakdown_total: true`

### 5.5 USD-First Strategy
All Tier A extractors attempt to force USD pricing. If extraction returns a foreign currency, the result is categorized as "not_comparable" with explicit currency labeling.

### 5.6 75% ImageGate Threshold
A listing is only considered a valid match if it passes the 75% AI confidence threshold. Matches ≥90% are marked "authoritative".

### 5.7 Terminal Status Contract
Every `price_extractions` row MUST end in a terminal status. Allowed values:
```
'success', 'dates_not_applied', 'no_availability_for_dates', 
'blocked_captcha_or_bot', 'blocked_rate_limit', 'render_failed',
'listing_unavailable', 'price_not_found_after_dates_applied',
'total_not_available_pre_checkout', 'validation_error',
'extraction_error', 'timeout', 'platform_unsupported'
```

---

## 6. SEARCH WORKFLOW (Complete Step-by-Step)

### 6.1 User Enters Airbnb URL

**Location**: `src/pages/Dashboard.tsx`

**Validation Performed**:
1. URL format validation (URL constructor)
2. Protocol check (http/https only)
3. Domain allowlist check (40+ Airbnb domains)
4. Room ID extraction (`/rooms/<id>` or `/book/stays/<id>`)
5. Date presence check (`check_in` and `check_out` params required)
6. Date format validation (YYYY-MM-DD)
7. Date logic check (checkout > checkin)
8. URL length limit (2048 chars, SSRF protection)

**If validation fails**: Toast error displayed, search not created

**If validation succeeds**:
```typescript
await supabase.from("searches").insert({
  user_id: user.id,
  airbnb_url: url,
  status: "searching"
});
```

**Navigation**: Redirect to `/search/{searchId}`

### 6.2 Search Orchestration Begins

**Location**: `supabase/functions/search-alternatives/index.ts`

**Trigger**: Frontend navigates to SearchResults page, which calls the edge function

**Initial Database Write**:
```sql
UPDATE searches SET status = 'searching', updated_at = now() WHERE id = ?
```

### 6.3 Stage 1: Analyze Listing (Airbnb Baseline)

**Backend Status**: `scraping_airbnb`, `extracting_price`

**Steps**:
1. **URL Normalization** via `buildBookStaysUrl()`:
   - Transform `/rooms/<id>` → `/book/stays/<id>`
   - Extract dates, guest counts
   - Build canonical URL with fixed parameter order

2. **Provider Fallback Chain** (Firecrawl → Zyte → Browserless):
   
   **Browserless Extraction** (primary for Airbnb):
   - Navigate to rooms page first (get title, images)
   - Navigate to book/stays page (get total price)
   - Execute `page.evaluate()` to extract:
     - "Pay $X now" pattern (primary)
     - "Total (USD) $X" pattern (secondary)
     - Subtotal + nights as fallback

3. **Bot Detection**: Check for captcha indicators, rate limiting

4. **Data Extracted**:
   - `airbnb_price`: Total stay price
   - `airbnb_title`: Property title
   - `airbnb_images`: Array of image URLs (up to 5)
   - `check_in_date`, `check_out_date`, `nights_count`

**Database Write**:
```sql
UPDATE searches SET 
  airbnb_price = ?,
  airbnb_title = ?,
  airbnb_images = ?,
  airbnb_image_url = ?,
  check_in_date = ?,
  check_out_date = ?,
  nights_count = ?,
  status = 'extracting_photos'
WHERE id = ?
```

**Failure Modes**:
- `airbnb_blocked_or_captcha` → Search terminates
- `airbnb_total_not_visible` → Search terminates
- `dates_unavailable` → Search terminates with specific error panel

### 6.4 Stage 2: Collect Photos

**Backend Status**: `extracting_photos`, `collecting_photos`

**Steps**:
1. Parse `airbnb_images` from Airbnb page scrape
2. Select up to 5 high-quality images
3. Download/validate image URLs

**Logged**: Image URLs and count in `activity_log`

### 6.5 Stage 3: Find Matches (Discovery + Verification)

**Backend Status**: `searching_platforms`, `ai_verifying_*`

**Discovery Methods**:

1. **Google Lens via SerpAPI**:
   ```
   POST https://serpapi.com/search
   {
     "engine": "google_lens",
     "url": "<airbnb_image_url>"
   }
   ```
   - Process `visual_matches` from response
   - Filter against blocked platforms
   - Deduplicate by domain

2. **Knowledge Graph Extraction**:
   - Extract from SerpAPI `knowledge_graph` section
   - Contains pre-identified platform URLs

**For Each Candidate**:

1. **Blocklist Check**:
   - Query `blocked_platforms` table
   - Domains normalized (no protocol, no www, no trailing slash)
   - Blocked candidates immediately rejected

2. **AI Image Verification (PASS 1)**:
   - Call Lovable AI with Airbnb image + candidate image
   - Prompt: "Balanced Identity Verification"
   - Threshold: ≥75% to proceed

3. **AI Image Verification (PASS 2)** (if PASS 1 ≥90%):
   - Adversarial check
   - If ≥90%, mark `is_authoritative: true`

**Database Write** (for each verified match):
```sql
INSERT INTO search_platforms (
  search_id, platform_name, listing_url, listing_title,
  images, confidence_score, match_type, matched_at
) VALUES (?, ?, ?, ?, ?, ?, ?, now())
```

**Progress Logged**: Candidate counts, verification results

### 6.6 Stage 4: Validate Dates (Phase A)

**Backend Status**: `validating_dates`, `applying_dates`, `phase_a`

**Triggered By**: Verified match at ≥75% confidence

**Location**: `process-platform-extraction/index.ts` → `validate-dates` function

**Steps**:
1. Apply date parameters to platform URL
2. Scrape page with Firecrawl/Zyte
3. Parse rendered dates from page content
4. Compare against requested dates

**Database Write**:
```sql
UPDATE price_extractions SET
  dates_validated = ?,
  detected_checkin = ?,
  detected_checkout = ?,
  extraction_stage = 'phase_a_complete'
WHERE id = ?
```

**Failure Modes**:
- `dates_not_applied` → Extraction marked unverified
- `no_availability_for_dates` → Terminal "sold out" state

### 6.7 Stage 5: Collect Prices (Phase B)

**Backend Status**: `collecting_prices`, `extracting_prices`, `phase_b`

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
- **Tier A**: Dedicated extractors, high patience, 4 retry attempts
- **Tier B**: Generic extractors (Firecrawl/Zyte), best effort
- **Tier C**: Blocked/unsupported, skipped immediately

**Dedicated Extractor Pattern** (e.g., Expedia):
1. Parse property ID from URL
2. Build Hotel-Search offers page URL with dates
3. Navigate via Browserless
4. Extract "total includes taxes & fees" price
5. Detect and convert currency if non-USD

**Database Write**:
```sql
UPDATE price_extractions SET
  extracted_price = ?,
  currency = ?,
  includes_taxes_fees = ?,
  extraction_status = ?,
  extraction_metadata = ?,
  confidence_score = ?,
  provider_used = ?
WHERE id = ?
```

**Tier A Retry Policy**:
- Max 4 attempts
- Exponential backoff
- Persisted state: `tier_a_attempt_count`, `tier_a_state`, `tier_a_next_retry_at`
- Retries only for transient failures (navigation, timeout)
- Hard terminal on bot detection, date unavailability

### 6.8 Stage 6: Finalize Results

**Backend Status**: `finalizing`, `completed`

**Location**: `_shared/buildFinalSnapshot.ts`

**Steps**:

1. **Gather Authoritative Platform Set**:
   ```sql
   SELECT * FROM search_platforms WHERE search_id = ?
   ```

2. **Join Extraction Data**:
   ```sql
   SELECT * FROM price_extractions 
   WHERE search_id = ? 
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
     // Price not comparable → 'not_comparable'
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
     results: categorizedResults,
     result_count: results.length,
     expected_platform_count,
     finalized_platform_count,
     render_debug: { ... }
   };
   ```

5. **Atomic Persistence**:
   ```sql
   UPDATE searches SET
     status = 'completed',
     finalised_at = now(),
     final_results_snapshot = ?
   WHERE id = ?
   ```

**CRITICAL INVARIANT**: If snapshot persistence fails, status becomes `finalization_failed`, NOT `completed`.

### 6.9 Failure Handling and Degraded Modes

| Failure | Behavior |
|---------|----------|
| Airbnb extraction fails | Search terminates immediately |
| SerpAPI rate limited | Search continues with 0 alternatives |
| Single platform bot-blocked | Platform marked `blocked`, search continues |
| All platforms fail | Search completes with empty results |
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
| Browserless concurrent requests | 1 (global) |
| Max AI calls per search | 50 |
| Max images for discovery | 5 |
| Tier A retry attempts | 4 |

### 6.11 Telemetry and Logging

**Activity Log** (`searches.activity_log`):
```json
[
  { "ts": 1706900000000, "message": "Starting search", "detail": "..." },
  { "ts": 1706900005000, "message": "Airbnb price extracted", "detail": "$2,214" },
  { "ts": 1706900020000, "message": "Found 3 verified matches", "detail": "..." },
  { "ts": 1706900060000, "message": "Finalization complete", "detail": "..." }
]
```

**API Request Logs** (`api_request_logs`):
- Provider name, endpoint type, URL
- Success/failure, HTTP status, duration
- Cost units (for quota tracking)

**Stage Runs** (`search_stage_runs`):
- Stage name, started_at, finished_at
- Duration_ms, outcome_status
- Used for progress bar timing estimates

---

## 7. Search Results Page Behavior

### 7.1 Data Flow

**Location**: `src/pages/SearchResults.tsx`

**Phase 1 (Progress View)**:
1. Subscribe to `price_extractions` via Supabase Realtime
2. Show live status chips for each platform
3. Display "Fetching prices (X / N)" counter
4. Poll every 3 seconds as fallback

**Phase 2 (Results View)**:
1. Triggered when `finalised_at` is set
2. Read-only render of `final_results_snapshot`
3. No re-computation or live enrichment

### 7.2 Result Buckets

| Bucket | Display | Meaning |
|--------|---------|---------|
| `cheaper` | ✓ Green | Verified lower price |
| `more_expensive` | Red | Verified higher price |
| `not_comparable` | Gray | Currency/type mismatch |
| `sold_out` | Orange | Dates unavailable |
| `price_not_found` | Gray | Extraction failed |
| `blocked` | Red | Bot/CAPTCHA blocked |
| `service_error` | Gray | Rate limit/timeout |
| `platform_blocked` | Gray | Tier C skipped |

### 7.3 Guarantees

1. **Determinism**: Refresh shows identical results (snapshot is immutable)
2. **Completeness**: Every matched platform appears (even if price failed)
3. **Correctness**: Bucket labels frozen at finalization, never re-derived
4. **Transparency**: Terminal error panels explain every failure

### 7.4 Auto-Recovery

If UI detects `status: completed` but `finalised_at` is null:
- Automatically triggers forced finalization
- Prevents infinite loading states

---

## 8. Known Limitations

### 8.1 Current State (Factual)

1. **Single Currency**: Only USD prices are fully comparable. Foreign currencies are labeled but not converted for comparison.

2. **Browserless Concurrency**: Global limit of 1 request creates bottleneck during high traffic.

3. **Rate Limits**: SerpAPI and external providers can rate-limit, causing reduced discovery coverage.

4. **Tier C Platforms**: Many platforms are blocked/unsupported and appear as "Platform not supported".

5. **Date Validation**: Some platforms apply dates correctly but render differently, causing false "dates not validated" states.

6. **Multi-Room Listings**: Airbnb listings with multiple room options require additional click handling.

7. **Regional Variants**: International domains (e.g., expedia.co.jp) may have different page structures.

8. **No Real-Time Prices**: Prices are point-in-time snapshots; actual booking prices may differ.

### 8.2 Implicit Behaviors

- Searches without dates in the Airbnb URL are rejected at input validation
- Searches with past dates are not explicitly blocked (may show "unavailable")
- Platform adapter configuration is static; no runtime learning

---

## Appendix A: File Reference

| Path | Purpose |
|------|---------|
| `src/pages/Dashboard.tsx` | Search input page |
| `src/pages/SearchResults.tsx` | Results display |
| `src/lib/pipelineStages.ts` | Stage definitions |
| `src/lib/priceVerification.ts` | Verification logic |
| `src/lib/resultCategorization.ts` | Bucket assignment |
| `src/lib/canonicalPrice.ts` | Price model |
| `src/lib/airbnbUrlNormalizer.ts` | URL normalization |
| `supabase/functions/search-alternatives/index.ts` | Main orchestrator |
| `supabase/functions/process-platform-extraction/index.ts` | Platform worker |
| `supabase/functions/_shared/buildFinalSnapshot.ts` | Snapshot builder |
| `supabase/functions/extract-expedia/index.ts` | Expedia extractor |
| `docs/EXTRACTION_STATE_MACHINE.md` | State definitions |
| `docs/CANONICAL_PRICE_MODEL.md` | Price model spec |

---

## Appendix B: Database Schema (Key Tables)

### searches
```sql
id, user_id, airbnb_url, airbnb_title, airbnb_price, airbnb_currency,
airbnb_images, check_in_date, check_out_date, nights_count,
status, finalised_at, final_results_snapshot, activity_log,
created_at, updated_at
```

### search_platforms
```sql
id, search_id, platform_name, listing_url, listing_title,
images, confidence_score, match_type, extraction_status_terminal,
outcome_category, matched_at, updated_at
```

### price_extractions
```sql
id, search_id, platform_name, deep_link, extracted_price, currency,
extraction_status, extraction_error, extraction_metadata,
dates_validated, includes_taxes_fees, confidence_score,
tier_a_state, tier_a_attempt_count, tier_a_next_retry_at,
created_at, updated_at
```

### blocked_platforms
```sql
id, domain, reason, blocked_at
```

---

*End of System Documentation*
