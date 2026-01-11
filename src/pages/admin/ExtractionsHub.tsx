import { useSearchParams } from 'react-router-dom';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Database, ShieldCheck, Microscope } from 'lucide-react';

// Import existing page components as content
import Extractions from './Extractions';
import PlatformReliability from './PlatformReliability';
import ExtractionDiagnostics from './ExtractionDiagnostics';

const TAB_CONFIG = [
  { value: 'log', label: 'Extraction Log', icon: Database },
  { value: 'reliability', label: 'Reliability', icon: ShieldCheck },
  { value: 'diagnostics', label: 'Diagnostics', icon: Microscope },
] as const;

export default function ExtractionsHub() {
  const [searchParams, setSearchParams] = useSearchParams();
  const currentTab = searchParams.get('tab') || 'log';

  const handleTabChange = (value: string) => {
    setSearchParams({ tab: value });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Extractions</h1>
        <p className="text-muted-foreground">Monitor extraction logs, reliability metrics, and diagnostics</p>
      </div>

      <Tabs value={currentTab} onValueChange={handleTabChange}>
        <TabsList>
          {TAB_CONFIG.map(({ value, label, icon: Icon }) => (
            <TabsTrigger key={value} value={value} className="gap-2">
              <Icon className="h-4 w-4" />
              {label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="log" className="mt-6">
          <Extractions />
        </TabsContent>

        <TabsContent value="reliability" className="mt-6">
          <PlatformReliability />
        </TabsContent>

        <TabsContent value="diagnostics" className="mt-6">
          <ExtractionDiagnostics />
        </TabsContent>
      </Tabs>
    </div>
  );
}
