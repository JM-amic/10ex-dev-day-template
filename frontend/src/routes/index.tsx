/**
 * Index Route - Dashboard
 */

import { createFileRoute } from '@tanstack/react-router';
import { UIEngine } from '@/engine';
import dashboardPage from '@/pages/dashboard.json';
import { triggerConfetti } from '@/engine/customHandlers/confetti';
import type { PageDefinition } from '@/engine/types';

export const Route = createFileRoute('/')({
  component: DashboardPage,
});

function DashboardPage() {
  return (
    <UIEngine
      page={dashboardPage as PageDefinition}
      customHandlers={{ triggerConfetti }}
    />
  );
}
