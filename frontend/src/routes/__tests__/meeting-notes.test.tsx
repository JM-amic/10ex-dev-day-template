import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { UIEngine } from '@/engine';
import { submitMeetingArtifact } from '@/engine/customHandlers/meetingNotes';
import { initializeRegistry } from '@/registry';
import meetingNotesPage from '@/pages/meeting-notes.json';
import type { PageDefinition } from '@/engine/types';

// No real router in this test; UIEngine calls useNavigate() unconditionally.
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => vi.fn(),
}));

// Per-test query results keyed by table. The chainable proxy below resolves to
// whichever result matches the `.from(table)` call.
const db = vi.hoisted(() => ({
  entities: { data: null as unknown, error: null as unknown },
  relationships_v2: { data: [] as unknown, error: null as unknown },
}));

function resultFor(table: string): { data: unknown; error: unknown } {
  if (table === 'entities') return db.entities;
  if (table === 'relationships_v2') return db.relationships_v2;
  // entity_versions insert (submit path) and anything else.
  return { data: null, error: null };
}

function makeBuilder(result: { data: unknown; error: unknown }): unknown {
  const builder: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'single') return () => Promise.resolve(result);
        if (prop === 'then')
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve(result).then(res, rej);
        if (prop === 'catch')
          return (rej: (e: unknown) => unknown) => Promise.resolve(result).catch(rej);
        if (prop === 'finally')
          return (cb: () => void) => Promise.resolve(result).finally(cb);
        return () => builder;
      },
    }
  );
  return builder;
}

vi.mock('@/data/supabase', () => ({
  supabase: {
    from: (table: string) => makeBuilder(resultFor(table)),
    rpc: () => Promise.resolve({ data: null, error: null }),
  },
}));

function renderPage(initialState: Record<string, unknown>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(UIEngine, {
        page: meetingNotesPage as PageDefinition,
        customHandlers: { submitMeetingArtifact },
        initialState,
      })
    )
  );
}

function doneEntity(rawText = 'my meeting notes') {
  return {
    id: 'e1',
    entity_versions: [{ data: { processing_status: 'done', raw_text: rawText } }],
  };
}

beforeAll(() => {
  initializeRegistry();
});

beforeEach(() => {
  db.entities = { data: null, error: null };
  db.relationships_v2 = { data: [], error: null };
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, status: 202 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Meeting Notes page - integration', () => {
  it('renders the form with the submit button disabled until text is entered', async () => {
    renderPage({ submittedEntityId: null });

    const submit = screen.getByRole('button', { name: 'Extract Action Items' });
    expect(submit).toBeDisabled();

    const textarea = screen.getByRole('textbox');
    await userEvent.type(textarea, 'Discussed the Q3 roadmap.');

    expect(submit).toBeEnabled();
  });

  it('disables the submit button while a submission is in flight, to prevent double-submit', async () => {
    let resolveEntityInsert: (v: unknown) => void = () => {};
    const supabaseMod = await import('@/data/supabase');
    const originalFrom = supabaseMod.supabase.from.bind(supabaseMod.supabase);
    vi.spyOn(supabaseMod.supabase, 'from').mockImplementation(((table: string) => {
      if (table === 'entities') {
        return {
          insert: () => ({
            select: () => ({
              single: () =>
                new Promise((resolve) => {
                  resolveEntityInsert = resolve;
                }),
            }),
          }),
        };
      }
      return originalFrom(table);
    }) as typeof supabaseMod.supabase.from);

    renderPage({ submittedEntityId: null });

    const submit = screen.getByRole('button', { name: 'Extract Action Items' });
    await userEvent.type(screen.getByRole('textbox'), 'Some meeting notes');
    await userEvent.click(submit);

    await waitFor(() => expect(submit).toBeDisabled());

    resolveEntityInsert({ data: { id: 'e1' }, error: null });
  });

  it('submitting shows a loading state while the note is still processing', async () => {
    db.entities = {
      data: {
        id: 'e1',
        entity_versions: [
          { data: { processing_status: 'processing', raw_text: 'notes' } },
        ],
      },
      error: null,
    };
    db.relationships_v2 = { data: [], error: null };

    const { container } = renderPage({ submittedEntityId: null });

    await userEvent.type(screen.getByRole('textbox'), 'Some meeting notes');
    await userEvent.click(
      screen.getByRole('button', { name: 'Extract Action Items' })
    );

    // Trigger fired and a skeleton placeholder is shown while processing.
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(container.querySelector('.animate-pulse')).toBeTruthy();
    });

    expect(screen.queryByText('No action items found')).not.toBeInTheDocument();
  });

  it('renders extracted action items when processing is done', async () => {
    db.entities = { data: doneEntity(), error: null };
    db.relationships_v2 = {
      data: [
        {
          child_id: 'c1',
          entities: {
            entity_versions: [
              {
                data: {
                  description: 'Send the roadmap deck',
                  owner: 'Alice',
                  due_date: '2026-07-14',
                },
              },
            ],
          },
        },
        {
          child_id: 'c2',
          entities: {
            entity_versions: [{ data: { description: 'Book the venue' } }],
          },
        },
      ],
      error: null,
    };

    renderPage({ submittedEntityId: 'e1' });

    await waitFor(() => {
      expect(screen.getByText('Send the roadmap deck')).toBeInTheDocument();
    });
    expect(screen.getByText('Book the venue')).toBeInTheDocument();

    // First item has owner + date, second falls back to placeholders.
    expect(screen.getByText('Alice · 2026-07-14')).toBeInTheDocument();
    expect(screen.getByText('unassigned · no date')).toBeInTheDocument();
  });

  it('shows the empty-state alert when done with zero action items', async () => {
    db.entities = { data: doneEntity(), error: null };
    db.relationships_v2 = { data: [], error: null };

    renderPage({ submittedEntityId: 'e1' });

    await waitFor(() => {
      expect(screen.getByText('No action items found')).toBeInTheDocument();
    });
  });

  it('shows a destructive alert and retry button when extraction errors', async () => {
    db.entities = {
      data: {
        id: 'e1',
        entity_versions: [
          {
            data: {
              processing_status: 'error',
              error_message: 'The model timed out.',
              raw_text: 'notes',
            },
          },
        ],
      },
      error: null,
    };
    db.relationships_v2 = { data: [], error: null };

    renderPage({ submittedEntityId: 'e1' });

    await waitFor(() => {
      expect(screen.getByText('The model timed out.')).toBeInTheDocument();
    });
    expect(screen.getByText('Extraction failed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
