/**
 * Price Formatting Utilities
 * 
 * Consistent price formatting across the application.
 * Uses en-US locale by default to ensure proper formatting (e.g., $2,225 not $2.225).
 */

/**
 * Format a price with proper USD formatting
 * CRITICAL: Always use en-US locale to ensure correct formatting ($2,225 not $2.225)
 */
export function formatUSDPrice(price: number | null | undefined): string {
  if (price === null || price === undefined) {
    return '—';
  }
  
  // Always use en-US locale to ensure $2,225 format
  return price.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

/**
 * Format a price with currency symbol
 * CRITICAL: Always use en-US locale to ensure correct formatting
 */
export function formatPrice(
  price: number | null | undefined,
  currencySymbol: string = '$'
): string {
  if (price === null || price === undefined) {
    return '—';
  }
  
  return `${currencySymbol}${formatUSDPrice(price)}`;
}

/**
 * Format a price difference (positive = savings, negative = more expensive)
 */
export function formatPriceDifference(
  difference: number | null | undefined,
  currencySymbol: string = '$'
): string {
  if (difference === null || difference === undefined) {
    return '—';
  }
  
  const absValue = Math.abs(difference);
  const formatted = formatUSDPrice(absValue);
  
  if (difference > 0) {
    return `${currencySymbol}${formatted} savings`;
  } else if (difference < 0) {
    return `${currencySymbol}${formatted} more`;
  }
  return 'Same price';
}
