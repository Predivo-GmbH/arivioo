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

  // Calculate totals
  const airbnbTotal = search?.airbnb_price && nights ? search.airbnb_price * nights : null;
  const estimatedServiceFee = airbnbTotal ? Math.round(airbnbTotal * 0.14) : null;
  const airbnbGrandTotal = airbnbTotal && estimatedServiceFee ? airbnbTotal + estimatedServiceFee : null;

  // Filter and sort results: limit to 4, sorted by price (most expensive first, cheapest last)
  // Filter out unreasonable prices (less than 10% of Airbnb price is likely an error)
  const minReasonablePrice = airbnbGrandTotal ? airbnbGrandTotal * 0.1 : 10;
  const validResults = results.filter(r => {
    const totalPrice = r.price && nights ? r.price * nights : r.price;
    return totalPrice && totalPrice >= minReasonablePrice;
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
            {/* Clean Results Container - No browser mockup */}
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
                  <div className="mb-6 p-4 bg-primary/5 border border-primary/20 rounded-xl">
                    <div className="flex items-center gap-3">
                      <Calendar className="w-5 h-5 text-primary flex-shrink-0" />
                      <div>
                        <p className="font-medium text-foreground">
                          Prices compared for: {formatDate(checkIn!)} – {formatDate(checkOut!)}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {nights} {nights === 1 ? 'night' : 'nights'} • Same dates used across all platforms
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {/* Airbnb Baseline Price Card */}
                <div className="mb-6 p-5 bg-[#FF5A5F]/5 border border-[#FF5A5F]/20 rounded-xl">
                  <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                    <div className="flex items-center gap-3">
                      <span className="w-4 h-4 rounded-full bg-[#FF5A5F]" />
                      <div>
                        <p className="font-semibold text-foreground">Airbnb Original Price</p>
                        <p className="text-sm text-muted-foreground">Your baseline for comparison</p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-2xl font-bold text-foreground">
                        {airbnbGrandTotal ? `€${airbnbGrandTotal}` : search?.airbnb_price ? `€${search.airbnb_price * (nights || 1)}` : '—'}
                      </p>
                      <div className="text-sm text-muted-foreground space-y-0.5">
                        {search?.airbnb_price && <p>€{search.airbnb_price}/night × {nights || 1} nights</p>}
                        {estimatedServiceFee && <p>+ ~€{estimatedServiceFee} service fee</p>}
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 pt-3 border-t border-[#FF5A5F]/10">
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <Shield className="w-3 h-3" />
                      Includes AirCover protection • Cleaning fee may apply
                    </p>
                  </div>
                </div>

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
                    {/* Comparison Cards */}
                    <div className="space-y-4 mb-8">
                      {/* Airbnb Original Card */}
                      <div className="border border-border rounded-xl p-4 bg-[#FF5A5F]/5">
                        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                          <div className="flex items-center gap-3">
                            <span className="w-4 h-4 rounded-full bg-[#FF5A5F]" />
                            <div>
                              <span className="font-semibold text-foreground">Airbnb</span>
                              <span className="text-xs text-muted-foreground ml-2">(Original)</span>
                            </div>
                            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-muted text-muted-foreground text-xs font-medium">
                              <Shield className="w-3 h-3" />
                              Baseline
                            </span>
                          </div>
                          <div className="flex items-center gap-4">
                            <div className="text-right">
                              <div className="font-bold text-lg text-foreground">
                                €{airbnbGrandTotal || (search?.airbnb_price ? search.airbnb_price * (nights || 1) : '—')}
                              </div>
                              <div className="text-xs text-muted-foreground">
                                €{search?.airbnb_price}/night
                              </div>
                            </div>
                            <Button variant="outline" size="sm" asChild>
                              <a href={search?.airbnb_url} target="_blank" rel="noopener noreferrer">
                                View
                              </a>
                            </Button>
                          </div>
                        </div>
                        {/* Key Differences for Airbnb */}
                        <div className="mt-3 pt-3 border-t border-[#FF5A5F]/20">
                          <p className="text-xs font-medium text-muted-foreground mb-1">Key Differences:</p>
                          <div className="flex flex-wrap gap-2">
                            <span className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded">AirCover protection</span>
                            <span className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded">~14% service fee included</span>
                            <span className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded">Host reviews visible</span>
                          </div>
                        </div>
                      </div>

                      {/* Alternative Results */}
                      {displayResults.map((result, index) => {
                        const resultImages = toStringArray(result.images);
                        const isCheapest = cheapestResult && result.id === cheapestResult.id;
                        const isDirect = result.platform_name.includes("(Direct)");
                        const totalPrice = result.price && nights ? result.price * nights : null;
                        const isExpanded = expandedComparison === result.id;
                        const savingsVsAirbnb = airbnbGrandTotal && totalPrice ? airbnbGrandTotal - totalPrice : null;
                        const keyDiffs = getKeyDifferences(result);
                        
                        return (
                          <div key={result.id} className={`border rounded-xl p-4 transition-all ${
                            isCheapest 
                              ? 'border-success/50 bg-success/5 ring-2 ring-success/20' 
                              : 'border-border hover:border-primary/30'
                          }`}>
                            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                              <div className="flex items-center gap-3 flex-wrap">
                                <span className={`w-4 h-4 rounded-full ${
                                  isCheapest ? 'bg-success' : isDirect ? 'bg-amber-500' : 'bg-primary'
                                }`} />
                                <span className="font-semibold text-foreground">{result.platform_name}</span>
                                
                                {/* Trust Score Badge */}
                                {result.confidence_score !== null && result.confidence_score !== undefined ? (
                                  <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${
                                    result.confidence_score >= 0.9 
                                      ? 'bg-success/20 text-success' 
                                      : result.confidence_score >= 0.8 
                                      ? 'bg-primary/20 text-primary'
                                      : 'bg-blue-500/20 text-blue-600 dark:text-blue-400'
                                  }`}>
                                    <Shield className="w-3 h-3" />
                                    {Math.round(result.confidence_score * 100)}% match
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 text-xs font-medium">
                                    <Info className="w-3 h-3" />
                                    Text match
                                  </span>
                                )}
                                
                                {isCheapest && (
                                  <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-success/20 text-success text-xs font-semibold">
                                    <Sparkles className="w-3 h-3" />
                                    Best Deal
                                  </span>
                                )}
                                {isDirect && !isCheapest && (
                                  <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-amber-500/20 text-amber-600 dark:text-amber-400 text-xs font-medium">
                                    No Fees
                                  </span>
                                )}
                              </div>
                              
                              <div className="flex items-center gap-4">
                                <div className="text-right">
                                  <div className={`font-bold text-lg ${isCheapest ? 'text-success' : 'text-foreground'}`}>
                                    {totalPrice ? `€${totalPrice}` : result.price ? `€${result.price}` : 'See listing'}
                                  </div>
                                  {savingsVsAirbnb && savingsVsAirbnb > 0 && (
                                    <div className="text-xs text-success font-medium flex items-center gap-1 justify-end">
                                      <TrendingDown className="w-3 h-3" />
                                      Save €{savingsVsAirbnb}
                                    </div>
                                  )}
                                  {result.price && (
                                    <div className="text-xs text-muted-foreground">€{result.price}/night</div>
                                  )}
                                </div>
                                
                                {isCheapest ? (
                                  <Button 
                                    size="sm" 
                                    className="bg-success hover:bg-success/90 shadow-md"
                                    onClick={() => window.open(result.listing_url, '_blank')}
                                  >
                                    <Lock className="w-3 h-3 mr-1" />
                                    Unlock Deal
                                  </Button>
                                ) : (
                                  <Button 
                                    asChild 
                                    size="sm" 
                                    variant="outline"
                                  >
                                    <a href={result.listing_url} target="_blank" rel="noopener noreferrer">
                                      View Free
                                    </a>
                                  </Button>
                                )}
                              </div>
                            </div>
                            
                            {/* Key Differences Section */}
                            <div className="mt-3 pt-3 border-t border-border/50">
                              <p className="text-xs font-medium text-muted-foreground mb-1">Key Differences:</p>
                              <div className="flex flex-wrap gap-2">
                                {keyDiffs.map((diff, i) => (
                                  <span key={i} className={`text-xs px-2 py-1 rounded ${
                                    diff.startsWith('✓') ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground'
                                  }`}>
                                    {diff}
                                  </span>
                                ))}
                              </div>
                            </div>
                            
                            {/* Photo Comparison Toggle */}
                            <div className="mt-3">
                              <button
                                onClick={() => setExpandedComparison(isExpanded ? null : result.id)}
                                className="text-sm text-primary hover:underline flex items-center gap-1"
                              >
                                <ArrowLeftRight className="w-4 h-4" />
                                {isExpanded ? 'Hide photo comparison' : 'Compare photos side-by-side'}
                              </button>
                            </div>
                            
                            {/* Image Comparison - Expandable */}
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


                    {/* Potential Savings Banner */}
                    {potentialSavings && potentialSavings > 0 && cheapestResult && (
                      <div className="bg-gradient-to-br from-success/15 via-success/10 to-success/5 rounded-2xl p-6 md:p-8 border-2 border-success/30 mb-8">
                        <div className="flex flex-col md:flex-row items-center justify-between gap-6">
                          <div className="text-center md:text-left">
                            <div className="flex items-center gap-2 justify-center md:justify-start mb-2">
                              <Sparkles className="w-5 h-5 text-success" />
                              <span className="text-sm font-semibold text-success uppercase tracking-wide">Your Potential Savings</span>
                            </div>
                            <p className="text-muted-foreground mb-1">
                              By booking on <span className="font-semibold text-foreground">{cheapestResult.platform_name}</span>
                            </p>
                            <div className="flex items-baseline gap-3 justify-center md:justify-start">
                              <p className="text-4xl md:text-5xl font-bold text-success">
                                €{potentialSavings}
                              </p>
                              <span className="text-success text-xl font-semibold">saved</span>
                            </div>
                            <p className="text-sm text-muted-foreground mt-2">
                              Same property • {hasValidDates ? `${formatDate(checkIn!)} – ${formatDate(checkOut!)}` : 'Same dates'}
                            </p>
                          </div>
                          
                          <div className="flex flex-col items-center gap-3">
                            <Button 
                              size="lg"
                              className="bg-success hover:bg-success/90 text-lg px-8 py-6 h-auto shadow-lg"
                              onClick={() => window.open(cheapestResult.listing_url, '_blank')}
                            >
                              <Lock className="w-5 h-5 mr-2" />
                              Unlock This Deal
                              <ExternalLink className="w-5 h-5 ml-2" />
                            </Button>
                            <p className="text-xs text-muted-foreground text-center">
                              <strong>Fee:</strong> €{Math.round(potentialSavings * 0.1)} (10% of savings)
                            </p>
                          </div>
                        </div>
                        
                        {/* Visual comparison of prices */}
                        <div className="mt-6 pt-6 border-t border-success/20">
                          <div className="grid grid-cols-2 gap-4 text-center">
                            <div className="bg-background/50 rounded-xl p-4">
                              <p className="text-sm text-muted-foreground mb-1">Airbnb Price</p>
                              <p className="text-xl font-semibold text-foreground line-through opacity-60">
                                €{airbnbGrandTotal || (search?.airbnb_price || 0) * (nights || 1)}
                              </p>
                            </div>
                            <div className="bg-success/10 rounded-xl p-4 border border-success/30">
                              <p className="text-sm text-success font-medium mb-1">{cheapestResult.platform_name}</p>
                              <p className="text-xl font-bold text-success">
                                €{cheapestTotalPrice}
                              </p>
                            </div>
                          </div>
                        </div>
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
