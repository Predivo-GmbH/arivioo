#!/bin/bash
# =============================================================================
# BROWSERLESS GATE REGRESSION GUARD - FINAL
# =============================================================================
# INVARIANT: Direct HTTP requests to browserless.io are FORBIDDEN outside the
#            shared gate module. URL constants are ALLOWED anywhere.
#
# FAILS on:
#   - fetch(`https://chrome.browserless.io/...`)
#   - axios.post("https://browserless.io/...")
#   - Any HTTP client invocation with browserless.io URL
#
# PASSES on:
#   - const url = `https://chrome.browserless.io/...`  (URL constant)
#   - gatedBrowserlessFetch(url, ...)                  (gated call)
#   - gatedBrowserlessFunctionFetch(url, ...)          (gated call)
#
# Usage: ./scripts/check-browserless-gate.sh
# =============================================================================

set -e

# The ONLY file allowed to make direct Browserless HTTP requests
GATE_MODULE="supabase/functions/_shared/browserlessGate.ts"

# Documentation files that may reference browserless.io for examples
DOC_FILES=(
  "docs/BROWSERLESS_GATE_IMPLEMENTATION.md"
  "docs/BROWSERLESS_CANONICAL_BASELINE.md"
  "scripts/check-browserless-gate.sh"
)

echo "🔍 BROWSERLESS GATE REGRESSION GUARD"
echo "====================================="
echo ""
echo "Invariant: Direct HTTP requests to browserless.io are forbidden"
echo "           outside $GATE_MODULE"
echo ""

VIOLATIONS=""
VIOLATION_COUNT=0

# -----------------------------------------------------------------------------
# STEP 1: Find all files with browserless.io references
# -----------------------------------------------------------------------------
echo "Step 1: Scanning repository for browserless.io references..."

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

FILE_COUNT=$(echo "$FILES_WITH_REFS" | grep -c . || echo "0")
echo "   Found $FILE_COUNT file(s) with browserless.io references"
echo ""

# -----------------------------------------------------------------------------
# STEP 2: Check each file for DIRECT HTTP calls (not URL constants)
# -----------------------------------------------------------------------------
echo "Step 2: Checking for forbidden direct HTTP calls..."

for file in $FILES_WITH_REFS; do
  FILE_PATH=$(echo "$file" | sed 's|^\./||')
  
  # Skip the gate module itself
  if [ "$FILE_PATH" = "$GATE_MODULE" ]; then
    echo "   ✓ $FILE_PATH (gate module - allowed)"
    continue
  fi
  
  # Skip documentation files
  IS_DOC=false
  for doc in "${DOC_FILES[@]}"; do
    if [ "$FILE_PATH" = "$doc" ]; then
      IS_DOC=true
      break
    fi
  done
  if [ "$IS_DOC" = true ]; then
    echo "   ✓ $FILE_PATH (documentation - allowed)"
    continue
  fi
  
  # -------------------------------------------------------------------------
  # Pattern 1: Direct fetch() calls with browserless URL on same line
  # Matches: fetch("https://chrome.browserless.io/...")
  #          fetch(`https://chrome.browserless.io/...`)
  #          await fetch(browserlessUrl, ...)
  # Does NOT match: gatedBrowserlessFetch(...) or gatedBrowserlessFunctionFetch(...)
  # -------------------------------------------------------------------------
  
  # Get all lines with fetch( that also reference browserless
  DIRECT_FETCH=$(grep -nE "fetch\s*\(" "$file" 2>/dev/null | \
    grep -iE "browserless" | \
    grep -vE "gatedBrowserlessFetch|gatedBrowserlessFunctionFetch" || true)
  
  if [ -n "$DIRECT_FETCH" ]; then
    while IFS= read -r line; do
      LINE_NUM=$(echo "$line" | cut -d: -f1)
      LINE_CONTENT=$(echo "$line" | cut -d: -f2-)
      VIOLATIONS="$VIOLATIONS❌ $FILE_PATH:$LINE_NUM - Direct fetch() call\n   $LINE_CONTENT\n\n"
      ((VIOLATION_COUNT++)) || true
    done <<< "$DIRECT_FETCH"
  fi
  
  # -------------------------------------------------------------------------
  # Pattern 2: axios calls with browserless URL
  # Matches: axios.post("https://browserless.io/...")
  #          axios.get(browserlessUrl)
  #          axios({ url: "https://browserless.io/..." })
  # -------------------------------------------------------------------------
  
  AXIOS_CALLS=$(grep -nE "axios\s*[\.(]" "$file" 2>/dev/null | \
    grep -iE "browserless" || true)
  
  if [ -n "$AXIOS_CALLS" ]; then
    while IFS= read -r line; do
      LINE_NUM=$(echo "$line" | cut -d: -f1)
      LINE_CONTENT=$(echo "$line" | cut -d: -f2-)
      VIOLATIONS="$VIOLATIONS❌ $FILE_PATH:$LINE_NUM - Direct axios() call\n   $LINE_CONTENT\n\n"
      ((VIOLATION_COUNT++)) || true
    done <<< "$AXIOS_CALLS"
  fi
  
  # -------------------------------------------------------------------------
  # Pattern 3: http/https module calls (Node.js style)
  # Matches: http.request("https://browserless.io/...")
  #          https.get(browserlessUrl)
  # -------------------------------------------------------------------------
  
  HTTP_CALLS=$(grep -nE "(http|https)\s*\.\s*(request|get|post)" "$file" 2>/dev/null | \
    grep -iE "browserless" || true)
  
  if [ -n "$HTTP_CALLS" ]; then
    while IFS= read -r line; do
      LINE_NUM=$(echo "$line" | cut -d: -f1)
      LINE_CONTENT=$(echo "$line" | cut -d: -f2-)
      VIOLATIONS="$VIOLATIONS❌ $FILE_PATH:$LINE_NUM - Direct http/https call\n   $LINE_CONTENT\n\n"
      ((VIOLATION_COUNT++)) || true
    done <<< "$HTTP_CALLS"
  fi
  
  # If no violations found for this file, it's clean (URL constants only)
  if [ -z "$DIRECT_FETCH" ] && [ -z "$AXIOS_CALLS" ] && [ -z "$HTTP_CALLS" ]; then
    echo "   ✓ $FILE_PATH (URL constants only - allowed)"
  fi
  
