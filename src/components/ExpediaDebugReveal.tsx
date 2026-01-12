/**
 * Expedia Debug Reveal Component
 * 
 * Shows debug information for Expedia results only.
 * Only visible in development/admin mode.
 */

import React, { useState } from 'react';
import type { CanonicalPrice, PriceType } from '@/lib/canonicalPrice';
import type { CategorizedResult } from '@/lib/resultCategorization';

interface ExpediaDebugRevealProps {
  platformName: string;
  canonicalPrice: CanonicalPrice | null;
  categorization: CategorizedResult | null;
  extractionMetadata?: Record<string, any> | null;
  airbnbTotal: number | null;
}

/**
 * Only show debug for Expedia in development or with URL flag
 */
function shouldShowDebug(): boolean {
  // Check for development mode or URL flag
  if (typeof window === 'undefined') return false;
  
  // Check URL for debug flag
  const url = new URL(window.location.href);
  if (url.searchParams.get('debug') === 'expedia') return true;
  
  // Check if development mode
  if (import.meta.env.DEV) return true;
  
  return false;
}

export function ExpediaDebugReveal({
  platformName,
  canonicalPrice,
  categorization,
  extractionMetadata,
  airbnbTotal,
}: ExpediaDebugRevealProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  
  // Only show for Expedia
  if (!platformName.toLowerCase().includes('expedia')) {
    return null;
  }
  
  // Only show in debug mode
  if (!shouldShowDebug()) {
    return null;
  }
  
  // Extract key debug fields
  const priceType = canonicalPrice?.price_type || 'unknown';
  const totalPrice = canonicalPrice?.total_price;
  const currency = canonicalPrice?.currency || 'USD';
  const confidence = canonicalPrice?.confidence || 'unknown';
  const isComparable = canonicalPrice?.is_comparable ?? false;
  const comparabilityFailures = canonicalPrice?.comparability_failures || [];
  
  // Structural proof
  const structuralProof = canonicalPrice?.structural_proof;
  const structuralVerified = 
    (structuralProof?.breakdown_found === true && structuralProof?.total_label_found === true) ||
    extractionMetadata?.verification === 'VERIFIED';
  
  // Semantic pass
  const semanticPass = extractionMetadata?.semantic === 'pass';
  
  // Has low confidence
  const hasLowConfidence = categorization?.has_low_confidence ?? false;
  
  // Comparison result
  const bucket = categorization?.bucket || 'unknown';
  const relativePosition = bucket === 'cheaper' ? 'Cheaper' : 
                          bucket === 'more_expensive' ? 'More Expensive' : 
                          bucket === 'not_comparable' ? 'Not Comparable' : bucket;
  
  return (
    <div className="mt-2">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="text-[10px] text-blue-500 hover:text-blue-700 underline"
      >
        {isExpanded ? '▼ Hide Debug' : '▶ Debug (Expedia)'}
      </button>
      
      {isExpanded && (
        <div className="mt-1 p-2 bg-slate-100 dark:bg-slate-800 rounded text-[10px] font-mono space-y-1">
          <div className="grid grid-cols-2 gap-x-2 gap-y-0.5">
            <span className="text-slate-500">price_type:</span>
            <span className={priceType === 'total_proven' ? 'text-green-600' : 'text-amber-600'}>
              {priceType}
            </span>
            
            <span className="text-slate-500">total_price:</span>
            <span className={totalPrice ? 'text-green-600' : 'text-red-600'}>
              {totalPrice !== null && totalPrice !== undefined 
                ? `${currency} ${totalPrice.toLocaleString('en-US')}`
                : 'null'}
            </span>
            
            <span className="text-slate-500">currency:</span>
            <span>{currency}</span>
            
            <span className="text-slate-500">structural_verified:</span>
            <span className={structuralVerified ? 'text-green-600' : 'text-amber-600'}>
              {structuralVerified ? '✓ VERIFIED' : '✗ not verified'}
            </span>
            
            <span className="text-slate-500">semantic_pass:</span>
            <span className={semanticPass ? 'text-green-600' : 'text-amber-600'}>
              {semanticPass ? '✓ pass' : '✗ fail/unknown'}
            </span>
            
            <span className="text-slate-500">confidence:</span>
            <span className={confidence === 'low' ? 'text-amber-600' : 'text-green-600'}>
              {confidence}
            </span>
            
            <span className="text-slate-500">has_low_confidence:</span>
            <span>{hasLowConfidence ? 'true' : 'false'}</span>
            
            <span className="text-slate-500">is_comparable:</span>
            <span className={isComparable ? 'text-green-600' : 'text-red-600'}>
              {isComparable ? '✓ yes' : '✗ no'}
            </span>
            
            <span className="text-slate-500">bucket:</span>
            <span className={
              bucket === 'cheaper' ? 'text-green-600' :
              bucket === 'more_expensive' ? 'text-amber-600' :
              'text-red-600'
            }>
              {bucket}
            </span>
            
            <span className="text-slate-500">relative_position:</span>
            <span>{relativePosition}</span>
            
            <span className="text-slate-500">airbnb_total:</span>
            <span>{airbnbTotal !== null ? `$${airbnbTotal.toLocaleString('en-US')}` : 'null'}</span>
          </div>
          
          {comparabilityFailures.length > 0 && (
            <div className="pt-1 border-t border-slate-300 dark:border-slate-600">
              <span className="text-slate-500">comparability_failures:</span>
              <span className="text-red-600 ml-1">[{comparabilityFailures.join(', ')}]</span>
            </div>
          )}
          
          {extractionMetadata && (
            <div className="pt-1 border-t border-slate-300 dark:border-slate-600">
              <span className="text-slate-500">raw metadata keys:</span>
              <span className="text-slate-600 ml-1 break-all">
                {Object.keys(extractionMetadata).slice(0, 8).join(', ')}
                {Object.keys(extractionMetadata).length > 8 ? '...' : ''}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
