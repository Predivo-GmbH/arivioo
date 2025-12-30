/**
 * Airbnb Image Extraction - Single Source of Truth
 * 
 * @module _shared/airbnb/image-extraction
 * @description Canonical image extraction patterns for Airbnb listings.
 * 
 * OWNERSHIP: This module owns all Airbnb image URL patterns and extraction logic.
 * CONSUMERS: search-alternatives, all scrapers
 * 
 * DO NOT duplicate muscache patterns in individual edge functions.
 * Import from this module instead.
 */

export const MODULE_VERSION = "1.0.0";

/**
 * Regex patterns to extract Airbnb image URLs from HTML content.
 * Ordered by specificity - more specific patterns first.
 */
export const MUSCACHE_PATTERNS: RegExp[] = [
  // Standard hosting images
  /https:\/\/a0\.muscache\.com\/im\/pictures\/hosting\/Hosting-[^"'\s\)\]\\<>]+/gi,
  /https:\/\/a0\.muscache\.com\/im\/pictures\/miso\/[^"'\s\)\]\\<>]+/gi,
  /https:\/\/a0\.muscache\.com\/im\/pictures\/BnbProperty\/[^"'\s\)\]\\<>]+/gi,
  /https:\/\/a0\.muscache\.com\/im\/pictures\/prohost-api\/[^"'\s\)\]\\<>]+/gi,
  // UUID format images
  /https:\/\/a0\.muscache\.com\/im\/pictures\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}[^"'\s\)\]\\<>]*/gi,
  // Airbnb media URLs (newer format)
  /https:\/\/a0\.muscache\.com\/im\/ml\/[^"'\s\)\]\\<>]+/gi,
  // Alternative subdomains (a1, a2, etc.)
  /https:\/\/a[0-9]\.muscache\.com\/im\/pictures\/[^"'\s\)\]\\<>]+/gi,
  // Generic muscache with any path to /pictures/
  /https:\/\/[a-z0-9]+\.muscache\.com\/[^"'\s\)\]\\<>]*pictures[^"'\s\)\]\\<>]+/gi,
  // Newer airbnbusercontent.com domain
  /https:\/\/[a-z0-9-]+\.airbnbusercontent\.com\/[^"'\s\)\]\\<>]+/gi,
];

/**
 * Patterns to extract images from embedded JSON data.
 */
export const JSON_IMAGE_PATTERNS: RegExp[] = [
  /"(?:pictureUrl|baseUrl|url)"\s*:\s*"(https:\/\/[^"]+muscache\.com[^"]+)"/gi,
  /"(?:pictureUrl|baseUrl|url)"\s*:\s*"(https:\/\/[^"]+airbnbusercontent\.com[^"]+)"/gi,
];

/**
 * Patterns to exclude non-property images.
 */
export const EXCLUDE_IMAGE_PATTERNS: string[] = [
  "favicon",
  "logo",
  "icon",
  "brand",
  "sprite",
  "button",
  "avatar",
  "profile",
  "map",
  "marker",
  "host",
  "user",
];

/**
 * Canonicalizes a muscache URL by removing query params and cleaning escape sequences.
 * 
 * @param url - Raw image URL
 * @returns Canonicalized URL without query params
 */
export function canonicalizeImageUrl(url: string): string {
  let cleaned = url.replace(/\\u002F/g, "/").replace(/\\/g, "");
  // Remove trailing punctuation that might have been captured
  cleaned = cleaned.replace(/[,;:]+$/, "");
  // Remove query params like ?im_w=1200 to dedupe correctly
  return cleaned.split("?")[0];
}

/**
 * Checks if an image URL is a valid property photo.
 * Excludes logos, icons, host photos, and other non-property images.
 * 
 * @param url - Image URL to validate
 * @returns true if URL appears to be a property photo
 */
export function isValidPropertyImage(url: string): boolean {
  if (!url) return false;
  
  const lowercaseUrl = url.toLowerCase();
  
  // Must be from muscache or airbnbusercontent
  if (!lowercaseUrl.includes("muscache.com") && !lowercaseUrl.includes("airbnbusercontent.com")) {
    return false;
  }
  
  // Must include pictures path (for muscache)
  if (lowercaseUrl.includes("muscache.com") && !lowercaseUrl.includes("/im/pictures/")) {
    return false;
  }
  
  // Exclude non-property images
  if (EXCLUDE_IMAGE_PATTERNS.some((p) => lowercaseUrl.includes(p))) {
    return false;
  }
  
  return true;
}

/**
 * Extracts all valid property images from HTML content.
 * 
 * @param html - HTML content to search
 * @param maxImages - Maximum images to return (default: 5)
 * @returns Array of unique, validated image URLs with ?im_w=1200 suffix
 */
export function extractAirbnbImages(html: string, maxImages = 5): string[] {
  const allImageUrls: string[] = [];
  
  // Extract from HTML patterns
  for (const pattern of MUSCACHE_PATTERNS) {
    // Reset regex state for each use
    pattern.lastIndex = 0;
    const matches = html.match(pattern) || [];
    allImageUrls.push(...matches);
  }
  
  // Extract from embedded JSON data
  for (const pattern of JSON_IMAGE_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(html)) !== null) {
      if (match[1]) {
        allImageUrls.push(match[1].replace(/\\u002F/g, "/").replace(/\\/g, ""));
      }
    }
  }
  
  // Dedupe by canonical URL
  const uniqueBases = [...new Set(allImageUrls.map(canonicalizeImageUrl))];
  
  // Filter and format
  const validUrls = uniqueBases
    .filter(isValidPropertyImage)
    .map((base) => base.includes("?") ? base : `${base}?im_w=1200`)
    .slice(0, maxImages);
  
  return validUrls;
}

/**
 * Extracts the listing title from HTML content.
 * Handles various Airbnb title formats and cleans up suffixes.
 * 
 * @param html - HTML content
 * @param pageTitle - Page title from <title> tag (optional)
 * @returns Cleaned listing title or null
 */
export function extractListingTitle(html: string, pageTitle?: string): string | null {
  // Try page title first
  if (pageTitle && !pageTitle.toLowerCase().includes("confirm and pay")) {
    const cleaned = pageTitle
      .replace(" - Airbnb", "")
      .replace(" · Airbnb", "")
      .replace(/\s*-\s*(Houses|Apartments|Homes|Villas|Cabins|Cottages|Condos)?\s*(for Rent|to Rent|zur Miete|in)?\s*.*$/i, "")
      .trim();
    if (cleaned && cleaned.length > 5) {
      return cleaned;
    }
  }
  
  // Try extracting from meta tags
  const metaMatch = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/i);
  if (metaMatch) {
    const cleaned = metaMatch[1]
      .replace(" - Airbnb", "")
      .replace(" · Airbnb", "")
      .trim();
    if (cleaned && cleaned.length > 5) {
      return cleaned;
    }
  }
  
  // Try extracting from title tag
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  if (titleMatch && !titleMatch[1].toLowerCase().includes("confirm and pay")) {
    const cleaned = titleMatch[1]
      .replace(" - Airbnb", "")
      .replace(" · Airbnb", "")
      .trim();
    if (cleaned && cleaned.length > 5) {
      return cleaned;
    }
  }
  
  return null;
}
