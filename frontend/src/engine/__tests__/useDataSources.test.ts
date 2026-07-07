import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider, useQueries } from '@tanstack/react-query';
import { useDataSources } from '../useDataSources';
import { createExpressionContext } from '../ExpressionEvaluator';
import type { DataSourceDefinition } from '../types';

// Keep react-query real except for useQueries, which we replace so we can
// capture the query configs the hook builds without executing any of them.
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQueries: vi.fn(() => []),
  };
});

// The supabase client / query executor must never be reached in this test.
vi.mock('@/data/supabase', () => ({ supabase: {} }));
vi.mock('@/data/queryBuilder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/queryBuilder')>();
  return {
    ...actual,
    executeSupabaseQuery: vi.fn(),
  };
});

function renderDataSources(dataSources: Record<string, DataSourceDefinition>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);

  const context = createExpressionContext();
  renderHook(() => useDataSources(dataSources, context), { wrapper });

  // Grab the `queries` array passed into the (mocked) useQueries.
  const call = vi.mocked(useQueries).mock.calls.at(-1);
  if (!call) throw new Error('useQueries was not called');
  return call[0].queries as Array<{ refetchInterval?: unknown }>;
}

describe('useDataSources - refetchInterval config', () => {
  beforeEach(() => {
    vi.mocked(useQueries).mockClear();
  });

  it('passes a plain numeric refetchInterval straight through', () => {
    const queries = renderDataSources({
      simple: {
        type: 'supabase',
        table: 'entities',
        refetchInterval: 2000,
      },
    });

    expect(queries[0].refetchInterval).toBe(2000);
  });

  it('leaves refetchInterval undefined when the source has none', () => {
    const queries = renderDataSources({
      noPoll: {
        type: 'supabase',
        table: 'entities',
      },
    });

    expect(queries[0].refetchInterval).toBeUndefined();
  });

  it('produces a stop-when-matched function when pollUntilPath/Values are set', () => {
    const queries = renderDataSources({
      polled: {
        type: 'supabase',
        table: 'entities',
        refetchInterval: 2000,
        pollUntilPath: 'entity_versions[0].data.processing_status',
        pollUntilValues: ['done', 'error'],
      },
    });

    const refetchInterval = queries[0].refetchInterval;
    expect(typeof refetchInterval).toBe('function');

    const fn = refetchInterval as (query: {
      state: { data: unknown };
    }) => number | false;

    // A terminal status stops polling.
    const doneQuery = {
      state: { data: { entity_versions: [{ data: { processing_status: 'done' } }] } },
    };
    expect(fn(doneQuery)).toBe(false);

    const errorQuery = {
      state: { data: { entity_versions: [{ data: { processing_status: 'error' } }] } },
    };
    expect(fn(errorQuery)).toBe(false);

    // A non-terminal status keeps polling at the configured interval.
    const processingQuery = {
      state: { data: { entity_versions: [{ data: { processing_status: 'processing' } }] } },
    };
    expect(fn(processingQuery)).toBe(2000);

    // Missing/undefined data also keeps polling.
    expect(fn({ state: { data: undefined } })).toBe(2000);
  });
});
