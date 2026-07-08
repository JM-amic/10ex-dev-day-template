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
 * Inserts a `debate` entity + its first version from the current
 * topic/round-count/persona-selection state, then triggers the start-debate
 * workflow. Reports the created entity id (or an error message) back to the
 * page via the injected `context.setState`, mirroring `submitMeetingArtifact`.
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

  setState?.('isSubmitting', true);
  try {
    const selected_personas = personaRows
      .map((row) => row.entity_versions?.[0]?.data)
      .filter((data): data is PersonaData => Boolean(data) && selectedKeys.includes(data!.key));
    const judge_persona = judgeRow?.entity_versions?.[0]?.data;

    if (!judge_persona) {
      throw new Error('Judge persona not found.');
    }

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
        topic,
        round_count: Number(round_count),
        selected_personas,
        judge_persona,
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
    setState?.('isSubmitting', false);
  }
}
