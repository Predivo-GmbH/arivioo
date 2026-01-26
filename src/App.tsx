import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate, useSearchParams } from "react-router-dom";
import Index from "./pages/Index";
import Auth from "./pages/Auth";
import ResetPassword from "./pages/ResetPassword";
import Dashboard from "./pages/Dashboard";
import SearchResults from "./pages/SearchResults";
import Pricing from "./pages/Pricing";
import UnlockDeal from "./pages/UnlockDeal";
import NotFound from "./pages/NotFound";

// Admin pages
import AdminLogin from "./pages/AdminLogin";
import AdminLayout from "./components/admin/AdminLayout";
import HealthOverview from "./pages/admin/HealthOverview";

// New consolidated admin pages
import Platforms from "./pages/admin/Platforms";
import ExtractionsHub from "./pages/admin/ExtractionsHub";
import PipelineHub from "./pages/admin/PipelineHub";
import Diagnostics from "./pages/admin/Diagnostics";
import Settings from "./pages/admin/Settings";

const queryClient = new QueryClient();

// Redirect components for backwards compatibility
function RedirectWithTab({ to, tab }: { to: string; tab: string }) {
  return <Navigate to={`${to}?tab=${tab}`} replace />;
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Index />} />
          <Route path="/auth" element={<Auth />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/search/:searchId" element={<SearchResults />} />
          <Route path="/pricing" element={<Pricing />} />
          <Route path="/unlock" element={<UnlockDeal />} />
          
          {/* Admin routes */}
          <Route path="/admin/login" element={<AdminLogin />} />
          <Route path="/admin" element={<AdminLayout />}>
            {/* Dashboard (Health Overview) */}
            <Route index element={<HealthOverview />} />
            
            {/* Consolidated pages */}
            <Route path="platforms" element={<Platforms />} />
            <Route path="extractions" element={<ExtractionsHub />} />
            <Route path="pipeline" element={<PipelineHub />} />
            <Route path="diagnostics" element={<Diagnostics />} />
            <Route path="settings" element={<Settings />} />
            
            {/* Backwards compatibility redirects - Platforms */}
            <Route path="coverage" element={<RedirectWithTab to="/admin/platforms" tab="coverage" />} />
            <Route path="adapters" element={<RedirectWithTab to="/admin/platforms" tab="adapters" />} />
            <Route path="blocked" element={<RedirectWithTab to="/admin/platforms" tab="blocked" />} />
            
            {/* Backwards compatibility redirects - Extractions */}
            <Route path="reliability" element={<RedirectWithTab to="/admin/extractions" tab="reliability" />} />
            <Route path="extraction-diagnostics" element={<RedirectWithTab to="/admin/extractions" tab="diagnostics" />} />
            
            {/* Backwards compatibility redirects - Pipeline */}
            <Route path="access-layer" element={<RedirectWithTab to="/admin/pipeline" tab="access-layer" />} />
            
            {/* Backwards compatibility redirects - Diagnostics */}
            <Route path="airbnb-diagnostic" element={<RedirectWithTab to="/admin/diagnostics" tab="airbnb" />} />
            <Route path="extraction-test" element={<RedirectWithTab to="/admin/diagnostics" tab="extraction-test" />} />
            
            {/* Backwards compatibility redirects - Settings */}
            <Route path="notify-me" element={<RedirectWithTab to="/admin/settings" tab="users" />} />
            <Route path="quotas" element={<RedirectWithTab to="/admin/settings" tab="quotas" />} />
            <Route path="audit" element={<RedirectWithTab to="/admin/settings" tab="audit" />} />
            
            {/* Deprecated: Search Debug - redirect to Extraction Diagnostics */}
            <Route path="search-debug" element={<RedirectWithTab to="/admin/extractions" tab="diagnostics" />} />
          </Route>
          
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
