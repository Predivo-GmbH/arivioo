/**
 * Canonical Stable Baseline Expectations
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

export const BASELINE_NAME = 'search-results-stable-v1';
export const BASELINE_VERSION = '1.0.0';

export interface BaselineExpectation {
  id: string;
  category: 'search' | 'results' | 'access_control' | 'admin';
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
    id: 'modal_auto_closes',
    category: 'search',
    description: 'Confirmation modal auto-closes on valid price',
    observable: 'If backend extracts valid Airbnb price, modal does not appear or closes automatically',
    critical: true,
  },

  // Results Display
  {
    id: 'results_render',
    category: 'results',
    description: 'Search results render correctly',
    observable: 'Result cards display platform, price, savings when available',
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
  access_control: 'Access Control',
  admin: 'Admin Dashboard',
};
