import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import Index from "./pages/Index";
import Auth from "./pages/Auth";
import Dashboard from "./pages/Dashboard";
import SearchResults from "./pages/SearchResults";
import Pricing from "./pages/Pricing";
import UnlockDeal from "./pages/UnlockDeal";
import NotFound from "./pages/NotFound";

// Admin pages
import AdminLogin from "./pages/AdminLogin";
import AdminLayout from "./components/admin/AdminLayout";
import HealthOverview from "./pages/admin/HealthOverview";
import Pipeline from "./pages/admin/Pipeline";
import Extractions from "./pages/admin/Extractions";
import Adapters from "./pages/admin/Adapters";
import BlockedPlatforms from "./pages/admin/BlockedPlatforms";
import Quotas from "./pages/admin/Quotas";
import AuditLogs from "./pages/admin/AuditLogs";
import NotifyMeUsers from "./pages/admin/NotifyMeUsers";
import PlatformCoverage from "./pages/admin/PlatformCoverage";
import SearchDebug from "./pages/admin/SearchDebug";
import AirbnbBaselineDiagnostic from "./pages/admin/AirbnbBaselineDiagnostic";
import PlatformReliability from "./pages/admin/PlatformReliability";
import ExtractionDiagnostics from "./pages/admin/ExtractionDiagnostics";
import AccessLayerTelemetry from "./pages/admin/AccessLayerTelemetry";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Index />} />
          <Route path="/auth" element={<Auth />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/search/:searchId" element={<SearchResults />} />
          <Route path="/pricing" element={<Pricing />} />
          <Route path="/unlock" element={<UnlockDeal />} />
          
          {/* Admin routes */}
          <Route path="/admin/login" element={<AdminLogin />} />
          <Route path="/admin" element={<AdminLayout />}>
            <Route index element={<HealthOverview />} />
            <Route path="coverage" element={<PlatformCoverage />} />
            <Route path="pipeline" element={<Pipeline />} />
            <Route path="extractions" element={<Extractions />} />
            <Route path="search-debug" element={<SearchDebug />} />
            <Route path="airbnb-diagnostic" element={<AirbnbBaselineDiagnostic />} />
            <Route path="reliability" element={<PlatformReliability />} />
            <Route path="extraction-diagnostics" element={<ExtractionDiagnostics />} />
            <Route path="access-layer" element={<AccessLayerTelemetry />} />
            <Route path="adapters" element={<Adapters />} />
            <Route path="blocked" element={<BlockedPlatforms />} />
            <Route path="quotas" element={<Quotas />} />
            <Route path="audit" element={<AuditLogs />} />
            <Route path="notify-me" element={<NotifyMeUsers />} />
          </Route>
          
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
