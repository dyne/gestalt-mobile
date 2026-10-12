/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { RelaySession } from '../../features/sessions/model/relay-session.js';
import { CodexSessionRuntime, type AppServer } from '../codex/session-runtime.js';
import { SqliteLiveOwnership, liveAppIdentity } from './sqlite-live-ownership.js';
import { LiveDispatchGuard } from './live-dispatch.js';
import { RelayLiveEventTurns } from './relay-event-turns.js';
import { stopLive } from '../../features/live-design/stop/use-case.js';
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'live-relay-turn-'));
  const app = join(root, 'app');
  mkdirSync(app);
  const owners = new SqliteLiveOwnership(join(root, 'private', 'owners.sqlite'), 'controller', {
    initialize: true,
  });
  const guard = new LiveDispatchGuard({
    owners,
    scopes: () => [app],
    verifyLiveRuntime: async () => {},
  });
  const requests: { method: string; params: unknown }[] = [];
  let complete = false;
  let final = '{"status":"done","file":"index.html"}';
  const server: AppServer = {
    rpc: {
      async request(method, params) {
        requests.push({ method, params });
        if (method === 'thread/start') return { thread: { id: 'root' } };
        if (method === 'turn/start') {
          complete = false;
          return { turn: { id: 'live-turn' } };
        }
        if (method === 'turn/interrupt') {
          complete = true;
          return {};
        }
        if (method === 'thread/list' || method === 'thread/backgroundTerminals/list')
          return { data: [] };
        if (method === 'thread/read')
          return {
            thread: {
              id: 'root',
              status: { type: complete ? 'idle' : 'active' },
              turns: [
                {
                  id: 'live-turn',
                  status: complete ? 'completed' : 'inProgress',
                  startedAt: 1,
                  completedAt: complete ? 2 : null,
                  items: complete
                    ? [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', text: final }]
                    : [],
                },
              ],
            },
          };
        return {};
      },
      onNotification: () => () => {},
      onServerRequest: () => () => {},
    },
    close: vi.fn(),
  };
  const launch = vi.fn(() => server);
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
    64,
    undefined,
    undefined,
    undefined,
    guard,
  );
  let session = RelaySession.create({
    id: 'relay',
    provider: 'codex',
    workspaceId: 'workspace',
    workspacePath: app,
    profile: 'default',
    model: 'own-model',
    modelSettings: { reasoningEffort: 'high' },
    sandbox: 'workspace-git',
    approvalPolicy: 'never',
    effectiveSkillSelection: { skills: [] },
    now: '2026-10-11T00:00:00Z',
  }).snapshot;
  session = await runtime.start(session, '2026-10-11T00:00:00Z');
  guard.settle('relay', { roots: 0, descendants: 0, commands: 0, approvals: 0, unknown: false });
  let run = owners.claim({
    relayId: 'relay',
    appId: 'app',
    rootThreadId: 'root',
    provider: 'codex',
    app: liveAppIdentity(app),
    targetId: 'target',
    targetIdentity: 'socket',
    operationId: 'start',
    previewOrigin: 'https://preview.test:9443',
    authSessionHash: 'hash',
    deviceId: 'device',
  }).run;
  run = owners.mutate(run, { event: 'phase', phase: 'route:ack' });
  run = owners.mutate(run, { event: 'ready' });
  let now = 1000;
  const sessions = {
    find: () => session,
    save: (value: typeof session) => {
      session = value;
    },
    list: () => [session],
  };
  const wait = vi.fn(async () => {
    complete = true;
  });
  const turns = new RelayLiveEventTurns({ owners, sessions, runtime, now: () => now, wait });
  cleanups.push(() => {
    runtime.stopAll();
    owners.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    owners,
    server,
    run,
    guard,
    runtime,
    turns,
    requests,
    launch,
    wait,
    session: () => session,
    final: (value: string) => {
      final = value;
    },
    time: (value: number) => {
      now = value;
    },
    sessions,
  };
}
it('uses the existing Codex relay/model/effort/policy and waits for completion while ordinary turns remain blocked', async () => {
  const f = await fixture();
  const before = f.session();
  let release!: () => void;
  f.wait.mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        release = done;
      }),
  );
  const work = f.guard.liveEvent(f.run, '1234abcd', () =>
    f.turns.apply(
      f.run,
      { type: 'generate', id: '1234abcd', count: 1 },
      595000,
      'operation-digest',
    ),
  );
  await vi.waitFor(() => expect(f.wait).toHaveBeenCalled());
  // Independent request context must not inherit the controller's Live authority.
  await expect(f.runtime.startTurn(f.session(), 'ordinary', 'ordinary', 'now')).rejects.toThrow(
    'LIVE_MODE_ACTIVE',
  );
  release();
  const reply = await work;
  expect(reply).toEqual({ status: 'done', file: 'index.html' });
  expect(f.launch).toHaveBeenCalledOnce();
  const starts = f.requests.filter((r) => r.method === 'turn/start');
  expect(starts).toHaveLength(1);
  expect(starts[0].params).toMatchObject({
    threadId: 'root',
    model: 'own-model',
    effort: 'high',
    clientUserMessageId: `live-${f.run.generation}-operation-digest`,
  });
  expect(f.session().executionPolicy).toEqual(before.executionPolicy);
  expect(f.session().effectiveSkillSelection).toEqual(before.effectiveSkillSelection);
  expect(f.wait).toHaveBeenCalledTimes(2);
});
it.each(['not json', '{"status":"steer_done"}', '{"status":"done","unexpected":true}'])(
  'invalid final output enters recovery contract: %s',
  async (final) => {
    const f = await fixture();
    f.final(final);
    await expect(
      f.guard.liveEvent(f.run, '1234abcd', () =>
        f.turns.apply(f.run, { type: 'generate', id: '1234abcd' }, 595000, 'operation-digest'),
      ),
    ).rejects.toThrow('LIVE_RELAY_RESULT_INVALID');
  },
);
it('manual apply requires pinned structured entry outcomes', async () => {
  const f = await fixture();
  await expect(
    f.guard.liveEvent(f.run, '1234abcd', () =>
      f.turns.apply(
        f.run,
        { type: 'manual_edit_apply', id: '1234abcd' },
        595000,
        'operation-digest',
      ),
    ),
  ).rejects.toThrow('LIVE_RELAY_RESULT_INVALID');
});
it('lease expiration during an active model turn never starts another turn', async () => {
  const f = await fixture();
  f.wait.mockImplementationOnce(async () => {
    f.time(600000);
  });
  await expect(
    f.guard.liveEvent(f.run, '1234abcd', () =>
      f.turns.apply(f.run, { type: 'generate', id: '1234abcd' }, 595000, 'operation-digest'),
    ),
  ).rejects.toThrow('LIVE_POLL_LEASE_EXPIRED');
  expect(f.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);
});
it('rejects a provider/thread identity change before dispatch', async () => {
  const f = await fixture();
  f.sessions.save({ ...f.session(), provider: 'kimi' });
  await expect(
    f.guard.liveEvent(f.run, '1234abcd', () =>
      f.turns.apply(f.run, { type: 'generate', id: '1234abcd' }, 595000, 'operation-digest'),
    ),
  ).rejects.toThrow('LIVE_RELAY_OWNER_INVALID');
  expect(f.requests.filter((r) => r.method === 'turn/start')).toHaveLength(0);
});

