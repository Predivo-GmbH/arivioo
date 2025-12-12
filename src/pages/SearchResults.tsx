import React, { useState, useEffect, useRef } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { ImageComparison } from "@/components/ImageComparison";
import { 
  ArrowLeft, 
  ExternalLink, 
  Search, 
  Sparkles, 
  AlertCircle,
  TrendingDown,
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
  source_airbnb_image?: string | null; // The Airbnb image that matched this result
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

  // Calculate totals - use original_price from results if airbnb_price not available
  const referencePrice = search?.airbnb_price || (results.length > 0 ? results[0].original_price : null);
  const airbnbTotal = referencePrice && nights ? referencePrice * nights : null;
  const estimatedServiceFee = airbnbTotal ? Math.round(airbnbTotal * 0.14) : null;
  const airbnbGrandTotal = airbnbTotal && estimatedServiceFee ? airbnbTotal + estimatedServiceFee : null;

  // Filter and sort results with strict price validation
  // 1. Must have a valid price (> 0)
  // 2. If we have Airbnb baseline, filter out prices below 20% (likely parsing errors like €7 vs €700)
  // 3. Also filter out prices above 200% of baseline (likely different property)
  const validResults = results.filter(r => {
    if (!r.price || r.price <= 0) return false;
    
    const totalPrice = nights ? r.price * nights : r.price;
    
    // If we have a reference price, validate against it
    if (airbnbGrandTotal) {
      const minReasonable = airbnbGrandTotal * 0.20; // At least 20% of Airbnb price
      const maxReasonable = airbnbGrandTotal * 2.0;  // At most 200% of Airbnb price
      return totalPrice >= minReasonable && totalPrice <= maxReasonable;
    }
    
    // Without reference, just ensure price is reasonable (> €10 per night)
    return r.price >= 10;
  });
  
  // Sort by price descending (most expensive first), then take specific positions
  const sortedByPrice = [...validResults].sort((a, b) => {
    const priceA = a.price || 0;
    const priceB = b.price || 0;
    return priceB - priceA; // Descending
  });
  
  // Take max 3 alternatives (will show 4 total with Airbnb)
  // Structure: most expensive, second most expensive, cheapest
  let displayResults: SearchResult[] = [];
  if (sortedByPrice.length >= 3) {
    displayResults = [
      sortedByPrice[0], // Most expensive
      sortedByPrice[1], // Second most expensive
      sortedByPrice[sortedByPrice.length - 1] // Cheapest (last after sorting desc)
    ];
  } else {
    displayResults = sortedByPrice.slice(0, 3);
  }
  
  // Find cheapest result for unlock button
  const cheapestResult = displayResults.length > 0 
    ? displayResults.reduce((min, r) => (!min.price || (r.price && r.price < min.price)) ? r : min, displayResults[0])
    : null;
  
  // Calculate potential savings
  const cheapestTotalPrice = cheapestResult?.price && nights ? cheapestResult.price * nights : null;
  const potentialSavings = airbnbGrandTotal && cheapestTotalPrice ? airbnbGrandTotal - cheapestTotalPrice : null;


  // Helper to generate key differences based on platform
  const getKeyDifferences = (result: SearchResult): string[] => {
    const differences: string[] = [];
    const isDirect = result.platform_name.includes("(Direct)");
    
    if (isDirect) {
      differences.push("No platform booking fees");
      differences.push("Book directly with owner");
    }
    
    if (result.platform_name.toLowerCase().includes("booking")) {
      differences.push("Free cancellation usually available");
      differences.push("Breakfast may be included");
    } else if (result.platform_name.toLowerCase().includes("vrbo")) {
      differences.push("Similar to Airbnb policies");
      differences.push("May have lower service fees");
    } else if (result.platform_name.toLowerCase().includes("agoda")) {
      differences.push("Often includes breakfast");
      differences.push("Pay at property options");
    }
    
    if (result.match_type === 'visual') {
      differences.push("✓ Photo verified match");
    }
    
    return differences.length > 0 ? differences : ["Verify booking terms on site"];
  };

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
            {/* Clean Results Container */}
            <div className="bg-card rounded-2xl shadow-large border border-border overflow-hidden">
              <div className="p-6 md:p-8">
                {/* Single Hero Image */}
                {airbnbImages.length > 0 && (
                  <div className="mb-6">
                    <div className="aspect-[21/9] rounded-xl overflow-hidden">
                      <img 
                        src={airbnbImages[0]} 
                        alt={search?.airbnb_title || "Property"}
                        className="w-full h-full object-cover"
                        loading="eager"
                      />
                    </div>
                  </div>
                )}

                <h1 className="text-xl md:text-2xl font-bold text-foreground mb-4">
                  {search?.airbnb_title || "Price Comparison Results"}
                </h1>

                {/* Date Range Notice */}
                {hasValidDates && (
                  <div className="mb-6 flex items-center gap-2 text-sm text-muted-foreground">
                    <Calendar className="w-4 h-4" />
                    <span>Comparing prices for {formatDate(checkIn!)} – {formatDate(checkOut!)} ({nights} {nights === 1 ? 'night' : 'nights'})</span>
                  </div>
                )}

                {/* Show results even without Airbnb price - just show skeletons for price columns */}
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
                    {/* Comparison Table - Matching ExampleResult layout */}
                    <div className="overflow-x-auto mb-8">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-border">
                            <th className="text-left py-3 px-4 font-semibold text-foreground">Platform</th>
                            <th className="text-center py-3 px-4 font-semibold text-foreground">Trust Score</th>
                            <th className="text-right py-3 px-4 font-semibold text-foreground">Total ({nights || 1} nights)</th>
                            <th className="text-right py-3 px-4 font-semibold text-foreground">Per Night</th>
                            <th className="text-left py-3 px-4 font-semibold text-foreground hidden lg:table-cell">Key Differences</th>
                            <th className="text-center py-3 px-4 font-semibold text-foreground">Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {/* Airbnb Original Row - Show estimated price when actual not available */}
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
                              {search?.airbnb_price ? (
                                `€${Math.round(search.airbnb_price * (nights || 1) * 1.14)}`
                              ) : (
                                <div className="flex justify-end">
                                  <div className="h-5 w-16 bg-muted animate-pulse rounded" />
                                </div>
                              )}
                            </td>
                            <td className="py-4 px-4 text-right text-muted-foreground">
                              {search?.airbnb_price ? (
                                `€${search.airbnb_price}/night`
                              ) : (
                                <div className="flex justify-end">
                                  <div className="h-4 w-14 bg-muted animate-pulse rounded" />
                                </div>
                              )}
                            </td>
                            <td className="py-4 px-4 text-muted-foreground hidden lg:table-cell">
                              <span className="text-xs">AirCover protection, ~14% service fee, cleaning fee may apply</span>
                            </td>
                            <td className="py-4 px-4 text-center">
                              <Button variant="outline" size="sm" asChild>
                                <a href={search?.airbnb_url} target="_blank" rel="noopener noreferrer">View</a>
                              </Button>
                            </td>
                          </tr>

                          {/* Alternative Results */}
                          {displayResults.map((result) => {
                            const isCheapest = cheapestResult && result.id === cheapestResult.id;
                            const isDirect = result.platform_name.includes("(Direct)");
                            const totalPrice = result.price && nights ? result.price * nights : null;
                            const keyDiffs = getKeyDifferences(result);
                            const resultImages = toStringArray(result.images);
                            const isExpanded = expandedComparison === result.id;
                            
                            return (
                              <React.Fragment key={result.id}>
                                <tr 
                                  className={isCheapest 
                                    ? 'bg-success/5 border-2 border-success/30' 
                                    : 'border-b border-border hover:bg-muted/50'
                                  }
                                >
                                  <td className="py-4 px-4">
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <span className={`w-2 h-2 rounded-full ${
                                        isCheapest ? 'bg-success' : isDirect ? 'bg-amber-500' : 'bg-blue-500'
                                      }`} />
                                      <span className="font-medium text-foreground">{result.platform_name}</span>
                                      {isCheapest && (
                                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-success/20 text-success text-xs font-medium">
                                          <Sparkles className="w-3 h-3" />
                                          Best Deal
                                        </span>
                                      )}
                                    </div>
                                  </td>
                                  <td className="py-4 px-4 text-center">
                                    {result.confidence_score !== null && result.confidence_score !== undefined ? (
                                      <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${
                                        result.confidence_score >= 0.9 
                                          ? 'bg-success/20 text-success' 
                                          : 'bg-primary/20 text-primary'
                                      }`}>
                                        <Shield className="w-3 h-3" />
                                        {Math.round(result.confidence_score * 100)}%
                                      </span>
                                    ) : (
                                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 text-xs font-medium">
                                        <Info className="w-3 h-3" />
                                        Text
                                      </span>
                                    )}
                                  </td>
                                  <td className={`py-4 px-4 text-right font-semibold ${isCheapest ? 'text-success text-lg' : 'text-foreground'}`}>
                                    {totalPrice ? `€${totalPrice}` : result.price ? `€${result.price}` : '—'}
                                  </td>
                                  <td className={`py-4 px-4 text-right ${isCheapest ? 'text-success font-medium' : 'text-muted-foreground'}`}>
                                    {result.price ? `€${result.price}/night` : '—'}
                                  </td>
                                  <td className="py-4 px-4 hidden lg:table-cell">
                                    <span className={`text-xs ${isCheapest ? 'text-success flex items-center gap-1' : 'text-muted-foreground'}`}>
                                      {isCheapest && <Check className="w-3 h-3" />}
                                      {keyDiffs.slice(0, 2).join(', ')}
                                    </span>
                                  </td>
                                  <td className="py-4 px-4 text-center">
                                    <div className="flex flex-col gap-1.5 items-center">
                                      {isCheapest ? (
                                        <Button size="sm" className="bg-success hover:bg-success/90">
                                          <Lock className="w-3 h-3 mr-1" />
                                          Unlock
                                          <ExternalLink className="w-3 h-3 ml-1" />
                                        </Button>
                                      ) : (
                                        <Button variant="outline" size="sm" asChild>
                                          <a href={result.listing_url} target="_blank" rel="noopener noreferrer">View Free</a>
                                        </Button>
                                      )}
                                      {resultImages.length > 0 && airbnbImages.length > 0 && (
                                        <button
                                          onClick={() => setExpandedComparison(isExpanded ? null : result.id)}
                                          className={`text-xs px-2 py-1 rounded transition-colors flex items-center gap-1 ${
                                            isExpanded 
                                              ? 'bg-primary/10 text-primary' 
                                              : 'text-muted-foreground hover:text-primary'
                                          }`}
                                        >
                                          <ArrowLeftRight className="w-3 h-3" />
                                          {isExpanded ? 'Hide' : 'Photos'}
                                        </button>
                                      )}
                                    </div>
                                  </td>
                                </tr>
                                {/* Inline Photo Comparison - appears directly below the row */}
                                {isExpanded && resultImages.length > 0 && (
                                  <tr className="border-b border-border">
                                    <td colSpan={6} className="p-4 bg-muted/30">
                                      <ImageComparison
                                        airbnbImages={airbnbImages}
                                        alternativeImages={resultImages}
                                        airbnbTitle={search?.airbnb_title || "Airbnb Listing"}
                                        alternativeTitle={result.listing_title || "Alternative Listing"}
                                        platformName={result.platform_name}
                                        sourceAirbnbImage={result.source_airbnb_image}
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

                    {/* Mobile Cards View for Key Differences */}
                    <div className="lg:hidden space-y-4 mb-8">
                      {displayResults.map((result) => {
                        const resultImages = toStringArray(result.images);
                        const isCheapest = cheapestResult && result.id === cheapestResult.id;
                        const isExpanded = expandedComparison === result.id;
                        const keyDiffs = getKeyDifferences(result);
                        
                        return (
                          <div key={`mobile-${result.id}`} className={`border rounded-xl p-4 ${
                            isCheapest ? 'border-success/50 bg-success/5' : 'border-border'
                          }`}>
                            <p className="text-xs font-medium text-muted-foreground mb-2">Key Differences:</p>
                            <div className="flex flex-wrap gap-2 mb-3">
                              {keyDiffs.map((diff, i) => (
                                <span key={i} className={`text-xs px-2 py-1 rounded ${
                                  diff.startsWith('✓') ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground'
                                }`}>
                                  {diff}
                                </span>
                              ))}
                            </div>
                            
                            {/* Photo Comparison Toggle */}
                            <button
                              onClick={() => setExpandedComparison(isExpanded ? null : result.id)}
                              className="text-sm text-primary hover:underline flex items-center gap-1"
                            >
                              <ArrowLeftRight className="w-4 h-4" />
                              {isExpanded ? 'Hide photo comparison' : 'Compare photos'}
                            </button>
                            
                            {isExpanded && (
                              <div className="mt-4 pt-4 border-t border-border animate-fade-in">
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

                    {/* Savings Summary - Show skeleton when Airbnb price not available */}
                    {cheapestResult && cheapestResult.price && (
                      <div className="bg-success/10 rounded-2xl p-6 text-center mb-8">
                        <p className="text-muted-foreground mb-2">Your potential savings by booking direct</p>
                        <div className="flex items-center justify-center gap-4 mb-2">
                          {!search?.airbnb_price ? (
                            <div className="flex items-center gap-3">
                              <div className="h-10 w-24 bg-muted animate-pulse rounded" />
                              <div className="h-6 w-16 bg-muted animate-pulse rounded" />
                            </div>
                          ) : potentialSavings && potentialSavings > 0 ? (
                            <>
                              <p className="text-4xl font-bold text-success">€{Math.round(potentialSavings)}</p>
                              <span className="text-success text-lg font-semibold">
                                ({airbnbGrandTotal ? Math.round((potentialSavings / airbnbGrandTotal) * 100) : '~'}% off)
                              </span>
                            </>
                          ) : (
                            <p className="text-2xl font-bold text-success">
                              Best price: €{cheapestResult.price && nights ? cheapestResult.price * nights : cheapestResult.price}/total
                            </p>
                          )}
                        </div>
                        <p className="text-sm text-muted-foreground mb-3">
                          {!search?.airbnb_price 
                            ? "Calculating savings..."
                            : "Same property, same dates — just without the platform fees"
                          }
                        </p>
                        {search?.airbnb_price && potentialSavings && potentialSavings > 0 && (
                          <p className="text-xs text-muted-foreground">
                            <strong>Unlock fee:</strong> €{(potentialSavings * 0.1).toFixed(2)} (10% of your savings) — Only pay when you save
                          </p>
                        )}
                      </div>
                    )}

                    {/* Methodology note */}
                    <div className="flex items-start gap-3 p-4 bg-muted/30 rounded-xl">
                      <Info className="w-5 h-5 text-muted-foreground flex-shrink-0 mt-0.5" />
                      <p className="text-xs text-muted-foreground">
                        <strong>Fair comparison methodology:</strong> All prices shown include total costs with fees and taxes for identical dates. 
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
