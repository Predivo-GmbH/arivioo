import React, { useState, useEffect, useRef } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { ImageCarousel } from "@/components/ImageCarousel";
import { ImageComparison } from "@/components/ImageComparison";
import { PhotoComparisonButton } from "@/components/PhotoComparisonButton";
import { 
  ArrowLeft, 
  ExternalLink, 
  Search, 
  Sparkles, 
  AlertCircle,
  TrendingDown,
  ImageIcon,
  Calendar,
  Info,
  Shield,
  Lock,
  Camera,
  Globe,
  DollarSign,
  Check,
  ArrowLeftRight
} from "lucide-react";
import type { User } from "@supabase/supabase-js";
import type { Json } from "@/integrations/supabase/types";

interface SearchResult {
  id: string;
  platform_name: string;
  listing_url: string;
  listing_title: string | null;
  price: number | null;
  original_price: number | null;
  savings_amount: number | null;
  savings_percentage: number | null;
  confidence_score: number | null;
  image_url: string | null;
  images: Json;
  match_type?: string;
}

interface SearchData {
  id: string;
  airbnb_url: string;
  airbnb_title: string | null;
  airbnb_price: number | null;
  airbnb_image_url: string | null;
  airbnb_images: Json;
  status: string;
  created_at: string;
  check_in_date?: string | null;
  check_out_date?: string | null;
  nights_count?: number | null;
}

// Step-based loading messages that progress linearly
const loadingSteps = [
  {
    id: "extracting",
    icon: Camera,
    title: "Extracting Property Photos",
    description: "Downloading clean property images from the Airbnb listing...",
    statuses: ["searching", "pending", "extracting_photos"]
  },
  {
    id: "searching",
    icon: Globe,
    title: "Searching Across Platforms",
    description: "Running reverse image search on Booking.com, Vrbo, Agoda, and 10+ other sites...",
    statuses: ["searching_platforms"]
  },
  {
    id: "comparing",
    icon: DollarSign,
    title: "Comparing Prices",
    description: "Analyzing prices and calculating potential savings for your dates...",
    statuses: ["comparing_prices"]
  }
];

// Helper to convert Json to string array
const toStringArray = (json: Json | null | undefined): string[] => {
  if (!json) return [];
  if (Array.isArray(json)) {
    return json.filter((item): item is string => typeof item === 'string');
  }
  return [];
};

// Extract dates from Airbnb URL if present
const extractDatesFromUrl = (url: string): { checkIn: string | null; checkOut: string | null } => {
  try {
    const urlObj = new URL(url);
    const checkIn = urlObj.searchParams.get('check_in');
    const checkOut = urlObj.searchParams.get('check_out');
    return { checkIn, checkOut };
  } catch {
    return { checkIn: null, checkOut: null };
  }
};