done

echo ""

# -----------------------------------------------------------------------------
# STEP 3: Verify gate module uses are correct (edge functions must import gate)
# -----------------------------------------------------------------------------
echo "Step 3: Verifying edge functions use gated helpers..."

EDGE_FUNCTIONS_WITH_REFS=$(echo "$FILES_WITH_REFS" | grep "^supabase/functions/" | grep -v "_shared/" || true)

for file in $EDGE_FUNCTIONS_WITH_REFS; do
  FILE_PATH=$(echo "$file" | sed 's|^\./||')
  
  # Check if file imports gated helpers
  HAS_GATE_IMPORT=$(grep -E "gatedBrowserlessFetch|gatedBrowserlessFunctionFetch" "$file" 2>/dev/null || true)
  
  if [ -z "$HAS_GATE_IMPORT" ]; then
    # Check if there are any fetch calls (not just URL constants)
    HAS_FETCH=$(grep -E "fetch\s*\(" "$file" 2>/dev/null | grep -iE "browserless" || true)
    if [ -n "$HAS_FETCH" ]; then
      echo "   ⚠️  $FILE_PATH has browserless fetch but no gate helper import"
      VIOLATIONS="$VIOLATIONS⚠️  $FILE_PATH\n   Contains browserless fetch() but doesn't import gate helpers\n\n"
      ((VIOLATION_COUNT++)) || true
    fi
  else
    echo "   ✓ $FILE_PATH imports gate helpers"
  fi
done

echo ""

# -----------------------------------------------------------------------------
# FINAL REPORT
# -----------------------------------------------------------------------------
if [ $VIOLATION_COUNT -gt 0 ]; then
  echo "❌ REGRESSION DETECTED: $VIOLATION_COUNT violation(s) found!"
  echo ""
  echo "Violations:"
  echo "============================================================================"
  echo -e "$VIOLATIONS"
  echo "============================================================================"
  echo ""
  echo "FIX: All direct HTTP requests to browserless.io MUST use the gated helpers:"
  echo "     - gatedBrowserlessFetch()         (for /content endpoint)"
  echo "     - gatedBrowserlessFunctionFetch() (for /function, /scrape endpoints)"
  echo ""
  echo "     Import from: supabase/functions/_shared/browserlessGate.ts"
  echo ""
  exit 1
fi

echo "✅ All Browserless calls are properly gated!"
echo ""
echo "Summary:"
echo "  - Scanned $FILE_COUNT file(s) with browserless.io references"
echo "  - 0 direct HTTP calls outside gate module"
echo "  - All edge functions use gated helpers"
echo ""
exit 0
