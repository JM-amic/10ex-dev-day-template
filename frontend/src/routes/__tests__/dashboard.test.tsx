import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import confetti from 'canvas-confetti';
import { UIEngine } from '@/engine';
import { triggerConfetti } from '@/engine/customHandlers/confetti';
import { initializeRegistry } from '@/registry';
import dashboardPage from '@/pages/dashboard.json';
import type { PageDefinition } from '@/engine/types';

// No real router in this test; UIEngine calls useNavigate() unconditionally, and
// dashboard.json renders a <Link to="/entities/portfolio"> that would otherwise
// need a full RouterProvider context just to sit there unused.
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => vi.fn(),
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) =>
    createElement('a', { href: to, ...rest }, children),
}));

// dashboard.json has no dataSources, so this is never actually queried, but
// the module is imported transitively by the engine and must not throw.
vi.mock('@/data/supabase', () => ({
  supabase: { from: () => ({}), rpc: () => Promise.resolve({ data: null, error: null }) },
}));

vi.mock('canvas-confetti', () => ({ default: vi.fn() }));

const confettiMock = confetti as unknown as ReturnType<typeof vi.fn>;

function renderDashboard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(UIEngine, {
        page: dashboardPage as PageDefinition,
        // Same registration shape as the real route: frontend/src/routes/index.tsx
        customHandlers: { triggerConfetti },
      })
    )
  );
}

beforeAll(() => {
  initializeRegistry();
});

beforeEach(() => {
  confettiMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Dashboard page - Celebrate button', () => {
  it('fires confetti when the Celebrate button is clicked', async () => {
    renderDashboard();

    await userEvent.click(screen.getByRole('button', { name: '🎉 Celebrate' }));

    expect(confettiMock).toHaveBeenCalledTimes(1);
  });

  it('does not fire confetti before the button is clicked', () => {
    renderDashboard();

    expect(confettiMock).not.toHaveBeenCalled();
  });
});
