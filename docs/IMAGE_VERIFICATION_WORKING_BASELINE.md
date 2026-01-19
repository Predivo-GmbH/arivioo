# Image Verification Working Baseline

## Current Active Baseline: `image-verification-two-pass-v1`

**Version:** 1.0.0  
**Declared:** 2026-01-19  
**Declared By:** user-declared  
**Status:** LOCKED - Do not modify without explicit baseline update

---

## Baseline Identity

| Field | Value |
|-------|-------|
| **Name** | `image-verification-two-pass-v1` |
| **Version** | `1.0.0` |
| **Previous** | N/A (initial baseline) |

## Purpose

This baseline captures the **correct, validated behavior** of the image verification system for search results. It serves as a reference point for future changes and a safe revert target if regressions occur.

## Core Logic (DO NOT MODIFY)

### Two-Pass Verification System

| Pass | Threshold | Purpose | Outcome |
|------|-----------|---------|---------|
| **PASS 1** | ≥ 75% | Discovery | Candidate persisted to `search_platforms`, shown in UI |
| **PASS 2** | ≥ 90% | Authority | Candidate receives "Verified" badge |

### Outcome Categories

| Confidence Score | outcome_category | UI Behavior |
|------------------|------------------|-------------|
| ≥ 90% | `authoritative` | Green "Verified" badge, full trust |
| 75-89% | `needs_review` | Amber "Needs Review" badge |
| < 75% | `rejected` | Shown in "Below Trust Threshold" section (testing mode) |

### Candidate Persistence Contract

ALL discovered candidates are persisted to `search_platforms` regardless of score:
- `outcome_category`: 'authoritative', 'needs_review', or 'rejected'
- `confidence_score`: Actual numerical score from vision model
- `extraction_status_terminal`: 'verification_rejected' for low-score candidates

### Prompt Strategy

The system uses a **BALANCED IDENTITY VERIFICATION PROMPT** that:
1. Focuses on **fixed structural elements** (stone patterns, beam layouts, fixture positions)
2. Acknowledges **same property can appear differently** (camera angle, lighting, staging)
3. Avoids false negatives for clear matches
4. Scoring: 90-100% identical, 75-89% very likely, 60-74% uncertain, <60% unlikely

## Key Files (Baseline Reference)

| File | Purpose | Critical Lines |
|------|---------|----------------|
| `supabase/functions/search-alternatives/index.ts` | Two-pass logic, balanced prompt | Lines 1529-1700 |
| `src/pages/SearchResults.tsx` | UI rendering, low-trust section | Lines 327-333, 1728-1745, 3100-3200 |
| `supabase/functions/_shared/buildFinalSnapshot.ts` | Snapshot inclusion logic | Lines 115-206 |

## Observable Behaviors (Acceptance Criteria)

### Discovery Phase (PASS 1)

| ID | Behavior | Observable |
|----|----------|------------|
| `pass1_threshold` | PASS 1 uses ≥75% threshold | Candidates ≥75% appear in main results |
| `pass1_persistence` | All candidates persisted | All discovered platforms in `search_platforms` |
| `pass1_rejection` | Low scores rejected | <75% candidates NOT in main results |

### Authority Phase (PASS 2)

| ID | Behavior | Observable |
|----|----------|------------|
| `pass2_threshold` | PASS 2 uses ≥90% threshold | Only ≥90% get "Verified" badge |
| `pass2_advisory` | PASS 2 is advisory | 75-89% get "Needs Review", still shown |
| `pass2_no_removal` | PASS 2 never removes | PASS 1 approved candidates stay |

### UI Rendering

| ID | Behavior | Observable |
|----|----------|------------|
| `verified_badge` | Green verified badge | ≥90% shows CheckCircle + "Verified" |
| `needs_review_badge` | Amber badge | 75-89% shows AlertTriangle + "Needs Review" |
| `low_trust_section` | Testing section | <75% in collapsible "Below Trust Threshold" |
| `actual_scores_shown` | Real scores displayed | Badges show actual % (not just "<75%") |
| `sorted_by_score` | Descending sort | Low-trust section sorted highest to lowest |

### False Positive Prevention

| ID | Behavior | Observable |
|----|----------|------------|
| `style_not_identity` | Style ≠ match | Similar cabins with different structure rejected |
| `structural_focus` | Structural elements | Stone patterns, beam layouts are key identifiers |

### False Negative Prevention

| ID | Behavior | Observable |
|----|----------|------------|
| `same_image_match` | Identical images match | Same image = high score (85%+) |
| `angle_tolerance` | Camera angle tolerance | Different angles of same property still match |
| `lighting_tolerance` | Lighting tolerance | Different lighting doesn't cause rejection |

## Reverting to This Baseline

If future changes break behavior, revert using:

1. **Git History**: Restore files to commit containing this baseline
2. **Key Files to Restore**:
   - `supabase/functions/search-alternatives/index.ts` (lines 1529-1700)
   - `src/pages/SearchResults.tsx` (low-trust section logic)
3. **Redeploy**: Edge function `search-alternatives`

## Baseline History

| Version | Name | Declared | Key Changes |
|---------|------|----------|-------------|
| **1.0.0** | **image-verification-two-pass-v1** | **2026-01-19** | Initial baseline: Two-pass system, balanced prompt, candidate persistence |

---

## Change Log Requirement

Any modification to image verification logic MUST:

1. Document the change in this file
2. Update version number
3. Add entry to Baseline History
4. Get explicit user approval
5. Update `src/lib/baselineExpectations.ts`

---

*This baseline is LOCKED. Future prompts can safely say "Revert to image-verification-two-pass-v1" and the system will restore this exact behavior.*
