# Canonical Stable Baseline

## Current Active Baseline: `search-results-stable-v2`

**Version:** 2.0.0  
**Declared:** 2026-01-02  
**Declared By:** user-declared

---

## Baseline Identity

| Field | Value |
|-------|-------|
| **Name** | `search-results-stable-v2` |
| **Version** | `2.0.0` |
| **Previous** | `search-results-stable-v1` |

## What's New in v2

This baseline includes all v1 behaviours plus:

1. **Verified vs Unverified Price Classification** - Prices are now classified as `verified` (eligible for comparison) or `unverified` (manual check recommended)
2. **Global Stuck Extraction Cleanup** - Pipeline automatically cleans up stuck pending extractions from ALL searches before starting new work
3. **Platform Reliability Dashboard** - Admin view showing verification success rates per platform over time
4. **No Cross-Search Contamination** - Stuck extractions from old searches no longer block new ones

## Baseline Expectations

These are **observable behaviours**, not implementation details.

### Search Flow

| ID | Expectation | Observable |
|----|-------------|------------|
| `search_completes` | Search completes successfully | Search reaches "completed" status without hanging |
| `progress_monotonic` | Progress stages advance monotonically | Progress indicator never moves backward |
| `stages_count` | Six canonical stages displayed | Analyzing → Gathering → Finding → Validating → Pricing → Finalizing |
| `global_stuck_cleanup` | Old stuck extractions auto-cleaned | Pending extractions >5min old marked as timeout before new search |

### Results Display

| ID | Expectation | Observable |
|----|-------------|------------|
| `results_render` | Results render correctly | Result cards show platform, price, verification status |
| `photo_comparison_present` | Photo comparison available | Evidence button renders for all result states |
| `verified_unverified_separation` | Prices classified correctly | Verified prices in comparison group, unverified in "manual check" group |
| `summary_shown` | Summary text always shown | Outcome message displayed |
| `summary_logic_correct` | Summary is logically correct | No contradictions in messaging |

### Pricing Integrity

| ID | Expectation | Observable |
|----|-------------|------------|
| `verified_prices_only_for_comparison` | Only verified prices compared | Savings claims based only on verified prices |
| `unverified_shown_as_manual_check` | Unverified prices labeled | "Manual check recommended" category for unverified |
| `no_false_savings_claims` | No false positives | Savings never shown for unverified platforms |
| `stuck_extractions_auto_timeout` | No stuck pending forever | Pending >5min automatically marked as timeout |

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
| `platform_reliability_dashboard` | Reliability metrics visible | `/admin/reliability` shows verification rates |
| `baseline_info_panel` | Baseline info visible | Health Overview shows active baseline |

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
3. Set previous baselines to `is_active = false`
4. Update this documentation
5. Update `src/lib/baselineExpectations.ts` if expectations change

## Regression Detection

When debugging issues, ask:

1. "Does current behaviour match baseline expectations?"
2. "What changed since the baseline was declared?"
3. "Is this a regression or a new issue?"

Use the expectation IDs to reference specific behaviours in bug reports.

## Baseline History

| Version | Name | Declared | Key Changes |
|---------|------|----------|-------------|
| 1.0.0 | search-results-stable-v1 | 2026-01-02 | Initial baseline: monotonic progress, modal auto-close |
| **2.0.0** | **search-results-stable-v2** | **2026-01-02** | **Verified/unverified prices, global stuck cleanup, reliability dashboard** |

---

*This baseline is the canonical reference point. Future prompts can safely say "Compare against search-results-stable-v2" and the system will know exactly what that means.*
