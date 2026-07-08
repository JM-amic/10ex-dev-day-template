/**
 * Custom action handler for the Meeting Notes -> Action Items page.
 */

import { supabase } from '@/data/supabase';
import type { ExpressionContext } from '../types';

interface MeetingArtifactPayload {
  input_format: 'text' | 'xml' | 'json';
  raw_text: string;
}

// Module-level (not React state) so a double-click can't slip a second submission in
// before a re-render disables the button -- the guard has to be synchronous with the
// very first line of the handler, not dependent on a state update being flushed first.
let submissionInFlight = false;

const MAX_RAW_TEXT_LENGTH = 500_000; // ~500KB; well under Temporal's activity payload size limit

function unparseableReason(input_format: string, raw_text: string): string | null {
  if (input_format === 'json') {
    try {
      JSON.parse(raw_text);
      return null;
    } catch {
      return 'Uploaded file is not valid JSON.';
    }
  }
  if (input_format === 'xml') {
    const doc = new DOMParser().parseFromString(raw_text, 'application/xml');
    return doc.getElementsByTagName('parsererror').length > 0
      ? 'Uploaded file is not valid XML.'
      : null;
  }
  return null;
}

/**
 * Textarea onChange handler for the pasted-notes field. Tracks a derived
 * `pastedTextIsBlank` flag alongside the raw text: the page's expression
 * evaluator has no `.trim()`/method-call support, so "is this blank"
 * can't be computed inline in the JSON disabled-expression and has to be
 * precomputed here instead.
 */
export function updatePastedText(payload: unknown, context: ExpressionContext): void {
  const text = typeof payload === 'string' ? payload : '';
  context.setState?.('pastedText', text);
  context.setState?.('pastedTextIsBlank', text.trim().length === 0);
}

/**
 * Inserts a meeting_notes entity + its first version, then triggers the
 * extract-action-items workflow. Reports the created entity id (or an error
 * message) back to the page via the injected `context.setState`.
 */
export async function submitMeetingArtifact(
  payload: unknown,
  context: ExpressionContext
): Promise<void> {
  const { input_format, raw_text } = (payload || {}) as MeetingArtifactPayload;
  const setState = context.setState;

  if (submissionInFlight) {
    return;
  }

  const reason = unparseableReason(input_format, raw_text);
  if (reason) {
    setState?.('submittedEntityId', null);
    setState?.('submitError', reason);
    return;
  }

  if (raw_text.length > MAX_RAW_TEXT_LENGTH) {
    setState?.('submittedEntityId', null);
    setState?.(
      'submitError',
      `Meeting notes are too long (${raw_text.length.toLocaleString()} characters). Please shorten to under ${MAX_RAW_TEXT_LENGTH.toLocaleString()} characters.`
    );
    return;
  }

  submissionInFlight = true;
  setState?.('isSubmitting', true);
  try {
    const { data: entity, error: entityError } = await supabase
      .from('entities')
      .insert({ entity_type: 'meeting_notes' })
      .select()
      .single();
    if (entityError) throw entityError;

    const entityId = (entity as { id: string }).id;

    const { error: versionError } = await supabase.from('entity_versions').insert({
      entity_id: entityId,
      version_number: 1,
      data: { input_format, raw_text, processing_status: 'pending' },
      is_current: true,
    });
    if (versionError) throw versionError;

    const response = await fetch(
      `${import.meta.env.VITE_TRIGGER_URL}/workflows/extract-action-items`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entity_id: entityId }),
      }
    );

    // A 202 (started or already_running) is ok; anything else is a failure.
    if (!response.ok) {
      throw new Error(`Trigger endpoint returned ${response.status}`);
    }

    setState?.('submitError', null);
    setState?.('submittedEntityId', entityId);

    const url = new URL(window.location.href);
    url.searchParams.set('entityId', entityId);
    window.history.replaceState(null, '', url);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setState?.('submittedEntityId', null);
    setState?.('submitError', `Failed to submit meeting artifact: ${message}`);
  } finally {
    submissionInFlight = false;
    setState?.('isSubmitting', false);
  }
}
