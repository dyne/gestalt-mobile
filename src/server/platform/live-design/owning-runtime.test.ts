/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it, vi } from 'vitest';
import { RelaySession } from '../../features/sessions/model/relay-session.js';
import { CodexSessionRuntime, type AppServer } from '../codex/session-runtime.js';
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
function fixture(observe = true) {
  const calls: { method: string; params: unknown }[] = [];
  let configuration: () => Promise<unknown> = async () => ({ config: {}, layers: [] });
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
          };
        if (method === 'config/read') return configuration();
        if (method === 'thread/read') return { thread: { id: 'same-thread' } };
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
  const launch = vi.fn(() => process);
  const runtime = new CodexSessionRuntime(launch);
  return {
    runtime,
    launch,
    calls,
    notify: (notification: Parameters<typeof notify>[0]) => notify(notification),
    setConfiguration: (read: typeof configuration) => {
      configuration = read;
    },
  };
}
describe('owning runtime admission observations', () => {
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
      expect(result.thread).toEqual({ thread: { id: owning.threadId } });
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
