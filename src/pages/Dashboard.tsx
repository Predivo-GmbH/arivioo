import { useState, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Search, LogOut, History, Sparkles } from "lucide-react";
import type { User } from "@supabase/supabase-js";

export default function Dashboard() {
  const [user, setUser] = useState<User | null>(null);
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
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

          <div className="bg-card rounded-2xl border border-border p-8">
            <div className="flex items-center gap-3 mb-4">
              <History className="w-5 h-5 text-muted-foreground" />
              <h2 className="font-semibold text-foreground">Recent Searches</h2>
            </div>
            <p className="text-muted-foreground text-sm">
              Your search history will appear here once you start searching.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
