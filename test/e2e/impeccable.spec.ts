/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, test } from '@playwright/test';
import { mockAuthenticatedStatus } from './auth-fixture.js';
import { ChatRelayFixture } from './chat-relay-fixture.js';

for (const selection of ['enabled', 'disabled', 'legacy'] as const) {
  test(`Impeccable chat commands with a ${selection} skill selection`, async ({
    page,
    context,
  }) => {
    const id = 'design-session';
    const origin = 'https://preview.example';
    const fixture = new ChatRelayFixture(page);
    await mockAuthenticatedStatus(page);
    await fixture.install([
      {
        id,
        state: 'ready',
        desiredState: 'active',
        threadId: 'thread',
        workspaceId: 'workspace',
        workspacePath: '/workspace',
        profile: 'default',
        activeTurnId: null,
        pendingInteractions: [],
        ...(selection === 'legacy'
          ? {}
          : {
              effectiveSkillSelection: {
                skills: [
                  {
                    name: 'impeccable',
                    path: '/skills/impeccable/SKILL.md',
                    enabled: selection === 'enabled',
                  },
                ],
              },
            }),
      },
    ]);
    await page.route('**/api/bootstrap', (route) =>
      route.fulfill({
        json: {
          workspaces: [],
          profiles: [],
          sessions: fixture.sessions,
          capabilities: { preview: true, impeccable: true },
        },
      }),
    );
    await page.route(`**/api/sessions/${id}/impeccable`, (route) =>
      route.fulfill({ json: { available: selection === 'legacy' } }),
    );
    let open: unknown;
    await page.route(`**/api/sessions/${id}/preview`, (route) => {
      open = route.request().postDataJSON();
      return route.fulfill({ json: { url: `${origin}/.gestalt-preview#code` } });
    });
    await context.route(`${origin}/.gestalt-preview`, (route) =>
      route.fulfill({ contentType: 'text/html', body: '<h1>Live preview</h1>' }),
    );

    await page.goto('/');
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    const prompt = page.getByRole('textbox', { name: 'Prompt' });
    await prompt.fill('/impeccable');
    const menu = page.getByRole('group', { name: 'Impeccable commands' });
    if (selection === 'disabled') {
      await expect(menu).toHaveCount(0);
      return;
    }
    await expect(menu.getByRole('heading')).toHaveText([
      'Build',
      'Evaluate',
      'Refine',
      'Enhance',
      'Fix',
      'Browser iteration',
    ]);
    await expect(menu.getByRole('button')).toHaveCount(21);
    if (selection === 'legacy') {
      await prompt.press('Tab');
      await expect(prompt).toHaveValue('/impeccable shape ');
      await page.getByRole('button', { name: 'Send prompt', exact: true }).click();
      await expect
        .poll(() => fixture.commands[0]?.body)
        .toMatchObject({
          text: expect.stringMatching(/^\$impeccable shape\nUse the current interface/),
        });
      expect(open).toBeUndefined();
      return;
    }
    await menu.getByRole('button', { name: /^live / }).click();
    await expect(prompt).toHaveValue('/impeccable live ');
    const opened = context.waitForEvent('page');
    await page.getByRole('button', { name: 'Send prompt', exact: true }).click();
    const preview = await opened;
    await expect(preview.getByRole('heading', { name: 'Live preview' })).toBeVisible();
    expect(open).toEqual({ impeccable: true });
    await expect
      .poll(() => fixture.commands[0]?.body)
      .toMatchObject({
        text: expect.stringMatching(/^\$impeccable live\nUse the current interface/),
      });
  });
}
