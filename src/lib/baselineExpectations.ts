/**
 * Canonical Stable Baseline Expectations - v2.0.0
 * 
 * This file defines the observable behaviours expected from the system
 * when operating at the declared stable baseline.
 * 
 * IMPORTANT: This is NOT implementation documentation.
 * These are testable, observable outcomes that define "working correctly".
 * 
 * Baseline changes must be EXPLICIT and INTENTIONAL.
 * Do not auto-update on deploy.
 */

export const BASELINE_NAME = 'search-results-finalization-baseline-v1';
export const BASELINE_VERSION = '1.0.0';

export interface BaselineExpectation {
  id: string;
  category: 'search' | 'results' | 'pricing' | 'access_control' | 'admin' | 'finalization';
  description: string;
  observable: string;
  critical: boolean;
}

/**
 * Observable behaviours that define the stable baseline.
 * Each expectation is testable and verifiable.
 */
export const BASELINE_EXPECTATIONS: BaselineExpectation[] = [
  // Search Flow
  {
    id: 'search_completes',
    category: 'search',
    description: 'Search completes successfully',
    observable: 'Search reaches "completed" or terminal status without hanging',
    critical: true,
  },
  {
    id: 'progress_monotonic',
    category: 'search',
    description: 'Progress stages advance monotonically',
    observable: 'Progress indicator never moves backward during search',
    critical: true,
  },
  {
    id: 'stages_count',
    category: 'search',
    description: 'Six canonical stages displayed',
    observable: 'Progress shows: Analyzing → Gathering → Finding → Validating → Pricing → Finalizing',
    critical: false,
  },
  {
    id: 'global_stuck_cleanup',
    category: 'search',
    description: 'Old stuck extractions auto-cleaned',
    observable: 'Pending extractions >5min old marked as timeout before new search starts',
    critical: true,
  },

  // Results Display
  {
    id: 'results_render',
    category: 'results',
    description: 'Search results render correctly',
    observable: 'Result cards display platform, price, verification status',
    critical: true,
  },
  {
    id: 'photo_comparison_present',
    category: 'results',
    description: 'Photo comparison available for all results',
    observable: 'Evidence button renders for all result states (success, failure, no-match)',
    critical: true,
  },
  {
    id: 'verified_unverified_separation',
    category: 'results',
    description: 'Prices classified as verified or unverified',
    observable: 'Verified prices in comparison group, unverified in "manual check" group',
    critical: true,
  },
  {
    id: 'summary_shown',
    category: 'results',
    description: 'Comparison summary text always shown',
    observable: 'Outcome message displayed matching result state logic',
    critical: true,
  },
  {
    id: 'summary_logic_correct',
    category: 'results',
    description: 'Summary text is logically correct',
    observable: 'No contradictions (e.g., "no cheaper found" when zero platforms identified)',
    critical: true,
  },

  // Pricing Integrity
  {
    id: 'verified_prices_only_for_comparison',
    category: 'pricing',
    description: 'Only verified prices used for comparison',
    observable: 'Savings claims based only on verified prices meeting all criteria',
    critical: true,
  },
  {
    id: 'unverified_shown_as_manual_check',
    category: 'pricing',
    description: 'Unverified prices labeled appropriately',
    observable: '"Manual check recommended" category for unverified platforms',
    critical: true,
  },
  {
    id: 'no_false_savings_claims',
    category: 'pricing',
    description: 'No false savings claims',
    observable: 'Savings never shown for unverified or low-confidence platforms',
    critical: true,
  },
  {
    id: 'stuck_extractions_auto_timeout',
    category: 'pricing',
    description: 'No stuck pending extractions',
    observable: 'Pending extractions >5min automatically marked as timeout',
    critical: true,
  },

  // Access Control
  {
    id: 'locked_mode_works',
    category: 'access_control',
    description: 'Locked mode hides sensitive data',
    observable: 'Anonymous users see LockedResultsView, prices/links hidden',
    critical: true,
  },
  {
    id: 'unlocked_mode_works',
    category: 'access_control',
    description: 'Unlocked mode shows full data',
    observable: 'Authenticated/privileged users see full prices, links, and actions',
    critical: true,
  },
  {
    id: 'admin_bypass_works',
    category: 'access_control',
    description: 'Admin bypass grants full access',
    observable: 'Valid admin session can view any search in unlocked state',
    critical: false,
  },

  // Admin Dashboard
  {
    id: 'dashboard_live_data',
    category: 'admin',
    description: 'Admin dashboard shows live data',
    observable: 'Health Overview, Extractions, Pipeline pages display current data',
    critical: true,
  },
  {
    id: 'price_extractions_visible',
    category: 'admin',
    description: 'Price extractions table populated',
    observable: 'Extractions page shows records from price_extractions table',
    critical: true,
  },
  {
    id: 'health_monitoring_active',
    category: 'admin',
    description: 'System health monitoring operational',
    observable: 'Health indicators update based on data staleness thresholds',
    critical: true,
  },
  {
    id: 'platform_reliability_dashboard',
    category: 'admin',
    description: 'Platform reliability metrics visible',
    observable: '/admin/reliability shows verification rates per platform over time',
    critical: false,
  },
  {
    id: 'baseline_info_panel',
    category: 'admin',
    description: 'Baseline info visible in dashboard',
    observable: 'Health Overview shows active baseline name and version',
    critical: false,
  },

  // Finalization Contract (NEW in v1.0.0)
  {
    id: 'no_results_before_final',
    category: 'finalization',
    description: 'No results render before finalised_at',
    observable: 'User sees "Finding Better Deals" with Activity Log until finalization completes',
    critical: true,
  },
  {
    id: 'atomic_backend_finalization',
    category: 'finalization',
    description: 'status=completed only set with snapshot',
    observable: 'finalizeAndCompleteSearch() performs single atomic DB update',
    critical: true,
  },
  {
    id: 'deterministic_snapshot_rendering',
    category: 'finalization',
    description: 'Results from snapshot only after finalization',
    observable: 'Refreshing page shows identical results',
    critical: true,
  },
  {
    id: 'no_background_mutation',
    category: 'finalization',
    description: 'No mutations after terminal freeze',
    observable: 'No UI flicker after isTerminalFrozen is set',
    critical: true,
  },
  {
    id: 'all_platforms_in_snapshot',
    category: 'finalization',
    description: 'All matched platforms appear in results',
    observable: 'Platforms never disappear from final results, even if extraction failed',
    critical: true,
  },
  {
    id: 'finalization_progress_gate',
    category: 'finalization',
    description: 'Finalization progress indicator visible',
    observable: '"X/Y platforms finalized" shown during terminalHydrating state',
    critical: false,
  },
];

/**
 * Get expectations grouped by category for display
 */
export function getExpectationsByCategory(): Record<string, BaselineExpectation[]> {
  return BASELINE_EXPECTATIONS.reduce((acc, exp) => {
    if (!acc[exp.category]) acc[exp.category] = [];
    acc[exp.category].push(exp);
    return acc;
  }, {} as Record<string, BaselineExpectation[]>);
}

/**
 * Get critical expectations only (for regression tests)
 */
export function getCriticalExpectations(): BaselineExpectation[] {
  return BASELINE_EXPECTATIONS.filter(e => e.critical);
}

/**
 * Category display names
 */
export const CATEGORY_LABELS: Record<string, string> = {
  search: 'Search Flow',
  results: 'Results Display',
  pricing: 'Pricing Integrity',
  access_control: 'Access Control',
  admin: 'Admin Dashboard',
  finalization: 'Finalization Contract',
};
