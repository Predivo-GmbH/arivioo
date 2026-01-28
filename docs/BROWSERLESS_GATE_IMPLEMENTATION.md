# Browserless Distributed Gate Implementation

## Overview

All Browserless API calls in this codebase are routed through a **distributed global gate** that uses **Postgres advisory locks** to enforce serialization across all Edge Function instances.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Edge Function Instance A                     │
│  ┌─────────────────┐    ┌──────────────────┐                   │
│  │ extract-agoda   │───▶│ browserlessGate  │─┐                 │
│  └─────────────────┘    └──────────────────┘ │                 │
│  ┌─────────────────┐    ┌──────────────────┐ │                 │
│  │ extract-booking │───▶│ browserlessGate  │─┤                 │
│  └─────────────────┘    └──────────────────┘ │                 │
└────────────────────────────────────────────────┼─────────────────┘
                                                 │
                                                 ▼
                                    ┌───────────────────────┐
                                    │  Postgres Advisory    │
                                    │  Lock (key: 8675309)  │
                                    │  MAX_CONCURRENCY = 1  │
                                    └───────────────────────┘
                                                 │
                                                 ▼
                                    ┌───────────────────────┐
                                    │  chrome.browserless.io│
                                    │  /content, /function  │
                                    │  /scrape endpoints    │
                                    └───────────────────────┘
```

## Shared Helper Module

Location: `supabase/functions/_shared/browserlessGate.ts`

### Exported Functions

| Function | Endpoint Type | Use Case |
|----------|---------------|----------|
| `gatedBrowserlessFetch()` | `/content` | Simple content fetch with rendered HTML |
| `gatedBrowserlessFunctionFetch()` | `/function`, `/scrape` | Puppeteer scripts, complex navigation |

### Configuration Constants

```typescript
BROWSERLESS_LOCK_KEY = 8675309        // Postgres advisory lock key
MAX_GLOBAL_CONCURRENCY = 1            // Only 1 concurrent Browserless call
BACKOFF_INITIAL_MS = 2000             // Initial retry delay
BACKOFF_MULTIPLIER = 2                // Exponential backoff multiplier
BACKOFF_MAX_MS = 20000                // Maximum retry delay
MAX_RETRIES = 3                       // Maximum 429 retry attempts
JITTER_MIN_MS = 200                   // Minimum jitter
JITTER_MAX_MS = 800                   // Maximum jitter
```

## Usage

### Simple Content Fetch

```typescript
import { gatedBrowserlessFetch, isFetchRateLimited } from '../_shared/browserlessGate.ts';

const result = await gatedBrowserlessFetch(
  `https://chrome.browserless.io/content?token=${apiKey}`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, gotoOptions: { waitUntil: 'networkidle0' } }),
    timeout: 60000,
  },
  { platform: 'agoda', searchId: 'xxx', operation: 'fetchContent' }
);

if (isFetchRateLimited(result)) {
  // Terminal rate limiting - classify as service_error
  return { status: 'rate_limited', error: 'browserless_429' };
}
```

### Puppeteer Script Execution

```typescript
import { gatedBrowserlessFunctionFetch, isFunctionRateLimited } from '../_shared/browserlessGate.ts';

const result = await gatedBrowserlessFunctionFetch(
  `https://chrome.browserless.io/function?token=${apiKey}`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: puppeteerScript, context: {} }),
    timeout: 90000,
  },
  { platform: 'airbnb', operation: 'extractPrice' }
);

if (isFunctionRateLimited(result)) {
  return { status: 'rate_limited' };
}

const data = result.data; // Parsed JSON response
```

## 429 Handling

When Browserless returns HTTP 429 (Too Many Requests):

1. **Automatic retry** with exponential backoff: 2s → 4s → 8s (max 20s)
2. **Jitter** added to prevent thundering herd: 200-800ms
3. **Maximum 3 retries** before terminal failure
4. **Explicit classification**: `rate_limited` with reason `browserless_429`
5. **Taxonomy mapping**: `rate_limited` → `service_error` bucket

## Logging

All gate operations log with consistent, machine-parsable format:

```
[BROWSERLESS_GATE] acquire_start requestId=br_1234 platform=agoda searchId=xxx
[BROWSERLESS_GATE] acquire_ok waitMs=150 requestId=br_1234
[BROWSERLESS] attempt=1 platform=agoda searchId=xxx
[BROWSERLESS] attempt=1 status=200 success=true
[BROWSERLESS_GATE] release requestId=br_1234

# On 429:
[BROWSERLESS] rate_limited attempt=1 backoffMs=2500
[BROWSERLESS] attempt=2 status=200 success=true

