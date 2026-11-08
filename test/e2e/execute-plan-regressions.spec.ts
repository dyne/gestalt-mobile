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
  expect(await page.getByRole('dialog').evaluate((element) => element.matches(':modal'))).toBe(
    true,
  );
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
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Execute', exact: true })).toBeFocused();
  await dialog(page);
  await cancel.click();
  await expect(page.getByRole('button', { name: 'Execute', exact: true })).toBeFocused();
  let release!: () => void;
  state.prepareGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await page.getByRole('button', { name: 'Execute', exact: true }).click();
    await expect(select).toBeDisabled();
    const loadingFocus = await page.evaluate(() => document.activeElement?.tagName);
    await page.keyboard.press('Tab');
    await expect(cancel).toBeFocused();
    release();
    await expect(select).toBeEnabled();
    await expect(cancel).toBeFocused();
    await writeFile(
      testInfo.outputPath('focus-transitions.json'),
      JSON.stringify({
        loadingFocus,
        afterUserTab: 'Cancel',
        afterFreshRead: 'Cancel',
        nativeModalInertness: true,
        focusTransitions,
        initialLoadedFocus: 'Supervisor Skill profile',
      }),
    );
    await cancel.click();
  } finally {
    release();
  }
  expect(state.launchRequests).toEqual([]);
  expect(state.published).toBe(false);
  expect(state.opens).toEqual([]);
  expect(state.toggles).toEqual([]);
});

for (const code of ['INVALID_PLAN', 'NO_REMAINING_WORK', 'CODEX_UNAVAILABLE'] as const) {
  test(`authoritative ${code} stays disabled, including unknown eligibility while reading`, async ({
    page,
  }) => {
    const { state } = await installExecuteFixture(page);
    let release!: () => void;
    state.prepareGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    state.blocked = {
      kind: 'blocked',
      code,
      reason: 'Execution is unavailable for this document.',
    };
    try {
      await page.goto('/');
      await page.getByLabel('Primary').getByRole('button', { name: 'Plan', exact: true }).click();
      await page.getByRole('button', { name: 'Open Project roadmap' }).click();
      const execute = page.getByRole('button', { name: 'Execute', exact: true });
      await expect(execute).toBeDisabled();
      await expect(page.getByText('Checking whether this plan can be executed…')).toBeVisible();
      release();
      await expect(page.getByText('Execution is unavailable for this document.')).toBeVisible();
      await expect(execute).toBeDisabled();
      expect(await execute.getAttribute('aria-describedby')).toBeTruthy();
      expect(state.launchRequests).toEqual([]);
    } finally {
      release();
    }
  });
}

test('an empty profile list confirms Default and rapid native clicks submit one launch', async ({
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
    await expect(page.getByRole('option')).toHaveCount(1);
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
  await page.getByRole('combobox').selectOption('');
  await expect(page.getByRole('button', { name: 'OK', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(
    page.getByLabel('Primary').getByRole('button', { name: 'Chat', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  expect(state.launchRequests.map((request) => request.skillProfile)).toEqual(['supervisor', '']);
});

test('a failed fresh profile read blocks OK until explicit successful refresh', async ({
  page,
}) => {
  const { state } = await installExecuteFixture(page);
  await page.goto('/');
  await openExecuteEntry(page, 'catalog');
  state.readError = true;
  await page.getByRole('button', { name: 'Execute', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'OK', exact: true })).toBeDisabled();
  await expect(page.getByRole('alert')).toContainText('Relay request failed (503).');
  expect(state.launchRequests).toEqual([]);
  state.readError = false;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('button', { name: 'OK', exact: true })).toBeEnabled();
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
