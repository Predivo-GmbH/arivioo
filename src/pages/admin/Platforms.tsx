import { useSearchParams } from 'react-router-dom';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Gauge, Settings, ShieldOff, Globe } from 'lucide-react';

// Import existing page components as content
import PlatformCoverage from './PlatformCoverage';
import Adapters from './Adapters';
import BlockedPlatforms from './BlockedPlatforms';
import CoverageVariants from './CoverageVariants';

const TAB_CONFIG = [
  { value: 'coverage', label: 'Coverage', icon: Gauge },
  { value: 'variants', label: 'Variants', icon: Globe },
  { value: 'adapters', label: 'Adapters', icon: Settings },
  { value: 'blocked', label: 'Blocked', icon: ShieldOff },
] as const;

export default function Platforms() {
  const [searchParams, setSearchParams] = useSearchParams();
  const currentTab = searchParams.get('tab') || 'coverage';

  const handleTabChange = (value: string) => {
    setSearchParams({ tab: value });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Platforms</h1>
        <p className="text-muted-foreground">Manage platform coverage, adapters, and blocked platforms</p>
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

        <TabsContent value="coverage" className="mt-6">
          <PlatformCoverage />
        </TabsContent>

        <TabsContent value="variants" className="mt-6">
          <CoverageVariants />
        </TabsContent>

        <TabsContent value="adapters" className="mt-6">
          <Adapters />
        </TabsContent>

        <TabsContent value="blocked" className="mt-6">
          <BlockedPlatforms />
        </TabsContent>
      </Tabs>
    </div>
  );
}
