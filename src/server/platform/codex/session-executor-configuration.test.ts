/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it, vi } from 'vitest';
import { RelaySession } from '../../features/sessions/model/relay-session.js';
import { CodexSessionRuntime } from './session-runtime.js';

const catalog = {
  data: [{ id: 'gpt-6-luna', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }],
};
const binding = (sessionId: string) => ({
  sessionId,
  rootThreadId: `root-${sessionId}`,
  threadId: `child-${sessionId}`,
  taskPath: '/root/l1',
});
async function fixture() {
  let launches = 0;
  const notifications = new Map<string, (event: { method: string; params: unknown }) => void>();
  let onCatalog: (() => Promise<unknown>) | null = null;
  const calls: { root: string; method: string; params: unknown }[] = [];
  const runtime = new CodexSessionRuntime(() => {
    const sessionId = ['a', 'b'][launches++]!;
    const root = `root-${sessionId}`;
    return {
      rpc: {
        request: async (method, params) => {
          calls.push({ root, method, params });
          if (method === 'thread/start') return { thread: { id: root } };
          if (method === 'thread/read') {
            const childId = (params as { threadId: string }).threadId;
            const owner = childId.endsWith('b') ? 'b' : 'a';
            return {
              thread: {
                id: childId,
                parentThreadId: `root-${owner}`,
                source: { subAgent: { thread_spawn: { agent_path: '/root/l1' } } },
                status: { type: 'idle' },
                model: 'gpt-6-luna',
                reasoningEffort: null,
                agentRole: 'org-plan-executor',
              },
            };
          }
          if (method === 'model/list') return onCatalog ? onCatalog() : catalog;
          return {};
        },
        onNotification: (listener) => {
          notifications.set(sessionId, listener);
          return () => {};
        },
        onServerRequest: () => () => {},
      },
      close: () => {},
    };
  });
  for (const sessionId of ['a', 'b'])
    await runtime.start(
      RelaySession.create({
        id: sessionId,
        provider: 'codex',
        workspaceId: 'w',
        workspacePath: '/w',
        profile: 'default',
        model: 'gpt-6-astra',
        effectiveSkillSelection: { skills: [] },
        modelSettings: { reasoningEffort: 'high', executorReasoningEffort: 'medium' },
        now: '2026-10-21T15:00:00Z',
      }).snapshot,
      '2026-10-21T15:00:00Z',
    );
  calls.length = 0;
  return {
    runtime,
    calls,
    notifications,
    launches: () => launches,
    setCatalog: (fn: () => Promise<unknown>) => {
      onCatalog = fn;
    },
  };
}

