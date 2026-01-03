import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

/**
 * Hotels.com Structural Verification Test
 * 
 * This function tests the structural verification contract using fixtures.
 * It simulates extraction results and verifies the structural proof is correctly emitted.
 * 
 * This is a DETERMINISTIC test - no network calls to Hotels.com.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Test fixture: Valid Hotels.com page content with breakdown
const FIXTURE_VALID_BREAKDOWN = `
# Property Name - Hotels.com

Check-in: Feb 15 | Check-out: Feb 18

## Price details

Room rate: $380.00
Taxes and fees: $65.50
Cleaning fee: $45.00

**The price is $490.50 total includes taxes and fees**

Reserve now
`;

// Test fixture: Page without breakdown
const FIXTURE_NO_BREAKDOWN = `
# Property Name - Hotels.com

$120 per night

Book now
`;

// Test fixture: Page with breakdown but dates don't match
const FIXTURE_DATES_MISMATCH = `
# Property Name - Hotels.com

Check-in: Mar 01 | Check-out: Mar 04

## Price details

Room rate: $420.00
Taxes and fees: $70.00

**Total: $490.00**

Reserve now
`;

interface StructuralProof {
  breakdown_found: boolean;
  total_label_found: boolean;
  rendered_dates_match: boolean;
  extracted_from_breakdown_total: boolean;
  proof_version: string;
  breakdown_selector_used?: string;
  total_value_raw?: string;
  date_value_raw?: string;
}

// Breakdown detection logic (same as production extractor)
function detectBreakdownStructure(markdown: string): {
  breakdown_found: boolean;
  total_label_found: boolean;
  breakdown_selector_used: string | null;
  total_value_raw: string | null;
  breakdown_price: number | null;
  has_fee_lines: boolean;
} {
  const result = {
    breakdown_found: false,
    total_label_found: false,
    breakdown_selector_used: null as string | null,
    total_value_raw: null as string | null,
    breakdown_price: null as number | null,
    has_fee_lines: false,
  };
  
  const lowerMarkdown = markdown.toLowerCase();
  
  const breakdownIndicators = [
    'price details',
    'price breakdown',
    'price summary',
    'your price summary',
    'payment summary',
    'room price',
    'taxes and fees',
    'taxes & fees',
    'service fee',
    'cleaning fee',
    'resort fee',
  ];
  
  for (const indicator of breakdownIndicators) {
    if (lowerMarkdown.includes(indicator)) {
      result.breakdown_found = true;
      result.breakdown_selector_used = indicator;
      break;
    }
  }
  
  const feePatterns = [
    /taxes\s*(?:and|&)?\s*fees/i,
    /service\s*fee/i,
    /cleaning\s*fee/i,
    /resort\s*fee/i,
    /occupancy\s*tax/i,
    /lodging\s*tax/i,
  ];
  result.has_fee_lines = feePatterns.some(p => p.test(markdown));
  
  if (!result.has_fee_lines) {
    result.breakdown_found = false;
  }
  
  const totalPatterns = [
    /the\s+price\s+is\s+\$?([\d,]+(?:\.\d{2})?)\s*total/i,
    /\$?([\d,]+(?:\.\d{2})?)\s*total\s*(?:includes?\s+)?(?:taxes\s+(?:and|&)\s+fees)?/i,
    /total[:\s]*\$?([\d,]+(?:\.\d{2})?)/i,
  ];
  
  for (const pattern of totalPatterns) {
    const match = markdown.match(pattern);
    if (match) {
      result.total_label_found = true;
      result.total_value_raw = match[0];
      const priceStr = match[1].replace(/,/g, '');
      result.breakdown_price = parseFloat(priceStr);
      break;
    }
  }
  
  return result;
}

// Date validation logic (same as production extractor)
function validateRenderedDates(
  markdown: string, 
  requestedCheckIn: string, 
  requestedCheckOut: string
): {
  rendered_dates_match: boolean;
  date_value_raw: string | null;
} {
  const result = {
    rendered_dates_match: false,
    date_value_raw: null as string | null,
  };
  
  const reqCheckIn = new Date(requestedCheckIn);
  const reqCheckOut = new Date(requestedCheckOut);
  
  if (isNaN(reqCheckIn.getTime()) || isNaN(reqCheckOut.getTime())) {
    return result;
  }
  
  // Pattern: "Feb 15" format
  const dateRangePattern = /([A-Z][a-z]{2}\s+\d{1,2})\s*[\|]\s*(?:Check-out:\s*)?([A-Z][a-z]{2}\s+\d{1,2})/i;
  const rangeMatch = markdown.match(dateRangePattern);
  
  if (rangeMatch) {
    result.date_value_raw = rangeMatch[0];
    
    const year = reqCheckIn.getFullYear();
    const checkInStr = rangeMatch[1] + ', ' + year;
    const checkOutStr = rangeMatch[2] + ', ' + year;
    
    const parsedCheckIn = new Date(checkInStr);
    const parsedCheckOut = new Date(checkOutStr);
    
    if (
      parsedCheckIn.getMonth() === reqCheckIn.getMonth() &&
      parsedCheckIn.getDate() === reqCheckIn.getDate() &&
      parsedCheckOut.getMonth() === reqCheckOut.getMonth() &&
      parsedCheckOut.getDate() === reqCheckOut.getDate()
    ) {
      result.rendered_dates_match = true;
    }
  }
  
  return result;
}

// Run test with fixture
function runTestWithFixture(
  fixtureContent: string,
  requestedCheckIn: string,
  requestedCheckOut: string
): {
  breakdown: ReturnType<typeof detectBreakdownStructure>;
  dates: ReturnType<typeof validateRenderedDates>;
  structuralProof: StructuralProof;
  wouldBeVerified: boolean;
} {
  const breakdown = detectBreakdownStructure(fixtureContent);
  const dates = validateRenderedDates(fixtureContent, requestedCheckIn, requestedCheckOut);
  
  const structuralProof: StructuralProof = {
    breakdown_found: breakdown.breakdown_found && breakdown.has_fee_lines,
    total_label_found: breakdown.total_label_found,
    rendered_dates_match: dates.rendered_dates_match,
    extracted_from_breakdown_total: breakdown.breakdown_found && breakdown.total_label_found,
    proof_version: '1.0',
    breakdown_selector_used: breakdown.breakdown_selector_used || undefined,
    total_value_raw: breakdown.total_value_raw || undefined,
    date_value_raw: dates.date_value_raw || undefined,
  };
  
  const wouldBeVerified = 
    structuralProof.breakdown_found &&
    structuralProof.total_label_found &&
    structuralProof.rendered_dates_match &&
    structuralProof.extracted_from_breakdown_total;
  
  return {
    breakdown,
    dates,
    structuralProof,
    wouldBeVerified,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { testCase = 'all' } = body;
    
    const results: Record<string, any> = {};
    
    // Test Case A: Valid breakdown with matching dates
    if (testCase === 'all' || testCase === 'valid') {
      results.caseA_valid_breakdown = runTestWithFixture(
        FIXTURE_VALID_BREAKDOWN,
        '2025-02-15',
        '2025-02-18'
      );
    }
    
    // Test Case B: No breakdown
    if (testCase === 'all' || testCase === 'no_breakdown') {
      results.caseB_no_breakdown = runTestWithFixture(
        FIXTURE_NO_BREAKDOWN,
        '2025-02-15',
        '2025-02-18'
      );
    }
    
    // Test Case C: Dates mismatch
    if (testCase === 'all' || testCase === 'dates_mismatch') {
      results.caseC_dates_mismatch = runTestWithFixture(
        FIXTURE_DATES_MISMATCH,
        '2025-02-15',
        '2025-02-18'
      );
    }
    
    // Summary
    const summary = {
      caseA_expected_verified: true,
      caseA_actual_verified: results.caseA_valid_breakdown?.wouldBeVerified ?? 'not_run',
      caseA_passed: results.caseA_valid_breakdown?.wouldBeVerified === true,
      
      caseB_expected_verified: false,
      caseB_actual_verified: results.caseB_no_breakdown?.wouldBeVerified ?? 'not_run',
      caseB_passed: results.caseB_no_breakdown?.wouldBeVerified === false,
      
      caseC_expected_verified: false,
      caseC_actual_verified: results.caseC_dates_mismatch?.wouldBeVerified ?? 'not_run',
      caseC_passed: results.caseC_dates_mismatch?.wouldBeVerified === false,
    };
    
    const allPassed = summary.caseA_passed && summary.caseB_passed && summary.caseC_passed;
    
    return new Response(
      JSON.stringify({
        success: allPassed,
        message: allPassed 
          ? 'All structural verification tests passed - contract is correct'
          : 'Some tests failed - check individual results',
        summary,
        results,
        proof_version: '1.0',
        test_type: 'deterministic_fixture',
      }, null, 2),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
    
  } catch (error) {
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
