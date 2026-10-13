/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { execFile, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { electLiveController } from './elected-controller.js';
import { liveAppIdentity } from './sqlite-live-ownership.js';

const roots: string[] = [];
const controllers: Awaited<ReturnType<typeof electLiveController>>[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'live-election-'));
  roots.push(root);
  const privateDirectory = join(root, 'private');
  mkdirSync(privateDirectory, { mode: 0o700 });
  const app = join(root, 'app');
  mkdirSync(app);
  return { root, app, privateDirectory, controllerId: 'controller' };
}
afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('elects one controller across independent OS processes, then fences takeover and retains claims', async () => {
  const input = fixture();
  const first = await electLiveController({ ...input, initialize: true });
  controllers.push(first);
  const run = first.ownership.claim({
    relayId: 'relay',
    appId: 'app',
    app: liveAppIdentity(input.app),
    targetId: 'target',
    targetIdentity: 'listener',
    rootThreadId: 'thread',
    provider: 'codex',
    operationId: 'start',
    previewOrigin: 'https://preview.example.test:9443',
    authSessionHash: 'session-hash',
    deviceId: 'device',
  }).run;
  const script = `import {electLiveController} from ${JSON.stringify(new URL('./elected-controller.ts', import.meta.url).href)};
    try { const controller = await electLiveController(JSON.parse(process.argv[1])); await controller.close(); console.log('UNEXPECTED_ELECTION'); }
    catch (error) { console.log(error.message); }`;
  const { stdout } = await promisify(execFile)(process.execPath, [
    '--import',
    'tsx',
    '--input-type=module',
    '--eval',
    script,
    JSON.stringify(input),
  ]);
  expect(stdout.trim()).toBe('LIVE_CONTROLLER_BUSY');
  expect(first.ownership.current(run.liveId)).toEqual(run);
  await first.close();
  const second = await electLiveController(input);
  controllers.push(second);
  const recovered = second.ownership.current(run.liveId)!;
  expect(recovered.state).toBe('recoveryRequired');
  expect(recovered.failureCode).toBe('LIVE_CONTROLLER_LOST');
  expect(recovered.controllerEpoch).toBeGreaterThan(run.controllerEpoch);
  expect(recovered.generation).toBeGreaterThan(run.generation);
  expect(() => second.ownership.assert(run)).toThrow('LIVE_GENERATION_STALE');
  expect(() => second.ownership.reserveWriter('relay', [input.app])).toThrow('LIVE_MODE_ACTIVE');
  await second.close();
  await second.close();
});

it('requires explicit first provisioning and releases the election after failed construction', async () => {
  const input = fixture();
  await expect(electLiveController(input)).rejects.toThrow('LIVE_STATE_UNAVAILABLE');
  const controller = await electLiveController({ ...input, initialize: true });
  controllers.push(controller);
});

it('releases the OS election after abrupt controller death without unlinking its lock', async () => {
  const input = fixture();
  const script = `import {electLiveController} from ${JSON.stringify(new URL('./elected-controller.ts', import.meta.url).href)};
    await electLiveController(JSON.parse(process.argv[1])); process.kill(process.pid, 'SIGKILL');`;
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      script,
      JSON.stringify({ ...input, initialize: true }),
    ],
    { stdio: 'ignore' },
  );
  const signal = await new Promise<NodeJS.Signals | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (_code, signal) => resolve(signal));
  });
  expect(signal).toBe('SIGKILL');
  await expect
    .poll(
      async () => {
        try {
          const controller = await electLiveController(input);
          controllers.push(controller);
          return 'elected';
        } catch (error) {
          return (error as Error).message;
        }
      },
      { timeout: 2000, interval: 10 },
    )
    .toBe('elected');
});

it('refuses symlinked or exposed private state without repairing it', async () => {
  const input = fixture();
  chmodSync(input.privateDirectory, 0o755);
  await expect(electLiveController({ ...input, initialize: true })).rejects.toThrow(
    'LIVE_PRIVATE_STATE_INVALID',
  );
  chmodSync(input.privateDirectory, 0o700);
  const alias = join(input.root, 'alias');
  symlinkSync(input.privateDirectory, alias);
  await expect(
    electLiveController({ ...input, privateDirectory: alias, initialize: true }),
  ).rejects.toThrow('LIVE_PRIVATE_STATE_INVALID');
  symlinkSync(join(input.root, 'unowned'), join(input.privateDirectory, 'controller.lock'));
  await expect(electLiveController({ ...input, initialize: true })).rejects.toThrow();
});
