/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it, vi } from 'vitest';
import { CodexSessionRuntime } from './session-runtime.js';
import { RelaySession } from '../../features/sessions/model/relay-session.js';
import type { CodexRetrievalState } from '../retrieval/codex-xerj.js';

function fixture(topology: 'idle' | 'active-root' | 'active-child' | 'unknown' = 'idle') {
  let requested = false;
  const calls: { method: string; params: unknown }[] = [];
  const close = vi.fn(),
    release = vi.fn(),
    observe = vi.fn();
  let notify: ((notification: { method: string; params: unknown }) => void) | undefined;
  const launch = vi.fn(() => ({
    rpc: {
      request: async (method: string, params: unknown) => {
        calls.push({ method, params });
        if (method === 'thread/start') return { thread: { id: 'root' } };
        if (method === 'thread/read') {
          if (topology === 'unknown') throw new Error('unavailable');
          const id = (params as { threadId: string }).threadId;
          return {
            thread: {
              id,
              parentThreadId: id === 'root' ? null : 'root',
              status: {
                type:
                  topology === 'active-root' || (id !== 'root' && topology === 'active-child')
                    ? 'active'
                    : 'idle',
              },
            },
          };
        }
        if (method === 'thread/list')
          return {
            data:
              topology === 'active-child'
                ? [{ id: 'child', parentThreadId: 'root', status: { type: 'active' } }]
                : [],
          };
        if (method === 'turn/start') return { turn: { id: 'turn' } };
        return {};
      },
      onNotification: (listener: typeof notify) => {
        notify = listener;
        return () => {};
      },
      onServerRequest: () => () => {},
    },
    close,
  }));
  const runtime = new CodexSessionRuntime(
    launch,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      prepare: async (): Promise<CodexRetrievalState> => ({
        config: {},
        skillsConfig: [],
        ready: requested,
        deadline: Date.now() + 1000,
        capabilities: [
          { skillName: 'gestalt:playwright', serverName: 'gestalt-playwright', ready: requested },
        ],
        turnInstructions: requested ? 'verified-browser-guidance' : '',
        fallback() {},
      }),
      verify: async () => true,
      needsResume: () => requested,
      release,
      observe,
    },
  );
  const session = RelaySession.create({
    id: 's',
    workspaceId: 'w',
    workspacePath: '/workspace',
    profile: 'default',
    provider: 'codex',
    effectiveSkillSelection: {
      skills: [{ name: 'gestalt:playwright', path: '/skill', enabled: false }],
      capabilities: { playwright: { enabled: true } },
    },
    approvalPolicy: 'never',
    sandbox: 'workspace-write',
    now: '2026-10-28T00:00:00Z',
  }).snapshot;
  return {
    runtime,
    session,
    calls,
    launch,
    close,
    release,
    observe,
    notify: (notification: { method: string; params: unknown }) => notify?.(notification),
    request: () => {
      requested = true;
    },
  };
}

describe('Mobile browser owned-runtime resume boundary', () => {
  it('dispatches browser-off root turns without waiting for browser work', async () => {
    const f = fixture();
    const started = await f.runtime.start(f.session, '2026-10-28T00:00:00Z');
    const operation = f.runtime.startTurn(
      started,
      'ordinary chat',
      undefined,
      '2026-10-28T00:00:01Z',
    );
    expect(f.calls.at(-1)?.method).toBe('turn/start');
    await operation;
    expect(f.launch).toHaveBeenCalledTimes(1);
    f.runtime.stopAll();
  });
  it('retains root, approvals and verified skill snapshot at an idle next turn', async () => {
    const f = fixture();
    const started = await f.runtime.start(f.session, '2026-10-28T00:00:00Z');
    f.request();
    const result = await f.runtime.startTurn(started, 'next', undefined, '2026-10-28T00:00:01Z');
    expect(f.launch).toHaveBeenCalledTimes(2);
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(result.threadId).toBe('root');
    expect(result.effectiveSkillSelection?.skills[0]?.enabled).toBe(true);
    expect(f.calls.find((call) => call.method === 'thread/resume')?.params).toMatchObject({
      threadId: 'root',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
    });
    expect(f.calls.at(-1)?.params).toMatchObject({
      threadId: 'root',
      input: [{ text: 'verified-browser-guidance' }, { text: 'next' }],
    });
    f.runtime.stopAll();
    expect(f.release).toHaveBeenCalledWith('s');
  });
  it.each(['active-root', 'active-child', 'unknown'] as const)(
    'defers attachment during %s and keeps chat usable',
    async (topology) => {
      const f = fixture(topology);
      const started = await f.runtime.start(f.session, '2026-10-28T00:00:00Z');
      f.request();
      await f.runtime.startTurn(started, 'chat', undefined, '2026-10-28T00:00:01Z');
      expect(f.launch).toHaveBeenCalledTimes(1);
      expect(f.close).not.toHaveBeenCalled();
      expect(f.calls.at(-1)?.method).toBe('turn/start');
      expect(f.calls.at(-1)?.params).toMatchObject({ input: [{ text: 'chat' }] });
      f.runtime.stopAll();
    },
  );
  it('delivers status observations and releases only the session-owned capability', async () => {
    const f = fixture();
    const started = await f.runtime.start(f.session, '2026-10-28T00:00:00Z');
    const notification = {
      method: 'mcpServer/statusUpdated',
      params: { name: 'gestalt-playwright', status: 'failed' },
    };
    f.notify(notification);
    expect(f.observe).toHaveBeenCalledWith('s', notification);
    await f.runtime.release(started.id);
    expect(f.release).toHaveBeenCalledWith('s');
  });
});