# On terminal 429:
[BROWSERLESS] terminal rate_limited reason=browserless_429 attempts=4
```

## Gated Call Sites

All Browserless calls in the following files are routed through the gate:

| File | Functions | Endpoint |
|------|-----------|----------|
| `extract-agoda/index.ts` | `fetchWithBrowserless`, `clickBookingButtonWithBrowserless`, `fetchWithBrowserlessAndClick` | /content, /function, /scrape |
| `extract-booking/index.ts` | `fetchWithBrowserless`, `executeCheckoutNavigation` | /content, /function |
| `extract-expedia/index.ts` | `fetchWithBrowserless` | /content |
| `search-alternatives/index.ts` | `scrapeWithBrowserless` | /function |
| `airbnb-baseline-test/index.ts` | `runBrowserlessExtraction` | /function |
| `airbnb-selftest/index.ts` | `runLiveCanaryCheck` | /function |
| `vrbo-live-access-check/index.ts` | `checkWithBrowserless` | /content |
| `booking-browserless-test/index.ts` | `fetchWithBrowserless` | /content |

## Regression Guard - Final

A strict CI script prevents direct Browserless HTTP calls outside the gate module.

### Invariant

- **URL constants**: ALLOWED anywhere
- **Direct HTTP requests**: FORBIDDEN outside `browserlessGate.ts`

### Run the Guard

```bash
chmod +x scripts/check-browserless-gate.sh
./scripts/check-browserless-gate.sh
```

### What PASSES (allowed patterns)

```typescript
// ✓ URL constant definition (allowed)
const browserlessUrl = `https://chrome.browserless.io/function?token=${token}`;

// ✓ Passing URL to gated helper (allowed)
const result = await gatedBrowserlessFetch(browserlessUrl, options, context);

// ✓ Passing URL to gated function helper (allowed)
const result = await gatedBrowserlessFunctionFetch(browserlessUrl, options, context);
```

### What FAILS (forbidden patterns)

```typescript
// ❌ Direct fetch with browserless URL (FORBIDDEN)
await fetch(`https://chrome.browserless.io/content?token=${token}`, options);

// ❌ Direct fetch with variable (FORBIDDEN)
await fetch(browserlessUrl, options);

// ❌ Axios call (FORBIDDEN)
await axios.post(`https://chrome.browserless.io/function`, body);
```

### Example Output - PASS

```
🔍 BROWSERLESS GATE REGRESSION GUARD
=====================================

Invariant: Direct HTTP requests to browserless.io are forbidden
           outside supabase/functions/_shared/browserlessGate.ts

Step 1: Scanning repository for browserless.io references...
   Found 8 file(s) with browserless.io references

Step 2: Checking for forbidden direct HTTP calls...
   ✓ supabase/functions/_shared/browserlessGate.ts (gate module - allowed)
   ✓ docs/BROWSERLESS_GATE_IMPLEMENTATION.md (documentation - allowed)
   ✓ supabase/functions/extract-agoda/index.ts (URL constants only - allowed)
   ✓ supabase/functions/airbnb-baseline-test/index.ts (URL constants only - allowed)

Step 3: Verifying edge functions use gated helpers...
   ✓ supabase/functions/extract-agoda/index.ts imports gate helpers

✅ All Browserless calls are properly gated!
```

### Example Output - FAIL

If someone adds a direct call like this:

```typescript
// In supabase/functions/new-extractor/index.ts
const html = await fetch(`https://chrome.browserless.io/content`, opts);
```

The guard will fail:

```
❌ REGRESSION DETECTED: 1 violation(s) found!

Violations:
============================================================================
❌ supabase/functions/new-extractor/index.ts:42 - Direct fetch() call
   const html = await fetch(`https://chrome.browserless.io/content`, opts);

============================================================================

FIX: All direct HTTP requests to browserless.io MUST use the gated helpers:
     - gatedBrowserlessFetch()         (for /content endpoint)
     - gatedBrowserlessFunctionFetch() (for /function, /scrape endpoints)

     Import from: supabase/functions/_shared/browserlessGate.ts
```

### Approved Files (Whitelist)

Only these files may contain browserless.io references:

| File | Reason |
|------|--------|
| `supabase/functions/_shared/browserlessGate.ts` | Gate module (makes actual HTTP calls) |
| `docs/BROWSERLESS_GATE_IMPLEMENTATION.md` | Documentation |
| `docs/BROWSERLESS_CANONICAL_BASELINE.md` | Baseline documentation |
| `scripts/check-browserless-gate.sh` | The guard script itself |

## Why Distributed Locking?

Edge functions run as isolated instances. Without distributed coordination:
- Multiple concurrent searches would burst Browserless simultaneously
- This triggers HTTP 429 rate limiting
- Failed extractions reduce platform coverage

The Postgres advisory lock ensures only ONE Browserless call runs at a time across ALL instances, preventing burst rate limiting.
