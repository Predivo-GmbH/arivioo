/**
 * Shared Types - Single Source of Truth
 * 
 * @module _shared/types
 * @description Canonical TypeScript interfaces used across edge functions.
 * 
 * OWNERSHIP: This module owns all shared type definitions.
 * CONSUMERS: All edge functions
 */

export const MODULE_VERSION = "1.0.0";

/**
 * Provider identifiers for the Airbnb scraping fallback chain.
 */
export type AirbnbProvider = "firecrawl" | "zyte" | "browserless";

/**
 * Status codes for Airbnb baseline extraction.
 */
export type AirbnbBaselineStatus =
  | "total_price_including_taxes_and_fees"
  | "total_price_excluding_taxes_and_fees"
  | "subtotal_only"
  | "needs_user_confirmation"
  | "price_not_available_in_content"
  | "airbnb_blocked_or_captcha"
  | "provider_error"
  | "timeout";

/**
 * Result of scraping an Airbnb listing.
 */
export interface AirbnbScrapeResult {
  ok: boolean;
  markdown: string;
  html: string;
  roomsHtml?: string;
  roomsTitle?: string;
  screenshot: string | null;
  providerUsed: AirbnbProvider;
  botIndicators: string[];
  error: string | null;
  statusCode?: number;
  evidenceSnippet?: string;
  ocrReference?: OcrVisualReference | null;
}

/**
 * OCR Visual Reference - ground truth from what's visually displayed.
 */
export interface OcrVisualReference {
  bookingCardAmountRaw: string | null;
  bookingCardAmountValue: number | null;
  bookingCardNights: number | null;
  bookingCardSnippet: string | null;
  breakdownTotalAmountRaw: string | null;
  breakdownTotalAmountValue: number | null;
  breakdownTotalSnippet: string | null;
  breakdownTaxesAmountValue: number | null;
  breakdownOpened: boolean;
}

/**
 * Result of baseline price extraction.
 */
export interface AirbnbBaselineExtraction {
  status: AirbnbBaselineStatus;
  price: number | null;
  currency: string | null;
  includes_taxes_fees: boolean;
  evidence_snippet: string;
  debug: {
    provider: string;
    content_hash: string;
    candidates: PriceCandidate[];
  };
}

/**
 * A potential price found during extraction.
 */
export interface PriceCandidate {
  value: number;
  raw: string;
  type: CandidateType;
  context: string;
  confidence: number;
}

/**
 * Classification of a price candidate.
 */
export type CandidateType =
  | "total_final"
  | "subtotal_nights"
  | "taxes_only"
  | "nightly_rate"
  | "unknown";

/**
 * Result of OCR validation against a provider price.
 */
export interface OcrValidationResult {
  accepted: boolean;
  status: AirbnbBaselineStatus;
  validatedPrice: number | null;
  includesTaxesFees: boolean;
  evidenceSnippet: string;
  mismatchReason?: string;
  acceptedVia?: "booking_card_match" | "breakdown_match" | "exceeds_baseline";
}

/**
 * Search result from alternative platform.
 */
export interface AlternativeResult {
  platform_name: string;
  listing_url: string;
  listing_title: string | null;
  price: number | null;
  confidence_score: number | null;
  image_url: string | null;
  images: string[] | null;
  match_type: "visual" | "text";
  source_airbnb_image: string | null;
  savings_amount: number | null;
  savings_percentage: number | null;
}
