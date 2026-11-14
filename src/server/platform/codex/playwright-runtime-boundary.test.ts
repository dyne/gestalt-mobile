/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexSessionRuntime } from './session-runtime.js';
import { RelaySession } from '../../features/sessions/model/relay-session.js';
import { CodexPlaywright, type PlaywrightAuthority } from './codex-playwright.js';
import { playwrightServerName, playwrightTools } from './managed-playwright.js';
import type { CodexCapabilityState } from './capability-contracts.js';

function fixture(
  topology: 'idle' | 'active-root' | 'active-child' | 'unknown' = 'idle',
  retrieval?: ConstructorParameters<typeof CodexSessionRuntime>[13],
) {
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
        if (method === 'config/read') return { config: {} };
        if (method === 'mcpServerStatus/list')
          return {
            data: [
              {
                name: playwrightServerName,
                runtimeStatus: 'connected',
                tools: Object.fromEntries(playwrightTools.map((tool) => [tool, {}])),
              },
            ],
          };
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
    retrieval ?? {
      prepare: async (): Promise<CodexCapabilityState> => ({
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
  it('explains pending activation and connects the retained request on the next root turn', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'browser-next-turn-'));
    const skillPath = join(workspace, 'SKILL.md');
    await writeFile(skillPath, '# Browser\nUse verified browser tools.');
    const installation = {
      check: vi.fn(async () => ({
        status: 'installed' as const,
        manager: '/operator/gestalt',
        version: '0.0.83',
      })),
      ready: vi.fn(async () => ({
        ready: true,
        package: 'ready' as const,
        chrome: 'ready' as const,
        node: 'ready' as const,
        chromeVersion: '151.0.7872.0',
      })),
    };
    const browser = new CodexPlaywright(installation);
    const authority = (session: PlaywrightAuthority['session']): PlaywrightAuthority => ({
      session,
      planIdentity: null,
      activePlanId: null,
      declared: false,
      fenced: false,
    });
    const f = fixture('idle', {
      prepare: (session, rpc, config, deadline) =>
        browser.prepare(
          { config, deadline, ready: false, skillsConfig: [], fallback() {} },
          authority(session),
          {
            rpc,
            skills: [{ name: 'gestalt:playwright', path: skillPath, enabled: false }],
            deadline,
          },
        ),
      verify: (rpc, threadId, state) => browser.verify(rpc, threadId, state),
      needsResume: (session) => browser.needsResume(authority(session)),
      bound: (state, threadId) => browser.bound(state, threadId),
      release: (id) => browser.release(id),
    });
    try {
      const started = await f.runtime.start(
        { ...f.session, workspacePath: workspace },
        '2026-10-28T00:00:00Z',
      );
      const first = await f.runtime.startTurn(
        started,
        'browser work',
        undefined,
        '2026-10-28T00:00:01Z',
      );
      const control = (action: 'start' | 'status') =>
        browser.control(authority(first), { capability: 'playwright', action }, true);
      expect(await control('start')).toMatchObject({
        status: 'pending',
        nextAction: 'next-root-turn',
        message: expect.stringContaining('Activation cannot complete during this turn'),
        chrome: { status: 'unknown' },
      });
      expect(await control('status')).toMatchObject({ status: 'pending' });
      expect(installation.ready).not.toHaveBeenCalled();
      expect(f.launch).toHaveBeenCalledTimes(1);
      const idle = RelaySession.rehydrate(first).completeTurn(
        first.activeTurnId!,
        '2026-10-28T00:00:02Z',
      ).snapshot;
      const next = await f.runtime.startTurn(
        idle,
        'continue browser work',
        undefined,
        '2026-10-28T00:00:03Z',
      );
      expect(next.threadId).toBe(first.threadId);
      expect(f.launch).toHaveBeenCalledTimes(2);
      expect(installation.ready).toHaveBeenCalledTimes(1);
      expect(await control('status')).toMatchObject({
        status: 'connected',
        chrome: { status: 'ready' },
      });
      expect(await control('status')).not.toHaveProperty('nextAction');
      expect(f.calls.at(-1)?.params).toMatchObject({
        input: [
          { text: expect.stringContaining('Verified managed browser tools are connected') },
          { text: 'continue browser work' },
        ],
      });
    } finally {
      f.runtime.stopAll();
      await rm(workspace, { recursive: true, force: true });
    }
  });
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
