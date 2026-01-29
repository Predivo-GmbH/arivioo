# Tier-A Retry Driver Architecture

## Overview

Tier-A platforms (Agoda, Booking.com) implement a **durable, server-driven retry system** that guarantees progress to terminal states even after edge function timeouts or restarts.

## Core Components

### 1. Persistence Layer (`price_extractions` columns)

```
tier_a_attempt_count  - Current attempt number (1-4)
tier_a_last_transient_reason - Why the last retry was scheduled
tier_a_next_retry_at - When to resume (with backoff + jitter)
tier_a_state - State machine: pending_retry | running | success | hard_terminal | exhausted
```

### 2. Classification Logic (`tierARetryPolicy.ts`)

Failures are classified as:

- **TRANSIENT** (retryable): `checkout_link_not_found`, `vat_excluded_checkout_failed`, `rate_limited`, `timeout`
- **HARD_TERMINAL** (no retry): `sold_out`, `blocked`, `captcha`, `invalid_url`
- **SUCCESS**: Valid price extracted

### 3. Retry Worker (`tier-a-retry-worker`)

A cron-scheduled edge function that:
- Runs every minute via `pg_cron`
- Claims `pending_retry` jobs with atomic locking
- Executes extraction via `process-platform-extraction`
- Transitions to terminal state or schedules next retry
- Recovers stale `running` jobs (orphaned due to timeouts)

### 4. Finalization Gate (`buildFinalSnapshot.ts`)

Finalization is **BLOCKED** while any Tier-A extraction is in:
- `pending_retry` - Waiting for next attempt
- `running` - Currently executing

## State Machine

```
                    ┌─────────────────────────────────┐
                    │        INITIAL STATE            │
                    │    tier_a_state = NULL          │
                    └─────────────────────────────────┘
                                   │
                                   ▼
                    ┌─────────────────────────────────┐
                    │    First transient failure      │
                    │    tier_a_state = pending_retry │
                    └─────────────────────────────────┘
                                   │
                    ┌──────────────┴──────────────┐
                    ▼                             ▼
        ┌───────────────────┐         ┌───────────────────┐
        │     Worker        │         │     timeout       │
        │    claims job     │         │   (recovered)     │
        │ state = running   │         │                   │
        └───────────────────┘         └───────────────────┘
                    │
        ┌───────────┼───────────┬───────────────────┐
        ▼           ▼           ▼                   ▼
    ┌───────┐  ┌─────────┐  ┌─────────┐      ┌──────────┐
    │SUCCESS│  │HARD_TERM│  │TRANSIENT│      │EXHAUSTED │
    │       │  │         │  │attempt<4│      │attempt>=4│
    └───────┘  └─────────┘  └─────────┘      └──────────┘
        │           │           │                   │
        ▼           ▼           │                   ▼
    ┌───────┐  ┌─────────┐      │           ┌──────────┐
    │success│  │hard_term│      │           │exhausted │
    │final  │  │  final  │      │           │  final   │
    └───────┘  └─────────┘      │           └──────────┘
                                ▼
                    ┌───────────────────┐
                    │   pending_retry   │
                    │ next_retry_at set │
                    └───────────────────┘
                                │
                    (loop back to worker claims)
```

## Retry Schedule

- **Max attempts:** 4 (including initial)
- **Backoff delays:** 2s, 5s, 10s (with 500-1500ms jitter)
- **Cron frequency:** Every minute

## Logging

All retry events emit structured logs:

```
[TIER_A_WORKER] claimed extraction_id=...
[TIER_A_WORKER] attempt=2/4 reason=checkout_link_not_found
[TIER_A_WORKER] scheduled next_retry_at=... backoffMs=...
[TIER_A_WORKER] success extraction_id=...
[TIER_A_WORKER] exhausted extraction_id=... after 4 attempts
```

## Guarantees

1. **Progress:** Every Tier-A extraction eventually reaches a terminal state
2. **Idempotency:** Atomic row-level locking prevents double execution
3. **Consistency:** Finalization blocked until all retries complete
4. **Recovery:** Stale `running` jobs are automatically recovered
5. **Determinism:** Same search produces same results (no random failures)
