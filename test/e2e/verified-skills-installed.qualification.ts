/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, test, type Page } from '@playwright/test';

type Skill = {
  name: string;
  path: string;
  enabled?: boolean;
  effectiveEnabled?: boolean;
  provenance?: { kind: string };
};
type NativeSession = {
  label: string;
  generated: { config: { skills: { config: { path: string; enabled: boolean }[] } } };
  observedProcessSkillConfig: { path: string; enabled: boolean }[];
  threadStartAccepted: { id: string };
  skills: Skill[];
  archived: boolean;
  modelTurns: number;
};
type Evidence = {
  fixture: string;
  managedPath: string;
  receipt: { revision: string; verifiedSource: boolean; version: string } | null;
  profileSha256: string;
  nativeSessions: NativeSession[];
  maintenance: { operation: string; profileUnchanged?: boolean }[];
  liveOwnedProcesses: number;
};

async function editor(page: Page, saved = true) {
  await page.goto('/');
  await page.getByRole('treeitem', { name: /unrelated workspace/ }).click();
  await page.getByText('Advanced settings', { exact: true }).click();
  await page.getByRole('button', { name: 'Manage skill profiles', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Manage skill profiles' })).toBeFocused();
  if (saved) await page.getByLabel('Skill profile', { exact: true }).selectOption('qualification');
}

test('qualifies the real installed collection through UI, native sessions, maintenance and complete profiles', async ({
  page,
  request,
}, testInfo) => {
  const read = async () => {
    const response = await request.get('/__fixture/evidence');
    expect(response.ok()).toBe(true);
    return response.json() as Promise<Evidence>;
  };
  const maintain = async (operation: string) => {
    const response = await request.post(`/__fixture/maintenance/${operation}`);
    expect(response.ok(), await response.text()).toBe(true);
    return response.json() as Promise<Evidence>;
  };
  const catalog = async (refresh = false) => {
    const response = await request.get(
      `/api/skills?workspaceId=workspace&profile=default${refresh ? '&refresh=true' : ''}`,
    );
    expect(response.ok()).toBe(true);
    return response.json() as Promise<{ skills: Skill[] }>;
  };
  const native = async (enabled: boolean, added = false) => {
    await page.getByRole('button', { name: 'Close skill profile editor' }).click();
    await page.getByLabel('Skills profile').selectOption('qualification');
    const started = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/sessions') && response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Create session', exact: true }).click();
    const response = await started;
    expect(response.status(), await response.text()).toBe(202);
    const session = (await response.json()) as {
      id: string;
      effectiveSkillSelection: { skills: Skill[] };
    };
    const evidence = await read();
    const observed = evidence.nativeSessions.find((probe) => probe.label === session.id)!;
    expect(observed.threadStartAccepted.id).toBeTruthy();
    expect(observed.archived).toBe(true);
    expect(observed.modelTurns).toBe(0);
    expect(observed.generated.config.skills.config).toContainEqual({
      path: evidence.managedPath,
      enabled,
    });
    expect(observed.observedProcessSkillConfig).toContainEqual({
      path: evidence.managedPath,
      enabled,
    });
    expect(observed.skills.filter((skill) => skill.name === 'nuklear-gui')).toEqual([
      expect.objectContaining({ path: evidence.managedPath, enabled }),
    ]);
    expect(observed.skills.find((skill) => skill.name === 'local-control')?.enabled).toBe(true);
    expect(observed.skills.find((skill) => skill.name === 'gestalt:org-plan')?.enabled).toBe(true);
    if (added)
      expect(observed.skills.find((skill) => skill.name === 'new-optional')?.enabled).toBe(false);
    return evidence;
  };

  const initial = await read();
  expect(initial.receipt).toMatchObject({
    revision: process.env.VERIFIED_SKILLS_REF,
    verifiedSource: true,
    version: '0.1.0',
  });
  await editor(page, false);
  const optional = () => page.getByRole('checkbox', { name: /nuklear-gui.*Gestalt verified/ });
  await expect(optional()).toBeChecked();
  await expect(optional()).toBeEnabled();
  await expect(page.getByText('Gestalt verified', { exact: true })).toHaveCount(1);
  await expect(page.getByRole('checkbox', { name: /local-control/ })).toBeChecked();
  await expect(page.getByText('gestalt:org-plan', { exact: true })).toHaveCount(0);
  const installed = await catalog();
  expect(installed.skills.filter((skill) => skill.name === 'nuklear-gui')).toHaveLength(1);
  expect(installed.skills.find((skill) => skill.name === 'nuklear-gui')?.provenance?.kind).toBe(
    'gestalt-verified',
  );
  expect(
    installed.skills.find((skill) => skill.name === 'local-control')?.provenance,
  ).toBeUndefined();
  await optional().click();
  await page.getByLabel('Save as').fill('qualification');
  await page.getByRole('button', { name: 'Save profile', exact: true }).click();
  await expect(page.getByText('Profile saved.')).toBeVisible();

  await editor(page);
  await expect(optional()).not.toBeChecked();
  await optional().focus();
  await page.screenshot({ path: testInfo.outputPath('installed-disabled-verified.png') });
  const disabled = await native(false);
  const profileDigest = disabled.profileSha256;
  const updated = await maintain('official-update');
  expect(updated.profileSha256).toBe(profileDigest);
  expect(updated.receipt).toEqual(disabled.receipt);
  await editor(page);
  await expect(optional()).not.toBeChecked();
  expect((await native(false)).profileSha256).toBe(profileDigest);

  await editor(page);
  const skillBefore = (await catalog()).skills;
  for (const operation of ['receipt-missing', 'receipt-tampered']) {
    await maintain(operation);
    // Cached reads must revalidate provenance without changing discovery/selection.
    const withoutBadge = (await catalog()).skills;
    const plain = (skill: Skill) => {
      const value = { ...skill };
      delete value.provenance;
      return value;
    };
    expect(withoutBadge.map(plain)).toEqual(skillBefore.map(plain));
    expect(withoutBadge.find((skill) => skill.name === 'nuklear-gui')?.provenance).toBeUndefined();
    await page.getByRole('button', { name: 'Refresh skills' }).click();
    await expect(page.getByText('Gestalt verified', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('checkbox', { name: /nuklear-gui/ })).not.toBeChecked();
    await expect(page.getByRole('checkbox', { name: /local-control/ })).toBeChecked();
    await maintain('receipt-restore');
    await page.getByRole('button', { name: 'Refresh skills' }).click();
    await expect(optional()).not.toBeChecked();
  }
  const contentUpdate = await maintain('content-update');
  expect(contentUpdate.profileSha256).toBe(profileDigest);
  expect(contentUpdate.receipt).toMatchObject({ version: '0.1.1', verifiedSource: false });
  expect(contentUpdate.receipt?.revision).not.toBe(initial.receipt?.revision);
  await page.getByRole('button', { name: 'Refresh skills' }).click();
  await expect(page.getByText('Gestalt verified', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: /new-optional/ })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: /nuklear-gui/ })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: /local-control/ })).toBeChecked();
  expect((await native(false, true)).profileSha256).toBe(profileDigest);

  await editor(page);
  await page.getByRole('checkbox', { name: /nuklear-gui/ }).click();
  await page.getByRole('button', { name: 'Save profile', exact: true }).click();
  await expect(page.getByText('Profile saved.')).toBeVisible();
  await editor(page);
  await expect(page.getByRole('checkbox', { name: /nuklear-gui/ })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: /new-optional/ })).not.toBeChecked();
  await page.getByRole('checkbox', { name: /nuklear-gui/ }).focus();
  await page.screenshot({ path: testInfo.outputPath('updated-reenabled-unverified-override.png') });
  await native(true, true);
  const settled = await request.post('/__fixture/settle');
  expect(settled.ok()).toBe(true);
  const final = (await settled.json()) as Evidence;
  expect(final.nativeSessions).toHaveLength(4);
  expect(final.liveOwnedProcesses).toBe(0);
  await testInfo.attach('installed-flow', {
    body: JSON.stringify(final),
    contentType: 'application/json',
  });
});
