import { useEffect } from 'react';
import { useNavigate, Outlet, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Activity,
  Database,
  Settings,
  ShieldOff,
  Gauge,
  FileText,
  LogOut,
  ChevronLeft,
  ChevronRight,
  User,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { useAdminAuth } from '@/hooks/useAdminAuth';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';
import { NavLink } from '@/components/NavLink';

const navItems = [
  { title: 'Health Overview', url: '/admin', icon: LayoutDashboard },
  { title: 'Platform Coverage', url: '/admin/coverage', icon: Gauge },
  { title: 'Pipeline Status', url: '/admin/pipeline', icon: Activity },
  { title: 'Extractions', url: '/admin/extractions', icon: Database },
  { title: 'Search Debug', url: '/admin/search-debug', icon: Activity },
  { title: 'Users & Notify Me', url: '/admin/notify-me', icon: User },
  { title: 'Platform Adapters', url: '/admin/adapters', icon: Settings },
  { title: 'Blocked Platforms', url: '/admin/blocked', icon: ShieldOff },
  { title: 'API Quotas', url: '/admin/quotas', icon: Gauge },
  { title: 'Audit Logs', url: '/admin/audit', icon: FileText },
];

function AdminSidebar() {
  const location = useLocation();
  const { logout, admin } = useAdminAuth();
  const navigate = useNavigate();
  const { state } = useSidebar();
  const collapsed = state === 'collapsed';

  const handleLogout = async () => {
    await logout();
    navigate('/admin/login');
  };

  return (
    <Sidebar className={cn("border-r transition-all duration-300", collapsed ? "w-16" : "w-64")}>
      <div className="flex items-center justify-between h-16 px-4 border-b">
        {!collapsed && (
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center">
              <LayoutDashboard className="w-4 h-4 text-primary-foreground" />
            </div>
            <span className="font-semibold text-lg">Admin</span>
          </div>
        )}
        <SidebarTrigger className={cn(collapsed && "mx-auto")}>
          {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
        </SidebarTrigger>
      </div>

      <SidebarContent className="flex-1">
        <SidebarGroup>
          <SidebarGroupLabel className={cn(collapsed && "sr-only")}>Dashboard</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton asChild>
                    <NavLink
                      to={item.url}
                      end={item.url === '/admin'}
                      className="flex items-center gap-3 px-3 py-2 rounded-lg transition-colors hover:bg-sidebar-accent"
                      activeClassName="bg-sidebar-accent text-primary font-medium"
                    >
                      <item.icon className="h-5 w-5 flex-shrink-0" />
                      {!collapsed && <span>{item.title}</span>}
                    </NavLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <div className="border-t p-4">
        {!collapsed && admin && (
          <div className="flex items-center gap-2 mb-3 px-2">
            <div className="w-8 h-8 bg-muted rounded-full flex items-center justify-center">
              <User className="w-4 h-4 text-muted-foreground" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{admin.fullName || admin.email}</p>
              <p className="text-xs text-muted-foreground capitalize">{admin.role.replace('_', ' ')}</p>
            </div>
          </div>
        )}
        <Button
          variant="ghost"
          className={cn("w-full justify-start gap-2", collapsed && "justify-center px-2")}
          onClick={handleLogout}
        >
          <LogOut className="h-4 w-4" />
          {!collapsed && <span>Logout</span>}
        </Button>
      </div>
    </Sidebar>
  );
}

export default function AdminLayout() {
  const { isAuthenticated, isLoading } = useAdminAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      navigate('/admin/login');
    }
  }, [isAuthenticated, isLoading, navigate]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return null;
  }

  return (
    <SidebarProvider>
      <div className="min-h-screen flex w-full bg-background">
        <AdminSidebar />
        <main className="flex-1 overflow-auto">
          <div className="p-6 lg:p-8">
            <Outlet />
          </div>
        </main>
      </div>
    </SidebarProvider>
  );
}
