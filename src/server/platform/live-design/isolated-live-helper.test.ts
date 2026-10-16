/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type {
  LiveOwnershipStore,
  LiveRun,
} from '../../features/live-design/application/ownership.js';
import { IsolatedLiveHelper } from './isolated-live-helper.js';
import type { IsolatedProjectProcess, IsolatedProjectReceipt } from './isolated-project-process.js';

// Journal/generation contracts only. The process RPC is a fixture; actual
// pre/post source/process verification and CLI closure require hosted Native.
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'isolated-helper-contract-'));
  roots.push(root);
  const app = join(root, 'app'),
    control = join(root, 'control');
  mkdirSync(app, { mode: 0o700 });
  mkdirSync(control, { mode: 0o700 });
  const run = {
    liveId: 'live',
    relayId: 'owner',
    rootThreadId: 'thread',
    generation: 1,
    controllerEpoch: 1,
    state: 'active',
    app: { canonicalAppRoot: app },
  } as LiveRun;
  const current = structuredClone(run);
  const process = {
    verify: vi.fn(),
    helperCommand: vi.fn<(receipt: unknown, args: readonly string[]) => Promise<unknown>>(
      async () => ({ type: 'timeout' }),
    ),
    cancelHelperCommand: vi.fn(async () => {}),
  };
  const input = {
    run,
    owners: { current: () => current, assert: () => current } as unknown as LiveOwnershipStore,
    process: process as unknown as IsolatedProjectProcess,
    receipt: {
      role: 'helper',
      sessionId: run.relayId,
      generation: 1,
      target: { cwd: app },
      signature: 'fixture-only-not-native-admission',
    } as IsolatedProjectReceipt,
    privateDirectory: control,
    port: 4321,
    publicBaseUrl: 'https://preview.example/__gestalt_live',
  };
  const cli = new IsolatedLiveHelper(input);
  return {
    cli,
    current,
    input,
    process,
    record: () => JSON.parse(readFileSync(join(control, 'helper-live-1.json'), 'utf8')),
  };
}
it('reserves one foreground command and settles its actual RPC before retaining cancelled-poll ambiguity', async () => {
  const f = fixture();
  let reject!: (error: Error) => void;
  f.process.helperCommand.mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  const active = f.cli.poll();
  const rejected = active.catch(() => 'rejected');
  await expect(f.cli.poll()).rejects.toThrow('LIVE_HELPER_COMMAND_UNAVAILABLE');
  expect(f.process.helperCommand).toHaveBeenCalledOnce();
  f.current.state = 'stopping';
  f.process.cancelHelperCommand.mockImplementation(async () => {
    reject(new Error('CANCELLED'));
  });
  await f.cli.settle();
  expect(await rejected).toBe('rejected');
  expect(f.record()).toMatchObject({
    pending: null,
    cancelled: { name: 'live-poll', ambiguous: true, foregroundClosed: true },
  });
  expect(f.process.verify).toHaveBeenCalledOnce(); // Constructor admission only; RPC owns pre/post verification.
});
it('a generation change while the verified RPC is outstanding cannot clear its intent or publish success', async () => {
  const f = fixture();
  let resolve!: (value: { type: string }) => void;
  f.process.helperCommand.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const active = f.cli.poll();
  Object.assign(f.current, { controllerEpoch: f.current.controllerEpoch + 1 });
  resolve({ type: 'timeout' });
  await expect(active).rejects.toThrow('LIVE_HELPER_COMMAND_AMBIGUOUS');
  expect(f.record().pending).toMatchObject({ name: 'live-poll', ambiguous: true });
  await expect(f.cli.poll()).rejects.toThrow('LIVE_HELPER_GENERATION_STALE');
  expect(f.process.helperCommand).toHaveBeenCalledOnce();
});
it('a failed source-verified RPC retains intent and cannot be blindly repeated', async () => {
  const f = fixture();
  f.process.helperCommand.mockRejectedValue(new Error('LIVE_PROJECT_PROCESS_UNAVAILABLE'));
  await expect(f.cli.poll()).rejects.toThrow('LIVE_HELPER_COMMAND_AMBIGUOUS');
  await expect(f.cli.poll()).rejects.toThrow('LIVE_HELPER_RECOVERY_REQUIRED');
  expect(f.process.helperCommand).toHaveBeenCalledOnce();
  expect(() => new IsolatedLiveHelper(f.input)).toThrow('LIVE_HELPER_RECOVERY_REQUIRED');
});

it('allows a newer exact cleanup fence to reconcile, while old poll and reply remain revoked', async () => {
  const f = fixture();
  f.current.generation = 2;
  f.current.state = 'stopping';
  f.process.helperCommand.mockImplementation(async (_receipt, args) =>
    args[0] === 'live-status'
      ? { activeSessions: [], liveServer: { pendingEvents: [] } }
      : { active: false },
  );
  await f.cli.reconcile(f.current);
  await expect(f.cli.poll()).rejects.toThrow('LIVE_HELPER_GENERATION_STALE');
  await expect(f.cli.reply({ id: 'old-event', status: 'done' })).rejects.toThrow(
    'LIVE_HELPER_GENERATION_STALE',
  );
  expect(f.process.helperCommand.mock.calls.map((call) => call[1])).toEqual([
    ['live-status'],
    ['live-resume'],
  ]);
  f.current.rootThreadId = 'successor';
  await expect(f.cli.reconcile(f.current)).rejects.toThrow('LIVE_HELPER_GENERATION_STALE');
});
it('retains recovery for a pending actual helper checkpoint without replay or completion', async () => {
  const f = fixture();
  f.current.generation = 2;
  f.current.state = 'stopping';
  f.process.helperCommand.mockImplementation(async (_receipt, args) =>
    args[0] === 'live-status'
      ? { activeSessions: [{ phase: 'accept_requested' }], liveServer: { pendingEvents: [] } }
      : { active: true },
  );
  await expect(f.cli.reconcile(f.current)).rejects.toThrow('LIVE_HELPER_RECOVERY_REQUIRED');
  expect(f.process.helperCommand.mock.calls.map((call) => call[1])).toEqual([
    ['live-status'],
    ['live-resume'],
  ]);
});
