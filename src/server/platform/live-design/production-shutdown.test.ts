/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ProductionLiveController } from './production-controller.js';
import type { ProductionLiveConfiguration } from './production-configuration.js';
import { SqliteLiveOwnership, liveAppIdentity } from './sqlite-live-ownership.js';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'live-shutdown-verification-'));
  const app = join(root, 'app');
  mkdirSync(app);
  const owners = new SqliteLiveOwnership(join(root, 'owners.sqlite'), 'controller', {
    initialize: true,
  });
  let run = owners.claim({
    relayId: 'relay',
    appId: 'app',
    rootThreadId: 'thread',
    provider: 'codex',
    app: liveAppIdentity(app),
    targetId: 'target',
    targetIdentity: 'socket',
    operationId: 'start',
    previewOrigin: 'https://preview.example.test:9443',
    authSessionHash: 'hash',
    deviceId: 'device',
  }).run;
  run = owners.mutate(run, { event: 'phase', phase: 'route:ack' });
  run = owners.mutate(run, { event: 'ready' });
  const controller = new ProductionLiveController(
    owners,
    {
      privateDirectory: join(root, 'controller'),
      caddy: { hostname: 'preview.example.test', previewPorts: [9443] },
    } as unknown as ProductionLiveConfiguration,
    { path: join(root, 'production.json'), sha256: 'a'.repeat(64) },
    async () => {},
    {} as ConstructorParameters<typeof ProductionLiveController>[4],
  );
  cleanups.push(() => {
    Reflect.get(controller, 'origins').close();
    owners.close();
    rmSync(root, { recursive: true, force: true });
  });
  let reject!: (error: Error) => void;
  const inspect = vi.fn(
    () =>
      new Promise<never>((_resolve, fail) => {
        reject = fail;
      }),
  );
  const abort = vi.fn(async () => {});
  const revoke = vi.fn(async () => {});
  const generation = { resumed: true, session: { id: 'relay' }, policy: { capture: {} } };
  // Isolate the asynchronous admission boundary. The real shared ownership
  // store and public verifier retain Stop's exact epoch/generation semantics.
  Reflect.set(controller, 'verifyHost', () => {});
  Reflect.set(controller, 'generation', () => generation);
  Reflect.set(controller, 'revokeCapture', revoke);
  Reflect.set(controller, 'connections', { revoke: vi.fn(async () => {}) });
  Reflect.set(controller, 'requireBindings', () => ({
    sessions: { find: () => ({ id: 'relay', provider: 'codex', threadId: 'thread' }) },
    runtime: { inspectLiveAdmission: inspect, abortLiveOwner: abort },
  }));
  return {
    controller,
    owners,
    run,
    inspect,
    abort,
    revoke,
    reject: (error: Error) => reject(error),
  };
}

it('lets exact Stop own teardown when delayed verification observes revoked admission', async () => {
  const f = fixture();
  const flight = f.controller.verifyLiveRuntime(f.run);
  const refused = expect(flight).rejects.toThrow('LIVE_ADMISSION_UNAVAILABLE');
  await vi.waitFor(() => expect(f.inspect).toHaveBeenCalledOnce());
  f.owners.mutate(f.run, { event: 'stop' });
  f.reject(new Error('LIVE_ADMISSION_UNAVAILABLE'));
  await refused;
  expect(f.controller.preflightBlocked()).toBe(false);
  expect(f.owners.current(f.run.liveId)?.state).toBe('stopping');
  expect(f.abort).not.toHaveBeenCalled();
  expect(f.revoke).not.toHaveBeenCalled();
});

it('still revokes and aborts a genuine admission failure while the generation is active', async () => {
  const f = fixture();
  const flight = f.controller.verifyLiveRuntime(f.run);
  const refused = expect(flight).rejects.toThrow('LIVE_ADMISSION_UNAVAILABLE');
  await vi.waitFor(() => expect(f.inspect).toHaveBeenCalledOnce());
  f.reject(new Error('LIVE_ADMISSION_UNAVAILABLE'));
  await refused;
  expect(f.owners.current(f.run.liveId)?.state).toBe('recoveryRequired');
  expect(f.abort).toHaveBeenCalledOnce();
  expect(f.revoke).toHaveBeenCalledOnce();
});
