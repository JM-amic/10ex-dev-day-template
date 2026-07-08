import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EnginePersonaPicker } from '../EnginePersonaPicker';
import { UIEngineContext } from '@/engine/UIEngineContext';
import type { UIEngineContextValue } from '@/engine/types';

function makePersona(key: string, label: string, flavor: 'classical' | 'unusual' | 'judge') {
  return {
    id: key,
    entity_versions: [
      { data: { key, label, emoji: '🙂', flavor, personality: `${label} personality` } },
    ],
  };
}

const CLASSICAL = ['optimist', 'skeptic', 'pragmatist', 'contrarian'].map((k) =>
  makePersona(k, `The ${k}`, 'classical')
);
const UNUSUAL = ['wizard', 'trickster', 'warrior', 'villain', 'hero', 'detective', 'scientist', 'samurai'].map(
  (k) => makePersona(k, `The ${k}`, 'unusual')
);
const JUDGE = makePersona('judge', 'The Arbiter Owl', 'judge');

const ALL_PERSONAS = [...CLASSICAL, ...UNUSUAL, JUDGE];

function renderPicker(props: Partial<React.ComponentProps<typeof EnginePersonaPicker>>, dispatch = vi.fn()) {
  const contextValue = {
    dispatch,
  } as unknown as UIEngineContextValue;

  render(
    <UIEngineContext.Provider value={contextValue}>
      <EnginePersonaPicker personas={ALL_PERSONAS} selectedKeys={[]} onChange={{ action: 'setState', key: 'x', value: 1 }} {...props} />
    </UIEngineContext.Provider>
  );

  return dispatch;
}

describe('EnginePersonaPicker', () => {
  it('renders all 12 pickable personas grouped into Classical/Unusual, excluding the judge', () => {
    renderPicker({});

    expect(screen.getByText('Classical')).toBeInTheDocument();
    expect(screen.getByText('Unusual')).toBeInTheDocument();
    for (const persona of [...CLASSICAL, ...UNUSUAL]) {
      expect(screen.getByText(persona.entity_versions[0].data.label)).toBeInTheDocument();
    }
    expect(screen.queryByText('The Arbiter Owl')).not.toBeInTheDocument();
  });

  it('toggling a card below max calls onChange with the updated array and correct isValidCount', async () => {
    const user = userEvent.setup();
    const dispatch = renderPicker({ selectedKeys: ['optimist', 'skeptic'] });

    await user.click(screen.getByText('The pragmatist'));

    expect(dispatch).toHaveBeenCalledTimes(1);
    const [action, context] = dispatch.mock.calls[0];
    expect(action).toEqual({ action: 'setState', key: 'x', value: 1 });
    expect(context.event.selectedKeys).toEqual(['optimist', 'skeptic', 'pragmatist']);
    expect(context.event.isValidCount).toBe(true); // 3 selected, min 3 max 5
  });

  it('toggling below min reports isValidCount = false', async () => {
    const user = userEvent.setup();
    const dispatch = renderPicker({ selectedKeys: [] });

    await user.click(screen.getByText('The optimist'));

    const [, context] = dispatch.mock.calls[0];
    expect(context.event.selectedKeys).toEqual(['optimist']);
    expect(context.event.isValidCount).toBe(false); // 1 selected, min 3
  });

  it('deselecting an already-selected card removes it from selectedKeys', async () => {
    const user = userEvent.setup();
    const dispatch = renderPicker({ selectedKeys: ['optimist', 'skeptic', 'pragmatist'] });

    await user.click(screen.getByText('The skeptic'));

    const [, context] = dispatch.mock.calls[0];
    expect(context.event.selectedKeys).toEqual(['optimist', 'pragmatist']);
  });

  it('a 6th selection when already at max (5) is a no-op: dispatch is not called', async () => {
    const user = userEvent.setup();
    const dispatch = renderPicker({
      selectedKeys: ['optimist', 'skeptic', 'pragmatist', 'contrarian', 'wizard'],
    });

    await user.click(screen.getByText('The trickster'));

    expect(dispatch).not.toHaveBeenCalled();
  });

  it('disables unselected cards once max is reached', () => {
    renderPicker({
      selectedKeys: ['optimist', 'skeptic', 'pragmatist', 'contrarian', 'wizard'],
    });

    const trickster = screen.getByText('The trickster').closest('button');
    expect(trickster).toBeDisabled();

    const optimist = screen.getByText('The optimist').closest('button');
    expect(optimist).not.toBeDisabled();
  });
});
