/**
 * Multi-Agent Debate Arena Route
 */

import { createFileRoute } from '@tanstack/react-router';
import { UIEngine } from '@/engine';
import debateArenaPage from '@/pages/debate-arena.json';
import { submitDebate, updateTopic } from '@/engine/customHandlers/debateArena';
import type { PageDefinition } from '@/engine/types';

export const Route = createFileRoute('/debate-arena')({
  component: DebateArenaPage,
});

function DebateArenaPage() {
  const entityId = new URLSearchParams(window.location.search).get('entityId');

  return (
    <UIEngine
      page={debateArenaPage as PageDefinition}
      customHandlers={{ submitDebate, updateTopic }}
      initialState={{ submittedDebateId: entityId }}
    />
  );
}
