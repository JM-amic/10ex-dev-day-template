import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import confetti from 'canvas-confetti';
import { triggerConfetti } from '../confetti';
import { createActionDispatcher } from '../../ActionDispatcher';
import type {
  CustomActionHandler,
  ActionDispatcherConfig,
} from '../../ActionDispatcher';
import type {
  ComponentDefinition,
  CustomAction,
  ExpressionContext,
  PageDefinition,
} from '../../types';
import dashboardPage from '@/pages/dashboard.json';

vi.mock('canvas-confetti', () => ({ default: vi.fn() }));

const confettiMock = confetti as unknown as ReturnType<typeof vi.fn>;

function makeContext(overrides: Partial<ExpressionContext> = {}): ExpressionContext {
  return {
    state: {},
    data: {},
    params: {},
    setState: vi.fn(),
    ...overrides,
  };
}

function findButtonWithCustomHandler(
  node: ComponentDefinition
): ComponentDefinition | undefined {
  const onClick = node.props?.onClick as { action?: string } | undefined;
  if (node.type === 'Button' && onClick?.action === 'custom') {
    return node;
  }
  return (node.children ?? [])
    .map(findButtonWithCustomHandler)
    .find((found): found is ComponentDefinition => found !== undefined);
}

describe('triggerConfetti', () => {
  beforeEach(() => {
    confettiMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fires the underlying canvas-confetti effect exactly once', () => {
    triggerConfetti(undefined, makeContext());

    expect(confettiMock).toHaveBeenCalledTimes(1);
  });

  it('invokes confetti with an options object', () => {
    triggerConfetti(undefined, makeContext());

    const [options] = confettiMock.mock.calls[0];
    expect(options).toBeTypeOf('object');
    expect(options).not.toBeNull();
  });

  it('returns void (undefined), matching the fire-and-forget handler contract', () => {
    const result = triggerConfetti(undefined, makeContext());

    expect(result).toBeUndefined();
  });

  it('does not throw and does not read from payload or context', () => {
    expect(() =>
      triggerConfetti({ arbitrary: 'payload' }, makeContext({ state: { anything: true } }))
    ).not.toThrow();
    expect(confettiMock).toHaveBeenCalledTimes(1);
  });

  it('does not call context.setState (purely decorative, no state side effects)', () => {
    const context = makeContext();

    triggerConfetti(undefined, context);

    expect(context.setState).not.toHaveBeenCalled();
  });

  it('does not log to the console', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    triggerConfetti(undefined, makeContext());

    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not touch fetch or any network API', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    triggerConfetti(undefined, makeContext());

    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('handles repeated rapid invocations without throwing or stacking state (one confetti() call per invocation)', () => {
    expect(() => {
      for (let i = 0; i < 10; i += 1) {
        triggerConfetti(undefined, makeContext());
      }
    }).not.toThrow();

    expect(confettiMock).toHaveBeenCalledTimes(10);
  });

  it('is assignable to the CustomActionHandler type ActionDispatcher expects', () => {
    // Compile-time contract check: fails the build if the signature drifts.
    const handler: CustomActionHandler = triggerConfetti;

    expect(handler).toBe(triggerConfetti);
  });
});

describe('triggerConfetti wired through the ActionDispatcher (the real invocation path)', () => {
  beforeEach(() => {
    confettiMock.mockClear();
  });

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

  it('fires confetti when the dispatcher runs a custom action registered as triggerConfetti', async () => {
    const { dispatch } = createActionDispatcher(
      makeConfig({ customHandlers: { triggerConfetti } })
    );
    const action: CustomAction = { action: 'custom', handler: 'triggerConfetti' };

    await dispatch(action, makeContext());

    expect(confettiMock).toHaveBeenCalledTimes(1);
  });
});

describe('dashboard.json celebrate button wiring', () => {
  const button = findButtonWithCustomHandler(
    (dashboardPage as PageDefinition).layout
  );

  it('declares a Button whose onClick dispatches the triggerConfetti custom handler', () => {
    expect(button).toBeDefined();
    expect(button?.props?.onClick).toEqual({
      action: 'custom',
      handler: 'triggerConfetti',
    });
  });

  it('references the handler under the exact key the module exports', () => {
    const onClick = button?.props?.onClick as CustomAction;

    // The JSON string must match the registered function's name so the
    // handler lookup in ActionDispatcher.handleCustom resolves.
    expect(onClick.handler).toBe(triggerConfetti.name);
  });
});
