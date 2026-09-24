/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import WebSocket from 'ws';

import { composeRelayApp, type ComposeRelayAppOptions } from './composition.js';
import { AUTOPILOT_CONTINUATION_PROMPT } from './features/autopilot/application/policy.js';
import { CodexJsonRpcError } from './platform/codex/json-rpc-client.js';
import { SqliteAuthorizationStore } from './platform/auth/sqlite-authorization-store.js';
import {
  authorizationSessionId,
  authorizedDeviceId,
  localOwnerId,
  webAuthnCredentialId,
} from './features/auth/domain/identifiers.js';
import { deviceNickname } from './features/auth/domain/device-nickname.js';
import { workspaceId } from './platform/catalog/workspace-id.js';
import {
  planStatusDirectoryPath,
  planStatusFilePath,
} from './platform/plans/filesystem-plan-status-source.js';
import { toOrgPlanAttentionToolResponse } from '../shared/contracts/org-plan-attention.js';
import { toOrgPlanCheckpointToolResponse } from '../shared/contracts/org-plan-checkpoint.js';
import {
  applyProjectionEvent,
  createChatProjection,
} from '../client/features/chat/chat-projection.js';

function fakeAppServer(calls: string[]) {
  return {
    rpc: {
      request: async (method: string, params: unknown) => {
        calls.push(method);
        if (method === 'thread/start') return { thread: { id: 'thread-1' } };
        if (method === 'model/list') return { data: [{ id: 'gpt-5.6-terra' }] };
        if (method === 'skills/list')
          return {
            data: [{ cwd: (params as { cwds: string[] }).cwds[0], skills: [], errors: [] }],
          };
        return {};
      },
      onNotification: () => () => {},
      onServerRequest: () => () => {},
    },
    close: () => {},
    onExit: () => () => {},
  };
}

type LiveServerHandle = {
  calls: string[];
  requests: Array<{ method: string; params: unknown }>;
  respond?: (method: string, params: unknown) => unknown | Promise<unknown>;
  notify?: (notification: { method: string; params: unknown }) => void;
  request?: (request: { id: number; method: string; params: unknown }) => Promise<unknown>;
  responseSettled?: (settlement: {
    id: number;
    outcome: 'resultWritten' | 'errorWritten' | 'writeFailed';
  }) => void;
  deferResponseSettlement?: boolean;
  pendingResponses: Map<number, { resolve(): void; reject(error: Error): void }>;
};

function liveAppServer(handles: LiveServerHandle[]) {
  return () => {
    const handle: LiveServerHandle = { calls: [], requests: [], pendingResponses: new Map() };
    handles.push(handle);
    return {
      rpc: {
        request: async (method: string, params: unknown) => {
          handle.calls.push(method);
          handle.requests.push({ method, params });
          const overridden = await handle.respond?.(method, params);
          if (overridden !== undefined) return overridden;
          if (method === 'thread/start') return { thread: { id: `thread-${handles.length}` } };
          if (method === 'turn/start') return { turn: { id: `turn-${handle.calls.length}` } };
          if (method === 'thread/read') return { thread: { turns: [] } };
          if (method === 'model/list') return { data: [{ id: 'gpt-5.6-terra' }] };
          if (method === 'skills/list')
            return {
              data: [{ cwd: (params as { cwds: string[] }).cwds[0], skills: [], errors: [] }],
            };
          return {};
        },
        onNotification: (listener: LiveServerHandle['notify']) => {
          handle.notify = listener;
          return () => {};
        },
        onServerRequest: (listener: LiveServerHandle['request']) => {
          handle.request = async (request) => {
            try {
              const result = await listener!(request);
              if (!handle.deferResponseSettlement)
                handle.responseSettled?.({ id: request.id, outcome: 'resultWritten' });
              else
                await new Promise<void>((resolve, reject) =>
                  handle.pendingResponses.set(request.id, { resolve, reject }),
                );
              return result;
            } catch (error) {
              if (!handle.deferResponseSettlement)
                handle.responseSettled?.({ id: request.id, outcome: 'errorWritten' });
              throw error;
            }
          };
          return () => {};
        },
        onServerResponseSettled: (listener: NonNullable<LiveServerHandle['responseSettled']>) => {
          handle.responseSettled = (settlement) => {
            listener(settlement);
            const pending = handle.pendingResponses.get(settlement.id);
            if (!pending) return;
            handle.pendingResponses.delete(settlement.id);
            if (settlement.outcome === 'resultWritten') pending.resolve();
            else pending.reject(new Error('CODEX_SERVER_REQUEST_WRITE_FAILED'));
          };
          return () => {
            handle.responseSettled = undefined;
          };
        },
      },
      close: () => {
        for (const pending of handle.pendingResponses.values())
          pending.reject(new Error('CODEX_SERVER_REQUEST_CANCELLED'));
        handle.pendingResponses.clear();
      },
      onExit: () => () => {},
    };
  };
}

async function createComposedSession(app: Awaited<ReturnType<typeof composeAuthorizedApp>>) {
  const workspace = (await app.inject('/api/bootstrap'))
    .json()
    .workspaces[0]?.children.find((item: { name: string }) => item.name === 'workspace');
  expect(workspace).toBeDefined();
  const created = await app.inject({
    method: 'POST',
    url: '/api/sessions',
    payload: { workspaceId: workspace.id, profile: 'default', provider: 'codex' },
  });
  expect(created.statusCode).toBe(202);
  return created.json().id as string;
}

const autopilotPlanText = (childState: 'TODO' | 'DONE' = 'TODO') => `#+TITLE: Autopilot fixture
* WIP [#A] Parent
:PROPERTIES:
:ID: parent
:SKILLS: $gestalt:org-plan
:REVIEW_STATUS: UNREVIEWED
:END:
- Effort :: Small
- Goal :: Keep moving.
- Notes :: Coordinator fixture.
** ${childState} [#A] Child
:PROPERTIES:
:ID: child
:END:
- Why :: Exercise the coordinator.
- Change :: Publish a safe state.
- Tests :: Exercise production routes.
- Done when :: The plan remains incomplete.
`;

const completedAutopilotPlanText = () =>
  autopilotPlanText('DONE')
    .replace('* WIP [#A] Parent', '* DONE [#A] Parent')
    .replace(':REVIEW_STATUS: UNREVIEWED', ':REVIEW_STATUS: REVIEWED');

