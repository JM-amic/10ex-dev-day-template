/**
 * Meeting Notes → Action Items Route
 */

import { createFileRoute } from '@tanstack/react-router';
import { UIEngine } from '@/engine';
import meetingNotesPage from '@/pages/meeting-notes.json';
import { submitMeetingArtifact, updatePastedText } from '@/engine/customHandlers/meetingNotes';
import type { PageDefinition } from '@/engine/types';

export const Route = createFileRoute('/meeting-notes')({
  component: MeetingNotesPage,
});

function MeetingNotesPage() {
  const entityId = new URLSearchParams(window.location.search).get('entityId');

  return (
    <UIEngine
      page={meetingNotesPage as PageDefinition}
      customHandlers={{ submitMeetingArtifact, updatePastedText }}
      initialState={{ submittedEntityId: entityId }}
    />
  );
}
