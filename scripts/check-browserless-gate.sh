#!/bin/bash
# =============================================================================
# BROWSERLESS GATE REGRESSION GUARD (STRICT)
# =============================================================================
# This script ensures ALL Browserless API calls are routed through the gate.
# It fails if any DIRECT calls (fetch/axios/http) to browserless.io are found
# outside the approved gate module.
#
# The script distinguishes between:
# - URL constants passed to gatedBrowserlessFetch/gatedBrowserlessFunctionFetch (OK)
# - Direct fetch/axios/http calls to browserless.io (FAIL)
#
# Usage: ./scripts/check-browserless-gate.sh
#
# Expected result: 0 violations (exit 0)
#                  N violations found (exit 1)
# =============================================================================

set -e

# Approved modules that may contain Browserless references
ALLOWED_FILES=(
  "supabase/functions/_shared/browserlessGate.ts"
  "docs/BROWSERLESS_GATE_IMPLEMENTATION.md"
  "docs/BROWSERLESS_CANONICAL_BASELINE.md"
  "scripts/check-browserless-gate.sh"
)

echo "🔍 BROWSERLESS GATE REGRESSION GUARD (STRICT)"
echo "=============================================="
echo ""
echo "Scanning for ungated Browserless calls..."
echo ""

# Track violations
VIOLATIONS=""
VIOLATION_COUNT=0

# ============================================================================
# CHECK 1: Find direct fetch/axios/http calls to browserless.io
# ============================================================================
# Look for patterns like:
#   fetch(`https://chrome.browserless.io/...`)
#   fetch("https://browserless.io/...")
#   axios.get("https://chrome.browserless.io/...")
#   http.post("https://browserless.io/...")
# 
# But NOT:
#   const url = `https://chrome.browserless.io/...`  (URL constant)
#   gatedBrowserlessFetch(url, ...)                  (gated call)

echo "Step 1: Checking for direct HTTP calls to browserless.io..."

# Find files with browserless.io references (excluding allowed files)
FILES_WITH_REFS=$(grep -rlE "browserless\.io" \
  --include="*.ts" \
  --include="*.tsx" \
  --include="*.js" \
  --include="*.jsx" \
  --include="*.mjs" \
  --include="*.cjs" \
  --exclude-dir=node_modules \
  --exclude-dir=.git \
  --exclude-dir=dist \
  --exclude-dir=build \
  . 2>/dev/null || true)

for file in $FILES_WITH_REFS; do
  # Remove ./ prefix
  FILE_PATH=$(echo "$file" | sed 's|^\./||')
  
  # Check if this file is in the allowed list
  IS_ALLOWED=false
  for allowed in "${ALLOWED_FILES[@]}"; do
    if [ "$FILE_PATH" = "$allowed" ]; then
      IS_ALLOWED=true
      break
    fi
  done
  
  if [ "$IS_ALLOWED" = true ]; then
    continue
  fi
  
  # Check for DIRECT calls (fetch/axios/http directly calling browserless)
  # Pattern: fetch( or axios. or http. followed by browserless.io on same line or next line
  DIRECT_CALLS=$(grep -nE "(fetch|axios\.|http\.)[^)]*browserless\.io" "$file" 2>/dev/null || true)
  
  if [ -n "$DIRECT_CALLS" ]; then
    while IFS= read -r line; do
      # Skip if line contains gatedBrowserlessFetch (it's a properly gated call)
      if echo "$line" | grep -qE "gatedBrowserlessFetch|gatedBrowserlessFunctionFetch"; then
        continue
      fi
      VIOLATIONS="$VIOLATIONS$FILE_PATH:$line\n"
      ((VIOLATION_COUNT++)) || true
    done <<< "$DIRECT_CALLS"
  fi
done

echo ""

# ============================================================================
# CHECK 2: Verify gate helpers are used correctly
# ============================================================================
echo "Step 2: Verifying gate helper usage in edge functions..."

