/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdir, mkdtemp, readFile, readlink, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { kimiStateBase, prepareKimiShareDir } from './kimi-share-dir.js';
import { SkillProfileError } from '../../features/skills/model/errors.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function sandbox(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kimi-share-dir-'));
  roots.push(root);
  return root;
}
async function fakeKimiHome(root: string): Promise<string> {
  const home = join(root, 'kimi-home');
  await mkdir(join(home, 'credentials'), { recursive: true });
  await writeFile(join(home, 'device_id'), 'device-1');
  await writeFile(join(home, 'config.toml'), 'default_model = "kimi-k3"\n');
  return home;
}

describe('kimiStateBase', () => {
  it('nests gestalt kimi state under the relay state directory', () => {
    expect(kimiStateBase('/tmp/home')).toBe('/tmp/home/.codex-gestalt/gestalt-mobile/kimi');
  });
});

describe('prepareKimiShareDir', () => {
  it('symlinks auth material and copies the user config into the isolated share dir', async () => {
    const root = await sandbox();
    const source = await fakeKimiHome(root);
    const result = prepareKimiShareDir({
      stateBase: join(root, 'state'),
      profileKey: 'default',
      sourceShareDir: source,
    });
    expect(await readlink(join(result.shareDir, 'credentials'))).toBe(join(source, 'credentials'));
    expect(await readlink(join(result.shareDir, 'device_id'))).toBe(join(source, 'device_id'));
    expect(await readFile(join(result.shareDir, 'config.toml'), 'utf8')).toBe(
      'default_model = "kimi-k3"\n',
    );
    expect((await stat(result.shareDir)).isDirectory()).toBe(true);
    expect((await stat(result.skillsDir)).isDirectory()).toBe(true);
  });

  it('keeps a newer user config in sync on later prepares', async () => {
    const root = await sandbox();
    const source = await fakeKimiHome(root);
    const stateBase = join(root, 'state');
    const first = prepareKimiShareDir({ stateBase, profileKey: 'default', sourceShareDir: source });
    await writeFile(join(source, 'config.toml'), 'default_model = "kimi-k4"\n');
    // Make the source clearly newer regardless of filesystem timestamp granularity.
    const future = new Date(Date.now() + 60_000);
    await utimes(join(source, 'config.toml'), future, future);
    const second = prepareKimiShareDir({
      stateBase,
      profileKey: 'default',
      sourceShareDir: source,
    });
    expect(second.shareDir).toBe(first.shareDir);
    expect(await readFile(join(second.shareDir, 'config.toml'), 'utf8')).toBe(
      'default_model = "kimi-k4"\n',
    );
  });

  it('does not copy config.toml when the user has none', async () => {
    const root = await sandbox();
    const source = join(root, 'empty-home');
    await mkdir(source, { recursive: true });
    const result = prepareKimiShareDir({
      stateBase: join(root, 'state'),
      profileKey: 'default',
      sourceShareDir: source,
    });
    await expect(stat(join(result.shareDir, 'config.toml'))).rejects.toThrow();
  });

  it('rejects profile keys that could escape the state directory', async () => {
    const root = await sandbox();
    const source = await fakeKimiHome(root);
    expect(() =>
      prepareKimiShareDir({
        stateBase: join(root, 'state'),
        profileKey: '../escape',
        sourceShareDir: source,
      }),
    ).toThrow(SkillProfileError);
  });
});
