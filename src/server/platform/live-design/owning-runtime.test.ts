/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it, vi } from 'vitest';
import { RelaySession } from '../../features/sessions/model/relay-session.js';
import {
  CodexSessionRuntime,
  type AppServer,
  type AppServerLaunchInput,
} from '../codex/session-runtime.js';
import { observeLiveProcess } from './process-identity.js';

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
  } = {},
) {
  const calls: { method: string; params: unknown }[] = [];
  let configuration: () => Promise<unknown> = async () => ({ config: {}, layers: [] });
  let children: () => Promise<unknown> = async () => ({ data: [], nextCursor: null });
  let notify: Parameters<AppServer['rpc']['onNotification']>[0] = () => {};
  const process: AppServer = {
    rpc: {
      request: async (method, params) => {
        calls.push({ method, params });
        if (method === 'thread/start')
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
        if (method === 'thread/list') return children();
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
                  }
                : ((await children()) as { data: { id: string }[] }).data.find(
                    (thread) => thread.id === id,
                  ),
          };
        }
        if (method === 'mcpServerStatus/list') return { data: [], nextCursor: null };
        return {};
      },
      onNotification: (listener) => {
        notify = listener;
        return () => {};
      },
      onServerRequest: () => () => {},
    },
    close: vi.fn(),
    ...(observe ? { observeLiveLaunch: () => observeLiveProcess(globalThis.process.pid) } : {}),
  };
  const launch = vi.fn<(input: AppServerLaunchInput) => AppServer>(() => process);
  const arguments_: ConstructorParameters<typeof CodexSessionRuntime> = [launch];
  arguments_[16] = hooks.beforeLaunch;
  arguments_[17] = hooks.beforeThread;
  const runtime = new CodexSessionRuntime(...arguments_);
  return {
    runtime,
    launch,
    calls,
    notify: (notification: Parameters<typeof notify>[0]) => notify(notification),
    setConfiguration: (read: typeof configuration) => {
      configuration = read;
    },
    setChildren: (read: typeof children) => {
      children = read;
    },
  };
}
describe('owning runtime admission observations', () => {
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
    setChildren(async () => ({
      data: [
        {
          id: 'actual-child',
          parentThreadId: owning.threadId,
          sessionId: 'native-session',
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
            sourceKinds: [
              'subAgent',
              'subAgentReview',
              'subAgentCompact',
              'subAgentThreadSpawn',
              'subAgentOther',
            ],
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
        { method: 'config/read', params: { cwd: owning.workspacePath, includeLayers: true } },
        { method: 'thread/read', params: { threadId: 'same-thread', includeTurns: false } },
        { method: 'mcpServerStatus/list', params: { threadId: 'same-thread', detail: 'full' } },
      ]);
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
    setConfiguration(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = runtime.inspectLiveAdmission(owning);
    runtime.stopAll();
    release({ config: {}, layers: [] });
    await expect(pending).rejects.toThrow('LIVE_RUNTIME_IDENTITY_CHANGED');
  });
});