async function installAutopilotPlan(
  app: Awaited<ReturnType<typeof composeAuthorizedApp>>,
  sessionId: string,
  workspacePath: string,
  name: string,
  childState: 'TODO' | 'DONE' = 'TODO',
  reason = 'supervision-start',
) {
  const planPath = join(workspacePath, `${name}.org`);
  await writeFile(planPath, autopilotPlanText(childState));
  await writeFile(
    planStatusFilePath(planStatusDirectoryPath(workspacePath, sessionId), planPath),
    JSON.stringify({
      schemaVersion: 1,
      planPath,
      reason,
      updatedAt: new Date().toISOString(),
    }),
  );
  await expect
    .poll(async () => (await app.inject(`/api/sessions/${sessionId}/plan`)).statusCode)
    .toBe(200);
  expect(
    (await app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/restore` })).statusCode,
  ).toBe(200);
  return planPath;
}

async function createProductionAutopilotFixture(overrides: Partial<ComposeRelayAppOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-root-'));
  const dataDir = await mkdtemp(join(tmpdir(), 'gestalt-mobile-state-'));
  ownTemporaryPaths(root, dataDir);
  const workspacePath = join(root, 'workspace');
  await mkdir(workspacePath);
  const handles: LiveServerHandle[] = [];
  const app = await composeAuthorizedApp({
    root,
    dataDir,
    relyingParty,
    installedCodexVersion: 'codex-cli 0.144.3',
    startAppServers: true,
    launchAppServer: liveAppServer(handles),
    profiles: {
      list: async () => [],
      require: async () => ({ name: 'default', state: 'ok' as const, status: 'ready' as const }),
    },
    ...overrides,
  });
  const sessionId = await createComposedSession(app);
  await vi.waitFor(async () =>
    expect((await app.inject(`/api/sessions/${sessionId}`)).json()).toMatchObject({
      state: 'ready',
      threadId: expect.any(String),
    }),
  );
  await installAutopilotPlan(app, sessionId, workspacePath, 'autopilot');
  return { app, dataDir, handles, root, sessionId, workspacePath };
}

async function holdCheckpointRequest(
  fixture: Awaited<ReturnType<typeof createProductionAutopilotFixture>>,
  timers: Array<{ callback: () => void; cancelled: boolean }>,
  requestId: number,
  expectHeld = true,
) {
  timers.find((timer) => !timer.cancelled)!.callback();
  await vi.waitFor(() =>
    expect(
      fixture.handles.flatMap((candidate) =>
        candidate.requests.filter((request) => request.method === 'turn/start'),
      ),
    ).toHaveLength(1),
  );
  const handle = fixture.handles.find((candidate) =>
    candidate.requests.some((request) => request.method === 'turn/start'),
  )!;
  await vi.waitFor(() => expect(handle.request).toBeDefined());
  const session = (await fixture.app.inject(`/api/sessions/${fixture.sessionId}`)).json();
  const threadId = session.threadId as string;
  const turnId = session.activeTurnId as string;
  handle.notify!({ method: 'turn/started', params: { threadId, turn: { id: turnId } } });
  await writeFile(join(fixture.workspacePath, 'autopilot.org'), autopilotPlanText('DONE'));
  await expect
    .poll(
      async () =>
        (await fixture.app.inject(`/api/sessions/${fixture.sessionId}/plan`)).json().steps[0]
          .children[0].state,
    )
    .toBe('DONE');
  handle.deferResponseSettlement = true;
  const planIdentity = createHash('sha256')
    .update(join(fixture.workspacePath, 'autopilot.org'))
    .digest('hex');
  const writersBefore = fixture.handles.length;
  const startsBefore = fixture.handles
    .flatMap((candidate) => candidate.requests)
    .filter((request) => request.method === 'turn/start').length;
  const response = handle.request!(l2CheckpointCall(requestId, threadId, turnId, planIdentity));
  // The caller can be synchronously rejected by a coordinator exception.
  // Mark it observed immediately; callers still assert its exact outcome.
  void response.catch(() => {});
  if (expectHeld) await vi.waitFor(() => expect(handle.pendingResponses.has(requestId)).toBe(true));
  return { handle, response, startsBefore, threadId, turnId, writersBefore };
}

function attentionCall(id: number, reason: 'hardBlock' | 'permissionRequired' = 'hardBlock') {
  return {
    id,
    method: 'item/tool/call',
    params: {
      tool: 'gestalt_org_plan_attention',
      arguments: {
        reason,
        summary: 'A bounded human decision is required.',
        requestedAction: 'Provide the requested decision.',
        resumeCondition:
          reason === 'permissionRequired' ? 'permissionGranted' : 'externalStateChanged',
      },
    },
  };
}

function l2CheckpointCall(id: number, threadId: string, turnId: string, planIdentity: string) {
  return {
    id,
    method: 'item/tool/call',
    params: {
      threadId,
      turnId,
      tool: 'gestalt_org_plan_checkpoint',
      arguments: {
        version: 1,
        kind: 'l2Completed',
        planIdentity,
        l1Id: 'parent',
        l2Id: 'child',
        position: 'L1.1',
        status: 'DONE',
        changes: 'Recorded the completed child.',
        files: 'src/checkpoint.ts',
        tests: 'Focused tests passed.',
      },
    },
  };
}

function ownTemporaryPaths(...paths: string[]) {
  onTestFinished(async () => {
    await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  });
}

type CompositionConcern = 'autopilot' | 'attention' | 'lifecycle' | 'authorization' | 'sessions';

const compositionConcern = process.env.GESTALT_COMPOSITION_CONCERN as
  CompositionConcern | undefined;

function describeCompositionConcern(concern: CompositionConcern, callback: () => void) {
  if (compositionConcern === concern) describe(concern, callback);
}

const relyingParty = {
  publicOrigin: 'http://localhost:3000',
  rpId: 'localhost',
  rpName: 'Gestalt Mobile' as const,
};

async function composeAuthorizedApp(options: ComposeRelayAppOptions) {
  const homeDirectory =
    options.homeDirectory ?? (await mkdtemp(join(tmpdir(), 'gestalt-mobile-home-')));
  if (!options.homeDirectory) ownTemporaryPaths(homeDirectory);
  const store = new SqliteAuthorizationStore(homeDirectory, options.relyingParty);
  const owner = { id: localOwnerId('local-owner'), userHandle: new Uint8Array(32).fill(1) };
  store.initializeOwner(owner.userHandle);
  const device = {
    id: authorizedDeviceId('test-device'),
    credentialId: webAuthnCredentialId('test-credential'),
    publicKey: new Uint8Array([1]),
    counter: 0,
    transports: ['internal'] as const,
    deviceType: 'singleDevice' as const,
    backedUp: false,
    nickname: deviceNickname('Test device'),
    createdAt: '2026-08-02T00:00:00.000Z',
  };
  store.claimFirstDevice(owner, device);
  if (!store.sessionDevice(authorizationSessionId('test-session'), '2026-08-02T00:00:00.000Z'))
    store.saveSession(authorizationSessionId('test-session'), {
      deviceId: device.id,
      expiresAt: '2099-09-01T00:00:00.000Z',
    });
  store.close();
  const app = await composeRelayApp({ ...options, homeDirectory });
  const inject = app.inject.bind(app) as (options: unknown) => Promise<unknown>;
  app.inject = ((
    request: string | { headers?: Record<string, string>; [key: string]: unknown },
  ) => {
    if (typeof request === 'string')
      return inject({ url: request, headers: { cookie: 'gestalt_mobile_session=test-session' } });
    return inject({
      ...request,
      headers: {
        cookie: 'gestalt_mobile_session=test-session',
        ...(request.method && request.method !== 'GET'
          ? { origin: options.relyingParty.publicOrigin }
          : {}),
        ...request.headers,
      },
    });
  }) as never;
  return app;
}

async function createUnauthorizedProductionApp(root: string, dataDir: string) {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'gestalt-mobile-home-'));
  ownTemporaryPaths(homeDirectory);
  return composeRelayApp({
    root,
    dataDir,
    homeDirectory,
    relyingParty,
    profiles: {
      list: async () => [],
      require: async () => ({
        name: 'default' as const,
        state: 'ok' as const,
        status: 'ready' as const,
      }),
    },
    installedCodexVersion: null,
  });
}

describe('production composition', () => {
  describeCompositionConcern('autopilot', () => {
    it('autopilot production composition keeps disabled sessions free of timers, reads, polls, and leaks', async () => {
      const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-root-'));
      const dataDir = await mkdtemp(join(tmpdir(), 'gestalt-mobile-state-'));
      ownTemporaryPaths(root, dataDir);
      await mkdir(join(root, 'workspace'));
      const calls: string[] = [];
      const app = await composeAuthorizedApp({
        root,
        dataDir,
        relyingParty,
        installedCodexVersion: 'codex-cli 0.144.3',
        startAppServers: true,
        launchAppServer: () => fakeAppServer(calls),
        profiles: {
          list: async () => [],
          require: async () => ({
            name: 'default',
            state: 'ok' as const,
            status: 'ready' as const,
          }),
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(calls).toEqual([]);
      await app.close();
    });
    it('autopilot production composition authenticates concurrent toggles, schedules once, replays redacted audit, and keeps get/list safe', async () => {
      const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-root-'));
      const dataDir = await mkdtemp(join(tmpdir(), 'gestalt-mobile-state-'));
      ownTemporaryPaths(root, dataDir);
      const workspacePath = join(root, 'workspace');
      await mkdir(workspacePath);
      const handles: LiveServerHandle[] = [];
      const app = await composeAuthorizedApp({
        root,
        dataDir,
        relyingParty,
        installedCodexVersion: 'codex-cli 0.144.3',
        startAppServers: true,
        launchAppServer: liveAppServer(handles),
        profiles: {
          list: async () => [],
          require: async () => ({
            name: 'default',
            state: 'ok' as const,
            status: 'ready' as const,
          }),
        },
      });
      const sessionId = await createComposedSession(app);
      await vi.waitFor(async () =>
        expect((await app.inject(`/api/sessions/${sessionId}`)).json()).toMatchObject({
          state: 'ready',
          threadId: expect.any(String),
        }),
      );
      // An authenticated request cannot opt in until a retained incomplete plan exists.
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: `/api/sessions/${sessionId}/autopilot`,
            payload: { enabled: true },
          })
        ).json(),
      ).toEqual({ code: 'AUTOPILOT_PLAN_REQUIRED' });
      const planPath = join(workspacePath, 'autopilot.org');
      await writeFile(
        planPath,
        `#+TITLE: Autopilot fixture
* WIP [#A] Parent
:PROPERTIES:
:ID: parent
:SKILLS: $gestalt:org-plan
:REVIEW_STATUS: UNREVIEWED
:END:
- Effort :: Small
- Goal :: Keep moving.
- Notes :: Coordinator fixture.
** TODO [#A] Child
:PROPERTIES:
:ID: child
:END:
- Why :: Exercise the coordinator.
- Change :: Publish a safe state.
- Tests :: Exercise production routes.
- Done when :: The plan remains incomplete.
`,
      );
      const opened = await app.inject({
        method: 'PUT',
        url: `/api/sessions/${sessionId}/plan`,
        payload: { planName: 'autopilot.org' },
      });
      expect(opened.statusCode).toBe(200);
      expect(opened.json()).toMatchObject({ title: 'Autopilot fixture', allDone: false });
      expect((await app.inject(`/api/sessions/${sessionId}/plan`)).statusCode).toBe(200);
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
      const socket = new WebSocket(
        `ws://127.0.0.1:${address.port}/api/sessions/${sessionId}/events?after=0`,
        {
          headers: {
            origin: relyingParty.publicOrigin,
            cookie: 'gestalt_mobile_session=test-session',
          },
        },
      );
      const messages: Array<{ event: { type: string; payload: Record<string, unknown> } }> = [];
      socket.on('message', (data) => messages.push(JSON.parse(String(data))));
      await once(socket, 'open');
      expect(
        (await app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/restore` }))
          .statusCode,
      ).toBe(200);
      const enabled = await app.inject({
        method: 'PUT',
        url: `/api/sessions/${sessionId}/autopilot`,
        payload: { enabled: true },
      });
      expect(enabled.statusCode).toBe(200);
      expect(enabled.json()).toMatchObject({ autopilot: { enabled: true } });
      await vi.waitFor(() =>
        expect(messages.some((message) => message.event.type === 'autopilot.updated')).toBe(true),
      );
      expect(
        messages.filter((message) => message.event.type === 'autopilot.updated').at(-1)?.event
          .payload,
      ).toMatchObject({ enabled: true });
      // This is production composition, not a coordinator fake: the scheduler reaches the
      // real runtime adapter and can pass only policy-owned lifecycle context and an opaque ID.
      await vi.waitFor(
        () => expect(handles.at(-1)?.calls.filter((call) => call === 'turn/start')).toHaveLength(1),
        { timeout: 2_500 },
      );
      const automaticStart = handles.at(-1)?.requests.find((call) => call.method === 'turn/start');
      expect(automaticStart?.params).toEqual({
        threadId: expect.any(String),
        input: [
          {
            type: 'text',
            text: `${AUTOPILOT_CONTINUATION_PROMPT} Launch task_name l1 for canonical L1; retain the canonical label in status and review output.`,
            text_elements: [],
          },
        ],
        clientUserMessageId: expect.stringMatching(/^autopilot-\d+-[a-f0-9]{16}$/),
        model: 'gpt-5.6-terra',
      });
      // The journal commits before the runtime request resolves, while the WebSocket transport
      // delivers the committed events on its own turn of the event loop. Observe the durable
      // boundary rather than assuming a synchronous socket delivery after `turn/start`.
      await vi.waitFor(() => {
        expect(messages.some((message) => message.event.type === 'autopilot.control-issued')).toBe(
          true,
        );
        expect(messages.some((message) => message.event.type === 'autopilot.turn-started')).toBe(
          true,
        );
      });
      const updates = messages.filter((message) => message.event.type === 'autopilot.updated');
      await Promise.all(
        [true, true].map(() =>
          app.inject({
            method: 'PUT',
            url: `/api/sessions/${sessionId}/autopilot`,
            payload: { enabled: true },
          }),
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(messages.filter((message) => message.event.type === 'autopilot.updated')).toHaveLength(
        updates.length,
      );
      expect((await app.inject(`/api/sessions/${sessionId}`)).json()).toMatchObject({
        autopilot: { enabled: true },
      });
      expect((await app.inject('/api/sessions')).json()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: sessionId, autopilot: expect.any(Object) }),
        ]),
      );
      expect(JSON.stringify(await app.inject(`/api/sessions/${sessionId}`))).not.toContain(
        'Inspect the active supervised Org Plan',
      );
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: `/api/sessions/${sessionId}/autopilot`,
            payload: { enabled: false },
          })
        ).json(),
      ).toMatchObject({ autopilot: { enabled: false, state: 'disabled' } });
      socket.close();
      const replayed: Array<{
        type: string;
        event?: { sequence: number; type: string; payload: unknown };
      }> = [];
      const replay = new WebSocket(
        `ws://127.0.0.1:${address.port}/api/sessions/${sessionId}/events?after=0`,
        {
          headers: {
            origin: relyingParty.publicOrigin,
            cookie: 'gestalt_mobile_session=test-session',
          },
        },
      );
      replay.on('message', (data) => replayed.push(JSON.parse(String(data))));
      await once(replay, 'open');
      await vi.waitFor(() =>
        expect(replayed.some((message) => message.event?.type === 'autopilot.updated')).toBe(true),
      );
      const sequence = replayed.flatMap((message) =>
        message.event ? [message.event.sequence] : [],
      );
      expect(new Set(sequence).size).toBe(sequence.length);
      expect(JSON.stringify(replayed)).not.toContain('Inspect the active supervised Org Plan');
      replay.close();
      await app.close();
    });
    it('autopilot production composition isolates concurrent session enablement, disablement, and safe snapshots', async () => {
      const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-root-'));
      const dataDir = await mkdtemp(join(tmpdir(), 'gestalt-mobile-state-'));
      ownTemporaryPaths(root, dataDir);
      const workspacePath = join(root, 'workspace');
      await mkdir(workspacePath);
      const handles: LiveServerHandle[] = [];
      const app = await composeAuthorizedApp({
        root,
        dataDir,
        relyingParty,
        installedCodexVersion: 'codex-cli 0.144.3',
        startAppServers: true,
        launchAppServer: liveAppServer(handles),
        profiles: {
          list: async () => [],
          require: async () => ({
            name: 'default',
            state: 'ok' as const,
            status: 'ready' as const,
          }),
        },
      });
      const sessions = await Promise.all([createComposedSession(app), createComposedSession(app)]);
      await vi.waitFor(async () =>
        expect(
          await Promise.all(
            sessions.map(
              async (sessionId) => (await app.inject(`/api/sessions/${sessionId}`)).json().state,
            ),
          ),
        ).toEqual(['ready', 'ready']),
      );
      const planText = `#+TITLE: Autopilot fixture
* WIP [#A] Parent
:PROPERTIES:
:ID: parent
:SKILLS: $gestalt:org-plan
:REVIEW_STATUS: UNREVIEWED
:END:
- Effort :: Small
- Goal :: Keep moving.
- Notes :: Coordinator fixture.
** TODO [#A] Child
:PROPERTIES:
:ID: child
:END:
- Why :: Exercise the coordinator.
- Change :: Publish a safe state.
- Tests :: Exercise production routes.
- Done when :: The plan remains incomplete.
`;
      await Promise.all(
        sessions.map(async (sessionId, index) => {
          const planPath = join(workspacePath, `autopilot-${index}.org`);
          await writeFile(planPath, planText);
          await writeFile(
            planStatusFilePath(planStatusDirectoryPath(workspacePath, sessionId), planPath),
            JSON.stringify({
              schemaVersion: 1,
              planPath,
              reason: 'supervision-start',
              updatedAt: new Date().toISOString(),
            }),
          );
          await expect
            .poll(async () => (await app.inject(`/api/sessions/${sessionId}/plan`)).statusCode)
            .toBe(200);
          expect(
            (await app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/restore` }))
              .statusCode,
          ).toBe(200);
        }),
      );
      await vi.waitFor(async () =>
        expect(
          await Promise.all(
            sessions.map(
              async (sessionId) => (await app.inject(`/api/sessions/${sessionId}`)).json().threadId,
            ),
          ),
        ).toEqual([expect.any(String), expect.any(String)]),
      );
      await app.listen({ host: '127.0.0.1', port: 0 });
      for (const sessionId of sessions) {
        expect(
          (
            await app.inject({
              method: 'PUT',
              url: `/api/sessions/${sessionId}/autopilot`,
              payload: { enabled: true },
            })
          ).statusCode,
        ).toBe(200);
      }
      const [first, second] = sessions;
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: `/api/sessions/${first}/autopilot`,
            payload: { enabled: false },
          })
        ).json(),
      ).toMatchObject({
        autopilot: { enabled: false, state: 'disabled' },
      });
      expect((await app.inject(`/api/sessions/${second}`)).json()).toMatchObject({
        autopilot: { enabled: true },
      });
      expect(JSON.stringify(await app.inject('/api/sessions'))).not.toContain(
        'Inspect the active supervised Org Plan',
      );
      await app.close();
    });
    it('production same-DB restart rearms future backoff and claims overdue once', async () => {
      const timers: Array<{ callback: () => void; delayMs: number }> = [];
      let coordinator:
        import('./features/autopilot/application/service.js').AutopilotCoordinator | undefined;
      const fixture = await createProductionAutopilotFixture({
        autopilotSchedule: (callback, delayMs) => {
          timers.push({ callback, delayMs });
          return () => undefined;
        },
        onAutopilotCoordinator: (value) => {
          coordinator = value;
        },
      });
      expect(
        (
          await fixture.app.inject({
            method: 'PUT',
            url: `/api/sessions/${fixture.sessionId}/autopilot`,
            payload: { enabled: true },
          })
        ).statusCode,
      ).toBe(200);
      await vi.waitFor(() => expect(timers.length).toBeGreaterThan(0));
      coordinator!.dispose(fixture.sessionId);
      timers.length = 0;
      const database = new DatabaseSync(join(fixture.dataDir, 'relay.sqlite'));
      const future = new Date(Date.now() + 60_000).toISOString();
      const timestamp = new Date().toISOString();
      database
        .prepare(
          "UPDATE autopilot_sessions SET state = 'backoff', generation = 7, no_progress_count = 0, next_evaluation_at = ?, last_control_id = 'future-control', stop_reason = NULL, updated_at = ? WHERE session_id = ?",
        )
        .run(future, timestamp, fixture.sessionId);
      database
        .prepare('DELETE FROM autopilot_controls WHERE session_id = ?')
        .run(fixture.sessionId);
      database
        .prepare(
          "INSERT INTO autopilot_controls (session_id,control_id,status,created_at,updated_at,failure_code,turn_id) VALUES (?, 'future-control', 'scheduled', ?, ?, NULL, NULL)",
        )
        .run(fixture.sessionId, timestamp, timestamp);
      database.close();
      coordinator!.restore(fixture.sessionId);
      expect(timers).toHaveLength(1);
      expect(timers[0]!.delayMs).toBeGreaterThan(0);
      // A fresh process sees the same durable state after its wall-clock deadline.
      timers[0]!.callback();
      timers[0]!.callback();
      await vi.waitFor(() =>
        expect(
          fixture.handles.flatMap((handle) => handle.calls).filter((call) => call === 'turn/start'),
        ).toHaveLength(1),
      );
      const audit = new DatabaseSync(join(fixture.dataDir, 'relay.sqlite'));
      const issued = audit
        .prepare(
          "SELECT count(*) AS count FROM autopilot_controls WHERE session_id = ? AND status = 'started'",
        )
        .get(fixture.sessionId) as { count: number };
      const events = audit
        .prepare(
          "SELECT count(*) AS count FROM session_events WHERE session_id = ? AND type = 'autopilot.turn-started'",
        )
        .get(fixture.sessionId) as { count: number };
      audit.close();
      expect(issued.count).toBe(1);
      expect(events.count).toBe(1);
      await fixture.app.close();
    });

    it('production restart keeps unexplained issued state supervised while persisted activeTurn records one started audit without replay', async () => {
      let coordinator:
        import('./features/autopilot/application/service.js').AutopilotCoordinator | undefined;
      const fixture = await createProductionAutopilotFixture({
        onAutopilotCoordinator: (value) => {
          coordinator = value;
        },
      });
      const database = new DatabaseSync(join(fixture.dataDir, 'relay.sqlite'));
      const timestamp = new Date().toISOString();
      database
        .prepare('DELETE FROM autopilot_sessions WHERE session_id = ?')
        .run(fixture.sessionId);
      database
        .prepare(
          "INSERT INTO autopilot_sessions (session_id,state,requested_enabled,plan_identity,plan_fingerprint,generation,no_progress_count,next_evaluation_at,last_control_id,stop_reason,updated_at) VALUES (?, 'backoff', 1, 'fixture', 'fixture', 1, 0, ?, 'issued-without-turn', NULL, ?)",
        )
        .run(fixture.sessionId, timestamp, timestamp);
      database
        .prepare(
          "INSERT INTO autopilot_controls (session_id,control_id,status,created_at,updated_at,failure_code,turn_id) VALUES (?, 'issued-without-turn', 'issued', ?, ?, NULL, NULL)",
        )
        .run(fixture.sessionId, timestamp, timestamp);
      database.close();
      coordinator!.restore(fixture.sessionId);
      await vi.waitFor(async () =>
        expect(
          (await fixture.app.inject(`/api/sessions/${fixture.sessionId}`)).json(),
        ).toMatchObject({
          autopilot: { enabled: true, state: 'monitoring', reason: 'reconcileFailed' },
        }),
      );
      expect(fixture.handles.flatMap((handle) => handle.calls)).not.toContain('turn/start');
      // Re-enabling is idempotent because runtime ambiguity remains under
      // condition-based supervision rather than becoming synthetic attention.
      expect(
        (
          await fixture.app.inject({
            method: 'PUT',
            url: `/api/sessions/${fixture.sessionId}/autopilot`,
            payload: { enabled: true },
          })
        ).statusCode,
      ).toBe(200);
      await vi.waitFor(async () =>
        expect(
          (await fixture.app.inject(`/api/sessions/${fixture.sessionId}`)).json(),
        ).toMatchObject({
          autopilot: { enabled: true, state: expect.stringMatching(/monitoring|backoff/) },
        }),
      );
      await fixture.app.close();

      let recovered:
        import('./features/autopilot/application/service.js').AutopilotCoordinator | undefined;
      const accepted = await createProductionAutopilotFixture({
        onAutopilotCoordinator: (value) => {
          recovered = value;
        },
      });
      const acceptedDatabase = new DatabaseSync(join(accepted.dataDir, 'relay.sqlite'));
      acceptedDatabase
        .prepare('DELETE FROM autopilot_sessions WHERE session_id = ?')
        .run(accepted.sessionId);
      acceptedDatabase
        .prepare(
          "INSERT INTO autopilot_sessions (session_id,state,requested_enabled,plan_identity,plan_fingerprint,generation,no_progress_count,next_evaluation_at,last_control_id,stop_reason,updated_at) VALUES (?, 'backoff', 1, 'fixture', 'fixture', 1, 0, ?, 'issued-with-turn', NULL, ?)",
        )
        .run(accepted.sessionId, timestamp, timestamp);
      acceptedDatabase
        .prepare(
          "INSERT INTO autopilot_controls (session_id,control_id,status,created_at,updated_at,failure_code,turn_id) VALUES (?, 'issued-with-turn', 'issued', ?, ?, NULL, NULL)",
        )
        .run(accepted.sessionId, timestamp, timestamp);
      acceptedDatabase
        .prepare("UPDATE relay_sessions SET active_turn_id = 'persisted-turn' WHERE id = ?")
        .run(accepted.sessionId);
      acceptedDatabase.close();
      recovered!.restore(accepted.sessionId);
      await vi.waitFor(async () =>
        expect(
          (await accepted.app.inject(`/api/sessions/${accepted.sessionId}`)).json(),
        ).toMatchObject({
          autopilot: { enabled: true, state: 'backoff' },
        }),
      );
      const auditDatabase = new DatabaseSync(join(accepted.dataDir, 'relay.sqlite'));
      const started = auditDatabase
        .prepare(
          "SELECT count(*) AS count FROM autopilot_controls WHERE session_id = ? AND status = 'started'",
        )
        .get(accepted.sessionId) as { count: number };
      const audits = auditDatabase
        .prepare(
          "SELECT count(*) AS count FROM session_events WHERE session_id = ? AND type = 'autopilot.turn-started'",
        )
        .get(accepted.sessionId) as { count: number };
      auditDatabase.close();
      expect(started.count).toBe(1);
      expect(audits.count).toBe(1);
      recovered!.restore(accepted.sessionId);
      expect(accepted.handles.flatMap((handle) => handle.calls)).not.toContain('turn/start');
      await accepted.app.close();
    });

    it('acknowledges a checkpoint before scheduling and drops an obsolete executor wait lease', async () => {
      const timers: Array<{ callback: () => void; cancelled: boolean; fired: boolean }> = [];
      let coordinator:
        import('./features/autopilot/application/service.js').AutopilotCoordinator | undefined;
      const fixture = await createProductionAutopilotFixture({
        autopilotSchedule: (callback) => {
          const timer = { callback, cancelled: false, fired: false };
          timers.push(timer);
          return () => {
            timer.cancelled = true;
          };
        },
        onAutopilotCoordinator: (value) => {
          coordinator = value;
        },
      });
      const first = timers.find((timer) => !timer.cancelled && !timer.fired);
      expect(first).toBeDefined();
      first!.fired = true;
      first!.callback();
      await vi.waitFor(() =>
        expect(
          fixture.handles.flatMap((handle) =>
            handle.requests.filter((request) => request.method === 'turn/start'),
          ),
        ).toHaveLength(1),
      );
      const database = new DatabaseSync(join(fixture.dataDir, 'relay.sqlite'));
      const active = database
        .prepare('SELECT active_turn_id FROM relay_sessions WHERE id = ?')
        .get(fixture.sessionId) as { active_turn_id: string };
      database.close();
      expect(
        coordinator!.registerProactiveWait(fixture.sessionId, {
          id: 'pre-checkpoint-report',
          leaseId: 'pre-checkpoint-lease',
          wakeConditions: ['executorChanged'],
          maxWaitMs: 60_000,
        }),
      ).toBe(true);
      await writeFile(join(fixture.workspacePath, 'autopilot.org'), autopilotPlanText('DONE'));
      await expect
        .poll(
          async () =>
            (await fixture.app.inject(`/api/sessions/${fixture.sessionId}/plan`)).json().steps[0]
              .children[0].state,
        )
        .toBe('DONE');
      const handle = fixture.handles.find((candidate) =>
        candidate.requests.some((request) => request.method === 'turn/start'),
      )!;
      const threadId = (await fixture.app.inject(`/api/sessions/${fixture.sessionId}`)).json()
        .threadId as string;
      const schedulesBeforeCheckpoint = timers.length;
      const planIdentity = createHash('sha256')
        .update(join(fixture.workspacePath, 'autopilot.org'))
        .digest('hex');
      handle.deferResponseSettlement = true;
      const checkpointResponse = handle.request!(
        l2CheckpointCall(811, threadId, active.active_turn_id, planIdentity),
      );
      await vi.waitFor(() => expect(handle.pendingResponses.has(811)).toBe(true));
      const beforeWriteDatabase = new DatabaseSync(join(fixture.dataDir, 'relay.sqlite'));
      const beforeWrite = beforeWriteDatabase
        .prepare(
          'SELECT resolved_at FROM pending_interactions WHERE session_id = ? AND request_id = ?',
        )
        .get(fixture.sessionId, '811') as { resolved_at: string | null };
      beforeWriteDatabase.close();
      expect(beforeWrite.resolved_at).toBeNull();
      handle.responseSettled!({ id: 811, outcome: 'resultWritten' });
      await expect(checkpointResponse).resolves.toEqual(toOrgPlanCheckpointToolResponse());
      const afterWriteDatabase = new DatabaseSync(join(fixture.dataDir, 'relay.sqlite'));
      const afterWrite = afterWriteDatabase
        .prepare(
          'SELECT resolved_at FROM pending_interactions WHERE session_id = ? AND request_id = ?',
        )
        .get(fixture.sessionId, '811') as { resolved_at: string | null };
      afterWriteDatabase.close();
      expect(afterWrite.resolved_at).toEqual(expect.any(String));
      expect(timers).toHaveLength(schedulesBeforeCheckpoint);
      expect(coordinator!.snapshot(fixture.sessionId).health).not.toMatchObject({
        phase: 'waitingForAgentEvent',
      });
      const startsBeforeFinal = fixture.handles
        .flatMap((candidate) => candidate.requests)
        .filter((request) => request.method === 'turn/start').length;
      // A completion from another turn cannot release the durable checkpoint
      // boundary, including after the short acknowledgement has returned.
      handle.notify!({
        method: 'turn/completed',
        params: { threadId, turn: { id: 'wrong-turn' } },
      });
      await Promise.resolve();
      expect(
        fixture.handles
          .flatMap((candidate) => candidate.requests)
          .filter((request) => request.method === 'turn/start'),
      ).toHaveLength(startsBeforeFinal);
      // Destroy the old runtime and rebuild the coordinator over the same
      // SQLite store. The persisted checkpoint remains inert until its owning
      // root final is observed by the replacement runtime.
      await fixture.app.close();
      const rebuiltTimers: Array<{ callback: () => void; cancelled: boolean; fired: boolean }> = [];
      const rebuiltHandles: LiveServerHandle[] = [];
      let rebuiltCoordinator:
        import('./features/autopilot/application/service.js').AutopilotCoordinator | undefined;
      const rebuilt = await composeAuthorizedApp({
        root: fixture.root,
        dataDir: fixture.dataDir,
        relyingParty,
        installedCodexVersion: 'codex-cli 0.144.3',
        startAppServers: true,
        launchAppServer: liveAppServer(rebuiltHandles),
        autopilotSchedule: (callback) => {
          const timer = { callback, cancelled: false, fired: false };
          rebuiltTimers.push(timer);
          return () => {
            timer.cancelled = true;
          };
        },
        onAutopilotCoordinator: (value) => {
          rebuiltCoordinator = value;
        },
        profiles: {
          list: async () => [],
          require: async () => ({
            name: 'default',
            state: 'ok' as const,
            status: 'ready' as const,
          }),
        },
      });
      await vi.waitFor(() => expect(rebuiltCoordinator).toBeDefined());
      expect(rebuiltTimers).toHaveLength(0);
      expect(rebuiltCoordinator!.turnCompleted(fixture.sessionId)).toBe(true);
      await vi.waitFor(() => expect(rebuiltTimers.length).toBe(1));
      await rebuilt.close();
    });

    it('recycles a stuck checkpoint writer at the acknowledgement deadline and recovers once', async () => {
      const timers: Array<{ callback: () => void; cancelled: boolean }> = [];
      const fixture = await createProductionAutopilotFixture({
        checkpointHandoffDeadlineMs: 100,
        autopilotSchedule: (callback) => {
          const timer = { callback, cancelled: false };
          timers.push(timer);
          return () => {
            timer.cancelled = true;
          };
        },
      });
      timers.find((timer) => !timer.cancelled)!.callback();
      await vi.waitFor(() =>
        expect(
          fixture.handles.flatMap((candidate) =>
            candidate.requests.filter((request) => request.method === 'turn/start'),
          ),
        ).toHaveLength(1),
      );
      await vi.waitFor(() =>
        expect(fixture.handles.some((candidate) => candidate.request)).toBe(true),
      );
      const handle = fixture.handles.find((candidate) =>
        candidate.requests.some((request) => request.method === 'turn/start'),
      )!;
      const threadId = (await fixture.app.inject(`/api/sessions/${fixture.sessionId}`)).json()
        .threadId as string;
      const database = new DatabaseSync(join(fixture.dataDir, 'relay.sqlite'));
      const active = database
        .prepare('SELECT active_turn_id FROM relay_sessions WHERE id = ?')
        .get(fixture.sessionId) as { active_turn_id: string };
      database.close();
      await writeFile(join(fixture.workspacePath, 'autopilot.org'), autopilotPlanText('DONE'));
      await expect
        .poll(
          async () =>
            (await fixture.app.inject(`/api/sessions/${fixture.sessionId}/plan`)).json().steps[0]
              .children[0].state,
        )
        .toBe('DONE');
      handle.notify!({
        method: 'turn/started',
        params: { threadId, turn: { id: active.active_turn_id } },
      });
      handle.deferResponseSettlement = true;
      const identity = createHash('sha256')
        .update(join(fixture.workspacePath, 'autopilot.org'))
        .digest('hex');
      const checkpointResponse = handle.request!(
        l2CheckpointCall(991, threadId, active.active_turn_id, identity),
      );
      const rejectedCheckpoint = expect(checkpointResponse).rejects.toThrow(
        'CODEX_SERVER_REQUEST_CANCELLED',
      );
      await vi.waitFor(() => expect(handle.pendingResponses.has(991)).toBe(true));
      const timersBeforeRecovery = timers.length;
      await rejectedCheckpoint;
      expect(
        fixture.handles
          .flatMap((candidate) => candidate.requests)
          .filter((request) => request.method === 'turn/start'),
      ).toHaveLength(1);
      await vi.waitFor(() => expect(fixture.handles.length).toBeGreaterThan(1), { timeout: 1_000 });
      expect(
        fixture.handles
          .flatMap((candidate) => candidate.requests)
          .filter((request) => request.method === 'turn/start'),
      ).toHaveLength(1);
      await expect
        .poll(() => {
          const audit = new DatabaseSync(join(fixture.dataDir, 'relay.sqlite'));
          const count = audit
            .prepare(
              "SELECT count(*) AS count FROM session_events WHERE type = 'org-plan.checkpoint-handoff-failed'",
            )
            .get() as { count: number };
          audit.close();
          return count.count;
        })
        .toBe(1);
      await expect
        .poll(() => {
          const recoveredState = new DatabaseSync(join(fixture.dataDir, 'relay.sqlite'));
          const lifecycle = recoveredState
            .prepare('SELECT lifecycle_json FROM autopilot_sessions WHERE session_id = ?')
            .get(fixture.sessionId) as { lifecycle_json: string };
          recoveredState.close();
          return JSON.parse(lifecycle.lifecycle_json).checkpoints;
        })
        .toMatchObject({ pendingTurnId: null, checkpointHandoffFailed: false });
      await vi.waitFor(() => expect(timers.length).toBeGreaterThan(timersBeforeRecovery));
      const recoveryTimer = timers.at(-1)!;
      recoveryTimer.callback();
      await vi.waitFor(() =>
        expect(
          fixture.handles
            .flatMap((candidate) => candidate.requests)
            .filter((request) => request.method === 'turn/start'),
        ).toHaveLength(2),
      );
      await fixture.app.close();
    });

    it('leaves an unsupported checkpoint exception before persistence inert', async () => {
      let coordinator:
        import('./features/autopilot/application/service.js').AutopilotCoordinator | undefined;
      const timers: Array<{ callback: () => void; cancelled: boolean }> = [];
      const fixture = await createProductionAutopilotFixture({
        autopilotSchedule: (callback) => {
          const timer = { callback, cancelled: false };
          timers.push(timer);
          return () => {
            timer.cancelled = true;
          };
        },
        onAutopilotCoordinator: (value) => {
          coordinator = value;
        },
      });
      const original = coordinator!.checkpointAccepted.bind(coordinator);
      vi.spyOn(coordinator!, 'checkpointAccepted').mockImplementation(() => {
        throw new Error('injected-before-checkpoint-persistence');
      });
      const { response, startsBefore, writersBefore } = await holdCheckpointRequest(
        fixture,
        timers,
        995,
        false,
      );
      await expect(response).rejects.toThrow('CODEX_SERVER_REQUEST_UNSUPPORTED');
      expect(coordinator!.checkpointAccepted).not.toBe(original);
      expect(fixture.handles).toHaveLength(writersBefore);
      expect(
        fixture.handles
          .flatMap((candidate) => candidate.requests)
          .filter((request) => request.method === 'turn/start'),
      ).toHaveLength(startsBefore);
      const database = new DatabaseSync(join(fixture.dataDir, 'relay.sqlite'));
      const events = database
        .prepare(
          "SELECT type FROM session_events WHERE type IN ('org-plan.step-checkpointed', 'org-plan.checkpoint-handoff-failed')",
        )
        .all() as Array<{ type: string }>;
      const lifecycle = database
        .prepare('SELECT lifecycle_json FROM autopilot_sessions WHERE session_id = ?')
        .get(fixture.sessionId) as { lifecycle_json: string };
      database.close();
      expect(events).toEqual([]);
      expect(JSON.parse(lifecycle.lifecycle_json).checkpoints).toBeUndefined();
      expect(
        (await fixture.app.inject(`/api/sessions/${fixture.sessionId}/history`)).json()
          .interactions,
      ).not.toEqual(expect.arrayContaining([expect.objectContaining({ requestId: '995' })]));
      await fixture.app.close();
    });

    it('turns a post-persistence checkpoint exception into one explicit failed handoff', async () => {
      let coordinator:
        import('./features/autopilot/application/service.js').AutopilotCoordinator | undefined;
      const timers: Array<{ callback: () => void; cancelled: boolean }> = [];
      const fixture = await createProductionAutopilotFixture({
        autopilotSchedule: (callback) => {
          const timer = { callback, cancelled: false };
          timers.push(timer);
          return () => {
            timer.cancelled = true;
          };
        },
        onAutopilotCoordinator: (value) => {
          coordinator = value;
        },
      });
      const original = coordinator!.checkpointAccepted.bind(coordinator);
      vi.spyOn(coordinator!, 'checkpointAccepted').mockImplementation((...input) => {
        original(...input);
        throw new Error('injected-after-checkpoint-persistence');
      });
      const { response, startsBefore, writersBefore } = await holdCheckpointRequest(
        fixture,
        timers,
        996,
        false,
      );
      await expect(response).rejects.toThrow('CHECKPOINT_HANDOFF_FAILED');
      await vi.waitFor(async () => {
        const database = new DatabaseSync(join(fixture.dataDir, 'relay.sqlite'));
        const failures = database
          .prepare(
            "SELECT count(*) AS count FROM session_events WHERE type = 'org-plan.checkpoint-handoff-failed'",
          )
          .get() as { count: number };
        database.close();
        expect(failures.count).toBe(1);
      });
      const history = (
        await fixture.app.inject(`/api/sessions/${fixture.sessionId}/history`)
      ).json();
      expect(history.interactions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            requestId: '996',
            kind: 'orgPlanCheckpoint',
            outcome: 'failed',
          }),
        ]),
      );
      const database = new DatabaseSync(join(fixture.dataDir, 'relay.sqlite'));
      const lifecycle = database
        .prepare('SELECT lifecycle_json FROM autopilot_sessions WHERE session_id = ?')
        .get(fixture.sessionId) as { lifecycle_json: string };
      database.close();
      expect(JSON.parse(lifecycle.lifecycle_json).checkpoints).toMatchObject({
        pendingTurnId: expect.any(String),
        checkpointHandoffFailed: true,
      });
      expect(fixture.handles).toHaveLength(writersBefore);
      expect(
        fixture.handles
          .flatMap((candidate) => candidate.requests)
          .filter((request) => request.method === 'turn/start'),
      ).toHaveLength(startsBefore);
      await fixture.app.close();
    });

    it('restores a pending checkpoint handoff once from the same database', async () => {
      const timers: Array<{ callback: () => void; cancelled: boolean }> = [];
      const fixture = await createProductionAutopilotFixture({
        autopilotSchedule: (callback) => {
          const timer = { callback, cancelled: false };
          timers.push(timer);
          return () => {
            timer.cancelled = true;
          };
        },
      });
      const { response } = await holdCheckpointRequest(fixture, timers, 997);
      await fixture.app.close();
      await expect(response).rejects.toThrow('CODEX_SERVER_REQUEST_CANCELLED');

      const rebuiltHandles: LiveServerHandle[] = [];
      const rebuiltTimers: Array<{ callback: () => void; cancelled: boolean }> = [];
      let rebuiltCoordinator:
        import('./features/autopilot/application/service.js').AutopilotCoordinator | undefined;
      const rebuilt = await composeAuthorizedApp({
        root: fixture.root,
        dataDir: fixture.dataDir,
        relyingParty,
        installedCodexVersion: 'codex-cli 0.144.3',
        startAppServers: true,
        launchAppServer: liveAppServer(rebuiltHandles),
        autopilotSchedule: (callback) => {
          const timer = { callback, cancelled: false };
          rebuiltTimers.push(timer);
          return () => {
            timer.cancelled = true;
          };
        },
        onAutopilotCoordinator: (value) => {
          rebuiltCoordinator = value;
        },
        profiles: {
          list: async () => [],
          require: async () => ({
            name: 'default',
            state: 'ok' as const,
            status: 'ready' as const,
          }),
        },
      });
      await rebuilt.listen({ port: 0 });
      await vi.waitFor(() => expect(rebuiltCoordinator).toBeDefined());
      await vi.waitFor(() => expect(rebuiltTimers.some((timer) => !timer.cancelled)).toBe(true));
      rebuiltTimers.find((timer) => !timer.cancelled)!.callback();
      await vi.waitFor(() =>
        expect(
          rebuiltHandles
            .flatMap((candidate) => candidate.requests)
            .filter((request) => request.method === 'turn/start'),
        ).toHaveLength(1),
      );
      const database = new DatabaseSync(join(fixture.dataDir, 'relay.sqlite'));
      const failures = database
        .prepare(
          "SELECT count(*) AS count FROM session_events WHERE type = 'org-plan.checkpoint-handoff-failed'",
        )
        .get() as { count: number };
      const interaction = database
        .prepare('SELECT outcome FROM pending_interactions WHERE session_id = ? AND request_id = ?')
        .get(fixture.sessionId, '997') as { outcome: string | null };
      database.close();
      expect(failures.count).toBe(1);
      expect(interaction.outcome).toBe('failed');
      expect(rebuiltCoordinator!.snapshot(fixture.sessionId).health).toMatchObject({
        phase: expect.not.stringMatching('checkpointRecovery'),
      });
      await rebuilt.close();
    });

    it.each([
      'resultWritten-before-timeout',
      'timeout-before-late-resultWritten',
      'writeFailed',
      'duplicate-settlement',
    ])('settles checkpoint write/deadline races exactly once: %s', async (scenario) => {
      const timers: Array<{ callback: () => void; cancelled: boolean }> = [];
      const fixture = await createProductionAutopilotFixture({
        checkpointHandoffDeadlineMs: 200,
        autopilotSchedule: (callback) => {
          const timer = { callback, cancelled: false };
          timers.push(timer);
          return () => {
            timer.cancelled = true;
          };
        },
      });
      const { handle, response, startsBefore, writersBefore } = await holdCheckpointRequest(
        fixture,
        timers,
        992,
      );
      const starts = () =>
        fixture.handles
          .flatMap((candidate) => candidate.requests)
          .filter((request) => request.method === 'turn/start').length;
      const failures = () => {
        const database = new DatabaseSync(join(fixture.dataDir, 'relay.sqlite'));
        const count = database
          .prepare(
            "SELECT count(*) AS count FROM session_events WHERE type = 'org-plan.checkpoint-handoff-failed'",
          )
          .get() as { count: number };
        database.close();
        return count.count;
      };
      if (scenario === 'resultWritten-before-timeout') {
        handle.responseSettled!({ id: 992, outcome: 'resultWritten' });
        await expect(response).resolves.toEqual(toOrgPlanCheckpointToolResponse());
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(fixture.handles).toHaveLength(writersBefore);
        expect(failures()).toBe(0);
      } else if (scenario === 'duplicate-settlement') {
        handle.responseSettled!({ id: 992, outcome: 'resultWritten' });
        handle.responseSettled!({ id: 992, outcome: 'resultWritten' });
        await expect(response).resolves.toEqual(toOrgPlanCheckpointToolResponse());
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(fixture.handles).toHaveLength(writersBefore);
        expect(failures()).toBe(0);
      } else {
        if (scenario === 'writeFailed')
          handle.responseSettled!({ id: 992, outcome: 'writeFailed' });
        const lateSettlement = handle.responseSettled;
        await expect(response).rejects.toThrow('CODEX_SERVER_REQUEST_CANCELLED');
        await vi.waitFor(() => expect(fixture.handles.length).toBeGreaterThan(writersBefore), {
          timeout: 1_000,
        });
        if (scenario === 'timeout-before-late-resultWritten')
          lateSettlement!({ id: 992, outcome: 'resultWritten' });
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(failures()).toBe(1);
      }
      expect(starts()).toBe(startsBefore);
      await fixture.app.close();
    });

    it('does not apply checkpoint deadlines to quiz or approval requests', async () => {
      const checkpointFailures = (dataDir: string) => {
        const database = new DatabaseSync(join(dataDir, 'relay.sqlite'));
        const count = database
          .prepare(
            "SELECT count(*) AS count FROM session_events WHERE type = 'org-plan.checkpoint-handoff-failed'",
          )
          .get() as { count: number };
        database.close();
        return count.count;
      };
      const fixture = await createProductionAutopilotFixture({ checkpointHandoffDeadlineMs: 1 });
      const handle = fixture.handles.find((candidate) => candidate.request)!;
      const started = await fixture.app.inject({
        method: 'POST',
        url: `/api/sessions/${fixture.sessionId}/turns`,
        payload: { text: 'request user input' },
      });
      expect(started.statusCode).toBe(202);
      await vi.waitFor(() => expect(handle.request).toBeDefined());
      handle.notify!({
        method: 'turn/started',
        params: {
          threadId: (await fixture.app.inject(`/api/sessions/${fixture.sessionId}`)).json()
            .threadId,
          turn: { id: started.json().activeTurnId },
        },
      });
      handle.deferResponseSettlement = true;
      const quizWriters = fixture.handles.length;
      const quiz = handle.request!({
        id: 993,
        method: 'item/tool/call',
        params: {
          tool: 'gestalt_quiz',
          arguments: {
            questions: [
              {
                id: 'mode',
                header: 'Mode',
                question: 'Choose a mode.',
                choices: [
                  { label: 'Solo', description: 'Use one agent.' },
                  { label: 'Team', description: 'Use several agents.' },
                ],
                allowCustom: false,
              },
            ],
          },
        },
      });
      await vi.waitFor(async () =>
        expect(
          (await fixture.app.inject(`/api/sessions/${fixture.sessionId}/history`)).json()
            .interactions,
        ).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ requestId: '993', kind: 'quiz', resolvedAt: null }),
          ]),
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(fixture.handles).toHaveLength(quizWriters);
      expect(checkpointFailures(fixture.dataDir)).toBe(0);
      expect(handle.pendingResponses).toHaveLength(0);
      expect(
        (await fixture.app.inject(`/api/sessions/${fixture.sessionId}/history`)).json()
          .interactions,
      ).toEqual(
        expect.arrayContaining([expect.objectContaining({ requestId: '993', resolvedAt: null })]),
      );
      const quizSubmission = fixture.app.inject({
        method: 'POST',
        url: `/api/sessions/${fixture.sessionId}/interactions/993`,
        payload: {
          success: true,
          contentItems: [{ type: 'inputText', text: '{"answers":{"mode":"Solo"}}' }],
        },
      });
      await vi.waitFor(() => {
        expect(handle.pendingResponses.has(993)).toBe(true);
      });
      handle.responseSettled!({ id: 993, outcome: 'resultWritten' });
      expect((await quizSubmission).statusCode).toBe(202);
      await expect(quiz).resolves.toEqual(expect.anything());
      expect(fixture.handles).toHaveLength(quizWriters);
      await fixture.app.close();

      const approvalFixture = await createProductionAutopilotFixture({
        checkpointHandoffDeadlineMs: 1,
      });
      const approvalHandle = approvalFixture.handles.find((candidate) => candidate.request)!;
      const approvalTurn = await approvalFixture.app.inject({
        method: 'POST',
        url: `/api/sessions/${approvalFixture.sessionId}/turns`,
        payload: { text: 'approve' },
      });
      await vi.waitFor(() => expect(approvalHandle.request).toBeDefined());
      approvalHandle.notify!({
        method: 'turn/started',
        params: {
          threadId: (
            await approvalFixture.app.inject(`/api/sessions/${approvalFixture.sessionId}`)
          ).json().threadId,
          turn: { id: approvalTurn.json().activeTurnId },
        },
      });
      approvalHandle.deferResponseSettlement = true;
      const approvalWriters = approvalFixture.handles.length;
      const approval = approvalHandle.request!({
        id: 994,
        method: 'item/commandExecution/requestApproval',
        params: { command: 'git status' },
      });
      await vi.waitFor(async () =>
        expect(
          (
            await approvalFixture.app.inject(`/api/sessions/${approvalFixture.sessionId}/history`)
          ).json().interactions,
        ).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              requestId: '994',
              kind: 'commandApproval',
              resolvedAt: null,
            }),
          ]),
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(approvalFixture.handles).toHaveLength(approvalWriters);
      expect(checkpointFailures(approvalFixture.dataDir)).toBe(0);
      expect(
        (
          await approvalFixture.app.inject(`/api/sessions/${approvalFixture.sessionId}/history`)
        ).json().interactions,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ requestId: '994', kind: 'commandApproval', resolvedAt: null }),
        ]),
      );
      const approvalSubmission = approvalFixture.app.inject({
        method: 'POST',
        url: `/api/sessions/${approvalFixture.sessionId}/interactions/994`,
        payload: { decision: 'accept' },
      });
      await vi.waitFor(() => expect(approvalHandle.pendingResponses.has(994)).toBe(true));
      approvalHandle.responseSettled!({ id: 994, outcome: 'resultWritten' });
      expect((await approvalSubmission).statusCode).toBe(202);
      await expect(approval).resolves.toEqual(expect.anything());
      expect(approvalTurn.statusCode).toBe(202);
      await approvalFixture.app.close();
    });

    it('rejects a checkpoint delivered after its owning root final has closed', async () => {
      const timers: Array<{ callback: () => void; cancelled: boolean }> = [];
      const fixture = await createProductionAutopilotFixture({
        autopilotSchedule: (callback) => {
          const timer = { callback, cancelled: false };
          timers.push(timer);
          return () => {
            timer.cancelled = true;
          };
        },
      });
      const first = timers[0]!;
      first.callback();
      await vi.waitFor(() =>
        expect(
          fixture.handles
            .flatMap((handle) => handle.requests)
            .filter((request) => request.method === 'turn/start'),
        ).toHaveLength(1),
      );
      const database = new DatabaseSync(join(fixture.dataDir, 'relay.sqlite'));
      const active = database
        .prepare('SELECT active_turn_id FROM relay_sessions WHERE id = ?')
        .get(fixture.sessionId) as { active_turn_id: string };
      database.close();
      const handle = fixture.handles.find((candidate) => candidate.notify && candidate.request)!;
      const threadId = (await fixture.app.inject(`/api/sessions/${fixture.sessionId}`)).json()
        .threadId as string;
      handle.notify!({
        method: 'turn/completed',
        params: { threadId, turn: { id: active.active_turn_id } },
      });
      await expect
        .poll(
          async () =>
            (await fixture.app.inject(`/api/sessions/${fixture.sessionId}`)).json().activeTurnId,
        )
        .toBeNull();
      const timersAfterFinal = timers.length;
      const startsAfterFinal = fixture.handles
        .flatMap((candidate) => candidate.requests)
        .filter((request) => request.method === 'turn/start').length;
      const planIdentity = createHash('sha256')
        .update(join(fixture.workspacePath, 'autopilot.org'))
        .digest('hex');
      await expect(
        handle.request!(l2CheckpointCall(812, threadId, active.active_turn_id, planIdentity)),
      ).rejects.toThrow('CODEX_SERVER_REQUEST_UNSUPPORTED');
      expect(timers).toHaveLength(timersAfterFinal);
      expect(
        fixture.handles
          .flatMap((candidate) => candidate.requests)
          .filter((request) => request.method === 'turn/start'),
      ).toHaveLength(startsAfterFinal);
      await fixture.app.close();
    });

    it('production attention request requires explicit re-enable and a complete plan transitions to completed', async () => {
      const fixture = await createProductionAutopilotFixture();
      const handle = fixture.handles.find((candidate) => candidate.request)!;
      expect(
        (
          await fixture.app.inject({
            method: 'PUT',
            url: `/api/sessions/${fixture.sessionId}/autopilot`,
            payload: { enabled: true },
          })
        ).statusCode,
      ).toBe(200);
      const attention = handle.request!(attentionCall(810));
      await vi.waitFor(async () =>
        expect(
          (await fixture.app.inject(`/api/sessions/${fixture.sessionId}`)).json(),
        ).toMatchObject({
          autopilot: { state: 'attentionRequired', enabled: false, reason: 'attentionRequired' },
        }),
      );
      expect(fixture.handles.flatMap((candidate) => candidate.calls)).not.toContain('turn/start');
      expect(
        (
          await fixture.app.inject({
            method: 'POST',
            url: `/api/sessions/${fixture.sessionId}/attention/810/resolve`,
            payload: { operationKey: 'resume-attention', action: 'resume' },
          })
        ).statusCode,
      ).toBe(202);
      await expect(attention).resolves.toEqual(
        toOrgPlanAttentionToolResponse({ action: 'resume' }),
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect((await fixture.app.inject(`/api/sessions/${fixture.sessionId}`)).json()).toMatchObject(
        {
          autopilot: { state: 'attentionRequired', enabled: false },
        },
      );
      expect(
        (
          await fixture.app.inject({
            method: 'PUT',
            url: `/api/sessions/${fixture.sessionId}/autopilot`,
            payload: { enabled: true },
          })
        ).statusCode,
      ).toBe(200);
      await vi.waitFor(async () =>
        expect(
          (await fixture.app.inject(`/api/sessions/${fixture.sessionId}`)).json(),
        ).toMatchObject({
          autopilot: { enabled: true, state: expect.stringMatching(/monitoring|backoff/) },
        }),
      );

      await writeFile(join(fixture.workspacePath, 'autopilot.org'), completedAutopilotPlanText());
      await expect
        .poll(
          async () =>
            (await fixture.app.inject(`/api/sessions/${fixture.sessionId}/plan`)).json()
              .executionComplete,
        )
        .toBe(true);
      await vi.waitFor(async () =>
        expect(
          (await fixture.app.inject(`/api/sessions/${fixture.sessionId}`)).json(),
        ).toMatchObject({
          autopilot: { state: 'completed', enabled: false, reason: 'planComplete' },
        }),
      );
      await fixture.app.close();
    });

    it('production plan removal, replacement, and session termination cancel queued continuations', async () => {
      for (const action of ['close', 'replace', 'stop', 'release', 'delete'] as const) {
        const timers: Array<{ callback: () => void; cancelled: boolean }> = [];
        const fixture = await createProductionAutopilotFixture({
          autopilotSchedule: (callback) => {
            const timer = { callback, cancelled: false };
            timers.push(timer);
            return () => {
              timer.cancelled = true;
            };
          },
        });
        expect(
          (
            await fixture.app.inject({
              method: 'PUT',
              url: `/api/sessions/${fixture.sessionId}/autopilot`,
              payload: { enabled: true },
            })
          ).statusCode,
        ).toBe(200);
        // Initial supervision schedules its control and keeps a separate,
        // bounded reconciliation watchdog while activity is still stale.
        await vi.waitFor(() => expect(timers).toHaveLength(2));
        const staleTimer = timers[0];
        if (action === 'close') {
          await writeFile(
            join(fixture.workspacePath, 'autopilot.org'),
            completedAutopilotPlanText(),
          );
          await expect
            .poll(
              async () =>
                (await fixture.app.inject(`/api/sessions/${fixture.sessionId}/plan`)).json()
                  .allDone,
            )
            .toBe(true);
          expect(
            (
              await fixture.app.inject({
                method: 'DELETE',
                url: `/api/sessions/${fixture.sessionId}/plan`,
              })
            ).statusCode,
          ).toBe(204);
        } else if (action === 'replace') {
          await installAutopilotPlan(
            fixture.app,
            fixture.sessionId,
            fixture.workspacePath,
            'replacement',
          );
        } else {
          const method = action === 'delete' ? 'DELETE' : 'POST';
          const suffix = action === 'delete' ? '' : `/${action}`;
          expect(
            (
              await fixture.app.inject({
                method,
                url: `/api/sessions/${fixture.sessionId}${suffix}`,
              })
            ).statusCode,
          ).toBeGreaterThanOrEqual(200);
        }
        if (action === 'delete') {
          const database = new DatabaseSync(join(fixture.dataDir, 'relay.sqlite'));
          const row = database
            .prepare(
              'SELECT state, requested_enabled, stop_reason FROM autopilot_sessions WHERE session_id = ?',
            )
            .get(fixture.sessionId) as {
            state: string;
            requested_enabled: number;
            stop_reason: string;
          };
          database.close();
          // Forgetting cascades the terminal row with the session itself; the
          // absence is the durable proof that no queued control can be reopened.
          expect(row).toBeUndefined();
        } else if (action === 'replace') {
          await vi.waitFor(() => expect(staleTimer.cancelled).toBe(true));
          await vi.waitFor(async () =>
            expect(
              (await fixture.app.inject(`/api/sessions/${fixture.sessionId}`)).json(),
            ).toMatchObject({
              autopilot: { enabled: true, state: expect.stringMatching(/monitoring|backoff/) },
            }),
          );
        } else {
          await vi.waitFor(async () =>
            expect(
              (await fixture.app.inject(`/api/sessions/${fixture.sessionId}`)).json(),
            ).toMatchObject({
              autopilot: {
                enabled: false,
                state: 'disabled',
                reason: action === 'close' ? 'planRemoved' : 'sessionEnded',
              },
            }),
          );
        }
        expect(staleTimer.cancelled, action).toBe(true);
        staleTimer.callback();
        await Promise.resolve();
        expect(fixture.handles.flatMap((candidate) => candidate.calls)).not.toContain('turn/start');
        await fixture.app.close();
      }
    }, 15_000);

    it('production duplicate and missing completion notifications coalesce without double control', async () => {
      const timers: Array<{
        callback: () => void;
        cancelled: boolean;
        fired: boolean;
      }> = [];
      const fixture = await createProductionAutopilotFixture({
        autopilotSchedule: (callback) => {
          const timer = { callback, cancelled: false, fired: false };
          timers.push(timer);
          return () => {
            timer.cancelled = true;
          };
        },
      });
      const runNextTimer = async () => {
        let timer: (typeof timers)[number] | undefined;
        await vi.waitFor(() => {
          timer = timers.find((candidate) => !candidate.cancelled && !candidate.fired);
          expect(timer).toBeDefined();
        });
        timer!.fired = true;
        timer!.callback();
      };
      const response = await fixture.app.inject({
        method: 'PUT',
        url: `/api/sessions/${fixture.sessionId}/autopilot`,
        payload: { enabled: true },
      });
      expect(response.statusCode).toBe(200);
      await runNextTimer();
      await vi.waitFor(
        () =>
          expect(
            fixture.handles
              .flatMap((handle) => handle.calls)
              .filter((call) => call === 'turn/start'),
          ).toHaveLength(1),
        { timeout: 2_500 },
      );
      const database = new DatabaseSync(join(fixture.dataDir, 'relay.sqlite'));
      const active = database
        .prepare('SELECT active_turn_id FROM relay_sessions WHERE id = ?')
        .get(fixture.sessionId) as { active_turn_id: string };
      database.close();
      const handle = fixture.handles.find((candidate) => candidate.notify);
      expect(handle?.notify).toBeDefined();
      const completion = {
        method: 'turn/completed',
        params: { turn: { id: active.active_turn_id } },
      };
      handle!.notify!(completion);
      handle!.notify!(completion);
      await vi.waitFor(() =>
        expect(timers.filter((timer) => !timer.cancelled && !timer.fired)).toHaveLength(1),
      );
      await runNextTimer();
      await runNextTimer();
      await vi.waitFor(
        () =>
          expect(
            fixture.handles
              .flatMap((candidate) => candidate.calls)
              .filter((call) => call === 'turn/start'),
          ).toHaveLength(2),
        { timeout: 3_500 },
      );
      const controlsDatabase = new DatabaseSync(join(fixture.dataDir, 'relay.sqlite'));
      const controls = controlsDatabase
        .prepare('SELECT control_id FROM autopilot_controls WHERE session_id = ?')
        .all(fixture.sessionId) as Array<{ control_id: string }>;
      controlsDatabase.close();
      expect(new Set(controls.map((control) => control.control_id)).size).toBe(controls.length);
      expect(controls).toHaveLength(2);
      await fixture.app.close();
    });

    it('production child-idle transition wakes an idle supervised autopilot', async () => {
      const timers: Array<{ callback: () => void; cancelled: boolean; fired: boolean }> = [];
      const fixture = await createProductionAutopilotFixture({
        autopilotActivity: (sessionId) => {
          const observedAt = new Date().toISOString();
          return {
            sessionId,
            rootThreadId: 'thread-1',
            root: {
              state: 'idle',
              reason: 'turnCompleted',
              observedAt,
              lastActivityAt: observedAt,
            },
            subagents: [
              {
                id: 'child-1',
                threadId: 'child-1',
                taskPath: '/root/l1',
                canonicalTaskName: 'l1',
                canonicalPosition: 'L1',
                continuationGeneration: 1,
                outcome: 'partial',
                ownedProcesses: [],
                state: 'idle',
                reason: 'turnCompleted',
                observedAt,
                lastActivityAt: observedAt,
              },
            ],
            aggregateSubagents: 'idle',
            confidence: 'fresh',
          };
        },
        autopilotSchedule: (callback) => {
          const timer = { callback, cancelled: false, fired: false };
          timers.push(timer);
          return () => {
            timer.cancelled = true;
          };
        },
      });
      expect(
        (
          await fixture.app.inject({
            method: 'PUT',
            url: `/api/sessions/${fixture.sessionId}/autopilot`,
            payload: { enabled: false },
          })
        ).statusCode,
      ).toBe(200);
      timers.length = 0;
      expect(
        (
          await fixture.app.inject({
            method: 'PUT',
            url: `/api/sessions/${fixture.sessionId}/autopilot`,
            payload: { enabled: true },
          })
        ).statusCode,
      ).toBe(200);
      expect(timers.filter((timer) => !timer.cancelled && !timer.fired)).toHaveLength(1);
      const timer = timers.find((candidate) => !candidate.cancelled && !candidate.fired)!;
      timer.fired = true;
      timer.callback();
      await vi.waitFor(() =>
        expect(
          fixture.handles.flatMap((candidate) =>
            candidate.requests.filter((call) => call.method === 'turn/start'),
          ),
        ).toHaveLength(1),
      );
      expect(
        fixture.handles.flatMap((candidate) =>
          candidate.requests.filter((call) => call.method === 'turn/start'),
        )[0]?.params,
      ).toMatchObject({ threadId: 'child-1' });
      await fixture.app.close();
    });

    it('production treats only a confirmed missing rollout as an executor rejection and starts one fenced replacement', async () => {
      const timers: Array<{ callback: () => void; cancelled: boolean; fired: boolean }> = [];
      const fixture = await createProductionAutopilotFixture({
        autopilotActivity: (sessionId) => {
          const observedAt = new Date().toISOString();
          return {
            sessionId,
            rootThreadId: 'thread-1',
            root: {
              state: 'idle',
              reason: 'turnCompleted',
              observedAt,
              lastActivityAt: observedAt,
            },
            subagents: [
              {
                id: 'child-1',
                threadId: 'child-1',
                taskPath: '/root/l1',
                canonicalTaskName: 'l1',
                canonicalPosition: 'L1',
                continuationGeneration: 1,
                outcome: 'partial',
                ownedProcesses: [],
                state: 'idle',
                reason: 'turnCompleted',
                observedAt,
                lastActivityAt: observedAt,
              },
            ],
            aggregateSubagents: 'idle',
            confidence: 'fresh',
          };
        },
        autopilotSchedule: (callback) => {
          const timer = { callback, cancelled: false, fired: false };
          timers.push(timer);
          return () => {
            timer.cancelled = true;
          };
        },
      });
      // Session setup may have used a retired writer; apply the failure seam to
      // every live writer that can own the executor continuation.
      for (const handle of fixture.handles)
        handle.respond = (method, params) => {
          if (method === 'turn/start' && (params as { threadId?: string }).threadId === 'child-1')
            throw new CodexJsonRpcError(-32600, 'no rollout found for thread id child-1');
          return undefined;
        };
      const fireNext = async () => {
        await vi.waitFor(() =>
          expect(timers.some((candidate) => !candidate.cancelled && !candidate.fired)).toBe(true),
        );
        const timer = timers.find((candidate) => !candidate.cancelled && !candidate.fired);
        expect(timer).toBeDefined();
        timer!.fired = true;
        timer!.callback();
        await Promise.resolve();
        await Promise.resolve();
      };

      expect(
        (
          await fixture.app.inject({
            method: 'PUT',
            url: `/api/sessions/${fixture.sessionId}/autopilot`,
            payload: { enabled: true },
          })
        ).statusCode,
      ).toBe(200);
      // Three confirmed rejections consume the bounded executor retry budget;
      // the fourth scheduled control is the root-owned physical g2 handoff.
      await fireNext();
      await fireNext();
      await fireNext();
      await fireNext();
      await fireNext();
      await fireNext();
      await fireNext();
      await vi.waitFor(() =>
        expect(
          fixture.handles.flatMap((candidate) =>
            candidate.requests.filter((request) => request.method === 'turn/start'),
          ),
        ).toHaveLength(4),
      );
      const starts = fixture.handles.flatMap((candidate) =>
        candidate.requests.filter((request) => request.method === 'turn/start'),
      );
      expect(starts.slice(0, 3).map((request) => request.params)).toEqual(
        Array.from({ length: 3 }, () => expect.objectContaining({ threadId: 'child-1' })),
      );
      // The root control may reacquire a new app-server writer after the
      // rejected child continuation; it must never target the dead child.
      expect((starts[3]?.params as { threadId?: string }).threadId).not.toBe('child-1');
      expect(
        (starts[3]?.params as { input?: Array<{ text?: string }> }).input?.[0]?.text,
      ).toContain('Launch task_name l1_g2 for canonical L1');
      expect(
        (starts[3]?.params as { input?: Array<{ text?: string }> }).input?.[0]?.text,
      ).toContain('explicit model selected by the supervisor');
      // Capacity recovery is allowed only for the active root control. It
      // recycles that writer but must retain the one durable g2 handoff.
      const rootHandle = fixture.handles.find((candidate) =>
        candidate.requests.some(
          (request) =>
            request.method === 'turn/start' &&
            (request.params as { threadId?: string }).threadId !== 'child-1',
        ),
      )!;
      const active = (await fixture.app.inject(`/api/sessions/${fixture.sessionId}`)).json();
      const writersBeforeRecovery = fixture.handles.length;
      await expect(
        rootHandle.request!({
          id: 992,
          method: 'item/tool/call',
          params: {
            threadId: active.threadId,
            turnId: active.activeTurnId,
            tool: 'gestalt_agent_capacity_recovery',
            arguments: { version: 1, reason: 'agentThreadLimit' },
          },
        }),
      ).resolves.toMatchObject({ success: true });
      await expect.poll(() => fixture.handles.length).toBeGreaterThan(writersBeforeRecovery);
      expect(
        fixture.handles
          .flatMap((candidate) => candidate.requests)
          .filter((request) => request.method === 'turn/start')
          .map(
            (request) => (request.params as { input?: Array<{ text?: string }> }).input?.[0]?.text,
          ),
      ).not.toContain(expect.stringContaining('l1_g3'));
      const database = new DatabaseSync(join(fixture.dataDir, 'relay.sqlite'));
      const lifecycle = database
        .prepare('SELECT lifecycle_json FROM autopilot_sessions WHERE session_id = ?')
        .get(fixture.sessionId) as { lifecycle_json: string };
      const replacements = database
        .prepare(
          "SELECT count(*) AS count FROM session_events WHERE session_id = ? AND type = 'autopilot.executor-replacement-scheduled'",
        )
        .get(fixture.sessionId) as { count: number };
      database.close();
      expect(JSON.parse(lifecycle.lifecycle_json)).toMatchObject({
        executor: {
          replacement: { taskName: 'l1_g2', canonicalTaskName: 'l1', generation: 2 },
          commands: expect.arrayContaining([
            expect.objectContaining({ status: 'failed', threadId: 'child-1' }),
          ]),
        },
      });
      expect(replacements.count).toBe(1);
      await fixture.app.close();
    });

    it('production leaves a transport-lost executor command issued and never replays it as a replacement', async () => {
      const timers: Array<{ callback: () => void; cancelled: boolean; fired: boolean }> = [];
      const fixture = await createProductionAutopilotFixture({
        autopilotActivity: (sessionId) => {
          const observedAt = new Date().toISOString();
          return {
            sessionId,
            rootThreadId: 'thread-1',
            root: {
              state: 'idle',
              reason: 'turnCompleted',
              observedAt,
              lastActivityAt: observedAt,
            },
            subagents: [
              {
                id: 'child-1',
                threadId: 'child-1',
                taskPath: '/root/l1',
                canonicalTaskName: 'l1',
                canonicalPosition: 'L1',
                continuationGeneration: 1,
                outcome: 'partial',
                ownedProcesses: [],
                state: 'idle',
                reason: 'turnCompleted',
                observedAt,
                lastActivityAt: observedAt,
              },
            ],
            aggregateSubagents: 'idle',
            confidence: 'fresh',
          };
        },
        autopilotSchedule: (callback) => {
          const timer = { callback, cancelled: false, fired: false };
          timers.push(timer);
          return () => {
            timer.cancelled = true;
          };
        },
      });
      for (const handle of fixture.handles)
        handle.respond = (method, params) => {
          if (method === 'turn/start' && (params as { threadId?: string }).threadId === 'child-1')
            throw new Error('transport dropped after request write');
          return undefined;
        };
      expect(
        (
          await fixture.app.inject({
            method: 'PUT',
            url: `/api/sessions/${fixture.sessionId}/autopilot`,
            payload: { enabled: true },
          })
        ).statusCode,
      ).toBe(200);
      const timer = timers.find((candidate) => !candidate.cancelled && !candidate.fired)!;
      timer.fired = true;
      timer.callback();
      await vi.waitFor(() =>
        expect(
          fixture.handles
            .flatMap((candidate) => candidate.requests)
            .filter((request) => request.method === 'turn/start'),
        ).toHaveLength(1),
      );
      // Drive the bounded reinspection once: the durable issued command blocks replay.
      const refresh = timers.find((candidate) => !candidate.cancelled && !candidate.fired)!;
      refresh.fired = true;
      refresh.callback();
      await Promise.resolve();
      await Promise.resolve();
      const database = new DatabaseSync(join(fixture.dataDir, 'relay.sqlite'));
      const lifecycle = database
        .prepare('SELECT lifecycle_json FROM autopilot_sessions WHERE session_id = ?')
        .get(fixture.sessionId) as { lifecycle_json: string };
      const replacements = database
        .prepare(
          "SELECT count(*) AS count FROM session_events WHERE session_id = ? AND type = 'autopilot.executor-replacement-scheduled'",
        )
        .get(fixture.sessionId) as { count: number };
      database.close();
      expect(JSON.parse(lifecycle.lifecycle_json)).toMatchObject({
        executor: {
          commands: [expect.objectContaining({ status: 'issued', threadId: 'child-1' })],
        },
      });
      expect(replacements.count).toBe(0);
      expect(
        fixture.handles
          .flatMap((candidate) => candidate.requests)
          .filter((request) => request.method === 'turn/start'),
      ).toHaveLength(1);
      await fixture.app.close();
    });

    it('production blocked child wakes the idle supervisor for bounded recovery', async () => {
      const timers: Array<{ callback: () => void; cancelled: boolean; fired: boolean }> = [];
      const fixture = await createProductionAutopilotFixture({
        autopilotSchedule: (callback) => {
          const timer = { callback, cancelled: false, fired: false };
          timers.push(timer);
          return () => {
            timer.cancelled = true;
          };
        },
      });
      expect(
        (
          await fixture.app.inject({
            method: 'PUT',
            url: `/api/sessions/${fixture.sessionId}/autopilot`,
            payload: { enabled: false },
          })
        ).statusCode,
      ).toBe(200);
      timers.length = 0;
      const handle = fixture.handles.find((candidate) => candidate.notify)!;
      handle.notify!({
        method: 'thread/started',
        params: { thread: { id: 'thread-1', status: { type: 'idle' } } },
      });
      handle.notify!({
        method: 'item/started',
        params: {
          item: {
            type: 'collabToolCall',
            tool: 'spawn_agent',
            status: 'inProgress',
            senderThreadId: 'thread-1',
            receiverThreadId: 'child-1',
            agentStatus: 'working',
          },
        },
      });
      expect(
        (
          await fixture.app.inject({
            method: 'PUT',
            url: `/api/sessions/${fixture.sessionId}/autopilot`,
            payload: { enabled: true },
          })
        ).statusCode,
      ).toBe(200);
      expect(timers).toHaveLength(0);

      handle.notify!({
        method: 'item/completed',
        params: {
          item: {
            type: 'collabToolCall',
            tool: 'wait',
            status: 'failed',
            senderThreadId: 'thread-1',
            receiverThreadId: 'child-1',
            agentStatus: 'failed',
          },
        },
      });

      const quietTimer = timers.find((timer) => !timer.cancelled && !timer.fired);
      expect(quietTimer).toBeDefined();
      quietTimer!.fired = true;
      quietTimer!.callback();
      await vi.waitFor(() =>
        expect(timers.find((timer) => !timer.cancelled && !timer.fired)).toBeDefined(),
      );
      const continuationTimer = timers.find((timer) => !timer.cancelled && !timer.fired);
      continuationTimer!.fired = true;
      continuationTimer!.callback();
      await vi.waitFor(() =>
        expect(
          fixture.handles
            .flatMap((candidate) => candidate.calls)
            .filter((call) => call === 'turn/start'),
        ).toHaveLength(1),
      );
      await fixture.app.close();
    });

    it('production incompatible reconcile remains supervised and schedules reinspection', async () => {
      let reconciliations = 0;
      const timers: Array<() => void> = [];
      const fixture = await createProductionAutopilotFixture({
        autopilotActivity: () => null,
        autopilotReconcile: async () => {
          reconciliations += 1;
          return { compatible: false };
        },
        autopilotSchedule: (callback) => {
          timers.push(callback);
          return () => undefined;
        },
      });
      expect(
        (
          await fixture.app.inject({
            method: 'PUT',
            url: `/api/sessions/${fixture.sessionId}/autopilot`,
            payload: { enabled: true },
          })
        ).statusCode,
      ).toBe(200);
      await vi.waitFor(async () =>
        expect(
          (await fixture.app.inject(`/api/sessions/${fixture.sessionId}`)).json(),
        ).toMatchObject({
          autopilot: { state: 'monitoring', enabled: true, reason: 'reconcileFailed' },
        }),
      );
      const stableReconciliations = reconciliations;
      const stableTimers = timers.length;
      expect(stableTimers).toBeGreaterThan(0);
      await timers.at(-1)?.();
      await vi.waitFor(() => expect(reconciliations).toBeGreaterThan(stableReconciliations));
      expect(timers.length).toBeGreaterThanOrEqual(stableTimers);
      await fixture.app.close();
    });

    it('production post-acceptance fault recovers one accepted control without a second turn or audit', async () => {
      let coordinator:
        import('./features/autopilot/application/service.js').AutopilotCoordinator | undefined;
      const fixture = await createProductionAutopilotFixture({
        autopilotAfterTurnAccepted: () => {
          throw new Error('fault after durable app-server acceptance');
        },
        onAutopilotCoordinator: (value) => {
          coordinator = value;
        },
      });
      const response = await fixture.app.inject({
        method: 'PUT',
        url: `/api/sessions/${fixture.sessionId}/autopilot`,
        payload: { enabled: true },
      });
      expect(response.statusCode).toBe(200);
      await vi.waitFor(
        () =>
          expect(
            fixture.handles
              .flatMap((handle) => handle.calls)
              .filter((call) => call === 'turn/start'),
          ).toHaveLength(1),
        { timeout: 2_500 },
      );
      const database = new DatabaseSync(join(fixture.dataDir, 'relay.sqlite'));
      const control = database
        .prepare(
          "SELECT status, turn_id FROM autopilot_controls WHERE session_id = ? AND status = 'started'",
        )
        .get(fixture.sessionId) as { status: string; turn_id: string };
      const startedAudits = database
        .prepare(
          "SELECT count(*) AS count FROM session_events WHERE session_id = ? AND type = 'autopilot.turn-started'",
        )
        .get(fixture.sessionId) as { count: number };
      const failedAudits = database
        .prepare(
          "SELECT count(*) AS count FROM session_events WHERE session_id = ? AND type = 'autopilot.turn-failed'",
        )
        .get(fixture.sessionId) as { count: number };
      database.close();
      expect(control).toMatchObject({ status: 'started', turn_id: expect.any(String) });
      expect(startedAudits.count).toBe(1);
      expect(failedAudits.count).toBe(0);
      // Rehydrate from the same durable store after the post-acceptance fault;
      // the active turn fences replay and the outbox preserves one audit identity.
      coordinator!.restore(fixture.sessionId);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(
        fixture.handles.flatMap((handle) => handle.calls).filter((call) => call === 'turn/start'),
      ).toHaveLength(1);
      const reopened = new DatabaseSync(join(fixture.dataDir, 'relay.sqlite'));
      expect(
        reopened
          .prepare(
            "SELECT count(*) AS count FROM session_events WHERE session_id = ? AND type = 'autopilot.turn-started'",
          )
          .get(fixture.sessionId),
      ).toMatchObject({ count: 1 });
      reopened.close();
      await fixture.app.close();
    });
    it('production pre-acceptance runtime failure durably records one failed control and does not create a started audit', async () => {
      const fixture = await createProductionAutopilotFixture({
        autopilotBeforeTurnAccepted: () => {
          throw new Error('temporary runtime transport failure');
        },
      });
      expect(
        (
          await fixture.app.inject({
            method: 'PUT',
            url: `/api/sessions/${fixture.sessionId}/autopilot`,
            payload: { enabled: true },
          })
        ).statusCode,
      ).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const database = new DatabaseSync(join(fixture.dataDir, 'relay.sqlite'));
      const failed = database
        .prepare(
          "SELECT count(*) AS count FROM autopilot_controls WHERE session_id = ? AND status = 'failed'",
        )
        .get(fixture.sessionId) as { count: number };
      const started = database
        .prepare(
          "SELECT count(*) AS count FROM session_events WHERE session_id = ? AND type = 'autopilot.turn-started'",
        )
        .get(fixture.sessionId) as { count: number };
      const failedAudits = database
        .prepare(
          "SELECT count(*) AS count FROM session_events WHERE session_id = ? AND type = 'autopilot.turn-failed'",
        )
        .get(fixture.sessionId) as { count: number };
      database.close();
      expect(failed.count).toBe(1);
      expect(failedAudits.count).toBe(1);
      expect(started.count).toBe(0);
      await fixture.app.close();
    });
  });

  describeCompositionConcern('attention', () => {
    it('publishes isolated typed required, resolved, and failed attention transitions through the feature-only seam', async () => {
      const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-root-'));
      const dataDir = await mkdtemp(join(tmpdir(), 'gestalt-mobile-state-'));
      ownTemporaryPaths(root, dataDir);
      await mkdir(join(root, 'workspace'));
      const handles: LiveServerHandle[] = [];
      let transitions:
        | import('./features/org-plan-attention/application/ports.js').OrgPlanAttentionTransitions
        | undefined;
      const app = await composeAuthorizedApp({
        root,
        dataDir,
        relyingParty,
        installedCodexVersion: 'codex-cli 0.144.3',
        startAppServers: true,
        launchAppServer: liveAppServer(handles),
        profiles: {
          list: async () => [],
          require: async () => ({
            name: 'default',
            state: 'ok' as const,
            status: 'ready' as const,
          }),
        },
        onAttentionTransitions: (port) => {
          transitions = port;
        },
      });
      expect(transitions).toBeDefined();
      const sessionA = await createComposedSession(app);
      const sessionB = await createComposedSession(app);
      const handleA = await vi.waitFor(() => {
        const handle = handles.find((candidate) => candidate.calls.includes('thread/start'));
        expect(handle?.request).toBeDefined();
        return handle!;
      });
      const handleB = await vi.waitFor(() => {
        const started = handles.filter((candidate) => candidate.calls.includes('thread/start'));
        expect(started).toHaveLength(2);
        expect(started[1]?.request).toBeDefined();
        return started[1]!;
      });
      const receivedA: Array<{ kind: string; requestId: string }> = [];
      const receivedB: Array<{ kind: string; requestId: string }> = [];
      const unsubscribeA = transitions!.subscribe(sessionA, (event) => receivedA.push(event));
      const unsubscribeB = transitions!.subscribe(sessionB, (event) => receivedB.push(event));
      const resolving = handleA.request!(attentionCall(701));
      await vi.waitFor(() =>
        expect(receivedA).toEqual([
          expect.objectContaining({ kind: 'required', requestId: '701' }),
        ]),
      );
      expect(receivedB).toEqual([]);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/sessions/${sessionA}/attention/701/resolve`,
            payload: { operationKey: 'resolve-a', action: 'resume' },
          })
        ).statusCode,
      ).toBe(202);
      await expect(resolving).resolves.toEqual(
        toOrgPlanAttentionToolResponse({ action: 'resume' }),
      );
      await vi.waitFor(() =>
        expect(receivedA).toEqual([
          expect.objectContaining({ kind: 'required', requestId: '701' }),
          expect.objectContaining({ kind: 'resolved', requestId: '701' }),
        ]),
      );
      const failing = handleB.request!(attentionCall(702, 'permissionRequired'));
      await vi.waitFor(() =>
        expect(receivedB).toEqual([
          expect.objectContaining({ kind: 'required', requestId: '702' }),
        ]),
      );
      handleB.notify!({
        method: 'serverRequest/resolved',
        params: { threadId: 'thread-ignored', requestId: 702 },
      });
      await expect(failing).rejects.toMatchObject({ message: 'CODEX_SERVER_REQUEST_CLEARED' });
      await vi.waitFor(() =>
        expect(receivedB).toEqual([
          expect.objectContaining({ kind: 'required', requestId: '702' }),
          expect.objectContaining({ kind: 'failed', requestId: '702' }),
        ]),
      );
      unsubscribeA();
      const afterUnsubscribe = handleA.request!(attentionCall(703));
      await vi.waitFor(async () =>
        expect((await app.inject(`/api/sessions/${sessionA}/attention`)).json()).toMatchObject({
          requestId: '703',
        }),
      );
      expect(receivedA).toHaveLength(2);
      handleA.notify!({
        method: 'serverRequest/resolved',
        params: { threadId: 'thread-ignored', requestId: 703 },
      });
      await expect(afterUnsubscribe).rejects.toMatchObject({
        message: 'CODEX_SERVER_REQUEST_CLEARED',
      });
      expect(receivedA).toHaveLength(2);
      unsubscribeB();
      await app.close();
    });

    it('keeps the typed attention blocker authoritative across simultaneous interaction resolutions', async () => {
      const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-root-'));
      const dataDir = await mkdtemp(join(tmpdir(), 'gestalt-mobile-state-'));
      ownTemporaryPaths(root, dataDir);
      await mkdir(join(root, 'workspace'));
      const handles: LiveServerHandle[] = [];
      const app = await composeAuthorizedApp({
        root,
        dataDir,
        relyingParty,
        installedCodexVersion: 'codex-cli 0.144.3',
        startAppServers: true,
        launchAppServer: liveAppServer(handles),
        profiles: {
          list: async () => [{ name: 'default', state: 'ok' as const, status: 'ready' as const }],
          require: async () => ({
            name: 'default',
            state: 'ok' as const,
            status: 'ready' as const,
          }),
        },
      });
      const sessionId = await createComposedSession(app);
      await vi.waitFor(() =>
        expect(handles.find((handle) => handle.request)?.request).toBeDefined(),
      );
      const handle = handles.find((candidate) => candidate.calls.includes('thread/start'))!;

      const attentionFirst = handle.request!(attentionCall(711, 'permissionRequired'));
      const inputFirst = handle.request!({
        id: 712,
        method: 'item/tool/requestUserInput',
        params: { questions: [] },
      });
      await vi.waitFor(async () =>
        expect((await app.inject(`/api/sessions/${sessionId}`)).json()).toMatchObject({
          agentActivity: { root: { state: 'awaitingHuman', reason: 'pendingInteraction' } },
        }),
      );
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/sessions/${sessionId}/interactions/712`,
            payload: { answers: {} },
          })
        ).statusCode,
      ).toBe(202);
      await expect(inputFirst).resolves.toEqual({ answers: {} });
      await vi.waitFor(async () =>
        expect((await app.inject(`/api/sessions/${sessionId}`)).json()).toMatchObject({
          agentActivity: { root: { state: 'awaitingHuman', reason: 'permissionRequired' } },
        }),
      );
      await app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/attention/711/resolve`,
        payload: { operationKey: 'attention-first', action: 'resume' },
      });
      await expect(attentionFirst).resolves.toEqual(
        toOrgPlanAttentionToolResponse({ action: 'resume' }),
      );
      await vi.waitFor(async () =>
        expect((await app.inject(`/api/sessions/${sessionId}`)).json()).toMatchObject({
          agentActivity: { root: { state: 'working' } },
        }),
      );

      const attentionSecond = handle.request!(attentionCall(713));
      const inputSecond = handle.request!({
        id: 714,
        method: 'item/tool/requestUserInput',
        params: { questions: [] },
      });
      await app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/attention/713/resolve`,
        payload: { operationKey: 'attention-second', action: 'resume' },
      });
      await expect(attentionSecond).resolves.toEqual(
        toOrgPlanAttentionToolResponse({ action: 'resume' }),
      );
      await vi.waitFor(async () =>
        expect((await app.inject(`/api/sessions/${sessionId}`)).json()).toMatchObject({
          agentActivity: { root: { state: 'awaitingHuman', reason: 'pendingInteraction' } },
        }),
      );
      await app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/interactions/714`,
        payload: { answers: {} },
      });
      await expect(inputSecond).resolves.toEqual({ answers: {} });
      await vi.waitFor(async () =>
        expect((await app.inject(`/api/sessions/${sessionId}`)).json()).toMatchObject({
          agentActivity: { root: { state: 'working' } },
        }),
      );
      await app.close();
    });

    it('preserves active and terminal attention state through a same-database relay reopen', async () => {
      const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-root-'));
      const dataDir = await mkdtemp(join(tmpdir(), 'gestalt-mobile-state-'));
      ownTemporaryPaths(root, dataDir);
      await mkdir(join(root, 'workspace'));
      const handles: LiveServerHandle[] = [];
      const profiles = {
        list: async () => [{ name: 'default', state: 'ok' as const, status: 'ready' as const }],
        require: async () => ({ name: 'default', state: 'ok' as const, status: 'ready' as const }),
      };
      const first = await composeAuthorizedApp({
        root,
        dataDir,
        relyingParty,
        profiles,
        installedCodexVersion: 'codex-cli 0.144.3',
        startAppServers: true,
        launchAppServer: liveAppServer(handles),
      });
      const sessionId = await createComposedSession(first);
      await vi.waitFor(() =>
        expect(handles.find((handle) => handle.request)?.request).toBeDefined(),
      );
      const handle = handles.find((candidate) => candidate.calls.includes('thread/start'))!;
      const active = handle.request!(attentionCall(801));
      const terminal = handle.request!(attentionCall(802));
      const terminalResponse = toOrgPlanAttentionToolResponse({
        action: 'resume',
        guidance: 'Sensitive terminal guidance.',
      });
      const accepted = await first.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/attention/802/resolve`,
        payload: {
          operationKey: 'terminal-key',
          action: 'resume',
          guidance: 'Sensitive terminal guidance.',
        },
      });
      const resolvedAt = accepted.json().resolvedAt as string;
      await expect(terminal).resolves.toEqual(terminalResponse);
      await first.close();
      await expect(active).rejects.toMatchObject({ message: 'CODEX_SERVER_REQUEST_CANCELLED' });

      const reopened = await composeAuthorizedApp({
        root,
        dataDir,
        relyingParty,
        profiles,
        installedCodexVersion: 'codex-cli 0.144.3',
        startAppServers: true,
        launchAppServer: liveAppServer(handles),
      });
      expect((await reopened.inject(`/api/sessions/${sessionId}/attention`)).json()).toMatchObject({
        requestId: '801',
      });
      const listed = (await reopened.inject('/api/sessions')).json();
      expect(JSON.stringify(listed)).toContain('801');
      await reopened.listen({ host: '127.0.0.1', port: 0 });
      await expect
        .poll(async () => (await reopened.inject(`/api/sessions/${sessionId}`)).json().state)
        .toBe('stopped');
      expect(
        (await reopened.inject({ method: 'POST', url: `/api/sessions/${sessionId}/restore` }))
          .statusCode,
      ).toBe(200);
      const history = (await reopened.inject(`/api/sessions/${sessionId}/history`)).json();
      expect(history.interactions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ requestId: '801', resolvedAt: null }),
          expect.objectContaining({ requestId: '802', resolvedAt, outcome: 'answered' }),
        ]),
      );
      expect(JSON.stringify(history)).not.toContain('Sensitive terminal guidance.');
      expect(
        (
          await reopened.inject({
            method: 'POST',
            url: `/api/sessions/${sessionId}/attention/802/resolve`,
            payload: { operationKey: 'terminal-key', action: 'resume' },
          })
        ).json(),
      ).toEqual({ accepted: true, replayed: true, resolvedAt });
      expect(
        (
          await reopened.inject({
            method: 'POST',
            url: `/api/sessions/${sessionId}/attention/802/resolve`,
            payload: { operationKey: 'other-terminal-key', action: 'resume' },
          })
        ).json(),
      ).toEqual({ code: 'ATTENTION_OPERATION_STALE' });
      await reopened.close();
    });

    it('reports supported offline writers separately from legacy sessions without the attention capability', async () => {
      const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-root-'));
      const dataDir = await mkdtemp(join(tmpdir(), 'gestalt-mobile-state-'));
      ownTemporaryPaths(root, dataDir);
      await mkdir(join(root, 'workspace'));
      const handles: LiveServerHandle[] = [];
      const profiles = {
        list: async () => [{ name: 'default', state: 'ok' as const, status: 'ready' as const }],
        require: async () => ({ name: 'default', state: 'ok' as const, status: 'ready' as const }),
      };
      const first = await composeAuthorizedApp({
        root,
        dataDir,
        relyingParty,
        profiles,
        installedCodexVersion: 'codex-cli 0.144.3',
        startAppServers: true,
        launchAppServer: liveAppServer(handles),
      });
      const supportedSession = await createComposedSession(first);
      const legacySession = await createComposedSession(first);
      await vi.waitFor(() =>
        expect(handles.filter((handle) => handle.calls.includes('thread/start'))).toHaveLength(2),
      );
      const started = handles.filter((handle) => handle.calls.includes('thread/start'));
      const supportedRequest = started[0]!.request!(attentionCall(901));
      const legacyRequest = started[1]!.request!(attentionCall(902));
      await vi.waitFor(async () =>
        expect((await first.inject(`/api/sessions/${legacySession}/attention`)).statusCode).toBe(
          200,
        ),
      );
      await first.close();
      await expect(supportedRequest).rejects.toMatchObject({
        message: 'CODEX_SERVER_REQUEST_CANCELLED',
      });
      await expect(legacyRequest).rejects.toMatchObject({
        message: 'CODEX_SERVER_REQUEST_CANCELLED',
      });
      const database = new DatabaseSync(join(dataDir, 'relay.sqlite'));
      database
        .prepare('UPDATE relay_sessions SET attention_tool_capability = NULL WHERE id = ?')
        .run(legacySession);
      database.close();
      const offline = await composeAuthorizedApp({
        root,
        dataDir,
        relyingParty,
        profiles,
        installedCodexVersion: null,
      });
      expect(
        (
          await offline.inject({
            method: 'POST',
            url: `/api/sessions/${supportedSession}/attention/901/resolve`,
            payload: { operationKey: 'offline-supported', action: 'resume' },
          })
        ).json(),
      ).toEqual({ code: 'ATTENTION_WRITER_UNAVAILABLE' });
      expect(
        (
          await offline.inject({
            method: 'POST',
            url: `/api/sessions/${legacySession}/attention/902/resolve`,
            payload: { operationKey: 'legacy-thread', action: 'resume' },
          })
        ).json(),
      ).toEqual({ code: 'ATTENTION_LEGACY_UNSUPPORTED' });
      await offline.close();
    });
    it('accepts bounded activity diagnostic and scheduler seams', async () => {
      const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-root-'));
      const dataDir = await mkdtemp(join(tmpdir(), 'gestalt-mobile-state-'));
      ownTemporaryPaths(root, dataDir);
      const diagnostic = vi.fn();
      const app = await composeAuthorizedApp({
        root,
        dataDir,
        relyingParty,
        installedCodexVersion: null,
        profiles: {
          list: async () => [],
          require: async () => ({
            name: 'default',
            state: 'ok' as const,
            status: 'ready' as const,
          }),
        },
        activitySchedule: () => () => undefined,
        activityDiagnostic: diagnostic,
      });
      expect(diagnostic).not.toHaveBeenCalled();
      await app.close();
    });
  });

  describeCompositionConcern('lifecycle', () => {
    it('retains an authored plan without starting supervision', async () => {
      const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-root-'));
      const dataDir = await mkdtemp(join(tmpdir(), 'gestalt-mobile-state-'));
      ownTemporaryPaths(root, dataDir);
      const workspacePath = join(root, 'workspace');
      await mkdir(workspacePath);
      const handles: LiveServerHandle[] = [];
      const app = await composeAuthorizedApp({
        root,
        dataDir,
        relyingParty,
        installedCodexVersion: 'codex-cli 0.144.3',
        startAppServers: true,
        launchAppServer: liveAppServer(handles),
        profiles: {
          list: async () => [],
          require: async () => ({
            name: 'default',
            state: 'ok' as const,
            status: 'ready' as const,
          }),
        },
      });
      const sessionId = await createComposedSession(app);

      await installAutopilotPlan(
        app,
        sessionId,
        workspacePath,
        'authored-only',
        'TODO',
        'authoring-start',
      );

      expect((await app.inject(`/api/sessions/${sessionId}`)).json()).toMatchObject({
        autopilot: { enabled: false, state: 'disabled' },
      });
      expect(
        handles.flatMap((handle) =>
          handle.requests.filter((request) => request.method === 'turn/start'),
        ),
      ).toHaveLength(0);
      await app.close();
    });

    it('rejects a wait lease when automatic continuation is unavailable', async () => {
      const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-root-'));
      const dataDir = await mkdtemp(join(tmpdir(), 'gestalt-mobile-state-'));
      ownTemporaryPaths(root, dataDir);
      await mkdir(join(root, 'workspace'));
      const handles: LiveServerHandle[] = [];
      const app = await composeAuthorizedApp({
        root,
        dataDir,
        relyingParty,
        installedCodexVersion: 'codex-cli 0.144.3',
        startAppServers: true,
        launchAppServer: liveAppServer(handles),
        profiles: {
          list: async () => [],
          require: async () => ({
            name: 'default',
            state: 'ok' as const,
            status: 'ready' as const,
          }),
        },
      });
      const sessionId = await createComposedSession(app);
      const handle = handles.find((candidate) => candidate.calls.includes('thread/start'))!;
      const started = await app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/turns`,
        payload: { text: 'continue supervised work' },
      });
      const turnId = started.json().activeTurnId as string;
      const threadId = (await app.inject(`/api/sessions/${sessionId}`)).json().threadId as string;
      handle.notify?.({ method: 'turn/started', params: { threadId, turn: { id: turnId } } });

      await expect(
        handle.request!({
          id: 89,
          method: 'item/tool/call',
          params: {
            threadId,
            turnId,
            tool: 'gestalt_autopilot_wait_lease',
            arguments: {
              version: 2,
              reportId: 'unavailable-report',
              leaseId: 'unavailable-lease',
              wakeConditions: ['executorChanged'],
              maxWaitMs: 60_000,
            },
          },
        }),
      ).resolves.toEqual({
        success: true,
        contentItems: [
          {
            type: 'inputText',
            text: '{"accepted":false,"reason":"automaticContinuationUnavailable","next":"continueSameTurn"}',
          },
        ],
      });
      expect((await app.inject(`/api/sessions/${sessionId}`)).json().activeTurnId).toBe(turnId);
      await app.close();
    });

    it('acknowledges root-owned capacity recovery before recycling only its app-server', async () => {
      const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-root-'));
      const dataDir = await mkdtemp(join(tmpdir(), 'gestalt-mobile-state-'));
      ownTemporaryPaths(root, dataDir);
      await mkdir(join(root, 'workspace'));
      const handles: LiveServerHandle[] = [];
      const app = await composeAuthorizedApp({
        root,
        dataDir,
        relyingParty,
        installedCodexVersion: 'codex-cli 0.144.3',
        startAppServers: true,
        launchAppServer: liveAppServer(handles),
        profiles: {
          list: async () => [],
          require: async () => ({
            name: 'default',
            state: 'ok' as const,
            status: 'ready' as const,
          }),
        },
      });
      const sessionId = await createComposedSession(app);
      const first = handles.find((candidate) => candidate.calls.includes('thread/start'));
      expect(first?.request).toBeDefined();
      const started = await app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/turns`,
        payload: { text: 'continue supervised work' },
      });
      expect(started.statusCode).toBe(202);
      const turnId = started.json().activeTurnId as string;
      const threadId = (await app.inject(`/api/sessions/${sessionId}`)).json().threadId as string;
      const handlesBeforeRecovery = handles.length;
      first!.notify?.({
        method: 'turn/started',
        params: { threadId, turn: { id: turnId } },
      });

      await expect(
        first!.request!({
          id: 90,
          method: 'item/tool/call',
          params: {
            threadId: 'child-thread',
            turnId,
            tool: 'gestalt_agent_capacity_recovery',
            arguments: { version: 1, reason: 'agentThreadLimit' },
          },
        }),
      ).rejects.toThrow('CODEX_SERVER_REQUEST_UNSUPPORTED');
      expect(handles).toHaveLength(handlesBeforeRecovery);

      await expect(
        first!.request!({
          id: 91,
          method: 'item/tool/call',
          params: {
            threadId,
            turnId,
            tool: 'gestalt_agent_capacity_recovery',
            arguments: { version: 1, reason: 'agentThreadLimit' },
          },
        }),
      ).resolves.toEqual({
        success: true,
        contentItems: [
          { type: 'inputText', text: '{"accepted":true,"action":"sessionRuntimeRecycle"}' },
        ],
      });

      await expect.poll(() => handles.length).toBeGreaterThan(handlesBeforeRecovery);
      const replacement = handles.find(
        (candidate) =>
          candidate !== first &&
          candidate.requests.some((request) => request.method === 'thread/resume'),
      );
      expect(replacement?.requests).toContainEqual({
        method: 'thread/resume',
        params: expect.objectContaining({ threadId, cwd: join(root, 'workspace') }),
      });
      await expect
        .poll(async () => (await app.inject(`/api/sessions/${sessionId}`)).json().state)
        .toBe('ready');
      expect((await app.inject(`/api/sessions/${sessionId}`)).json()).toMatchObject({
        threadId,
        activeTurnId: null,
        desiredState: 'active',
      });
      await app.close();
    });

    it('publishes an idle websocket status after saving a completed turn', async () => {
      const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-root-'));
      const dataDir = await mkdtemp(join(tmpdir(), 'gestalt-mobile-state-'));
      ownTemporaryPaths(root, dataDir);
      await mkdir(join(root, 'workspace'));
      const handles: LiveServerHandle[] = [];
      const app = await composeAuthorizedApp({
        root,
        dataDir,
        relyingParty,
        installedCodexVersion: 'codex-cli 0.144.3',
        startAppServers: true,
        launchAppServer: liveAppServer(handles),
        profiles: {
          list: async () => [],
          require: async () => ({
            name: 'default',
            state: 'ok' as const,
            status: 'ready' as const,
          }),
        },
      });
      const sessionId = await createComposedSession(app);
      const handle = handles.find((candidate) => candidate.notify);
      expect(handle?.notify).toBeDefined();
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
      const socket = new WebSocket(
        `ws://127.0.0.1:${address.port}/api/sessions/${sessionId}/events?after=0`,
        {
          headers: {
            origin: relyingParty.publicOrigin,
            cookie: 'gestalt_mobile_session=test-session',
          },
        },
      );
      const messages: Array<{ event: { type: string; payload: Record<string, unknown> } }> = [];
      socket.on('message', (data) => messages.push(JSON.parse(String(data))));
      await once(socket, 'open');
      const started = await app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/turns`,
        payload: { text: 'complete this turn' },
      });
      expect(started.statusCode).toBe(202);
      const turnId = started.json().activeTurnId as string;
      handle!.notify!({ method: 'turn/completed', params: { turn: { id: turnId } } });
      await vi.waitFor(() => {
        const status = messages
          .filter((message) => message.event.type === 'session.status.updated')
          .at(-1)?.event.payload;
        expect(status).toMatchObject({ state: 'idle' });
      });
      expect((await app.inject(`/api/sessions/${sessionId}`)).json()).toMatchObject({
        activeTurnId: null,
      });
      socket.close();
      await app.close();
    });

    it('forgets a session while activity reconciliation is pending without publishing late activity', async () => {
      const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-root-'));
      const dataDir = await mkdtemp(join(tmpdir(), 'gestalt-mobile-state-'));
      ownTemporaryPaths(root, dataDir);
      await mkdir(join(root, 'workspace'));
      const writers: Array<{
        releaseRead?: () => void;
        rejectRead?: () => void;
        notify?: (notification: { method: string; params: unknown }) => void;
      }> = [];
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on('unhandledRejection', onUnhandled);
      onTestFinished(() => {
        process.off('unhandledRejection', onUnhandled);
      });
      const app = await composeAuthorizedApp({
        root,
        dataDir,
        relyingParty,
        installedCodexVersion: 'codex-cli 0.144.3',
        startAppServers: true,
        profiles: {
          list: async () => [{ name: 'default', state: 'ok' as const, status: 'ready' as const }],
          require: async () => ({
            name: 'default',
            state: 'ok' as const,
            status: 'ready' as const,
          }),
        },
        launchAppServer: () => {
          const writer: (typeof writers)[number] = {};
          return {
            rpc: {
              request: async (method: string, params: unknown) => {
                if (method === 'thread/start') {
                  writers.push(writer);
                  return { thread: { id: `thread-${writers.length}` } };
                }
                if (method === 'thread/read')
                  return await new Promise((resolve, reject) => {
                    writer.releaseRead = () => resolve({ thread: { turns: [] } });
                    writer.rejectRead = () => reject(new Error('LATE_READ_FAILURE'));
                  });
                if (method === 'thread/list') return { data: [] };
                if (method === 'model/list') return { data: [{ id: 'gpt-5.6-terra' }] };
                if (method === 'skills/list')
                  return {
                    data: [{ cwd: (params as { cwds: string[] }).cwds[0], skills: [], errors: [] }],
                  };
                return {};
              },
              onNotification: (listener) => {
                writer.notify = listener;
                return () => {};
              },
              onServerRequest: () => () => {},
            },
            close: () => {},
            onExit: () => () => {},
          };
        },
      });
      const forgottenId = await createComposedSession(app);
      await vi.waitFor(() => expect(writers[0]?.releaseRead).toBeTypeOf('function'));
      expect(
        (await app.inject({ method: 'DELETE', url: `/api/sessions/${forgottenId}` })).statusCode,
      ).toBe(204);
      writers[0]!.rejectRead!();
      await Promise.resolve();
      await Promise.resolve();
      expect(unhandled).toEqual([]);
      expect((await app.inject('/api/bootstrap')).statusCode).toBe(200);

      const liveId = await createComposedSession(app);
      await vi.waitFor(() => expect(writers[1]?.notify).toBeTypeOf('function'));
      writers[1]!.notify!({
        method: 'thread/started',
        params: { thread: { id: 'thread-2', status: { type: 'active' } } },
      });
      await vi.waitFor(async () =>
        expect((await app.inject(`/api/sessions/${liveId}`)).json()).toMatchObject({
          agentActivity: { root: { state: 'working' } },
        }),
      );
      await app.close();
    });

    it('uses the relay root for detached history reads and Open never resumes', async () => {
      const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-root-'));
      const dataDir = await mkdtemp(join(tmpdir(), 'gestalt-mobile-state-'));
      ownTemporaryPaths(root, dataDir);
      const launches: Array<{ cwd: string; method?: string }> = [];
      const app = await composeAuthorizedApp({
        root,
        dataDir,
        relyingParty,
        installedCodexVersion: 'codex-cli 0.144.3',
        startAppServers: true,
        profiles: {
          list: async () => [{ name: 'default', state: 'ok' as const, status: 'ready' as const }],
          require: async () => ({
            name: 'default',
            state: 'ok' as const,
            status: 'ready' as const,
          }),
        },
        launchAppServer: (input) => ({
          rpc: {
            request: async (method) => {
              launches.push({ cwd: input.cwd, method });
              if (method === 'thread/list')
                return { data: [{ id: 't', cwd: '/deleted', updatedAt: 1 }] };
              if (method === 'thread/read') return { thread: { turns: [] } };
              return {};
            },
            onNotification: () => () => {},
            onServerRequest: () => () => {},
          },
          close: () => {},
        }),
      });
      const opened = await app.inject({
        method: 'POST',
        url: '/api/sessions/recent-threads/open',
        payload: { threadId: 't', cwd: '/deleted' },
      });
      expect(opened.statusCode).toBe(202);
      expect(
        launches.filter((call) => call.method === 'thread/read').map((call) => call.cwd),
      ).toEqual([root, root]);
      expect(launches.some((call) => call.method === 'thread/resume')).toBe(false);
      await app.close();
    });
    it('serves the relay without creating passkey state when access control is disabled', async () => {
      const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-root-'));
      const dataDir = await mkdtemp(join(tmpdir(), 'gestalt-mobile-state-'));
      const homeDirectory = await mkdtemp(join(tmpdir(), 'gestalt-mobile-home-'));
      ownTemporaryPaths(root, dataDir, homeDirectory);
      const authorizationRandomBytes = vi.fn(() => new Uint8Array(32));
      const app = await composeRelayApp({
        root,
        dataDir,
        homeDirectory,
        relyingParty,
        passkeyAuthEnabled: false,
        authorizationRandomBytes,
        profiles: {
          list: async () => [],
          require: async () => ({
            name: 'default',
            state: 'ok' as const,
            status: 'ready' as const,
          }),
        },
        installedCodexVersion: null,
      });

      expect((await app.inject('/api/auth/status')).json()).toEqual({
        status: 'authenticated',
        publicOrigin: '',
        passkeyAuthEnabled: false,
      });
      expect((await app.inject('/api/bootstrap')).statusCode).toBe(200);
      expect(
        (await app.inject({ method: 'POST', url: '/api/auth/login/options' })).statusCode,
      ).toBe(404);
      expect(authorizationRandomBytes).not.toHaveBeenCalled();
      await app.close();
    });

    it('inventory-classifies every production API route and reserves exactly six public entries', async () => {
      const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-root-'));
      const dataDir = await mkdtemp(join(tmpdir(), 'gestalt-mobile-state-'));
      ownTemporaryPaths(root, dataDir);
      const app = await composeAuthorizedApp({
        root,
        dataDir,
        relyingParty,
        profiles: {
          list: async () => [],
          require: async () => ({
            name: 'default',
            state: 'ok' as const,
            status: 'ready' as const,
          }),
        },
        installedCodexVersion: null,
      });
      const routes = [
        ['GET', '/api/auth/status', '/api/auth/status', 'public'],
        ['POST', '/api/auth/login/options', '/api/auth/login/options', 'public'],
        ['POST', '/api/auth/login/verify', '/api/auth/login/verify', 'public'],
        ['POST', '/api/auth/register/options', '/api/auth/register/options', 'public'],
        ['POST', '/api/auth/register/verify', '/api/auth/register/verify', 'public'],
        ['HEAD', '/api/auth/status', '/api/auth/status', 'protected'],
        ['POST', '/api/auth/logout', '/api/auth/logout', 'public'],
        ['POST', '/api/auth/enrollment-tickets', '/api/auth/enrollment-tickets', 'protected'],
        [
          'GET',
          '/api/auth/enrollment-tickets/current',
          '/api/auth/enrollment-tickets/current',
          'protected',
        ],
        [
          'HEAD',
          '/api/auth/enrollment-tickets/current',
          '/api/auth/enrollment-tickets/current',
          'protected',
        ],
        [
          'DELETE',
          '/api/auth/enrollment-tickets/current',
          '/api/auth/enrollment-tickets/current',
          'protected',
        ],
        ['GET', '/api/auth/devices', '/api/auth/devices', 'protected'],
        ['HEAD', '/api/auth/devices', '/api/auth/devices', 'protected'],
        ['PATCH', '/api/auth/devices/:deviceId', '/api/auth/devices/device-1', 'protected'],
        ['DELETE', '/api/auth/devices/:deviceId', '/api/auth/devices/device-1', 'protected'],
        ['GET', '/api/bootstrap', '/api/bootstrap', 'protected'],
        ['HEAD', '/api/bootstrap', '/api/bootstrap', 'protected'],
        ['POST', '/api/sessions', '/api/sessions', 'protected'],
        ['GET', '/api/sessions', '/api/sessions', 'protected'],
        ['HEAD', '/api/sessions', '/api/sessions', 'protected'],
        ['GET', '/api/sessions/recent-threads', '/api/sessions/recent-threads', 'protected'],
        ['HEAD', '/api/sessions/recent-threads', '/api/sessions/recent-threads', 'protected'],
        ['GET', '/api/sessions/:id', '/api/sessions/session-1', 'protected'],
        ['GET', '/api/sessions/:id/attention', '/api/sessions/session-1/attention', 'protected'],
        [
          'POST',
          '/api/sessions/:id/activity/refresh',
          '/api/sessions/session-1/activity/refresh',
          'protected',
        ],
        ['HEAD', '/api/sessions/:id', '/api/sessions/session-1', 'protected'],
        ['HEAD', '/api/sessions/:id/attention', '/api/sessions/session-1/attention', 'protected'],
        [
          'POST',
          '/api/sessions/:id/attention/:requestId/resolve',
          '/api/sessions/session-1/attention/request-1/resolve',
          'protected',
        ],
        ['POST', '/api/sessions/:id/model', '/api/sessions/session-1/model', 'protected'],
        ['PUT', '/api/sessions/:id/autopilot', '/api/sessions/session-1/autopilot', 'protected'],
        ['PUT', '/api/sessions/:id/plan', '/api/sessions/session-1/plan', 'protected'],
        ['GET', '/api/sessions/:id/plan', '/api/sessions/session-1/plan', 'protected'],
        ['HEAD', '/api/sessions/:id/plan', '/api/sessions/session-1/plan', 'protected'],
        ['DELETE', '/api/sessions/:id/plan', '/api/sessions/session-1/plan', 'protected'],
        [
          'GET',
          '/api/workspaces/:workspaceId/files',
          '/api/workspaces/workspace-1/files',
          'protected',
        ],
        [
          'HEAD',
          '/api/workspaces/:workspaceId/files',
          '/api/workspaces/workspace-1/files',
          'protected',
        ],
        [
          'POST',
          '/api/workspaces/:workspaceId/files/copy',
          '/api/workspaces/workspace-1/files/copy',
          'protected',
        ],
        [
          'POST',
          '/api/workspaces/:workspaceId/files/move',
          '/api/workspaces/workspace-1/files/move',
          'protected',
        ],
        [
          'PUT',
          '/api/workspaces/:workspaceId/files/upload',
          '/api/workspaces/workspace-1/files/upload',
          'protected',
        ],
        [
          'DELETE',
          '/api/workspaces/:workspaceId/files',
          '/api/workspaces/workspace-1/files',
          'protected',
        ],
        [
          'GET',
          '/api/workspaces/:workspaceId/plans',
          '/api/workspaces/workspace-1/plans',
          'protected',
        ],
        [
          'HEAD',
          '/api/workspaces/:workspaceId/plans',
          '/api/workspaces/workspace-1/plans',
          'protected',
        ],
        [
          'GET',
          '/api/workspaces/:workspaceId/plans/:planName',
          '/api/workspaces/workspace-1/plans/plan.org',
          'protected',
        ],
        [
          'HEAD',
          '/api/workspaces/:workspaceId/plans/:planName',
          '/api/workspaces/workspace-1/plans/plan.org',
          'protected',
        ],
        [
          'GET',
          '/api/git/repositories/:workspaceId',
          '/api/git/repositories/workspace-1',
          'protected',
        ],
        [
          'HEAD',
          '/api/git/repositories/:workspaceId',
          '/api/git/repositories/workspace-1',
          'protected',
        ],
        [
          'POST',
          '/api/git/repositories/:workspaceId/push',
          '/api/git/repositories/workspace-1/push',
          'protected',
        ],
        [
          'POST',
          '/api/git/repositories/:workspaceId/refresh',
          '/api/git/repositories/workspace-1/refresh',
          'protected',
        ],
        [
          'POST',
          '/api/git/repositories/:workspaceId/pull',
          '/api/git/repositories/workspace-1/pull',
          'protected',
        ],
        [
          'POST',
          '/api/git/repositories/:workspaceId/checkout',
          '/api/git/repositories/workspace-1/checkout',
          'protected',
        ],
        ['POST', '/api/git/clone', '/api/git/clone', 'protected'],
        ['POST', '/api/maintenance/update-restart', '/api/maintenance/update-restart', 'protected'],
        ['GET', '/api/skills', '/api/skills', 'protected'],
        ['HEAD', '/api/skills', '/api/skills', 'protected'],
        ['GET', '/api/skill-profiles', '/api/skill-profiles', 'protected'],
        ['HEAD', '/api/skill-profiles', '/api/skill-profiles', 'protected'],
        ['PUT', '/api/skill-profiles/:name', '/api/skill-profiles/default', 'protected'],
        ['DELETE', '/api/skill-profiles/:name', '/api/skill-profiles/default', 'protected'],
      ] as const;
      const routePaths: string[] = [];
      const inventory = app
        .printRoutes({ commonPrefix: false })
        .split('\n')
        .flatMap((line) => {
          const match = line.match(/^(.*)[├└]── (\/\S+) \(([^)]+)\)$/);
          if (!match) return [];
          const depth = match[1].length / 4;
          routePaths.splice(depth);
          routePaths[depth] = depth === 0 ? match[2] : `${routePaths[depth - 1]}${match[2]}`;
          if (!routePaths[depth].startsWith('/api/')) return [];
          return match[3].split(', ').map((method) => `${method} ${routePaths[depth]}`);
        })
        .sort();
      const expectedInventory = routes.map(([method, pattern]) => `${method} ${pattern}`).sort();
      expect(inventory).toEqual(expectedInventory);
      expect(routes.filter(([, , , access]) => access === 'public')).toEqual([
        ['GET', '/api/auth/status', '/api/auth/status', 'public'],
        ['POST', '/api/auth/login/options', '/api/auth/login/options', 'public'],
        ['POST', '/api/auth/login/verify', '/api/auth/login/verify', 'public'],
        ['POST', '/api/auth/register/options', '/api/auth/register/options', 'public'],
        ['POST', '/api/auth/register/verify', '/api/auth/register/verify', 'public'],
        ['POST', '/api/auth/logout', '/api/auth/logout', 'public'],
      ]);
      const unauthorized = await createUnauthorizedProductionApp(root, dataDir);
      for (const [method, pattern, url, access] of routes) {
        const response = await unauthorized.inject({
          method,
          url,
          headers:
            method === 'GET' || method === 'HEAD' ? {} : { origin: relyingParty.publicOrigin },
        });
        if (access === 'public') {
          expect(response.statusCode, `${method} ${pattern}`).not.toBe(401);
          expect(response.body, `${method} ${pattern}`).not.toContain('AUTH_REQUIRED');
        } else {
          expect(response.statusCode, `${method} ${pattern}`).toBe(401);
          if (method !== 'HEAD')
            expect(response.json(), `${method} ${pattern}`).toMatchObject({
              code: 'AUTH_REQUIRED',
            });
        }
      }
      await unauthorized.close();
      await app.close();
    });
  });

  describeCompositionConcern('authorization', () => {
    it('shares one authorization owner across independently composed relay databases and closes handles independently', async () => {
      const rootOne = await mkdtemp(join(tmpdir(), 'gestalt-mobile-root-'));
      const rootTwo = await mkdtemp(join(tmpdir(), 'gestalt-mobile-root-'));
      const dataOne = await mkdtemp(join(tmpdir(), 'gestalt-mobile-state-'));
      const dataTwo = await mkdtemp(join(tmpdir(), 'gestalt-mobile-state-'));
      const sharedHome = await mkdtemp(join(tmpdir(), 'gestalt-mobile-home-'));
      ownTemporaryPaths(rootOne, rootTwo, dataOne, dataTwo, sharedHome);
      const profiles = {
        list: async () => [],
        require: async () => ({ name: 'default', state: 'ok' as const, status: 'ready' as const }),
      };
      const firstHandle = new Uint8Array(32).fill(1);
      const secondHandle = new Uint8Array(32).fill(9);
      const first = await composeRelayApp({
        root: rootOne,
        dataDir: dataOne,
        homeDirectory: sharedHome,
        relyingParty,
        profiles,
        installedCodexVersion: null,
        authorizationRandomBytes: () => firstHandle,
      });
      const second = await composeRelayApp({
        root: rootTwo,
        dataDir: dataTwo,
        homeDirectory: sharedHome,
        relyingParty,
        profiles,
        installedCodexVersion: null,
        authorizationRandomBytes: () => secondHandle,
      });
      await first.close();
      expect((await second.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
      const store = new SqliteAuthorizationStore(sharedHome, relyingParty);
      expect(store.readOwner()?.userHandle).toEqual(firstHandle);
      store.close();
      await second.close();
    });

    it('rejects malformed authorization randomness before opening a durable auth handle', async () => {
      const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-root-'));
      const dataDir = await mkdtemp(join(tmpdir(), 'gestalt-mobile-state-'));
      const home = await mkdtemp(join(tmpdir(), 'gestalt-mobile-home-'));
      ownTemporaryPaths(root, dataDir, home);
      await expect(
        composeRelayApp({
          root,
          dataDir,
          homeDirectory: home,
          relyingParty,
          profiles: {
            list: async () => [],
            require: async () => ({
              name: 'default',
              state: 'ok' as const,
              status: 'ready' as const,
            }),
          },
          installedCodexVersion: null,
          authorizationRandomBytes: () => new Uint8Array(31),
        }),
      ).rejects.toThrow('exactly 32');
      const store = new SqliteAuthorizationStore(home, relyingParty);
      expect(store.readOwner()).toBeNull();
      store.close();
    });

    it('closes authorization and relay handles when app construction fails after owner initialization', async () => {
      const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-root-'));
      const dataDir = await mkdtemp(join(tmpdir(), 'gestalt-mobile-state-'));
      const home = await mkdtemp(join(tmpdir(), 'gestalt-mobile-home-'));
      const notDirectory = join(root, 'not-a-directory');
      ownTemporaryPaths(root, dataDir, home);
      await writeFile(notDirectory, 'x');
      await expect(
        composeRelayApp({
          root,
          dataDir,
          homeDirectory: home,
          staticDir: notDirectory,
          relyingParty,
          profiles: {
            list: async () => [],
            require: async () => ({
              name: 'default',
              state: 'ok' as const,
              status: 'ready' as const,
            }),
          },
          installedCodexVersion: null,
          authorizationRandomBytes: () => new Uint8Array(32).fill(7),
        }),
      ).rejects.toThrow();
      const store = new SqliteAuthorizationStore(home, relyingParty);
      expect(store.readOwner()?.userHandle).toEqual(new Uint8Array(32).fill(7));
      store.close();
    });

    it('closes the relay handle when authorization initialization rejects an RP migration', async () => {
      const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-root-'));
      const dataDir = await mkdtemp(join(tmpdir(), 'gestalt-mobile-state-'));
      const home = await mkdtemp(join(tmpdir(), 'gestalt-mobile-home-'));
      ownTemporaryPaths(root, dataDir, home);
      const seeded = new SqliteAuthorizationStore(home, relyingParty);
      const owner = { id: localOwnerId('local-owner'), userHandle: new Uint8Array(32).fill(1) };
      seeded.initializeOwner(owner.userHandle);
      seeded.claimFirstDevice(owner, {
        id: authorizedDeviceId('device'),
        credentialId: webAuthnCredentialId('credential'),
        publicKey: new Uint8Array([1]),
        counter: 0,
        transports: ['internal'],
        deviceType: 'singleDevice',
        backedUp: false,
        nickname: deviceNickname('Device'),
        createdAt: '2026-08-02T00:00:00.000Z',
      });
      seeded.close();
      const migrated = {
        publicOrigin: 'https://other.example',
        rpId: 'other.example',
        rpName: 'Gestalt Mobile' as const,
      };
      await expect(
        composeRelayApp({
          root,
          dataDir,
          homeDirectory: home,
          relyingParty: migrated,
          profiles: {
            list: async () => [],
            require: async () => ({
              name: 'default',
              state: 'ok' as const,
              status: 'ready' as const,
            }),
          },
          installedCodexVersion: null,
          authorizationRandomBytes: () => new Uint8Array(32).fill(2),
        }),
      ).rejects.toThrow('hostname changed');
      const reopened = new SqliteAuthorizationStore(home, relyingParty);
      expect(reopened.listAuthorizedDevices()).toHaveLength(1);
      reopened.close();
    });

    it('rejects a relying-party identity that does not match its canonical origin', async () => {
      await expect(
        composeRelayApp({
          root: '/unused',
          relyingParty: { ...relyingParty, rpId: 'other.example' },
          profiles: {
            list: async () => [],
            require: async () => ({ name: 'default', state: 'ok', status: 'ready' }),
          },
          installedCodexVersion: null,
        }),
      ).rejects.toThrow('Invalid WebAuthn relying-party configuration');
    });
  });

  describeCompositionConcern('sessions', () => {
    it('does not resolve a Git operation target outside the configured root', async () => {
      const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-root-'));
      const outside = await mkdtemp(join(tmpdir(), 'gestalt-mobile-outside-'));
      const dataDir = await mkdtemp(join(tmpdir(), 'gestalt-mobile-state-'));
      ownTemporaryPaths(root, outside, dataDir);
      await mkdir(join(outside, '.git'));
      await symlink(outside, join(root, 'escape'));
      const app = await composeAuthorizedApp({
        root,
        dataDir,
        relyingParty,
        profiles: {
          list: async () => [{ name: 'default', state: 'ok', status: 'ready' }],
          require: async () => ({ name: 'default', state: 'ok', status: 'ready' }),
        },
        installedCodexVersion: 'codex-cli 0.144.3',
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/git/repositories/${workspaceId(outside)}`,
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ code: 'WORKSPACE_NOT_FOUND' });
      await app.close();
    });

    it('persists a catalog-selected session under the configured data directory', async () => {
      const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-root-'));
      const dataDir = await mkdtemp(join(tmpdir(), 'gestalt-mobile-state-'));
      ownTemporaryPaths(root, dataDir);
      await mkdir(join(root, 'workspace'));
      const app = await composeAuthorizedApp({
        root,
        dataDir,
        relyingParty,
        profiles: {
          list: async () => [{ name: 'default', state: 'ok', status: 'ready' }],
          require: async () => ({ name: 'default', state: 'ok', status: 'ready' }),
        },
        installedCodexVersion: 'codex-cli 0.144.3',
        launchAppServer: () => fakeAppServer([]),
      });

      const bootstrap = await app.inject({ method: 'GET', url: '/api/bootstrap' });
      const workspace = bootstrap
        .json()
        .workspaces[0]?.children.find((item: { name: string }) => item.name === 'workspace');
      expect(workspace).toBeDefined();
      const created = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { workspaceId: workspace!.id, profile: 'default', provider: 'codex' },
      });
      expect(created.statusCode).toBe(202);
      const restored = await app.inject({
        method: 'GET',
        url: `/api/sessions/${created.json().id}`,
      });
      expect(restored.json()).toMatchObject({
        workspaceId: workspace!.id,
        workspacePath: join(root, 'workspace'),
      });
      await app.close();
    });

    it('keeps cold bootstrap passive while explicit Kimi session creation resolves a Kimi model', async () => {
      const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-root-'));
      const dataDir = await mkdtemp(join(tmpdir(), 'gestalt-mobile-state-'));
      ownTemporaryPaths(root, dataDir);
      await mkdir(join(root, 'workspace'));
      const sessionModelCalls: string[] = [];
      const app = await composeAuthorizedApp({
        root,
        dataDir,
        relyingParty,
        installedCodexVersion: null,
        installedKimiVersion: '2.0.2',
        launchAppServer: () => fakeAppServer([]),
        sessionModelCatalog: {
          list: async (provider) => {
            sessionModelCalls.push(provider);
            return provider === 'kimi' ? ['k2-thinking'] : ['gpt-5.6-terra'];
          },
        },
        profiles: {
          list: async () => [],
          require: async () => {
            throw new Error('CODEX_LAUNCHER_UNAVAILABLE');
          },
        },
      });

      const bootstrap = await app.inject('/api/bootstrap');
      const workspace = bootstrap
        .json()
        .workspaces[0]?.children.find((item: { name: string }) => item.name === 'workspace');
      expect(bootstrap.json().models.kimi).toEqual([]);
      expect(sessionModelCalls).toEqual([]);

      const created = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { workspaceId: workspace.id, profile: 'default', provider: 'kimi' },
      });
      expect(created.statusCode).toBe(202);
      expect(created.json()).toMatchObject({ provider: 'kimi', model: 'k2-thinking' });
      expect(sessionModelCalls).toEqual(['kimi']);
      await app.close();
    });

    it('keeps real server listen passive when Kimi is installed', async () => {
      const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-root-'));
      const dataDir = await mkdtemp(join(tmpdir(), 'gestalt-mobile-state-'));
      ownTemporaryPaths(root, dataDir);
      await mkdir(join(root, 'workspace'));
      const ensure = vi.fn(async () => {
        throw new Error('passive startup must not ensure Kimi');
      });
      const app = await composeAuthorizedApp({
        root,
        dataDir,
        relyingParty,
        installedCodexVersion: null,
        installedKimiVersion: '2.0.2',
        startAppServers: true,
        kimiServerManager: {
          ensure,
          get: () => null,
          list: () => [],
          stopAll: async () => {},
        } as never,
        profiles: {
          list: async () => [],
          require: async () => {
            throw new Error('CODEX_LAUNCHER_UNAVAILABLE');
          },
        },
      });

      await app.listen({ host: '127.0.0.1', port: 0 });
      expect(ensure).not.toHaveBeenCalled();
      await app.close();
    });

    it('delivers a realistic Codex answer notification through the journal to the chat projection', async () => {
      const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-root-'));
      const dataDir = await mkdtemp(join(tmpdir(), 'gestalt-mobile-state-'));
      ownTemporaryPaths(root, dataDir);
      await mkdir(join(root, 'workspace'));
      const handles: LiveServerHandle[] = [];
      const app = await composeAuthorizedApp({
        root,
        dataDir,
        relyingParty,
        installedCodexVersion: 'codex-cli 0.144.3',
        startAppServers: true,
        launchAppServer: liveAppServer(handles),
        profiles: {
          list: async () => [],
          require: async () => ({
            name: 'default',
            state: 'ok' as const,
            status: 'ready' as const,
          }),
        },
      });
      const sessionId = await createComposedSession(app);
      const handle = handles.find((candidate) => candidate.calls.includes('thread/start'))!;
      const started = await app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/turns`,
        payload: { text: 'give the answer' },
      });
      expect(started.statusCode).toBe(202);
      const turnId = started.json().activeTurnId as string;
      const threadId = (await app.inject(`/api/sessions/${sessionId}`)).json().threadId as string;

      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
      const socket = new WebSocket(
        `ws://127.0.0.1:${address.port}/api/sessions/${sessionId}/events?after=0`,
        {
          headers: {
            origin: relyingParty.publicOrigin,
            cookie: 'gestalt_mobile_session=test-session',
          },
        },
      );
      const messages: Array<{ event: { sequence: number; type: string; payload: unknown } }> = [];
      socket.on('message', (data) => messages.push(JSON.parse(String(data))));
      await once(socket, 'open');

      handle.notify!({
        method: 'item/completed',
        params: {
          threadId,
          turnId,
          item: {
            id: 'answer-1',
            type: 'agentMessage',
            phase: 'final_answer',
            text: 'The provider boundary is intact.',
          },
        },
      });

      await vi.waitFor(() =>
        expect(messages.some((message) => message.event.type === 'agentMessageCompleted')).toBe(
          true,
        ),
      );
      const projection = messages
        .map((message) => message.event)
        .sort((left, right) => left.sequence - right.sequence)
        .reduce(
          (current, event) => applyProjectionEvent(current, event),
          createChatProjection(sessionId),
        );
      expect(projection.messages).toEqual([
        expect.objectContaining({
          id: 'assistant:answer-1',
          role: 'assistant',
          text: 'The provider boundary is intact.',
          phase: 'final_answer',
          complete: true,
          turnId,
        }),
      ]);
      socket.close();
      await app.close();
    });

    it('hands a replayed session-owned plan replacement off to its live close event exactly once', async () => {
      const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-root-'));
      const dataDir = await mkdtemp(join(tmpdir(), 'gestalt-mobile-state-'));
      ownTemporaryPaths(root, dataDir);
      const workspacePath = join(root, 'workspace');
      await mkdir(workspacePath);
      const planPath = join(workspacePath, 'plan.org');
      await writeFile(
        planPath,
        `#+TITLE: Completed plan
* DONE [#A] Closeable work
:PROPERTIES:
:ID: closeable-work
:SKILLS: $gestalt:org-plan
:REVIEW_STATUS: UNREVIEWED
:END:
- Effort :: Small
- Goal :: Exercise session event composition.
- Notes :: Complete.
`,
      );
      const profiles = {
        list: async () => [{ name: 'default', state: 'ok' as const, status: 'ready' as const }],
        require: async () => ({ name: 'default', state: 'ok' as const, status: 'ready' as const }),
      };
      const app = await composeAuthorizedApp({
        root,
        dataDir,
        relyingParty,
        profiles,
        installedCodexVersion: 'codex-cli 0.144.3',
        startAppServers: true,
        launchAppServer: () => fakeAppServer([]),
      });
      const workspace = (await app.inject('/api/bootstrap'))
        .json()
        .workspaces[0]?.children.find((item: { name: string }) => item.name === 'workspace');
      const created = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { workspaceId: workspace.id, profile: 'default', provider: 'codex' },
      });
      const sessionId = created.json().id as string;
      await writeFile(
        planStatusFilePath(planStatusDirectoryPath(workspacePath, sessionId), planPath),
        JSON.stringify({
          schemaVersion: 1,
          planPath,
          reason: 'supervision-start',
          updatedAt: '2026-08-01T00:00:00.000Z',
        }),
      );
      await expect
        .poll(async () => (await app.inject(`/api/sessions/${sessionId}/plan`)).statusCode)
        .toBe(200);
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
      const socket = new WebSocket(
        `ws://127.0.0.1:${address.port}/api/sessions/${sessionId}/events?after=0`,
        {
          headers: {
            origin: relyingParty.publicOrigin,
            cookie: 'gestalt_mobile_session=test-session',
          },
        },
      );
      const messages: Array<{
        type: string;
        event: { type: string; sequence: number; payload: unknown };
      }> = [];
      socket.on('message', (data) => messages.push(JSON.parse(String(data))));
      await once(socket, 'open');
      await vi.waitFor(() =>
        expect(messages.some((message) => message.event.type === 'plan.updated')).toBe(true),
      );
      const updatedIndex = messages.findIndex((message) => message.event.type === 'plan.updated');
      expect(messages[updatedIndex]).toMatchObject({
        type: 'relay.event',
        event: {
          type: 'plan.updated',
          payload: {
            plan: { title: 'Completed plan', allDone: true },
            reason: 'supervision-start',
          },
        },
      });
      expect(
        (await app.inject({ method: 'DELETE', url: `/api/sessions/${sessionId}/plan` })).statusCode,
      ).toBe(204);
      await vi.waitFor(() =>
        expect(messages.some((message) => message.event.type === 'plan.closed')).toBe(true),
      );
      const closedIndex = messages.findIndex((message) => message.event.type === 'plan.closed');
      expect(messages[closedIndex]).toMatchObject({
        type: 'relay.event',
        event: { type: 'plan.closed', payload: {} },
      });
      expect(closedIndex).toBeGreaterThan(updatedIndex);
      const replayedSequence = messages[updatedIndex]!.event.sequence;
      const liveSequence = messages[closedIndex]!.event.sequence;
      expect(replayedSequence).toBeGreaterThan(0);
      expect(liveSequence).toBeGreaterThan(replayedSequence);
      expect(new Set([replayedSequence, liveSequence]).size).toBe(2);
      expect(messages.filter((message) => message.event.type === 'plan.updated')).toHaveLength(1);
      expect(messages.filter((message) => message.event.type === 'plan.closed')).toHaveLength(1);
      const updatesBeforeResync = messages.filter(
        (message) => message.event.type === 'plan.updated',
      ).length;
      await writeFile(
        planStatusFilePath(planStatusDirectoryPath(workspacePath, sessionId), planPath),
        JSON.stringify({
          schemaVersion: 1,
          planPath,
          reason: 'same-plan-resync',
          updatedAt: '2026-08-01T00:00:01.000Z',
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(messages.filter((message) => message.event.type === 'plan.updated')).toHaveLength(
        updatesBeforeResync,
      );
      socket.close();
      await app.close();
      const restarted = await composeAuthorizedApp({
        root,
        dataDir,
        relyingParty,
        profiles,
        installedCodexVersion: 'codex-cli 0.144.3',
        startAppServers: true,
        launchAppServer: () => fakeAppServer([]),
      });
      await restarted.listen({ host: '127.0.0.1', port: 0 });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect((await restarted.inject(`/api/sessions/${sessionId}/plan`)).statusCode).toBe(204);
      const nextPlanPath = join(workspacePath, 'next-plan.org');
      await writeFile(
        nextPlanPath,
        `#+TITLE: Different plan
* DONE [#A] Different work
:PROPERTIES:
:ID: different-work
:SKILLS: $gestalt:org-plan
:REVIEW_STATUS: UNREVIEWED
:END:
- Effort :: Small
- Goal :: Prove a different plan can replace a dismissed one.
- Notes :: Complete.
`,
      );
      await writeFile(
        planStatusFilePath(planStatusDirectoryPath(workspacePath, sessionId), nextPlanPath),
        JSON.stringify({
          schemaVersion: 1,
          planPath: nextPlanPath,
          reason: 'different-plan',
          updatedAt: '2026-08-01T00:00:02.000Z',
        }),
      );
      await expect
        .poll(async () => (await restarted.inject(`/api/sessions/${sessionId}/plan`)).json().title)
        .toBe('Different plan');
      await restarted.close();
    });

    it('detaches active persisted threads when the relay restarts without resuming a writer', async () => {
      const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-root-'));
      const dataDir = await mkdtemp(join(tmpdir(), 'gestalt-mobile-state-'));
      ownTemporaryPaths(root, dataDir);
      await mkdir(join(root, 'workspace'));
      const profiles = {
        list: async () => [{ name: 'default', state: 'ok' as const, status: 'ready' }],
        require: async () => ({ name: 'default', state: 'ok' as const, status: 'ready' }),
      };
      const firstCalls: string[] = [];
      const first = await composeAuthorizedApp({
        root,
        dataDir,
        relyingParty,
        profiles,
        installedCodexVersion: 'codex-cli 0.144.3',
        startAppServers: true,
        launchAppServer: () => fakeAppServer(firstCalls),
      });
      const workspace = (await first.inject('/api/bootstrap'))
        .json()
        .workspaces[0]?.children.find((item: { name: string }) => item.name === 'workspace');
      expect(workspace).toBeDefined();
      const created = await first.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { workspaceId: workspace!.id, profile: 'default', provider: 'codex' },
      });
      expect(created.statusCode).toBe(202);
      expect(firstCalls).toEqual([
        'initialize',
        'model/list',
        'initialize',
        'model/list',
        'initialize',
        'skills/list',
        'initialize',
        'skills/list',
        'initialize',
        'thread/start',
        'thread/read',
      ]);
      await first.close();

      const secondCalls: string[] = [];
      const second = await composeAuthorizedApp({
        root,
        dataDir,
        relyingParty,
        profiles,
        installedCodexVersion: 'codex-cli 0.144.3',
        startAppServers: true,
        launchAppServer: () => fakeAppServer(secondCalls),
      });
      expect(secondCalls).toEqual([]);
      await second.listen({ host: '127.0.0.1', port: 0 });
      await expect
        .poll(() => secondCalls, { timeout: 1_000 })
        .toEqual(['initialize', 'skills/list']);
      const restored = await second.inject(`/api/sessions/${created.json().id}`);
      expect(restored.json()).toMatchObject({
        threadId: 'thread-1',
        state: 'stopped',
        agentActivity: { confidence: 'stale', root: { state: 'disconnected' } },
      });
      await second.close();
    });

    it('closes an active Codex child during graceful relay shutdown', async () => {
      const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-root-'));
      const dataDir = await mkdtemp(join(tmpdir(), 'gestalt-mobile-state-'));
      ownTemporaryPaths(root, dataDir);
      await mkdir(join(root, 'workspace'));
      let closed = 0;
      const app = await composeAuthorizedApp({
        root,
        dataDir,
        relyingParty,
        profiles: {
          list: async () => [{ name: 'default', state: 'ok', status: 'ready' }],
          require: async () => ({ name: 'default', state: 'ok', status: 'ready' }),
        },
        installedCodexVersion: 'codex-cli 0.144.3',
        startAppServers: true,
        launchAppServer: () => ({
          rpc: {
            request: async (method: string, params: unknown) => {
              if (method === 'model/list') return { data: [{ id: 'gpt-5.6-terra' }] };
              if (method === 'skills/list')
                return {
                  data: [{ cwd: (params as { cwds: string[] }).cwds[0], skills: [], errors: [] }],
                };
              return method === 'thread/start' ? { thread: { id: 'thread-1' } } : {};
            },
            onNotification: () => () => {},
            onServerRequest: () => () => {},
          },
          close: () => {
            closed += 1;
          },
          onExit: () => () => {},
        }),
      });
      const workspace = (await app.inject('/api/bootstrap'))
        .json()
        .workspaces[0]?.children.find((item: { name: string }) => item.name === 'workspace');
      await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { workspaceId: workspace.id, profile: 'default', provider: 'codex' },
      });

      await app.close();

      // Model and skill catalogs run for bootstrap and session start; the active child closes with the relay.
      expect(closed).toBe(5);
    });

    it('reconciles an interaction cleared upstream as no longer pending', async () => {
      const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-root-'));
      const dataDir = await mkdtemp(join(tmpdir(), 'gestalt-mobile-state-'));
      ownTemporaryPaths(root, dataDir);
      await mkdir(join(root, 'workspace'));
      const handles: Array<{
        calls: string[];
        failReads?: boolean;
        notify?: (notification: { method: string; params: unknown }) => void;
        request?: (request: { id: number; method: string; params: unknown }) => Promise<unknown>;
      }> = [];
      const activityCallbacks: Array<() => void> = [];
      const activityDiagnostic = vi.fn();
      const app = await composeAuthorizedApp({
        root,
        dataDir,
        relyingParty,
        profiles: {
          list: async () => [{ name: 'default', state: 'ok', status: 'ready' }],
          require: async () => ({ name: 'default', state: 'ok', status: 'ready' }),
        },
        installedCodexVersion: 'codex-cli 0.144.3',
        startAppServers: true,
        activitySchedule: (callback) => {
          activityCallbacks.push(callback);
          return () => undefined;
        },
        activityDiagnostic,
        launchAppServer: () => {
          const handle: (typeof handles)[number] = { calls: [] };
          handles.push(handle);
          return {
            rpc: {
              request: async (method: string, params: unknown) => {
                handle.calls.push(method);
                if (method === 'thread/start') return { thread: { id: 'thread-1' } };
                if (method === 'thread/read') {
                  if (handle.failReads) throw new Error('READ_DOWN');
                  return { thread: { turns: [] } };
                }
                if (method === 'model/list') return { data: [{ id: 'gpt-5.6-terra' }] };
                if (method === 'skills/list')
                  return {
                    data: [{ cwd: (params as { cwds: string[] }).cwds[0], skills: [], errors: [] }],
                  };
                return {};
              },
              onNotification: (listener) => {
                handle.notify = listener;
                return () => {};
              },
              onServerRequest: (listener) => {
                handle.request = listener;
                return () => {};
              },
            },
            close: () => {},
            onExit: () => () => {},
          };
        },
      });
      const workspace = (await app.inject('/api/bootstrap'))
        .json()
        .workspaces[0]?.children.find((item: { name: string }) => item.name === 'workspace');
      const created = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { workspaceId: workspace.id, profile: 'default', provider: 'codex' },
      });
      const sessionId = created.json().id as string;
      const handle = handles.find((candidate) => candidate.calls.includes('thread/start'));
      expect(handle?.request).toBeDefined();
      await vi.waitFor(() => {
        expect(handle?.calls).toContain('thread/read');
        expect(handle?.calls).toContain('thread/list');
      });
      expect((await app.inject(`/api/sessions/${sessionId}`)).json()).toMatchObject({
        state: 'ready',
        agentActivity: { confidence: 'fresh' },
      });
      const reconciliationCalls = handle!.calls.filter(
        (method) => method === 'thread/read' || method === 'thread/list',
      );
      const ordinarySave = await app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/model`,
        payload: { model: 'gpt-5.6-terra' },
      });
      expect(ordinarySave.statusCode).toBe(200);
      expect(
        handle!.calls.filter((method) => method === 'thread/read' || method === 'thread/list'),
      ).toEqual(reconciliationCalls);
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
      const socket = new WebSocket(
        `ws://127.0.0.1:${address.port}/api/sessions/${sessionId}/events?after=0`,
        {
          headers: {
            origin: relyingParty.publicOrigin,
            cookie: 'gestalt_mobile_session=test-session',
          },
        },
      );
      const activityEvents: Array<{ event: { type: string; sequence: number } }> = [];
      socket.on('message', (data) => activityEvents.push(JSON.parse(String(data))));
      await once(socket, 'open');
      expect((await app.inject(`/api/sessions/${sessionId}`)).json()).toMatchObject({
        agentActivity: { confidence: 'fresh' },
      });
      activityCallbacks.splice(0);
      handle!.failReads = true;
      await expect(
        app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/activity/refresh` }),
      ).resolves.toMatchObject({ statusCode: 202 });
      for (let retry = 0; retry < 3; retry += 1) {
        await vi.waitFor(() => expect(activityCallbacks.length).toBeGreaterThan(0));
        const callback = activityCallbacks.shift();
        expect(callback).toBeDefined();
        callback!();
        await Promise.resolve();
        await Promise.resolve();
      }
      await vi.waitFor(() => expect(activityDiagnostic).toHaveBeenCalledTimes(1));
      expect(activityDiagnostic).toHaveBeenCalledWith(sessionId, 'reconcileExhausted');
      handle!.failReads = false;
      const initialActivityEvents = activityEvents.filter(
        (message) => message.event.type === 'agent.activity.updated',
      ).length;
      handle!.notify!({
        method: 'thread/started',
        params: { thread: { id: 'thread-1', status: { type: 'active' } } },
      });
      await vi.waitFor(() =>
        expect(
          activityEvents.filter((message) => message.event.type === 'agent.activity.updated'),
        ).toHaveLength(initialActivityEvents + 1),
      );
      expect((await app.inject(`/api/sessions/${sessionId}`)).json()).toMatchObject({
        agentActivity: { root: { state: 'working' } },
      });
      expect(
        activityEvents.filter((message) => message.event.type === 'agent.activity.updated'),
      ).toHaveLength(initialActivityEvents + 1);
      expect(JSON.stringify(activityEvents)).not.toMatch(
        /ownerThreadId|ownerTaskPath|itemId|cpuPercent|rssBytes|resultArtifact/,
      );
      const activitySequence = activityEvents.find(
        (message) => message.event.type === 'agent.activity.updated',
      )!.event.sequence;
      socket.close();
      const replaySocket = new WebSocket(
        `ws://127.0.0.1:${address.port}/api/sessions/${sessionId}/events?after=${activitySequence - 1}`,
        {
          headers: {
            origin: relyingParty.publicOrigin,
            cookie: 'gestalt_mobile_session=test-session',
          },
        },
      );
      const replayEvents: Array<{ event: { type: string; sequence: number } }> = [];
      replaySocket.on('message', (data) => replayEvents.push(JSON.parse(String(data))));
      await once(replaySocket, 'open');
      await vi.waitFor(() =>
        expect(replayEvents.some((message) => message.event.sequence === activitySequence)).toBe(
          true,
        ),
      );
      expect(
        replayEvents.filter((message) => message.event.sequence === activitySequence),
      ).toHaveLength(1);
      replaySocket.close();
      // Replaying the same app-server fact is semantically idempotent: the
      // session snapshot remains stable and no prompt/collaboration text enters it.
      handle!.notify!({
        method: 'thread/started',
        params: { thread: { id: 'thread-1', status: { type: 'active' } } },
      });
      expect((await app.inject(`/api/sessions/${sessionId}`)).json()).toMatchObject({
        agentActivity: { root: { state: 'working' }, subagents: [] },
      });
      const pending = handle!.request!({
        id: 7,
        method: 'item/tool/requestUserInput',
        params: { isBlocking: true, questions: [] },
      });
      const cleared = pending.catch((error: unknown) => error);
      expect((await app.inject(`/api/sessions/${sessionId}/history`)).json().interactions).toEqual([
        expect.objectContaining({ requestId: '7', resolvedAt: null }),
      ]);

      handle!.notify!({
        method: 'serverRequest/resolved',
        params: { threadId: 'thread-1', requestId: 7 },
      });

      expect(await cleared).toEqual(
        expect.objectContaining({ message: 'CODEX_SERVER_REQUEST_CLEARED' }),
      );
      expect((await app.inject(`/api/sessions/${sessionId}/history`)).json().interactions).toEqual([
        expect.objectContaining({
          requestId: '7',
          resolvedAt: expect.any(String),
          outcome: 'dismissed',
        }),
      ]);

      const attention = handle!.request!({
        id: 8,
        method: 'item/tool/call',
        params: {
          tool: 'gestalt_org_plan_attention',
          arguments: {
            reason: 'permissionRequired',
            summary: 'A protected release needs approval.',
            requestedAction: 'Grant the release permission.',
            resumeCondition: 'permissionGranted',
          },
        },
      });
      await vi.waitFor(async () => {
        expect((await app.inject(`/api/sessions/${sessionId}`)).json()).toMatchObject({
          pendingInteractions: [
            expect.objectContaining({
              requestId: '8',
              kind: 'orgPlanAttention',
              payload: expect.objectContaining({ reason: 'permissionRequired' }),
            }),
          ],
          agentActivity: { root: { state: 'awaitingHuman', reason: 'permissionRequired' } },
        });
      });
      const auditSocket = new WebSocket(
        `ws://127.0.0.1:${address.port}/api/sessions/${sessionId}/events?after=0`,
        {
          headers: {
            origin: relyingParty.publicOrigin,
            cookie: 'gestalt_mobile_session=test-session',
          },
        },
      );
      const auditEvents: Array<{ event: { type: string } }> = [];
      auditSocket.on('message', (data) => auditEvents.push(JSON.parse(String(data))));
      await once(auditSocket, 'open');
      await vi.waitFor(() =>
        expect(
          auditEvents.some((message) => message.event.type === 'org-plan.attention-required'),
        ).toBe(true),
      );
      expect((await app.inject(`/api/sessions/${sessionId}/attention`)).json()).toMatchObject({
        requestId: '8',
        attention: { reason: 'permissionRequired', resumeCondition: 'permissionGranted' },
      });
      const attentionResponse = toOrgPlanAttentionToolResponse({
        action: 'resume',
        guidance: 'The release permission is now granted.',
      });
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/sessions/${sessionId}/interactions/8`,
            payload: attentionResponse,
          })
        ).statusCode,
      ).toBe(400);
      expect(
        await app.inject({
          method: 'POST',
          url: `/api/sessions/${sessionId}/attention/8/resolve`,
          payload: {
            operationKey: 'attention-8',
            action: 'resume',
            guidance: 'The release permission is now granted.',
          },
        }),
      ).toMatchObject({ statusCode: 202 });
      expect(await attention).toEqual(attentionResponse);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/sessions/${sessionId}/attention/8/resolve`,
            payload: { operationKey: 'attention-8', action: 'resume' },
          })
        ).json(),
      ).toMatchObject({ accepted: true, replayed: true });
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/sessions/${sessionId}/attention/8/resolve`,
            payload: { operationKey: 'other-key', action: 'resume' },
          })
        ).json(),
      ).toEqual({ code: 'ATTENTION_OPERATION_STALE' });
      await vi.waitFor(() =>
        expect(
          auditEvents.some((message) => message.event.type === 'org-plan.attention-resolved'),
        ).toBe(true),
      );
      const requiredIndex = auditEvents.findIndex(
        (message) => message.event.type === 'org-plan.attention-required',
      );
      const resolvedIndex = auditEvents.findIndex(
        (message) => message.event.type === 'org-plan.attention-resolved',
      );
      expect(requiredIndex).toBeGreaterThanOrEqual(0);
      expect(resolvedIndex).toBeGreaterThan(requiredIndex);
      auditSocket.close();
      const attentionHistory = (await app.inject(`/api/sessions/${sessionId}/history`)).json();
      expect(attentionHistory.interactions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            requestId: '8',
            kind: 'orgPlanAttention',
            outcome: 'answered',
          }),
        ]),
      );
      expect(JSON.stringify(attentionHistory)).not.toContain(
        'The release permission is now granted.',
      );
      // A server-cleared attention request is a durable failed audit and must
      // re-project the root rather than leaving the GUI awaiting a vanished alert.
      const clearedAttention = handle!.request!({
        id: 9,
        method: 'item/tool/call',
        params: {
          tool: 'gestalt_org_plan_attention',
          arguments: {
            reason: 'externalState',
            summary: 'The remote state changed.',
            requestedAction: 'Refresh the remote state.',
            resumeCondition: 'externalStateChanged',
          },
        },
      });
      await vi.waitFor(async () =>
        expect((await app.inject(`/api/sessions/${sessionId}`)).json()).toMatchObject({
          agentActivity: { root: { state: 'awaitingHuman' } },
        }),
      );
      handle!.notify!({
        method: 'serverRequest/resolved',
        params: { threadId: 'thread-1', requestId: 9 },
      });
      await expect(clearedAttention).rejects.toMatchObject({
        message: 'CODEX_SERVER_REQUEST_CLEARED',
      });
      await vi.waitFor(async () =>
        expect((await app.inject(`/api/sessions/${sessionId}`)).json()).toMatchObject({
          agentActivity: { root: { state: 'working' } },
        }),
      );
      expect((await app.inject(`/api/sessions/${sessionId}/history`)).json().interactions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ requestId: '9', kind: 'orgPlanAttention', outcome: 'failed' }),
        ]),
      );

      const quiz = handle!.request!({
        id: 71,
        method: 'item/tool/call',
        params: {
          tool: 'gestalt_quiz',
          arguments: {
            questions: [
              {
                id: 'mode',
                header: 'Mode',
                question: 'How should this run?',
                choices: [
                  { label: 'Solo', description: 'Use one agent.' },
                  { label: 'Team', description: 'Use several agents.' },
                ],
                allowCustom: false,
              },
            ],
          },
        },
      });
      const clearedQuiz = quiz.catch((error: unknown) => error);
      handle!.notify!({
        method: 'serverRequest/resolved',
        params: { threadId: 'thread-1', requestId: 71 },
      });
      expect(await clearedQuiz).toEqual(
        expect.objectContaining({ message: 'CODEX_SERVER_REQUEST_CLEARED' }),
      );
      expect((await app.inject(`/api/sessions/${sessionId}/history`)).json().interactions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ requestId: '71', kind: 'quiz', resolvedAt: null }),
        ]),
      );
      await app.close();
    });
  });
});
