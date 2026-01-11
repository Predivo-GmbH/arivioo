import { useSearchParams } from 'react-router-dom';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Activity, ShieldOff } from 'lucide-react';

// Import existing page components as content
import Pipeline from './Pipeline';
import AccessLayerTelemetry from './AccessLayerTelemetry';

const TAB_CONFIG = [
  { value: 'status', label: 'Pipeline Status', icon: Activity },
  { value: 'access-layer', label: 'Access Layer', icon: ShieldOff },
] as const;

export default function PipelineHub() {
  const [searchParams, setSearchParams] = useSearchParams();
  const currentTab = searchParams.get('tab') || 'status';

  const handleTabChange = (value: string) => {
    setSearchParams({ tab: value });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Pipeline</h1>
        <p className="text-muted-foreground">Monitor pipeline status and access layer telemetry</p>
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

        <TabsContent value="status" className="mt-6">
          <Pipeline />
        </TabsContent>

        <TabsContent value="access-layer" className="mt-6">
          <AccessLayerTelemetry />
        </TabsContent>
      </Tabs>
    </div>
  );
}