describe('owned Codex child configuration port', () => {
  it('reads a prelaunch catalog from the owning root without reading/creating/resuming a child', async () => {
    const { runtime, calls, launches } = await fixture();
    try {
      expect(
        await runtime.readExecutorPolicyCatalog({ sessionId: 'a', rootThreadId: 'root-a' }),
      ).toMatchObject({
        kind: 'observed',
        source: 'runtime-model-list',
        catalog: {
          revision: expect.stringMatching(/^[a-f0-9]{64}$/),
          models: [{ id: 'gpt-6-luna', reasoningEfforts: ['medium'] }],
        },
      });
      expect(
        await runtime.readExecutorPolicyCatalog({ sessionId: 'a', rootThreadId: 'root-b' }),
      ).toEqual({ kind: 'unavailable', code: 'ROOT_BINDING_MISMATCH' });
      expect(calls.map((call) => [call.root, call.method])).toEqual([['root-a', 'model/list']]);
      expect(launches()).toBe(2);
    } finally {
      runtime.stopAll();
    }
  });

  it('discards a prelaunch catalog if the owning writer stops during model/list', async () => {
    const { runtime, setCatalog } = await fixture();
    const pending = Promise.withResolvers<unknown>();
    setCatalog(() => pending.promise);
    try {
      const reading = runtime.readExecutorPolicyCatalog({ sessionId: 'a', rootThreadId: 'root-a' });
      runtime.stop('a');
      pending.resolve(catalog);
      expect(await reading).toEqual({ kind: 'unavailable', code: 'CONTEXT_CHANGED' });
    } finally {
      pending.resolve(catalog);
      runtime.stopAll();
    }
  });

  it('bounds a stalled prelaunch catalog read without starting a turn', async () => {
    const { runtime, setCatalog, calls } = await fixture();
    const pending = Promise.withResolvers<unknown>();
    setCatalog(() => pending.promise);
    vi.useFakeTimers();
    try {
      const reading = runtime.readExecutorPolicyCatalog({ sessionId: 'a', rootThreadId: 'root-a' });
      await vi.advanceTimersByTimeAsync(5_001);
      expect(await reading).toEqual({ kind: 'unavailable', code: 'CATALOG_UNAVAILABLE' });
      expect(calls.map((call) => call.method)).toEqual(['model/list']);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      pending.resolve(catalog);
      runtime.stopAll();
      vi.useRealTimers();
    }
  });
  it('isolates sessions, never substitutes Astra root settings, and launches no reader process/turn', async () => {
    const { runtime, calls, launches } = await fixture();
    try {
      const [a, b] = await Promise.all([
        runtime.readExecutorConfiguration(binding('a')),
        runtime.readExecutorConfiguration(binding('b')),
      ]);
      for (const result of [a, b])
        expect(result).toMatchObject({
          kind: 'observed',
          configuration: { model: 'gpt-6-luna', reasoningEffort: null, settingsRevision: null },
        });
      expect(launches()).toBe(2);
      expect(calls.map((call) => [call.root, call.method])).toEqual([
        ['root-a', 'thread/read'],
        ['root-b', 'thread/read'],
        ['root-a', 'model/list'],
        ['root-b', 'model/list'],
      ]);
      expect(
        await runtime.readExecutorConfiguration({ ...binding('a'), threadId: 'child-b' }),
      ).toEqual({ kind: 'unavailable', code: 'CHILD_BINDING_MISMATCH' });
      expect(
        await runtime.readExecutorConfiguration({ ...binding('a'), rootThreadId: 'root-b' }),
      ).toEqual({ kind: 'unavailable', code: 'RUNTIME_UNAVAILABLE' });
    } finally {
      runtime.stopAll();
    }
  });

  it.each(['thread/settings/updated', 'turn/started'])(
    'invalidates an in-flight receipt on %s',
    async (method) => {
      const { runtime, notifications, setCatalog } = await fixture();
      const pending = Promise.withResolvers<unknown>();
      setCatalog(() => pending.promise);
      try {
        const reading = runtime.readExecutorConfiguration(binding('a'));
        await vi.waitFor(() => expect(notifications.has('a')).toBe(true));
        notifications.get('a')!({
          method,
          params: { threadId: 'child-a', threadSettings: { model: 'gpt-6-sol', effort: 'high' } },
        });
        pending.resolve(catalog);
        expect(await reading).toEqual({ kind: 'unavailable', code: 'OBSERVATION_CHANGED' });
      } finally {
        pending.resolve(catalog);
        runtime.stopAll();
      }
    },
  );

  it('invalidates reads when the owning runtime is stopped and never falls back to a detached reader', async () => {
    const { runtime, setCatalog, launches } = await fixture();
    const pending = Promise.withResolvers<unknown>();
    setCatalog(() => pending.promise);
    const reading = runtime.readExecutorConfiguration(binding('a'));
    await Promise.resolve();
    runtime.stop('a');
    pending.resolve(catalog);
    expect(await reading).toEqual({ kind: 'unavailable', code: 'OBSERVATION_CHANGED' });
    expect(await runtime.readExecutorConfiguration(binding('a'))).toEqual({
      kind: 'unavailable',
      code: 'RUNTIME_UNAVAILABLE',
    });
    expect(launches()).toBe(2);
    runtime.stopAll();
  });
});
