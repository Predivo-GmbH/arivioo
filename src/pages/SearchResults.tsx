import { useState, useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { 
  ArrowLeft, 
  ExternalLink, 
  Search, 
  Sparkles, 
  CheckCircle2, 
  AlertCircle,
  TrendingDown,
  Building2,
  Loader2
} from "lucide-react";
import type { User } from "@supabase/supabase-js";

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
}

interface SearchData {
  id: string;
  airbnb_url: string;
  airbnb_title: string | null;
  airbnb_price: number | null;
  status: string;
  created_at: string;
}

const loadingMessages = [
  "Scanning the web for your property...",
  "Checking Vrbo, Booking.com and more...",
  "Comparing prices across platforms...",
  "Finding the best deals for you...",
  "Almost there, crunching the numbers...",
];

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

      setSearch(searchData);

      // If search is already completed, fetch results
      if (searchData.status === "completed") {
        const { data: resultsData } = await supabase
          .from("search_results")
          .select("*")
          .eq("search_id", searchId)
          .order("savings_percentage", { ascending: false, nullsFirst: false });

        setResults(resultsData || []);
        setLoading(false);
        return;
      }

      // If status is 'searching' or 'pending', trigger the search
      if (searchData.status === "searching" || searchData.status === "pending") {
        setSearchStarted(true);
        
        try {
          const response = await fetch(
            `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/search-alternatives`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
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

          setSearch(updatedSearch);
          setResults(resultsData || []);
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
              Searching for Better Deals
            </h2>
            
            <p className="text-muted-foreground mb-8 h-6">
              {loadingMessages[messageIndex]}
            </p>

            <div className="flex justify-center gap-2 mb-8">
              {[0, 1, 2, 3, 4].map(i => (
                <div 
                  key={i}
                  className={`w-2 h-2 rounded-full transition-all duration-300 ${
                    i === messageIndex ? "bg-primary w-6" : "bg-muted"
                  }`}
                />
              ))}
            </div>

            <p className="text-sm text-muted-foreground">
              This usually takes 30-60 seconds...
            </p>
          </div>
        ) : (
          <>
            {/* Results Header */}
            <div className="max-w-4xl mx-auto mb-8">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
                <div>
                  <h1 className="text-2xl md:text-3xl font-bold text-foreground mb-2">
                    Search Results
                  </h1>
                  <p className="text-muted-foreground line-clamp-1">
                    {search?.airbnb_title || "Vacation Rental"}
                  </p>
                </div>

                {bestSavings > 0 && (
                  <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-green-500/10 text-green-600 dark:text-green-400">
                    <TrendingDown className="w-5 h-5" />
                    <span className="font-semibold">Up to {bestSavings}% savings found!</span>
                  </div>
                )}
              </div>

              {/* Original Listing Card */}
              <div className="bg-card rounded-2xl border border-border p-6 mb-8">
                <div className="flex items-start gap-4">
                  <div className="w-12 h-12 rounded-xl bg-[#FF5A5F]/10 flex items-center justify-center flex-shrink-0">
                    <Building2 className="w-6 h-6 text-[#FF5A5F]" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-medium text-muted-foreground">Original Listing</span>
                      <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-[#FF5A5F]/10 text-[#FF5A5F]">
                        Airbnb
                      </span>
                    </div>
                    <h3 className="font-semibold text-foreground mb-2 line-clamp-1">
                      {search?.airbnb_title || "Vacation Rental"}
                    </h3>
                    <div className="flex flex-wrap items-center gap-4">
                      {search?.airbnb_price && (
                        <span className="text-lg font-bold text-foreground">
                          ${search.airbnb_price}/night
                        </span>
                      )}
                      <a 
                        href={search?.airbnb_url} 
                        target="_blank" 
                        rel="noopener noreferrer"
                        className="text-sm text-primary hover:underline flex items-center gap-1"
                      >
                        View on Airbnb
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Alternatives */}
            <div className="max-w-4xl mx-auto">
              <h2 className="text-xl font-semibold text-foreground mb-4 flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-primary" />
                Alternative Listings Found
              </h2>

              {results.length === 0 ? (
                <div className="bg-card rounded-2xl border border-border p-12 text-center">
                  <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-muted flex items-center justify-center">
                    <AlertCircle className="w-8 h-8 text-muted-foreground" />
                  </div>
                  <h3 className="text-xl font-semibold text-foreground mb-2">
                    No Alternatives Found
                  </h3>
                  <p className="text-muted-foreground mb-6 max-w-md mx-auto">
                    We couldn't find this exact property on other platforms. This might be an Airbnb-exclusive listing, or the property uses different names elsewhere.
                  </p>
                  <Button asChild>
                    <Link to="/dashboard">
                      <Search className="w-4 h-4 mr-2" />
                      Try Another Search
                    </Link>
                  </Button>
                </div>
              ) : (
                <div className="space-y-4">
                  {results.map((result, index) => (
                    <div 
                      key={result.id}
                      className={`bg-card rounded-2xl border transition-all hover:shadow-medium ${
                        index === 0 && result.savings_percentage && result.savings_percentage > 0
                          ? "border-green-500/50 ring-1 ring-green-500/20"
                          : "border-border"
                      }`}
                    >
                      <div className="p-6">
                        <div className="flex flex-col md:flex-row md:items-center gap-4">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-2">
                              <span className="px-3 py-1 text-sm font-medium rounded-full bg-primary/10 text-primary">
                                {result.platform_name}
                              </span>
                              {result.confidence_score && result.confidence_score > 0.7 && (
                                <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                                  <CheckCircle2 className="w-3 h-3" />
                                  High Match
                                </span>
                              )}
                            </div>
                            
                            <h3 className="font-semibold text-foreground mb-2 line-clamp-2">
                              {result.listing_title || "Vacation Rental"}
                            </h3>

                            <div className="flex flex-wrap items-center gap-4">
                              {result.price ? (
                                <div className="flex items-baseline gap-2">
                                  <span className="text-2xl font-bold text-foreground">
                                    ${result.price}
                                  </span>
                                  <span className="text-muted-foreground">/night</span>
                                </div>
                              ) : (
                                <span className="text-muted-foreground">Price not available</span>
                              )}

                              {result.savings_percentage && result.savings_percentage > 0 && (
                                <div className="flex items-center gap-1 px-3 py-1 rounded-full bg-green-500/10 text-green-600 dark:text-green-400">
                                  <TrendingDown className="w-4 h-4" />
                                  <span className="font-semibold">Save {result.savings_percentage}%</span>
                                  {result.savings_amount && (
                                    <span className="text-sm">(${result.savings_amount}/night)</span>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>

                          <div className="flex-shrink-0">
                            <Button asChild className="w-full md:w-auto bg-gradient-primary hover:opacity-90">
                              <a href={result.listing_url} target="_blank" rel="noopener noreferrer">
                                View & Book
                                <ExternalLink className="w-4 h-4 ml-2" />
                              </a>
                            </Button>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Try another search */}
              <div className="mt-8 text-center">
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
