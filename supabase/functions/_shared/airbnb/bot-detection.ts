/**
 * Bot Detection - Single Source of Truth
 * 
 * @module _shared/airbnb/bot-detection
 * @description Canonical bot/captcha detection for Airbnb scraping.
 * 
 * OWNERSHIP: This module owns all bot detection patterns and logic.
 * CONSUMERS: All Airbnb scrapers (search-alternatives, airbnb-baseline-test, airbnb-selftest)
 * 
 * DO NOT duplicate detectBotIndicators in individual edge functions.
 * Import from this module instead.
 */

export const MODULE_VERSION = "1.0.0";

/**
 * Patterns that indicate bot detection or captcha walls.
 * These must appear in visible text context, not CSS class names or scripts.
 */
export const BOT_PATTERNS: Array<{ pattern: RegExp; indicator: string }> = [
  { pattern: /please verify you are a human/i, indicator: "captcha" },
  { pattern: /checking your browser/i, indicator: "browser_check" },
  { pattern: /access denied/i, indicator: "access_denied" },
  { pattern: /blocked/i, indicator: "blocked" },
  { pattern: /unusual traffic/i, indicator: "unusual_traffic" },
  { pattern: /security check/i, indicator: "security_check" },
  { pattern: /complete the challenge/i, indicator: "challenge" },
  { pattern: /prove you['']?re not a robot/i, indicator: "robot_check" },
];

/**
 * Sanitizes HTML content for bot detection.
 * Removes CSS, scripts, and class/id attributes to prevent false positives.
 * 
 * @param content - Raw HTML content
 * @returns Sanitized visible text content
 */
export function sanitizeForBotDetection(content: string): string {
  return content
    // Remove style blocks
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    // Remove script blocks
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    // Remove CSS rule blocks
    .replace(/\{[^}]*\}/g, " ")
    // Remove class attributes
    .replace(/class\s*=\s*["'][^"']*["']/gi, " ")
    // Remove id attributes
    .replace(/id\s*=\s*["'][^"']*["']/gi, " ");
}

/**
 * Detects bot/captcha indicators in HTML content.
 * 
 * IMPORTANT: This function sanitizes content before detection to prevent
 * false positives from CSS class names or script contents.
 * 
 * @param content - HTML content to analyze
 * @returns Array of detected indicator names (empty if no bot detection found)
 * 
 * @example
 * ```typescript
 * const indicators = detectBotIndicators(htmlContent);
 * if (indicators.length > 0) {
 *   console.log("Bot detected:", indicators.join(", "));
 * }
 * ```
 */
export function detectBotIndicators(content: string): string[] {
  const indicators: string[] = [];
  
  // Sanitize to avoid false positives from CSS/scripts
  const visibleContent = sanitizeForBotDetection(content);
  
  for (const { pattern, indicator } of BOT_PATTERNS) {
    if (pattern.test(visibleContent)) {
      indicators.push(indicator);
    }
  }
  
  return indicators;
}

/**
 * Checks if content indicates a bot wall or captcha.
 * Convenience function that returns boolean instead of array.
 * 
 * @param content - HTML content to analyze
 * @returns true if bot detection is present
 */
export function hasBotWall(content: string): boolean {
  return detectBotIndicators(content).length > 0;
}

/**
 * Checks if the page appears to be a login redirect.
 * 
 * @param url - Current page URL
 * @returns true if URL indicates login redirect
 */
export function isLoginRedirect(url: string): boolean {
  const lowerUrl = url.toLowerCase();
  return lowerUrl.includes("/login") || lowerUrl.includes("/signin") || lowerUrl.includes("/oauth");
}
