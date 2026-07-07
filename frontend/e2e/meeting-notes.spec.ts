import { test, expect } from '@playwright/test';

/**
 * Drives the real meeting-notes page against the E2E backend stack
 * (`make e2e-up`): real Temporal workflow, real worker, real trigger API,
 * real (shared, local) Supabase -- only the Azure OpenAI call is replaced by
 * the deterministic e2e/stub-llm server. Scenarios are selected via marker
 * strings the stub recognizes (see e2e/stub-llm/server.py):
 *   "__E2E_FAIL__" -> simulated model failure
 *   "__E2E_ZERO_ITEMS__" -> zero extracted items
 *   anything else -> two canned items (Alice/2026-08-01, unassigned/no date)
 */

async function submitText(page: import('@playwright/test').Page, text: string) {
  await page.goto('/meeting-notes');
  await page.getByPlaceholder('Paste your meeting notes here…').fill(text);
  await page.getByRole('button', { name: 'Extract Action Items' }).click();
}

test('happy path: submit text and see extracted action items', async ({ page }) => {
  await submitText(page, 'Alice will send the budget by Friday. Someone should recap the meeting.');

  // Source artifact panel appears immediately with the submitted text.
  await expect(page.getByText('Alice will send the budget by Friday.', { exact: false })).toBeVisible();

  // Poll (every 2s) until the workflow finishes and items render.
  await expect(page.getByText('Follow up on Q3 budget numbers')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Alice · 2026-08-01')).toBeVisible();
  await expect(page.getByText('Send meeting recap to the team')).toBeVisible();
  await expect(page.getByText('unassigned · no date')).toBeVisible();
});

test('zero items: shows the empty state, not a broken list', async ({ page }) => {
  await submitText(page, '__E2E_ZERO_ITEMS__ just a casual chat, no follow-ups.');

  await expect(page.getByText('No action items found')).toBeVisible({ timeout: 20_000 });
});

test('model failure: shows an error state with a retry button', async ({ page }) => {
  await submitText(page, '__E2E_FAIL__ this should blow up the model call.');

  await expect(page.getByText('Extraction failed')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
});

test('file upload: submitting a JSON export also extracts action items', async ({ page }) => {
  await page.goto('/meeting-notes');
  await page.getByRole('button', { name: 'Upload file' }).click();

  await page.setInputFiles('input[type="file"]', {
    name: 'notes.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ notes: 'Alice will send the budget by Friday.' })),
  });

  await expect(page.getByText('notes.json')).toBeVisible();
  await page.getByRole('button', { name: 'Extract Action Items' }).click();

  await expect(page.getByText('Follow up on Q3 budget numbers')).toBeVisible({ timeout: 20_000 });
});

test('persistence: a page refresh still shows the same artifact and items', async ({ page }) => {
  await submitText(page, 'Alice will send the budget by Friday. Someone should recap the meeting.');
  await expect(page.getByText('Follow up on Q3 budget numbers')).toBeVisible({ timeout: 20_000 });

  await page.reload();

  await expect(page.getByText('Alice will send the budget by Friday.', { exact: false })).toBeVisible();
  await expect(page.getByText('Follow up on Q3 budget numbers')).toBeVisible();
});
