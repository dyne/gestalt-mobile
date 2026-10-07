/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it, vi } from 'vitest';
import { CodexSessionRuntime } from '../codex/session-runtime.js';
import { RelaySession } from '../../features/sessions/model/relay-session.js';
import type { CodexRetrievalState } from './codex-xerj.js';
import { CodexJsonRpcError } from '../codex/json-rpc-client.js';

function setup(connected = true, missingRollout = false) {
  const requests: Array<{ method: string; params: unknown }> = [];
  const closed = vi.fn();
  let started = 0;
  const prepare = vi.fn(async (): Promise<CodexRetrievalState> => {
    const state: CodexRetrievalState = {
      config: { mcp_servers: { 'gestalt-xerj': { enabled: true } } },
      skillsConfig: [
        { path: '/xerj/SKILL.md', enabled: true },
        { path: '/org/SKILL.md', enabled: true },
      ],
      ready: true,
      deadline: Date.now() + 1000,
      fallback: () => {
        state.ready = false;
        state.config = { mcp_servers: { 'gestalt-xerj': { enabled: false } } };
        state.skillsConfig = [
          { path: '/xerj/SKILL.md', enabled: false },
          { path: '/org/SKILL.md', enabled: true },
        ];
      },
    };
    return state;
  });
  const runtime = new CodexSessionRuntime(
    () => ({
      rpc: {
        request: async (method, params) => {
          requests.push({ method, params });
          if (method === 'thread/resume' && missingRollout)
            throw new CodexJsonRpcError(-32600, 'no rollout found for thread id missing');
          return method === 'thread/start'
            ? { thread: { id: missingRollout ? `replacement-${++started}` : 'root-thread' } }
            : {};
        },
        onNotification: () => () => {},
        onServerRequest: () => () => {},
      },
      close: closed,
    }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    64,
    undefined,
    undefined,
    { prepare, verify: async () => connected },
  );
  const session = RelaySession.create({
    id: 'fixture',
    provider: 'codex',
    workspaceId: 'w',
    workspacePath: '/workspace',
    profile: 'default',
    now: 't',
    effectiveSkillSelection: {
      skills: [
        { name: 'gestalt:xerj', path: '/xerj/SKILL.md', enabled: false },
        { name: 'gestalt:org-plan', path: '/org/SKILL.md', enabled: true },
      ],
    },
  }).snapshot;
  return { runtime, session, requests, prepare, closed };
}

describe('runtime capability boundaries', () => {
  it('recovers a missing rollout with failed proxy before publishing the replacement identity', async () => {
    const f = setup(false, true);
    const stopped = RelaySession.rehydrate(f.session).bindThread('missing', 't').stop('u').snapshot;
    const recovered = await f.runtime.restoreWithOutcome(stopped, 'v');
    expect(recovered).toMatchObject({
      replacementCreated: true,
      historyUnavailable: true,
      session: { threadId: 'replacement-2' },
    });
    expect(f.requests.filter((request) => request.method === 'thread/resume')).toHaveLength(1);
    expect(f.requests).toContainEqual({
      method: 'thread/unsubscribe',
      params: { threadId: 'replacement-1' },
    });
    expect(f.requests.at(-1)).toMatchObject({
      method: 'thread/start',
      params: { config: { mcp_servers: { 'gestalt-xerj': { enabled: false } } } },
    });
    f.runtime.stopAll();
  });
  it('prepares one native configuration before fresh root and inherited child turns', async () => {
    const f = setup();
    const session = await f.runtime.start(f.session, 't');
    expect(session.effectiveSkillSelection?.skills).toEqual(
      expect.arrayContaining([
        { name: 'gestalt:xerj', path: '/xerj/SKILL.md', enabled: true },
        { name: 'gestalt:org-plan', path: '/org/SKILL.md', enabled: true },
      ]),
    );
    const started = f.requests.find((request) => request.method === 'thread/start')!.params;
    expect(started).toMatchObject({
      config: {
        mcp_servers: { 'gestalt-xerj': { enabled: true } },
        skills: {
          config: [
            { path: '/xerj/SKILL.md', enabled: true },
            { path: '/org/SKILL.md', enabled: true },
          ],
        },
      },
    });
    expect(f.requests.some((request) => request.method === 'turn/start')).toBe(false);
    expect(f.prepare).toHaveBeenCalledTimes(1);
    f.runtime.stopAll();
    expect(f.closed).toHaveBeenCalledOnce();
  });
  it('releases an unpublished failed native connection before creating the fallback root', async () => {
    const f = setup(false);
    const result = await f.runtime.start(f.session, 't');
    expect(result.threadId).toBe('root-thread');
    expect(
      result.effectiveSkillSelection?.skills.find((skill) => skill.name === 'gestalt:xerj')
        ?.enabled,
    ).toBe(false);
    expect(f.requests.at(-1)).toMatchObject({
      method: 'thread/start',
      params: {
        config: {
          mcp_servers: { 'gestalt-xerj': { enabled: false } },
          skills: {
            config: [
              { path: '/xerj/SKILL.md', enabled: false },
              { path: '/org/SKILL.md', enabled: true },
            ],
          },
        },
      },
    });
    f.runtime.stopAll();
  });
  it('rechecks fresh availability on restore and process recovery without changing durable thread', async () => {
    const f = setup();
    const started = await f.runtime.start(f.session, 't');
    await f.runtime.release(started.id);
    const restored = await f.runtime.restore(started, 'u');
    expect(restored.threadId).toBe(started.threadId);
    expect(
      restored.effectiveSkillSelection?.skills.find((skill) => skill.name === 'gestalt:xerj')
        ?.enabled,
    ).toBe(true);
    const recovered = await f.runtime.recycle(restored, 'v');
    expect(recovered.threadId).toBe(started.threadId);
    expect(f.prepare).toHaveBeenCalledTimes(3);
    f.runtime.stopAll();
  });
});
