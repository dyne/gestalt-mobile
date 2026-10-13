/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InstalledLivePolicy, measureInstalledLiveTree } from './installed-policy.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'live-installation-'));
  roots.push(root);
  const file = join(root, 'entry.mjs');
  writeFileSync(file, 'export const trusted = true;\n', { mode: 0o600 });
  return { root, file };
}
describe('installed code before host execution', () => {
  it('binds every installed file name, mode and byte', () => {
    const { root, file } = fixture();
    const original = measureInstalledLiveTree(root);
    mkdirSync(join(root, 'nested'), { mode: 0o700 });
    writeFileSync(join(root, 'nested/module.mjs'), 'export const value = 1;\n', { mode: 0o600 });
    expect(measureInstalledLiveTree(root)).not.toBe(original);
    rmSync(join(root, 'nested'), { recursive: true });
    expect(measureInstalledLiveTree(root)).toBe(original);
    chmodSync(file, 0o700);
    expect(measureInstalledLiveTree(root)).not.toBe(original);
    chmodSync(file, 0o600);
    writeFileSync(file, 'export const trusted = false;\n');
    expect(measureInstalledLiveTree(root)).not.toBe(original);
  });
  it('refuses symlinks and group-writable installed code', () => {
    const { root, file } = fixture();
    symlinkSync(file, join(root, 'alias'));
    expect(() => measureInstalledLiveTree(root)).toThrow('LIVE_INSTALLATION_UNVERIFIED');
    rmSync(join(root, 'alias'));
    chmodSync(file, 0o660);
    expect(() => measureInstalledLiveTree(root)).toThrow('LIVE_INSTALLATION_UNVERIFIED');
  });
  it('refuses a substituted manager before it can run any host command', () => {
    const hash = 'a'.repeat(64);
    expect(
      () =>
        new InstalledLivePolicy({
          manager: { path: '/unapproved/manager', sha256: hash },
          node: { path: '/unapproved/node', sha256: hash },
          packages: [
            { name: 'gestalt', root: '/unapproved/gestalt', sha256: hash },
            { name: 'context-mode', root: '/unapproved/context', sha256: hash },
          ],
          runtime: { root: '/unapproved/runtime', sha256: hash },
        }),
    ).toThrow('LIVE_INSTALLATION_UNVERIFIED');
  });
});