// Format date for display
const formatDate = (dateStr: string): string => {
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

// Calculate nights between dates
const calculateNights = (checkIn: string, checkOut: string): number => {
  const start = new Date(checkIn);
  const end = new Date(checkOut);
  const diffTime = Math.abs(end.getTime() - start.getTime());
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
};

// Get current step index based on status
const getCurrentStepIndex = (status: string): number => {
  for (let i = loadingSteps.length - 1; i >= 0; i--) {
    if (loadingSteps[i].statuses.includes(status)) {
      return i;
    }
  }
  return 0;
};

// Logo component for consistency
function AriviooLogo() {
  return (
    <div className="flex items-center gap-2.5">
      <div className="w-8 h-8 bg-gradient-primary rounded-xl flex items-center justify-center shadow-soft">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="text-white">
          <path d="M12 2L4 7V17L12 22L20 17V7L12 2Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M12 22V12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M12 12L4 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M12 12L20 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </div>
      <span className="font-bold text-xl text-foreground tracking-tight">Arivioo</span>
    </div>
  );
}

export default function SearchResults() {
  const { searchId } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  
  const [user, setUser] = useState<User | null>(null);
  const [search, setSearch] = useState<SearchData | null>(null);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentStep, setCurrentStep] = useState(0);
  const [expandedComparison, setExpandedComparison] = useState<string | null>(null);
  const searchTriggeredRef = useRef(false);

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      setUser(session?.user ?? null);
      if (!session?.user) navigate("/auth");
    });

    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      if (!session?.user) navigate("/auth");
    });

    return () => subscription.unsubscribe();
  }, [navigate]);

  // Fetch search data and trigger search
  useEffect(() => {
    if (!searchId || !user) return;
    if (searchTriggeredRef.current) return;

    const fetchAndSearch = async () => {
      searchTriggeredRef.current = true;
      
      // Fetch search record
      const { data: searchData, error: searchError } = await supabase
        .from("searches")
        .select("*")
        .eq("id", searchId)
        .single();

      if (searchError || !searchData) {
        toast({ title: "Error", description: "Search not found", variant: "destructive" });
        navigate("/dashboard");
        return;
      }

      setSearch(searchData as SearchData);
      setCurrentStep(getCurrentStepIndex(searchData.status));

      // If search is already completed, fetch results
      if (searchData.status === "completed") {
        const { data: resultsData } = await supabase
          .from("search_results")
          .select("*")
          .eq("search_id", searchId)
          .order("savings_percentage", { ascending: false, nullsFirst: false });

        setResults((resultsData || []) as SearchResult[]);
        setLoading(false);
        return;
      }

      // If status is 'searching' or 'pending', trigger the search
      if (searchData.status === "searching" || searchData.status === "pending") {
        try {
          const { data: { session } } = await supabase.auth.getSession();
          
          // Poll for status updates during search
          const pollInterval = setInterval(async () => {
            const { data: updatedSearch } = await supabase
              .from("searches")
              .select("status")
              .eq("id", searchId)
              .single();
            
            if (updatedSearch) {
              const newStep = getCurrentStepIndex(updatedSearch.status);
              setCurrentStep(prev => Math.max(prev, newStep));
            }
          }, 2000);
          
          const response = await fetch(
            `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/search-alternatives`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${session?.access_token || import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
              },
              body: JSON.stringify({ searchId }),
            }
          );

          clearInterval(pollInterval);
          
          const data = await response.json();

          if (!response.ok) {
            throw new Error(data.error || "Search failed");
          }

          // Ensure we're at the final step before showing results
          setCurrentStep(loadingSteps.length - 1);
          
          // Small delay to show final step
          await new Promise(r => setTimeout(r, 1000));

          // Refresh search and results
          const { data: updatedSearch } = await supabase
            .from("searches")
            .select("*")
            .eq("id", searchId)
            .single();

          const { data: resultsData } = await supabase
            .from("search_results")
            .select("*")
            .eq("search_id", searchId)
            .order("savings_percentage", { ascending: false, nullsFirst: false });

          setSearch(updatedSearch as SearchData);
          setResults((resultsData || []) as SearchResult[]);
        } catch (error: any) {
          console.error("Search error:", error);
          toast({ 
            title: "Search Error", 
            description: error.message || "Failed to search for alternatives", 
            variant: "destructive" 
          });
        }
        
        setLoading(false);
      }
    };

    fetchAndSearch();
  }, [searchId, user, navigate, toast]);

  if (!user) return null;

  const bestResult = results.length > 0 && results[0].savings_percentage && results[0].savings_percentage > 0 ? results[0] : null;
  const bestSavings = bestResult?.savings_percentage || 0;
  const bestSavingsAmount = bestResult?.savings_amount || 0;

  // Get images arrays
  const airbnbImages = toStringArray(search?.airbnb_images);

  // Use dates from database first (these are the actual comparison dates used)
  const dbCheckIn = search?.check_in_date;
  const dbCheckOut = search?.check_out_date;
  const dbNights = search?.nights_count;
  
  const urlDates = search?.airbnb_url ? extractDatesFromUrl(search.airbnb_url) : { checkIn: null, checkOut: null };
  const checkIn = dbCheckIn || urlDates.checkIn;
  const checkOut = dbCheckOut || urlDates.checkOut;
  const hasValidDates = checkIn && checkOut;
  const nights = dbNights || (hasValidDates ? calculateNights(checkIn!, checkOut!) : null);

  // Calculate totals
  const airbnbTotal = search?.airbnb_price && nights ? search.airbnb_price * nights : null;
  const estimatedServiceFee = airbnbTotal ? Math.round(airbnbTotal * 0.14) : null;
  const airbnbGrandTotal = airbnbTotal && estimatedServiceFee ? airbnbTotal + estimatedServiceFee : null;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="container px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link to="/dashboard" className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors">
              <ArrowLeft className="w-4 h-4" />
              <span className="hidden sm:inline">Back to Dashboard</span>
            </Link>
          </div>
          <Link to="/">
            <AriviooLogo />
          </Link>
        </div>
      </header>

      <main className="container px-4 py-8 md:py-12">
        {loading ? (
          <div className="max-w-xl mx-auto py-12">
            {/* Step Progress Indicator */}
            <div className="mb-12">
              {loadingSteps.map((step, index) => {
                const StepIcon = step.icon;
                const isActive = index === currentStep;
                const isCompleted = index < currentStep;
                
                return (
                  <div key={step.id} className="relative">
                    {index < loadingSteps.length - 1 && (
                      <div 
                        className={`absolute left-6 top-14 w-0.5 h-12 transition-colors duration-500 ${
                          isCompleted ? 'bg-primary' : 'bg-muted'
                        }`}
                      />
                    )}
                    
                    <div className={`flex items-start gap-4 p-4 rounded-xl transition-all duration-500 ${
                      isActive ? 'bg-primary/5 border border-primary/20' : ''
                    }`}>
                      <div className={`w-12 h-12 rounded-full flex items-center justify-center flex-shrink-0 transition-all duration-500 ${
                        isCompleted 
                          ? 'bg-primary text-primary-foreground' 
                          : isActive 
                          ? 'bg-primary/10 text-primary border-2 border-primary' 
                          : 'bg-muted text-muted-foreground'
                      }`}>
                        {isCompleted ? (
                          <Check className="w-5 h-5" />
                        ) : isActive ? (
                          <div className="relative">
                            <StepIcon className="w-5 h-5" />
                            <div className="absolute inset-0 animate-ping">
                              <StepIcon className="w-5 h-5 opacity-50" />
                            </div>
                          </div>
                        ) : (
                          <StepIcon className="w-5 h-5" />
                        )}
                      </div>
                      
                      <div className="flex-1 pt-1">
                        <h3 className={`font-semibold mb-1 transition-colors ${
                          isActive ? 'text-foreground' : isCompleted ? 'text-foreground' : 'text-muted-foreground'
                        }`}>
                          {step.title}
                          {isCompleted && <span className="text-primary ml-2 text-sm">✓</span>}
                        </h3>
                        <p className={`text-sm transition-colors ${
                          isActive ? 'text-muted-foreground' : 'text-muted-foreground/60'
                        }`}>
                          {step.description}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="text-center">
              <p className="text-sm text-muted-foreground">
                This usually takes 30-60 seconds as we search across multiple platforms...
              </p>
            </div>
          </div>
        ) : (
          <div className="max-w-5xl mx-auto">
            {/* Browser-like Header */}
            <div className="bg-card rounded-3xl shadow-large border border-border overflow-hidden">
              <div className="bg-secondary/50 px-6 py-4 border-b border-border">
                <div className="flex items-center justify-between flex-wrap gap-4">
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full bg-destructive/60" />
                    <div className="w-3 h-3 rounded-full bg-yellow-400/60" />
                    <div className="w-3 h-3 rounded-full bg-success/60" />
                    <span className="ml-4 text-sm text-muted-foreground">arivioo.com/results</span>
                  </div>
                  {hasValidDates && (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Calendar className="w-4 h-4" />
                      <span>Comparing prices for {formatDate(checkIn!)} – {formatDate(checkOut!)} ({nights} {nights === 1 ? 'night' : 'nights'})</span>
                    </div>
                  )}
                </div>
              </div>

              <div className="p-6 md:p-8">
                {/* Property Preview */}
                {airbnbImages.length > 0 && (
                  <div className="grid md:grid-cols-3 gap-4 mb-8">
                    <div className="md:col-span-2 aspect-video rounded-xl overflow-hidden">
                      <img 
                        src={airbnbImages[0]} 
                        alt={search?.airbnb_title || "Property"}
                        className="w-full h-full object-cover"
                      />
                    </div>
                    {airbnbImages[1] && (
                      <div className="aspect-video rounded-xl overflow-hidden">
                        <img 
                          src={airbnbImages[1]} 
                          alt="Property interior"
                          className="w-full h-full object-cover"
                        />
                      </div>
                    )}
                  </div>
                )}

                <h1 className="text-xl md:text-2xl font-bold text-foreground mb-6">
                  {search?.airbnb_title || "Price Comparison Results"}
                </h1>

                {results.length === 0 ? (
                  <div className="py-12 text-center">
                    <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-muted flex items-center justify-center">
                      <AlertCircle className="w-8 h-8 text-muted-foreground" />
                    </div>
                    <h3 className="text-xl font-semibold text-foreground mb-2">
                      No Alternative Listings Found
                    </h3>
                    <p className="text-muted-foreground mb-6 max-w-md mx-auto">
                      We couldn't find this property on Booking.com, Vrbo, or other platforms using photo matching and property details. 
                      It might be exclusive to Airbnb or listed under a different name elsewhere.
                    </p>
                    <p className="text-sm text-muted-foreground mb-6">
                      This means Airbnb is likely your best option for this property!
                    </p>
                    <Button asChild>
                      <Link to="/dashboard">
                        <Search className="w-4 h-4 mr-2" />
                        Try Another Search
                      </Link>
                    </Button>
                  </div>
                ) : (
                  <>
                    {/* Comparison Table */}
                    <div className="overflow-x-auto mb-8">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-border">
                            <th className="text-left py-3 px-4 font-semibold text-foreground">Platform</th>
                            <th className="text-center py-3 px-4 font-semibold text-foreground">Trust Score</th>
                            <th className="text-right py-3 px-4 font-semibold text-foreground">
                              {nights ? `Total (${nights} nights)` : 'Per Night'}
                            </th>
                            <th className="text-right py-3 px-4 font-semibold text-foreground hidden md:table-cell">Per Night</th>
                            <th className="text-center py-3 px-4 font-semibold text-foreground hidden lg:table-cell">Compare</th>
                            <th className="text-center py-3 px-4 font-semibold text-foreground">Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {/* Airbnb Original Row */}
                          <tr className="border-b border-border bg-[#FF5A5F]/5">
                            <td className="py-4 px-4">
                              <div className="flex items-center gap-2">
                                <span className="w-2 h-2 rounded-full bg-[#FF5A5F]" />
                                <span className="font-medium text-foreground">Airbnb</span>
                                <span className="text-xs text-muted-foreground">(Original)</span>
                              </div>
                            </td>
                            <td className="py-4 px-4 text-center">
                              <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-muted text-muted-foreground text-xs font-medium">
                                <Shield className="w-3 h-3" />
                                Baseline
                              </span>
                            </td>
                            <td className="py-4 px-4 text-right font-semibold text-foreground">
                              {airbnbGrandTotal ? `$${airbnbGrandTotal}` : search?.airbnb_price ? `$${search.airbnb_price}/night` : '—'}
                            </td>
                            <td className="py-4 px-4 text-right text-muted-foreground hidden md:table-cell">
                              {search?.airbnb_price ? `$${search.airbnb_price}/night` : '—'}
                            </td>
                            <td className="py-4 px-4 text-center hidden lg:table-cell">
                              <span className="text-xs text-muted-foreground">—</span>
                            </td>
                            <td className="py-4 px-4 text-center">
                              <Button variant="outline" size="sm" asChild>
                                <a href={search?.airbnb_url} target="_blank" rel="noopener noreferrer">
                                  View
                                </a>
                              </Button>
                            </td>
                          </tr>

                          {/* Alternative Results */}
                          {results.map((result, index) => {
                            const resultImages = toStringArray(result.images);
                            const isTopResult = index === 0 && result.savings_percentage && result.savings_percentage > 0;
                            const isDirect = result.platform_name.includes("(Direct)");
                            const totalPrice = result.price && nights ? result.price * nights : null;
                            const isExpanded = expandedComparison === result.id;
                            
                            return (
                              <React.Fragment key={result.id}>
                                <tr 
                                  className={`border-b border-border ${
                                    isTopResult 
                                      ? 'bg-success/5 border-2 border-success/30' 
                                      : 'hover:bg-muted/20'
                                  }`}
                                >
                                  <td className="py-4 px-4">
                                    <div className="flex items-center gap-2">
                                      <span className={`w-2 h-2 rounded-full ${
                                        isTopResult ? 'bg-success' : isDirect ? 'bg-amber-500' : 'bg-primary'
                                      }`} />
                                      <span className="font-medium text-foreground">{result.platform_name}</span>
                                      {isTopResult && (
                                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-success/20 text-success text-xs font-medium">
                                          <Sparkles className="w-3 h-3" />
                                          Best Deal
                                        </span>
                                      )}
                                      {isDirect && !isTopResult && (
                                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-600 dark:text-amber-400 text-xs font-medium">
                                          No Fees
                                        </span>
                                      )}
                                    </div>
                                  </td>
                                  <td className="py-4 px-4 text-center">
                                    {result.confidence_score !== null && result.confidence_score !== undefined ? (
                                      <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${
                                        result.confidence_score >= 0.9 
                                          ? 'bg-success/20 text-success' 
                                          : result.confidence_score >= 0.8 
                                          ? 'bg-primary/20 text-primary'
                                          : 'bg-blue-500/20 text-blue-600 dark:text-blue-400'
                                      }`}>
                                        <Shield className="w-3 h-3" />
                                        {Math.round(result.confidence_score * 100)}%
                                      </span>
                                    ) : (
                                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 text-xs font-medium">
                                        <Info className="w-3 h-3" />
                                        Text Only
                                      </span>
                                    )}
                                  </td>
                                  <td className={`py-4 px-4 text-right ${isTopResult ? 'text-success font-bold text-lg' : 'font-semibold text-foreground'}`}>
                                    {totalPrice ? `$${totalPrice}` : result.price ? `$${result.price}/night` : 'See listing'}
                                    {result.savings_percentage && result.savings_percentage > 0 && (
                                      <div className="text-xs text-success font-normal">
                                        Save {result.savings_percentage}%
                                      </div>
                                    )}
                                  </td>
                                  <td className={`py-4 px-4 text-right hidden md:table-cell ${isTopResult ? 'text-success font-medium' : 'text-muted-foreground'}`}>
                                    {result.price ? `$${result.price}/night` : '—'}
                                  </td>
                                  <td className="py-4 px-4 text-center hidden lg:table-cell">
                                    <PhotoComparisonButton 
                                      isExpanded={isExpanded}
                                      onToggle={() => setExpandedComparison(isExpanded ? null : result.id)}
                                      hasImages={airbnbImages.length > 0 || resultImages.length > 0}
                                    />
                                  </td>
                                  <td className="py-4 px-4 text-center">
                                    {isTopResult ? (
                                      <Button 
                                        size="sm" 
                                        className="bg-success hover:bg-success/90"
                                        onClick={() => window.open(result.listing_url, '_blank')}
                                      >
                                        <Lock className="w-3 h-3 mr-1" />
                                        Unlock
                                        <ExternalLink className="w-3 h-3 ml-1" />
                                      </Button>
                                    ) : (
                                      <Button 
                                        asChild 
                                        size="sm" 
                                        variant="outline"
                                      >
                                        <a href={result.listing_url} target="_blank" rel="noopener noreferrer">
                                          View Free
                                          <ExternalLink className="w-3 h-3 ml-1" />
                                        </a>
                                      </Button>
                                    )}
                                  </td>
                                </tr>
                                
                                {/* Image Comparison Row */}
                                {isExpanded && (
                                  <tr>
                                    <td colSpan={6} className="p-4 bg-muted/10">
                                      <ImageComparison
                                        airbnbImages={airbnbImages}
                                        alternativeImages={resultImages}
                                        airbnbTitle={search?.airbnb_title || "Airbnb Listing"}
                                        alternativeTitle={result.listing_title || "Alternative Listing"}
                                        platformName={result.platform_name}
                                      />
                                    </td>
                                  </tr>
                                )}
                              </React.Fragment>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>

                    {/* Mobile Card View - visible on lg and below for comparison button */}
                    <div className="lg:hidden space-y-2 mb-8">
                      {results.map((result) => {
                        const resultImages = toStringArray(result.images);
                        const isExpanded = expandedComparison === result.id;
                        const hasImages = airbnbImages.length > 0 || resultImages.length > 0;
                        
                        if (!hasImages) return null;
                        
                        return (
                          <div key={`mobile-compare-${result.id}`}>
                            <button
                              onClick={() => setExpandedComparison(isExpanded ? null : result.id)}
                              className="w-full flex items-center justify-between p-3 bg-muted/30 rounded-lg hover:bg-muted/50 transition-colors"
                            >
                              <div className="flex items-center gap-2">
                                <ArrowLeftRight className="w-4 h-4 text-primary" />
                                <span className="text-sm font-medium">Compare photos with {result.platform_name}</span>
                              </div>
                              <span className="text-xs text-muted-foreground">
                                {isExpanded ? 'Hide' : 'Show'}
                              </span>
                            </button>
                            
                            {isExpanded && (
                              <div className="mt-2">
                                <ImageComparison
                                  airbnbImages={airbnbImages}
                                  alternativeImages={resultImages}
                                  airbnbTitle={search?.airbnb_title || "Airbnb Listing"}
                                  alternativeTitle={result.listing_title || "Alternative Listing"}
                                  platformName={result.platform_name}
                                />
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    {/* Savings Summary */}
                    {bestResult && bestSavings > 0 && (
                      <div className="bg-success/10 rounded-2xl p-6 text-center mb-8">
                        <p className="text-muted-foreground mb-2">Your potential savings by booking on {bestResult.platform_name}</p>
                        <div className="flex items-center justify-center gap-4 mb-2">
                          <p className="text-4xl font-bold text-success">
                            ${bestSavingsAmount * (nights || 1)}
                          </p>
                          <span className="text-success text-lg font-semibold">({bestSavings}% off)</span>
                        </div>
                        <p className="text-sm text-muted-foreground mb-3">
                          Same property, same dates — just without the platform fees
                        </p>
                        <p className="text-xs text-muted-foreground">
                          <strong>Unlock fee:</strong> ${Math.round(bestSavingsAmount * (nights || 1) * 0.1)} (10% of your savings) — Only pay when you save
                        </p>
                      </div>
                    )}

                    {/* Methodology note */}
                    <div className="flex items-start gap-3 p-4 bg-muted/30 rounded-xl">
                      <Info className="w-5 h-5 text-muted-foreground flex-shrink-0 mt-0.5" />
                      <p className="text-xs text-muted-foreground">
                        <strong>Fair comparison methodology:</strong> All prices shown include total costs for identical dates. 
                        Trust scores are based on image matching accuracy. We verify listings using photo matching and location data. 
                        Always confirm details directly with the host before booking.
                      </p>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Try another search */}
            <div className="text-center mt-8">
              <Button variant="outline" asChild>
                <Link to="/dashboard">
                  <Search className="w-4 h-4 mr-2" />
                  Search Another Property
                </Link>
              </Button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
