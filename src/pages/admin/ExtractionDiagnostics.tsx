import { useState, useEffect } from 'react';
import {
  Search,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Clock,
  Shield,
  ShieldX,
  ShieldCheck,
  ExternalLink,
  ChevronRight,
  Eye,
  Ban,
  HelpCircle,
  Loader2,
  Calendar,
  Copy,
  Check,
  FileText,
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { supabase } from '@/integrations/supabase/client';
import { useAdminAuth } from '@/hooks/useAdminAuth';

interface ExtractionDiagnostic {
  platform_name: string;
  search_result_id: string;
  listing_url: string;
  scraped_price: number | null;
  match_confidence: number | null;
  match_type: string | null;
  coverage_tier: string;
  tier_reason: string | null;
  dedicated_extractor: string | null;
  extraction_attempted: boolean;
  extraction_id: string | null;
  extraction_path_used: string;
  provider_used: string;
  extraction_status: string;
  failure_reason: string | null;
  dates_applied: boolean | null;
  detected_checkin: string | null;
  detected_checkout: string | null;
  includes_taxes_fees: boolean | null;
  confidence_score: number | null;
  extracted_price: number | null;
  currency: string | null;
  price_status: string;
  verification_failures: string[];
  last_attempt_at: string | null;
  // Semantic verification (kept for debugging, not used for decisions)
  semantic_total_verified: boolean;
  price_type: string | null;
  evidence_snippets: string[] | null;
  // NEW: Structural verification (the REAL verification)
  structural_total_verified: boolean;
  structural_proof: {
    breakdown_found: boolean | null;
    total_label_found: boolean | null;
    rendered_dates_match: boolean | null;
    extracted_from_breakdown_total: boolean | null;
    // Expedia diagnostics
    current_url_at_extraction?: string | null;
    offers_page_reached?: boolean | null;
    constructed_offers_url?: string | null;
    property_id_used?: string | null;
    expedia_trace?: any | null;
  } | null;
}

interface SearchSummary {
  id: string;
  airbnb_url: string;
  airbnb_title: string | null;
  status: string;
  created_at: string;
  check_in_date: string | null;
  check_out_date: string | null;
  extraction_stats: {
    total: number;
    success: number;
    failed: number;
    pending: number;
  };
  has_activity_log?: boolean;
}

interface SystemicIssues {
  never_attempted: number;
  blocked: number;
  render_failed: number;
  timeout: number;
  verified: number;
  unverified: number;
  tier_a_failures: number;
  // Semantic verification (kept for debugging)
  semantic_total_failed: number;
  semantic_total_passed: number;
  // NEW: Structural verification (the REAL verification)
  structural_total_passed: number;
  structural_total_failed: number;
}

// Import from canonical taxonomy
import { classifyOutcome, getOutcomeAdminLabel, OUTCOME_DISPLAY, type OutcomeCategory } from '@/lib/extractionOutcomeTaxonomy';

// Status configuration using canonical taxonomy
const STATUS_CONFIG: Record<string, { icon: any; color: string; label: string }> = {
  success: { icon: CheckCircle2, color: 'text-green-500', label: 'Success' },
  // Access blocked statuses
  blocked: { icon: Ban, color: 'text-red-500', label: 'Blocked' },
  blocked_captcha_or_bot: { icon: Ban, color: 'text-red-500', label: 'Bot Blocked' },
  blocked_rate_limit: { icon: Ban, color: 'text-red-500', label: 'Rate Limited' },
  rate_limited: { icon: Ban, color: 'text-amber-500', label: 'Rate Limited' },
  rate_limited_abort: { icon: Ban, color: 'text-red-500', label: 'Rate Limited (Stopped)' },
  bot_blocked_abort: { icon: Ban, color: 'text-red-500', label: 'Bot Blocked (Stopped)' },
  // Service errors
  render_failed: { icon: XCircle, color: 'text-orange-500', label: 'Render Failed' },
  timeout: { icon: Clock, color: 'text-yellow-500', label: 'Timeout' },
  // Price not found
  price_not_found: { icon: HelpCircle, color: 'text-muted-foreground', label: 'Price Not Found' },
  price_not_found_after_dates_applied: { icon: HelpCircle, color: 'text-muted-foreground', label: 'Price Not Found' },
  // Pending/Not attempted
  pending: { icon: Loader2, color: 'text-blue-500', label: 'Pending' },
  not_attempted: { icon: XCircle, color: 'text-muted-foreground', label: 'Not Attempted' },
  internal_error: { icon: AlertTriangle, color: 'text-red-600', label: 'Internal Error' },
  // AVAILABILITY STATUSES (NOT errors - terminal valid states)
  dates_unavailable: { icon: Calendar, color: 'text-orange-500', label: 'Unavailable for Dates' },
  sold_out: { icon: Calendar, color: 'text-orange-500', label: 'Sold Out for Dates' },
  no_availability_for_dates: { icon: Calendar, color: 'text-orange-500', label: 'No Availability' },
  // Date application issues
  dates_not_applied: { icon: Calendar, color: 'text-yellow-500', label: 'Dates Not Applied' },
  date_application_failed: { icon: Calendar, color: 'text-yellow-500', label: 'Date Application Failed' },
  needs_user_confirmation: { icon: HelpCircle, color: 'text-amber-500', label: 'Needs Confirmation' },
  // Expedia-specific statuses (golden path)
  expedia_target_offer_not_found: { icon: HelpCircle, color: 'text-orange-500', label: 'Expedia: Offer Not Found' },
  expedia_target_offer_mismatch: { icon: AlertTriangle, color: 'text-orange-500', label: 'Expedia: Offer Mismatch' },
  expedia_dates_unavailable_for_target: { icon: Calendar, color: 'text-orange-500', label: 'Expedia: Unavailable for Dates' },
  expedia_target_total_not_found: { icon: HelpCircle, color: 'text-orange-500', label: 'Expedia: Total Not Found' },
  expedia_offers_page_not_reached: { icon: XCircle, color: 'text-orange-500', label: 'Expedia: Page Not Reached' },
  expedia_total_not_found: { icon: HelpCircle, color: 'text-orange-500', label: 'Expedia: Total Not Found' },
  expedia_total_not_found_on_offers_page: { icon: HelpCircle, color: 'text-orange-500', label: 'Expedia: Total Not Found' },
  expedia_access_blocked: { icon: Ban, color: 'text-red-500', label: 'Expedia: Blocked' },
  property_id_not_found: { icon: HelpCircle, color: 'text-orange-500', label: 'Property ID Not Found' },
  offers_page_not_loaded: { icon: XCircle, color: 'text-orange-500', label: 'Offers Page Failed' },
  // Other terminal statuses
  subtotal_rejected: { icon: AlertTriangle, color: 'text-yellow-500', label: 'Subtotal Rejected' },
  checkout_not_reached: { icon: XCircle, color: 'text-orange-500', label: 'Checkout Not Reached' },
  currency_conversion_failed: { icon: AlertTriangle, color: 'text-yellow-500', label: 'Currency Failed' },
  validation_error: { icon: AlertTriangle, color: 'text-red-500', label: 'Validation Error' },
  platform_unsupported: { icon: Ban, color: 'text-muted-foreground', label: 'Platform Unsupported' },
};

const PRICE_STATUS_CONFIG: Record<string, { icon: any; color: string; bgColor: string }> = {
  verified: { icon: ShieldCheck, color: 'text-green-600', bgColor: 'bg-green-500/10' },
  unverified: { icon: Shield, color: 'text-yellow-600', bgColor: 'bg-yellow-500/10' },
  unavailable: { icon: ShieldX, color: 'text-red-600', bgColor: 'bg-red-500/10' },
};

const VERIFICATION_FAILURE_LABELS: Record<string, string> = {
  extraction_not_successful: 'Extraction failed',
  dates_not_validated: 'Dates not validated',
  taxes_fees_not_included: 'Missing taxes/fees',
  low_confidence: 'Low confidence score',
  no_extraction_attempt: 'No extraction attempted',
  // STRUCTURAL verification failures (NEW - the real verification)
  no_structural_total_proof: 'No structural proof of booking total',
  no_breakdown_found: 'Breakdown not found on page',
  no_total_label_found: 'Total label not found in breakdown',
  rendered_dates_do_not_match: 'Rendered dates mismatch',
  price_not_from_breakdown_total: 'Price not from breakdown total',
  untrusted_extraction_path: 'Path ignores selected dates',
  // Semantic verification failures (legacy, for debugging)
  semantic_total_not_verified: 'Semantic total not proven',
  price_type_not_total: 'Price is nightly, not total',
  breakdown_missing_fees_aggregation: 'Breakdown incomplete',
  no_semantic_total_proof: 'No semantic total evidence',
};

function ExtractionStatusBadge({ status }: { status: string }) {
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.internal_error;
  const Icon = config.icon;
  return (
    <Badge variant="outline" className="gap-1">
      <Icon className={`h-3 w-3 ${config.color}`} />
      {config.label}
    </Badge>
  );
}

function PriceStatusBadge({ status }: { status: string }) {
  const config = PRICE_STATUS_CONFIG[status] || PRICE_STATUS_CONFIG.unavailable;
  const Icon = config.icon;
  return (
    <Badge variant="outline" className={`gap-1 ${config.bgColor} ${config.color}`}>
      <Icon className="h-3 w-3" />
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </Badge>
  );
}

function TierBadge({ tier }: { tier: string }) {
  const colors: Record<string, string> = {
    A: 'bg-green-100 text-green-700',
    B: 'bg-yellow-100 text-yellow-700',
    C: 'bg-red-100 text-red-700',
  };
  return (
    <Badge variant="outline" className={colors[tier] || 'bg-muted'}>
      Tier {tier}
    </Badge>
  );
}

function DiagnosticRow({ diagnostic }: { diagnostic: ExtractionDiagnostic }) {
  const [isOpen, setIsOpen] = useState(false);

  // Get structural proof details
  const structuralProof = diagnostic.structural_proof || {
    breakdown_found: null,
    total_label_found: null,
    rendered_dates_match: null,
    extracted_from_breakdown_total: null,
  };

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <TableRow className="cursor-pointer hover:bg-muted/50" onClick={() => setIsOpen(!isOpen)}>
        <TableCell>
          <div className="flex items-center gap-2">
            <ChevronRight className={`h-4 w-4 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
            <span className="font-medium">{diagnostic.platform_name}</span>
          </div>
        </TableCell>
        <TableCell>
          <TierBadge tier={diagnostic.coverage_tier} />
        </TableCell>
        <TableCell>
          <ExtractionStatusBadge status={diagnostic.extraction_status} />
        </TableCell>
        <TableCell>
          <PriceStatusBadge status={diagnostic.price_status} />
        </TableCell>
        <TableCell className="text-right font-mono">
          {diagnostic.extracted_price 
            ? `${diagnostic.currency || '$'}${diagnostic.extracted_price.toFixed(2)}`
            : diagnostic.scraped_price 
              ? <span className="text-muted-foreground">${diagnostic.scraped_price.toFixed(2)} (scraped)</span>
              : '—'}
        </TableCell>
        <TableCell>
          {diagnostic.dates_applied === true && <CheckCircle2 className="h-4 w-4 text-green-500" />}
          {diagnostic.dates_applied === false && <XCircle className="h-4 w-4 text-red-500" />}
          {diagnostic.dates_applied === null && <span className="text-muted-foreground">—</span>}
        </TableCell>
        <TableCell>
          {diagnostic.includes_taxes_fees === true && <CheckCircle2 className="h-4 w-4 text-green-500" />}
          {diagnostic.includes_taxes_fees === false && <XCircle className="h-4 w-4 text-red-500" />}
          {diagnostic.includes_taxes_fees === null && <span className="text-muted-foreground">—</span>}
        </TableCell>
        {/* NEW: Structural verification column (the REAL verification) */}
        <TableCell>
          {diagnostic.structural_total_verified ? (
            <ShieldCheck className="h-4 w-4 text-green-500" />
          ) : (
            <ShieldX className="h-4 w-4 text-red-500" />
          )}
        </TableCell>
        {/* Semantic column (kept for debugging, secondary importance) */}
        <TableCell>
          {diagnostic.semantic_total_verified ? (
            <CheckCircle2 className="h-4 w-4 text-green-400" />
          ) : (
            <XCircle className="h-4 w-4 text-muted-foreground" />
          )}
        </TableCell>
      </TableRow>
      <CollapsibleContent asChild>
        <TableRow className="bg-muted/30">
          <TableCell colSpan={9} className="p-4">
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              {/* Extraction Details */}
              <div className="space-y-2">
                <h4 className="font-medium text-sm">Extraction Details</h4>
                <div className="text-sm space-y-1">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Attempted:</span>
                    <span>{diagnostic.extraction_attempted ? 'Yes' : 'No'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Path:</span>
                    <span className="capitalize">{diagnostic.extraction_path_used}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Provider:</span>
                    <span className="capitalize">{diagnostic.provider_used}</span>
                  </div>
                  {diagnostic.dedicated_extractor && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Extractor:</span>
                      <span className="font-mono text-xs">{diagnostic.dedicated_extractor}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Date Validation */}
              <div className="space-y-2">
                <h4 className="font-medium text-sm">Date Validation</h4>
                <div className="text-sm space-y-1">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Dates Applied:</span>
                    <span>{diagnostic.dates_applied === null ? 'Unknown' : diagnostic.dates_applied ? 'Yes' : 'No'}</span>
                  </div>
                  {diagnostic.detected_checkin && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Check-in:</span>
                      <span>{diagnostic.detected_checkin}</span>
                    </div>
                  )}
                  {diagnostic.detected_checkout && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Check-out:</span>
                      <span>{diagnostic.detected_checkout}</span>
                    </div>
                  )}
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Confidence:</span>
                    <span>{diagnostic.confidence_score !== null ? `${(diagnostic.confidence_score * 100).toFixed(0)}%` : 'N/A'}</span>
                  </div>
                </div>
              </div>

              {/* STRUCTURAL Verification Status (NEW - Primary) */}
              <div className="space-y-2">
                <h4 className="font-medium text-sm flex items-center gap-2">
                  <Shield className="h-4 w-4" />
                  Structural Proof
                </h4>
                <div className="flex items-center gap-2 mb-2">
                  {diagnostic.structural_total_verified ? (
                    <Badge variant="outline" className="bg-green-100 text-green-700">
                      <ShieldCheck className="h-3 w-3 mr-1" />
                      VERIFIED
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="bg-red-100 text-red-700">
                      <ShieldX className="h-3 w-3 mr-1" />
                      NO PROOF
                    </Badge>
                  )}
                </div>
                {/* Structural proof details */}
                <div className="text-xs space-y-1 bg-muted/50 p-2 rounded">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">breakdown_found:</span>
                    {structuralProof.breakdown_found === true ? (
                      <CheckCircle2 className="h-3 w-3 text-green-500" />
                    ) : structuralProof.breakdown_found === false ? (
                      <XCircle className="h-3 w-3 text-red-500" />
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">total_label_found:</span>
                    {structuralProof.total_label_found === true ? (
                      <CheckCircle2 className="h-3 w-3 text-green-500" />
                    ) : structuralProof.total_label_found === false ? (
                      <XCircle className="h-3 w-3 text-red-500" />
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">rendered_dates_match:</span>
                    {structuralProof.rendered_dates_match === true ? (
                      <CheckCircle2 className="h-3 w-3 text-green-500" />
                    ) : structuralProof.rendered_dates_match === false ? (
                      <XCircle className="h-3 w-3 text-red-500" />
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">from_breakdown_total:</span>
                    {structuralProof.extracted_from_breakdown_total === true ? (
                      <CheckCircle2 className="h-3 w-3 text-green-500" />
                    ) : structuralProof.extracted_from_breakdown_total === false ? (
                      <XCircle className="h-3 w-3 text-red-500" />
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </div>

                  {/* Expedia hard-gate trace (if present) */}
                  {(structuralProof.current_url_at_extraction || structuralProof.constructed_offers_url || structuralProof.property_id_used || structuralProof.offers_page_reached !== undefined) && (
                    <div className="mt-2 pt-2 border-t border-border space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">offers_page_reached:</span>
                        <span className="font-mono">{structuralProof.offers_page_reached === null || structuralProof.offers_page_reached === undefined ? '—' : String(structuralProof.offers_page_reached)}</span>
                      </div>
                      {structuralProof.property_id_used && (
                        <div className="flex items-center justify-between">
                          <span className="text-muted-foreground">propertyId_used:</span>
                          <span className="font-mono truncate max-w-[220px]">{structuralProof.property_id_used}</span>
                        </div>
                      )}
                      {structuralProof.constructed_offers_url && (
                        <div className="space-y-1">
                          <div className="text-muted-foreground">constructed_offers_url:</div>
                          <div className="font-mono text-[10px] break-all">{structuralProof.constructed_offers_url}</div>
                        </div>
                      )}
                      {structuralProof.current_url_at_extraction && (
                        <div className="space-y-1">
                          <div className="text-muted-foreground">current_url_at_extraction:</div>
                          <div className="font-mono text-[10px] break-all">{structuralProof.current_url_at_extraction}</div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Verification Failures */}
              <div className="space-y-2">
                <h4 className="font-medium text-sm">Verification Failures</h4>
                {diagnostic.price_type && (
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Price Type:</span>
                    <span className="capitalize">{diagnostic.price_type}</span>
                  </div>
                )}
                {/* Semantic (legacy, for debugging) */}
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>Semantic:</span>
                  {diagnostic.semantic_total_verified ? (
                    <span className="text-green-600">pass</span>
                  ) : (
                    <span className="text-orange-500">fail</span>
                  )}
                </div>
                {diagnostic.verification_failures.length === 0 ? (
                  <div className="flex items-center gap-2 text-green-600 text-sm">
                    <ShieldCheck className="h-4 w-4" />
                    All checks passed
                  </div>
                ) : (
                  <div className="space-y-1">
                    {diagnostic.verification_failures.map((failure) => (
                      <div key={failure} className="flex items-center gap-2 text-sm text-red-600">
                        <XCircle className="h-3 w-3" />
                        {VERIFICATION_FAILURE_LABELS[failure] || failure}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Evidence Snippets (kept for debugging) */}
              {diagnostic.evidence_snippets && diagnostic.evidence_snippets.length > 0 && (
                <div className="md:col-span-2 lg:col-span-4 space-y-2">
                  <h4 className="font-medium text-sm text-muted-foreground">Evidence Snippets (debug only)</h4>
                  <div className="text-sm bg-muted p-2 rounded font-mono text-xs overflow-x-auto space-y-1">
                    {diagnostic.evidence_snippets.slice(0, 3).map((snippet, i) => (
                      <div key={i} className="text-muted-foreground truncate">
                        "{snippet}"
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Failure Reason (full width) */}
              {diagnostic.failure_reason && (
                <div className="md:col-span-2 lg:col-span-4 space-y-2">
                  <h4 className="font-medium text-sm">Failure Reason</h4>
                  <div className="text-sm text-muted-foreground bg-muted p-2 rounded font-mono text-xs overflow-x-auto">
                    {diagnostic.failure_reason}
                  </div>
                </div>
              )}

              {/* Links */}
              <div className="md:col-span-2 lg:col-span-4 flex gap-2">
                <Button variant="outline" size="sm" asChild>
                  <a href={diagnostic.listing_url} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="h-3 w-3 mr-1" />
                    View Listing
                  </a>
                </Button>
                {diagnostic.last_attempt_at && (
                  <span className="text-xs text-muted-foreground self-center">
                    Last attempt: {new Date(diagnostic.last_attempt_at).toLocaleString()}
                  </span>
                )}
              </div>
            </div>
          </TableCell>
        </TableRow>
      </CollapsibleContent>
    </Collapsible>
  );
}

function CopyButton({ text, className = '' }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  
  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  
  return (
    <Button variant="ghost" size="sm" className={className} onClick={handleCopy}>
      {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
    </Button>
  );
}

function TruncatedId({ id, className = '' }: { id: string; className?: string }) {
  const truncated = `${id.slice(0, 8)}...${id.slice(-4)}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={`font-mono text-xs ${className}`}>{truncated}</span>
      </TooltipTrigger>
      <TooltipContent>
        <span className="font-mono text-xs">{id}</span>
      </TooltipContent>
    </Tooltip>
  );
}

export default function ExtractionDiagnostics() {
  const { getToken } = useAdminAuth();
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searches, setSearches] = useState<SearchSummary[]>([]);
  const [selectedSearchId, setSelectedSearchId] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<ExtractionDiagnostic[]>([]);
  const [systemicIssues, setSystemicIssues] = useState<SystemicIssues | null>(null);
  const [searchFilter, setSearchFilter] = useState('');
  const [selectedSearch, setSelectedSearch] = useState<any>(null);

  const fetchSearches = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const token = getToken();
      if (!token) throw new Error('Not authenticated');

      const { data, error: invokeError } = await supabase.functions.invoke('admin-dashboard/extraction-diagnostics', {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });

      if (invokeError) throw invokeError;
      if (data?.error) throw new Error(data.error);

      setSearches(data.searches || []);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch searches');
    } finally {
      setIsLoading(false);
    }
  };

  const fetchDiagnostics = async (searchId: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const token = getToken();
      if (!token) throw new Error('Not authenticated');

      const { data, error: invokeError } = await supabase.functions.invoke(`admin-dashboard/extraction-diagnostics?searchId=${searchId}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });

      if (invokeError) throw invokeError;
      if (data?.error) throw new Error(data.error);

      setDiagnostics(data.diagnostics || []);
      setSystemicIssues(data.systemic_issues || null);
      setSelectedSearch(data.search);
      setSelectedSearchId(searchId);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch diagnostics');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchSearches();
  }, []);

  const filteredSearches = searches.filter(s => 
    s.airbnb_url?.toLowerCase().includes(searchFilter.toLowerCase()) ||
    s.airbnb_title?.toLowerCase().includes(searchFilter.toLowerCase()) ||
    s.id.includes(searchFilter)
  );

  if (selectedSearchId && diagnostics.length >= 0) {
    return (
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <Button variant="ghost" onClick={() => { setSelectedSearchId(null); setDiagnostics([]); }} className="mb-2">
              ← Back to Searches
            </Button>
            <h1 className="text-2xl font-bold">Extraction Diagnostics</h1>
            {selectedSearch && (
              <div className="mt-2 space-y-1">
                <p className="text-muted-foreground text-sm">
                  {selectedSearch.airbnb_title || selectedSearch.airbnb_url?.split('/rooms/')[1]?.split('?')[0] || 'Untitled'}
                  {selectedSearch.check_in_date && selectedSearch.check_out_date && (
                    <span className="ml-2">
                      ({selectedSearch.check_in_date} → {selectedSearch.check_out_date})
                    </span>
                  )}
                </p>
                <div className="flex items-center gap-2 bg-muted/50 px-3 py-1.5 rounded-md w-fit">
                  <span className="text-xs text-muted-foreground">Search ID:</span>
                  <span className="font-mono text-xs">{selectedSearchId}</span>
                  <CopyButton text={selectedSearchId || ''} />
                  <Button variant="ghost" size="sm" asChild className="h-6 px-2">
                    <a href={`/search/${selectedSearchId}`} target="_blank" rel="noopener noreferrer">
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </Button>
                </div>
              </div>
            )}
          </div>
          <Button onClick={() => fetchDiagnostics(selectedSearchId)} variant="outline" disabled={isLoading}>
            <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>

        {/* Systemic Issues Summary */}
        {systemicIssues && (
          <div className="grid gap-4 md:grid-cols-4 lg:grid-cols-7">
            <Card className={systemicIssues.verified > 0 ? 'border-green-200' : ''}>
              <CardHeader className="pb-2">
                <CardDescription>Verified</CardDescription>
                <CardTitle className="text-2xl text-green-600">{systemicIssues.verified}</CardTitle>
              </CardHeader>
            </Card>
            <Card className={systemicIssues.unverified > 0 ? 'border-yellow-200' : ''}>
              <CardHeader className="pb-2">
                <CardDescription>Unverified</CardDescription>
                <CardTitle className="text-2xl text-yellow-600">{systemicIssues.unverified}</CardTitle>
              </CardHeader>
            </Card>
            <Card className={systemicIssues.never_attempted > 0 ? 'border-muted' : ''}>
              <CardHeader className="pb-2">
                <CardDescription>Not Attempted</CardDescription>
                <CardTitle className="text-2xl text-muted-foreground">{systemicIssues.never_attempted}</CardTitle>
              </CardHeader>
            </Card>
            <Card className={systemicIssues.blocked > 0 ? 'border-red-200' : ''}>
              <CardHeader className="pb-2">
                <CardDescription>Blocked</CardDescription>
                <CardTitle className="text-2xl text-red-600">{systemicIssues.blocked}</CardTitle>
              </CardHeader>
            </Card>
            <Card className={systemicIssues.render_failed > 0 ? 'border-orange-200' : ''}>
              <CardHeader className="pb-2">
                <CardDescription>Render Failed</CardDescription>
                <CardTitle className="text-2xl text-orange-600">{systemicIssues.render_failed}</CardTitle>
              </CardHeader>
            </Card>
            <Card className={systemicIssues.timeout > 0 ? 'border-yellow-200' : ''}>
              <CardHeader className="pb-2">
                <CardDescription>Timeout</CardDescription>
                <CardTitle className="text-2xl text-yellow-600">{systemicIssues.timeout}</CardTitle>
              </CardHeader>
            </Card>
            <Card className={systemicIssues.tier_a_failures > 0 ? 'border-red-300 bg-red-50' : ''}>
              <CardHeader className="pb-2">
                <CardDescription>Tier A Failures</CardDescription>
                <CardTitle className={`text-2xl ${systemicIssues.tier_a_failures > 0 ? 'text-red-700' : ''}`}>
                  {systemicIssues.tier_a_failures}
                </CardTitle>
              </CardHeader>
            </Card>
            {/* STRUCTURAL Verification Stats (NEW - Primary) */}
            <Card className={(systemicIssues.structural_total_failed ?? 0) > 0 ? 'border-red-300 bg-red-50' : 'border-green-300 bg-green-50'}>
              <CardHeader className="pb-2">
                <CardDescription className="font-medium">Structural Proof</CardDescription>
                <CardTitle className="text-lg">
                  <span className="text-green-600">{systemicIssues.structural_total_passed ?? 0}</span>
                  <span className="text-muted-foreground mx-1">/</span>
                  <span className="text-red-600">{systemicIssues.structural_total_failed ?? 0}</span>
                </CardTitle>
              </CardHeader>
            </Card>
            {/* Semantic Verification Stats (Legacy, for debugging) */}
            <Card className="border-muted">
              <CardHeader className="pb-2">
                <CardDescription className="text-muted-foreground text-xs">Semantic (debug)</CardDescription>
                <CardTitle className="text-sm text-muted-foreground">
                  <span>{systemicIssues.semantic_total_passed ?? 0}</span>
                  <span className="mx-1">/</span>
                  <span>{systemicIssues.semantic_total_failed ?? 0}</span>
                </CardTitle>
              </CardHeader>
            </Card>
          </div>
        )}

        {/* Activity Log from frontend SSE events */}
        {selectedSearch?.activity_log && Array.isArray(selectedSearch.activity_log) && selectedSearch.activity_log.length > 0 && (
          <Collapsible>
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-base">Activity Log</CardTitle>
                    <CardDescription>
                      {selectedSearch.activity_log.length} events captured during search
                    </CardDescription>
                  </div>
                  <CollapsibleTrigger asChild>
                    <Button variant="ghost" size="sm">
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </CollapsibleTrigger>
                </div>
              </CardHeader>
              <CollapsibleContent>
                <CardContent className="pt-0">
                  <div className="max-h-64 overflow-y-auto space-y-1 font-mono text-xs">
                    {selectedSearch.activity_log.map((item: { ts: number; message: string; detail?: string }, idx: number) => (
                      <div key={idx} className="flex gap-2 py-1 border-b border-border/50 last:border-0">
                        <span className="text-muted-foreground w-5 text-right flex-shrink-0">{idx + 1}.</span>
                        <div className="flex-1">
                          <span className="text-foreground">{item.message}</span>
                          {item.detail && (
                            <span className="text-muted-foreground ml-2">— {item.detail}</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </CollapsibleContent>
            </Card>
          </Collapsible>
        )}

        {error && (
          <Card className="border-destructive">
            <CardContent className="pt-6">
              <p className="text-destructive">{error}</p>
            </CardContent>
          </Card>
        )}

        {/* Diagnostics Table */}
        <Card>
          <CardHeader>
            <CardTitle>Platform Extraction Details</CardTitle>
            <CardDescription>
              Click a row to expand diagnostic details
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="h-40 flex items-center justify-center">
                <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : diagnostics.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                No platforms found for this search
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Platform</TableHead>
                    <TableHead>Tier</TableHead>
                    <TableHead>Extraction Status</TableHead>
                    <TableHead>Price Status</TableHead>
                    <TableHead className="text-right">Price</TableHead>
                    <TableHead>Dates</TableHead>
                    <TableHead>Taxes</TableHead>
                    <TableHead>Structural</TableHead>
                    <TableHead>Semantic</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {diagnostics.map((d) => (
                    <DiagnosticRow key={d.search_result_id} diagnostic={d} />
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  // Search Selection View
  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Extraction Diagnostics</h1>
          <p className="text-muted-foreground">
            Select a search to view per-platform extraction diagnostics
          </p>
        </div>
        <Button onClick={fetchSearches} variant="outline" disabled={isLoading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      <div className="flex items-center gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Filter by URL, title, or search ID..."
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      {error && (
        <Card className="border-destructive">
          <CardContent className="pt-6">
            <p className="text-destructive">{error}</p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Recent Searches</CardTitle>
          <CardDescription>
            {filteredSearches.length} searches shown
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="h-40 flex items-center justify-center">
              <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-40">Search ID</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>Dates</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-center">Extractions</TableHead>
                  <TableHead className="text-center">Success</TableHead>
                  <TableHead className="text-center">Failed</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="w-24">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredSearches.map((search) => (
                  <TableRow key={search.id} className="cursor-pointer hover:bg-muted/50" onClick={() => fetchDiagnostics(search.id)}>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <TruncatedId id={search.id} />
                        <CopyButton text={search.id} />
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="max-w-xs truncate">
                        <span className="font-medium">
                          {search.airbnb_title || search.airbnb_url?.split('/rooms/')[1]?.split('?')[0] || 'Untitled'}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {search.check_in_date && search.check_out_date ? (
                        <span>{search.check_in_date} → {search.check_out_date}</span>
                      ) : '—'}
                    </TableCell>
                    <TableCell>
                      <Badge variant={search.status === 'completed' ? 'default' : 'secondary'}>
                        {search.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-center">{search.extraction_stats.total}</TableCell>
                    <TableCell className="text-center text-green-600">{search.extraction_stats.success}</TableCell>
                    <TableCell className="text-center text-red-600">{search.extraction_stats.failed}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {new Date(search.created_at).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Button variant="ghost" size="sm" asChild onClick={(e) => e.stopPropagation()}>
                          <a href={`/search/${search.id}`} target="_blank" rel="noopener noreferrer" title="View results page">
                            <ExternalLink className="h-4 w-4" />
                          </a>
                        </Button>
                        <Button variant="ghost" size="sm" title="View diagnostics">
                          <Eye className="h-4 w-4" />
                        </Button>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="sm"
                              className={search.has_activity_log ? "text-blue-500 hover:text-blue-600" : "text-muted-foreground/50"}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (search.has_activity_log) {
                                  fetchDiagnostics(search.id);
                                }
                              }}
                              title={search.has_activity_log ? "View Activity Log" : "No Activity Log"}
                              disabled={!search.has_activity_log}
                            >
                              <FileText className="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            <span>{search.has_activity_log ? "Activity Log Available" : "No Activity Log"}</span>
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
