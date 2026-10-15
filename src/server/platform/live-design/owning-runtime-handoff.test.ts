/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RelaySession } from '../../features/sessions/model/relay-session.js';
import type {
  LiveOwnershipStore,
  LiveRun,
} from '../../features/live-design/application/ownership.js';
import { CodexSessionRuntime, type AppServer } from '../codex/session-runtime.js';
import { observeLiveProcess } from './process-identity.js';
import { readLiveProcessEnvironment } from '../codex/codex-process-launcher.js';
import { SqliteLiveOwnership } from './sqlite-live-ownership.js';
import { LiveDispatchGuard } from './live-dispatch.js';

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
  let resumeId = 'root';
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
        if (method === 'thread/resume') return { thread: { id: resumeId }, instructionSources: [] };
        if (method === 'thread/read')
          return {
            thread: {
              id,
              sessionId: 'native-session',
              parentThreadId: id === 'child' ? 'root' : null,
              status: { type: id === 'child' ? childStatus : 'idle' },
            },
          };
        if (method === 'thread/backgroundTerminals/list')
          return { data: background ? [{}] : [], nextCursor: null };
        if (method === 'thread/list')
          return {
            data: [{ id: 'child', parentThreadId: 'root', sessionId: 'native-session' }],
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
    badResume: () => {
      resumeId = 'another-thread';
    },
    async cleanup() {
      child.kill('SIGTERM');
      runtime.stopAll();
      await closed;
    },
  };
}

