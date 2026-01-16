/**
 * priceClassification.ts
 * 
 * Canonical Price Classification Module
 * 
 * AUTHORITATIVE RULE: Only TOTAL_STAY prices are valid for comparison.
 * All other price-like numbers are noise and must not be persisted.
 * 
 * Classification Types:
 * - TOTAL_STAY: Explicitly labeled as total for the entire stay (valid)
 * - PER_NIGHT: Per-night rate only (invalid for persistence)
 * - SUBTOTAL: Sum before taxes/fees (invalid for persistence)
 * - FEE: Individual fee amount (invalid for persistence)
 * - TAX: Individual tax amount (invalid for persistence)
 * - UNKNOWN: Cannot determine type (invalid for persistence)
 */

export type PriceClassification = 
  | 'TOTAL_STAY'
  | 'PER_NIGHT'
  | 'SUBTOTAL'
  | 'FEE'
  | 'TAX'
  | 'UNKNOWN';

export interface ClassifiedPrice {
  amount: number;
  currency: string;
  classification: PriceClassification;
  confidence: number; // 0-1 confidence in classification
  evidenceSnippet: string | null;
  classificationReason: string;
  // Metadata for debugging
  rawText: string | null;
  matchedPattern: string | null;
}

export interface ClassificationResult {
  isValid: boolean;
  classification: PriceClassification;
  price: ClassifiedPrice | null;
  rejectionReason: string | null;
  debugInfo: {
    candidatesFound: number;
    totalStayCandidates: number;
    rejectedCandidates: Array<{
      amount: number;
      classification: PriceClassification;
      reason: string;
    }>;
  };
}

