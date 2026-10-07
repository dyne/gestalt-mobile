/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ManagedXerj, xerjDeadline } from './managed-xerj.js';

const roots: string[] = [];
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
    expect(await adapter.check({ cwd: root, deadline: began + 70, start: true })).toEqual({
      status: 'unavailable',
      reason: 'readiness-timeout',
    });
    expect(Date.now() - began).toBeLessThan(500);
  });
  it('preserves the five-second default and bounded explicit deadline', () => {
    expect(xerjDeadline({}) - Date.now()).toBeGreaterThan(4900);
    expect(xerjDeadline({ XERJ_READY_TIMEOUT_MS: '10' }) - Date.now()).toBeLessThanOrEqual(10);
  });
});
