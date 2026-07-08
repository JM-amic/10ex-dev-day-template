/**
 * DebateTranscript Component - Debate Arena live transcript
 *
 * Grouping turns by round and color-coding them by persona both require a
 * lookup/grouping step the JSON page engine's expression language can't
 * express (no array method calls, no arithmetic) -- the same class of gap
 * that already motivated EnginePersonaPicker as a real component instead of
 * a declarative `{{...}}`-driven `each` loop.
 */

import { AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getPersonaColor } from '@/lib/personaColor';
import type { EngineComponentProps } from '@/engine/types';

interface TurnData {
  round_number: number;
  persona_key: string;
  persona_label: string;
  persona_emoji: string;
  argument: string;
  is_placeholder?: boolean;
}

interface TurnRow {
  child_id?: string;
  entities?: { entity_versions?: { data?: TurnData }[] };
}

interface EngineDebateTranscriptProps extends EngineComponentProps {
  turns?: TurnRow[];
  className?: string;
}

function turnData(row: TurnRow): TurnData | undefined {
  return row.entities?.entity_versions?.[0]?.data;
}

export function EngineDebateTranscript({ turns, className }: EngineDebateTranscriptProps) {
  const resolved = (turns ?? [])
    .map((row) => ({ key: row.child_id, data: turnData(row) }))
    .filter((t): t is { key: string | undefined; data: TurnData } => Boolean(t.data));

  if (resolved.length === 0) {
    return <p className="text-sm text-muted-foreground">No arguments yet -- waiting on round 1.</p>;
  }

  const rounds: { round: number; turns: typeof resolved }[] = [];
  for (const turn of resolved) {
    const round = turn.data.round_number;
    let group = rounds.find((r) => r.round === round);
    if (!group) {
      group = { round, turns: [] };
      rounds.push(group);
    }
    group.turns.push(turn);
  }

  return (
    <div className={cn('space-y-5', className)}>
      {rounds.map((group) => (
        <div key={group.round} className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Round {group.round}
            </span>
            <div className="h-px flex-1 bg-border" />
          </div>
          <div className="space-y-2">
            {group.turns.map(({ key, data }) => {
              if (data.is_placeholder) {
                return (
                  <div
                    key={key}
                    className="rounded-lg border border-dashed border-destructive/40 p-3 flex gap-3"
                  >
                    <div className="flex items-center justify-center h-9 w-9 shrink-0 rounded-full bg-destructive/10 text-destructive">
                      <AlertTriangle className="h-4 w-4" />
                    </div>
                    <div className="space-y-0.5">
                      <p className="text-sm font-semibold">
                        {data.persona_emoji} {data.persona_label}
                      </p>
                      <p className="text-sm italic text-muted-foreground">{data.argument}</p>
                    </div>
                  </div>
                );
              }

              const color = getPersonaColor(data.persona_key);
              return (
                <div
                  key={key}
                  className={cn('rounded-lg border p-3 flex gap-3', color.cardBorder, color.cardBg)}
                >
                  <div
                    className={cn(
                      'flex items-center justify-center h-9 w-9 shrink-0 rounded-full text-lg',
                      color.avatarBg
                    )}
                  >
                    {data.persona_emoji}
                  </div>
                  <div className="space-y-0.5">
                    <p className="text-sm font-semibold">{data.persona_label}</p>
                    <p className="text-sm">{data.argument}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
