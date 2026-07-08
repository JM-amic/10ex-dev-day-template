import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { submitMeetingArtifact, updatePastedText } from '../meetingNotes';
import type { ExpressionContext } from '../../types';

// Mutable results the mocked supabase client returns, controlled per-test.
const supabaseState = vi.hoisted(() => ({
  entities: { data: { id: 'e1' } as unknown, error: null as unknown },
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

function makeContext(): ExpressionContext {
  return {
    state: {},
    data: {},
    params: {},
    setState: vi.fn(),
  };
}

describe('submitMeetingArtifact', () => {
  beforeEach(() => {
    supabaseState.entities = { data: { id: 'e1' }, error: null };
    supabaseState.entityVersions = { error: null };
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, status: 202 })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const payload = { input_format: 'text' as const, raw_text: 'hello notes' };

  it('inserts entity + version, triggers the workflow, and reports success', async () => {
    const replaceState = vi.spyOn(window.history, 'replaceState');
    const context = makeContext();

    await submitMeetingArtifact(payload, context);

    expect(context.setState).toHaveBeenCalledWith('submitError', null);
    expect(context.setState).toHaveBeenCalledWith('submittedEntityId', 'e1');

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toContain('/workflows/extract-action-items');
    expect(init).toEqual(
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ entity_id: 'e1' }),
      })
    );

    expect(replaceState).toHaveBeenCalledTimes(1);
    const replacedUrl = String(replaceState.mock.calls[0][2]);
    expect(replacedUrl).toContain('entityId=e1');
  });

  it('reports an error and skips the trigger when the entities insert fails', async () => {
    supabaseState.entities = { data: null, error: new Error('entities insert failed') };
    const context = makeContext();

    await submitMeetingArtifact(payload, context);

    expect(context.setState).toHaveBeenCalledWith('submittedEntityId', null);
    expect(context.setState).toHaveBeenCalledWith(
      'submitError',
      expect.stringContaining('entities insert failed')
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports an error and skips the trigger when the version insert fails', async () => {
    supabaseState.entityVersions = { error: new Error('version insert failed') };
    const context = makeContext();

    await submitMeetingArtifact(payload, context);

    expect(context.setState).toHaveBeenCalledWith('submittedEntityId', null);
    expect(context.setState).toHaveBeenCalledWith(
      'submitError',
      expect.stringContaining('version insert failed')
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports an error mentioning the status when the trigger endpoint fails', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 500 })));
    const context = makeContext();

    await submitMeetingArtifact(payload, context);

    expect(context.setState).toHaveBeenCalledWith('submittedEntityId', null);
    expect(context.setState).toHaveBeenCalledWith(
      'submitError',
      expect.stringContaining('500')
    );
  });

  it('toggles isSubmitting on around a successful submit', async () => {
    const context = makeContext();

    await submitMeetingArtifact(payload, context);

    const calls = (context.setState as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const onIdx = calls.findIndex(([key, val]) => key === 'isSubmitting' && val === true);
    const offIdx = calls.findIndex(([key, val]) => key === 'isSubmitting' && val === false);
    expect(onIdx).toBeGreaterThanOrEqual(0);
    expect(offIdx).toBeGreaterThan(onIdx);
  });

  it('rejects malformed JSON before inserting anything, and turns isSubmitting back off', async () => {
    const context = makeContext();

    await submitMeetingArtifact(
      { input_format: 'json', raw_text: '{this is not valid json' },
      context
    );

    expect(context.setState).toHaveBeenCalledWith('submittedEntityId', null);
    expect(context.setState).toHaveBeenCalledWith(
      'submitError',
      expect.stringContaining('not valid JSON')
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(context.setState).not.toHaveBeenCalledWith('isSubmitting', true);
  });

  it('rejects malformed XML before inserting anything', async () => {
    const context = makeContext();

    await submitMeetingArtifact(
      { input_format: 'xml', raw_text: '<meeting><unclosed>' },
      context
    );

    expect(context.setState).toHaveBeenCalledWith('submittedEntityId', null);
    expect(context.setState).toHaveBeenCalledWith(
      'submitError',
      expect.stringContaining('not valid XML')
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('ignores a second submission fired before the first one has left the synchronous guard', async () => {
    const context = makeContext();

    // Neither call is awaited before the other starts, mirroring a double-click: both
    // handler invocations run their synchronous prelude before either yields on the
    // first `await`, so the guard must be set synchronously, not via React state.
    const first = submitMeetingArtifact(payload, context);
    const second = submitMeetingArtifact(payload, context);
    await Promise.all([first, second]);

    // The trigger endpoint is only reached once both supabase inserts have completed,
    // so a single fetch call proves the second submission never entered the handler body.
    expect(fetch).toHaveBeenCalledTimes(1);

    const setStateMock = context.setState as unknown as ReturnType<typeof vi.fn>;
    const submittingOnCalls = setStateMock.mock.calls.filter(
      ([key, val]) => key === 'isSubmitting' && val === true
    );
    expect(submittingOnCalls).toHaveLength(1);
  });

  it('allows a fresh submission once the prior one has finished', async () => {
    const context = makeContext();

    await submitMeetingArtifact(payload, context);
    await submitMeetingArtifact(payload, context);

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects raw_text over the size limit before inserting anything', async () => {
    const context = makeContext();

    await submitMeetingArtifact(
      { input_format: 'text', raw_text: 'x'.repeat(500_001) },
      context
    );

    expect(context.setState).toHaveBeenCalledWith('submittedEntityId', null);
    expect(context.setState).toHaveBeenCalledWith(
      'submitError',
      expect.stringContaining('too long')
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('accepts well-formed JSON and XML uploads', async () => {
    const jsonContext = makeContext();
    await submitMeetingArtifact(
      { input_format: 'json', raw_text: '{"notes": "Alice will send the budget."}' },
      jsonContext
    );
    expect(jsonContext.setState).toHaveBeenCalledWith('submitError', null);

    const xmlContext = makeContext();
    await submitMeetingArtifact(
      { input_format: 'xml', raw_text: '<meeting><note>Alice will send the budget.</note></meeting>' },
      xmlContext
    );
    expect(xmlContext.setState).toHaveBeenCalledWith('submitError', null);
  });
});

describe('updatePastedText', () => {
  it('flags whitespace-only text as blank', () => {
    const context = makeContext();

    updatePastedText('   \n\t  ', context);

    expect(context.setState).toHaveBeenCalledWith('pastedText', '   \n\t  ');
    expect(context.setState).toHaveBeenCalledWith('pastedTextIsBlank', true);
  });

  it('flags empty text as blank', () => {
    const context = makeContext();

    updatePastedText('', context);

    expect(context.setState).toHaveBeenCalledWith('pastedTextIsBlank', true);
  });

  it('does not flag real text as blank, even with surrounding whitespace', () => {
    const context = makeContext();

    updatePastedText('  Alice will send the budget.  ', context);

    expect(context.setState).toHaveBeenCalledWith(
      'pastedText',
      '  Alice will send the budget.  '
    );
    expect(context.setState).toHaveBeenCalledWith('pastedTextIsBlank', false);
  });
});
