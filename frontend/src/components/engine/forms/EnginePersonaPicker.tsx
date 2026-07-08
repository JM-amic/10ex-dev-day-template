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

import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getPersonaColor } from '@/lib/personaColor';
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
  label?: string;
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
  label = 'Debaters',
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

  const isValidCount = selectedKeys.length >= min && selectedKeys.length <= max;

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
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">{label}</p>
        <span
          className={cn(
            'text-xs font-medium rounded-full px-2 py-0.5',
            isValidCount ? 'bg-emerald-100 text-emerald-700' : 'bg-muted text-muted-foreground'
          )}
        >
          {selectedKeys.length} / {min}-{max} selected
        </span>
      </div>
      {groups.map((group) => (
        <div key={group.flavor} className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {FLAVOR_LABELS[group.flavor] || group.flavor}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {group.personas.map((persona) => {
              const selected = selectedKeys.includes(persona.key);
              const atCapacity = !selected && selectedKeys.length >= max;
              const color = getPersonaColor(persona.key);
              return (
                <button
                  key={persona.key}
                  type="button"
                  disabled={atCapacity}
                  aria-pressed={selected}
                  onClick={() => toggle(persona.key)}
                  className={cn(
                    'relative text-left rounded-xl border p-3 space-y-2 transition-all',
                    selected
                      ? cn('border-transparent ring-2', color.ring, color.cardBg)
                      : 'border-border hover:border-foreground/30 hover:shadow-sm',
                    atCapacity && 'opacity-50 cursor-not-allowed hover:shadow-none hover:border-border'
                  )}
                >
                  {selected && (
                    <span className="absolute top-2 right-2 rounded-full bg-primary text-primary-foreground p-0.5">
                      <Check className="h-3 w-3" />
                    </span>
                  )}
                  <div
                    className={cn(
                      'flex items-center justify-center h-10 w-10 rounded-full text-xl',
                      color.avatarBg
                    )}
                  >
                    {persona.emoji}
                  </div>
                  <div className="text-sm font-semibold">{persona.label}</div>
                  <div className="text-xs text-muted-foreground leading-snug">{persona.personality}</div>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
