import { Link } from "react-router-dom";
import { AlertCircle, Calendar, Info, Check, ExternalLink, Search } from "lucide-react";
import { Button } from "@/components/ui/button";

type TerminalErrorType = "dates_unavailable" | "rate_limited" | "airbnb_total_not_visible";

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
    title: "Temporarily Unavailable",
    description: (
      <>
        We can't retrieve the price from Airbnb right now due to <span className="font-semibold text-foreground">temporary rate limiting</span>.
      </>
    ),
    tips: [
      "Wait a few minutes and try again",
      "Airbnb limits how often we can check prices",
      "This is temporary — pricing data will be available again soon",
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
  const showTechnicalDetails = type === "airbnb_total_not_visible";

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
