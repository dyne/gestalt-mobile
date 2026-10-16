/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  InstalledLiveAdmissionError,
  InstalledLivePolicy,
  measureInstalledLiveTree,
} from './installed-policy.js';

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
  it('retains only fixed protocol refusal reasons without command output or private data', () => {
    const privateValue = '/private/secret-credential';
    const failure = (reason: string) => ({
      stdout: JSON.stringify({
        schemaVersion: 2,
        available: false,
        liveReady: false,
        reason,
        diagnostic: privateValue,
      }),
      stderr: privateValue,
      message: privateValue,
    });
    const known = InstalledLiveAdmissionError.command('manager-command', failure('source-changed'));
    expect(known.message).toBe('LIVE_ADMISSION_UNAVAILABLE');
    expect(known.diagnostic).toEqual({ phase: 'manager-command', reason: 'source-changed' });
    for (const reason of [
      'invalid-renewal-lineage',
      'renewal-intent-changed',
      'renewal-not-revoked',
      'renewal-observation-required',
      'renewal-owner-alive',
      'renewal-policy-broadened',
      'renewal-policy-incompatible',
      'renewal-required',
      'renewal-source-changed',
      'renewal-storage-reused',
      'renewal-undrained',
    ]) {
      const error = InstalledLiveAdmissionError.command('manager-command', failure(reason));
      expect(error.diagnostic).toEqual({ phase: 'manager-command', reason });
      expect(JSON.stringify(error)).not.toContain(privateValue);
    }
    const unknown = InstalledLiveAdmissionError.command('agents-command', failure(privateValue));
    expect(unknown.diagnostic).toEqual({ phase: 'agents-command', reason: 'contract-refused' });
    const malformed = InstalledLiveAdmissionError.command('agents-command', {
      stdout: privateValue,
    });
    expect(malformed.diagnostic.reason).toBe('command-failed');
    for (const error of [known, unknown, malformed]) {
      expect(JSON.stringify(error)).not.toContain(privateValue);
      expect(error.cause).toBeUndefined();
    }
  });
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
