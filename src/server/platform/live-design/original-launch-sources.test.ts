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
