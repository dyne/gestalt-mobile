/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { chmod, mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSkillProfile } from '../../features/skills/model/skill-profile.js';
import { SkillProfileError } from '../../features/skills/model/errors.js';
import { FilesystemSkillProfileStore } from './filesystem-skill-profile-store.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) => (await import('node:fs/promises')).rm(root, { recursive: true, force: true }))); });
async function sandbox(): Promise<string> { const root = await mkdtemp(join(tmpdir(), 'skill-profile-')); roots.push(root); return root; }
const profile = () => createSkillProfile({ name: 'Work', skills: [{ name: 'Alpha', path: '/skills/alpha/SKILL.md', enabled: true }] });

describe('FilesystemSkillProfileStore', () => {
  it('returns missing global profiles, creates their private directory, and lists names deterministically', async () => {
    const home = await sandbox();
    const store = new FilesystemSkillProfileStore(home);
    expect(await store.listGlobalProfileNames()).toEqual([]);
    expect(await store.readGlobalProfile('work')).toBeUndefined();
    await store.replaceGlobalProfile(profile());
    await store.replaceGlobalProfile(createSkillProfile({ name: 'Alpha', skills: [] }));
    expect(await store.listGlobalProfileNames()).toEqual(['alpha', 'work']);
    expect((await (await import('node:fs/promises')).stat(join(home, '.gestalt', 'skill-profiles'))).mode & 0o777).toBe(0o700);
  });

  it('atomically overwrites a global profile and leaves no temporary file', async () => {
    const home = await sandbox();
    const store = new FilesystemSkillProfileStore(home);
    await store.replaceGlobalProfile(profile());
    await store.replaceGlobalProfile(createSkillProfile({ name: 'work', skills: [] }));
    expect((await store.readGlobalProfile('work'))?.skills).toEqual([]);
    expect((await (await import('node:fs/promises')).readdir(join(home, '.gestalt', 'skill-profiles'))).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('reads only the exact workspace-root gestalt-skills.yml file', async () => {
    const workspace = await sandbox();
    const nested = join(workspace, 'nested');
    await mkdir(nested);
    await writeFile(join(workspace, 'gestalt-skills.yml'), 'version: 1\nname: project\nskills: []\n');
    await writeFile(join(nested, 'gestalt-skills.yml'), 'version: 1\nname: nested\nskills: []\n');
    await expect(new FilesystemSkillProfileStore(await sandbox()).readWorkspaceDefault(nested)).resolves.toEqual({ version: 1, name: 'nested', skills: [] });
    await expect(new FilesystemSkillProfileStore(await sandbox()).readWorkspaceDefault(workspace)).resolves.toEqual({ version: 1, name: 'project', skills: [] });
  });

  it('rejects profile symlinks and invalid YAML', async () => {
    const home = await sandbox();
    const root = join(home, '.gestalt', 'skill-profiles');
    await mkdir(root, { recursive: true });
    await writeFile(join(home, 'target.yml'), 'version: 1\nname: target\nskills: []\n');
    await symlink(join(home, 'target.yml'), join(root, 'work.yml'));
    await expect(new FilesystemSkillProfileStore(home).readGlobalProfile('work')).rejects.toBeInstanceOf(SkillProfileError);
    await chmod(join(home, 'target.yml'), 0o600);
  });

  it('deletes only an existing normalized regular global profile', async () => {
    const home = await sandbox();
    const store = new FilesystemSkillProfileStore(home);
    await store.replaceGlobalProfile(profile());
    await store.replaceGlobalProfile(createSkillProfile({ name: 'keep', skills: [] }));

    await expect(store.deleteGlobalProfile('WORK')).resolves.toBe(true);
    await expect(store.deleteGlobalProfile('work')).resolves.toBe(false);
    await expect(store.readGlobalProfile('keep')).resolves.toMatchObject({ name: 'keep' });
    await expect(store.deleteGlobalProfile('../keep')).rejects.toBeInstanceOf(SkillProfileError);
  });

  it('does not follow profile or root symlinks when deleting', async () => {
    const home = await sandbox();
    const outside = await sandbox();
    const root = join(home, '.gestalt', 'skill-profiles');
    await mkdir(root, { recursive: true });
    await writeFile(join(outside, 'target.yml'), 'version: 1\nname: target\nskills: []\n');
    await symlink(join(outside, 'target.yml'), join(root, 'work.yml'));
    await expect(new FilesystemSkillProfileStore(home).deleteGlobalProfile('work')).rejects.toBeInstanceOf(SkillProfileError);
    await expect((await import('node:fs/promises')).readFile(join(outside, 'target.yml'), 'utf8')).resolves.toContain('name: target');

    const linkedHome = await sandbox();
    await mkdir(join(linkedHome, '.gestalt'), { recursive: true });
    await symlink(outside, join(linkedHome, '.gestalt', 'skill-profiles'));
    await expect(new FilesystemSkillProfileStore(linkedHome).deleteGlobalProfile('target')).rejects.toBeInstanceOf(SkillProfileError);
    await expect((await import('node:fs/promises')).readFile(join(outside, 'target.yml'), 'utf8')).resolves.toContain('name: target');
  });
});
