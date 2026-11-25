/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { installExecuteFixture, openExecuteEntry } from './execute-plan-fixture.js';

async function dialog(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Execute', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Execute plan' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'OK', exact: true })).toBeEnabled();
}

test('one preparation enables Execute and survives skill profile changes through launch', async ({
  page,
}) => {
  const { state } = await installExecuteFixture(page);
  state.profiles = ['supervisor', 'reviewer'];
  await page.goto('/');
  await openExecuteEntry(page, 'catalog');
  await dialog(page);
  const select = page.getByRole('combobox', { name: 'Supervisor Skill profile' });
  const ok = page.getByRole('button', { name: 'OK', exact: true });
  for (const profile of ['supervisor', 'reviewer', '', 'reviewer']) {
    await select.selectOption(profile);
    await expect(ok).toBeEnabled();
  }
  expect(state.prepareCount).toBe(1);
  await ok.click();
  await expect.poll(() => state.published).toBe(true);
  expect(state.prepareCount).toBe(1);
  expect(state.launchRequests).toMatchObject([
    { expectedRevision: 'original', skillProfile: 'reviewer' },
  ]);
});

test('Execute shows the existing session and requires confirmation once it is idle', async ({
  page,
}) => {
  const { state, source } = await installExecuteFixture(page);
  state.workspaceSession = { sessionId: source.id, replaceAllowed: false };
  source.sessionStatus = {
    state: 'working',
    reason: 'rootTurn',
    confidence: 'fresh',
    observedAt: '2026-11-08T00:00:00Z',
    nextExpectedAction: 'Wait for the turn to finish.',
  };
  await page.goto('/');
  await openExecuteEntry(page, 'catalog');
  const execute = page.getByRole('button', { name: 'Execute', exact: true });
  const confirmation = page.getByRole('dialog', { name: 'Execute plan' });
  await execute.click();
  const status = confirmation.getByRole('region', { name: 'Session open in this workspace' });
  const replace = confirmation.getByRole('button', { name: 'Replace and execute' });
  await expect(status.getByText('Working', { exact: true })).toBeVisible();
  await expect(replace).toBeDisabled();
  await confirmation.getByRole('button', { name: 'Cancel' }).click();
  expect(state.launchRequests).toHaveLength(0);

  await execute.click();
  await expect(status.getByText('Working', { exact: true })).toBeVisible();
  state.workspaceSession = { sessionId: source.id, replaceAllowed: true };
  // The status read can observe new work after an eligible preparation.
  const refresh = confirmation.getByRole('button', { name: 'Refresh' });
  await refresh.click();
  await expect(refresh).toBeEnabled();
  await expect(status.getByText('Working', { exact: true })).toBeVisible();
  await expect(replace).toBeDisabled();
  source.sessionStatus = {
    ...source.sessionStatus,
    state: 'idle',
    reason: 'complete',
    nextExpectedAction: 'Ready for the next request.',
  };
  await confirmation.getByRole('button', { name: 'Refresh' }).click();
  await expect(status.getByText('Idle', { exact: true })).toBeVisible();
  await expect(status.getByText(/history stay saved/)).toBeVisible();
  await expect(replace).toBeEnabled();
  expect(state.launchRequests).toHaveLength(0);
  await replace.click();
  await expect.poll(() => state.launchRequests).toMatchObject([{ replaceSessionId: source.id }]);
});

