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

## Regression Guard

A CI/test script is provided to ensure no direct Browserless calls are added:

```bash
./scripts/check-browserless-gate.sh
```

This script:
1. Searches for `chrome.browserless.io` references
2. Excludes the shared gate module
3. Verifies all references use `gatedBrowserlessFetch` or `gatedBrowserlessFunctionFetch`
4. Exits with code 1 if direct calls are found

## Why Distributed Locking?

Edge functions run as isolated instances. Without distributed coordination:
- Multiple concurrent searches would burst Browserless simultaneously
- This triggers HTTP 429 rate limiting
- Failed extractions reduce platform coverage

The Postgres advisory lock ensures only ONE Browserless call runs at a time across ALL instances, preventing burst rate limiting.
