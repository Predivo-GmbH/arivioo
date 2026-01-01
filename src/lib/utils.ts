import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Format a price with max 2 decimal places, removing trailing zeros
 * Examples:
 *   formatPrice(504.34000000000015) => "504.34"
 *   formatPrice(2020.3600000000006) => "2020.36"
 *   formatPrice(100) => "100"
 *   formatPrice(99.5) => "99.50"
 */
export function formatPrice(value: number | null | undefined): string {
  if (value === null || value === undefined || isNaN(value)) return "0";
  // Round to 2 decimal places to avoid floating point issues
  return value.toFixed(2).replace(/\.00$/, '');
}

/**
 * Format a price for display with currency symbol
 */
export function formatPriceWithCurrency(
  value: number | null | undefined, 
  currencySymbol: string = "$"
): string {
  return `${currencySymbol}${formatPrice(value)}`;
}
