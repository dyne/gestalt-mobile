import { expect, test } from '@playwright/test';

test('starts a selected workspace session and opens chat', async ({ page }) => {
  const session = {
    id: 'session-1',
    state: 'ready',
    workspaceId: 'workspace-1',
    profile: 'work',
    activeTurnId: null,
  };
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        workspaces: [{ id: 'workspace-1', name: 'project' }],
        profiles: [{ name: 'work', state: 'ok', status: 'ready' }],
        sessions: [],
      }),
    }),
  );
  await page.route('**/api/sessions', async (route) => {
    if (route.request().method() === 'POST') {
      expect(route.request().postDataJSON()).toEqual({
        workspaceId: 'workspace-1',
        profile: 'work',
      });
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(session) });
      return;
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify([session]) });
  });
  await page.route('**/api/sessions/session-1/turns', async (route) => {
    expect(route.request().postDataJSON()).toEqual({ text: 'Inspect this workspace' });
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ activeTurnId: 'turn-1' }),
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Sessions' }).click();
  await page.getByRole('button', { name: 'Start session' }).click();

  await expect(page.getByRole('heading', { name: 'Chat' })).toBeVisible();
  await expect(page.getByText('Connected session: session-1')).toBeVisible();
  await page.getByLabel('Message').fill('Inspect this workspace');
  await page.getByLabel('Message').press('Enter');
  await expect(page.getByRole('button', { name: 'Interrupt' })).toBeVisible();
});
