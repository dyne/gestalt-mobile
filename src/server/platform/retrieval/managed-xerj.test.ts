/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { existsSync } from 'node:fs';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ManagedXerj, xerjDeadline } from './managed-xerj.js';

const roots: string[] = [];
const shippedManager = join(process.cwd(), '..', 'gestalt', 'public', 'gestalt');
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function manager(body: string) {
  const root = await mkdtemp(join(tmpdir(), 'xerj mobile with spaces '));
  roots.push(root);
  const path = join(root, 'gestalt');
  await writeFile(path, `#!/usr/bin/env node\n${body}`, { mode: 0o700 });
  return { adapter: new ManagedXerj({ PATH: process.env.PATH, GESTALT_MANAGER_BIN: path }), root };
}
const ready = {
  schemaVersion: 1,
  status: 'ready',
  version: '1.0.0-rc.87',
  endpoint: 'http://127.0.0.1:19200',
  auth: { keyFile: '/private/admin.key' },
};

describe('managed retrieval capability', () => {
  it('ignores stale availability flags and degrades without an installed manager', async () => {
    expect(
      await new ManagedXerj({ PATH: '', GESTALT_XERJ_READY: '1' }).check({
        cwd: '/tmp',
        deadline: Date.now() + 100,
        start: true,
      }),
    ).toEqual({ status: 'absent' });
  });
  it.each([true, false])(
    'uses the common contract with start=%s without leaking auth',
    async (start) => {
      const { adapter, root } = await manager(
        `if (process.argv[2] !== 'xerj' || process.argv[3] !== '${start ? 'ensure-ready' : 'probe'}') process.exit(2); console.error('secret-value'); console.log(${JSON.stringify(JSON.stringify(ready))});`,
      );
      const result = await adapter.check({ cwd: root, deadline: Date.now() + 1000, start });
      expect(result).toMatchObject({ status: 'ready', endpoint: ready.endpoint });
      expect(JSON.stringify(result)).not.toContain('auth');
      expect(JSON.stringify(result)).not.toContain('secret-value');
    },
  );
  it.each([
    { ...ready, version: 'other' },
    { ...ready, endpoint: 'http://example.org' },
    { ...ready, endpoint: 'http://127.0.0.1:99999' },
    { ...ready, schemaVersion: 2 },
    { ...ready, endpoint: 'http://user:key@127.0.0.1' },
  ])('rejects incompatible or unsafe contract %j', async (value) => {
    const { adapter, root } = await manager(
      `console.log(${JSON.stringify(JSON.stringify(value))});`,
    );
    expect(await adapter.check({ cwd: root, deadline: Date.now() + 1000, start: true })).toEqual({
      status: 'unavailable',
      reason: 'invalid-manager-response',
    });
  });
  it('bounds and reaps a stuck owned probe', async () => {
    const { adapter, root } = await manager('setInterval(() => {}, 1000);');
    const began = Date.now();
    expect(await adapter.check({ cwd: root, deadline: began + 150, start: true })).toEqual({
      status: 'unavailable',
      reason: 'readiness-timeout',
    });
    expect(Date.now() - began).toBeLessThan(500);
  });
  it('uses the manager contract range and falls back to five seconds outside it', () => {
    const remaining = (value?: string) =>
      xerjDeadline(value === undefined ? {} : { XERJ_READY_TIMEOUT_MS: value }) - Date.now();
    expect(remaining()).toBeGreaterThan(4900);
    expect(remaining('10')).toBeGreaterThan(4900);
    expect(remaining('120000')).toBeGreaterThan(4900);
    expect(remaining('100')).toBeGreaterThan(90);
    expect(remaining('60000')).toBeGreaterThan(59_900);
  });
  it('does not invoke the manager when the shared remaining budget falls below 100ms', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xerj short deadline '));
    roots.push(root);
    const marker = join(root, 'manager-called');
    const guarded = new ManagedXerj({
      PATH: process.env.PATH,
      GESTALT_MANAGER_BIN: join(root, 'gestalt'),
      MANAGER_MARKER: marker,
    });
    await writeFile(
      join(root, 'gestalt'),
      `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.env.MANAGER_MARKER, 'called');`,
      { mode: 0o700 },
    );
    expect(await guarded.check({ cwd: root, deadline: Date.now() + 50, start: true })).toEqual({
      status: 'unavailable',
      reason: 'readiness-timeout',
    });
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.runIf(existsSync(shippedManager))(
    'matches the shipped manager deadline contract for invalid configured bounds',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'xerj shipped contract '));
      roots.push(root);
      for (const configured of ['10', '120000']) {
        const processResult = await import('node:child_process').then(
          ({ spawn }) =>
            new Promise<{ code: number | null; output: string }>((resolve) => {
              const child = spawn(shippedManager, ['xerj', 'probe'], {
                env: {
                  ...process.env,
                  GESTALT_HOME: root,
                  XERJ_READY_TIMEOUT_MS: configured,
                },
                stdio: ['ignore', 'pipe', 'ignore'],
              });
              let output = '';
              child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
              child.once('close', (code) => resolve({ code, output }));
            }),
        );
        expect(processResult.code).toBe(0);
        expect(JSON.parse(processResult.output)).toEqual({
          schemaVersion: 1,
          status: 'unavailable',
          reason: 'invalid-deadline',
        });
        const normalized = xerjDeadline({ XERJ_READY_TIMEOUT_MS: configured }) - Date.now();
        expect(normalized).toBeGreaterThan(4900);
        expect(normalized).toBeLessThanOrEqual(5000);
      }
    },
  );
});
