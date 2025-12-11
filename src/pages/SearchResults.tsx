import React, { useState, useEffect, useRef } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { ImageCarousel } from "@/components/ImageCarousel";
import { ImageComparison } from "@/components/ImageComparison";
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
  Eye
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
              setCurrentStep(prev => Math.max(prev, newStep)); // Only move forward, never back
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

  const bestSavings = results.length > 0 
    ? Math.max(...results.map(r => r.savings_percentage || 0))
    : 0;

  // Get images arrays
  const airbnbImages = toStringArray(search?.airbnb_images);

  // Use dates from database first (these are the actual comparison dates used)
  // Fall back to URL extraction for display consistency
  const dbCheckIn = search?.check_in_date;
  const dbCheckOut = search?.check_out_date;
  const dbNights = search?.nights_count;
  
  // If DB has dates, use those (these are the dates actually used for comparison)
  // Otherwise extract from URL for legacy data
  const urlDates = search?.airbnb_url ? extractDatesFromUrl(search.airbnb_url) : { checkIn: null, checkOut: null };
  const checkIn = dbCheckIn || urlDates.checkIn;
  const checkOut = dbCheckOut || urlDates.checkOut;
  const hasValidDates = checkIn && checkOut;
  const nights = dbNights || (hasValidDates ? calculateNights(checkIn!, checkOut!) : null);

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
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-gradient-primary rounded-lg flex items-center justify-center">
              <span className="text-white font-bold">A</span>
            </div>
            <span className="font-bold text-xl text-foreground">Arivioo</span>
          </div>
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
                    {/* Connector line */}
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
                      {/* Step Icon */}
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
                      
                      {/* Step Content */}
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

            {/* Time estimate */}
            <div className="text-center">
              <p className="text-sm text-muted-foreground">
                This usually takes 30-60 seconds as we search across multiple platforms...
              </p>
            </div>
          </div>
        ) : (
          <>
            {/* Results Header */}
            <div className="max-w-5xl mx-auto mb-8">
              <div className="flex flex-col md:flex-row md:items-start justify-between gap-4 mb-6">
                <div className="flex-1">
                  <h1 className="text-2xl md:text-3xl font-bold text-foreground mb-2">
                    Price Comparison Results
                  </h1>
                  <p className="text-muted-foreground line-clamp-2">
                    {search?.airbnb_title || "Vacation Rental"}
                  </p>
                </div>

                {hasValidDates && (
                  <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-muted/50 text-muted-foreground flex-shrink-0">
                    <Calendar className="w-4 h-4" />
                    <span className="text-sm">
                      {formatDate(checkIn!)} – {formatDate(checkOut!)} ({nights} {nights === 1 ? 'night' : 'nights'})
                    </span>
                  </div>
                )}
              </div>

              {bestSavings > 0 && (
                <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-green-500/10 text-green-600 dark:text-green-400 mb-6">
                  <TrendingDown className="w-5 h-5" />
                  <span className="font-semibold">Great news! We found up to {bestSavings}% savings on alternative platforms.</span>
                </div>
              )}

              {/* Original Listing Card with Image Carousel */}
              <div className="bg-card rounded-2xl border border-border overflow-hidden mb-8">
                <div className="bg-[#FF5A5F]/5 px-6 py-3 border-b border-border flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-[#FF5A5F]" />
                    <span className="font-semibold text-foreground">Original Airbnb Listing</span>
                  </div>
                  {search?.airbnb_price && (
                    <span className="text-lg font-bold text-foreground">
                      ${search.airbnb_price}/night
                    </span>
                  )}
                </div>
                <div className="p-6">
                  <div className="flex flex-col md:flex-row items-start gap-6">
                    {/* Airbnb Image Carousel */}
                    <div className="w-full md:w-56 lg:w-72 flex-shrink-0">
                      {airbnbImages.length > 0 ? (
                        <ImageCarousel 
                          images={airbnbImages}
                          alt={search?.airbnb_title || "Property"}
                          aspectRatio="video"
                          fallbackColor="bg-[#FF5A5F]/10"
                        />
                      ) : (
                        <div className="aspect-video rounded-xl bg-[#FF5A5F]/10 flex items-center justify-center">
                          <ImageIcon className="w-8 h-8 text-[#FF5A5F]" />
                        </div>
                      )}
                    </div>
                    
                    <div className="flex-1 min-w-0">
                      <h3 className="font-semibold text-lg text-foreground mb-3 line-clamp-2">
                        {search?.airbnb_title || "Vacation Rental"}
                      </h3>
                      
                      {hasValidDates && search?.airbnb_price && nights && (
                        <div className="space-y-2 text-sm mb-4">
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">${search.airbnb_price} × {nights} nights</span>
                            <span className="text-foreground">${search.airbnb_price * nights}</span>
                          </div>
                          <div className="flex justify-between text-muted-foreground">
                            <span>+ Cleaning fee (est.)</span>
                            <span>Varies</span>
                          </div>
                          <div className="flex justify-between text-destructive/80">
                            <span>+ Service fee (~14%)</span>
                            <span>~${Math.round(search.airbnb_price * nights * 0.14)}</span>
                          </div>
                        </div>
                      )}

                      <Button asChild variant="outline" size="sm">
                        <a href={search?.airbnb_url} target="_blank" rel="noopener noreferrer">
                          View on Airbnb
                          <ExternalLink className="w-3 h-3 ml-2" />
                        </a>
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Alternatives */}
            <div className="max-w-5xl mx-auto">
              <h2 className="text-xl font-semibold text-foreground mb-4 flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-primary" />
                Alternative Listings Found ({results.length})
              </h2>

              {results.length === 0 ? (
                <div className="bg-card rounded-2xl border border-border p-12 text-center">
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
                  {/* Comparison Table for larger screens */}
                  <div className="hidden md:block bg-card rounded-2xl border border-border overflow-hidden mb-6">
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="bg-muted/30 border-b border-border">
                            <th className="text-left py-4 px-4 font-semibold text-foreground">Platform</th>
                            <th className="text-left py-4 px-4 font-semibold text-foreground">Property</th>
                            <th className="text-center py-4 px-4 font-semibold text-foreground">Match Score</th>
                            <th className="text-right py-4 px-4 font-semibold text-foreground">Price</th>
                            <th className="text-center py-4 px-4 font-semibold text-foreground">Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {results.map((result, index) => {
                            const resultImages = toStringArray(result.images);
                            const isTopResult = index === 0 && result.savings_percentage && result.savings_percentage > 0;
                            const isDirect = result.platform_name.includes("(Direct)");
                            
                            return (
                              <React.Fragment key={result.id}>
                                <tr 
                                  className={`border-b border-border last:border-0 ${
                                    isTopResult ? 'bg-green-500/5' : 'hover:bg-muted/20'
                                  }`}
                                >
                                  <td className="py-4 px-4">
                                    <div className="flex items-center gap-2">
                                      <span className={`w-2 h-2 rounded-full ${
                                        isDirect ? 'bg-amber-500' : isTopResult ? 'bg-success' : 'bg-primary'
                                      }`} />
                                      <span className="font-medium text-foreground">{result.platform_name}</span>
                                      {isTopResult && (
                                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-success/20 text-success text-xs font-medium">
                                          <Sparkles className="w-3 h-3" />
                                          Best Deal
                                        </span>
                                      )}
                                      {isDirect && (
                                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-600 dark:text-amber-400 text-xs font-medium">
                                          No Fees
                                        </span>
                                      )}
                                    </div>
                                  </td>
                                  <td className="py-4 px-4">
                                    <div className="flex items-center gap-3">
                                      <button
                                        onClick={() => setExpandedComparison(expandedComparison === result.id ? null : result.id)}
                                        className="w-12 h-12 rounded-lg overflow-hidden flex-shrink-0 bg-muted relative group cursor-pointer"
                                        title="Compare photos"
                                      >
                                        {resultImages.length > 0 || result.image_url ? (
                                          <img 
                                            src={resultImages[0] || result.image_url || ''} 
                                            alt={result.listing_title || 'Property'}
                                            className="w-full h-full object-cover"
                                            onError={(e) => {
                                              const target = e.target as HTMLImageElement;
                                              target.style.display = 'none';
                                            }}
                                          />
                                        ) : (
                                          <div className="w-full h-full flex items-center justify-center">
                                            <ImageIcon className="w-4 h-4 text-muted-foreground" />
                                          </div>
                                        )}
                                        <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                          <Eye className="w-4 h-4 text-white" />
                                        </div>
                                      </button>
                                      <span className="text-foreground line-clamp-2 text-sm">
                                        {result.listing_title || "Vacation Rental"}
                                      </span>
                                    </div>
                                  </td>
                                  <td className="py-4 px-4 text-center">
                                    {result.confidence_score !== null && result.confidence_score !== undefined ? (
                                      <div className="flex flex-col items-center gap-1">
                                        <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${
                                          result.confidence_score >= 0.9 
                                            ? 'bg-success/20 text-success' 
                                            : result.confidence_score >= 0.8 
                                            ? 'bg-primary/20 text-primary'
                                            : result.confidence_score >= 0.7
                                            ? 'bg-blue-500/20 text-blue-600 dark:text-blue-400'
                                            : 'bg-muted text-muted-foreground'
                                        }`}>
                                          <Shield className="w-3 h-3" />
                                          {Math.round(result.confidence_score * 100)}%
                                        </span>
                                        <span className="text-xs text-muted-foreground">
                                          {result.confidence_score >= 0.95 
                                            ? 'Verified Match' 
                                            : result.confidence_score >= 0.85 
                                            ? 'High Confidence'
                                            : result.confidence_score >= 0.7
                                            ? 'Good Match'
                                            : 'Possible Match'}
                                        </span>
                                      </div>
                                    ) : (
                                      <div className="flex flex-col items-center gap-1">
                                        <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 text-xs font-medium">
                                          <Info className="w-3 h-3" />
                                          Text Only
                                        </span>
                                        <span className="text-xs text-muted-foreground">
                                          Not visually verified
                                        </span>
                                      </div>
                                    )}
                                  </td>
                                  <td className="py-4 px-4 text-right">
                                    {result.price ? (
                                      <div>
                                        <span className={`font-bold ${isTopResult ? 'text-success text-lg' : 'text-foreground'}`}>
                                          ${result.price}
                                        </span>
                                        <span className="text-muted-foreground text-xs">/night</span>
                                        {result.savings_percentage && result.savings_percentage > 0 && (
                                          <div className="text-xs text-success mt-1">
                                            Save {result.savings_percentage}%
                                          </div>
                                        )}
                                      </div>
                                    ) : (
                                      <span className="text-muted-foreground text-xs">See listing</span>
                                    )}
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
                                {/* Visual Comparison Row */}
                                {expandedComparison === result.id && (
                                  <tr>
                                    <td colSpan={5} className="p-4 bg-muted/20">
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
                  </div>

                  {/* Card view for mobile */}
                  <div className="md:hidden space-y-4 mb-6">
                    {results.map((result, index) => {
                      const resultImages = toStringArray(result.images);
                      const isTopResult = index === 0 && result.savings_percentage && result.savings_percentage > 0;
                      const isDirect = result.platform_name.includes("(Direct)");
                      
                      return (
                        <div 
                          key={result.id}
                          className={`bg-card rounded-2xl border transition-all ${
                            isTopResult
                              ? "border-green-500/50 ring-1 ring-green-500/20"
                              : "border-border"
                          }`}
                        >
                          <div className="p-4">
                            <div className="flex items-start gap-4">
                              {/* Image */}
                              <div className="w-20 h-20 rounded-xl overflow-hidden flex-shrink-0 bg-muted relative">
                                {resultImages.length > 0 || result.image_url ? (
                                  <img 
                                    src={resultImages[0] || result.image_url || ''} 
                                    alt={result.listing_title || 'Property'}
                                    className="w-full h-full object-cover"
                                  />
                                ) : (
                                  <div className="w-full h-full flex items-center justify-center bg-primary/10">
                                    <ImageIcon className="w-6 h-6 text-primary" />
                                  </div>
                                )}
                                {/* Match Score Badge - only show for visual matches with confidence */}
                                {result.confidence_score !== null && result.confidence_score !== undefined ? (
                                  <div className={`absolute bottom-1 right-1 px-1.5 py-0.5 rounded text-xs font-medium flex items-center gap-0.5 ${
                                    result.confidence_score >= 0.9 
                                      ? 'bg-success text-white' 
                                      : result.confidence_score >= 0.8 
                                      ? 'bg-primary text-white'
                                      : result.confidence_score >= 0.7
                                      ? 'bg-blue-500 text-white'
                                      : 'bg-muted text-muted-foreground'
                                  }`}>
                                    <Shield className="w-2.5 h-2.5" />
                                    {Math.round(result.confidence_score * 100)}%
                                  </div>
                                ) : (
                                  <div className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded text-xs font-medium flex items-center gap-0.5 bg-amber-500/80 text-white">
                                    <Info className="w-2.5 h-2.5" />
                                    ?
                                  </div>
                                )}
                              </div>
                              
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-1 flex-wrap">
                                  <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${
                                    isDirect 
                                      ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                                      : 'bg-primary/10 text-primary'
                                  }`}>
                                    {result.platform_name}
                                  </span>
                                  {isTopResult && (
                                    <span className="flex items-center gap-1 text-xs text-success">
                                      <Sparkles className="w-3 h-3" />
                                      Best Deal
                                    </span>
                                  )}
                                </div>
                                
                                <h3 className="font-medium text-foreground mb-2 text-sm line-clamp-2">
                                  {result.listing_title || "Vacation Rental"}
                                </h3>

                                <div className="flex items-center justify-between">
                                  <div>
                                    {result.price ? (
                                      <span className={`font-bold ${isTopResult ? 'text-success' : 'text-foreground'}`}>
                                        ${result.price}/night
                                      </span>
                                    ) : (
                                      <span className="text-muted-foreground text-sm">See listing</span>
                                    )}
                                    {result.savings_percentage && result.savings_percentage > 0 && (
                                      <span className="text-xs text-success ml-2">
                                        Save {result.savings_percentage}%
                                      </span>
                                    )}
                                  </div>

                                  {isTopResult ? (
                                    <Button 
                                      size="sm" 
                                      className="bg-success hover:bg-success/90"
                                      onClick={() => window.open(result.listing_url, '_blank')}
                                    >
                                      <Lock className="w-3 h-3 mr-1" />
                                      Unlock
                                    </Button>
                                  ) : (
                                    <Button 
                                      asChild 
                                      size="sm" 
                                      variant="outline"
                                    >
                                      <a href={result.listing_url} target="_blank" rel="noopener noreferrer">
                                        View
                                        <ExternalLink className="w-3 h-3 ml-1" />
                                      </a>
                                    </Button>
                                  )}
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}

              {/* Methodology note */}
              <div className="bg-muted/30 rounded-xl p-4 flex items-start gap-3 mb-8">
                <Info className="w-5 h-5 text-muted-foreground flex-shrink-0 mt-0.5" />
                <div className="text-xs text-muted-foreground">
                  <strong className="text-foreground">How we found these:</strong> We extracted clean property photos from the Airbnb listing 
                  (no logos or UI elements) and ran reverse image searches across Booking.com, Vrbo, Agoda, HolidayCheck, and 10+ other platforms. 
                  Matches are verified using image similarity and location data. 
                  {hasValidDates && (
                    <span> All prices shown are for {formatDate(checkIn!)} – {formatDate(checkOut!)}.</span>
                  )}
                  {' '}Always confirm details directly with the host before booking.
                </div>
              </div>

              {/* Try another search */}
              <div className="text-center">
                <Button variant="outline" asChild>
                  <Link to="/dashboard">
                    <Search className="w-4 h-4 mr-2" />
                    Search Another Property
                  </Link>
                </Button>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
