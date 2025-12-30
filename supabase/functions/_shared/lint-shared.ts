#!/usr/bin/env -S deno run --allow-read

/**
 * Shared Module Enforcement Script
 * 
 * Scans edge functions for forbidden patterns that should only exist in _shared/.
 * Fails the build if duplication is detected.
 * 
 * Run: deno task lint:shared
 * Or:  deno run --allow-read supabase/functions/_shared/lint-shared.ts
 */

const FUNCTIONS_DIR = "./supabase/functions";
const SHARED_DIR = "_shared";

// Patterns that must ONLY exist in _shared/
// Phase 1: Core patterns from migrated functions (search-alternatives, airbnb-baseline-test, airbnb-selftest, airbnb-diagnostic)
// Phase 2: Expand to all functions as they are migrated
const FORBIDDEN_PATTERNS: Array<{
  pattern: RegExp;
  name: string;
  allowedIn: string;
  message: string;
}> = [
  // NOTE: corsHeaders is NOT enforced yet - too many files need migration
  // This will be enabled in a future phase after all functions are migrated
  // {
  //   pattern: /const\s+corsHeaders\s*[:=]\s*\{/,
  //   name: "corsHeaders definition",
  //   allowedIn: "_shared/http/cors.ts",
  //   message: "Import corsHeaders from '../_shared/mod.ts' instead of defining locally.",
  // },
  {
    pattern: /function\s+buildBookStaysUrl\s*\(/,
    name: "buildBookStaysUrl function",
    allowedIn: "_shared/airbnb/url-utils.ts",
    message: "Import buildBookStaysUrl from '../_shared/mod.ts' instead of defining locally.",
  },
  {
    pattern: /function\s+fetchWithTimeout\s*\(/,
    name: "fetchWithTimeout function",
    allowedIn: "_shared/http/fetch-utils.ts",
    message: "Import fetchWithTimeout from '../_shared/mod.ts' instead of defining locally.",
  },
  {
    pattern: /function\s+detectBotIndicators\s*\(/,
    name: "detectBotIndicators function",
    allowedIn: "_shared/airbnb/bot-detection.ts",
    message: "Import detectBotIndicators from '../_shared/mod.ts' instead of defining locally.",
  },
  {
    pattern: /function\s+isValidPropertyImage\s*\(/,
    name: "isValidPropertyImage function",
    allowedIn: "_shared/airbnb/image-extraction.ts",
    message: "Import isValidPropertyImage from '../_shared/mod.ts' instead of defining locally.",
  },
  {
    pattern: /async\s+function\s+logProviderRequest\s*\(/,
    name: "logProviderRequest function",
    allowedIn: "_shared/logging/provider-logs.ts",
    message: "Import logProviderRequest from '../_shared/mod.ts' instead of defining locally.",
  },
  {
    pattern: /\/https:\\\/\\\/a\\d\+\\\.muscache\\\.com\\\/im\\\/pictures/,
    name: "muscache URL pattern",
    allowedIn: "_shared/airbnb/image-extraction.ts",
    message: "Import MUSCACHE_PATTERNS from '../_shared/mod.ts' instead of defining locally.",
  },
];

interface Violation {
  file: string;
  line: number;
  pattern: string;
  message: string;
}

async function* walkDir(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      // Skip _shared directory when checking for violations
      if (entry.name !== SHARED_DIR) {
        yield* walkDir(path);
      }
    } else if (entry.isFile && entry.name.endsWith(".ts")) {
      yield path;
    }
  }
}

async function checkFile(filePath: string): Promise<Violation[]> {
  const violations: Violation[] = [];
  const content = await Deno.readTextFile(filePath);
  const lines = content.split("\n");

  for (const { pattern, name, allowedIn, message } of FORBIDDEN_PATTERNS) {
    // Skip if this file is the allowed location
    if (filePath.includes(allowedIn)) continue;

    for (let i = 0; i < lines.length; i++) {
      if (pattern.test(lines[i])) {
        violations.push({
          file: filePath,
          line: i + 1,
          pattern: name,
          message,
        });
      }
    }
  }

  return violations;
}

async function main() {
  console.log("🔍 Checking for shared module violations...\n");

  const allViolations: Violation[] = [];

  try {
    for await (const file of walkDir(FUNCTIONS_DIR)) {
      const violations = await checkFile(file);
      allViolations.push(...violations);
    }
  } catch (e) {
    console.error("Error scanning files:", e);
    Deno.exit(1);
  }

  if (allViolations.length === 0) {
    console.log("✅ No shared module violations found.\n");
    console.log("All shared logic is properly centralized in _shared/.");
    Deno.exit(0);
  }

  console.error("❌ SHARED MODULE VIOLATIONS DETECTED\n");
  console.error("The following patterns must only be defined in _shared/:\n");

  // Group by file
  const byFile = new Map<string, Violation[]>();
  for (const v of allViolations) {
    const list = byFile.get(v.file) || [];
    list.push(v);
    byFile.set(v.file, list);
  }

  for (const [file, violations] of byFile) {
    console.error(`\n📄 ${file}`);
    for (const v of violations) {
      console.error(`   Line ${v.line}: ${v.pattern}`);
      console.error(`   → ${v.message}`);
    }
  }

  console.error(`\n\nTotal violations: ${allViolations.length}`);
  console.error("\n⚠️  Fix these violations before deploying.");
  console.error("See supabase/functions/_shared/README.md for migration instructions.\n");

  Deno.exit(1);
}

main();
