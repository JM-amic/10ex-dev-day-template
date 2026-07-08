/**
 * DebateTranscript Component - Debate Arena live transcript
 *
 * Grouping turns by round and color-coding them by persona both require a
 * lookup/grouping step the JSON page engine's expression language can't
 * express (no array method calls, no arithmetic) -- the same class of gap
 * that already motivated EnginePersonaPicker as a real component instead of
 * a declarative `{{...}}`-driven `each` loop.
 *
 * Renders as a conversation thread rather than a stack of report cards: a
 * roster legend up front so the reader has every debater's color/name
 * before diving in, centered round dividers as scene breaks, and turns as
 * chat-style rows (colored avatar + name, neutral bubble with a colored
 * accent) so identity comes from the avatar/name, not a full-card color
 * wash on every single turn.
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

interface RosterPersona {
  key: string;
  label: string;
  emoji: string;
}

interface EngineDebateTranscriptProps extends EngineComponentProps {
  turns?: TurnRow[];
  personas?: RosterPersona[];
  className?: string;
}

function turnData(row: TurnRow): TurnData | undefined {
  return row.entities?.entity_versions?.[0]?.data;
}

export function EngineDebateTranscript({ turns, personas, className }: EngineDebateTranscriptProps) {
  const resolved = (turns ?? [])
    .map((row) => ({ key: row.child_id, data: turnData(row) }))
    .filter((t): t is { key: string | undefined; data: TurnData } => Boolean(t.data));

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
    <div className={cn('space-y-4', className)}>
      {personas && personas.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-2 pb-3 border-b border-border">
          {personas.map((persona) => {
            const color = getPersonaColor(persona.key);
            return (
              <div key={persona.key} className="flex items-center gap-1.5">
                <span
                  className={cn(
                    'flex items-center justify-center h-6 w-6 rounded-full text-sm',
                    color.avatarBg
                  )}
                >
                  {persona.emoji}
                </span>
                <span className={cn('text-xs font-semibold', color.text)}>{persona.label}</span>
              </div>
            );
          })}
        </div>
      )}

      {resolved.length === 0 && (
        <p className="text-sm text-muted-foreground">No arguments yet -- waiting on round 1.</p>
      )}

      {rounds.map((group) => (
        <div key={group.round} className="space-y-3">
          <div className="flex items-center gap-3">
            <div className="h-px flex-1 bg-border" />
            <span className="text-xs font-semibold text-muted-foreground rounded-full border border-border bg-muted/50 px-2.5 py-1">
              Round {group.round}
            </span>
            <div className="h-px flex-1 bg-border" />
          </div>
          <div className="space-y-3">
            {group.turns.map(({ key, data }) => {
              if (data.is_placeholder) {
                return (
                  <div key={key} className="flex gap-3">
                    <div className="flex items-center justify-center h-9 w-9 shrink-0 rounded-full bg-destructive/10 text-destructive">
                      <AlertTriangle className="h-4 w-4" />
                    </div>
                    <div className="flex-1 rounded-xl border border-dashed border-destructive/40 px-3 py-2">
                      <p className="text-sm font-semibold">
                        {data.persona_emoji} {data.persona_label}
                      </p>
                      <p className="text-sm italic text-muted-foreground mt-0.5">{data.argument}</p>
                    </div>
                  </div>
                );
              }

              const color = getPersonaColor(data.persona_key);
              return (
                <div key={key} className="flex gap-3">
                  <div
                    className={cn(
                      'flex items-center justify-center h-9 w-9 shrink-0 rounded-full text-lg',
                      color.avatarBg
                    )}
                  >
                    {data.persona_emoji}
                  </div>
                  <div className={cn('flex-1 rounded-xl border-l-4 bg-muted/40 px-3 py-2', color.cardBorder)}>
                    <p className={cn('text-sm font-semibold', color.text)}>{data.persona_label}</p>
                    <p className="text-sm mt-0.5">{data.argument}</p>
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
