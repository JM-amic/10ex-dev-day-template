/**
 * Custom action handlers for the Multi-Agent Debate Arena page.
 */

import { supabase } from '@/data/supabase';
import type { ExpressionContext } from '../types';

interface PersonaData {
  key: string;
  label: string;
  emoji: string;
  flavor: 'classical' | 'unusual' | 'judge';
  personality: string;
  stance_prompt: string;
}

interface PersonaRow {
  entity_versions?: { data?: PersonaData }[];
}

interface DebateEntityData {
  topic: string;
  round_count: number;
  selected_personas: PersonaData[];
  judge_persona: PersonaData;
}

// Module-level (not React state) so a double-click can't slip a second submission in
// before a re-render disables the button -- mirrors the guard in meetingNotes.ts,
// where isSubmitting React state alone proved too slow to close the race.
let submissionInFlight = false;

/**
 * Textarea onChange handler for the topic field. Tracks a derived
 * `topicIsBlank` flag alongside the raw text: the page's expression
 * evaluator has no `.trim()`/method-call support, so "is this blank"
 * can't be computed inline in the JSON disabled-expression and has to be
 * precomputed here instead, mirroring `updatePastedText` in meetingNotes.ts.
 */
export function updateTopic(payload: unknown, context: ExpressionContext): void {
  const text = typeof payload === 'string' ? payload : '';
  context.setState?.('topic', text);
  context.setState?.('topicIsBlank', text.trim().length === 0);
}

/**
 * Inserts a `debate` entity + its first version from the given data, then triggers
 * the start-debate workflow. Reports the created entity id (or an error message)
 * back to the page via the injected `context.setState`. Shared by `submitDebate`
 * (fresh submissions, built from current form state) and `retryDebate` (resubmits
 * the same debate data already persisted on the entity being retried).
 */
async function insertDebateAndTrigger(
  entityData: DebateEntityData,
  setState: ExpressionContext['setState']
): Promise<void> {
  if (submissionInFlight) {
    return;
  }

  submissionInFlight = true;
  setState?.('isSubmitting', true);
  try {
    const { data: entity, error: entityError } = await supabase
      .from('entities')
      .insert({ entity_type: 'debate' })
      .select()
      .single();
    if (entityError) throw entityError;

    const entityId = (entity as { id: string }).id;

    const { error: versionError } = await supabase.from('entity_versions').insert({
      entity_id: entityId,
      version_number: 1,
      data: {
        ...entityData,
        processing_status: 'pending',
        current_round: 0,
      },
      is_current: true,
    });
    if (versionError) throw versionError;

    const response = await fetch(`${import.meta.env.VITE_TRIGGER_URL}/workflows/start-debate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entity_id: entityId }),
    });

    // A 202 (started or already_running) is ok; anything else is a failure.
    if (!response.ok) {
      throw new Error(`Trigger endpoint returned ${response.status}`);
    }

    setState?.('submitError', null);
    setState?.('submittedDebateId', entityId);

    const url = new URL(window.location.href);
    url.searchParams.set('entityId', entityId);
    window.history.replaceState(null, '', url);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setState?.('submittedDebateId', null);
    setState?.('submitError', `Failed to submit debate: ${message}`);
  } finally {
    submissionInFlight = false;
    setState?.('isSubmitting', false);
  }
}

/**
 * Inserts a `debate` entity + its first version from the current
 * topic/round-count/persona-selection state, then triggers the start-debate
 * workflow.
 */
export async function submitDebate(
  payload: unknown,
  context: ExpressionContext
): Promise<void> {
  const { round_count } = (payload || {}) as { round_count?: string };
  const setState = context.setState;

  const topic = (context.state.topic as string) || '';
  const selectedKeys = (context.state.selectedPersonaKeys as string[]) || [];
  const personaRows = (context.data.personas as PersonaRow[]) || [];
  const judgeRow = context.data.judgePersona as PersonaRow | undefined;

  const selected_personas = personaRows
    .map((row) => row.entity_versions?.[0]?.data)
    .filter((data): data is PersonaData => Boolean(data) && selectedKeys.includes(data!.key));
  const judge_persona = judgeRow?.entity_versions?.[0]?.data;

  if (!judge_persona) {
    setState?.('submittedDebateId', null);
    setState?.('submitError', 'Failed to submit debate: Judge persona not found.');
    return;
  }

  await insertDebateAndTrigger(
    { topic, round_count: Number(round_count), selected_personas, judge_persona },
    setState
  );
}

/**
 * "Try again" handler for a debate that ended in error. Resubmits the exact
 * topic/round_count/selected_personas/judge_persona already persisted on the
 * debate being retried (`context.data.debate`), rather than rebuilding from page
 * state -- state like `selectedPersonaKeys`/`topic` resets to its initial empty
 * value on a page refresh, which previously caused a retry to resubmit an empty
 * debate (the same class of bug fixed for meeting notes' "Try again").
 */
export async function retryDebate(
  _payload: unknown,
  context: ExpressionContext
): Promise<void> {
  const setState = context.setState;
  const debate = context.data.debate as
    | { entity_versions?: { data?: Partial<DebateEntityData> }[] }
    | undefined;
  const persisted = debate?.entity_versions?.[0]?.data;

  if (!persisted?.topic || !persisted.judge_persona || !persisted.selected_personas || !persisted.round_count) {
    setState?.('submittedDebateId', null);
    setState?.('submitError', 'Failed to submit debate: original debate data not found.');
    return;
  }

  await insertDebateAndTrigger(
    {
      topic: persisted.topic,
      round_count: persisted.round_count,
      selected_personas: persisted.selected_personas,
      judge_persona: persisted.judge_persona,
    },
    setState
  );
}