describe('quiescent owning-runtime handoff', () => {
  it('reconfigures the same durable thread inside the original live process without another writer', async () => {
    const f = await fixture();
    const modelConfig = { mcp_servers: { 'context-mode': { command: 'trusted-proxy' } } };
    try {
      const before = observeLiveProcess(f.child.pid!);
      await f.runtime.reconfigureLiveOwner(f.session, { modelConfig, skillsConfig: [] });
      expect(observeLiveProcess(f.child.pid!)).toEqual(before);
      expect(f.launch).toHaveBeenCalledTimes(1);
      expect(f.process.close).not.toHaveBeenCalled();
      expect(
        f.calls.filter((call) => call.method === 'thread/unsubscribe').map((call) => call.params),
      ).toEqual([{ threadId: 'child' }, { threadId: 'root' }]);
      expect(f.calls.find((call) => call.method === 'thread/resume')?.params).toMatchObject({
        threadId: 'root',
        excludeTurns: true,
        model: 'selected-model',
        config: modelConfig,
      });
      expect((await f.runtime.inspectLiveAdmission(f.session)).threadConfig).toEqual(modelConfig);
    } finally {
      await f.cleanup();
    }
  });
  it.each(['busy', 'unload', 'resume'] as const)(
    'refuses invalid same-process %s handoff without launching or killing another owner',
    async (kind) => {
      const f = await fixture();
      try {
        if (kind === 'busy') f.busy();
        if (kind === 'unload') f.badUnload();
        if (kind === 'resume') f.badResume();
        await expect(
          f.runtime.reconfigureLiveOwner(f.session, { modelConfig: {}, skillsConfig: [] }),
        ).rejects.toThrow(/^LIVE_/);
        expect(f.launch).toHaveBeenCalledTimes(1);
        expect(f.process.close).not.toHaveBeenCalled();
      } finally {
        await f.cleanup();
      }
    },
  );
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

describe('discovery on the captured original before readiness', () => {
  async function discoveryFixture(
    change?:
      | 'config'
      | 'account'
      | 'birth'
      | 'environment'
      | 'invalid-models'
      | 'failure'
      | 'pending'
      | 'name-failure'
      | 'name-invalid'
      | 'name-pending',
  ) {
    // A real physical lifetime with simulated protocol responses; no Native/provider claim.
    const child = spawn(
      process.execPath,
      ['-e', 'process.stdout.write("ready");setInterval(()=>{},1000)'],
      {
        env: { HOME: '/original', CODEX_HOME: '/original', TMPDIR: '/tmp' },
        stdio: 'pipe',
      },
    );
    const closed = new Promise<void>((done) => child.once('close', () => done()));
    await once(child.stdout, 'data');
    const calls: string[] = [];
    const details: { method: string; params: unknown }[] = [];
    let naming!: () => void;
    const atName = new Promise<void>((done) => {
      naming = done;
    });
    let configs = 0,
      accounts = 0,
      observations = 0;
    let modelEntered!: () => void, finishModel!: (value: unknown) => void;
    const atModel = new Promise<void>((done) => {
      modelEntered = done;
    });
    const pending = new Promise<unknown>((done) => {
      finishModel = done;
    });
    const close = vi.fn(() => child.kill('SIGTERM'));
    const source: AppServer = {
      close,
      waitForExit: () => closed,
      observeLiveLaunch: () => {
        const actual = observeLiveProcess(child.pid!);
        return change === 'birth' && ++observations > 1 ? { ...actual, birth: 'changed' } : actual;
      },
      observeLiveEnvironment: () => {
        const actual = readLiveProcessEnvironment(child.pid!);
        return change === 'environment' && calls.includes('model/list')
          ? { ...actual, home: '/changed' }
          : actual;
      },
      observeLiveDescendants: () => {},
      rpc: {
        request: async (method, params) => {
          calls.push(method);
          details.push({ method, params });
          if (method === 'config/read')
            return {
              config: {
                model_provider:
                  change === 'config' && ++configs > 1 ? 'changed' : 'original-provider',
              },
            };
          if (method === 'account/read')
            return {
              account: change === 'account' && ++accounts > 1 ? { id: 'changed' } : null,
              requiresOpenaiAuth: false,
            };
          if (method === 'model/list') {
            modelEntered();
            if (change === 'failure') throw new Error('DISCOVERY_FAILED');
            if (change === 'pending') return pending;
            return change === 'invalid-models'
              ? { data: [{ id: null }] }
              : { data: [{ id: 'selected' }] };
          }
          if (method === 'skills/list')
            return {
              data: [
                {
                  cwd: process.cwd(),
                  errors: [],
                  skills: [
                    {
                      name: 'Actual skill',
                      path: '/actual/SKILL.md',
                      enabled: true,
                      description: 'actual',
                    },
                  ],
                },
              ],
            };
          if (method === 'thread/start') return { thread: { id: 'original-thread' } };
          if (method === 'thread/name/set') {
            naming();
            if (change === 'name-failure') throw new Error('NATIVE_PERSISTENCE_FAILED');
            if (change === 'name-invalid') return { unexpected: true };
            if (change === 'name-pending') return pending;
          }
          return {};
        },
        onNotification: () => () => {},
        onServerRequest: () => () => {},
      },
    };
    const launch = vi.fn(() => source),
      auxiliarySkills = vi.fn(async () => {
        throw new Error('AUXILIARY_FORBIDDEN');
      });
    const args: ConstructorParameters<typeof CodexSessionRuntime> = [launch];
    args[5] = auxiliarySkills;
    args[12] = async (session) => ({
      model_reasoning_effort: session.modelSettings?.reasoningEffort,
    });
    args[16] = async (_session, input) => ({ ...input, liveCaptureId: 'captured-original' });
    const directory = mkdtempSync('/tmp/live-owning-discovery-guard-');
    const owners = new SqliteLiveOwnership(join(directory, 'ownership.sqlite'), 'controller', {
      initialize: true,
    });
    let preparing = false;
    const guard = new LiveDispatchGuard({
      owners,
      scopes: () => null,
      preflightBlocked: () => preparing,
    });
    args[14] = guard;
    args[18] = {
      run: async (session, work) => {
        guard.writer(session);
        preparing = true;
        try {
          return await guard.livePreparation(session, work);
        } finally {
          preparing = false;
        }
      },
    };

    let sealing!: () => void, finishSeal!: () => void;
    const atSeal = new Promise<void>((done) => {
      sealing = done;
    });
    const seal = new Promise<void>((done) => {
      finishSeal = done;
    });
    args[15] = async () => {
      sealing();
      await seal;
    };
    const runtime = new CodexSessionRuntime(...args);
    const session = RelaySession.create({
      id: 'discovering-owner',
      workspaceId: 'workspace',
      workspacePath: process.cwd(),
      provider: 'codex',
      profile: 'default',
      model: 'selected',
      modelSettings: { reasoningEffort: 'high' },
      sandbox: 'workspace-git',
      approvalPolicy: 'never',
      effectiveSkillSelection: { skills: [] },
      now: 'time',
    }).snapshot;
    const select = vi.fn(
      async (discovery: Parameters<Parameters<typeof runtime.startWithDiscovery>[2]>[0]) => {
        expect(discovery.models).toEqual(['selected']);
        return {
          ...session,
          effectiveSkillSelection: {
            skills: discovery.skills.skills.map(({ name, path, enabled }) => ({
              name,
              path,
              enabled,
            })),
          },
        };
      },
    );
    return {
      runtime,
      session,
      select,
      calls,
      details,
      launch,
      auxiliarySkills,
      source,
      child,
      closed,
      atModel,
      atName,
      atSeal,
      finishSeal,
      finishModel,
      close: async () => {
        finishSeal();
        finishModel({ data: [] });
        runtime.stopAll();
        child.kill('SIGTERM');
        await closed;
        owners.close();
        rmSync(directory, { recursive: true, force: true });
      },
    };
  }
  it('uses one physical owner and its actual catalogs, keeps settings, and withholds readiness through seal', async () => {
    const f = await discoveryFixture();
    try {
      let ready = false;
      const start = f.runtime.startWithDiscovery(f.session, 'time', f.select).then((session) => {
        ready = true;
        return session;
      });
      await f.atSeal;
      expect(ready).toBe(false);
      expect(f.launch).toHaveBeenCalledTimes(1);
      expect(f.auxiliarySkills).not.toHaveBeenCalled();
      expect(f.calls).toEqual([
        'initialize',
        'config/read',
        'account/read',
        'model/list',
        'skills/list',
        'config/read',
        'account/read',
        'thread/start',
        'thread/name/set',
      ]);
      expect(f.details.find((call) => call.method === 'thread/start')?.params).toMatchObject({
        historyMode: 'paginated',
        model: 'selected',
      });
      expect(f.details.find((call) => call.method === 'thread/name/set')?.params).toEqual({
        threadId: 'original-thread',
        name: `Gestalt Mobile ${f.session.id}`,
      });
      expect(f.calls).not.toContain('turn/start');
      expect(f.source.observeLiveLaunch!().pid).toBe(f.child.pid);
      f.finishSeal();
      expect(await start).toMatchObject({
        threadId: 'original-thread',
        model: 'selected',
        modelSettings: { reasoningEffort: 'high' },
        executionPolicy: { sandbox: 'workspace-git', approvalPolicy: 'never' },
      });
    } finally {
      await f.close();
    }
  });
  it.each(['name-failure', 'name-invalid'] as const)(
    'requires Native persistence acknowledgement before admission: %s',
    async (change) => {
      const f = await discoveryFixture(change);
      try {
        await expect(f.runtime.startWithDiscovery(f.session, 'time', f.select)).rejects.toThrow();
        await f.closed;
        expect(f.calls).toContain('thread/name/set');
        expect(f.calls).not.toContain('turn/start');
        expect(f.runtime.liveOwnerIds()).toEqual([]);
      } finally {
        await f.close();
      }
    },
  );
  it('cancels pending Native persistence without publishing readiness or running a model turn', async () => {
    const f = await discoveryFixture('name-pending');
    const controller = new AbortController();
    try {
      const started = f.runtime.startWithDiscovery(f.session, 'time', f.select, controller.signal);
      const rejected = expect(started).rejects.toThrow();
      await f.atName;
      controller.abort();
      await rejected;
      await f.closed;
      expect(f.calls).not.toContain('turn/start');
      expect(f.runtime.liveOwnerIds()).toEqual([]);
    } finally {
      await f.close();
    }
  });
  it.each(['config', 'account', 'birth', 'environment', 'invalid-models', 'failure'] as const)(
    'refuses %s changes or failed discovery before thread/model work and closes the owner',
    async (change) => {
      const f = await discoveryFixture(change);
      try {
        await expect(f.runtime.startWithDiscovery(f.session, 'time', f.select)).rejects.toThrow();
        await f.closed;
        expect(f.calls).not.toContain('thread/start');
        expect(f.calls).not.toContain('turn/start');
        expect(f.runtime.liveOwnerIds()).toEqual([]);
      } finally {
        await f.close();
      }
    },
  );
  it('cancels pending discovery, rejects a concurrent acquisition, and fences late replies', async () => {
    const f = await discoveryFixture('pending');
    const cancellation = new AbortController();
    try {
      const started = f.runtime.startWithDiscovery(
        f.session,
        'time',
        f.select,
        cancellation.signal,
      );
      const rejected = expect(started).rejects.toThrow('CODEX_STARTUP_CANCELLED');
      await f.atModel;
      await expect(f.runtime.startWithDiscovery(f.session, 'time', f.select)).rejects.toThrow(
        'LIVE_SESSION_BUSY',
      );
      await expect(
        f.runtime.startWithDiscovery(
          { ...f.session, id: 'concurrent-other-owner' },
          'time',
          f.select,
        ),
      ).rejects.toThrow();
      cancellation.abort();
      await rejected;
      await f.closed;
      f.finishModel({ data: [{ id: 'selected' }] });
      await Promise.resolve();
      expect(f.select).not.toHaveBeenCalled();
      expect(f.calls).not.toContain('thread/start');
      expect(f.launch).toHaveBeenCalledTimes(1);
    } finally {
      await f.close();
    }
  });
});
