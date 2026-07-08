import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { submitDebate, retryDebate, updateTopic } from '../debateArena';
import type { ExpressionContext } from '../../types';

// Mutable results the mocked supabase client returns, controlled per-test. `entityVersionInserts`
// captures every payload passed to `entity_versions.insert(...)` so tests can assert on the real
// submitted data, not just "fetch was called".
const supabaseState = vi.hoisted(() => ({
  entities: { data: { id: 'd1' } as unknown, error: null as unknown },
  entityVersions: { error: null as unknown },
  entityVersionInserts: [] as unknown[],
}));

vi.mock('@/data/supabase', () => ({
  supabase: {
    from: (table: string) => {
      if (table === 'entities') {
        return {
          insert: () => ({
            select: () => ({
              single: () => Promise.resolve(supabaseState.entities),
            }),
          }),
        };
      }
      if (table === 'entity_versions') {
        return {
          insert: (payload: unknown) => {
            supabaseState.entityVersionInserts.push(payload);
            return Promise.resolve(supabaseState.entityVersions);
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  },
}));

function persona(key: string, label: string, flavor: 'classical' | 'unusual' | 'judge' = 'classical') {
  return {
    entity_versions: [
      { data: { key, label, emoji: '🙂', flavor, personality: 'p', stance_prompt: 's' } },
    ],
  };
}

const PERSONAS = [
  persona('skeptic', 'The Skeptic'),
  persona('wizard', 'The Sage Wizard', 'unusual'),
  persona('pragmatist', 'The Pragmatist'),
];
const JUDGE = persona('judge', 'The Arbiter Owl', 'judge');

function makeContext(overrides: Partial<ExpressionContext> = {}): ExpressionContext {
  return {
    state: {
      topic: 'Should we ship on Friday?',
      selectedPersonaKeys: ['skeptic', 'wizard', 'pragmatist'],
    },
    data: {
      personas: PERSONAS,
      judgePersona: JUDGE,
    },
    params: {},
    setState: vi.fn(),
    ...overrides,
  };
}

function lastInsertedData(): Record<string, unknown> {
  const inserts = supabaseState.entityVersionInserts as { data: Record<string, unknown> }[];
  return inserts[inserts.length - 1].data;
}

describe('submitDebate', () => {
  beforeEach(() => {
    supabaseState.entities = { data: { id: 'd1' }, error: null };
    supabaseState.entityVersions = { error: null };
    supabaseState.entityVersionInserts = [];
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, status: 202 })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('inserts entity + version, triggers the workflow, and reports success', async () => {
    const replaceState = vi.spyOn(window.history, 'replaceState');
    const context = makeContext();

    await submitDebate({ round_count: '3' }, context);

    expect(context.setState).toHaveBeenCalledWith('submitError', null);
    expect(context.setState).toHaveBeenCalledWith('submittedDebateId', 'd1');

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toContain('/workflows/start-debate');
    expect(init).toEqual(
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ entity_id: 'd1' }),
      })
    );

    expect(replaceState).toHaveBeenCalledTimes(1);
    const replacedUrl = String(replaceState.mock.calls[0][2]);
    expect(replacedUrl).toContain('entityId=d1');
  });

  it('builds selected_personas and judge_persona correctly from context.data', async () => {
    const context = makeContext();

    await submitDebate({ round_count: '3' }, context);

    const inserted = lastInsertedData();
    expect(inserted.topic).toBe('Should we ship on Friday?');
    expect((inserted.selected_personas as { key: string }[]).map((p) => p.key)).toEqual([
      'skeptic',
      'wizard',
      'pragmatist',
    ]);
    expect((inserted.judge_persona as { key: string }).key).toBe('judge');
    expect(inserted.processing_status).toBe('pending');
    expect(inserted.current_round).toBe(0);
  });

  it('excludes unselected personas from selected_personas even when present in context.data.personas', async () => {
    const context = makeContext({
      state: { topic: 'Topic', selectedPersonaKeys: ['skeptic'] },
    });

    await submitDebate({ round_count: '2' }, context);

    const inserted = lastInsertedData();
    expect((inserted.selected_personas as { key: string }[]).map((p) => p.key)).toEqual(['skeptic']);
  });

  it('defaults round_count to 3 (not NaN) when state.roundCount is left at its default', async () => {
    const context = makeContext();

    await submitDebate({ round_count: '3' }, context);

    expect(context.setState).toHaveBeenCalledWith('submitError', null);
    expect(lastInsertedData().round_count).toBe(3);
  });

  it('converts round_count to a number regardless of which value is submitted', async () => {
    const context = makeContext();

    await submitDebate({ round_count: '4' }, context);

    expect(lastInsertedData().round_count).toBe(4);
    expect(Number.isNaN(lastInsertedData().round_count)).toBe(false);
  });

  it('reports an error and skips the trigger when the entities insert fails', async () => {
    supabaseState.entities = { data: null, error: new Error('entities insert failed') };
    const context = makeContext();

    await submitDebate({ round_count: '3' }, context);

    expect(context.setState).toHaveBeenCalledWith('submittedDebateId', null);
    expect(context.setState).toHaveBeenCalledWith(
      'submitError',
      expect.stringContaining('entities insert failed')
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports an error and skips the trigger when the version insert fails', async () => {
    supabaseState.entityVersions = { error: new Error('version insert failed') };
    const context = makeContext();

    await submitDebate({ round_count: '3' }, context);

    expect(context.setState).toHaveBeenCalledWith('submittedDebateId', null);
    expect(context.setState).toHaveBeenCalledWith(
      'submitError',
      expect.stringContaining('version insert failed')
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports an error mentioning the status when the trigger endpoint fails', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 500 })));
    const context = makeContext();

    await submitDebate({ round_count: '3' }, context);

    expect(context.setState).toHaveBeenCalledWith('submittedDebateId', null);
    expect(context.setState).toHaveBeenCalledWith('submitError', expect.stringContaining('500'));
  });

  it('reports an error when the judge persona is missing from context.data', async () => {
    const context = makeContext({ data: { personas: PERSONAS, judgePersona: undefined } });

    await submitDebate({ round_count: '3' }, context);

    expect(context.setState).toHaveBeenCalledWith('submittedDebateId', null);
    expect(context.setState).toHaveBeenCalledWith(
      'submitError',
      expect.stringContaining('Judge persona not found')
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('toggles isSubmitting on around a successful submit', async () => {
    const context = makeContext();

    await submitDebate({ round_count: '3' }, context);

    const calls = (context.setState as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const onIdx = calls.findIndex(([key, val]) => key === 'isSubmitting' && val === true);
    const offIdx = calls.findIndex(([key, val]) => key === 'isSubmitting' && val === false);
    expect(onIdx).toBeGreaterThanOrEqual(0);
    expect(offIdx).toBeGreaterThan(onIdx);
  });

  it('ignores a second submission fired before the first one has left the synchronous guard', async () => {
    const context = makeContext();

    const first = submitDebate({ round_count: '3' }, context);
    const second = submitDebate({ round_count: '3' }, context);
    await Promise.all([first, second]);

    expect(fetch).toHaveBeenCalledTimes(1);
    const setStateMock = context.setState as unknown as ReturnType<typeof vi.fn>;
    const submittingOnCalls = setStateMock.mock.calls.filter(
      ([key, val]) => key === 'isSubmitting' && val === true
    );
    expect(submittingOnCalls).toHaveLength(1);
  });

  it('allows a fresh submission once the prior one has finished', async () => {
    const context = makeContext();

    await submitDebate({ round_count: '3' }, context);
    await submitDebate({ round_count: '3' }, context);

    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('retryDebate', () => {
  beforeEach(() => {
    supabaseState.entities = { data: { id: 'd2' }, error: null };
    supabaseState.entityVersions = { error: null };
    supabaseState.entityVersionInserts = [];
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, status: 202 })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const persistedDebate = {
    entity_versions: [
      {
        data: {
          topic: 'the original topic',
          round_count: 2,
          selected_personas: [persona('skeptic', 'The Skeptic').entity_versions[0].data],
          judge_persona: JUDGE.entity_versions[0].data,
          processing_status: 'error',
          error_message: 'boom',
          current_round: 1,
        },
      },
    ],
  };

  it('resubmits the exact topic/round_count/selected_personas/judge_persona persisted on the errored debate, ignoring stale page state', async () => {
    // Simulates a reload: submittedDebateId is restored from the URL, but topic/
    // selectedPersonaKeys are back to their initial empty client-only state.
    const context = makeContext({
      state: { topic: '', selectedPersonaKeys: [] },
      data: { debate: persistedDebate },
    });

    await retryDebate(undefined, context);

    const inserted = lastInsertedData();
    expect(inserted.topic).toBe('the original topic');
    expect(inserted.round_count).toBe(2);
    expect((inserted.selected_personas as { key: string }[]).map((p) => p.key)).toEqual(['skeptic']);
    expect((inserted.judge_persona as { key: string }).key).toBe('judge');
    expect(context.setState).toHaveBeenCalledWith('submittedDebateId', 'd2');
  });

  it('reports an error and does not insert anything when the original debate data is missing', async () => {
    const context = makeContext({ data: { debate: undefined } });

    await retryDebate(undefined, context);

    expect(context.setState).toHaveBeenCalledWith('submittedDebateId', null);
    expect(context.setState).toHaveBeenCalledWith(
      'submitError',
      expect.stringContaining('original debate data not found')
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shares the double-submit guard with submitDebate', async () => {
    const context = makeContext({ data: { debate: persistedDebate } });

    const first = retryDebate(undefined, context);
    const second = retryDebate(undefined, context);
    await Promise.all([first, second]);

    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('updateTopic', () => {
  it('flags whitespace-only text as blank', () => {
    const context = makeContext();

    updateTopic('   \n\t  ', context);

    expect(context.setState).toHaveBeenCalledWith('topic', '   \n\t  ');
    expect(context.setState).toHaveBeenCalledWith('topicIsBlank', true);
  });

  it('flags empty text as blank', () => {
    const context = makeContext();

    updateTopic('', context);

    expect(context.setState).toHaveBeenCalledWith('topicIsBlank', true);
  });

  it('does not flag real text as blank, even with surrounding whitespace', () => {
    const context = makeContext();

    updateTopic('  Should we ship on Friday?  ', context);

    expect(context.setState).toHaveBeenCalledWith('topic', '  Should we ship on Friday?  ');
    expect(context.setState).toHaveBeenCalledWith('topicIsBlank', false);
  });
});
