/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveLiveConfigFiles } from './effective-config.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'live-effective-config-'));
  roots.push(root);
  const path = join(root, 'config.toml');
  const bytes = 'model = "configured-model"\n';
  writeFileSync(path, bytes, { mode: 0o600 });
  const layer = {
    name: { type: 'user', file: path, profile: null },
    version: 'native-version',
    config: {},
    disabledReason: null as string | null,
  };
  const input = {
    configuration: { config: {}, layers: [layer] },
    threadConfig: {},
    approved: { mcpServers: {}, plugins: {} },
  };
  return { root, path, bytes, layer, input };
}
describe('owning configuration inventory', () => {
  it('pins the original supported snapshot-disabled source without exempting project or launch surfaces', () => {
    const { input, path, layer, root } = fixture();
    const bytes = '[features]\nshell_snapshot = false\nshell_snapshot_v2 = false\n';
    writeFileSync(path, bytes, { mode: 0o600 });
    const config = { features: { shell_snapshot: false, shell_snapshot_v2: false } };
    const observed = {
      ...input,
      configuration: { config, layers: [{ ...layer, config }] },
    };
    expect(resolveLiveConfigFiles(observed)).toEqual([
      { path, sha256: createHash('sha256').update(bytes).digest('hex') },
    ]);
    expect(observed.configuration.config).toEqual(config);
    mkdirSync(join(root, '.codex'), { mode: 0o700 });
    expect(() =>
      resolveLiveConfigFiles({
        ...observed,
        configuration: {
          config,
          layers: [
            ...observed.configuration.layers,
            {
              name: { type: 'project', dotCodexFolder: join(root, '.codex') },
              version: 'native-project',
              config: {},
              disabledReason: null,
            },
          ],
        },
      }),
    ).toThrow('LIVE_EFFECTIVE_CONFIG_UNAVAILABLE');
    expect(() =>
      resolveLiveConfigFiles({
        ...observed,
        threadConfig: { mcp_servers: { unsupported: { command: 'unapproved' } } },
      }),
    ).toThrow('LIVE_EFFECTIVE_CONFIG_UNAVAILABLE');
  });
  it('refuses native directory-only project provenance even when config.toml does not exist', () => {
    const { input, layer, root } = fixture();
    const folder = join(root, '.codex');
    mkdirSync(folder, { mode: 0o700 });
    const project = {
      name: { type: 'project', dotCodexFolder: folder },
      version: 'native-empty-project-version',
      config: {},
    };
    const observed = { ...input, configuration: { config: {}, layers: [project, layer] } };
    expect(() => resolveLiveConfigFiles(observed)).toThrow('LIVE_EFFECTIVE_CONFIG_UNAVAILABLE');
    // Empty-looking config must not conceal the significant subfolders the
    // native loader intentionally represents with this directory-only layer.
    mkdirSync(join(folder, 'hooks'), { mode: 0o700 });
    writeFileSync(join(folder, 'hooks', 'unapproved'), 'unapproved', { mode: 0o600 });
    expect(() => resolveLiveConfigFiles(observed)).toThrow('LIVE_EFFECTIVE_CONFIG_UNAVAILABLE');
    expect(() =>
      resolveLiveConfigFiles({
        ...observed,
        configuration: { config: {}, layers: [{ ...project, disabledReason: 'untrusted' }, layer] },
      }),
    ).toThrow('LIVE_EFFECTIVE_CONFIG_UNAVAILABLE');
  });
  it('identifies an unapproved disabled thread MCP surface without logging names or transports', () => {
    const { input } = fixture();
    const canary = 'PRIVATE-TRANSPORT-CANARY';
    try {
      resolveLiveConfigFiles({
        ...input,
        threadConfig: { mcp_servers: { [canary]: { command: canary, enabled: false } } },
      });
      throw new Error('EXPECTED_REFUSAL');
    } catch (error) {
      expect(error).toMatchObject({
        message: 'LIVE_EFFECTIVE_CONFIG_UNAVAILABLE',
        liveConfigDiagnostics: { stage: 'approved-launch-surface-mcp_servers' },
        liveLaunchInventory: {
          mcp_servers: { thread: { type: 'object', count: 1 }, matchesApproved: false },
        },
      });
      expect(JSON.stringify(error)).not.toContain(canary);
    }
  });
  it('inventories enabled native layers that omit disabledReason without omitting source bytes', () => {
    const { input, path, bytes, layer } = fixture();
    const { name, version, config } = layer;
    const enabled = { name, version, config };
    const nativeInput = { ...input, configuration: { config: {}, layers: [enabled] } };
    expect(resolveLiveConfigFiles(nativeInput)).toEqual([
      { path, sha256: createHash('sha256').update(bytes).digest('hex') },
    ]);
    expect(() =>
      resolveLiveConfigFiles({
        ...nativeInput,
        configuration: { config: {}, layers: [{ ...enabled, config: [] }] },
      }),
    ).toThrow('LIVE_EFFECTIVE_CONFIG_UNAVAILABLE');
    expect(() =>
      resolveLiveConfigFiles({
        ...nativeInput,
        configuration: { config: {}, layers: [{ ...enabled, disabledReason: false }] },
      }),
    ).toThrow('LIVE_EFFECTIVE_CONFIG_UNAVAILABLE');
  });
  it('reports only fixed shape diagnostics for rejected native responses', () => {
    const { input, path, layer } = fixture();
    const canary = 'PRIVATE-CONFIG-CANARY';
    try {
      resolveLiveConfigFiles({
        ...input,
        configuration: {
          config: { private: canary },
          layers: [{ ...layer, version: 7, name: { type: canary, file: path } }],
        },
      });
      throw new Error('EXPECTED_REFUSAL');
    } catch (error) {
      expect(error).toMatchObject({
        message: 'LIVE_EFFECTIVE_CONFIG_UNAVAILABLE',
        liveConfigDiagnostics: {
          stage: 'response-shape',
          shapeIssues: [{ field: 'layers.0.version', code: 'invalid_type' }],
          layers: [{ source: 'unrecognized', versionType: 'number' }],
        },
      });
      const serialized = JSON.stringify(error);
      expect(serialized).not.toContain(canary);
      expect(serialized).not.toContain(path);
    }
  });
  it('inventories the observed user configuration and child role configuration bytes', () => {
    const { root, path, bytes, input } = fixture();
    const role = join(root, 'role.toml');
    writeFileSync(role, 'model_reasoning_effort = "high"\n');
    input.threadConfig = { agents: { worker: { config_file: role } } };
    const files = resolveLiveConfigFiles(input);
    expect(files.map((file) => file.path)).toEqual([path, role].sort());
    expect(files.find((file) => file.path === path)?.sha256).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    );
    writeFileSync(path, 'model = "changed-model"\n');
    expect(resolveLiveConfigFiles(input)).not.toEqual(files);
  });
  it('cannot conceal an ambient MCP server with an empty thread override', () => {
    const { input } = fixture();
    input.configuration.config = { mcp_servers: { unknown: { command: '/unapproved' } } };
    input.threadConfig = { mcp_servers: {} };
    expect(() => resolveLiveConfigFiles(input)).toThrow('LIVE_EFFECTIVE_CONFIG_UNAVAILABLE');
  });
  it('does not treat a measured role file with independent launch configuration as approved', () => {
    const { root, input } = fixture();
    const role = join(root, 'role.toml');
    writeFileSync(
      role,
      'model = "selected-model"\n[mcp_servers.unapproved]\ncommand = "/unapproved"\n',
    );
    input.threadConfig = { agents: { worker: { config_file: role } } };
    expect(() => resolveLiveConfigFiles(input)).toThrow('LIVE_EFFECTIVE_CONFIG_UNAVAILABLE');
  });
  it('refuses dotted native launch overrides rather than treating them as inert JSON keys', () => {
    const { input } = fixture();
    input.threadConfig = { 'mcp_servers.unknown.command': '/unapproved' };
    expect(() => resolveLiveConfigFiles(input)).toThrow('LIVE_EFFECTIVE_CONFIG_UNAVAILABLE');
  });
  it.each([
    { hooks: [{ command: '/unapproved' }] },
    { features: { hooks: true } },
    { remote_mcp: [{ url: 'https://unapproved.test' }] },
    { executables: [{ command: '/unapproved' }] },
    { plugins: { unknown: { enabled: true } } },
    { computer_use: { enabled: true } },
    { browser_use: { enabled: true } },
    { desktop: { enabled: true } },
  ])('refuses unapproved launch surfaces %j', (config) => {
    const { input } = fixture();
    input.configuration.config = config;
    expect(() => resolveLiveConfigFiles(input)).toThrow('LIVE_EFFECTIVE_CONFIG_UNAVAILABLE');
  });
  it('does not ignore disabled project layers or unresolved configuration layers', () => {
    const { input, layer } = fixture();
    input.configuration.layers = [
      {
        ...layer,
        name: { type: 'project', file: '/project', profile: null },
        disabledReason: 'not trusted',
      },
    ];
    expect(() => resolveLiveConfigFiles(input)).toThrow('LIVE_EFFECTIVE_CONFIG_UNAVAILABLE');
    input.configuration.layers = [];
    expect(() => resolveLiveConfigFiles(input)).toThrow('LIVE_EFFECTIVE_CONFIG_UNAVAILABLE');
  });
  it('refuses symlink configuration paths instead of pinning their current destination', () => {
    const { root, path, input, layer } = fixture();
    const alias = join(root, 'alias.toml');
    symlinkSync(path, alias);
    input.configuration.layers = [{ ...layer, name: { ...layer.name, file: alias } }];
    expect(() => resolveLiveConfigFiles(input)).toThrow('LIVE_EFFECTIVE_CONFIG_UNAVAILABLE');
  });
});
