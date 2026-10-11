/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RelaySession } from '../../features/sessions/model/relay-session.js';
import { CodexSessionRuntime, type AppServer } from '../codex/session-runtime.js';
import { registerLiveDispatchBoundary } from '../../features/live-design/dispatch/register-boundary.js';
import { registerStartTurn } from '../../features/sessions/start-turn/endpoint.js';
import { registerSelectModel } from '../../features/sessions/select-model/endpoint.js';
import { registerProblemHandler } from '../http/problem-handler.js';
import { KimiSessionRuntime } from '../kimi/kimi-session-runtime.js';
import type { KimiWebServerManager } from '../kimi/kimi-web-server-manager.js';
import { LiveDispatchGuard } from './live-dispatch.js';
import { liveAppIdentity, SqliteLiveOwnership } from './sqlite-live-ownership.js';

const quiet = { roots: 0, descendants: 0, commands: 0, approvals: 0, unknown: false };
const fixtures: Array<{ root: string; store: SqliteLiveOwnership; runtime: CodexSessionRuntime }> =
  [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'live-dispatch-'));
  const app = join(root, 'app');
  mkdirSync(app);
  const store = new SqliteLiveOwnership(join(root, 'private', 'live.sqlite'), 'controller', {
    initialize: true,
  });
  const guard = new LiveDispatchGuard({
    owners: store,
    scopes: (session) => [session.workspacePath],
    verifyLiveRuntime: async () => {},
  });
  const calls: Array<{ method: string; params: unknown }> = [];
  const launch = vi.fn();
  let incoming:
    ((request: { id: number; method: string; params: unknown }) => Promise<unknown>) | undefined;
  let delayTurn: Promise<unknown> | undefined;
  const server: AppServer = {
    rpc: {
      async request(method, params) {
        calls.push({ method, params });
        if (method === 'thread/start') return { thread: { id: 'root' } };
        if (method === 'turn/start') return delayTurn ?? { turn: { id: 'turn' } };
        if (method === 'thread/list')
          return {
            data: [
              {
                id: 'child',
                source: { subAgent: { thread_spawn: { parent_thread_id: 'root' } } },
                status: { type: 'idle' },
              },
            ],
          };
        if (method === 'thread/read')
          return { thread: { id: 'root', status: { type: 'idle' }, turns: [] } };
        return {};
      },
      onNotification: () => () => {},
      onServerRequest(listener) {
        incoming = listener;
        return () => {};
      },
    },
    close: vi.fn(),
  };
  launch.mockReturnValue(server);
  const runtime = new CodexSessionRuntime(
    launch,
    undefined,
    undefined,
    () => true,
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
  const session = RelaySession.create({
    id: 'relay',
    provider: 'codex',
    workspaceId: 'workspace',
    workspacePath: app,
    profile: 'default',
    model: 'provider-model',
    sandbox: 'workspace-git',
    approvalPolicy: 'on-request',
    modelSettings: { reasoningEffort: 'high' },
    effectiveSkillSelection: { skills: [] },
    now: '2026-10-10T00:00:00.000Z',
  }).snapshot;
  fixtures.push({ root, store, runtime });
  const claim = () =>
    store.claim({
      relayId: session.id,
      rootThreadId: 'root',
      provider: 'codex',
      appId: 'app',
      app: liveAppIdentity(app),
      targetId: 'target',
      targetIdentity: 'listener',
      operationId: 'start',
      previewOrigin: 'https://preview.example.test:9443',
      authSessionHash: 'hash',
      deviceId: 'device',
    }).run;
  const active = () => {
    let run = claim();
    run = store.mutate(run, { event: 'phase', phase: 'route:ack' });
    return store.mutate(run, { event: 'ready' });
  };
  return {
    root,
    app,
    store,
    guard,
    runtime,
    session,
    calls,
    launch,
    server,
    claim,
    active,
    incoming: () => incoming!,
    delayTurn: (promise: Promise<unknown>) => {
      delayTurn = promise;
    },
  };
}
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.runtime.stopAll();
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

