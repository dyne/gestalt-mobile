/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  existsSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RelaySession } from '../../features/sessions/model/relay-session.js';
import {
  CodexSessionRuntime,
  type AppServer,
  type AppServerLaunchInput,
} from '../codex/session-runtime.js';
import { observeLiveProcess } from './process-identity.js';
import { JsonRpcClient } from '../codex/json-rpc-client.js';
import { SqliteLiveOwnership, liveAppIdentity } from './sqlite-live-ownership.js';
import { LIVE_OWNING_CATALOG_MS } from './installed-launch-contract.js';
import { ProductionLiveController } from './production-controller.js';
import { LiveDispatchGuard } from './live-dispatch.js';
import { PollLiveEvents } from '../../features/live-design/application/poll-events.js';
import { LivePollLoop } from '../../features/live-design/application/poll-loop.js';
import { SqliteLiveEventInbox } from './sqlite-event-inbox.js';
import { captureLiveInjection } from './injection-cleanup.js';
import type { CaddyRouteStore } from './caddy-route-store.js';
import type { RegisteredPreviewTargets } from './preview-targets.js';

function session() {
  return RelaySession.create({
    id: 'owning-session',
    provider: 'codex',
    workspaceId: 'workspace',
    workspacePath: process.cwd(),
    profile: 'default',
    model: 'selected-model',
    effectiveSkillSelection: { skills: [] },
    now: 'time',
  }).snapshot;
}
// Deterministic RPC fixture; the Linux observation test separately uses an actual owned child.
function fixture(
  observe = true,
  hooks: {
    beforeLaunch?: ConstructorParameters<typeof CodexSessionRuntime>[16];
    beforeThread?: ConstructorParameters<typeof CodexSessionRuntime>[17];
    dispatch?: ConstructorParameters<typeof CodexSessionRuntime>[14];
    lifetime?: boolean;
  } = {},
) {
  const calls: { method: string; params: unknown }[] = [];
  let configuration: () => Promise<unknown> = async () => ({ config: {}, layers: [] });
  let children: () => Promise<unknown> = async () => ({ data: [], nextCursor: null });
  let loaded: () => Promise<unknown> = async () => ({ data: ['same-thread'], nextCursor: null });
  let mcp: (params: unknown) => Promise<unknown> = async () => ({ data: [], nextCursor: null });
  let mcpTool: (params: unknown) => Promise<unknown> = async () => ({});
  let notify: Parameters<AppServer['rpc']['onNotification']>[0] = () => {};
  let exited: () => void = () => {};
  let closeLifetime!: () => void;
  const lifetime = new Promise<void>((resolve) => {
    closeLifetime = resolve;
  });
  const process: AppServer = {
    rpc: {
      request: async (method, params) => {
        calls.push({ method, params });
        if (method === 'thread/start' || method === 'thread/resume')
          return {
            thread: { id: 'same-thread' },
            model: 'selected-model',
            cwd: globalThis.process.cwd(),
            activePermissionProfile: { id: 'workspace-git', extends: ':workspace' },
            runtimeWorkspaceRoots: [globalThis.process.cwd()],
            sandbox: { type: 'workspaceWrite', networkAccess: false },
            instructionSources: [],
          };
        if (method === 'config/read') return configuration();
        if (method === 'account/read') return { account: null, requiresOpenaiAuth: false };
        if (method === 'model/list') return { data: [{ id: 'selected-model' }] };
        if (method === 'skills/list')
          return { data: [{ cwd: globalThis.process.cwd(), skills: [], errors: [] }] };
        if (method === 'thread/backgroundTerminals/list') return { data: [], nextCursor: null };
        if (method === 'thread/list') return children();
        if (method === 'thread/loaded/list') return loaded();
        if (method === 'thread/unsubscribe') return { status: 'unsubscribed' };
        if (method === 'thread/read') {
          const id = (params as { threadId: string }).threadId;
          return {
            thread:
              id === 'same-thread'
                ? {
                    id,
                    sessionId: 'native-session',
                    parentThreadId: null,
                    status: { type: 'idle' },
                    ...((params as { includeTurns?: boolean }).includeTurns ? { turns: [] } : {}),
                  }
                : ((await children()) as { data: { id: string }[] }).data.find(
                    (thread) => thread.id === id,
                  ),
          };
        }
        if (method === 'mcpServerStatus/list') return mcp(params);
        if (method === 'mcpServer/tool/call') return mcpTool(params);
        return {};
      },
      onNotification: (listener) => {
        notify = listener;
        return () => {};
      },
      onServerRequest: () => () => {},
    },
    close: vi.fn(),
    waitForLiveImage: async () => ({ elapsedMs: 0, budgetMs: 90_000 }),
    ...(hooks.lifetime
      ? {
          onExit: (listener: () => void) => {
            exited = listener;
            return () => {};
          },
          waitForExit: () => lifetime,
        }
      : {}),
    ...(observe ? { observeLiveLaunch: () => observeLiveProcess(globalThis.process.pid) } : {}),
  };
  const launch = vi.fn<(input: AppServerLaunchInput) => AppServer>(() => process);
  const arguments_: ConstructorParameters<typeof CodexSessionRuntime> = [launch];
  arguments_[16] = hooks.beforeLaunch;
  arguments_[17] = hooks.beforeThread;
  arguments_[14] = hooks.dispatch;
  const runtime = new CodexSessionRuntime(...arguments_);
  return {
    runtime,
    process,
    launch,
    calls,
    exit: () => {
      closeLifetime();
      exited();
    },
    notify: (notification: Parameters<typeof notify>[0]) => notify(notification),
    setConfiguration: (read: typeof configuration) => {
      configuration = read;
    },
    setChildren: (read: typeof children) => {
      children = read;
    },
    setLoaded: (read: typeof loaded) => {
      loaded = read;
    },
    setMcp: (read: typeof mcp) => {
      mcp = read;
    },
    setMcpTool: (call: typeof mcpTool) => {
      mcpTool = call;
    },
  };
}
describe('owning runtime admission observations', () => {
  it.each(['completed', 'cancelled'] as const)(
    'keeps the measured context phase bounded and immediately %s',
    async (outcome) => {
      const root = mkdtempSync(join(tmpdir(), 'live-context-budget-'));
      const canary = join(root, 'canary');
      writeFileSync(canary, Buffer.alloc(32), { mode: 0o600 });
      const f = fixture();
      const owner = await f.runtime.start(session(), 'time');
      vi.useFakeTimers();
      try {
        let resolve!: (value: unknown) => void;
        f.setMcpTool(
          () =>
            new Promise((done) => {
              resolve = done;
            }),
        );
        const pending = f.runtime.probeLiveContext(owner, canary);
        if (outcome === 'cancelled') {
          const refusal = expect(pending).rejects.toMatchObject({
            stage: 'context-tool-cancelled',
          });
          f.runtime.stopAll();
          await refusal;
        } else {
          await vi.advanceTimersByTimeAsync(82_183);
          resolve({
            content: [{ type: 'text', text: 'LIVE_ADMISSION_PROBE_V1:{"privateReadDenied":true}' }],
          });
          await expect(pending).resolves.toBeUndefined();
        }
        expect(f.launch).toHaveBeenCalledOnce();
      } finally {
        f.runtime.stopAll();
        vi.useRealTimers();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
  it.each(['module', 'commonjs'])(
    'executes the denial probe in a %s app and refuses readable private state',
    async (type) => {
      const directory = mkdtempSync(join(tmpdir(), 'live-context-module-'));
      const canary = join(directory, 'canary');
      writeFileSync(canary, Buffer.alloc(32), { mode: 0o600 });
      writeFileSync(join(directory, 'package.json'), JSON.stringify({ type }));
      const f = fixture();
      try {
        const owning = await f.runtime.start(session(), 'time');
        f.setMcpTool(async (params) => {
          const request = params as {
            threadId: string;
            server: string;
            tool: string;
            arguments: { code: string };
          };
          expect(request).toMatchObject({
            threadId: owning.threadId,
            server: 'context-mode',
            tool: 'ctx_execute',
          });
          const script = join(directory, 'probe.js');
          // Match the context wrapper's module-scoped require handling. This
          // process deliberately has no sandbox, so readable state must refuse.
          writeFileSync(
            script,
            `(function(require){async function run(){${request.arguments.code}}run().catch(()=>{process.exitCode=1});})(typeof require!=='undefined'?require:null);`,
          );
          const text = execFileSync(process.execPath, [script], { encoding: 'utf8' });
          expect(text.trim()).toBe('LIVE_ADMISSION_PROBE_V1:{"privateReadDenied":false}');
          return { content: [{ type: 'text', text }] };
        });
        await expect(f.runtime.probeLiveContext(owning, canary)).rejects.toMatchObject({
          message: 'LIVE_CONTEXT_PROBE_UNAVAILABLE',
          stage: 'context-denial-not-proven',
        });
      } finally {
        f.runtime.stopAll();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
  it('does not renew a disposed captured owner through ordinary rollback restoration', async () => {
    const beforeLaunch = vi.fn(async (_session, input) => ({
      ...input,
      liveCaptureId: 'original-capture',
    }));
    const f = fixture(true, { beforeLaunch });
    const owning = await f.runtime.start(session(), 'time');
    f.runtime.stop(owning.id);
    await expect(
      f.runtime.restoreLiveOwner(owning, 'later', { modelConfig: {}, skillsConfig: undefined }),
    ).rejects.toThrow('LIVE_RUNTIME_RENEWAL_REQUIRED');
    expect(beforeLaunch).toHaveBeenCalledTimes(1);
    expect(f.launch).toHaveBeenCalledTimes(1);
    expect(f.runtime.liveOwnerIds()).toEqual([]);
  });
  it('awaits private capture before launching the original process and refuses a failed capture', async () => {
    const beforeLaunch = vi.fn(async (_session, input) => ({
      ...input,
      liveCaptureId: 'controller-token',
    }));
    const f = fixture(true, { beforeLaunch });
    try {
      await f.runtime.start(session(), 'time');
      expect(beforeLaunch).toHaveBeenCalledTimes(1);
      expect(f.launch.mock.calls[0]![0]).toMatchObject({ liveCaptureId: 'controller-token' });
    } finally {
      f.runtime.stopAll();
    }
    const denied = fixture(true, {
      beforeLaunch: async () => {
        throw new Error('LIVE_RUNTIME_PROVENANCE_UNAVAILABLE');
      },
    });
    await expect(denied.runtime.start(session(), 'time')).rejects.toThrow(
      'LIVE_RUNTIME_PROVENANCE_UNAVAILABLE',
    );
    expect(denied.launch).not.toHaveBeenCalled();
  });
  it('checks final original thread flags before native startup can execute configured delegates', async () => {
    const beforeThread = vi.fn(() => {
      throw new Error('LIVE_ORIGINAL_LAUNCH_UNVERIFIED');
    });
    const f = fixture(true, { beforeThread });
    await expect(f.runtime.start(session(), 'time')).rejects.toThrow(
      'LIVE_ORIGINAL_LAUNCH_UNVERIFIED',
    );
    expect(beforeThread).toHaveBeenCalledTimes(1);
    expect(f.calls.some((call) => call.method === 'initialize')).toBe(true);
    expect(f.calls.some((call) => call.method === 'thread/start')).toBe(false);
    expect(f.runtime.liveOwnerIds()).toEqual([]);
  });
  it('enumerates native spawned children through the sole owner without detached readers or resume', async () => {
    const { runtime, launch, calls, setChildren } = fixture();
    const owning = await runtime.start(session(), 'time');
    let reads = 0;
    setChildren(async () => ({
      data: [
        {
          id: 'actual-child',
          parentThreadId: owning.threadId,
          sessionId: ++reads === 1 ? 'actual-child' : 'native-session',
          source: 'appServer',
          modelProvider: 'selected-custom-provider',
          model: 'selected-model',
          reasoningEffort: 'medium',
          status: { type: 'idle' },
        },
      ],
      nextCursor: null,
    }));
    try {
      const before = calls.length;
      const roster = await runtime.inspectLiveSpawnedChildren(owning);
      expect(launch).toHaveBeenCalledTimes(1);
      expect(calls.slice(before)).toEqual([
        { method: 'thread/read', params: { threadId: owning.threadId, includeTurns: false } },
        {
          method: 'thread/list',
          params: {
            ancestorThreadId: owning.threadId,
            modelProviders: [],
            limit: 64,
          },
        },
        { method: 'thread/read', params: { threadId: 'actual-child', includeTurns: false } },
      ]);
      expect(roster.threads[0]).toMatchObject({
        id: 'actual-child',
        model: 'selected-model',
        reasoningEffort: 'medium',
      });
    } finally {
      runtime.stopAll();
    }
  });
  it('ignores unrelated global children and refuses changed lineage before adopting an own child', async () => {
    const f = fixture();
    const owning = await f.runtime.start(session(), 'time');
    const own = {
      id: 'own-child',
      parentThreadId: owning.threadId,
      sessionId: 'native-session',
      status: { type: 'idle' },
    };
    const foreign = {
      id: 'foreign',
      parentThreadId: 'other-root',
      sessionId: 'other-session',
      status: { type: 'idle' },
    };
    f.setChildren(async () => ({ data: [own, foreign] }));
    try {
      expect(
        (await f.runtime.inspectLiveSpawnedChildren(owning)).threads.map((thread) => thread.id),
      ).toEqual(['own-child']);
      let reads = 0;
      f.setChildren(async () => ({
        data: [++reads === 1 ? own : { ...own, parentThreadId: 'retargeted-root' }],
      }));
      await expect(f.runtime.inspectLiveSpawnedChildren(owning)).rejects.toThrow(
        'LIVE_CHILD_TOPOLOGY_UNAVAILABLE',
      );
    } finally {
      f.runtime.stopAll();
    }
  });
  it.each([
    { data: [{ id: 'foreign', parentThreadId: 'same-thread', sessionId: 'another-session' }] },
    {
      data: [
        { id: 'duplicate', parentThreadId: 'same-thread', sessionId: 'native-session' },
        { id: 'duplicate', parentThreadId: 'same-thread', sessionId: 'native-session' },
      ],
    },
    { data: [], nextCursor: 'incomplete-roster' },
  ])('refuses foreign, ambiguous or incomplete Live child topology', async (reply) => {
    const { runtime, setChildren } = fixture();
    const owning = await runtime.start(session(), 'time');
    setChildren(async () => reply);
    try {
      await expect(runtime.inspectLiveSpawnedChildren(owning)).rejects.toThrow(
        'LIVE_CHILD_TOPOLOGY_UNAVAILABLE',
      );
    } finally {
      runtime.stopAll();
    }
  });
  it('fences a lost owner during Live child enumeration', async () => {
    const { runtime, setChildren } = fixture();
    const owning = await runtime.start(session(), 'time');
    let release: (value: unknown) => void = () => {};
    let entered!: () => void;
    const listing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    setChildren(
      () =>
        new Promise((resolve) => {
          release = resolve;
          entered();
        }),
    );
    const pending = runtime.inspectLiveSpawnedChildren(owning);
    await listing;
    runtime.stopAll();
    release({ data: [] });
    await expect(pending).rejects.toThrow('LIVE_RUNTIME_IDENTITY_CHANGED');
  });
  it('observes native profile provenance and ignores a different child thread settings update', async () => {
    const { runtime, notify } = fixture();
    const owning = await runtime.start(session(), 'time');
    try {
      const first = await runtime.inspectLiveAdmission(owning);
      expect(first.threadSelection?.activePermissionProfile).toEqual({
        id: 'workspace-git',
        extends: ':workspace',
      });
      (first.threadSelection?.activePermissionProfile as { id: string }).id = 'tampered-copy';
      notify({
        method: 'thread/settings/updated',
        params: {
          threadId: 'other-child',
          threadSettings: { activePermissionProfile: { id: ':full' } },
        },
      });
      expect(
        (await runtime.inspectLiveAdmission(owning)).threadSelection?.activePermissionProfile,
      ).toEqual({ id: 'workspace-git', extends: ':workspace' });
      notify({
        method: 'thread/settings/updated',
        params: {
          threadId: owning.threadId,
          threadSettings: {
            model: 'selected-model',
            cwd: owning.workspacePath,
            activePermissionProfile: { id: 'workspace-git', extends: ':workspace' },
            sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
            effort: 'medium',
          },
        },
      });
      expect(
        (await runtime.inspectLiveAdmission(owning)).threadSelection?.runtimeWorkspaceRoots,
      ).toEqual([owning.workspacePath]);
      notify({
        method: 'thread/settings/updated',
        params: {
          threadId: owning.threadId,
          threadSettings: {
            model: 'changed-model',
            cwd: owning.workspacePath,
            activePermissionProfile: { id: ':readOnly' },
            effort: 'low',
          },
        },
      });
      const changed = (await runtime.inspectLiveAdmission(owning)).threadSelection;
      expect(changed?.activePermissionProfile).toEqual({ id: ':readOnly' });
      expect(changed?.model).toBe('changed-model');
      expect(changed?.runtimeWorkspaceRoots).toBeUndefined();
    } finally {
      runtime.stopAll();
    }
  });
  it('reads the existing thread, effective layers and actual MCP without launching another runtime', async () => {
    const { runtime, launch, calls } = fixture();
    const owning = await runtime.start(session(), 'time');
    try {
      const before = calls.length;
      const result = await runtime.inspectLiveAdmission(owning);
      expect(launch).toHaveBeenCalledTimes(1);
      expect(calls.slice(before)).toEqual([
        {
          method: 'mcpServerStatus/list',
          params: { threadId: 'same-thread', serverName: 'context-mode', detail: 'full' },
        },
        {
          method: 'mcpServerStatus/list',
          params: { threadId: 'same-thread', serverName: 'gestalt-org-plan', detail: 'full' },
        },
        { method: 'config/read', params: { cwd: owning.workspacePath, includeLayers: true } },
        { method: 'thread/read', params: { threadId: 'same-thread', includeTurns: false } },
        { method: 'account/read', params: { refreshToken: false } },
      ]);
      expect(result.account).toEqual({ account: null, requiresOpenaiAuth: false });
      expect(result.thread).toEqual({
        thread: {
          id: owning.threadId,
          sessionId: 'native-session',
          parentThreadId: null,
          status: { type: 'idle' },
        },
      });
      await expect(runtime.inspectLiveAdmission({ ...owning, provider: 'kimi' })).rejects.toThrow(
        'LIVE_RUNTIME_UNAVAILABLE',
      );
      await expect(
        runtime.inspectLiveAdmission({ ...owning, threadId: 'foreign-thread' }),
      ).rejects.toThrow('LIVE_RUNTIME_UNAVAILABLE');
    } finally {
      runtime.stopAll();
    }
  });
  it('refuses a resource with no native process provenance', async () => {
    const { runtime, launch } = fixture(false);
    const owning = await runtime.start(session(), 'time');
    try {
      await expect(runtime.inspectLiveAdmission(owning)).rejects.toThrow(
        'LIVE_RUNTIME_UNAVAILABLE',
      );
      expect(launch).toHaveBeenCalledTimes(1);
    } finally {
      runtime.stopAll();
    }
  });
  it('fences a lost owning resource while configuration inspection is outstanding', async () => {
    const { runtime, setConfiguration } = fixture();
    const owning = await runtime.start(session(), 'time');
    let release: (value: unknown) => void = () => {};
    let entered!: () => void;
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    setConfiguration(
      () =>
        new Promise((resolve) => {
          release = resolve;
          entered();
        }),
    );
    const pending = runtime.inspectLiveAdmission(owning);
    const rejected = expect(pending).rejects.toThrow('LIVE_RUNTIME_UNAVAILABLE');
    await reading;
    runtime.stopAll();
    release({ config: {}, layers: [] });
    await rejected;
  });
  it('awaits a cold owning catalog beyond five seconds and reads current sources afterwards', async () => {
    const f = fixture();
    const owning = await f.runtime.start(session(), 'time');
    let release!: (value: unknown) => void;
    f.setMcp(async (params) => {
      const name = (params as { serverName: string }).serverName;
      if (name === 'context-mode') return new Promise((resolve) => (release = resolve));
      return { data: [{ name, runtimeStatus: 'connected', tools: {} }], nextCursor: null };
    });
    vi.useFakeTimers();
    try {
      let complete = false;
      const observed = f.runtime.inspectLiveAdmission(owning).then((value) => {
        complete = true;
        return value;
      });
      await vi.advanceTimersByTimeAsync(33_654);
      expect(complete).toBe(false);
      f.setConfiguration(async () => ({ config: { current: true }, layers: [] }));
      release({
        data: [{ name: 'context-mode', runtimeStatus: 'connected', tools: { actual: {} } }],
        nextCursor: null,
      });
      const result = await observed;
      expect(result.configuration).toEqual({ config: { current: true }, layers: [] });
      expect(result.mcp).toMatchObject({ data: [{ tools: { actual: {} } }, {}] });
      expect(f.launch).toHaveBeenCalledTimes(1);
      expect(f.calls.some((call) => call.method === 'turn/start')).toBe(false);
    } finally {
      f.runtime.stopAll();
      vi.useRealTimers();
    }
  });
  it('observes terminal owning statuses instead of accepting an asynchronously starting proxy', async () => {
    const f = fixture();
    const owning = await f.runtime.start(session(), 'time');
    let attempts = 0;
    f.setMcp(async (params) => {
      const name = (params as { serverName: string }).serverName;
      return {
        data: [
          {
            name,
            runtimeStatus: name === 'context-mode' && attempts++ === 0 ? 'starting' : 'failed',
            tools: {},
          },
        ],
        nextCursor: null,
      };
    });
    try {
      const result = await f.runtime.inspectLiveAdmission(owning);
      expect(result.mcp).toMatchObject({
        data: [{ runtimeStatus: 'failed' }, { runtimeStatus: 'failed' }],
      });
      const queries = f.calls.filter((call) => call.method === 'mcpServerStatus/list');
      expect(queries).toHaveLength(3);
      expect(
        queries.every((call) => (call.params as { threadId: string }).threadId === owning.threadId),
      ).toBe(true);
      expect(queries.every((call) => (call.params as { serverName?: string }).serverName)).toBe(
        true,
      );
    } finally {
      f.runtime.stopAll();
    }
  });
  it('bounds a stalled owning catalog without launching a replacement or observing stale sources', async () => {
    const f = fixture();
    const owning = await f.runtime.start(session(), 'time');
    const releases: ((value: unknown) => void)[] = [];
    f.setMcp(() => new Promise((resolve) => releases.push(resolve)));
    vi.useFakeTimers();
    try {
      const before = f.calls.length;
      const rejected = expect(f.runtime.inspectLiveAdmission(owning)).rejects.toThrow(
        'LIVE_RUNTIME_UNAVAILABLE',
      );
      await vi.advanceTimersByTimeAsync(LIVE_OWNING_CATALOG_MS - 1);
      expect(f.calls.slice(before).map((call) => call.method)).toEqual([
        'mcpServerStatus/list',
        'mcpServerStatus/list',
      ]);
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(f.calls.slice(before).map((call) => call.method)).toEqual([
        'mcpServerStatus/list',
        'mcpServerStatus/list',
      ]);
      expect(f.launch).toHaveBeenCalledTimes(1);
    } finally {
      for (const release of releases) release({ data: [], nextCursor: null });
      f.runtime.stopAll();
      vi.useRealTimers();
    }
  });
  it('cancels pending owning catalog discovery on stop and fences a late reply', async () => {
    const f = fixture();
    const owning = await f.runtime.start(session(), 'time');
    const releases: ((value: unknown) => void)[] = [];
    f.setMcp(() => new Promise((resolve) => releases.push(resolve)));
    const before = f.calls.length;
    const rejected = expect(f.runtime.inspectLiveAdmission(owning)).rejects.toThrow(
      'LIVE_RUNTIME_UNAVAILABLE',
    );
    f.runtime.stop(owning.id);
    await rejected;
    for (const release of releases) release({ data: [], nextCursor: null });
    await Promise.resolve();
    expect(f.calls.slice(before).map((call) => call.method)).toEqual([
      'mcpServerStatus/list',
      'mcpServerStatus/list',
    ]);
    expect(f.runtime.liveOwnerIds()).toEqual([]);
    expect(f.launch).toHaveBeenCalledTimes(1);
  });
});

describe('renewal through a private owning RPC', () => {
  const dispatch = { writer: vi.fn(), check: vi.fn(), interaction: vi.fn(), blocked: () => false };
  it('reconfigures and settles historical children only after actual notLoaded and loaded-registry absence', async () => {
    const f = fixture(true, { lifetime: true, dispatch });
    const owner = await f.runtime.start(session(), 'time');
    f.setChildren(async () => ({
      data: [
        {
          id: 'historical-child',
          parentThreadId: owner.threadId,
          sessionId: 'historical-child',
          status: { type: 'notLoaded' },
        },
      ],
      nextCursor: null,
    }));
    try {
      await f.runtime.reconfigureLiveOwner(owner, { modelConfig: {}, skillsConfig: [] });
      await f.runtime.reconfigureLiveOwner(owner, { modelConfig: {}, skillsConfig: [] });
      const writes = dispatch.writer.mock.calls.length;
      await f.runtime.inspectLiveQuiescence(owner);
      await f.runtime.settleLiveWork(owner, () => {});
      expect(dispatch.writer.mock.calls).toHaveLength(writes);
      expect(f.calls.filter((call) => call.method === 'thread/loaded/list').length).toBeGreaterThan(
        0,
      );
      expect(
        f.calls
          .filter((call) => (call.params as { threadId?: string })?.threadId === 'historical-child')
          .every(
            (call) =>
              call.method === 'thread/unsubscribe' ||
              (call.method === 'thread/read' &&
                (call.params as { includeTurns?: boolean }).includeTurns === false),
          ),
      ).toBe(true);
      expect(f.launch).toHaveBeenCalledOnce();
    } finally {
      f.runtime.stopAll();
    }
  });
  it.each(['still-loaded', 'unbounded', 'unknown-registry', 'duplicate-registry'])(
    'refuses %s historical identity without loading or adopting it',
    async (kind) => {
      const f = fixture(true, { lifetime: true });
      const owner = await f.runtime.start(session(), 'time');
      f.setChildren(async () => ({
        data: [
          {
            id: 'historical-child',
            parentThreadId: owner.threadId,
            sessionId: 'historical-child',
            status: { type: 'notLoaded' },
          },
        ],
        nextCursor: null,
      }));
      f.setLoaded(async () =>
        kind === 'still-loaded'
          ? { data: ['same-thread', 'historical-child'], nextCursor: null }
          : kind === 'unbounded'
            ? { data: ['same-thread'], nextCursor: 'more' }
            : kind === 'duplicate-registry'
              ? { data: ['same-thread', 'same-thread'], nextCursor: null }
              : {},
      );
      try {
        await expect(f.runtime.inspectLiveQuiescence(owner)).rejects.toThrow(
          'LIVE_CHILD_TOPOLOGY_UNAVAILABLE',
        );
        expect(f.calls.some((call) => call.method === 'thread/unsubscribe')).toBe(false);
        expect(f.launch).toHaveBeenCalledOnce();
      } finally {
        f.runtime.stopAll();
      }
    },
  );
  it('checks actual terminals when Native caches a child without a watch subscription', async () => {
    const f = fixture(true, { lifetime: true });
    const owner = await f.runtime.start(session(), 'time');
    f.setChildren(async () => ({
      data: [
        {
          id: 'cached-child',
          parentThreadId: owner.threadId,
          sessionId: 'native-session',
          status: { type: 'notLoaded' },
        },
      ],
      nextCursor: null,
    }));
    f.setLoaded(async () => ({ data: ['same-thread', 'cached-child'], nextCursor: null }));
    try {
      await f.runtime.inspectLiveQuiescence(owner);
      expect(
        f.calls.some(
          (call) =>
            call.method === 'thread/backgroundTerminals/list' &&
            (call.params as { threadId?: string }).threadId === 'cached-child',
        ),
      ).toBe(true);
    } finally {
      f.runtime.stopAll();
    }
  });
  it.each(['unchanged', 'notification', 'effect'] as const)(
    'requires actual unchanged idle observation before settling an exited %s owner',
    async (change) => {
      const f = fixture(true, {
        lifetime: true,
        dispatch,
        beforeLaunch: async (_session, input) => ({ ...input, liveCaptureId: 'captured' }),
      });
      const owner = await f.runtime.start(session(), 'time');
      await f.runtime.inspectLiveQuiescence(owner);
      if (change === 'notification') f.notify({ method: 'unknown/stateChanged', params: {} });
      if (change === 'effect')
        await f.runtime.startTurn(owner, 'fixture', undefined, 'later').catch(() => {});
      f.exit();
      const settled = f.runtime.settleLiveWork(owner, () => {});
      if (change === 'unchanged') await expect(settled).resolves.toEqual([]);
      else await expect(settled).rejects.toThrow('LIVE_NATIVE_SETTLEMENT_UNAVAILABLE');
      expect(f.launch).toHaveBeenCalledOnce();
    },
  );
  it('refuses an invented replacement token before launching a process or consulting auxiliary discovery', async () => {
    const f = fixture(true, {
      dispatch,
      beforeLaunch: async (_session, input) => ({ ...input, liveCaptureId: 'original' }),
    });
    const owner = await f.runtime.start(session(), 'time');
    f.runtime.stop(owner.id);
    const fence = { liveId: 'live', generation: 3, controllerEpoch: 1, revision: 4 };
    const authority = {
      owners: {
        assert: () => ({
          ...fence,
          relayId: owner.id,
          rootThreadId: owner.threadId,
          state: 'starting',
          phase: 'resume:prepare:intent',
        }),
      } as never,
      fence,
      captureId: '6eaa81bc-763f-4bf2-84f0-980b94325cdc',
    };
    await expect(
      f.runtime.restoreRenewedLiveOwner(
        owner,
        'later',
        { modelConfig: {}, skillsConfig: [] },
        authority,
      ),
    ).rejects.toThrow('LIVE_RUNTIME_RENEWAL_INVALID');
    expect(f.launch).toHaveBeenCalledOnce();
  });
  it('discovers actual replacement catalogs before resuming the exact selected thread', async () => {
    const capture = '6eaa81bc-763f-4bf2-84f0-980b94325cdc';
    let fresh = false;
    const f = fixture(true, {
      dispatch,
      beforeLaunch: async (_session, input) => ({
        ...input,
        liveCaptureId: fresh ? capture : 'original',
      }),
    });
    const owner = await f.runtime.start(session(), 'time');
    f.runtime.stop(owner.id);
    fresh = true;
    const fence = { liveId: 'live', generation: 3, controllerEpoch: 1, revision: 4 };
    const owners = {
      assert: () => ({
        ...fence,
        relayId: owner.id,
        rootThreadId: owner.threadId,
        state: 'starting',
        phase: 'resume:prepare:intent',
      }),
    } as never;
    const before = f.calls.length;
    const restored = await f.runtime.restoreRenewedLiveOwner(
      owner,
      'later',
      { modelConfig: {}, skillsConfig: [] },
      { owners, fence, captureId: capture },
    );
    expect(restored.threadId).toBe(owner.threadId);
    const methods = f.calls.slice(before).map((call) => call.method);
    expect(methods.indexOf('model/list')).toBeLessThan(methods.indexOf('thread/resume'));
    expect(methods.indexOf('skills/list')).toBeLessThan(methods.indexOf('thread/resume'));
    expect(
      f.calls.slice(before).find((call) => call.method === 'thread/resume')?.params,
    ).toMatchObject({ threadId: owner.threadId, model: 'selected-model' });
    expect(f.launch).toHaveBeenCalledTimes(2);
    f.runtime.stopAll();
  });
});

function retirementAuthority(owning: ReturnType<typeof session>) {
  const root = mkdtempSync(join(tmpdir(), 'live-observation-retirement-'));
  mkdirSync(join(root, 'app'));
  const owners = new SqliteLiveOwnership(join(root, 'owners.sqlite'), 'controller', {
    initialize: true,
  });
  let fence = owners.claim({
    relayId: owning.id,
    appId: 'app',
    rootThreadId: owning.threadId!,
    provider: 'codex',
    app: liveAppIdentity(join(root, 'app')),
    targetId: 'target',
    targetIdentity: 'socket',
    operationId: 'start',
    previewOrigin: 'https://preview.test:9443',
    authSessionHash: 'hash',
    deviceId: 'device',
  }).run;
  fence = owners.mutate(fence, { event: 'stop' });
  return {
    authority: { owners, fence },
    close() {
      owners.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

it('overlaps only two exact owning catalogs and reads mutable sources only after both finish', async () => {
  const f = fixture();
  const owning = await f.runtime.start(session(), 'time');
  const releases: ((value: unknown) => void)[] = [];
  f.setMcp(() => new Promise((resolve) => releases.push(resolve)));
  const before = f.calls.length;
  const pending = f.runtime.inspectLiveAdmission(owning);
  expect(f.calls.slice(before)).toEqual(
    ['context-mode', 'gestalt-org-plan'].map((serverName) => ({
      method: 'mcpServerStatus/list',
      params: { threadId: owning.threadId, serverName, detail: 'full' },
    })),
  );
  try {
    releases[0]({ data: [], nextCursor: null });
    await Promise.resolve();
    expect(f.calls.slice(before)).toHaveLength(2);
    f.setConfiguration(async () => ({ config: { currentAfterBoth: true }, layers: [] }));
    releases[1]({ data: [], nextCursor: null });
    expect((await pending).configuration).toMatchObject({ config: { currentAfterBoth: true } });
    expect(f.calls.slice(before).map((v) => v.method)).toEqual([
      'mcpServerStatus/list',
      'mcpServerStatus/list',
      'config/read',
      'thread/read',
      'account/read',
    ]);
  } finally {
    for (const release of releases) release({ data: [], nextCursor: null });
    await pending.catch(() => {});
    f.runtime.stopAll();
  }
});

it.each(['wrong-server', 'pagination', 'unknown-status', 'refused'] as const)(
  'retains a hung raw peer after %s until both bounded outcomes and fenced physical drainage',
  async (mutation) => {
    const f = fixture(true, { lifetime: true });
    const owning = await f.runtime.start(session(), 'time');
    const a = retirementAuthority(owning);
    let release!: (v: unknown) => void;
    f.setMcp(async (params) => {
      if ((params as { serverName: string }).serverName === 'gestalt-org-plan')
        return new Promise((resolve) => {
          release = resolve;
        });
      if (mutation === 'refused') throw new Error('REFUSED');
      return {
        data: [
          {
            name: mutation === 'wrong-server' ? 'foreign' : 'context-mode',
            runtimeStatus: mutation === 'unknown-status' ? 'invented' : 'connected',
          },
        ],
        nextCursor: mutation === 'pagination' ? 'cursor' : null,
      };
    });
    vi.useFakeTimers();
    try {
      const before = f.calls.length;
      let rejected = false;
      const pending = f.runtime.inspectLiveAdmission(owning).catch((error) => {
        rejected = true;
        return error;
      });
      await vi.advanceTimersByTimeAsync(LIVE_OWNING_CATALOG_MS - 1);
      expect(rejected).toBe(false);
      expect(f.calls.slice(before)).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toBeInstanceOf(Error);
      f.runtime.stop(owning.id);
      f.exit();
      await expect(f.runtime.restore(owning, 'later')).rejects.toThrow(
        'LIVE_RUNTIME_LIFETIME_UNVERIFIED',
      );
      let drained = false;
      const retirement = f.runtime.abortLiveOwner(owning, a.authority).then(() => {
        drained = true;
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(drained).toBe(false);
      release({ data: [], nextCursor: null });
      await retirement;
      expect(drained).toBe(true);
      expect(f.launch).toHaveBeenCalledOnce();
      expect(f.launch.mock.results[0].value.close).toHaveBeenCalledOnce();
    } finally {
      release?.({ data: [], nextCursor: null });
      f.runtime.stopAll();
      a.close();
      vi.useRealTimers();
    }
  },
);

it('Stop interrupts bounded inspection without dropping raw obligations after resource-map removal', async () => {
  const f = fixture(true, { lifetime: true });
  const owning = await f.runtime.start(session(), 'time');
  const a = retirementAuthority(owning);
  const releases: ((v: unknown) => void)[] = [];
  f.setMcp(() => new Promise((resolve) => releases.push(resolve)));
  try {
    const failed = expect(f.runtime.inspectLiveAdmission(owning)).rejects.toThrow(
      'LIVE_RUNTIME_UNAVAILABLE',
    );
    f.runtime.cancelLiveAdmission(owning, a.authority);
    await failed;
    expect(releases).toHaveLength(2);
    f.runtime.stop(owning.id);
    f.exit();
    expect(f.runtime.liveOwnerIds()).toEqual([]);
    let finished = false;
    const retirement = f.runtime.abortLiveOwner(owning, a.authority).then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    await expect(f.runtime.start(session(), 'later')).rejects.toThrow(
      'LIVE_RUNTIME_LIFETIME_UNVERIFIED',
    );
    for (const release of releases) release({ data: [], nextCursor: null });
    await retirement;
    expect(finished).toBe(true);
    await f.runtime.start(session(), 'later');
    expect(f.launch).toHaveBeenCalledTimes(2);
  } finally {
    for (const release of releases) release({ data: [], nextCursor: null });
    f.runtime.stopAll();
    a.close();
  }
});

it.each(['physical-exit', 'raw-settlement'] as const)(
  'bounded failed %s retains the raw drain obligation and refuses successors',
  async (failure) => {
    const f = fixture(true, { lifetime: true });
    const owning = await f.runtime.start(session(), 'time');
    const a = retirementAuthority(owning);
    const releases: ((v: unknown) => void)[] = [];
    f.setMcp(() => new Promise((resolve) => releases.push(resolve)));
    vi.useFakeTimers();
    try {
      const inspection = expect(f.runtime.inspectLiveAdmission(owning)).rejects.toThrow(
        'LIVE_RUNTIME_UNAVAILABLE',
      );
      f.runtime.cancelLiveAdmission(owning, a.authority);
      await inspection;
      if (failure === 'raw-settlement') f.exit();
      const failed = expect(f.runtime.abortLiveOwner(owning, a.authority)).rejects.toThrow(
        'LIVE_RUNTIME_LIFETIME_UNVERIFIED',
      );
      await vi.advanceTimersByTimeAsync(10000);
      await failed;
      for (const release of releases) release({ data: [], nextCursor: null });
      await expect(f.runtime.start(session(), 'later')).rejects.toThrow(
        'LIVE_RUNTIME_LIFETIME_UNVERIFIED',
      );
      f.exit();
      await f.runtime.abortLiveOwner(owning, a.authority);
      expect(f.launch.mock.results[0].value.close).toHaveBeenCalledOnce();
    } finally {
      for (const release of releases) release({ data: [], nextCursor: null });
      f.exit();
      f.runtime.stopAll();
      a.close();
      vi.useRealTimers();
    }
  },
);

it('drains actual JsonRpcClient raw requests and positively waits for its exact owned child', async () => {
  const f = fixture();
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import {createInterface} from 'node:readline';
    for await (const line of createInterface({input:process.stdin})) {
      const r=JSON.parse(line);let result={};
      if(r.method==='thread/start')result={thread:{id:'same-thread'},model:'selected-model',cwd:process.cwd()};
      if(r.method==='model/list')result={data:[{id:'selected-model'}]};
      if(r.method==='skills/list')result={data:[]};
      if(r.method==='mcpServerStatus/list')continue;
      process.stdout.write(JSON.stringify({id:r.id,result})+'\\n');
    }
  `,
    ],
    { stdio: ['pipe', 'pipe', 'ignore'] },
  );
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
  const rpc = new JsonRpcClient(child.stdout, child.stdin);
  const close = vi.fn(() => {
    child.kill('SIGTERM');
  });
  f.launch.mockImplementation(() => ({
    rpc,
    close,
    observeLiveLaunch: () => observeLiveProcess(child.pid!),
    waitForExit: () => exited,
  }));
  let a: ReturnType<typeof retirementAuthority> | undefined;
  try {
    const owning = await f.runtime.start(session(), 'time');
    a = retirementAuthority(owning);
    const failed = expect(f.runtime.inspectLiveAdmission(owning)).rejects.toThrow(
      'LIVE_RUNTIME_UNAVAILABLE',
    );
    f.runtime.cancelLiveAdmission(owning, a.authority);
    await failed;
    await f.runtime.abortLiveOwner(owning, a.authority);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  } finally {
    child.kill('SIGKILL');
    await exited;
    f.runtime.stopAll();
    a?.close();
  }
});

it('cancels observation while real JsonRpcClient requests remain owned until same-child replies', async () => {
  const f = fixture();
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import {createInterface} from 'node:readline';
    const held=[];const methods=[];
    const reply=(id,result)=>console.log(JSON.stringify({id,result}));
    for await (const line of createInterface({input:process.stdin})) {
      const r=JSON.parse(line);if(r.id===undefined)continue;
      if(r.method==='test/status'){reply(r.id,{held:held.length,methods});continue;}
      if(r.method==='test/release'){
        for(const id of held.splice(0))reply(id,{data:[],nextCursor:null});
        reply(r.id,{});continue;
      }
      methods.push(r.method);let result={};
      if(r.method==='thread/start')result={thread:{id:'same-thread'},model:'selected-model',cwd:process.cwd()};
      if(r.method==='model/list')result={data:[{id:'selected-model'}]};
      if(r.method==='skills/list')result={data:[]};
      if(r.method==='mcpServerStatus/list'){held.push(r.id);continue;}
      reply(r.id,result);
    }
  `,
    ],
    { stdio: ['pipe', 'pipe', 'ignore'] },
  );
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
  const rpc = new JsonRpcClient(child.stdout, child.stdin);
  const close = vi.fn(() => {
    child.kill('SIGTERM');
  });
  f.launch.mockImplementation(() => ({
    rpc,
    close,
    observeLiveLaunch: () => observeLiveProcess(child.pid!),
    waitForExit: () => exited,
  }));
  let a: ReturnType<typeof retirementAuthority> | undefined;
  let inspection: Promise<unknown> | undefined, settlement: Promise<void> | undefined;
  const cancellation = new AbortController();
  try {
    const owning = await f.runtime.start(session(), 'time');
    a = retirementAuthority(owning);
    inspection = f.runtime.inspectLiveAdmission(owning, cancellation.signal);
    const reason = new Error('LIVE_GENERATION_STALE');
    const refused = expect(inspection).rejects.toBe(reason);
    const before = (await rpc.request('test/status', {})) as { held: number; methods: string[] };
    expect(before.held).toBe(2);
    cancellation.abort(reason);
    await refused;
    const resource = [...Reflect.get(f.runtime, 'admissionResources')][0];
    expect(resource.admissionRequests.size).toBe(2);
    let settled = false;
    settlement = f.runtime.settleLiveAdmission(owning, a.authority).then(() => {
      settled = true;
    });
    expect(((await rpc.request('test/status', {})) as { held: number }).held).toBe(2);
    expect(settled).toBe(false);
    expect(child.exitCode).toBe(null);
    expect(child.signalCode).toBe(null);
    expect(close).not.toHaveBeenCalled();
    await rpc.request('test/release', {});
    await settlement;
    expect(resource.admissionRequests.size).toBe(0);
    expect(resource.lifetime.signal.aborted).toBe(false);
    expect(resource.admissionRetirementRequired).toBe(false);
    expect(((await rpc.request('test/status', {})) as { methods: string[] }).methods).toEqual(
      before.methods,
    );
    expect(f.runtime.liveOwnerIds()).toContain(owning.id);
    expect(close).not.toHaveBeenCalled();
  } finally {
    cancellation.abort(new Error('LIVE_GENERATION_STALE'));
    // Release and join every original request before terminating this test-owned child.
    await rpc.request('test/release', {}).catch(() => {});
    await inspection?.catch(() => {});
    await settlement?.catch(() => {});
    f.runtime.stopAll();
    child.kill('SIGKILL');
    await exited;
    a?.close();
  }
});

it('rejects a process-birth mutation during overlapped catalogs before returning admission', async () => {
  const f = fixture();
  const owning = await f.runtime.start(session(), 'time');
  const process = f.launch.mock.results[0].value;
  const observe = process.observeLiveLaunch!;
  const releases: ((v: unknown) => void)[] = [];
  f.setMcp(() => new Promise((resolve) => releases.push(resolve)));
  const pending = f.runtime.inspectLiveAdmission(owning);
  const rejected = expect(pending).rejects.toThrow('LIVE_RUNTIME_IDENTITY_CHANGED');
  try {
    expect(releases).toHaveLength(2);
    const birth = observe();
    process.observeLiveLaunch = () => ({ ...birth, birth: 'changed-birth' });
    for (const release of releases) release({ data: [], nextCursor: null });
    await rejected;
    await expect(f.runtime.start(session(), 'later')).rejects.toThrow(
      'LIVE_RUNTIME_LIFETIME_UNVERIFIED',
    );
    expect(f.launch).toHaveBeenCalledOnce();
  } finally {
    process.observeLiveLaunch = observe;
    for (const release of releases) release({ data: [], nextCursor: null });
    await pending.catch(() => {});
    f.runtime.stopAll();
  }
});

it('rechecks raw drain obligations after asynchronous preparation immediately before successor launch', async () => {
  let continueLaunch!: () => void;
  let entered!: () => void;
  const preparing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let launches = 0;
  const f = fixture(true, {
    beforeLaunch: async (_session, input) => {
      if (++launches > 1) {
        entered();
        await new Promise<void>((resolve) => {
          continueLaunch = resolve;
        });
      }
      return input;
    },
  });
  const owning = await f.runtime.start(session(), 'time');
  const releases: ((v: unknown) => void)[] = [];
  f.setMcp(() => new Promise((resolve) => releases.push(resolve)));
  const successor = f.runtime.start(session(), 'later');
  await preparing;
  const observation = f.runtime.inspectLiveAdmission(owning);
  try {
    expect(releases).toHaveLength(2);
    continueLaunch();
    await expect(successor).rejects.toThrow('LIVE_RUNTIME_LIFETIME_UNVERIFIED');
    expect(f.launch).toHaveBeenCalledOnce();
  } finally {
    continueLaunch?.();
    for (const release of releases) release({ data: [], nextCursor: null });
    await observation.catch(() => {});
    await successor.catch(() => {});
    f.runtime.stopAll();
  }
});

it.each(['account/read', 'config/read'] as const)(
  'refuses an already-running %s peer after one failed inspection poisons the same owner',
  async (heldMethod) => {
    const f = fixture();
    const owning = await f.runtime.start(session(), 'time');
    const rpc = f.launch.mock.results[0].value.rpc;
    const original = rpc.request;
    let refuse!: (error: Error) => void;
    let complete!: (value: unknown) => void;
    let entered!: () => void;
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const methods: string[] = [];
    rpc.request = (method: string, params: unknown) => {
      methods.push(method);
      if (method === heldMethod)
        return new Promise((resolve) => {
          complete = resolve;
          entered();
        });
      return original.call(rpc, method, params);
    };
    let queries = 0;
    f.setMcp(() =>
      ++queries === 1
        ? new Promise((_resolve, reject) => {
            refuse = reject;
          })
        : Promise.resolve({ data: [], nextCursor: null }),
    );
    const first = f.runtime.inspectLiveAdmission(owning);
    const firstRefused = expect(first).rejects.toThrow('REFUSED');
    const peer = f.runtime.inspectLiveAdmission(owning);
    const peerRefused = expect(peer).rejects.toThrow('LIVE_RUNTIME_LIFETIME_UNVERIFIED');
    try {
      await reading;
      refuse(new Error('REFUSED'));
      await firstRefused;
      const beforeCompletion = methods.length;
      complete(
        heldMethod === 'config/read'
          ? { config: {}, layers: [] }
          : { account: null, requiresOpenaiAuth: false },
      );
      await peerRefused;
      expect(methods.slice(beforeCompletion)).toEqual([]);
      await expect(f.runtime.start(session(), 'later')).rejects.toThrow(
        'LIVE_RUNTIME_LIFETIME_UNVERIFIED',
      );
      expect(f.launch).toHaveBeenCalledOnce();
    } finally {
      refuse?.(new Error('REFUSED'));
      complete?.({});
      await first.catch(() => {});
      await peer.catch(() => {});
      f.runtime.stopAll();
    }
  },
);

it('shares concurrent retirement failure and late raw completion cannot release its obligation', async () => {
  const f = fixture(true, { lifetime: true });
  const owning = await f.runtime.start(session(), 'time');
  const a = retirementAuthority(owning);
  const process = f.launch.mock.results[0].value;
  const releases: ((value: unknown) => void)[] = [];
  f.setMcp(() => new Promise((resolve) => releases.push(resolve)));
  let failExit!: (error: Error) => void;
  const wait = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          failExit = reject;
        }),
    )
    .mockResolvedValue(undefined);
  process.waitForExit = wait;
  const inspection = f.runtime.inspectLiveAdmission(owning);
  const refused = expect(inspection).rejects.toThrow('LIVE_RUNTIME_UNAVAILABLE');
  const flights: Promise<unknown>[] = [];
  try {
    f.runtime.cancelLiveAdmission(owning, a.authority);
    await refused;
    flights.push(f.runtime.abortLiveOwner(owning, a.authority).catch((error) => error));
    flights.push(f.runtime.abortLiveOwner(owning, a.authority).catch((error) => error));
    failExit(new Error('LIVE_PROCESS_TREE_UNVERIFIED'));
    for (const release of releases) release({ data: [], nextCursor: null });
    const outcomes = await Promise.all(flights);
    expect(wait).toHaveBeenCalledOnce();
    expect(outcomes.every((value) => value instanceof Error)).toBe(true);
    await expect(f.runtime.start(session(), 'later')).rejects.toThrow(
      'LIVE_RUNTIME_LIFETIME_UNVERIFIED',
    );
    await f.runtime.abortLiveOwner(owning, a.authority);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(process.close).toHaveBeenCalledOnce();
    await f.runtime.start(session(), 'later');
    expect(f.launch).toHaveBeenCalledTimes(2);
  } finally {
    failExit?.(new Error('LIVE_PROCESS_TREE_UNVERIFIED'));
    for (const release of releases) release({ data: [], nextCursor: null });
    await inspection.catch(() => {});
    await Promise.allSettled(flights);
    f.exit();
    f.runtime.stopAll();
    a.close();
  }
});

it('allows concurrent successful inspections on one owner without sharing observations or authority', async () => {
  const f = fixture();
  const owning = await f.runtime.start(session(), 'time');
  const rpc = f.launch.mock.results[0].value.rpc;
  const original = rpc.request;
  const replies: ((value: unknown) => void)[] = [];
  let entered!: () => void;
  const bothReading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  rpc.request = (method: string, params: unknown) =>
    method === 'account/read'
      ? new Promise((resolve) => {
          replies.push(resolve);
          if (replies.length === 2) entered();
        })
      : original.call(rpc, method, params);
  const flights = [f.runtime.inspectLiveAdmission(owning), f.runtime.inspectLiveAdmission(owning)];
  try {
    await bothReading;
    for (const reply of replies) reply({ account: null, requiresOpenaiAuth: false });
    const values = await Promise.all(flights);
    expect(values[0]).not.toBe(values[1]);
    expect(values.every((v) => v.threadSelection?.threadId === owning.threadId)).toBe(true);
    expect(f.calls.filter((v) => v.method === 'mcpServerStatus/list')).toHaveLength(4);
  } finally {
    for (const reply of replies) reply({});
    await Promise.allSettled(flights);
    f.runtime.stopAll();
  }
});

it('shares successful physical and raw retirement across concurrent waiters without a second close', async () => {
  const f = fixture(true, { lifetime: true });
  const owning = await f.runtime.start(session(), 'time');
  const a = retirementAuthority(owning);
  const process = f.launch.mock.results[0].value;
  const wait = vi.fn(process.waitForExit!);
  process.waitForExit = wait;
  const releases: ((value: unknown) => void)[] = [];
  f.setMcp(() => new Promise((resolve) => releases.push(resolve)));
  const inspection = f.runtime.inspectLiveAdmission(owning);
  const refused = expect(inspection).rejects.toThrow('LIVE_RUNTIME_UNAVAILABLE');
  const flights: Promise<void>[] = [];
  let finished = 0;
  try {
    f.runtime.cancelLiveAdmission(owning, a.authority);
    await refused;
    for (let index = 0; index < 2; index++)
      flights.push(
        f.runtime.abortLiveOwner(owning, a.authority).then(() => {
          finished++;
        }),
      );
    expect(wait).toHaveBeenCalledOnce();
    f.exit();
    releases[0]({ data: [], nextCursor: null });
    await Promise.resolve();
    expect(finished).toBe(0);
    releases[1]({ data: [], nextCursor: null });
    await Promise.all(flights);
    expect(finished).toBe(2);
    expect(wait).toHaveBeenCalledOnce();
    expect(process.close).toHaveBeenCalledOnce();
    await f.runtime.start(session(), 'later');
    expect(f.launch).toHaveBeenCalledTimes(2);
  } finally {
    for (const release of releases) release({ data: [], nextCursor: null });
    f.exit();
    await inspection.catch(() => {});
    await Promise.allSettled(flights);
    f.runtime.stopAll();
    a.close();
  }
});

describe('captured image transition before Native startup RPC', () => {
  it('separates a six-second handoff from the unchanged five-second Native RPC clock', async () => {
    vi.useFakeTimers();
    const f = fixture(true, {
      beforeLaunch: async (_session, input) => ({ ...input, liveCaptureId: 'captured' }),
    });
    Reflect.set(f.runtime, 'owningAdmission', {
      run: (_session: unknown, work: () => Promise<unknown>) => work(),
    });
    Reflect.set(f.process, 'observeLiveEnvironment', () => ({
      home: '/tmp',
      codexHome: '/tmp',
      tmpdir: '/tmp',
    }));
    let imageReady = false;
    const phase = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 6000));
      imageReady = true;
      return { elapsedMs: 6000, budgetMs: 90000 };
    });
    Reflect.set(f.process, 'waitForLiveImage', phase);
    const request = f.process.rpc.request;
    f.process.rpc.request = vi.fn((method, params) =>
      method === 'initialize' && !imageReady ? new Promise(() => {}) : request(method, params),
    );
    try {
      const pending = f.runtime.startWithDiscovery(session(), 'time', async () => session());
      const result = pending.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await vi.advanceTimersByTimeAsync(5000);
      expect(f.process.rpc.request).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      expect(await result).not.toHaveProperty('error');
      expect(phase).toHaveBeenCalledOnce();
      expect(f.calls.filter((x) => x.method === 'initialize')).toHaveLength(1);
    } finally {
      f.runtime.stopAll();
      vi.useRealTimers();
    }
  });
});

describe('captured startup failure ownership', () => {
  const captured = () =>
    fixture(true, {
      beforeLaunch: async (_session, input) => ({ ...input, liveCaptureId: 'capture' }),
    });
  const discover = (f: ReturnType<typeof fixture>, signal?: AbortSignal) => {
    Reflect.set(f.runtime, 'owningAdmission', {
      run: (_session: unknown, work: () => Promise<unknown>) => work(),
    });
    Reflect.set(f.process, 'observeLiveEnvironment', () => ({
      home: '/tmp',
      codexHome: '/tmp',
      tmpdir: '/tmp',
    }));
    return f.runtime.startWithDiscovery(session(), 'time', async () => session(), signal);
  };
  it('requires the image fence only for captured owners and refuses successors after a missing fence', async () => {
    const f = captured();
    Reflect.deleteProperty(f.process, 'waitForLiveImage');
    try {
      await expect(discover(f)).rejects.toThrow('LIVE_NATIVE_HANDOFF_UNVERIFIED');
      expect(f.calls).toEqual([]);
      expect(f.process.close).toHaveBeenCalledOnce();
      await expect(f.runtime.start(session(), 'time')).rejects.toThrow(
        'LIVE_RUNTIME_LIFETIME_UNVERIFIED',
      );
      expect(f.launch).toHaveBeenCalledOnce();
    } finally {
      f.runtime.stopAll();
    }
    const ordinary = fixture();
    Reflect.deleteProperty(ordinary.process, 'waitForLiveImage');
    try {
      await expect(ordinary.runtime.start(session(), 'time')).resolves.toMatchObject({
        threadId: 'same-thread',
      });
    } finally {
      ordinary.runtime.stopAll();
    }
  });
  it('cancels an in-flight handoff without dispatch and keeps its cleanup obligation after map removal', async () => {
    const f = captured(),
      abort = new AbortController();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    Reflect.set(
      f.process,
      'waitForLiveImage',
      (signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          entered();
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    try {
      const result = discover(f, abort.signal);
      const refused = expect(result).rejects.toThrow('CODEX_STARTUP_CANCELLED');
      await started;
      expect(f.calls).toEqual([]);
      abort.abort();
      await refused;
      expect(f.process.close).toHaveBeenCalledOnce();
      await expect(f.runtime.start(session(), 'time')).rejects.toThrow(
        'LIVE_RUNTIME_LIFETIME_UNVERIFIED',
      );
      expect(f.launch).toHaveBeenCalledOnce();
    } finally {
      f.runtime.stopAll();
    }
  });
  it('keeps the five-second Native RPC bound and retains late raw replies without successor dispatch', async () => {
    vi.useFakeTimers();
    const f = captured();
    let complete!: (value: unknown) => void;
    const request = f.process.rpc.request,
      raw = new Promise((resolve) => {
        complete = resolve;
      });
    f.process.rpc.request = vi.fn((method, params) =>
      method === 'initialize' ? raw : request(method, params),
    );
    try {
      const result = discover(f).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await vi.advanceTimersByTimeAsync(5001);
      expect(await result).toMatchObject({ error: new Error('CODEX_STARTUP_DISCOVERY_TIMEOUT') });
      expect(f.process.rpc.request).toHaveBeenCalledTimes(1);
      await expect(f.runtime.start(session(), 'time')).rejects.toThrow(
        'LIVE_RUNTIME_LIFETIME_UNVERIFIED',
      );
      complete({});
      await Promise.resolve();
      await Promise.resolve();
      await expect(f.runtime.start(session(), 'time')).rejects.toThrow(
        'LIVE_RUNTIME_LIFETIME_UNVERIFIED',
      );
      expect(f.launch).toHaveBeenCalledOnce();
      expect(f.calls).toEqual([]);
    } finally {
      f.runtime.stopAll();
      vi.useRealTimers();
    }
  });
});

it('settles captured startup RPC ownership before the production owner callback inspects quiescence', async () => {
  const f = fixture(true, {
    lifetime: true,
    beforeLaunch: async (_session, input) => ({ ...input, liveCaptureId: 'captured' }),
  });
  const observed = vi.fn(async (owner: ReturnType<typeof session>) => {
    await f.runtime.inspectLiveQuiescence(owner);
  });
  Reflect.set(f.runtime, 'onOwnerStarted', observed);
  try {
    await expect(f.runtime.start(session(), 'time')).resolves.toMatchObject({
      threadId: 'same-thread',
    });
    expect(observed).toHaveBeenCalledOnce();
  } finally {
    f.exit();
    f.runtime.stopAll();
  }
});

describe('private failed captured-startup settlement', () => {
  async function failed() {
    const f = fixture(true, {
      lifetime: true,
      beforeLaunch: async (_session, input) => ({ ...input, liveCaptureId: 'failed-capture' }),
    });
    Reflect.deleteProperty(f.process, 'waitForLiveImage');
    await expect(f.runtime.start(session(), 'time')).rejects.toThrow();
    return f;
  }
  it('retains the exact failed resource until positive physical closure, then settles idempotently', async () => {
    const f = await failed();
    const revoked = vi.fn();
    const pending = f.runtime.settleFailedStartup(
      session(),
      'failed-capture',
      revoked,
      performance.now() + 1000,
    );
    await expect(f.runtime.start(session(), 'time')).rejects.toThrow(
      'LIVE_RUNTIME_LIFETIME_UNVERIFIED',
    );
    f.exit();
    await pending;
    await f.runtime.settleFailedStartup(
      session(),
      'failed-capture',
      revoked,
      performance.now() + 1000,
    );
    expect(revoked.mock.calls.length).toBeGreaterThan(2);
    await expect(
      f.runtime.settleFailedStartup(session(), 'wrong', revoked, performance.now() + 1000),
    ).rejects.toThrow();
  });
  it.each(['capture', 'revocation', 'closure'] as const)(
    'retains failed startup on %s refusal',
    async (failure) => {
      const f = await failed();
      await expect(
        f.runtime.settleFailedStartup(
          session(),
          failure === 'capture' ? 'wrong' : 'failed-capture',
          () => {
            if (failure === 'revocation') throw new Error('capture changed');
          },
          performance.now() + 20,
        ),
      ).rejects.toThrow();
      await expect(f.runtime.start(session(), 'time')).rejects.toThrow(
        'LIVE_RUNTIME_LIFETIME_UNVERIFIED',
      );
      f.exit();
      await Promise.resolve();
      await expect(f.runtime.start(session(), 'after-late-close')).rejects.toThrow(
        'LIVE_RUNTIME_LIFETIME_UNVERIFIED',
      );
    },
  );
  it('rejects revocation mutation while physical closure is pending without late clearing', async () => {
    const f = await failed();
    let current = true;
    const pending = f.runtime.settleFailedStartup(
      session(),
      'failed-capture',
      () => {
        if (!current) throw new Error('capture changed');
      },
      performance.now() + 1000,
    );
    current = false;
    f.exit();
    await expect(pending).rejects.toThrow('capture changed');
    await expect(f.runtime.start(session(), 'time')).rejects.toThrow(
      'LIVE_RUNTIME_LIFETIME_UNVERIFIED',
    );
  });
});

it('keeps an actual startup JsonRpcClient request and exact child locked until physical close settles both', async () => {
  const f = fixture(true, {
    beforeLaunch: async (_session, input) => ({ ...input, liveCaptureId: 'raw-capture' }),
  });
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], {
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
  const rpc = new JsonRpcClient(child.stdout, child.stdin);
  let dispatched!: () => void;
  const sent = new Promise<void>((resolve) => {
    dispatched = resolve;
  });
  const raw = rpc.request.bind(rpc);
  vi.spyOn(rpc, 'request').mockImplementation((method, params) => {
    const result = raw(method, params);
    if (method === 'initialize') dispatched();
    return result;
  });
  f.launch.mockImplementation(() => ({
    rpc,
    close: vi.fn(), // Deliberately retain the actual pipe until authenticated host cleanup.
    waitForLiveImage: async () => ({ elapsedMs: 0, budgetMs: 90000 }),
    observeLiveLaunch: () => observeLiveProcess(child.pid!),
    waitForExit: () => exited,
  }));
  Reflect.set(f.runtime, 'owningAdmission', {
    run: async (_session: unknown, work: () => Promise<unknown>) => work(),
  });
  const cancel = new AbortController();
  const startup = f.runtime.startWithDiscovery(
    session(),
    'time',
    async () => session(),
    cancel.signal,
  );
  const rejected = expect(startup).rejects.toThrow();
  try {
    await sent;
    cancel.abort();
    await rejected;
    let settled = false;
    const cleanup = f.runtime
      .settleFailedStartup(session(), 'raw-capture', () => {}, performance.now() + 2000)
      .then(() => {
        settled = true;
      });
    await Promise.resolve();
    expect(settled).toBe(false);
    await expect(f.runtime.start(session(), 'later')).rejects.toThrow(
      'LIVE_RUNTIME_LIFETIME_UNVERIFIED',
    );
    child.kill('SIGTERM');
    await cleanup;
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(f.launch).toHaveBeenCalledOnce();
  } finally {
    child.kill('SIGKILL');
    await exited;
    f.runtime.stopAll();
  }
});

it.each(['reply', 'reject'] as const)(
  'cancels only an admission observation and joins original raw catalog %s before ordinary reuse',
  async (outcome) => {
    const f = fixture(true, { lifetime: true });
    const owning = await f.runtime.start(session(), 'time');
    const a = retirementAuthority(owning);
    const pending: { resolve(value: unknown): void; reject(error: Error): void }[] = [];
    f.setMcp(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
    const cancellation = new AbortController();
    let inspection: Promise<unknown> | undefined, settlement: Promise<void> | undefined;
    const reason = new Error('LIVE_GENERATION_STALE');
    try {
      const before = f.calls.length;
      inspection = f.runtime.inspectLiveAdmission(owning, cancellation.signal);
      const refused = expect(inspection).rejects.toBe(reason);
      expect(pending).toHaveLength(2);
      cancellation.abort(reason);
      await refused;
      const resource = [...Reflect.get(f.runtime, 'admissionResources')][0];
      expect(resource.admissionRequests.size).toBe(2);
      expect(resource.lifetime.signal.aborted).toBe(false);
      expect(resource.admissionRetirementRequired).toBe(false);
      let settled = false;
      settlement = f.runtime.settleLiveAdmission(owning, a.authority).then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(() => a.authority.owners.checkOrdinary(owning.id, null)).toThrow();
      for (const operation of pending) {
        if (outcome === 'reply') operation.resolve({ data: [], nextCursor: null });
        else operation.reject(new Error('LATE_RAW_REFUSAL'));
      }
      await settlement;
      expect(settled).toBe(true);
      expect(resource.admissionRequests.size).toBe(0);
      expect(f.calls.slice(before).map((call) => call.method)).toEqual([
        'mcpServerStatus/list',
        'mcpServerStatus/list',
      ]);
      expect(f.process.close).not.toHaveBeenCalled();
      f.setMcp(async () => ({ data: [], nextCursor: null }));
      await expect(f.runtime.inspectLiveAdmission(owning)).resolves.toMatchObject({
        launch: resource.admissionBirth,
      });
      await expect(f.runtime.inspectLiveQuiescence(owning)).resolves.toMatchObject({
        outstanding: { unknown: false },
      });
    } finally {
      for (const operation of pending) operation.resolve({ data: [], nextCursor: null });
      await inspection?.catch(() => {});
      await settlement?.catch(() => {});
      f.exit();
      f.runtime.stopAll();
      a.close();
    }
  },
);

it('keeps a timed-out raw admission locked and refuses stale settlement authority before later exact drain', async () => {
  const f = fixture(true, { lifetime: true });
  const owning = await f.runtime.start(session(), 'time');
  const a = retirementAuthority(owning);
  const releases: ((value: unknown) => void)[] = [];
  f.setMcp(() => new Promise((resolve) => releases.push(resolve)));
  const cancellation = new AbortController();
  const inspection = f.runtime
    .inspectLiveAdmission(owning, cancellation.signal)
    .catch((error) => error);
  let settlement: Promise<void> | undefined;
  try {
    cancellation.abort(new Error('LIVE_GENERATION_STALE'));
    await inspection;
    await expect(
      f.runtime.settleLiveAdmission({ ...owning, threadId: 'successor' }, a.authority),
    ).rejects.toThrow('LIVE_GENERATION_STALE');
    vi.useFakeTimers();
    settlement = f.runtime.settleLiveAdmission(owning, a.authority);
    const refused = expect(settlement).rejects.toThrow('LIVE_RUNTIME_LIFETIME_UNVERIFIED');
    await vi.advanceTimersByTimeAsync(5000);
    await refused;
    const resource = [...Reflect.get(f.runtime, 'admissionResources')][0];
    expect(resource.admissionRequests.size).toBe(2);
    expect(resource.lifetime.signal.aborted).toBe(false);
    expect(() => a.authority.owners.checkOrdinary(owning.id, null)).toThrow();
    for (const release of releases) release({ data: [], nextCursor: null });
    await f.runtime.settleLiveAdmission(owning, a.authority);
    expect(resource.admissionRequests.size).toBe(0);
    expect(f.launch).toHaveBeenCalledOnce();
  } finally {
    for (const release of releases) release({ data: [], nextCursor: null });
    await inspection;
    await settlement?.catch(() => {});
    vi.useRealTimers();
    f.exit();
    f.runtime.stopAll();
    a.close();
  }
});

// Actual controller/runtime/guard/inbox/routes/restoration code. Native RPC and
// helper command ports are controlled; helper/devserver use real owned Node
// children. This is local product regression evidence, not pinned Native proof.
async function stopRestorationFixture() {
  const root = mkdtempSync(join(tmpdir(), 'live-stop-raw-restoration-'));
  const app = join(root, 'app'),
    home = join(root, 'native');
  mkdirSync(app);
  mkdirSync(home);
  const originalConfig = {
    config: { model_providers: { controlled: { requires_openai_auth: false } } },
    layers: [],
  };
  const configPath = join(home, 'config.json');
  writeFileSync(configPath, JSON.stringify(originalConfig));
  const f = fixture(true, { lifetime: true });
  f.setConfiguration(async () => JSON.parse(readFileSync(configPath, 'utf8')));
  const originalRequest = f.process.rpc.request.bind(f.process.rpc);
  f.process.rpc.request = async (method, params) => {
    const result = await originalRequest(method, params);
    if (method !== 'thread/start' && method !== 'thread/resume') return result;
    if (method === 'thread/resume') writeFileSync(configPath, JSON.stringify(originalConfig));
    return {
      ...(result as object),
      modelProvider: 'controlled',
      cwd: app,
      approvalPolicy: 'never',
      reasoningEffort: null,
      sandbox: {
        type: 'workspaceWrite',
        writableRoots: [app],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      },
    };
  };
  const owning = await f.runtime.start({ ...session(), workspacePath: app }, 'time');
  const observation = await f.runtime.inspectLiveAdmission(owning);
  const owners = new SqliteLiveOwnership(join(root, 'owners.sqlite'), 'controller', {
    initialize: true,
  });
  let run = owners.claim({
    relayId: owning.id,
    appId: 'app',
    rootThreadId: owning.threadId!,
    provider: 'codex',
    app: liveAppIdentity(app),
    targetId: 'target',
    targetIdentity: 'socket',
    operationId: 'operation',
    previewOrigin: 'https://preview.test:9443',
    authSessionHash: 'hash',
    deviceId: 'device',
  }).run;
  run = owners.mutate(run, { event: 'phase', phase: 'route:ack' });
  run = owners.mutate(run, { event: 'ready' });
  const socket = join(root, 'admin.sock');
  const controller = new ProductionLiveController(
    owners,
    {
      privateDirectory: join(root, 'controller'),
      caddy: { hostname: 'preview.test', previewPorts: [9443], socketPath: socket },
    } as never,
    { path: join(root, 'source'), sha256: 'a'.repeat(64) },
    async () => {},
    {} as never,
  );
  const origins = Reflect.get(controller, 'origins') as CaddyRouteStore;
  const targets = Reflect.get(controller, 'targets') as RegisteredPreviewTargets;
  const gateway = createServer((_request, response) => response.end('owned fixture gateway'));
  await new Promise<void>((resolve, reject) => {
    gateway.once('error', reject);
    gateway.listen(0, '127.0.0.1', resolve);
  });
  const gatewayPort = (gateway.address() as import('node:net').AddressInfo).port;
  const assignment = origins.assign(app),
    routeBody = { '@id': assignment.serverId, listen: [':9443'] };
  const registrationId = targets.register({
    appRoot: app,
    appPort: 19441,
    helperPort: 19442,
    gatewayPort,
  });
  origins.desire(app, routeBody, registrationId);
  origins.acknowledge(app, JSON.stringify(routeBody));
  const servers: Record<string, unknown> = { [assignment.serverId]: routeBody };
  const admin = createServer((request, response) => {
    if (
      request.method === 'DELETE' &&
      request.url === `/config/apps/http/servers/${assignment.serverId}`
    )
      delete servers[assignment.serverId];
    else if (request.method !== 'GET' || request.url !== '/config/apps/http/servers') {
      response.writeHead(404).end();
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.setHeader('etag', '"fixture-1"');
    response.end(JSON.stringify(request.method === 'GET' ? servers : {}));
  });
  await new Promise<void>((resolve, reject) => {
    admin.once('error', reject);
    admin.listen(socket, resolve);
  });
  const order: string[] = [];
  const children: {
    stop(): Promise<void>;
    diagnostics(): { namespaceExited: boolean; pipeDescriptorsClosed: boolean };
  }[] = [];
  for (const role of ['helper', 'devserver']) {
    const child = spawn(
      process.execPath,
      ['-e', "process.stdout.write('ready');setInterval(()=>{},1000)"],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    await new Promise<void>((resolve, reject) => {
      child.stdout.once('data', () => resolve());
      child.once('error', reject);
    });
    let stopping: Promise<void> | undefined;
    children.push({
      stop: () =>
        (stopping ??= (async () => {
          order.push(`${role}-stop`);
          child.kill('SIGTERM');
          await closed;
        })()),
      diagnostics: () => ({
        namespaceExited: child.exitCode !== null || child.signalCode !== null,
        pipeDescriptorsClosed:
          child.stdout.destroyed && child.stderr.destroyed && child.stdin.destroyed,
      }),
    });
  }
  const live = join(app, '.impeccable/live');
  mkdirSync(live, { recursive: true });
  const chosen = '<h1>chosen accepted source</h1>',
    injected = '<script>live-injection</script>';
  writeFileSync(join(app, 'index.html'), chosen + injected);
  writeFileSync(join(app, 'app.js'), 'chosen module');
  writeFileSync(join(live, 'helper.js'), 'owned-injection');
  writeFileSync(join(live, 'server.json'), '{}');
  writeFileSync(
    join(live, 'inject-journal.json'),
    JSON.stringify({
      version: 1,
      appRoot: app,
      artifacts: [
        { kind: 'patched', path: 'index.html', markers: [injected] },
        { kind: 'created', path: '.impeccable/live/helper.js', marker: 'owned-injection' },
      ],
    }),
  );
  writeFileSync(configPath, JSON.stringify({ ...originalConfig, live: true }));
  const inbox = new SqliteLiveEventInbox(join(root, 'inbox.sqlite'));
  const cli = {
    status: async () => ({ liveServer: { pendingEvents: [] } }),
    poll: vi.fn(async () => ({ type: 'timeout' })),
    reply: vi.fn(async () => ({})),
    complete: vi.fn(async () => ({})),
    settle: vi.fn(async () => {}),
    reconcile: vi.fn(async () => 'a'.repeat(64)),
    removeInjection: async () => {
      order.push('remove-injection');
      writeFileSync(join(app, 'index.html'), chosen);
      unlinkSync(join(live, 'helper.js'));
      unlinkSync(join(live, 'inject-journal.json'));
    },
    forgetExitedServerRecord: () => unlinkSync(join(live, 'server.json')),
  };
  const guard = new LiveDispatchGuard({
    owners,
    scopes: () => [app],
    verifyLiveRuntime: controller.verifyLiveRuntime,
  });
  Reflect.set(f.runtime, 'liveDispatch', guard);
  const turns = {
    apply: vi.fn(async () => ({ status: 'done' as const })),
    settle: vi.fn(async () => {}),
  };
  const poll = new PollLiveEvents({ owners, inbox, cli, authority: guard, turns, now: Date.now });
  const loop = new LivePollLoop({
    owners,
    poll,
    revocations: { revoke: controller.revokePollGeneration },
  });
  const generation = {
    run,
    claim: run,
    plannedGeneration: run.generation,
    session: owning,
    observation,
    policy: { capture: { captureId: 'capture' } },
    app: { appRoot: app },
    resumed: true,
    injected: true,
    injectionArtifacts: captureLiveInjection(app),
    retired: false,
    helper: children[0],
    devserver: children[1],
    cli,
    inbox,
    loop,
    registrationId,
    gateway: {
      close: () =>
        new Promise<void>((resolve, reject) =>
          gateway.close((error) => (error ? reject(error) : resolve())),
        ),
    },
  };
  Reflect.get(controller, 'generations').set(owning.id, generation);
  Reflect.set(controller, 'verifyHost', () => {});
  Reflect.set(controller, 'preview', {
    authentication: { authorized: () => true },
    now: () => new Date(),
  });
  Reflect.set(controller, 'connections', {
    revoke: async () => {
      order.push('streams-revoked');
    },
  });
  Reflect.set(controller, 'revokeCapture', async () => {
    order.push('signed-revoke');
    Reflect.get(controller, 'revokedCaptures').add('capture');
  });
  Reflect.set(controller, 'controls', {
    restore: () => {
      expect(owners.current(run.liveId)?.state).toBe('idle');
      order.push('controls-restored');
    },
  });
  Reflect.set(controller, 'requireBindings', () => ({
    runtime: f.runtime,
    sessions: { find: () => owning },
    guard,
  }));
  const operations: { resolve(value: unknown): void; reject(error: Error): void }[] = [];
  f.setMcp(() => new Promise((resolve, reject) => operations.push({ resolve, reject })));
  let flight: Promise<unknown> | undefined;
  let pollSettled = false;
  const stops: Promise<unknown>[] = [];
  return {
    f,
    controller,
    owners,
    run,
    app,
    configPath,
    originalConfig,
    chosen,
    cli,
    turns,
    operations,
    order,
    children,
    generation,
    origins,
    targets,
    registrationId,
    servers,
    gateway,
    get pollSettled() {
      return pollSettled;
    },
    startPoll() {
      flight = loop
        .run(run)
        .catch((error) => error)
        .finally(() => {
          pollSettled = true;
        });
      return flight;
    },
    stop(generationNumber = run.generation) {
      const result = controller.stop({
        relayId: owning.id,
        liveId: run.liveId,
        generation: generationNumber,
        authSessionHash: 'hash',
        deviceId: 'device',
      });
      stops.push(result);
      return result;
    },
    release(reject = false) {
      f.setMcp(async () => ({ data: [], nextCursor: null }));
      for (const operation of operations) {
        if (reject) operation.reject(new Error('LATE_RAW_REJECTION'));
        else operation.resolve({ data: [], nextCursor: null });
      }
    },
    async close() {
      this.release();
      await Promise.allSettled(stops);
      await flight;
      await Promise.all(children.map((child) => child.stop()));
      if (gateway.listening) await new Promise<void>((resolve) => gateway.close(() => resolve()));
      await new Promise<void>((resolve) => admin.close(() => resolve()));
      f.exit();
      f.runtime.stopAll();
      origins.close();
      try {
        inbox.close();
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'database is not open') throw error;
      }
      owners.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

it.each(['reply', 'reject', 'concurrent', 'stale'] as const)(
  'actual Stop joins a pre-authority raw %s before verified disk/config/injection/routes restoration and process closure',
  async (mode) => {
    const f = await stopRestorationFixture();
    try {
      f.startPoll();
      await vi.waitFor(() => expect(f.operations).toHaveLength(2));
      if (mode === 'stale')
        await expect(f.stop(f.run.generation + 1)).rejects.toThrow('LIVE_GENERATION_STALE');
      let completed = false;
      const stop = f.stop().then((run) => {
        completed = true;
        return run;
      });
      const second =
        mode === 'concurrent'
          ? f.stop().then(
              (value) => value,
              (error) => error,
            )
          : undefined;
      await vi.waitFor(() => expect(f.order).toContain('signed-revoke'));
      await vi.waitFor(() => expect(f.pollSettled).toBe(true));
      expect(completed).toBe(false);
      expect(f.cli.poll).not.toHaveBeenCalled();
      expect(f.turns.apply).not.toHaveBeenCalled();
      expect(() => f.owners.checkOrdinary(f.run.relayId, [f.app])).toThrow();
      expect(readFileSync(join(f.app, 'index.html'), 'utf8')).toContain('live-injection');
      expect(f.children.every((child) => child.diagnostics().namespaceExited)).toBe(false);
      f.release(mode === 'reject');
      expect((await stop).state).toBe('idle');
      if (second) {
        const result = await second;
        if (result instanceof Error) expect(result.message).toBe('LIVE_GENERATION_STALE');
        else expect(result.state).toBe('idle');
      }
      expect(readFileSync(join(f.app, 'index.html'), 'utf8')).toBe(f.chosen);
      expect(readFileSync(join(f.app, 'app.js'), 'utf8')).toBe('chosen module');
      expect(JSON.parse(readFileSync(f.configPath, 'utf8'))).toEqual(f.originalConfig);
      expect(existsSync(join(f.app, '.impeccable/live/inject-journal.json'))).toBe(false);
      expect(existsSync(join(f.app, '.impeccable/live/server.json'))).toBe(false);
      expect(f.origins.read(f.app)).toMatchObject({
        desired: null,
        applied: null,
        registrationId: null,
      });
      expect(Object.keys(f.servers)).toHaveLength(0);
      expect(f.gateway.listening).toBe(false);
      expect(() => f.targets.read(f.registrationId, f.app)).toThrow('LIVE_TARGET_UNREGISTERED');
      expect(f.children.every((child) => Object.values(child.diagnostics()).every(Boolean))).toBe(
        true,
      );
      expect(f.order.indexOf('signed-revoke')).toBeLessThan(f.order.indexOf('remove-injection'));
      expect(f.order.at(-1)).toBe('controls-restored');
      expect(f.f.process.close).not.toHaveBeenCalled(); // Original ordinary Native remains usable.
      expect(f.controller.preflightBlocked()).toBe(false);
      expect(() => f.owners.checkOrdinary(f.run.relayId, [f.app])).not.toThrow();
    } finally {
      await f.close();
    }
  },
);

it('keeps failed Stop visibly locked while raw RPCs remain held, then restores after exact retry and actual settlement', async () => {
  const f = await stopRestorationFixture();
  let stop: Promise<unknown> | undefined;
  try {
    f.startPoll();
    await vi.waitFor(() => expect(f.operations).toHaveLength(2));
    stop = f.stop();
    const refused = expect(stop).rejects.toThrow('LIVE_RUNTIME_LIFETIME_UNVERIFIED');
    await vi.waitFor(() => expect(f.pollSettled).toBe(true));
    await refused;
    expect(f.owners.current(f.run.liveId)?.state).toBe('recoveryRequired');
    expect(() => f.owners.checkOrdinary(f.run.relayId, [f.app])).toThrow();
    expect(readFileSync(join(f.app, 'index.html'), 'utf8')).toContain('live-injection');
    expect(existsSync(join(f.app, '.impeccable/live/inject-journal.json'))).toBe(true);
    expect(f.children.some((child) => child.diagnostics().namespaceExited)).toBe(false);
    const current = f.owners.current(f.run.liveId)!;
    await expect(f.stop(f.run.generation)).rejects.toThrow('LIVE_GENERATION_STALE');
    f.release();
    expect((await f.stop(current.generation)).state).toBe('idle');
    expect(readFileSync(join(f.app, 'index.html'), 'utf8')).toBe(f.chosen);
    expect(JSON.parse(readFileSync(f.configPath, 'utf8'))).toEqual(f.originalConfig);
    expect(f.children.every((child) => Object.values(child.diagnostics()).every(Boolean))).toBe(
      true,
    );
    expect(f.controller.preflightBlocked()).toBe(false);
  } finally {
    f.release();
    await stop?.catch(() => {});
    await f.close();
  }
}, 10000);

it('does not equate original Native exit with verified source, journal and configuration restoration', async () => {
  const f = await stopRestorationFixture();
  let stop: Promise<unknown> | undefined;
  try {
    f.startPoll();
    await vi.waitFor(() => expect(f.operations).toHaveLength(2));
    stop = f.stop();
    const refused = expect(stop).rejects.toThrow(/^LIVE_/);
    await vi.waitFor(() => expect(f.pollSettled).toBe(true));
    f.f.exit();
    f.release();
    await refused;
    expect(f.owners.current(f.run.liveId)?.state).toBe('recoveryRequired');
    expect(() => f.owners.checkOrdinary(f.run.relayId, [f.app])).toThrow();
    expect(readFileSync(join(f.app, 'index.html'), 'utf8')).toContain('live-injection');
    expect(existsSync(join(f.app, '.impeccable/live/inject-journal.json'))).toBe(true);
    expect(JSON.parse(readFileSync(f.configPath, 'utf8'))).not.toEqual(f.originalConfig);
  } finally {
    f.release();
    await stop?.catch(() => {});
    await f.close();
  }
});

it('refuses stale authority during raw admission settlement and never releases the newer recovery lock', async () => {
  const f = fixture(true, { lifetime: true });
  const owning = await f.runtime.start(session(), 'time');
  const a = retirementAuthority(owning);
  const releases: ((value: unknown) => void)[] = [];
  f.setMcp(() => new Promise((resolve) => releases.push(resolve)));
  const cancellation = new AbortController();
  const observation = f.runtime
    .inspectLiveAdmission(owning, cancellation.signal)
    .catch((error) => error);
  let settlement: Promise<void> | undefined;
  try {
    cancellation.abort(new Error('LIVE_GENERATION_STALE'));
    await observation;
    settlement = f.runtime.settleLiveAdmission(owning, a.authority);
    const refused = expect(settlement).rejects.toThrow('LIVE_GENERATION_STALE');
    const newer = a.authority.owners.mutate(a.authority.fence, {
      event: 'recover',
      code: 'LIVE_CLEANUP_REQUIRED',
    });
    for (const release of releases) release({ data: [], nextCursor: null });
    await refused;
    expect(a.authority.owners.current(newer.liveId)).toMatchObject({
      generation: newer.generation,
      state: 'recoveryRequired',
    });
    expect(() => a.authority.owners.checkOrdinary(owning.id, null)).toThrow();
    expect(f.process.close).not.toHaveBeenCalled();
  } finally {
    for (const release of releases) release({ data: [], nextCursor: null });
    await observation;
    await settlement?.catch(() => {});
    f.exit();
    f.runtime.stopAll();
    a.close();
  }
});

it('an already-cancelled observation dispatches no Native request and cannot poison its ordinary owner', async () => {
  const f = fixture(true, { lifetime: true });
  const owning = await f.runtime.start(session(), 'time');
  const cancellation = new AbortController();
  const reason = new Error('LIVE_GENERATION_STALE');
  cancellation.abort(reason);
  try {
    const before = f.calls.length;
    await expect(f.runtime.inspectLiveAdmission(owning, cancellation.signal)).rejects.toBe(reason);
    expect(f.calls).toHaveLength(before);
    await expect(f.runtime.inspectLiveAdmission(owning)).resolves.toHaveProperty('launch');
  } finally {
    f.exit();
    f.runtime.stopAll();
  }
});
