/**
 * Root Route - App Shell
 */

import { createRootRoute, Outlet, Link, useLocation } from '@tanstack/react-router';
import { TanStackRouterDevtools } from '@tanstack/router-devtools';
import { cn } from '@/lib/utils';
import { Home, ListChecks } from 'lucide-react';

export const Route = createRootRoute({
  component: RootComponent,
});

function RootComponent() {
  return (
    <div className="min-h-screen bg-background">
      <Header />
      <div className="flex">
        <Sidebar />
        <main className="flex-1 p-6">
          <Outlet />
        </main>
      </div>
      {import.meta.env.DEV && (
        <TanStackRouterDevtools position="bottom-right" />
      )}
    </div>
  );
}

function Header() {
  return (
    <header className="h-16 border-b bg-card flex items-center px-6">
      <h1 className="text-xl font-semibold">JSON UI Engine</h1>
    </header>
  );
}

function Sidebar() {
  const location = useLocation();

  return (
    <aside className="w-64 border-r bg-card min-h-[calc(100vh-4rem)]">
      <nav className="p-4 space-y-2">
        <Link
          to="/"
          className={cn(
            'flex items-center gap-3 px-3 py-2 rounded-lg transition-colors',
            location.pathname === '/'
              ? 'bg-primary text-primary-foreground'
              : 'hover:bg-muted'
          )}
        >
          <Home className="h-4 w-4" />
          Dashboard
        </Link>

        <Link
          to="/meeting-notes"
          className={cn(
            'flex items-center gap-3 px-3 py-2 rounded-lg transition-colors',
            location.pathname === '/meeting-notes'
              ? 'bg-primary text-primary-foreground'
              : 'hover:bg-muted'
          )}
        >
          <ListChecks className="h-4 w-4" />
          Meeting Notes
        </Link>
      </nav>
    </aside>
  );
}
