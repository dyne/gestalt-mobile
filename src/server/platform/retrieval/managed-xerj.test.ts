/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { existsSync } from 'node:fs';
import { access, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagedXerj, xerjDeadline, xerjStartupTimeout } from './managed-xerj.js';

const roots: string[] = [];
const adapters: ManagedXerj[] = [];
const shippedManager = join(process.cwd(), '..', 'gestalt', 'public', 'gestalt');
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function manager(body: string, environment: NodeJS.ProcessEnv = {}) {
  const root = await mkdtemp(join(tmpdir(), 'xerj mobile with spaces '));
  roots.push(root);
  const path = join(root, 'gestalt');
  await writeFile(path, `#!/usr/bin/env node\n${body}`, { mode: 0o700 });
  const adapter = new ManagedXerj({
    PATH: process.env.PATH,
    GESTALT_MANAGER_BIN: path,
    ...environment,
  });
  adapters.push(adapter);
  return { adapter, root };
}
const ready = {
  schemaVersion: 1,
  status: 'ready',
  version: '1.0.0-rc.98',
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
    const { adapter, root } = await manager('setInterval(() => {}, 1000);', {
      XERJ_STARTUP_TIMEOUT_MS: '150',
    });
    const began = Date.now();
    expect(await adapter.check({ cwd: root, deadline: began + 1000, start: true })).toEqual({
      status: 'unavailable',
      reason: 'readiness-timeout',
    });
    expect(Date.now() - began).toBeLessThan(1000);
  });
  it('shares background startup across short chat waits and read-only observers, then verifies again', async () => {
    const { adapter, root } = await manager(`
const fs = require('node:fs'), path = require('node:path');
const operation = process.argv[3], root = process.cwd();
fs.appendFileSync(path.join(root, 'calls'), JSON.stringify({ operation, pid: process.pid, budget: process.env.XERJ_READY_TIMEOUT_MS }) + '\\n');
const reply = () => console.log(JSON.stringify(fs.existsSync(path.join(root, 'reject'))
 ? { schemaVersion:1, status:'unavailable', reason:'authentication-failed', stderr:'secret' }
 : ${JSON.stringify(ready)}));
if (operation === 'probe') reply();
else { const timer = setInterval(() => { if (fs.existsSync(path.join(root, 'release'))) { clearInterval(timer); reply(); } }, 10); }
`);
    const readCalls = async () =>
      (await readFile(join(root, 'calls'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
    const first = adapter.check({ cwd: root, deadline: Date.now() + 200, start: true });
    const second = adapter.check({ cwd: '/tmp', deadline: Date.now() + 250, start: true });
    expect(await first).toEqual({ status: 'starting' });
    expect(await second).toEqual({ status: 'starting' });
    await vi.waitFor(async () => expect(await readCalls()).toHaveLength(1));
    expect((await readCalls())[0].budget).toBe('30000');
    const pid = (await readCalls())[0].pid;
    expect(() => process.kill(pid, 0)).not.toThrow();
    const observer = adapter.check({ cwd: root, deadline: Date.now() + 1000, start: false });
    await writeFile(join(root, 'release'), '');
    expect(await observer).toMatchObject({ status: 'ready' });
    await writeFile(join(root, 'reject'), '');
    expect(await adapter.check({ cwd: root, deadline: Date.now() + 1000, start: false })).toEqual({
      status: 'unavailable',
      reason: 'authentication-failed',
    });
    expect((await readCalls()).map((call) => call.operation)).toEqual(['ensure-ready', 'probe']);
  });
  it('cancels and reaps an in-flight startup on shutdown without stopping the shared backend', async () => {
    const { adapter, root } = await manager(
      `require('node:fs').writeFileSync('pid', String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`,
    );
    const waiting = adapter.check({ cwd: root, deadline: Date.now() + 200, start: true });
    await vi.waitFor(async () =>
      expect(Number(await readFile(join(root, 'pid'), 'utf8'))).toBeGreaterThan(0),
    );
    expect(await waiting).toEqual({ status: 'starting' });
    const pid = Number(await readFile(join(root, 'pid'), 'utf8'));
    await adapter.close();
    expect(() => process.kill(pid, 0)).toThrow();
    expect(await adapter.check({ cwd: root, deadline: Date.now() + 1000, start: true })).toEqual({
      status: 'unavailable',
      reason: 'cancelled',
    });
  });
  it.each([
    'authentication-failed',
    'timeout',
    'launch-failed',
    'unsafe-path',
    'secret credential text',
  ])('preserves only allowlisted manager reason %s and can retry later', async (reason) => {
    const { adapter, root } = await manager(
      `console.log(JSON.stringify({schemaVersion:1,status:'unavailable',reason:${JSON.stringify(reason)},stderr:'private'}));`,
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await adapter.check({ cwd: root, deadline: Date.now() + 1000, start: true })).toEqual({
        status: 'unavailable',
        reason: reason === 'secret credential text' ? 'unknown' : reason,
      });
    }
  });
  it('keeps the background startup allowance separate from the foreground deadline', () => {
    expect(xerjStartupTimeout({})).toBe(30000);
    expect(xerjStartupTimeout({ XERJ_READY_TIMEOUT_MS: '15000' })).toBe(30000);
    expect(xerjStartupTimeout({ XERJ_STARTUP_TIMEOUT_MS: '15000' })).toBe(15000);
    for (const value of ['1', '60001', 'oops'])
      expect(xerjStartupTimeout({ XERJ_STARTUP_TIMEOUT_MS: value })).toBe(30000);
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
