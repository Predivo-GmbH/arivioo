import { Link } from "react-router-dom";
import { AlertCircle, Calendar, Info, Check, ExternalLink, Search, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";

type TerminalErrorType = 
  | "dates_unavailable" 
  | "rate_limited" 
  | "airbnb_total_not_visible" 
  | "provider_timeout" 
  | "bot_detected" 
  | "expedia_access_blocked" 
  | "expedia_total_not_found" 
  | "property_id_not_found" 
  | "offers_page_not_loaded" 
  | "expedia_offers_page_not_reached" 
  | "expedia_total_not_found_on_offers_page"
  // Target card anchoring statuses (v6.3)
  | "expedia_target_offer_not_found"
  | "expedia_target_offer_mismatch"
  | "expedia_dates_unavailable_for_target"
  | "expedia_target_total_not_found";

interface TerminalErrorPanelProps {
  type: TerminalErrorType;
  airbnbUrl?: string | null;
  checkIn?: string | null;
  checkOut?: string | null;
  nights?: number;
  apiErrorCode?: string | null;
  apiError?: string | null;
}

const config: Record<TerminalErrorType, {
  icon: typeof Calendar | typeof AlertCircle;
  iconColor: string;
  bgColor: string;
  borderColor: string;
  title: string;
  description: React.ReactNode;
  tips: string[];
  primaryAction: { label: string; to: string };
}> = {
  dates_unavailable: {
    icon: Calendar,
    iconColor: "text-blue-500",
    bgColor: "bg-blue-500/10",
    borderColor: "border-blue-500/20",
    title: "Dates Not Available",
    description: (
      <>
        This property is <span className="font-semibold text-foreground">no longer available</span> for the dates you selected.
      </>
    ),
    tips: [
      "Change the check-in and check-out dates in your Airbnb URL",
      "Check the listing on Airbnb to see which dates are available",
      "Try a different property that has availability",
    ],
    primaryAction: { label: "Try Different Dates", to: "/dashboard" },
  },
  rate_limited: {
    icon: AlertCircle,
    iconColor: "text-orange-500",
    bgColor: "bg-orange-500/10",
    borderColor: "border-orange-500/20",
    title: "Rate Limit Reached",
    description: (
      <>
        The platform is <span className="font-semibold text-foreground">limiting automated requests</span>. We stopped the search to avoid further restrictions.
      </>
    ),
    tips: [
      "Wait 10-15 minutes before trying again",
      "This is a protective measure — the platform will allow requests again soon",
      "You can view the listing directly on Airbnb in the meantime",
    ],
    primaryAction: { label: "Try Again Later", to: "/dashboard" },
  },
  airbnb_total_not_visible: {
    icon: AlertCircle,
    iconColor: "text-amber-500",
    bgColor: "bg-amber-500/10",
    borderColor: "border-amber-500/20",
    title: "Price Can't Be Confirmed",
    description: (
      <>
        Airbnb currently shows only <span className="font-semibold text-foreground">partial pricing</span> for this stay (per-night rate), but not a complete total including all fees.
      </>
    ),
    tips: [
      "Open the listing on Airbnb where the full total may be visible",
      "Try different dates — pricing may vary by availability",
      "Check back later — Airbnb sometimes updates pricing display",
    ],
    primaryAction: { label: "Try Different Dates", to: "/dashboard" },
  },
  provider_timeout: {
    icon: Clock,
    iconColor: "text-purple-500",
    bgColor: "bg-purple-500/10",
    borderColor: "border-purple-500/20",
    title: "Price Retrieval Timed Out",
    description: (
      <>
        We couldn't retrieve the Airbnb pricing <span className="font-semibold text-foreground">in time</span>. The page took too long to load.
      </>
    ),
    tips: [
      "Try again in a moment — it may work on the next attempt",
      "Open the listing on Airbnb to verify the price directly",
      "If this persists, the listing may have complex pricing requirements",
    ],
    primaryAction: { label: "Try Again", to: "/dashboard" },
  },
  bot_detected: {
    icon: AlertCircle,
    iconColor: "text-red-500",
    bgColor: "bg-red-500/10",
    borderColor: "border-red-500/20",
    title: "Access Blocked",
    description: (
      <>
        The platform detected automated access and <span className="font-semibold text-foreground">blocked the request</span>. We stopped immediately to protect your search.
      </>
    ),
    tips: [
      "Wait 10-15 minutes before trying again",
      "Open the listing on Airbnb directly to see pricing",
      "This is a security measure — it will resolve automatically",
    ],
    primaryAction: { label: "Try Again Later", to: "/dashboard" },
  },
  expedia_access_blocked: {
    icon: AlertCircle,
    iconColor: "text-red-500",
    bgColor: "bg-red-500/10",
    borderColor: "border-red-500/20",
    title: "Expedia Access Blocked",
    description: (
      <>
        Expedia detected automated access and <span className="font-semibold text-foreground">blocked the request</span>. We cannot retrieve pricing for these dates right now.
      </>
    ),
    tips: [
      "Wait 10-15 minutes before trying again",
      "Open the listing directly on Expedia to see pricing",
      "This is a temporary security measure — it will resolve automatically",
    ],
    primaryAction: { label: "Try Again Later", to: "/dashboard" },
  },
  expedia_total_not_found: {
    icon: AlertCircle,
    iconColor: "text-amber-500",
    bgColor: "bg-amber-500/10",
    borderColor: "border-amber-500/20",
    title: "Expedia Price Not Found",
    description: (
      <>
        We found the property on Expedia but couldn't extract a <span className="font-semibold text-foreground">total price including taxes & fees</span>.
      </>
    ),
    tips: [
      "Open the listing directly on Expedia to see the full price",
      "The property may not display a complete total on the offers page",
      "Try a different property that shows clearer pricing",
    ],
    primaryAction: { label: "View on Expedia", to: "/dashboard" },
  },
  property_id_not_found: {
    icon: AlertCircle,
    iconColor: "text-amber-500",
    bgColor: "bg-amber-500/10",
    borderColor: "border-amber-500/20",
    title: "Property Not Identified",
    description: (
      <>
        We couldn't extract the <span className="font-semibold text-foreground">property ID</span> from the Expedia URL. This is needed to find pricing.
      </>
    ),
    tips: [
      "Ensure you're using a valid Expedia property page URL",
      "The URL should contain a property ID like 'h12345678'",
      "Try copying the URL directly from the Expedia website",
    ],
    primaryAction: { label: "Try Again", to: "/dashboard" },
  },
  offers_page_not_loaded: {
    icon: Clock,
    iconColor: "text-purple-500",
    bgColor: "bg-purple-500/10",
    borderColor: "border-purple-500/20",
    title: "Expedia Offers Page Failed",
    description: (
      <>
        We couldn't load the <span className="font-semibold text-foreground">Expedia offers page</span> with pricing for your dates.
      </>
    ),
    tips: [
      "Try again in a moment — it may work on the next attempt",
      "Open the listing on Expedia to verify pricing directly",
      "Check if the property is available for your selected dates",
    ],
    primaryAction: { label: "Try Again", to: "/dashboard" },
  },
  expedia_offers_page_not_reached: {
    icon: AlertCircle,
    iconColor: "text-amber-500",
    bgColor: "bg-amber-500/10",
    borderColor: "border-amber-500/20",
    title: "Expedia Offers Page Not Reached",
    description: (
      <>
        We couldn't navigate to the <span className="font-semibold text-foreground">Expedia offers page</span> with pricing. The URL gate check failed.
      </>
    ),
    tips: [
      "Try again in a moment — navigation may work on the next attempt",
      "Open the listing directly on Expedia to see pricing",
      "Ensure the property is still available on Expedia",
    ],
    primaryAction: { label: "Try Again", to: "/dashboard" },
  },
  expedia_total_not_found_on_offers_page: {
    icon: AlertCircle,
    iconColor: "text-amber-500",
    bgColor: "bg-amber-500/10",
    borderColor: "border-amber-500/20",
    title: "No Price on Offers Page",
    description: (
      <>
        We reached the Expedia offers page but couldn't find a <span className="font-semibold text-foreground">"total includes taxes" price</span>.
      </>
    ),
    tips: [
      "The property may not display a complete total on this page",
      "Open the listing directly on Expedia to see the full price",
      "Try a different property that shows clearer pricing",
    ],
    primaryAction: { label: "View on Expedia", to: "/dashboard" },
  },
  // Target card anchoring statuses (v6.3)
  expedia_target_offer_not_found: {
    icon: AlertCircle,
    iconColor: "text-amber-500",
    bgColor: "bg-amber-500/10",
    borderColor: "border-amber-500/20",
    title: "Property Not Found on Expedia",
    description: (
      <>
        We searched the Expedia offers page but couldn't locate the <span className="font-semibold text-foreground">target property card</span>.
      </>
    ),
    tips: [
      "The property may be listed under a different name on Expedia",
      "Open the listing directly on Expedia to verify availability",
      "Try a different property or check back later",
    ],
    primaryAction: { label: "View on Expedia", to: "/dashboard" },
  },
  expedia_target_offer_mismatch: {
    icon: AlertCircle,
    iconColor: "text-amber-500",
    bgColor: "bg-amber-500/10",
    borderColor: "border-amber-500/20",
    title: "Property Mismatch on Expedia",
    description: (
      <>
        We found a property on Expedia but the <span className="font-semibold text-foreground">title doesn't match</span> the expected listing.
      </>
    ),
    tips: [
      "The property may have been renamed or updated on Expedia",
      "Open the listing directly on Expedia to verify it's the same property",
      "Compare photos to confirm the match",
    ],
    primaryAction: { label: "View on Expedia", to: "/dashboard" },
  },
  expedia_dates_unavailable_for_target: {
    icon: Calendar,
    iconColor: "text-blue-500",
    bgColor: "bg-blue-500/10",
    borderColor: "border-blue-500/20",
    title: "Dates Not Available on Expedia",
    description: (
      <>
        This property is <span className="font-semibold text-foreground">not available</span> for your selected dates on Expedia.
      </>
    ),
    tips: [
      "The property may have different availability on Expedia",
      "Try different check-in and check-out dates",
      "Check the listing directly on Expedia for available dates",
    ],
    primaryAction: { label: "Try Different Dates", to: "/dashboard" },
  },
  expedia_target_total_not_found: {
    icon: AlertCircle,
    iconColor: "text-amber-500",
    bgColor: "bg-amber-500/10",
    borderColor: "border-amber-500/20",
    title: "No Price for This Property",
    description: (
      <>
        We found the property on Expedia but couldn't extract the <span className="font-semibold text-foreground">"total includes taxes & fees"</span> price.
      </>
    ),
    tips: [
      "The property card may not display a complete total",
      "Open the listing directly on Expedia to see the full price",
      "Pricing may require selecting specific options first",
    ],
    primaryAction: { label: "View on Expedia", to: "/dashboard" },
  },
};

const formatDate = (dateStr: string): string => {
  const date = new Date(dateStr);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};

export function TerminalErrorPanel({
  type,
  airbnbUrl,
  checkIn,
  checkOut,
  nights,
  apiErrorCode,
  apiError,
}: TerminalErrorPanelProps) {
  const { icon: Icon, iconColor, bgColor, borderColor, title, description, tips, primaryAction } = config[type];
  const hasValidDates = checkIn && checkOut && nights && nights > 0;
  // Show technical details for non-obvious error types
  const showTechnicalDetails = type === "airbnb_total_not_visible" || type === "provider_timeout" || type === "bot_detected";

  return (
    <div className="py-12 text-center">
      <div className={`w-20 h-20 mx-auto mb-6 rounded-full ${bgColor} flex items-center justify-center`}>
        <Icon className={`w-10 h-10 ${iconColor}`} />
      </div>
      <h3 className="text-2xl font-bold text-foreground mb-3">{title}</h3>
      <p className="text-muted-foreground mb-2 max-w-lg mx-auto text-base">{description}</p>
      {hasValidDates && (
        <p className="text-sm text-muted-foreground mb-6">
          {formatDate(checkIn)} – {formatDate(checkOut)} ({nights} {nights === 1 ? "night" : "nights"})
        </p>
      )}
      <div className={`${bgColor.replace("/10", "/5")} border ${borderColor} rounded-xl p-5 max-w-md mx-auto mb-6`}>
        <h4 className="font-semibold text-foreground mb-2 flex items-center justify-center gap-2">
          <Info className={`w-4 h-4 ${iconColor}`} />
          What you can do
        </h4>
        <ul className="text-sm text-muted-foreground text-left space-y-2">
          {tips.map((tip, i) => (
            <li key={i} className="flex items-start gap-2">
              <Check className={`w-4 h-4 ${iconColor} mt-0.5 flex-shrink-0`} />
              <span>{tip}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex items-center justify-center gap-3 flex-wrap">
        {airbnbUrl && (
          <Button variant="outline" asChild>
            <a href={airbnbUrl} target="_blank" rel="noopener noreferrer">
              View on Airbnb <ExternalLink className="w-4 h-4 ml-2" />
            </a>
          </Button>
        )}
        <Button asChild>
          <Link to={primaryAction.to}>
            <Search className="w-4 h-4 mr-2" />
            {primaryAction.label}
          </Link>
        </Button>
      </div>
      {showTechnicalDetails && (
        <details className="mt-6 text-left max-w-md mx-auto">
          <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
            Show technical details
          </summary>
          <div className="mt-2 p-3 bg-muted/50 rounded-lg text-xs text-muted-foreground font-mono">
            Error code: {apiErrorCode || "airbnb_total_not_visible"}
            {apiError && <div className="mt-1">Message: {apiError}</div>}
          </div>
        </details>
      )}
    </div>
  );
}
