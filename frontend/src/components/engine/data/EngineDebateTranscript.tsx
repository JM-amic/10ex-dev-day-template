/**
 * DebateTranscript Component - Debate Arena live transcript
 *
 * Grouping turns by round and color-coding them by persona both require a
 * lookup/grouping step the JSON page engine's expression language can't
 * express (no array method calls, no arithmetic) -- the same class of gap
 * that already motivated EnginePersonaPicker as a real component instead of
 * a declarative `{{...}}`-driven `each` loop. The staggered reveal,
 * "is thinking" placeholders, and per-round collapse below are all local UI
 * state (timers, expansion sets) that has no home in the declarative page.
 *
 * Renders as a conversation thread rather than a stack of report cards: a
 * roster legend up front so the reader has every debater's color/name
 * before diving in, centered round dividers as scene breaks, and turns as
 * chat-style rows (colored avatar + name, neutral bubble with a colored
 * accent) so identity comes from the avatar/name, not a full-card color
 * wash on every single turn. Turns trickle in one at a time so a round
 * reads as a conversation unfolding rather than a wall of text popping in.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getPersonaColor } from '@/lib/personaColor';
import type { EngineComponentProps } from '@/engine/types';

interface TurnData {
  round_number: number;
  persona_key: string;
  persona_label: string;
  persona_emoji: string;
  headline?: string;
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
  status?: string;
  currentRound?: number;
  roundCount?: number;
  className?: string;
}

interface ResolvedTurn {
  key: string;
  data: TurnData;
}

function turnData(row: TurnRow): TurnData | undefined {
  return row.entities?.entity_versions?.[0]?.data;
}

// A single conversation turn. Animates in on mount (opacity/translate) so
// only genuinely new turns -- those whose key was just added to the parent's
// revealed set and therefore mount fresh -- play the entrance; already-mounted
// turns are left untouched by a poll and so never re-animate.
function TurnBubble({ data }: { data: TurnData }) {
  const [visible, setVisible] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const argRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useLayoutEffect(() => {
    const el = argRef.current;
    if (!el || expanded) return; // measure only while clamped; keep toggle once expanded
    setOverflowing(el.scrollHeight > el.clientHeight + 1);
  }, [data.argument, expanded]);

  const wrapperCls = cn(
    'flex gap-3 transition-all duration-500 ease-out',
    visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'
  );

  if (data.is_placeholder) {
    return (
      <div className={wrapperCls}>
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
  const hasHeadline = Boolean(data.headline && data.headline.trim());

  return (
    <div className={wrapperCls}>
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
        {hasHeadline && <p className="text-sm font-semibold mt-0.5">{data.headline}</p>}
        <p
          ref={argRef}
          className={cn('text-sm mt-0.5 whitespace-pre-line', !expanded && 'line-clamp-4')}
        >
          {data.argument}
        </p>
        {(overflowing || expanded) && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className={cn('mt-1 text-xs font-medium hover:underline', color.text)}
          >
            {expanded ? 'Show less' : 'Show more'}
          </button>
        )}
      </div>
    </div>
  );
}

export function EngineDebateTranscript({
  turns,
  personas,
  status,
  currentRound,
  roundCount,
  className,
}: EngineDebateTranscriptProps) {
  const [revealedKeys, setRevealedKeys] = useState<Set<string>>(new Set());
  const [manuallyExpanded, setManuallyExpanded] = useState<Set<number>>(new Set());
  const scheduledRef = useRef<Set<string>>(new Set());
  const timersRef = useRef<number[]>([]);
  const nearBottomRef = useRef(true);
  const bottomRef = useRef<HTMLDivElement>(null);

  const resolved: ResolvedTurn[] = (turns ?? [])
    .map((row, i) => ({ key: row.child_id ?? `turn-${i}`, data: turnData(row) }))
    .filter((t): t is ResolvedTurn => Boolean(t.data));

  const keySignature = resolved.map((t) => t.key).join('|');

  const activeRound = currentRound != null ? Number(currentRound) : undefined;
  const totalRounds = roundCount != null ? Number(roundCount) : undefined;
  const isProcessing = status === 'processing';

  // Staggered reveal: each not-yet-scheduled key gets its own timer so turns
  // surface one at a time. A large batch (page-refresh history load) reveals
  // quickly in sequence; a live trickle (one or two new turns per poll) uses
  // a conversational pace. scheduledRef guarantees a key is only ever queued
  // once, so a 2s poll that re-supplies known keys schedules nothing.
  useEffect(() => {
    const orderedKeys = keySignature ? keySignature.split('|') : [];
    const pending = orderedKeys.filter((k) => !scheduledRef.current.has(k));
    if (pending.length === 0) return;

    const stagger = pending.length >= 5 ? 100 : 450;
    pending.forEach((k, i) => {
      scheduledRef.current.add(k);
      const id = window.setTimeout(() => {
        setRevealedKeys((prev) => {
          const next = new Set(prev);
          next.add(k);
          return next;
        });
        timersRef.current = timersRef.current.filter((t) => t !== id);
      }, i * stagger);
      timersRef.current.push(id);
    });
  }, [keySignature]);

  useEffect(() => () => timersRef.current.forEach(clearTimeout), []);

  // Track the user's scroll position so a newly-revealed turn only pulls the
  // page down when they were already near the bottom; if they scrolled up to
  // re-read, we leave them there.
  useEffect(() => {
    const onScroll = () => {
      nearBottomRef.current =
        window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 200;
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Group turns by round, preserving arrival order within a round. When
  // processing, ensure the in-flight round has a group even before its first
  // turn lands, so its "is thinking" placeholders have somewhere to render.
  const rounds: { round: number; turns: ResolvedTurn[] }[] = [];
  const ensureGroup = (round: number) => {
    let group = rounds.find((r) => r.round === round);
    if (!group) {
      group = { round, turns: [] };
      rounds.push(group);
    }
    return group;
  };
  for (const turn of resolved) {
    ensureGroup(turn.data.round_number).turns.push(turn);
  }
  if (isProcessing && activeRound != null) {
    ensureGroup(activeRound);
  }
  rounds.sort((a, b) => a.round - b.round);

  const thinkingPersonas =
    isProcessing && activeRound != null && personas
      ? personas.filter(
          (p) =>
            !resolved.some(
              (t) => t.data.round_number === activeRound && t.data.persona_key === p.key
            )
        )
      : [];

  const roundsWithTurns = rounds.filter((r) => r.turns.length > 0).map((r) => r.round);
  const latestRoundWithTurns = roundsWithTurns.length ? Math.max(...roundsWithTurns) : undefined;
  const isExpanded = (round: number) =>
    round === activeRound || round === latestRoundWithTurns || manuallyExpanded.has(round);

  const expandRound = (round: number) =>
    setManuallyExpanded((prev) => {
      const next = new Set(prev);
      next.add(round);
      return next;
    });

  const revealCount = revealedKeys.size;
  const thinkingCount = thinkingPersonas.length;

  // Gently keep the newest content in view as it reveals -- only if the user
  // was near the bottom when it arrived (captured pre-update by nearBottomRef).
  useEffect(() => {
    if (nearBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [revealCount, thinkingCount]);

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

      {resolved.length === 0 && thinkingPersonas.length === 0 && (
        <p className="text-sm text-muted-foreground">No arguments yet -- waiting on round 1.</p>
      )}

      {rounds.map((group) => {
        const expanded = isExpanded(group.round);
        const roundLabel = totalRounds ? `Round ${group.round} of ${totalRounds}` : `Round ${group.round}`;

        if (!expanded) {
          const speakers: TurnData[] = [];
          const seen = new Set<string>();
          for (const t of group.turns) {
            if (t.data.is_placeholder || seen.has(t.data.persona_key)) continue;
            seen.add(t.data.persona_key);
            speakers.push(t.data);
          }
          return (
            <button
              key={group.round}
              type="button"
              onClick={() => expandRound(group.round)}
              className="w-full flex items-center gap-3 group"
            >
              <div className="h-px flex-1 bg-border" />
              <span className="flex items-center gap-2 text-xs font-semibold text-muted-foreground rounded-full border border-border bg-muted/50 px-2.5 py-1 group-hover:bg-muted transition-colors">
                Round {group.round}
                <span className="flex -space-x-1.5">
                  {speakers.map((s) => {
                    const color = getPersonaColor(s.persona_key);
                    return (
                      <span
                        key={s.persona_key}
                        className={cn(
                          'flex items-center justify-center h-5 w-5 rounded-full text-[10px] ring-2 ring-background',
                          color.avatarBg
                        )}
                      >
                        {s.persona_emoji}
                      </span>
                    );
                  })}
                </span>
                <span className="font-normal text-muted-foreground/70">
                  {group.turns.length} {group.turns.length === 1 ? 'reply' : 'replies'}
                </span>
                <ChevronDown className="h-3.5 w-3.5" />
              </span>
              <div className="h-px flex-1 bg-border" />
            </button>
          );
        }

        const visibleTurns = group.turns.filter((t) => revealedKeys.has(t.key));

        return (
          <div key={group.round} className="space-y-3">
            <div className="flex items-center gap-3">
              <div className="h-px flex-1 bg-border" />
              <span className="text-xs font-semibold text-muted-foreground rounded-full border border-border bg-muted/50 px-2.5 py-1">
                {roundLabel}
              </span>
              <div className="h-px flex-1 bg-border" />
            </div>
            <div className="space-y-3">
              {visibleTurns.map(({ key, data }) => (
                <TurnBubble key={key} data={data} />
              ))}
              {group.round === activeRound &&
                thinkingPersonas.map((persona) => {
                  const color = getPersonaColor(persona.key);
                  return (
                    <div key={`thinking-${persona.key}`} className="flex gap-3 animate-pulse">
                      <div
                        className={cn(
                          'flex items-center justify-center h-9 w-9 shrink-0 rounded-full text-lg',
                          color.avatarBg
                        )}
                      >
                        {persona.emoji}
                      </div>
                      <div
                        className={cn(
                          'flex-1 rounded-xl border-l-4 bg-muted/40 px-3 py-2',
                          color.cardBorder
                        )}
                      >
                        <p className={cn('text-sm font-semibold', color.text)}>{persona.label}</p>
                        <p className="text-sm italic text-muted-foreground mt-0.5">…is thinking</p>
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>
        );
      })}

      <div ref={bottomRef} />
    </div>
  );
}