it('Stop interrupts the actual owned turn and proves settlement without launching a replacement', async () => {
  const f = await fixture();
  let release!: () => void;
  f.wait.mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        release = done;
      }),
  );
  const work = f.guard.liveEvent(f.run, '1234abcd', () =>
    f.turns.apply(f.run, { type: 'generate', id: '1234abcd' }, 595000, 'stop-operation'),
  );
  const rejected = expect(work).rejects.toThrow();
  await vi.waitFor(() => expect(f.wait).toHaveBeenCalled());
  const stopped = f.owners.mutate(f.run, { event: 'stop' });
  await f.turns.settle(stopped);
  expect(f.session().state).toBe('ready');
  expect(f.session().activeTurnId).toBeNull();
  release();
  await rejected;
  expect(f.requests).toContainEqual({
    method: 'turn/interrupt',
    params: { threadId: 'root', turnId: 'live-turn' },
  });
  expect(f.launch).toHaveBeenCalledTimes(1);
});
it('missing owning runtime after restart cannot substitute a new history reader for settlement', async () => {
  const f = await fixture();
  const stopped = f.owners.mutate(f.run, { event: 'stop' });
  f.runtime.stopAll();
  await expect(f.turns.settle(stopped)).rejects.toThrow('LIVE_NATIVE_SETTLEMENT_UNAVAILABLE');
  expect(f.launch).toHaveBeenCalledTimes(1);
});

