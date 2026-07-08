/**
 * PersonaPicker Component - Debate Arena persona roster picker
 *
 * The engine's expression language (ExpressionEvaluator.ts) has no array
 * method-call support (no `.includes()`/`.filter()`/`.map()`) and no
 * arithmetic, so "is this dynamically-fetched roster card currently
 * selected" and "is the selection count between 3 and 5" can't be expressed
 * as declarative `{{...}}` bindings. This component pushes that logic into
 * real code and reports the derived selection + validity back to the page
 * via `dispatch(onChange, {...})`, the same pattern EngineFileInput already
 * establishes for logic the expression language can't reach.
 */

import { cn } from '@/lib/utils';
import type { EngineComponentProps, ActionDefinition } from '@/engine/types';
import { useUIEngine } from '@/engine/UIEngineContext';

interface PersonaData {
  key: string;
  label: string;
  emoji: string;
  flavor: 'classical' | 'unusual' | 'judge';
  personality: string;
}

interface PersonaRow {
  id?: string;
  entity_versions?: { data?: PersonaData }[];
}

interface EnginePersonaPickerProps extends EngineComponentProps {
  personas?: PersonaRow[];
  selectedKeys?: string[];
  min?: number;
  max?: number;
  onChange?: ActionDefinition;
  className?: string;
}

function personaData(row: PersonaRow): PersonaData | undefined {
  return row.entity_versions?.[0]?.data;
}

const FLAVOR_LABELS: Record<string, string> = {
  classical: 'Classical',
  unusual: 'Unusual',
};

export function EnginePersonaPicker({
  personas,
  selectedKeys = [],
  min = 3,
  max = 5,
  onChange,
  className,
}: EnginePersonaPickerProps) {
  const { dispatch } = useUIEngine();

  // `useDataSources` resolves an unresolved query's data to `null` (not `undefined`)
  // while it's still loading, so a `personas = []` default parameter alone doesn't
  // cover the pre-load render -- an explicit `null` bypasses default parameters.
  const pickable = (personas ?? [])
    .map(personaData)
    .filter((p): p is PersonaData => Boolean(p) && p!.flavor !== 'judge');

  const groups: { flavor: string; personas: PersonaData[] }[] = ['classical', 'unusual']
    .map((flavor) => ({ flavor, personas: pickable.filter((p) => p.flavor === flavor) }))
    .filter((group) => group.personas.length > 0);

  const toggle = (key: string) => {
    if (!onChange) return;

    const isSelected = selectedKeys.includes(key);
    let nextKeys: string[];
    if (isSelected) {
      nextKeys = selectedKeys.filter((k) => k !== key);
    } else {
      if (selectedKeys.length >= max) return; // at capacity: 6th selection is a no-op
      nextKeys = [...selectedKeys, key];
    }

    dispatch(onChange, {
      event: {
        selectedKeys: nextKeys,
        isValidCount: nextKeys.length >= min && nextKeys.length <= max,
      },
    });
  };

  return (
    <div className={cn('space-y-4', className)}>
      {groups.map((group) => (
        <div key={group.flavor} className="space-y-2">
          <p className="text-sm font-medium text-muted-foreground">
            {FLAVOR_LABELS[group.flavor] || group.flavor}
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {group.personas.map((persona) => {
              const selected = selectedKeys.includes(persona.key);
              const atCapacity = !selected && selectedKeys.length >= max;
              return (
                <button
                  key={persona.key}
                  type="button"
                  disabled={atCapacity}
                  aria-pressed={selected}
                  onClick={() => toggle(persona.key)}
                  className={cn(
                    'text-left rounded-lg border p-3 space-y-1 transition-colors',
                    selected
                      ? 'border-primary bg-primary/10'
                      : 'border-border hover:bg-muted',
                    atCapacity && 'opacity-50 cursor-not-allowed hover:bg-transparent'
                  )}
                >
                  <div className="text-2xl leading-none">{persona.emoji}</div>
                  <div className="text-sm font-medium">{persona.label}</div>
                  <div className="text-xs text-muted-foreground">{persona.personality}</div>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
