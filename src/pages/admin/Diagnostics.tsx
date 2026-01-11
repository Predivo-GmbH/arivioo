import { useSearchParams } from 'react-router-dom';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TestTube, FlaskConical } from 'lucide-react';

// Import existing page components as content
import AirbnbBaselineDiagnostic from './AirbnbBaselineDiagnostic';
import ExtractionTestHarness from './ExtractionTestHarness';

const TAB_CONFIG = [
  { value: 'airbnb', label: 'Airbnb Diagnostic', icon: TestTube },
  { value: 'extraction-test', label: 'Extraction Test', icon: FlaskConical },
] as const;

export default function Diagnostics() {
  const [searchParams, setSearchParams] = useSearchParams();
  const currentTab = searchParams.get('tab') || 'airbnb';

  const handleTabChange = (value: string) => {
    setSearchParams({ tab: value });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Diagnostics & Tools</h1>
        <p className="text-muted-foreground">Provider-specific diagnostics and extraction testing</p>
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

        <TabsContent value="airbnb" className="mt-6">
          <AirbnbBaselineDiagnostic />
        </TabsContent>

        <TabsContent value="extraction-test" className="mt-6">
          <ExtractionTestHarness />
        </TabsContent>
      </Tabs>
    </div>
  );
}
