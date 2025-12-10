import { useState, useEffect } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Search, LogOut, History, Sparkles, Clock, ExternalLink, TrendingDown } from "lucide-react";
import type { User } from "@supabase/supabase-js";

interface SearchHistory {
  id: string;
  airbnb_url: string;
  airbnb_title: string | null;
  airbnb_price: number | null;
  status: string;
  created_at: string;
}

export default function Dashboard() {
  const [user, setUser] = useState<User | null>(null);
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [searches, setSearches] = useState<SearchHistory[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { toast } = useToast();

  useEffect(() => {
    const urlFromParams = searchParams.get("url");
    if (urlFromParams) setUrl(urlFromParams);
  }, [searchParams]);

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

  // Fetch search history
  useEffect(() => {
    if (!user) return;

    const fetchSearches = async () => {
      const { data, error } = await supabase
        .from("searches")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(10);

      if (!error && data) {
        setSearches(data);
      }
      setLoadingHistory(false);
    };

    fetchSearches();
  }, [user]);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim() || !user) return;

    setLoading(true);
    try {
      const { data, error } = await supabase.from("searches").insert({
        user_id: user.id,
        airbnb_url: url,
        status: "searching"
      }).select().single();

      if (error) throw error;
      navigate(`/search/${data.id}`);
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate("/");
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString("en-US", { 
      month: "short", 
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    });
  };

  if (!user) return null;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="container px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-gradient-primary rounded-lg flex items-center justify-center">
              <span className="text-white font-bold">A</span>
            </div>
            <span className="font-bold text-xl text-foreground">Arivioo</span>
          </div>
          <Button variant="ghost" size="sm" onClick={handleLogout}>
            <LogOut className="w-4 h-4 mr-2" />
            Log out
          </Button>
        </div>
      </header>

      <main className="container px-4 py-12">
        <div className="max-w-2xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary/10 text-primary mb-6">
            <Sparkles className="w-4 h-4" />
            <span className="text-sm font-medium">Find cheaper alternatives</span>
          </div>

          <h1 className="text-3xl md:text-4xl font-bold text-foreground mb-4">
            Paste Your Airbnb Link
          </h1>
          <p className="text-muted-foreground mb-8">
            We'll search across the web to find the same property at a lower price.
          </p>

          <form onSubmit={handleSearch} className="mb-12">
            <div className="flex flex-col sm:flex-row gap-3 p-2 bg-card rounded-2xl shadow-medium border border-border">
              <Input
                type="url"
                placeholder="https://airbnb.com/rooms/..."
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                required
                className="flex-1 h-14 text-lg border-0 bg-transparent focus-visible:ring-0 px-4"
              />
              <Button type="submit" size="lg" disabled={loading} className="h-14 px-8 bg-gradient-primary hover:opacity-90">
                {loading ? "Searching..." : "Search"}
                <Search className="w-5 h-5 ml-2" />
              </Button>
            </div>
          </form>

          <div className="bg-card rounded-2xl border border-border p-6 text-left">
            <div className="flex items-center gap-3 mb-4">
              <History className="w-5 h-5 text-muted-foreground" />
              <h2 className="font-semibold text-foreground">Recent Searches</h2>
            </div>
            
            {loadingHistory ? (
              <p className="text-muted-foreground text-sm">Loading...</p>
            ) : searches.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                Your search history will appear here once you start searching.
              </p>
            ) : (
              <div className="space-y-3">
                {searches.map((search) => (
                  <Link
                    key={search.id}
                    to={`/search/${search.id}`}
                    className="flex items-center gap-4 p-3 rounded-xl hover:bg-muted/50 transition-colors group"
                  >
                    <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                      <TrendingDown className="w-5 h-5 text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-foreground line-clamp-1 group-hover:text-primary transition-colors">
                        {search.airbnb_title || "Vacation Rental"}
                      </p>
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Clock className="w-3 h-3" />
                        <span>{formatDate(search.created_at)}</span>
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                          search.status === "completed" 
                            ? "bg-green-500/10 text-green-600 dark:text-green-400"
                            : search.status === "error"
                            ? "bg-destructive/10 text-destructive"
                            : "bg-primary/10 text-primary"
                        }`}>
                          {search.status === "completed" ? "Done" : search.status === "error" ? "Failed" : "Pending"}
                        </span>
                      </div>
                    </div>
                    <ExternalLink className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
