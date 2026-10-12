/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