describe('actual Codex outbound Live dispatch boundary', () => {
  it('Start first prevents process creation, thread resume, fallback and model turns', async () => {
    const f = fixture();
    f.claim();
    await expect(f.runtime.start(f.session, 'now')).rejects.toThrow('LIVE_MODE_ACTIVE');
    await expect(
      f.runtime.restoreWithOutcome({ ...f.session, threadId: 'root' }, 'now'),
    ).rejects.toThrow('LIVE_MODE_ACTIVE');
    await expect(f.runtime.startTurn(f.session, 'ordinary', 'message', 'now')).rejects.toThrow(
      'LIVE_MODE_ACTIVE',
    );
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
  });
  it('writer creation reserves before its first await and a racing Start returns busy', async () => {
    const f = fixture();
    const operation = f.runtime.start(f.session, 'now');
    expect(() => f.claim()).toThrow('LIVE_SESSION_BUSY');
    const session = await operation;
    await f.runtime.startExecutorTurn(session, 'child', 'follow up', 'id');
    expect(() => f.guard.settle('relay', { ...quiet, descendants: 1 })).toThrow(
      'LIVE_SESSION_BUSY',
    );
    expect(() => f.claim()).toThrow('LIVE_SESSION_BUSY');
    // Explicit reconciliation is necessary; root turn completion and runtime Stop do not release.
    f.runtime.stopAll();
    expect(() => f.claim()).toThrow('LIVE_SESSION_BUSY');
    f.guard.settle('relay', quiet);
    expect(f.claim().state).toBe('starting');
    expect(() => f.guard.settle('relay', quiet)).toThrow('LIVE_GENERATION_STALE');
  });
  it.each(['startTurn', 'executor', 'queue', 'ensure', 'restore', 'recycle'])(
    'blocks %s against an attached ordinary resource after takeover',
    async (operation) => {
      const f = fixture();
      const session = await f.runtime.start(f.session, 'now');
      f.guard.settle('relay', quiet);
      f.active();
      f.calls.length = 0;
      f.launch.mockClear();
      const work =
        operation === 'startTurn'
          ? f.runtime.startTurn(session, 'ordinary', 'id', 'now')
          : operation === 'executor'
            ? f.runtime.startExecutorTurn(session, 'child', 'follow up', 'id')
            : operation === 'queue'
              ? f.runtime.queueTurnInput(session, 'turn', 'ordinary')
              : operation === 'ensure'
                ? f.runtime.ensureWriter(session, 'now')
                : operation === 'restore'
                  ? f.runtime.restoreWithOutcome(session, 'now')
                  : f.runtime.recycle(session, 'now');
      await expect(work).rejects.toThrow('LIVE_MODE_ACTIVE');
      expect(f.calls).toEqual([]);
      expect(f.launch).not.toHaveBeenCalled();
      expect(f.runtime.ownsWriter('relay')).toBe(true);
    },
  );
  it('permits only fenced Live root turns without replacing provider/model/effort', async () => {
    const f = fixture();
    const session = await f.runtime.start(f.session, 'now');
    f.guard.settle('relay', quiet);
    const run = f.active();
    f.calls.length = 0;
    await f.guard.liveEvent(run, 'event-1', () =>
      f.runtime.startTurn(session, 'Live event', 'event-1', 'now'),
    );
    expect(f.calls).toEqual([
      {
        method: 'turn/start',
        params: {
          threadId: 'root',
          input: [{ type: 'text', text: 'Live event', text_elements: [] }],
          clientUserMessageId: 'event-1',
          model: 'provider-model',
          effort: 'high',
        },
      },
    ]);
    await expect(
      f.guard.liveEvent(run, 'event-2', () =>
        f.runtime.startExecutorTurn(session, 'child', 'spawn', 'id'),
      ),
    ).rejects.toThrow('LIVE_MODE_ACTIVE');
    await expect(
      f.guard.liveEvent(run, 'event-3', () => f.runtime.restore(session, 'now')),
    ).rejects.toThrow('LIVE_MODE_ACTIVE');
    expect(f.calls).toHaveLength(1);
  });
  it('refuses Live event readiness when native collaboration/external-writer confinement has no proof', async () => {
    const f = fixture();
    const run = f.active();
    const unproved = new LiveDispatchGuard({ owners: f.store, scopes: () => [f.app] });
    const effect = vi.fn(async () => {});
    await expect(unproved.liveEvent(run, 'event', effect)).rejects.toThrow(
      'LIVE_RUNTIME_UNISOLATED',
    );
    expect(effect).not.toHaveBeenCalled();
  });
  it('revokes event authority for detached asynchronous callbacks after the event finishes', async () => {
    const f = fixture();
    const session = await f.runtime.start(f.session, 'now');
    f.guard.settle('relay', quiet);
    const run = f.active();
    let wake!: () => void;
    const gate = new Promise<void>((resolve) => {
      wake = resolve;
    });
    let delayed!: Promise<unknown>;
    await f.guard.liveEvent(run, 'event', async () => {
      delayed = gate.then(() => f.runtime.startTurn(session, 'late', 'event', 'now'));
    });
    f.calls.length = 0;
    wake();
    await expect(delayed).rejects.toThrow('LIVE_GENERATION_STALE');
    expect(f.calls).toEqual([]);
  });
  it('allows only exact read-only health observations without granting control-tool authority', async () => {
    const f = fixture();
    await f.runtime.start(f.session, 'now');
    f.guard.settle('relay', quiet);
    f.active();
    const health = f.incoming()({
      id: 9,
      method: 'item/tool/call',
      params: { tool: 'gestalt_org_plan_health', arguments: {} },
    });
    expect(f.runtime.resolveServerRequest('relay', '9', { readOnly: true })).toBe(true);
    expect(await health).toEqual({ readOnly: true });
    await expect(
      f.incoming()({
        id: 10,
        method: 'item/tool/call',
        params: { tool: 'gestalt_org_plan_health', arguments: { sessionId: 'other' } },
      }),
    ).rejects.toThrow('LIVE_MODE_ACTIVE');
  });
  it('fences a delayed accepted provider response after Stop without publishing a ready turn', async () => {
    const f = fixture();
    const session = await f.runtime.start(f.session, 'now');
    f.guard.settle('relay', quiet);
    const run = f.active();
    let finish!: (value: unknown) => void;
    f.delayTurn(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const operation = f.guard.liveEvent(run, 'event', () =>
      f.runtime.startTurn(session, 'Live', 'event', 'now'),
    );
    await Promise.resolve();
    await Promise.resolve();
    f.store.mutate(run, { event: 'stop' });
    finish({ turn: { id: 'late' } });
    await expect(operation).rejects.toThrow('LIVE_GENERATION_STALE');
    expect(f.store.read('relay')?.state).toBe('stopping');
  });
  it('denies delayed ordinary interaction settlement and every control tool after ownership changes', async () => {
    const f = fixture();
    await f.runtime.start(f.session, 'now');
    const held = f.incoming()({
      id: 1,
      method: 'item/commandExecution/requestApproval',
      params: {},
    });
    const settled = held.catch((error: Error) => error.message);
    f.guard.settle('relay', quiet);
    f.active();
    expect(() => f.runtime.resolveServerRequest('relay', '1', { decision: 'accept' })).toThrow(
      'LIVE_MODE_ACTIVE',
    );
    for (const tool of [
      'gestalt_org_plan_checkpoint',
      'gestalt_org_plan_attention',
      'gestalt_autopilot_wait_lease',
      'gestalt_agent_capacity_recovery',
    ])
      await expect(
        f.incoming()({ id: 2, method: 'item/tool/call', params: { tool, arguments: {} } }),
      ).rejects.toThrow('LIVE_MODE_ACTIVE');
    f.runtime.stopAll();
    expect(await settled).toBe('CODEX_SERVER_REQUEST_CANCELLED');
  });
  it('old controller callbacks cannot create a new writer after epoch takeover', async () => {
    const f = fixture();
    await f.runtime.start(f.session, 'now');
    const replacement = new SqliteLiveOwnership(
      join(f.root, 'private', 'live.sqlite'),
      'controller',
    );
    replacement.recoverController(1);
    await expect(f.runtime.startTurn(f.session, 'old callback', 'id', 'now')).rejects.toThrow(
      'LIVE_GENERATION_STALE',
    );
    expect(() => f.guard.settle('relay', quiet)).toThrow('LIVE_GENERATION_STALE');
    replacement.close();
  });
  it('Kimi actual adapters cannot start/restore/steer an overlapping Live app or convert provider', async () => {
    const f = fixture();
    f.active();
    const ensure = vi.fn();
    const get = vi.fn();
    const runtime = new KimiSessionRuntime({
      servers: { ensure, get } as unknown as KimiWebServerManager,
      skillsFor: async () => [],
      onNotification: () => {},
      onServerRequest: () => true,
      liveDispatch: f.guard,
    });
    const session = {
      ...f.session,
      id: 'kimi-relay',
      provider: 'kimi' as const,
      threadId: 'kimi-thread',
    };
    await expect(runtime.start(session, 'now')).rejects.toThrow('LIVE_MODE_ACTIVE');
    await expect(runtime.restoreWithOutcome(session, 'now')).rejects.toThrow('LIVE_MODE_ACTIVE');
    await expect(runtime.queueTurnInput(session, 'turn', 'ordinary')).rejects.toThrow(
      'LIVE_MODE_ACTIVE',
    );
    expect(ensure).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(f.launch).not.toHaveBeenCalled();
    expect(session.provider).toBe('kimi');
  });
});

describe('HTTP admission before ordinary prompt/cache/model effects', () => {
  it('reserves before delayed model discovery so Start cannot race model persistence', async () => {
    const f = fixture();
    const session = { ...f.session, state: 'ready' as const, threadId: 'root' };
    const app = fastify();
    registerProblemHandler(app);
    registerLiveDispatchBoundary(app, { policy: f.guard, session: () => session });
    let complete!: (models: string[]) => void;
    const models = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          complete = resolve;
        }),
    );
    const save = vi.fn();
    registerSelectModel(app, { find: () => session, models, now: () => 'now', save });
    const request = app.inject({
      method: 'POST',
      url: '/api/sessions/relay/model',
      payload: { model: 'next' },
    });
    await vi.waitFor(() => expect(models).toHaveBeenCalledOnce());
    expect(() => f.claim()).toThrow('LIVE_SESSION_BUSY');
    expect(save).not.toHaveBeenCalled();
    complete(['next']);
    expect((await request).statusCode).toBe(200);
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'codex', model: 'next' }),
    );
    expect(f.launch).not.toHaveBeenCalled();
    await app.close();
  });
  it('keeps nonmodel interrupt and explicit manual Off reachable while blocking On', async () => {
    const f = fixture();
    f.claim();
    const app = fastify();
    registerLiveDispatchBoundary(app, { policy: f.guard, session: () => f.session });
    const interrupt = vi.fn(async () => ({ interrupted: true }));
    const toggle = vi.fn(async () => ({ enabled: false }));
    app.post('/api/sessions/:id/turns/:turnId/interrupt', interrupt);
    app.put('/api/sessions/:id/autopilot', toggle);
    expect(
      (await app.inject({ method: 'POST', url: '/api/sessions/relay/turns/turn/interrupt' }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/sessions/relay/autopilot',
          payload: { enabled: false },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/sessions/relay/autopilot',
          payload: { enabled: true },
        })
      ).statusCode,
    ).toBe(409);
    expect(interrupt).toHaveBeenCalledOnce();
    expect(toggle).toHaveBeenCalledOnce();
    await app.close();
  });
  it('rejects cached ordinary prompt and forged Live flag before writer/history/idempotency effects', async () => {
    const f = fixture();
    const session = { ...f.session, state: 'ready' as const, threadId: 'root' };
    f.active();
    const app = fastify();
    registerProblemHandler(app);
    registerLiveDispatchBoundary(app, { policy: f.guard, session: () => session });
    const start = vi.fn(async () => session);
    const save = vi.fn();
    const cached = vi.fn(() => ({
      statusCode: 202,
      body: JSON.stringify({ fingerprint: 'old', response: session }),
    }));
    registerStartTurn(app, {
      find: () => session,
      start,
      save,
      idempotency: { get: cached, put: vi.fn() },
    });
    const models = vi.fn(async () => ['other']);
    registerSelectModel(app, { find: () => session, models, now: () => 'now', save });
    for (const url of ['/api/sessions/relay/turns', '/api/sessions/relay/model']) {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: { 'idempotency-key': 'cached' },
        payload: { text: 'ordinary', model: 'other', liveId: f.store.read('relay')!.liveId },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('LIVE_MODE_ACTIVE');
    }
    expect(cached).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(models).not.toHaveBeenCalled();
    await app.close();
  });
  it.each([
    '/restore',
    '/plan',
    '/debug',
    '/interactions/request',
    '/autopilot',
    '/release',
    '/stop',
    '',
  ])(
    'holds unsafe session control %s before its endpoint and allows nonmodel interrupt/manual Off',
    async (suffix) => {
      const f = fixture();
      f.claim();
      const app = fastify();
      registerLiveDispatchBoundary(app, { policy: f.guard, session: () => f.session });
      const effect = vi.fn(async () => ({ ok: true }));
      app.post(`/api/sessions/:id${suffix}`, effect);
      const response = await app.inject({
        method: 'POST',
        url: `/api/sessions/relay${suffix}`,
        payload: { enabled: true },
      });
      expect(response.statusCode).toBe(409);
      expect(effect).not.toHaveBeenCalled();
      await app.close();
    },
  );
});
