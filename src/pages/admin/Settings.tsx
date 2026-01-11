import { useSearchParams } from 'react-router-dom';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { User, Gauge, FileText } from 'lucide-react';

// Import existing page components as content
import NotifyMeUsers from './NotifyMeUsers';
import Quotas from './Quotas';
import AuditLogs from './AuditLogs';

const TAB_CONFIG = [
  { value: 'users', label: 'Users & Notify Me', icon: User },
  { value: 'quotas', label: 'API Quotas', icon: Gauge },
  { value: 'audit', label: 'Audit Logs', icon: FileText },
] as const;

export default function Settings() {
  const [searchParams, setSearchParams] = useSearchParams();
  const currentTab = searchParams.get('tab') || 'users';

  const handleTabChange = (value: string) => {
    setSearchParams({ tab: value });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Settings & Governance</h1>
        <p className="text-muted-foreground">Manage users, quotas, and audit logs</p>
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

        <TabsContent value="users" className="mt-6">
          <NotifyMeUsers />
        </TabsContent>

        <TabsContent value="quotas" className="mt-6">
          <Quotas />
        </TabsContent>

        <TabsContent value="audit" className="mt-6">
          <AuditLogs />
        </TabsContent>
      </Tabs>
    </div>
  );
}