# For each edge function file with browserless.io, verify it imports the gate
for file in $FILES_WITH_REFS; do
  FILE_PATH=$(echo "$file" | sed 's|^\./||')
  
  # Only check supabase/functions files (excluding _shared)
  if [[ ! "$FILE_PATH" =~ ^supabase/functions/ ]] || [[ "$FILE_PATH" =~ ^supabase/functions/_shared/ ]]; then
    continue
  fi
  
  # Check if this file is in the allowed list
  IS_ALLOWED=false
  for allowed in "${ALLOWED_FILES[@]}"; do
    if [ "$FILE_PATH" = "$allowed" ]; then
      IS_ALLOWED=true
      break
    fi
  done
  
  if [ "$IS_ALLOWED" = true ]; then
    continue
  fi
  
  # Verify file imports the gate helpers
  if ! grep -qE "gatedBrowserlessFetch|gatedBrowserlessFunctionFetch" "$file" 2>/dev/null; then
    echo "  ⚠️  $FILE_PATH contains browserless.io but doesn't use gate helpers"
    VIOLATIONS="$VIOLATIONS$FILE_PATH: Contains browserless.io but no gate helper import\n"
    ((VIOLATION_COUNT++)) || true
  else
    echo "  ✓ $FILE_PATH uses gate helpers"
  fi
done

echo ""

# ============================================================================
# CHECK 3: Ensure no raw fetch() in files that should use the gate
# ============================================================================
echo "Step 3: Checking for raw fetch() bypasses..."

for file in $FILES_WITH_REFS; do
  FILE_PATH=$(echo "$file" | sed 's|^\./||')
  
  # Skip allowed files and non-edge-function files
  IS_ALLOWED=false
  for allowed in "${ALLOWED_FILES[@]}"; do
    if [ "$FILE_PATH" = "$allowed" ]; then
      IS_ALLOWED=true
      break
    fi
  done
  
  if [ "$IS_ALLOWED" = true ]; then
    continue
  fi
  
  # Look for fetch() calls on lines containing browserless
  # that aren't part of gatedBrowserlessFetch
  RAW_FETCHES=$(grep -nE "await\s+fetch\s*\(" "$file" 2>/dev/null | \
    grep -iE "browserless" | \
    grep -vE "gatedBrowserlessFetch|gatedBrowserlessFunctionFetch" || true)
  
  if [ -n "$RAW_FETCHES" ]; then
    while IFS= read -r line; do
      VIOLATIONS="$VIOLATIONS$FILE_PATH:$line\n"
      ((VIOLATION_COUNT++)) || true
    done <<< "$RAW_FETCHES"
  fi
done

echo ""

# ============================================================================
# FINAL REPORT
# ============================================================================
if [ $VIOLATION_COUNT -gt 0 ]; then
  echo "❌ REGRESSION DETECTED: $VIOLATION_COUNT violation(s) found!"
  echo ""
  echo "Violations:"
  echo "--------------------------------------------------------------------------------"
  echo -e "$VIOLATIONS"
  echo "--------------------------------------------------------------------------------"
  echo ""
  echo "FIX: All Browserless calls MUST use the gated helpers from:"
  echo "     supabase/functions/_shared/browserlessGate.ts"
  echo ""
  echo "Available helpers:"
  echo "  - gatedBrowserlessFetch()         (for /content endpoint)"
  echo "  - gatedBrowserlessFunctionFetch() (for /function and /scrape endpoints)"
  echo ""
  exit 1
fi

echo "✅ All Browserless calls are properly gated!"
echo ""
echo "Summary:"
echo "  - Scanned $(echo "$FILES_WITH_REFS" | wc -l | tr -d ' ') files with browserless.io references"
echo "  - All edge functions use gate helpers"
echo "  - No direct fetch() bypasses detected"
echo ""
echo "Approved modules:"
for allowed in "${ALLOWED_FILES[@]}"; do
  if [ -f "$allowed" ]; then
    echo "  ✓ $allowed"
  fi
done
echo ""
exit 0
