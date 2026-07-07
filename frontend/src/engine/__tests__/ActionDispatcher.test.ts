import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createActionDispatcher } from '../ActionDispatcher';
import type { ActionDispatcherConfig } from '../ActionDispatcher';
import type { CustomAction, ExpressionContext } from '../types';

function makeConfig(
  overrides: Partial<ActionDispatcherConfig> = {}
): ActionDispatcherConfig {
  return {
    setState: vi.fn(),
    navigate: vi.fn() as unknown as ActionDispatcherConfig['navigate'],
    supabase: {} as ActionDispatcherConfig['supabase'],
    queryClient: {} as ActionDispatcherConfig['queryClient'],
    refetch: vi.fn(),
    openModal: vi.fn(),
    closeModal: vi.fn(),
    customHandlers: {},
    ...overrides,
  };
}

function makeContext(overrides: Partial<ExpressionContext> = {}): ExpressionContext {
  return {
    state: {},
    data: {},
    params: {},
    ...overrides,
  };
}

describe('createActionDispatcher - handleCustom', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('calls the named handler with the resolved payload and the context plus setState', async () => {
    const handler = vi.fn();
    const setState = vi.fn();
    const config = makeConfig({ setState, customHandlers: { foo: handler } });
    const { dispatch } = createActionDispatcher(config);

    const context = makeContext();
    const action: CustomAction = {
      action: 'custom',
      handler: 'foo',
      payload: { a: 1 },
    };

    await dispatch(action, context);

    expect(handler).toHaveBeenCalledTimes(1);
    const [payloadArg, contextArg] = handler.mock.calls[0];
    expect(payloadArg).toEqual({ a: 1 });
    expect(contextArg).toEqual(
      expect.objectContaining({
        state: context.state,
        data: context.data,
        params: context.params,
        setState,
      })
    );
    // setState injected into the context is the dispatcher's own setState.
    expect(contextArg.setState).toBe(setState);
  });

  it('resolves expression values in the payload against the context', async () => {
    const handler = vi.fn();
    const config = makeConfig({ customHandlers: { foo: handler } });
    const { dispatch } = createActionDispatcher(config);

    const context = makeContext({ state: { name: 'meeting.txt' } });
    const action: CustomAction = {
      action: 'custom',
      handler: 'foo',
      payload: { raw_text: '{{state.name}}' },
    };

    await dispatch(action, context);

    expect(handler).toHaveBeenCalledWith(
      { raw_text: 'meeting.txt' },
      expect.objectContaining({ setState: config.setState })
    );
  });

  it('warns and does not throw when the handler name is not registered', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = makeConfig({ customHandlers: {} });
    const { dispatch } = createActionDispatcher(config);

    const action: CustomAction = { action: 'custom', handler: 'missing' };

    await expect(dispatch(action, makeContext())).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Custom handler not found: missing')
    );
  });

  it('awaits an async handler before resolving', async () => {
    const order: string[] = [];
    const handler = vi.fn(async () => {
      await Promise.resolve();
      order.push('handler-done');
    });
    const config = makeConfig({ customHandlers: { foo: handler } });
    const { dispatch } = createActionDispatcher(config);

    await dispatch({ action: 'custom', handler: 'foo' }, makeContext());
    order.push('dispatch-returned');

    expect(order).toEqual(['handler-done', 'dispatch-returned']);
  });
});
