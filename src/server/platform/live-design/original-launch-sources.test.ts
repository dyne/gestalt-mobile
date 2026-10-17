/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readLiveConfigFile } from './effective-config.js';
import { validateOriginalLaunchSources } from './original-launch-sources.js';
import {
  originalInstalledSourceSchema,
  originalLaunchSurfaces,
} from './installed-launch-contract.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));
function fixture(content = 'model = "selected-model"\n[features]\nhooks = false\n') {
  const owningHome = mkdtempSync(join(tmpdir(), 'live-original-source-'));
  roots.push(owningHome);
  const path = join(owningHome, 'config.toml');
  writeFileSync(path, content, { mode: 0o600 });
  return { owningHome, files: [readLiveConfigFile(path)], threadConfig: {} };
}
describe('original launch source validation before signing authority', () => {
  it('accepts only the exact separately declared bridge in a hook-free original without hiding settings', () => {
    const input = fixture();
    const source = originalInstalledSourceSchema.parse({
      kind: 'context-mode-bridge-v1',
      path: join(input.owningHome, 'bin/context-mode-mcp.mjs'),
      sha256: 'a'.repeat(64),
      gestaltHome: '/protected/gestalt',
      interpreter: { path: '/usr/bin/node', sha256: 'b'.repeat(64) },
      package: {
        root: '/cache/context-mode/2.16.1',
        version: '2.16.1',
        treeDigest: 'c'.repeat(64),
      },
      runtime: { root: '/protected/gestalt/runtime/context-mode', treeDigest: 'd'.repeat(64) },
    });
    const content = `[features]\nhooks = false\n[mcp_servers.context-mode]\ncommand = "node"\nargs = [${JSON.stringify(source.path)}]\nenabled = true\nrequired = true\ndefault_tools_approval_mode = "approve"\n[plugins."context-mode@dyne-gestalt-agents"]\nenabled = false\n`;
    const set = (text: string) => {
      writeFileSync(input.files[0]!.path, text);
      input.files[0] = readLiveConfigFile(input.files[0]!.path);
    };
    set(content);
    expect(validateOriginalLaunchSources({ ...input, installedSource: source })).toMatchObject({
      mcp_servers: originalLaunchSurfaces(source).mcpServers,
      plugins: originalLaunchSurfaces(source).plugins,
    });
    expect(() => validateOriginalLaunchSources(input)).toThrow('LIVE_ORIGINAL_LAUNCH_UNVERIFIED');
    for (const changed of [
      content.replace('hooks = false', 'hooks = true'),
      content.replace('required = true', 'required = false'),
      content.replace('enabled = false', 'enabled = true'),
      content + '[plugins."gestalt@dyne-gestalt-agents"]\nenabled = true\n',
      content + '[mcp_servers.context-mode.env]\nNODE_OPTIONS = "unapproved"\n',
    ]) {
      set(changed);
      expect(() => validateOriginalLaunchSources({ ...input, installedSource: source })).toThrow(
        'LIVE_ORIGINAL_LAUNCH_UNVERIFIED',
      );
    }
  });
  it.each(['mcp_servers = {}\nplugins = {}\n', '[mcp_servers]\n[plugins]\n'])(
    'accepts explicitly empty TOML launch inventories (%s)',
    (inventory) => {
      expect(
        validateOriginalLaunchSources(fixture(`${inventory}[features]\nhooks = false\n`)),
      ).toMatchObject({ features: { hooks: false } });
    },
  );
  it('parses actual source bytes without confusing comments or strings with executable settings', () => {
    const input = fixture(
      'model = "selected-model"\n# mcp_servers.unapproved.command = "not a setting"\n[features]\nhooks = false\n',
    );
    expect(validateOriginalLaunchSources(input)).toMatchObject({
      model: 'selected-model',
      features: { hooks: false },
    });
  });
  it.each([
    '"mcp_servers"."unapproved"."command" = "PRIVATE_COMMAND"\n[features]\nhooks = false\n',
    '[plugins.unapproved]\nenabled = false\n[features]\nhooks = false\n',
    '[profiles.unselected.hooks]\ncommand = "PRIVATE_COMMAND"\n[features]\nhooks = false\n',
    'notify = ["PRIVATE_COMMAND"]\n[features]\nhooks = false\n',
    '[features]\nhooks = true\n',
    'model = "no explicit hook prohibition"\n',
    'project_doc_max_bytes = 0\n[features]\nhooks = false\n',
    'model = "first"\nmodel = "duplicate"\n',
    '"__proto__".command = "PRIVATE_COMMAND"\n',
  ])('refuses unapproved or ambiguous TOML without returning source contents', (content) => {
    const input = fixture(content);
    try {
      validateOriginalLaunchSources(input);
      throw new Error('EXPECTED_REFUSAL');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('LIVE_ORIGINAL_LAUNCH_UNVERIFIED');
      expect(String(error)).not.toContain('PRIVATE_COMMAND');
    }
  });
  it('does not let thread flags hide an original executable surface or introduce dotted ones', () => {
    const bad = fixture(
      '[mcp_servers.unapproved]\ncommand = "unapproved"\n[features]\nhooks = false\n',
    );
    expect(() =>
      validateOriginalLaunchSources({ ...bad, threadConfig: { mcp_servers: {} } }),
    ).toThrow('LIVE_ORIGINAL_LAUNCH_UNVERIFIED');
    const valid = fixture();
    expect(() =>
      validateOriginalLaunchSources({ ...valid, threadConfig: { 'hooks.SessionStart': [] } }),
    ).toThrow('LIVE_ORIGINAL_LAUNCH_UNVERIFIED');
  });
  it('binds referenced roles to actual inventoried informational source files', () => {
    const input = fixture();
    const role = join(input.owningHome, 'reader.toml');
    writeFileSync(role, 'model = "selected-model"\n', { mode: 0o600 });
    writeFileSync(
      input.files[0]!.path,
      `[features]\nhooks = false\n[agents.reader]\nconfig_file = ${JSON.stringify(role)}\n`,
    );
    input.files[0] = readLiveConfigFile(input.files[0]!.path);
    expect(() => validateOriginalLaunchSources(input)).toThrow('LIVE_ORIGINAL_LAUNCH_UNVERIFIED');
    input.files.push(readLiveConfigFile(role));
    expect(validateOriginalLaunchSources(input)).toMatchObject({
      agents: { reader: { config_file: role } },
    });
    writeFileSync(role, '[mcp_servers.unapproved]\ncommand = "unapproved"\n');
    input.files[1] = readLiveConfigFile(role);
    expect(() => validateOriginalLaunchSources(input)).toThrow('LIVE_ORIGINAL_LAUNCH_UNVERIFIED');
  });
  it('refuses changed bytes and omitted original owning configuration', () => {
    const input = fixture();
    writeFileSync(input.files[0]!.path, '[features]\nhooks = false\nmodel = "changed"\n');
    expect(() => validateOriginalLaunchSources(input)).toThrow('LIVE_ORIGINAL_LAUNCH_UNVERIFIED');
    expect(() => validateOriginalLaunchSources({ ...input, files: [] })).toThrow(
      'LIVE_ORIGINAL_LAUNCH_UNVERIFIED',
    );
  });
});
