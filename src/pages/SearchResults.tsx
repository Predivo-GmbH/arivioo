import { useState, useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { ImageCarousel } from "@/components/ImageCarousel";
import { 
  ArrowLeft, 
  ExternalLink, 
  Search, 
  Sparkles, 
  CheckCircle2, 
  AlertCircle,
  TrendingDown,
  Loader2,
  ImageIcon,
  Calendar,
  Info,
  Check,
  Shield,
  Lock
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
}

const loadingMessages = [
  "Extracting property photos from Airbnb...",
  "Running reverse image search across the web...",
  "Checking Vrbo, Booking.com, and direct sites...",
  "Verifying matches with location data...",
  "Comparing prices for your dates...",
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

export default function SearchResults() {
  const { searchId } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  
  const [user, setUser] = useState<User | null>(null);
  const [search, setSearch] = useState<SearchData | null>(null);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchStarted, setSearchStarted] = useState(false);
  const [messageIndex, setMessageIndex] = useState(0);

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

  // Rotate loading messages
  useEffect(() => {
    if (!loading || !searchStarted) return;
    const interval = setInterval(() => {
      setMessageIndex(i => (i + 1) % loadingMessages.length);
    }, 4000);
    return () => clearInterval(interval);
  }, [loading, searchStarted]);

  // Fetch search data and trigger search
  useEffect(() => {
    if (!searchId || !user) return;

    const fetchAndSearch = async () => {
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
        setSearchStarted(true);
        
        try {
          const { data: { session } } = await supabase.auth.getSession();
          
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

          const data = await response.json();

          if (!response.ok) {
            throw new Error(data.error || "Search failed");
          }

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

  // Extract dates from URL
  const dates = search?.airbnb_url ? extractDatesFromUrl(search.airbnb_url) : { checkIn: null, checkOut: null };
  const hasValidDates = dates.checkIn && dates.checkOut;
  const nights = hasValidDates ? calculateNights(dates.checkIn!, dates.checkOut!) : null;

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
          <div className="max-w-xl mx-auto text-center py-16">
            <div className="relative mb-8">
              <div className="w-24 h-24 mx-auto rounded-full bg-primary/10 flex items-center justify-center">
                <Loader2 className="w-12 h-12 text-primary animate-spin" />
              </div>
              <div className="absolute inset-0 w-24 h-24 mx-auto rounded-full border-4 border-primary/20 animate-ping" />
            </div>
            
            <h2 className="text-2xl font-bold text-foreground mb-4">
              Finding Better Deals
            </h2>
            
            <p className="text-muted-foreground mb-8 h-6">
              {loadingMessages[messageIndex]}
            </p>

            <div className="flex justify-center gap-2 mb-8">
              {loadingMessages.map((_, i) => (
                <div 
                  key={i}
                  className={`w-2 h-2 rounded-full transition-all duration-300 ${
                    i === messageIndex ? "bg-primary w-6" : "bg-muted"
                  }`}
                />
              ))}
            </div>

            <p className="text-sm text-muted-foreground">
              This usually takes 30-60 seconds as we search across multiple platforms...
            </p>
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
                      {formatDate(dates.checkIn!)} – {formatDate(dates.checkOut!)} ({nights} {nights === 1 ? 'night' : 'nights'})
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
                            <th className="text-center py-4 px-4 font-semibold text-foreground">Trust Score</th>
                            <th className="text-right py-4 px-4 font-semibold text-foreground">Price</th>
                            <th className="text-center py-4 px-4 font-semibold text-foreground">Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {results.map((result, index) => {
                            const resultImages = toStringArray(result.images);
                            const isTopResult = index === 0 && result.savings_percentage && result.savings_percentage > 0;
                            
                            return (
                              <tr 
                                key={result.id}
                                className={`border-b border-border last:border-0 ${
                                  isTopResult ? 'bg-green-500/5' : 'hover:bg-muted/20'
                                }`}
                              >
                                <td className="py-4 px-4">
                                  <div className="flex items-center gap-2">
                                    <span className={`w-2 h-2 rounded-full ${isTopResult ? 'bg-success' : 'bg-primary'}`} />
                                    <span className="font-medium text-foreground">{result.platform_name}</span>
                                    {isTopResult && (
                                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-success/20 text-success text-xs font-medium">
                                        <Sparkles className="w-3 h-3" />
                                        Best Deal
                                      </span>
                                    )}
                                  </div>
                                </td>
                                <td className="py-4 px-4">
                                  <div className="flex items-center gap-3">
                                    <div className="w-12 h-12 rounded-lg overflow-hidden flex-shrink-0 bg-muted">
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
                                    </div>
                                    <span className="text-foreground line-clamp-2 text-sm">
                                      {result.listing_title || "Vacation Rental"}
                                    </span>
                                  </div>
                                </td>
                                <td className="py-4 px-4 text-center">
                                  {result.confidence_score ? (
                                    <div className="flex flex-col items-center gap-1">
                                      <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${
                                        result.confidence_score >= 0.9 
                                          ? 'bg-success/20 text-success' 
                                          : result.confidence_score >= 0.7 
                                          ? 'bg-primary/20 text-primary'
                                          : 'bg-muted text-muted-foreground'
                                      }`}>
                                        <Shield className="w-3 h-3" />
                                        {Math.round(result.confidence_score * 100)}%
                                      </span>
                                      <span className="text-xs text-muted-foreground">
                                        {result.confidence_score >= 0.9 
                                          ? 'Excellent' 
                                          : result.confidence_score >= 0.7 
                                          ? 'Good'
                                          : 'Likely'}
                                      </span>
                                    </div>
                                  ) : (
                                    <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-muted text-muted-foreground text-xs">
                                      <Shield className="w-3 h-3" />
                                      Pending
                                    </span>
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
                                {/* Trust Score Badge */}
                                {result.confidence_score && (
                                  <div className={`absolute bottom-1 right-1 px-1.5 py-0.5 rounded text-xs font-medium flex items-center gap-0.5 ${
                                    result.confidence_score >= 0.9 
                                      ? 'bg-success text-white' 
                                      : result.confidence_score >= 0.7 
                                      ? 'bg-primary text-white'
                                      : 'bg-muted text-muted-foreground'
                                  }`}>
                                    <Shield className="w-2.5 h-2.5" />
                                    {Math.round(result.confidence_score * 100)}%
                                  </div>
                                )}
                              </div>
                              
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-1 flex-wrap">
                                  <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-primary/10 text-primary">
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
                  <strong className="text-foreground">How we found these:</strong> We extracted property photos from the Airbnb listing 
                  and ran reverse image searches to find the same property on other platforms. 
                  Matches are verified using image similarity and location data. 
                  Always confirm details directly with the host before booking.
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