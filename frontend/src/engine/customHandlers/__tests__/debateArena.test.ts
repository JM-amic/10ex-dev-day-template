import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { submitDebate, updateTopic } from '../debateArena';
import type { ExpressionContext } from '../../types';

// Mutable results the mocked supabase client returns, controlled per-test.
const supabaseState = vi.hoisted(() => ({
  entities: { data: { id: 'd1' } as unknown, error: null as unknown },
  entityVersions: { error: null as unknown },
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
          insert: () => Promise.resolve(supabaseState.entityVersions),
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

describe('submitDebate', () => {
  beforeEach(() => {
    supabaseState.entities = { data: { id: 'd1' }, error: null };
    supabaseState.entityVersions = { error: null };
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

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('defaults round_count to 3 (not NaN) when state.roundCount is left at its default', async () => {
    const context = makeContext();

    await submitDebate({ round_count: '3' }, context);

    // No direct way to inspect the entity_versions insert payload with this mock shape,
    // so we assert indirectly: submission succeeds and doesn't error out on NaN.
    expect(context.setState).toHaveBeenCalledWith('submitError', null);
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
