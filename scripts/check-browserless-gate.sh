#!/bin/bash
# =============================================================================
# BROWSERLESS GATE REGRESSION GUARD
# =============================================================================
# This script verifies that ALL Browserless calls are routed through the 
# distributed gate module. It fails if any direct fetch() calls to 
# chrome.browserless.io are found outside the shared helper.
#
# Usage: ./scripts/check-browserless-gate.sh
#        OR: npm run lint:browserless
#
# Expected result: 0 direct calls (exit 0)
#                  N direct calls found (exit 1)
# =============================================================================

GATE_MODULE="supabase/functions/_shared/browserlessGate.ts"

echo "🔍 Checking for direct Browserless calls outside the gate module..."
echo ""

# Find all files containing chrome.browserless.io except the gate module
# and filter to only show actual fetch() calls (not comments or gated calls)
DIRECT_CALLS=$(grep -rn "chrome\.browserless\.io" supabase/functions/ \
  --include="*.ts" \
  | grep -v "$GATE_MODULE" \
  | grep -v "gatedBrowserlessFetch\|gatedBrowserlessFunctionFetch" \
  | grep -v "// USAGE:" \
  | grep -v "^\s*//" \
  | grep "fetch\|await fetch" \
  || true)

if [ -n "$DIRECT_CALLS" ]; then
  echo "❌ REGRESSION: Found direct Browserless calls outside the gate module!"
  echo ""
  echo "$DIRECT_CALLS"
  echo ""
  echo "All Browserless calls MUST use gatedBrowserlessFetch() or gatedBrowserlessFunctionFetch()"
  echo "from supabase/functions/_shared/browserlessGate.ts"
  exit 1
fi

# Also check for any new files using chrome.browserless.io
ALL_REFS=$(grep -rln "chrome\.browserless\.io" supabase/functions/ --include="*.ts" | grep -v "$GATE_MODULE" || true)

if [ -n "$ALL_REFS" ]; then
  echo "📋 Files containing chrome.browserless.io references (should all use gate wrappers):"
  echo "$ALL_REFS" | while read file; do
    # Check if file has proper gate imports
    if grep -q "gatedBrowserlessFetch\|gatedBrowserlessFunctionFetch" "$file"; then
      echo "  ✅ $file (uses gate)"
    else
      echo "  ⚠️  $file (missing gate import - needs review)"
    fi
  done
  echo ""
fi

echo "✅ All Browserless calls are properly gated through the distributed lock."
exit 0
