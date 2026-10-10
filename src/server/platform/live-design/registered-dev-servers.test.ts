/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RegisteredDevServers } from './registered-dev-servers.js';
import { liveAppIdentity } from './sqlite-live-ownership.js';

const children: ChildProcess[] = [];
const roots: string[] = [];
async function fixture(host = '127.0.0.1') {
  const root = mkdtempSync(join(tmpdir(), 'live-dev-server-'));
  roots.push(root);
  const app = join(root, 'app');
  mkdirSync(app);
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import {createServer} from 'node:http';
    const server=createServer((request,response)=>response.end('app'));
    server.listen(0, ${JSON.stringify(host)}, ()=>console.log(server.address().port));`,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  children.push(child);
  const [data] = await once(child.stdout!, 'data');
  return {
    root,
    app,
    child,
    port: Number(String(data).trim()),
    registry: new RegisteredDevServers(),
  };
}
afterEach(async () => {
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, 'exit');
    }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('trusted existing dev-server registration', () => {
  it('verifies an actual loopback listener, executable, process start and canonical alias without taking process ownership', async () => {
    const f = await fixture();
    const alias = join(f.root, 'alias');
    symlinkSync(f.app, alias);
    const target = f.registry.register(alias, f.port, f.child.pid!);
    expect(target.app).toEqual({ ...liveAppIdentity(f.app), registeredPath: alias });
    expect(target.identity.startTicks).toMatch(/^\d+$/);
    expect(target.identity.executableDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(target.identity.socketInodes.length).toBeGreaterThan(0);
    expect(f.registry.read(target.targetId, liveAppIdentity(f.app))).toEqual(target);
    f.registry.unregister(target.targetId);
    expect(() => f.registry.read(target.targetId, target.app)).toThrow('LIVE_TARGET_UNREGISTERED');
    expect(f.child.exitCode).toBeNull();
    expect(await (await fetch(`http://127.0.0.1:${f.port}`)).text()).toBe('app');
  });
  it('rejects a non-loopback listener even if its PID/port are known', async () => {
    const f = await fixture('0.0.0.0');
    expect(() => f.registry.register(f.app, f.port, f.child.pid!)).toThrow(
      'LIVE_TARGET_UNREGISTERED',
    );
    expect(f.child.exitCode).toBeNull();
  });
  it('rejects arbitrary port and wrong process identities', async () => {
    const f = await fixture();
    expect(() => f.registry.register(f.app, f.port, process.pid)).toThrow(
      'LIVE_TARGET_UNREGISTERED',
    );
    expect(() => f.registry.register(f.app, 0, f.child.pid!)).toThrow('LIVE_TARGET_INVALID');
    expect(() => f.registry.register(f.app, f.port, -1)).toThrow('LIVE_TARGET_UNREGISTERED');
  });
  it('rejects retargeting the original registered app alias', async () => {
    const f = await fixture();
    const alias = join(f.root, 'alias');
    symlinkSync(f.app, alias);
    const target = f.registry.register(alias, f.port, f.child.pid!);
    const other = join(f.root, 'other');
    mkdirSync(other);
    rmSync(alias);
    symlinkSync(other, alias);
    expect(() => f.registry.read(target.targetId, target.app)).toThrow('LIVE_APP_IDENTITY_CHANGED');
    expect(f.child.exitCode).toBeNull();
  });
  it('refuses dead listeners and replacement app directories without terminating any process', async () => {
    const f = await fixture();
    const target = f.registry.register(f.app, f.port, f.child.pid!);
    renameSync(f.app, join(f.root, 'old'));
    mkdirSync(f.app);
    expect(() => f.registry.read(target.targetId, target.app)).toThrow('LIVE_APP_IDENTITY_CHANGED');
    const other = f.registry.register(f.app, f.port, f.child.pid!);
    f.child.kill();
    await once(f.child, 'exit');
    expect(() => f.registry.read(other.targetId, other.app)).toThrow('LIVE_TARGET_UNREGISTERED');
  });
});