it('unsupported native tree observation still interrupts known root work and retains the recovery lock', async () => {
  const f = await fixture();
  const realRequest = f.server.rpc.request.bind(f.server.rpc);
  f.server.rpc.request = async (method, params) =>
    method === 'thread/list' ? {} : realRequest(method, params);
  const stopped = f.owners.mutate(f.run, { event: 'stop' });
  await expect(f.turns.settle(stopped)).rejects.toThrow('LIVE_NATIVE_TREE_UNKNOWN');
  expect(f.requests.some((request) => request.method === 'turn/interrupt')).toBe(true);
  expect(f.owners.current(f.run.liveId)?.state).toBe('stopping');
  expect(f.launch).toHaveBeenCalledTimes(1);
});

it('a late native Stop observation cannot continue cancelling after its ownership fence changes', async () => {
  const f = await fixture();
  const realRequest = f.server.rpc.request.bind(f.server.rpc);
  let release!: () => void;
  f.server.rpc.request = async (method, params) => {
    if (method === 'thread/list')
      return new Promise((done) => {
        release = () => done({ data: [] });
      });
    return realRequest(method, params);
  };
  const stopping = f.owners.mutate(f.run, { event: 'stop' });
  const work = f.turns.settle(stopping);
  const rejected = expect(work).rejects.toThrow('LIVE_GENERATION_STALE');
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  const newer = f.owners.mutate(stopping, { event: 'phase', phase: 'stop:remove:intent' });
  const before = f.requests.length;
  release();
  await rejected;
  expect(f.requests).toHaveLength(before);
  expect(f.owners.current(f.run.liveId)).toEqual(newer);
});

it('unresponsive native settlement returns a bounded recovery error and never restores controls', async () => {
  const f = await fixture();
  const realRequest = f.server.rpc.request.bind(f.server.rpc);
  f.server.rpc.request = async (method, params) =>
    method === 'thread/list' ? new Promise(() => {}) : realRequest(method, params);
  const restore = vi.fn();
  vi.useFakeTimers();
  try {
    const work = stopLive(
      {
        owners: f.owners,
        controls: {
          read: () => ({ version: 1, enabled: false, planIdentity: null }),
          hold: vi.fn(),
          restore,
        },
        resources: {
          revoke: async () => {},
          settle: (run) => f.turns.settle(run),
          remove: async () => {},
          cleanup: async () => {},
          verifyClean: async () => {},
        },
      },
      f.run,
    );
    const rejected = expect(work).rejects.toThrow('LIVE_NATIVE_SETTLEMENT_TIMEOUT');
    await vi.advanceTimersByTimeAsync(5100);
    await rejected;
    expect(f.owners.current(f.run.liveId)?.state).toBe('recoveryRequired');
    expect(restore).not.toHaveBeenCalled();
    expect(f.launch).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it('actual completed history reconciles a lost notification before the next serialized Live steering turn', async () => {
  const f = await fixture();
  const before = f.session();
  await f.guard.liveEvent(f.run, 'generate-operation', () =>
    f.turns.apply(f.run, { type: 'generate', id: '1234abcd' }, 595000, 'generate-operation'),
  );
  expect(f.session().state).toBe('ready');
  expect(f.session().activeTurnId).toBeNull();
  f.final('{"status":"steer_done"}');
  await f.guard.liveEvent(f.run, 'steer-operation', () =>
    f.turns.apply(
      f.run,
      { type: 'steer', id: '1234abcd', message: 'More space' },
      595000,
      'steer-operation',
    ),
  );
  expect(f.requests.filter((request) => request.method === 'turn/start')).toHaveLength(2);
  expect(f.session().model).toBe(before.model);
  expect(f.session().executionPolicy).toEqual(before.executionPolicy);
  expect(f.session().activeTurnId).toBeNull();
  expect(f.launch).toHaveBeenCalledTimes(1);
});