// TOTAL_STAY indicators - price is ONLY valid if preceded/followed by these
const TOTAL_STAY_PATTERNS = [
  // Explicit "total" labels
  /(?:grand\s+)?total(?:\s+price)?(?:\s+for)?/i,
  /total\s+(?:for\s+)?(?:your\s+)?stay/i,
  /total\s+(?:incl\.?|including)\s+(?:all\s+)?(?:taxes|fees)/i,
  /trip\s+total/i,
  /stay\s+total/i,
  /final\s+(?:price|total|amount)/i,
  /amount\s+due/i,
  /you(?:'ll)?\s+pay/i,
  /pay\s+now/i,
  /booking\s+total/i,
  /reservation\s+total/i,
  /(?:total\s+)?price\s+for\s+\d+\s+nights?/i,
  /\$[\d,]+(?:\.\d{2})?\s+(?:for|\/)\s+\d+\s+nights?/i,
  /total\s+\(?\s*(?:USD|EUR|GBP|CAD|AUD)\s*\)?/i,
];

// PER_NIGHT indicators - these prices are INVALID
const PER_NIGHT_PATTERNS = [
  /per\s+night/i,
  /\/\s*night/i,
  /nightly\s+rate/i,
  /avg\.?\s+(?:per\s+)?night/i,
  /(?:from|starting\s+(?:at|from))\s+\$[\d,]+/i,
  /price\s+per\s+night/i,
  /rate\s+per\s+night/i,
  /\$[\d,]+(?:\.\d{2})?\s*\/\s*night/i,
];

// SUBTOTAL indicators - these prices are INVALID
const SUBTOTAL_PATTERNS = [
  /subtotal/i,
  /sub-total/i,
  /room\s+(?:rate|charges?)/i,
  /accommodation\s+(?:cost|charges?)/i,
  /base\s+(?:rate|price)/i,
  /before\s+(?:taxes|fees)/i,
  /excluding\s+(?:taxes|fees)/i,
  /excl\.?\s+(?:taxes|fees)/i,
  /\d+\s+nights?\s+x\s+\$[\d,]+/i,
];

// FEE indicators - these prices are INVALID
const FEE_PATTERNS = [
  /cleaning\s+fee/i,
  /service\s+fee/i,
  /booking\s+fee/i,
  /resort\s+fee/i,
  /facility\s+fee/i,
  /amenity\s+fee/i,
  /destination\s+fee/i,
  /processing\s+fee/i,
  /(?:additional|extra)\s+fees?/i,
];

// TAX indicators - these prices are INVALID
const TAX_PATTERNS = [
  /taxes?\s+(?:and\s+)?fees?/i,
  /occupancy\s+tax/i,
  /lodging\s+tax/i,
  /tourism\s+tax/i,
  /city\s+tax/i,
  /vat/i,
  /gst/i,
  /hst/i,
  /sales\s+tax/i,
];

/**
 * Classify a price amount based on surrounding context
 */
export function classifyPriceFromContext(
  amount: number,
  contextBefore: string,
  contextAfter: string,
  fullContext: string
): ClassifiedPrice {
  const context = `${contextBefore} ${contextAfter}`.toLowerCase();
  const rawText = fullContext.slice(0, 200);
  
  // Check for TOTAL_STAY first (highest priority)
  for (const pattern of TOTAL_STAY_PATTERNS) {
    if (pattern.test(context) || pattern.test(fullContext)) {
      return {
        amount,
        currency: 'USD', // Will be overridden by caller
        classification: 'TOTAL_STAY',
        confidence: 0.9,
        evidenceSnippet: fullContext.slice(0, 150),
        classificationReason: `Matched TOTAL_STAY pattern: ${pattern.source}`,
        rawText,
        matchedPattern: pattern.source,
      };
    }
  }
  
  // Check for PER_NIGHT (invalid)
  for (const pattern of PER_NIGHT_PATTERNS) {
    if (pattern.test(context) || pattern.test(fullContext)) {
      return {
        amount,
        currency: 'USD',
        classification: 'PER_NIGHT',
        confidence: 0.85,
        evidenceSnippet: fullContext.slice(0, 150),
        classificationReason: `Matched PER_NIGHT pattern: ${pattern.source}`,
        rawText,
        matchedPattern: pattern.source,
      };
    }
  }
  
  // Check for SUBTOTAL (invalid)
  for (const pattern of SUBTOTAL_PATTERNS) {
    if (pattern.test(context) || pattern.test(fullContext)) {
      return {
        amount,
        currency: 'USD',
        classification: 'SUBTOTAL',
        confidence: 0.8,
        evidenceSnippet: fullContext.slice(0, 150),
        classificationReason: `Matched SUBTOTAL pattern: ${pattern.source}`,
        rawText,
        matchedPattern: pattern.source,
      };
    }
  }
  
  // Check for FEE (invalid)
  for (const pattern of FEE_PATTERNS) {
    if (pattern.test(context) || pattern.test(fullContext)) {
      return {
        amount,
        currency: 'USD',
        classification: 'FEE',
        confidence: 0.85,
        evidenceSnippet: fullContext.slice(0, 150),
        classificationReason: `Matched FEE pattern: ${pattern.source}`,
        rawText,
        matchedPattern: pattern.source,
      };
    }
  }
  
  // Check for TAX (invalid)
  for (const pattern of TAX_PATTERNS) {
    if (pattern.test(context) || pattern.test(fullContext)) {
      return {
        amount,
        currency: 'USD',
        classification: 'TAX',
        confidence: 0.85,
        evidenceSnippet: fullContext.slice(0, 150),
        classificationReason: `Matched TAX pattern: ${pattern.source}`,
        rawText,
        matchedPattern: pattern.source,
      };
    }
  }
  
  // Cannot determine - treat as UNKNOWN (invalid)
  return {
    amount,
    currency: 'USD',
    classification: 'UNKNOWN',
    confidence: 0.3,
    evidenceSnippet: fullContext.slice(0, 150),
    classificationReason: 'No matching classification pattern found',
    rawText,
    matchedPattern: null,
  };
}

/**
 * Extract and classify all price candidates from content
 */
export function extractAndClassifyPrices(
  content: string,
  expectedNights: number
): ClassificationResult {
  const pricePattern = /(?:US?\$|USD\s*|EUR\s*|€|£|GBP\s*|CAD\s*|C\$|AUD\s*|A\$)\s*([\d,]+(?:\.\d{2})?)/gi;
  
  const candidates: ClassifiedPrice[] = [];
  const rejectedCandidates: Array<{ amount: number; classification: PriceClassification; reason: string }> = [];
  let match;
  
  while ((match = pricePattern.exec(content)) !== null) {
    const amount = parseFloat(match[1].replace(/,/g, ''));
    
    // Skip implausibly small amounts (likely fees or tax items)
    if (amount < 20) {
      rejectedCandidates.push({
        amount,
        classification: 'UNKNOWN',
        reason: 'Amount too small (<$20) - likely fee/tax component',
      });
      continue;
    }
    
    // Get context around the price
    const startIdx = Math.max(0, match.index - 100);
    const endIdx = Math.min(content.length, match.index + match[0].length + 100);
    const contextBefore = content.slice(startIdx, match.index);
    const contextAfter = content.slice(match.index + match[0].length, endIdx);
    const fullContext = content.slice(startIdx, endIdx);
    
    const classified = classifyPriceFromContext(amount, contextBefore, contextAfter, fullContext);
    
    // Detect currency from match
    const currencyMatch = match[0].match(/(?:US?\$|USD|EUR|€|£|GBP|CAD|C\$|AUD|A\$)/i);
    if (currencyMatch) {
      const currencyMap: Record<string, string> = {
        '$': 'USD', 'US$': 'USD', 'USD': 'USD',
        '€': 'EUR', 'EUR': 'EUR',
        '£': 'GBP', 'GBP': 'GBP',
        'CAD': 'CAD', 'C$': 'CAD',
        'AUD': 'AUD', 'A$': 'AUD',
      };
      classified.currency = currencyMap[currencyMatch[0].toUpperCase()] || 'USD';
    }
    
    candidates.push(classified);
  }
  
  // Also check for "for N nights" pattern specifically
  const forNightsPattern = new RegExp(
    `(?:US?\\$|USD\\s*)([\\d,]+(?:\\.\\d{2})?)\\s*(?:for|\\/)\\s*${expectedNights}\\s*nights?`,
    'gi'
  );
  
  let nightsMatch;
  while ((nightsMatch = forNightsPattern.exec(content)) !== null) {
    const amount = parseFloat(nightsMatch[1].replace(/,/g, ''));
    if (amount >= 20) {
      const startIdx = Math.max(0, nightsMatch.index - 50);
      const endIdx = Math.min(content.length, nightsMatch.index + nightsMatch[0].length + 50);
      const fullContext = content.slice(startIdx, endIdx);
      
      // This pattern is a strong TOTAL_STAY indicator
      candidates.push({
        amount,
        currency: 'USD',
        classification: 'TOTAL_STAY',
        confidence: 0.95, // High confidence for explicit "for N nights"
        evidenceSnippet: fullContext,
        classificationReason: `Matched explicit "for ${expectedNights} nights" pattern`,
        rawText: nightsMatch[0],
        matchedPattern: forNightsPattern.source,
      });
    }
  }
  
  // Filter to only TOTAL_STAY candidates
  const totalStayCandidates = candidates.filter(c => c.classification === 'TOTAL_STAY');
  
  // Track rejected non-TOTAL_STAY candidates
  candidates
    .filter(c => c.classification !== 'TOTAL_STAY')
    .forEach(c => {
      rejectedCandidates.push({
        amount: c.amount,
        classification: c.classification,
        reason: c.classificationReason,
      });
    });
  
  // If we have TOTAL_STAY candidates, return the lowest (best deal)
  if (totalStayCandidates.length > 0) {
    totalStayCandidates.sort((a, b) => a.amount - b.amount);
    const bestPrice = totalStayCandidates[0];
    
    return {
      isValid: true,
      classification: 'TOTAL_STAY',
      price: bestPrice,
      rejectionReason: null,
      debugInfo: {
        candidatesFound: candidates.length,
        totalStayCandidates: totalStayCandidates.length,
        rejectedCandidates,
      },
    };
  }
  
  // No TOTAL_STAY prices found
  return {
    isValid: false,
    classification: 'UNKNOWN',
    price: null,
    rejectionReason: candidates.length > 0
      ? `Found ${candidates.length} price candidates but none classified as TOTAL_STAY`
      : 'No price candidates found in content',
    debugInfo: {
      candidatesFound: candidates.length,
      totalStayCandidates: 0,
      rejectedCandidates,
    },
  };
}

/**
 * Validate that a price from AI extraction is actually a TOTAL_STAY
 * Returns the validated price only if it's a confirmed total
 */
export function validateExtractedPriceAsTotalStay(
  extractedPrice: number,
  priceType: string | null | undefined,
  includesTaxesFees: boolean | null | undefined,
  evidenceSnippets: string[] | null | undefined,
  fullContent: string
): ClassificationResult {
  // Check if extractor already classified as TOTAL_STAY
  const normalizedType = (priceType || '').toUpperCase();
  
  if (normalizedType === 'TOTAL_STAY' && includesTaxesFees === true) {
    // Verify the price exists in content (hallucination guard)
    const priceStr = extractedPrice.toLocaleString('en-US');
    const priceFormats = [
      `$${priceStr}`,
      `$${extractedPrice}`,
      `US$${priceStr}`,
      `US$ ${priceStr}`,
      priceStr,
      extractedPrice.toString(),
    ];
    
    const foundInContent = priceFormats.some(fmt => fullContent.includes(fmt));
    
    if (foundInContent) {
      return {
        isValid: true,
        classification: 'TOTAL_STAY',
        price: {
          amount: extractedPrice,
          currency: 'USD',
          classification: 'TOTAL_STAY',
          confidence: 0.9,
          evidenceSnippet: evidenceSnippets?.[0] || null,
          classificationReason: 'AI extractor classified as TOTAL_STAY with taxes/fees included',
          rawText: null,
          matchedPattern: null,
        },
        rejectionReason: null,
        debugInfo: {
          candidatesFound: 1,
          totalStayCandidates: 1,
          rejectedCandidates: [],
        },
      };
    }
    
    return {
      isValid: false,
      classification: 'UNKNOWN',
      price: null,
      rejectionReason: `Price $${extractedPrice} not found verbatim in content (hallucination guard)`,
      debugInfo: {
        candidatesFound: 1,
        totalStayCandidates: 0,
        rejectedCandidates: [{
          amount: extractedPrice,
          classification: 'UNKNOWN',
          reason: 'Price not found in content - possible hallucination',
        }],
      },
    };
  }
  
  // If extractor said NIGHTLY or didn't include taxes, reject
  if (normalizedType === 'NIGHTLY' || normalizedType === 'PER_NIGHT') {
    return {
      isValid: false,
      classification: 'PER_NIGHT',
      price: null,
      rejectionReason: `Price classified as ${normalizedType} - not a total stay price`,
      debugInfo: {
        candidatesFound: 1,
        totalStayCandidates: 0,
        rejectedCandidates: [{
          amount: extractedPrice,
          classification: 'PER_NIGHT',
          reason: 'AI extractor classified as per-night rate',
        }],
      },
    };
  }
  
  if (includesTaxesFees === false) {
    return {
      isValid: false,
      classification: 'SUBTOTAL',
      price: null,
      rejectionReason: 'Price excludes taxes/fees - not a final total',
      debugInfo: {
        candidatesFound: 1,
        totalStayCandidates: 0,
        rejectedCandidates: [{
          amount: extractedPrice,
          classification: 'SUBTOTAL',
          reason: 'Price does not include taxes/fees',
        }],
      },
    };
  }
  
  // Unknown type - try to classify from content
  const contentClassification = extractAndClassifyPrices(fullContent, 1);
  
  // Check if our extracted price matches any TOTAL_STAY candidate
  if (contentClassification.isValid && contentClassification.price) {
    const tolerance = 0.01; // Allow 1% tolerance for rounding
    const priceDiff = Math.abs(contentClassification.price.amount - extractedPrice) / extractedPrice;
    
    if (priceDiff < tolerance) {
      return contentClassification;
    }
  }
  
  return {
    isValid: false,
    classification: 'UNKNOWN',
    price: null,
    rejectionReason: `Cannot confirm $${extractedPrice} is a TOTAL_STAY price`,
    debugInfo: {
      candidatesFound: 1,
      totalStayCandidates: 0,
      rejectedCandidates: [{
        amount: extractedPrice,
        classification: 'UNKNOWN',
        reason: 'Could not verify as total stay price from content',
      }],
    },
  };
}

/**
 * Build extraction status based on classification result
 */
export function getExtractionStatusFromClassification(
  classificationResult: ClassificationResult,
  datesValidated: boolean
): string {
  if (classificationResult.isValid && classificationResult.classification === 'TOTAL_STAY') {
    return 'success_total_stay';
  }
  
  if (!datesValidated) {
    return 'dates_not_applied';
  }
  
  // Map rejection reasons to specific statuses
  const rejection = classificationResult.rejectionReason?.toLowerCase() || '';
  
  if (rejection.includes('per_night') || rejection.includes('nightly')) {
    return 'price_not_total_stay_nightly_only';
  }
  
  if (rejection.includes('subtotal') || rejection.includes('excludes tax')) {
    return 'price_not_total_stay_subtotal_only';
  }
  
  if (rejection.includes('hallucination')) {
    return 'price_not_found_hallucination_guard';
  }
  
  if (rejection.includes('no price') || rejection.includes('not found')) {
    return 'price_not_found_after_dates_applied';
  }
  
  return 'price_not_total_stay';
}