test('native modal keeps background inert, preserves keyboard order and Escape/Cancel restore Execute', async ({
  page,
}, testInfo) => {
  const { state } = await installExecuteFixture(page);
  await page.goto('/');
  await openExecuteEntry(page, 'catalog');
  await dialog(page);
  const select = page.getByRole('combobox', { name: 'Supervisor Skill profile' });
  const ok = page.getByRole('button', { name: 'OK', exact: true });
  const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
  const executeDialog = page.getByRole('dialog', { name: 'Execute plan' });
  const focusTransitions: unknown[] = [];
  const snapshot = async (label: string) => {
    const value = await page.evaluate(
      (label) => ({
        label,
        hasFocus: document.hasFocus(),
        activeTag: document.activeElement?.tagName,
        activeId: document.activeElement?.id,
        activeText: document.activeElement?.textContent?.trim().slice(0, 40),
        insideModal: !!document.activeElement?.closest('dialog[open]'),
      }),
      label,
    );
    focusTransitions.push(value);
    return value;
  };
  await expect(select).toBeFocused();
  expect(await executeDialog.evaluate((element) => element.matches(':modal'))).toBe(true);
  // Native showModal makes background controls inert even to programmatic focus.
  expect(
    await page.getByRole('button', { name: 'Execute', exact: true }).evaluate((button) => {
      button.focus();
      return document.activeElement === button;
    }),
  ).toBe(false);
  await page.keyboard.press('Tab');
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(ok).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(select).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  const boundary = await snapshot('reverse boundary');
  // Chromium may put keyboard focus in browser chrome, as the minimal native
  // comparison demonstrates. It must never focus an inert background control.
  expect(!boundary.hasFocus || boundary.insideModal).toBe(true);
  if (!boundary.hasFocus) expect(boundary.activeTag).toBe('BODY');
  await page.keyboard.press('Tab');
  await expect(select).toBeFocused();
  await snapshot('Tab re-entry');
  await page.keyboard.press('Escape');
  await expect(executeDialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Execute', exact: true })).toBeFocused();
  await dialog(page);
  await cancel.click();
  await expect(page.getByRole('button', { name: 'Execute', exact: true })).toBeFocused();
  expect(state.prepareCount).toBe(1);
  await writeFile(
    testInfo.outputPath('focus-transitions.json'),
    JSON.stringify({
      nativeModalInertness: true,
      focusTransitions,
      initialLoadedFocus: 'Supervisor Skill profile',
    }),
  );
  expect(state.launchRequests).toEqual([]);
  expect(state.published).toBe(false);
  expect(state.opens).toEqual([]);
  expect(state.toggles).toEqual([]);
});

for (const code of [
  'INVALID_PLAN',
  'NO_REMAINING_WORK',
  'CODEX_UNAVAILABLE',
  'CODEX_NOT_FOUND',
] as const) {
  test(`authoritative ${code} stays disabled, including unknown eligibility while reading`, async ({
    page,
  }) => {
    const { state } = await installExecuteFixture(page);
    let release!: () => void;
    state.prepareGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reason =
      code === 'CODEX_NOT_FOUND'
        ? 'Codex CLI was not found when Mobile started. Install Codex and restart Mobile.'
        : 'Execution is unavailable for this document.';
    state.blocked = {
      kind: 'blocked',
      code,
      reason,
    };
    try {
      await page.goto('/');
      await page.getByLabel('Primary').getByRole('button', { name: 'Plan', exact: true }).click();
      await page.getByRole('button', { name: 'Open Project roadmap' }).click();
      const execute = page.getByRole('button', { name: 'Execute', exact: true });
      await expect(execute).toBeDisabled();
      const checking = page
        .getByRole('status')
        .filter({ hasText: 'Checking whether this plan can be executed…' });
      await expect(checking).toBeVisible();
      const animation = () =>
        checking.evaluate((element) => getComputedStyle(element, '::before').animationName);
      await expect.poll(animation).not.toBe('none');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await expect.poll(animation).toBe('none');
      release();
      await expect(page.getByText(reason)).toBeVisible();
      await expect(checking).toHaveCount(0);
      await expect(execute).toBeDisabled();
      expect(await execute.getAttribute('aria-describedby')).toBeTruthy();
      expect(state.launchRequests).toEqual([]);
    } finally {
      release();
    }
  });
}

test('an empty profile list offers None and rapid native clicks submit one launch', async ({
  page,
}) => {
  const { state } = await installExecuteFixture(page);
  state.profiles = [];
  let release!: () => void;
  state.launchGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await page.goto('/');
    await openExecuteEntry(page, 'catalog');
    await dialog(page);
    await expect(page.getByRole('combobox').locator('option')).toHaveText(['None']);
    await expect(page.getByRole('combobox')).toHaveValue('');
    await page
      .getByRole('button', { name: 'OK', exact: true })
      .evaluate((button: HTMLButtonElement) => {
        button.click();
        button.click();
        button.click();
      });
    await expect.poll(() => state.launchRequests.length).toBe(1);
    await expect(page.getByRole('button', { name: 'Starting…' })).toBeDisabled();
    release();
    await expect(
      page.getByLabel('Primary').getByRole('button', { name: 'Chat', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(state.launchRequests[0]!.skillProfile).toBe('');
    expect(state.opens).toEqual([]);
    expect(state.toggles).toEqual([]);
  } finally {
    release();
  }
});

test('a deleted selected profile stays selected until an explicit available choice, with no silent fallback', async ({
  page,
}) => {
  const { state } = await installExecuteFixture(page, { defaultProfile: 'supervisor' });
  await page.goto('/');
  await openExecuteEntry(page, 'catalog');
  await dialog(page);
  state.profiles = [];
  await page.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'The selected skill profile disappeared.' }),
  ).toBeVisible();
  await expect(page.getByRole('combobox')).toHaveValue('supervisor');
  await expect(page.getByRole('button', { name: 'OK', exact: true })).toBeDisabled();
  expect(state.published).toBe(false);
  await page.getByRole('combobox').selectOption({ label: 'None' });
  await expect(page.getByRole('button', { name: 'OK', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(
    page.getByLabel('Primary').getByRole('button', { name: 'Chat', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  expect(state.launchRequests.map((request) => request.skillProfile)).toEqual(['supervisor', '']);
});

test('a failed explicit refresh blocks replacement until refresh succeeds', async ({ page }) => {
  const { state, source } = await installExecuteFixture(page);
  state.workspaceSession = { sessionId: source.id, replaceAllowed: false };
  source.sessionStatus = {
    state: 'idle',
    reason: 'complete',
    confidence: 'fresh',
    observedAt: '2026-11-08T00:00:00Z',
    nextExpectedAction: 'Ready for the next request.',
  };
  await page.goto('/');
  await openExecuteEntry(page, 'catalog');
  await page.getByRole('button', { name: 'Execute', exact: true }).click();
  const refresh = page.getByRole('button', { name: 'Refresh', exact: true });
  const replace = page.getByRole('button', { name: 'Replace and execute' });
  state.readError = true;
  await refresh.click();
  await expect(replace).toBeDisabled();
  await expect(page.getByRole('alert')).toContainText('Relay request failed (503).');
  expect(state.launchRequests).toEqual([]);
  state.readError = false;
  state.workspaceSession = { sessionId: source.id, replaceAllowed: true };
  await refresh.click();
  await expect(replace).toBeEnabled();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(state.published).toBe(false);
});

test('source revision changes require refresh and new confirmation before creating a session', async ({
  page,
}) => {
  const { state } = await installExecuteFixture(page);
  await page.goto('/');
  await openExecuteEntry(page, 'catalog');
  await dialog(page);
  state.revision = 'changed';
  await page.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'The plan changed.' })).toBeVisible();
  expect(state.published).toBe(false);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Close plan and return to list' }).click();
  await page.getByRole('button', { name: 'Open Project roadmap' }).click();
  await dialog(page);
  await page.getByRole('button', { name: 'OK', exact: true }).click();
  await expect.poll(() => state.published).toBe(true);
  expect(state.launchRequests.map((request) => request.expectedRevision)).toEqual([
    'original',
    'changed',
  ]);
  expect(state.opens).toEqual([]);
  expect(state.toggles).toEqual([]);
});

test('retained full viewer alone offers Execute; later supervisor publication updates normal Autopilot', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1536, height: 900 });
  const fixture = await installExecuteFixture(page, { entry: 'retained' });
  await page.goto('/');
  await page.getByLabel('Primary').getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Full plan', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Execute', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Full plan', exact: true }).click();
  await dialog(page);
  await page.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(
    page.getByLabel('Primary').getByRole('button', { name: 'Chat', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  expect(fixture.state.launchRequests[0]!.reference).toEqual({
    kind: 'retained-session',
    sessionId: 'source-session',
  });
  await expect.poll(() => fixture.state.socket !== null).toBe(true);
  // Ordinary Chat exposes this control only after a plan is actually assigned.
  await expect(page.locator('#chat-autopilot-launched-supervisor-button')).toHaveCount(0);
  expect(fixture.state.toggles).toEqual([]);
  expect(fixture.state.opens).toEqual([]);
  fixture.activate();
  await expect(page.locator('#chat-autopilot-launched-supervisor-button')).toHaveAccessibleName(
    'Autopilot: Monitoring',
  );
  await expect(page.locator('#chat-autopilot-launched-supervisor-button')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(fixture.state.launchRequests).toHaveLength(1);
  expect(fixture.state.toggles).toEqual([]);
  expect(fixture.state.opens).toEqual([]);
});
