/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { RelaySession } from '../../features/sessions/model/relay-session.js';
import type {
  LiveOwnershipStore,
  LiveRun,
} from '../../features/live-design/application/ownership.js';
import { CodexSessionRuntime, type AppServer } from '../codex/session-runtime.js';
import { observeLiveProcess } from './process-identity.js';

async function fixture() {
  // Actual local process lifetime; deterministic native RPC contract, no native/provider claim.
  const child = spawn(globalThis.process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    env: {},
    stdio: 'ignore',
  });
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  await once(child, 'spawn');
  const calls: { method: string; params: unknown }[] = [];
  let childStatus = 'idle';
  let background = false;
  let unloadStatus = 'unsubscribed';
  const process: AppServer = {
    close: vi.fn(() => {
      child.kill('SIGTERM');
    }),
    waitForExit: () => closed,
    observeLiveLaunch: () => observeLiveProcess(child.pid!),
    rpc: {
      request: async (method, params) => {
        calls.push({ method, params });
        const id = (params as { threadId?: string }).threadId;
        if (method === 'thread/start') return { thread: { id: 'root' } };
        if (method === 'thread/read')
          return { thread: { id, status: { type: id === 'child' ? childStatus : 'idle' } } };
        if (method === 'thread/backgroundTerminals/list')
          return { data: background ? [{}] : [], nextCursor: null };
        if (method === 'thread/list')
          return {
            data:
              (params as { parentThreadId: string }).parentThreadId === 'root'
                ? [{ id: 'child', parentThreadId: 'root' }]
                : [],
            nextCursor: null,
          };
        if (method === 'thread/unsubscribe') return { status: unloadStatus };
        return {};
      },
      onNotification: () => () => {},
      onServerRequest: () => () => {},
    },
  };
  const launch = vi.fn(() => process);
  const runtime = new CodexSessionRuntime(launch);
  const session = await runtime
    .start(
      RelaySession.create({
        id: 'owner',
        provider: 'codex',
        workspaceId: 'workspace',
        workspacePath: globalThis.process.cwd(),
        profile: 'default',
        model: 'selected-model',
        effectiveSkillSelection: { skills: [] },
        now: 'time',
      }).snapshot,
      'time',
    )
    .catch(async (error) => {
      child.kill('SIGTERM');
      await closed;
      throw error;
    });
  const run = {
    relayId: session.id,
    rootThreadId: session.threadId,
    state: 'starting',
    phase: 'quiesce:intent',
  } as LiveRun;
  const assert = vi.fn(() => run);
  const authority = { owners: { assert } as unknown as LiveOwnershipStore, fence: run };
  return {
    runtime,
    session,
    process,
    launch,
    child,
    closed,
    calls,
    authority,
    run,
    assert,
    busy: () => {
      childStatus = 'active';
    },
    background: () => {
      background = true;
    },
    badUnload: () => {
      unloadStatus = 'unknown';
    },
    async cleanup() {
      child.kill('SIGTERM');
      runtime.stopAll();
      await closed;
    },
  };
}

describe('quiescent owning-runtime handoff', () => {
  it('unloads descendants before root and awaits the actual owning process close without replacement', async () => {
    const f = await fixture();
    try {
      await f.runtime.releaseLiveOwner(f.session, f.authority);
      expect(
        f.calls.filter((call) => call.method === 'thread/unsubscribe').map((call) => call.params),
      ).toEqual([{ threadId: 'child' }, { threadId: 'root' }]);
      expect(f.child.exitCode !== null || f.child.signalCode !== null).toBe(true);
      expect(f.launch).toHaveBeenCalledTimes(1);
      await expect(f.runtime.inspectLiveAdmission(f.session)).rejects.toThrow(
        'LIVE_RUNTIME_UNAVAILABLE',
      );
    } finally {
      await f.cleanup();
    }
  });
  it.each(['child', 'background', 'missing-lifetime', 'wrong-authority'] as const)(
    'refuses %s before unload or process shutdown',
    async (kind) => {
      const f = await fixture();
      try {
        if (kind === 'child') f.busy();
        if (kind === 'background') f.background();
        if (kind === 'missing-lifetime') delete f.process.waitForExit;
        if (kind === 'wrong-authority') f.run.phase = 'prepare:intent';
        await expect(f.runtime.releaseLiveOwner(f.session, f.authority)).rejects.toThrow(/^LIVE_/);
        expect(f.calls.some((call) => call.method === 'thread/unsubscribe')).toBe(false);
        expect(f.process.close).not.toHaveBeenCalled();
      } finally {
        await f.cleanup();
      }
    },
  );
  it('fences a takeover before the next native call', async () => {
    const f = await fixture();
    try {
      f.assert
        .mockImplementationOnce(() => f.run)
        .mockImplementation(() => {
          throw new Error('LIVE_GENERATION_STALE');
        });
      const before = f.calls.length;
      await expect(f.runtime.releaseLiveOwner(f.session, f.authority)).rejects.toThrow(
        'LIVE_GENERATION_STALE',
      );
      expect(f.calls).toHaveLength(before);
      expect(f.process.close).not.toHaveBeenCalled();
    } finally {
      await f.cleanup();
    }
  });
  it('closes the exact owner on an invalid native unload receipt while retaining refusal', async () => {
    const f = await fixture();
    try {
      f.badUnload();
      await expect(f.runtime.releaseLiveOwner(f.session, f.authority)).rejects.toThrow(
        'LIVE_RUNTIME_UNLOAD_UNVERIFIED',
      );
      expect(f.child.exitCode !== null || f.child.signalCode !== null).toBe(true);
      expect(f.launch).toHaveBeenCalledTimes(1);
    } finally {
      await f.cleanup();
    }
  });
});
