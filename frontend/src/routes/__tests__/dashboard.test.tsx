import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import type { AnchorHTMLAttributes, ComponentType, ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import confetti from 'canvas-confetti';
import { UIEngine } from '@/engine';
import { triggerConfetti } from '@/engine/customHandlers/confetti';
import { initializeRegistry } from '@/registry';
import dashboardPage from '@/pages/dashboard.json';
import type { PageDefinition } from '@/engine/types';
import { Route as IndexRoute } from '../index';

// No real router in this test; UIEngine calls useNavigate() unconditionally
// even though dashboard.json has no links that need it.
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => vi.fn(),
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) =>
    createElement('a', { href: to, ...rest }, children),
}));

// dashboard.json has no dataSources, so this is never actually queried, but
// the module is imported transitively by the engine and must not throw.
const { supabaseFrom, supabaseRpc } = vi.hoisted(() => ({
  supabaseFrom: vi.fn(() => ({})),
  supabaseRpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
}));
vi.mock('@/data/supabase', () => ({
  supabase: { from: supabaseFrom, rpc: supabaseRpc },
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
  supabaseFrom.mockClear();
  supabaseRpc.mockClear();
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

  it('has a discoverable accessible name from its own visible text (no aria-label pass-through needed)', () => {
    renderDashboard();

    const button = screen.getByRole('button', { name: '🎉 Celebrate' });
    expect(button).toBeVisible();
    expect(button).toHaveAccessibleName('🎉 Celebrate');
  });

  it('is keyboard-activatable via Enter, same as any other EngineButton', async () => {
    renderDashboard();
    const user = userEvent.setup();

    await user.tab();
    expect(screen.getByRole('button', { name: '🎉 Celebrate' })).toHaveFocus();

    await user.keyboard('{Enter}');

    expect(confettiMock).toHaveBeenCalledTimes(1);
  });

  it('is keyboard-activatable via Space, same as any other EngineButton', async () => {
    renderDashboard();
    const user = userEvent.setup();

    await user.tab();
    expect(screen.getByRole('button', { name: '🎉 Celebrate' })).toHaveFocus();

    await user.keyboard(' ');

    expect(confettiMock).toHaveBeenCalledTimes(1);
  });

  it('does not error and triggers no Supabase/network calls on click', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    renderDashboard();

    await userEvent.click(screen.getByRole('button', { name: '🎉 Celebrate' }));

    expect(errorSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(supabaseFrom).not.toHaveBeenCalled();
    expect(supabaseRpc).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('does not stack or throw on repeated rapid clicks; confetti fires once per click', async () => {
    renderDashboard();
    const button = screen.getByRole('button', { name: '🎉 Celebrate' });

    await userEvent.click(button);
    await userEvent.click(button);
    await userEvent.click(button);

    expect(confettiMock).toHaveBeenCalledTimes(3);
    expect(screen.getAllByRole('button', { name: '🎉 Celebrate' })).toHaveLength(1);
  });
});

describe('Dashboard route registration - real index.tsx export', () => {
  // Renders the ACTUAL component exported by frontend/src/routes/index.tsx via
  // Route.options.component, rather than a hand-rebuilt <UIEngine customHandlers={...}>.
  // This is the only test that exercises the real customHandlers registration, so if
  // someone drops `customHandlers={{ triggerConfetti }}` (or the import) from index.tsx,
  // the click hits handleCustom -> "handler not found" -> no confetti, and this fails.
  function renderRealIndexRoute() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const RouteComponent = IndexRoute.options.component as ComponentType;
    return render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(RouteComponent)
      )
    );
  }

  it('fires confetti when the Celebrate button is clicked, using the real Route.options.component', async () => {
    renderRealIndexRoute();

    await userEvent.click(screen.getByRole('button', { name: '🎉 Celebrate' }));

    expect(confettiMock).toHaveBeenCalledTimes(1);
  });
});
