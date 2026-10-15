/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readLiveConfigFile, resolveLiveConfigFiles } from './effective-config.js';
import { captureLiveSources, resolveLiveSourceInventory } from './owning-source-inventory.js';
import { observeLiveProcess } from './process-identity.js';

// The host's unrelated Native metadata/system config is not part of this
// disposable filesystem fixture. Supported-host proof exercises real ancestry.
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    lstatSync: (...args: Parameters<typeof fs.lstatSync>) => {
      if (
        [
          '/tmp/.codex',
          '/.codex',
          '/etc/codex/config.toml',
          '/etc/codex/managed_config.toml',
          '/etc/codex/requirements.toml',
        ].includes(String(args[0]))
      )
        throw Object.assign(new Error('fixture absence'), { code: 'ENOENT' });
      return fs.lstatSync(...args);
    },
  };
});

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'live-source-inventory-'));
  roots.push(root);
  const app = join(root, 'app'),
    home = join(root, 'home');
  mkdirSync(app);
  mkdirSync(home);
  const loaded = join(app, 'AGENTS.override.md'),
    shadowed = join(app, 'AGENTS.md');
  writeFileSync(loaded, 'override instruction', { mode: 0o644 });
  writeFileSync(shadowed, 'shadowed instruction', { mode: 0o644 });
  const config = join(home, 'config.toml'),
    worker = join(root, 'worker.toml');
  writeFileSync(config, 'model = "configured"\n', { mode: 0o600 });
  writeFileSync(worker, '[shell_environment_policy]\ninherit = "none"\n', { mode: 0o600 });
  const captured = captureLiveSources(app, home);
  const project = join(app, '.codex');
  mkdirSync(project);
  const configuration = {
    config: {},
    layers: [
      { name: { type: 'user', file: config }, version: '1', config: {} },
      { name: { type: 'project', dotCodexFolder: project }, version: '1', config: {} },
    ],
  };
  const input = {
    captured,
    configuration,
    threadConfig: {},
    selection: { instructionSources: [loaded] },
    runtime: observeLiveProcess(process.pid),
    policyDigest: 'a'.repeat(64),
    workerConfig: readLiveConfigFile(worker),
    approved: { mcpServers: {}, plugins: {} },
  };
  return { input, loaded, shadowed, app, home, project, config };
}

describe('original Native source inventory', () => {
  it('separates actual config, directory, absent and loaded/shadowed instruction sources', () => {
    const { input, loaded, shadowed, project, config } = fixture();
    const result = resolveLiveSourceInventory(input);
    expect(result.schemaVersion).toBe(2);
    expect(result.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'file', role: 'user', path: config }),
        expect.objectContaining({ kind: 'file', role: 'sandbox-worker' }),
        expect.objectContaining({ kind: 'directory', role: 'project', path: project }),
        expect.objectContaining({ kind: 'absent', role: 'system', path: '/etc/codex/config.toml' }),
        expect.objectContaining({ kind: 'instruction', path: loaded }),
        expect.objectContaining({ kind: 'instruction-candidate', path: shadowed }),
      ]),
    );
    expect(
      result.sources
        .filter((source) => source.kind === 'file')
        .some((source) => source.path === project),
    ).toBe(false);
    // The regular resolver still rejects an unproven project directory.
    expect(() => resolveLiveConfigFiles({ ...input, appRoot: input.captured.appRoot })).toThrow(
      'LIVE_EFFECTIVE_CONFIG_UNAVAILABLE',
    );
  });
  it.each(['loaded', 'shadowed', 'absent'] as const)(
    'rejects a changed %s instruction candidate independently of Native selection',
    (kind) => {
      const { input, loaded, shadowed, home } = fixture();
      writeFileSync(
        kind === 'loaded' ? loaded : kind === 'shadowed' ? shadowed : join(home, 'AGENTS.md'),
        'changed',
      );
      expect(() => resolveLiveSourceInventory(input)).toThrow('LIVE_EFFECTIVE_CONFIG_UNAVAILABLE');
    },
  );
  it('rejects incomplete or forged loaded-instruction lists', () => {
    const { input, loaded, app } = fixture();
    for (const instructionSources of [[loaded, loaded], [join(app, 'untracked.md')], undefined])
      expect(() =>
        resolveLiveSourceInventory({ ...input, selection: { instructionSources } }),
      ).toThrow('LIVE_EFFECTIVE_CONFIG_UNAVAILABLE');
  });
  it('rejects project content and replaced directory symlinks', () => {
    const { input, project, home } = fixture();
    writeFileSync(join(project, 'config.toml'), 'hooks = {}');
    expect(() => resolveLiveSourceInventory(input)).toThrow('LIVE_EFFECTIVE_CONFIG_UNAVAILABLE');
    rmSync(project, { recursive: true });
    symlinkSync(home, project);
    expect(() => resolveLiveSourceInventory(input)).toThrow('LIVE_EFFECTIVE_CONFIG_UNAVAILABLE');
  });
  it('rejects unknown or nonempty project layers, including disabled layers', () => {
    const { input, app, project } = fixture();
    for (const layer of [
      { name: { type: 'project', dotCodexFolder: join(app, 'other') }, config: {} },
      { name: { type: 'project', dotCodexFolder: project }, config: { hooks: {} } },
    ])
      expect(() =>
        resolveLiveSourceInventory({
          ...input,
          configuration: {
            ...input.configuration,
            layers: [
              ...input.configuration.layers,
              { ...layer, version: '1', disabledReason: 'untrusted' },
            ],
          },
        }),
      ).toThrow('LIVE_EFFECTIVE_CONFIG_UNAVAILABLE');
  });
  it('refuses pre-existing metadata before original birth, including an empty directory', () => {
    const { app, home } = fixture();
    expect(() => captureLiveSources(app, home)).toThrow('LIVE_RUNTIME_PROVENANCE_UNAVAILABLE');
  });
  it('rejects changes to actual worker configuration and effective launch surfaces', () => {
    const { input } = fixture();
    writeFileSync(input.workerConfig.path, 'changed');
    expect(() => resolveLiveSourceInventory(input)).toThrow('LIVE_EFFECTIVE_CONFIG_UNAVAILABLE');
    expect(() =>
      resolveLiveSourceInventory({
        ...input,
        threadConfig: { hooks: { executable: 'unapproved' } },
      }),
    ).toThrow('LIVE_EFFECTIVE_CONFIG_UNAVAILABLE');
  });
});
