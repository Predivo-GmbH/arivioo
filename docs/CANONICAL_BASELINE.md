# Canonical Stable Baseline

This document defines the **search-results-stable-v1** baseline, the first formally recorded stable state of the search flow and admin systems.

## Baseline Identity

| Field | Value |
|-------|-------|
| **Name** | `search-results-stable-v1` |
| **Version** | `1.0.0` |
| **Declared** | 2026-01-02 |
| **Declared By** | system |

## Purpose

This baseline serves as:

1. **Debugging Reference**: "What changed since baseline?" is the first question for any regression
2. **Regression Control**: Future issues are compared against known-good behaviour
3. **Test Anchor**: Automated tests can verify behaviour matches baseline expectations
4. **Admin Visibility**: Super Admins can see which baseline is active

## Baseline Expectations

These are **observable behaviours**, not implementation details.

### Search Flow

| ID | Expectation | Observable |
|----|-------------|------------|
| `search_completes` | Search completes successfully | Search reaches "completed" status without hanging |
| `progress_monotonic` | Progress stages advance monotonically | Progress indicator never moves backward |
| `stages_count` | Six canonical stages displayed | Analyzing → Gathering → Finding → Validating → Pricing → Finalizing |
| `modal_auto_closes` | Confirmation modal auto-closes on valid price | If backend extracts valid Airbnb price, modal closes automatically |

### Results Display

| ID | Expectation | Observable |
|----|-------------|------------|
| `results_render` | Results render correctly | Result cards show platform, price, savings |
| `photo_comparison_present` | Photo comparison available | Evidence button renders for all result states |
| `summary_shown` | Summary text always shown | Outcome message displayed |
| `summary_logic_correct` | Summary is logically correct | No contradictions in messaging |

### Access Control

| ID | Expectation | Observable |
|----|-------------|------------|
| `locked_mode_works` | Locked mode hides data | Anonymous users see LockedResultsView |
| `unlocked_mode_works` | Unlocked mode shows data | Authenticated users see full details |
| `admin_bypass_works` | Admin bypass grants access | Valid admin session can view any search |

### Admin Dashboard

| ID | Expectation | Observable |
|----|-------------|------------|
| `dashboard_live_data` | Dashboard shows live data | Health Overview displays current data |
| `price_extractions_visible` | Extractions table populated | Extractions page shows records |
| `health_monitoring_active` | Health monitoring operational | Indicators update based on staleness |

## Storage Location

The baseline is stored in:

- **Database**: `public.system_baselines` table (authoritative source)
- **Code**: `src/lib/baselineExpectations.ts` (expectation definitions)
- **Docs**: This file (human reference)

## Viewing the Baseline

Admins can view the active baseline in:

1. **Super Admin Dashboard** → Health Overview → "Current Stable Baseline" panel
2. **API**: `GET /admin-dashboard/baseline` (authenticated)

## Updating the Baseline

**Baseline changes must be EXPLICIT and INTENTIONAL.**

Do NOT:
- Auto-update on deploy
- Update via automated scripts
- Rely on chat history or comments

To declare a new baseline:

1. Verify the system is in a known-good state
2. Insert a new record in `system_baselines` with `is_active = true`
3. The unique index will enforce only one active baseline
4. Update this documentation
5. Update `src/lib/baselineExpectations.ts` if expectations change

## Regression Detection

When debugging issues, ask:

1. "Does current behaviour match baseline expectations?"
2. "What changed since the baseline was declared?"
3. "Is this a regression or a new issue?"

Use the expectation IDs to reference specific behaviours in bug reports.

## Known Issues at Baseline

None. This baseline was declared after resolving:

- Monotonic progress guard for SSE and polling paths
- Confirmation modal auto-close on valid price extraction
- Admin dashboard data visibility
- Search outcome logic consistency

---

*This baseline is the canonical reference point. Future prompts can safely say "Compare against search-results-stable-v1" and the system will know exactly what that means.*
