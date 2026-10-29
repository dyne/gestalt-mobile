/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import WebSocket from 'ws';

import { composeRelayApp, type ComposeRelayAppOptions } from './composition.js';
import { autopilotExecutorLaunchPrompt } from './features/autopilot/application/policy.js';
import { CodexJsonRpcError } from './platform/codex/json-rpc-client.js';
import { CodexSessionRuntime } from './platform/codex/session-runtime.js';
import { SqliteAuthorizationStore } from './platform/auth/sqlite-authorization-store.js';
import { SqliteEventJournal } from './platform/persistence/sqlite-event-journal.js';
import { exportControlPlaneTrace } from './features/control-plane-trace/export-trace.js';
import type { McpStartupStatus } from '../shared/contracts/mcp-startup-failure.js';
import type { ToolEfficiencySnapshot } from '../shared/contracts/tool-efficiency.js';
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
import {
  toOrgPlanAttentionAcknowledgement,
  toOrgPlanAttentionToolResponse,
} from '../shared/contracts/org-plan-attention.js';
import { toOrgPlanCheckpointToolResponse } from '../shared/contracts/org-plan-checkpoint.js';
import {
  applyProjectionEvent,
  createChatProjection,
  acceptSnapshot,
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
          if (method === 'thread/read')
            return {
              thread: {
                id: (params as { threadId: string }).threadId,
                status: { type: 'idle' },
                turns: [],
              },
            };
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

const acceptedL1WithNextTodoPlanText = () => `${completedAutopilotPlanText()}
* TODO [#B] Next parent
:PROPERTIES:
:ID: next-parent
:SKILLS: $gestalt:org-plan
:REVIEW_STATUS: UNREVIEWED
:END:
- Effort :: Small
- Goal :: Continue on the next root turn.
- Notes :: Must remain pending at the accepted-L1 boundary.
** TODO [#B] Next child
:PROPERTIES:
:ID: next-child
:END:
- Why :: Verify boundary separation.
- Change :: Start only after durable handoff.
- Tests :: Exercise the next continuation.
- Done when :: The next L1 starts exactly once.
`;

async function installAutopilotPlan(
  app: Awaited<ReturnType<typeof composeAuthorizedApp>>,
  sessionId: string,
  workspacePath: string,
  name: string,
  childState: 'TODO' | 'DONE' = 'TODO',
  reason = 'supervision-start',
  source?: string,
) {
  const planPath = join(workspacePath, `${name}.org`);
  await writeFile(planPath, source ?? autopilotPlanText(childState));
  await writeFile(
    planStatusFilePath(planStatusDirectoryPath(workspacePath, sessionId), planPath),
    JSON.stringify({
      schemaVersion: 1,
      planPath,
      reason,
      updatedAt: new Date().toISOString(),
      ...(source?.includes('#+MODEL_POLICY_VERSION: 1')
        ? { modelPolicyVersion: 1, requiredCapabilities: ['l1-model-policy-v1'] }
        : {}),
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

async function createProductionAutopilotFixture(
  overrides: Partial<ComposeRelayAppOptions> = {},
  source?: string,
) {
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
  await installAutopilotPlan(
    app,
    sessionId,
    workspacePath,
    'autopilot',
    'TODO',
    'supervision-start',
    source,
  );
  return { app, dataDir, handles, root, sessionId, workspacePath };
}

async function holdCheckpointRequest(
  fixture: Awaited<ReturnType<typeof createProductionAutopilotFixture>>,
  timers: Array<{ callback: () => void; cancelled: boolean }>,
  requestId: number,
  expectHeld = true,
  compact = false,
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
  const response = handle.request!(
    compact
      ? {
          id: requestId,
          method: 'item/tool/call',
          params: {
            threadId,
            turnId,
            tool: 'gestalt_org_plan_checkpoint',
            arguments: { kind: 'l2Completed' },
          },
        }
      : l2CheckpointCall(requestId, threadId, turnId, planIdentity),
  );
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
    it('serves compact supervision deltas and wakes only for the selected host run', async () => {
      let coordinator: import('./features/autopilot/application/service.js').AutopilotCoordinator;
      const f = await createProductionAutopilotFixture({
        autopilotSchedule: () => () => {},
        onAutopilotCoordinator: (value) => {
          coordinator = value;
        },
      });
      onTestFinished(() => f.app.close());
      const exec = promisify(execFile);
      await exec('git', ['init', '-q', f.workspacePath]);
      await exec(
        'git',
        [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          'commit',
          '--allow-empty',
          '-qm',
          'fixture',
        ],
        { cwd: f.workspacePath },
      );
      const marker = join(f.dataDir, 'release-test');
      await mkdir(join(f.workspacePath, '.gestalt'), { recursive: true });
      await writeFile(
        join(f.workspacePath, '.gestalt/host-tests.json'),
        JSON.stringify({
          version: 1,
          suites: [
            {
              id: 'controlled',
              repository: f.workspacePath,
              command: process.execPath,
              args: [
                '-e',
                "setInterval(()=>{if(require('node:fs').existsSync(process.argv[1]))process.exit(0)},20)",
                marker,
              ],
              timeoutMs: 10_000,
              maxOutputBytes: 4096,
            },
          ],
        }),
      );
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: `/api/sessions/${f.sessionId}/turns`,
            payload: { text: 'Synthetic run wait fixture' },
          })
        ).statusCode,
      ).toBe(202);
      const session = (await f.app.inject(`/api/sessions/${f.sessionId}`)).json();
      const handle = f.handles.find((value) => value.calls.includes('turn/start'))!;
      let requestId = 5000;
      const call = async (tool: string, args: unknown) => {
        const response = (await handle.request!({
          id: ++requestId,
          method: 'item/tool/call',
          params: {
            threadId: session.threadId,
            turnId: session.activeTurnId,
            tool,
            arguments: args,
          },
        })) as { contentItems: Array<{ text: string }> };
        return JSON.parse(response.contentItems[0]!.text);
      };
      const initial = await call('gestalt_org_plan_health', { view: 'compact' });
      expect(initial.snapshot).toMatchObject({
        plan: { l1: { id: 'parent' } },
        tests: { running: 0, unread: 0 },
        control: { enabled: true },
      });
      expect(Buffer.byteLength(JSON.stringify(initial))).toBeLessThan(2500);
      const unchanged = await call('gestalt_org_plan_health', {
        view: 'compact',
        sinceRevision: initial.revision,
      });
      expect(unchanged).toEqual({ revision: initial.revision, unchanged: true });
      expect(Buffer.byteLength(JSON.stringify(unchanged))).toBeLessThan(120);
      expect(await call('gestalt_org_plan_health', {})).toMatchObject({
        enabled: true,
        health: expect.any(Object),
      });
      const run = await call('gestalt_test_runner', {
        operation: 'start',
        suite: 'controlled',
        requestId: '00000000-0000-4000-8000-000000000002',
      });
      expect(run.state).toBe('running');
      const changed = await call('gestalt_org_plan_health', {
        view: 'compact',
        sinceRevision: initial.revision,
      });
      expect(changed.changes.tests).toMatchObject({
        running: 1,
        runs: [{ runId: run.runId, state: 'running' }],
      });
      expect(changed.snapshot).toBeUndefined();
      expect(
        await call('gestalt_test_runner', {
          operation: 'wait',
          runId: run.runId,
          maxWaitMs: 60_000,
        }),
      ).toEqual({ accepted: true, runId: run.runId });
      // A retried request must not register another lease or reset its deadline.
      expect(
        await call('gestalt_test_runner', {
          operation: 'wait',
          runId: run.runId,
          maxWaitMs: 60_000,
        }),
      ).toEqual({ accepted: true, runId: run.runId });
      expect(coordinator!.rootProcessCompleted(f.sessionId, 'another-run')).toBe(false);
      expect(coordinator!.semanticEvent(f.sessionId, 'processResultAvailable')).toBe(false);
      const parked = await call('gestalt_org_plan_health', {
        view: 'compact',
        sinceRevision: changed.revision,
      });
      expect(parked.changes.wait).toMatchObject({ runId: run.runId });
      const database = new DatabaseSync(join(f.dataDir, 'relay.sqlite'));
      onTestFinished(() => database.close());
      const count = (type: string) =>
        database
          .prepare('SELECT COUNT(*) AS count FROM session_events WHERE session_id=? AND type=?')
          .get(f.sessionId, type)?.count;
      expect(count('autopilot.wait-registered')).toBe(1);
      expect(count('autopilot.wait-woken')).toBe(0);
      await writeFile(marker, 'done');
      await vi.waitFor(() => expect(count('autopilot.wait-woken')).toBe(1), { timeout: 5000 });
      expect(
        await call('gestalt_test_runner', { operation: 'wait', runId: run.runId }),
      ).toMatchObject({
        accepted: false,
        reason: 'runCompleted',
        next: 'continueSameTurn',
        result: { state: 'passed', exitCode: 0 },
      });
      expect(
        await call('gestalt_test_runner', {
          operation: 'wait',
          runId: '00000000-0000-4000-8000-000000000099',
        }),
      ).toEqual({ error: 'runNotFound' });
      expect(count('autopilot.wait-woken')).toBe(1);
    });

    it('does not park after a host test completes before process-wait registration', async () => {
      let coordinator: import('./features/autopilot/application/service.js').AutopilotCoordinator;
      const f = await createProductionAutopilotFixture({
        autopilotSchedule: () => () => {},
        onAutopilotCoordinator: (value) => {
          coordinator = value;
        },
      });
      onTestFinished(() => f.app.close());
      const exec = promisify(execFile);
      await exec('git', ['init', '-q', f.workspacePath]);
      await exec(
        'git',
        [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          'commit',
          '--allow-empty',
          '-qm',
          'fixture',
        ],
        { cwd: f.workspacePath },
      );
      await mkdir(join(f.workspacePath, '.gestalt'), { recursive: true });
      await writeFile(
        join(f.workspacePath, '.gestalt/host-tests.json'),
        JSON.stringify({
          version: 1,
          suites: [
            {
              id: 'fast',
              repository: f.workspacePath,
              command: process.execPath,
              args: ['-e', 'process.exit(0)'],
              timeoutMs: 5000,
              maxOutputBytes: 4096,
            },
          ],
        }),
      );
      const session = (await f.app.inject(`/api/sessions/${f.sessionId}`)).json();
      const call = async (id: number, args: unknown) => {
        const response = (await f.handles.find((handle) => handle.request)!.request!({
          id,
          method: 'item/tool/call',
          params: { threadId: session.threadId, tool: 'gestalt_test_runner', arguments: args },
        })) as { contentItems: Array<{ text: string }> };
        return JSON.parse(response.contentItems[0]!.text);
      };
      const run = await call(900, {
        operation: 'start',
        suite: 'fast',
        requestId: '00000000-0000-4000-8000-000000000001',
      });
      expect(run.state).toBe('running');
      const database = new DatabaseSync(join(f.dataDir, 'relay.sqlite'));
      onTestFinished(() => database.close());
      await vi.waitFor(
        () =>
          expect(
            database
              .prepare(
                "SELECT COUNT(*) AS count FROM session_events WHERE session_id=? AND type='host-test.completed'",
              )
              .get(f.sessionId)?.count,
          ).toBe(1),
        { timeout: 5000 },
      );
      const report = {
        id: 'focused-running',
        leaseId: 'focused-wait',
        wakeConditions: ['processResultAvailable'] as const,
        maxWaitMs: 600_000,
      };
      expect(coordinator!.registerProactiveWait(f.sessionId, report)).toBe('wakeAlreadySatisfied');
      expect(await call(901, { operation: 'status', runId: run.runId })).toMatchObject({
        state: 'passed',
      });
      expect(coordinator!.registerProactiveWait(f.sessionId, report)).toBe(true);
    });

    const versionedText = (state: 'TODO' | 'DONE' = 'TODO', strict = false) =>
      '#+MODEL_POLICY_VERSION: 1\n' +
      (strict ? '#+MODEL_POLICY_ASSURANCE: runtime-attested\n' : '') +
      autopilotPlanText(state).replace(
        ':REVIEW_STATUS: UNREVIEWED',
        `:REVIEW_STATUS: UNREVIEWED
:MODEL: gpt-6.1-sol
:REASONING_EFFORT: medium
:MODEL_RATIONALE: Composition contract with explicit launch choices.
:MODEL_FALLBACKS: none
:MODEL_ESCALATION_TRIGGER: A focused invariant fails.`,
      );
    const policyCatalog = {
      data: [{ id: 'gpt-6.1-sol', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }],
    };

    it('reconciles the existing second executor through health while root and attention are active', async () => {
      const f = await createProductionAutopilotFixture(
        { autopilotSchedule: () => () => {} },
        versionedText(),
      );
      onTestFinished(() => f.app.close());
      const { app, sessionId } = f;
      const started = await app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/turns`,
        payload: { text: 'Synthetic supervised handoff fixture' },
      });
      expect(started.statusCode).toBe(202);
      const session = (await app.inject(`/api/sessions/${sessionId}`)).json();
      const rootId = session.threadId as string;
      const handle = f.handles.find((candidate) =>
        candidate.requests.some((call) => call.method === 'turn/start'),
      )!;
      let handedOff = false;
      let changeDuringRead = false;
      const row = (id: string, task: string, active: boolean) => ({
        id,
        status: { type: active ? 'active' : 'idle' },
        parentThreadId: rootId,
        source: { subAgent: { thread_spawn: { agent_path: `/root/${task}` } } },
        agentRole: 'default',
        model: 'gpt-6.1-sol',
        reasoningEffort: 'medium',
      });
      handle.respond = (method, params) => {
        if (method === 'model/list') return policyCatalog;
        if (method === 'thread/list' && changeDuringRead) {
          changeDuringRead = false;
          handle.notify!({
            method: 'turn/completed',
            params: { threadId: rootId, turn: { id: session.activeTurnId, status: 'completed' } },
          });
        }
        if (method === 'thread/list')
          return {
            data: handedOff
              ? [row('first-writer', 'l1', false), row('second-writer', 'l2', true)]
              : [row('first-writer', 'l1', true)],
          };
        if (method === 'thread/read') {
          const id = (params as { threadId: string }).threadId;
          return {
            thread:
              id === rootId
                ? { id, status: { type: 'active' } }
                : row(
                    id,
                    id === 'first-writer' ? 'l1' : 'l2',
                    !handedOff || id === 'second-writer',
                  ),
          };
        }
        return undefined;
      };
      const health = async (id: number) => {
        const response = (await handle.request!({
          id,
          method: 'item/tool/call',
          params: {
            threadId: rootId,
            turnId: session.activeTurnId,
            tool: 'gestalt_org_plan_health',
            arguments: {},
          },
        })) as { success: boolean; contentItems: { text: string }[] };
        expect(response.success).toBe(true);
        return JSON.parse(response.contentItems[0]!.text);
      };
      expect(await health(9960)).toMatchObject({
        executorBinding: { status: 'ready' },
        modelPolicy: { child: { threadId: 'first-writer' } },
      });
      const completed = versionedText('DONE')
        .replace('* WIP [#A] Parent', '* DONE [#A] Parent')
        .replace(':REVIEW_STATUS: UNREVIEWED', ':REVIEW_STATUS: REVIEWED');
      const next = versionedText()
        .slice(versionedText().indexOf('* WIP'))
        .replace(':ID: parent', ':ID: second')
        .replace(':ID: child', ':ID: second-child')
        .replace('** TODO', '** WIP');
      // A synthetic accepted-review projection, followed by the real composition's binding reconciliation.
      await writeFile(join(f.workspacePath, 'autopilot.org'), completed + next);
      await app.inject(`/api/sessions/${sessionId}/plan`);
      await expect(handle.request!(attentionCall(9961))).resolves.toEqual(
        toOrgPlanAttentionAcknowledgement(),
      );
      const before = (await app.inject(`/api/sessions/${sessionId}`)).json();
      const startsBefore = f.handles
        .flatMap((candidate) => candidate.requests)
        .filter((call) =>
          ['turn/start', 'turn/steer', 'thread/resume'].includes(call.method),
        ).length;
      const processesBefore = f.handles.length;
      handedOff = true;
      changeDuringRead = true;
      expect(await health(9964)).toMatchObject({
        executorBinding: { status: 'unavailable', code: 'CONTEXT_CHANGED' },
      });
      expect((await app.inject(`/api/sessions/${sessionId}`)).json().agentActivity.root.state).toBe(
        'awaitingHuman',
      );
      const reconciled = await health(9962);
      expect(reconciled).toMatchObject({
        executionAdmission: { allowed: true },
        executorBinding: { status: 'ready', canonicalPosition: 'L2', authorizesExecution: false },
        executorLaunch: { validated: true },
        modelPolicy: {
          configuration: 'match',
          child: { threadId: 'second-writer', continuationCount: 0 },
        },
      });
      expect(JSON.stringify(reconciled)).not.toContain('CONTROLLER_BINDING_INVALID');
      const after = (await app.inject(`/api/sessions/${sessionId}`)).json();
      expect(after.autopilot.enabled).toBe(before.autopilot.enabled);
      expect(after.pendingInteractions).toMatchObject([
        { kind: 'orgPlanAttention', requestId: '9961' },
      ]);
      expect(f.handles.length).toBe(processesBefore);
      expect(
        f.handles
          .flatMap((candidate) => candidate.requests)
          .filter((call) => ['turn/start', 'turn/steer', 'thread/resume'].includes(call.method)),
      ).toHaveLength(startsBefore);
      expect(await health(9963)).toMatchObject({
        executorBinding: { status: 'ready', code: 'BINDING_MATCH' },
        modelPolicy: { child: { threadId: 'second-writer' } },
      });
    });

    it('activates existing v1, validates catalog, dispatches launch instructions and records a report checkpoint', async () => {
      const timers: Array<{ callback: () => void; cancelled: boolean }> = [];
      const fixture = await createProductionAutopilotFixture(
        {
          autopilotSchedule: (callback) => {
            const timer = { callback, cancelled: false };
            timers.push(timer);
            return () => {
              timer.cancelled = true;
            };
          },
        },
        versionedText(),
      );
      const { app, sessionId, handles, workspacePath } = fixture;
      onTestFinished(() => app.close());
      for (const handle of handles)
        handle.respond = (method) => (method === 'model/list' ? policyCatalog : undefined);
      expect((await app.inject(`/api/sessions/${sessionId}`)).json()).toMatchObject({
        autopilot: {
          enabled: true,
          executionAdmission: { allowed: true, assurance: 'configured', runtimeEnforcement: false },
        },
      });
      timers.find((timer) => !timer.cancelled)!.callback();
      await vi.waitFor(() =>
        expect(
          handles
            .flatMap((handle) => handle.requests)
            .filter((call) => call.method === 'turn/start'),
        ).toHaveLength(1),
      );
      const handle = handles.find((candidate) =>
        candidate.requests.some((call) => call.method === 'turn/start'),
      )!;
      const start = handle.requests.find((call) => call.method === 'turn/start')!;
      expect(start.params).toMatchObject({
        input: [
          {
            text: expect.stringContaining('explicit model gpt-6.1-sol and reasoning_effort medium'),
          },
        ],
      });
      expect(JSON.stringify(start.params)).not.toContain('reasoning_effort high');
      const session = (await app.inject(`/api/sessions/${sessionId}`)).json();
      const requestsBeforeHealth = handle.requests.length;
      const healthResponse = (await handle.request!({
        id: 9900,
        method: 'item/tool/call',
        params: {
          threadId: session.threadId,
          turnId: session.activeTurnId,
          tool: 'gestalt_org_plan_health',
          arguments: {},
        },
      })) as { success: boolean; contentItems: { text: string }[] };
      expect(healthResponse.success).toBe(true);
      expect(JSON.parse(healthResponse.contentItems[0]!.text)).toMatchObject({
        executionAdmission: { allowed: true, assurance: 'configured' },
        executorLaunch: {
          scope: 'prelaunch-catalog',
          validated: true,
          code: 'CATALOG_MATCH',
          requested: { model: 'gpt-6.1-sol', reasoningEffort: 'medium' },
          catalog: {
            source: 'runtime-model-list',
            fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
            revisionSource: 'normalized-content-digest',
          },
        },
        modelPolicy: {
          code: 'CHILD_NOT_LAUNCHED',
          catalogRevision: null,
          effective: { model: null, reasoningEffort: null },
          attested: false,
        },
      });
      expect(handle.requests.slice(requestsBeforeHealth).map((call) => call.method)).toEqual([
        'thread/read',
        'thread/list',
        'model/list',
      ]);
      // Synthetic executor report: real composition validates the authoritative plan boundary.
      await writeFile(join(workspacePath, 'autopilot.org'), versionedText('DONE'));
      const result = await handle.request!({
        id: 9901,
        method: 'item/tool/call',
        params: {
          threadId: session.threadId,
          turnId: session.activeTurnId,
          tool: 'gestalt_org_plan_checkpoint',
          arguments: { kind: 'l2Completed' },
        },
      });
      expect(result).toEqual(toOrgPlanCheckpointToolResponse('recorded'));
      const db = new DatabaseSync(join(fixture.dataDir, 'relay.sqlite'));
      try {
        expect(
          db
            .prepare(
              "SELECT count(*) AS n FROM session_events WHERE type='org-plan.step-checkpointed'",
            )
            .get(),
        ).toMatchObject({ n: 1 });
      } finally {
        db.close();
      }
      handle.notify!({
        method: 'turn/completed',
        params: {
          threadId: session.threadId,
          turn: { id: session.activeTurnId, status: 'completed' },
        },
      });
      await vi.waitFor(async () =>
        expect((await app.inject(`/api/sessions/${sessionId}`)).json().activeTurnId).toBeNull(),
      );
      expect((await app.inject(`/api/sessions/${sessionId}/plan`)).json().steps[0]).toMatchObject({
        reviewStatus: 'UNREVIEWED',
      });
      expect(
        handles.flatMap((handle) => handle.requests).filter((call) => call.method === 'turn/start'),
      ).toHaveLength(1);
    });

    it.each(['missing', 'model', 'effort', 'manual-off'] as const)(
      'exposes prechild catalog evidence without changing admission or Manual Off: %s',
      async (scenario) => {
        const f = await createProductionAutopilotFixture(
          { autopilotSchedule: () => () => {} },
          versionedText(),
        );
        onTestFinished(() => f.app.close());
        const session = (await f.app.inject(`/api/sessions/${f.sessionId}`)).json();
        const handle = f.handles.find((candidate) => candidate.request)!;
        for (const candidate of f.handles)
          candidate.respond = (method) =>
            method !== 'model/list'
              ? undefined
              : scenario === 'missing'
                ? {}
                : scenario === 'model'
                  ? {
                      data: [
                        {
                          id: 'gpt-6-sol',
                          supportedReasoningEfforts: [{ reasoningEffort: 'medium' }],
                        },
                      ],
                    }
                  : scenario === 'effort'
                    ? {
                        data: [
                          {
                            id: 'gpt-6.1-sol',
                            supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
                          },
                        ],
                      }
                    : policyCatalog;
        if (scenario === 'manual-off')
          await f.app.inject({
            method: 'PUT',
            url: `/api/sessions/${f.sessionId}/autopilot`,
            payload: { enabled: false },
          });
        const beforeHealth = f.handles
          .flatMap((candidate) => candidate.requests)
          .filter((call) => ['turn/start', 'thread/resume'].includes(call.method));
        const response = (await handle.request!({
          id: 9902,
          method: 'item/tool/call',
          params: {
            threadId: session.threadId,
            tool: 'gestalt_org_plan_health',
            arguments: {},
          },
        })) as { contentItems: { text: string }[] };
        const health = JSON.parse(response.contentItems[0]!.text);
        expect(health).toMatchObject({
          executionAdmission: { allowed: true },
          executorLaunch: {
            validated: scenario === 'manual-off',
            code:
              scenario === 'missing'
                ? 'CATALOG_UNAVAILABLE'
                : scenario === 'model'
                  ? 'MODEL_UNAVAILABLE'
                  : scenario === 'effort'
                    ? 'EFFORT_UNSUPPORTED'
                    : 'CATALOG_MATCH',
          },
        });
        if (scenario === 'manual-off')
          expect(health).toMatchObject({ enabled: false, reason: 'manualDisabled' });
        expect(
          f.handles
            .flatMap((candidate) => candidate.requests)
            .filter((call) => ['turn/start', 'thread/resume'].includes(call.method)),
        ).toEqual(beforeHealth);
      },
    );

    it('keeps explicit strict v1 blocked at production activation without scheduling', async () => {
      const timers: (() => void)[] = [];
      const f = await createProductionAutopilotFixture(
        {
          autopilotSchedule: (callback) => {
            timers.push(callback);
            return () => {};
          },
        },
        versionedText('TODO', true),
      );
      onTestFinished(() => f.app.close());
      const response = await f.app.inject({
        method: 'PUT',
        url: `/api/sessions/${f.sessionId}/autopilot`,
        payload: { enabled: true },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        reason: 'RUNTIME_ATTESTATION_UNAVAILABLE',
        action: expect.stringContaining('explicitly requires'),
      });
      expect(timers).toHaveLength(0);
      expect(
        f.handles
          .flatMap((handle) => handle.requests)
          .filter((call) => call.method === 'turn/start'),
      ).toHaveLength(0);
    });

    it.each([
      'match',
      'mismatch',
      'supervisor-terra',
      'unsupported-terra-effort',
      'off-during-read',
      'policy-during-read',
      'same-plan-during-read',
      'off-on-during-recovery',
    ] as const)('guards configured executor dispatch in production: %s', async (scenario) => {
      const timers: Array<{ callback: () => void; cancelled: boolean }> = [];
      let observedRootThreadId = '';
      const f = await createProductionAutopilotFixture(
        {
          autopilotActivity: (sessionId) => {
            const observedAt = new Date().toISOString();
            return {
              sessionId,
              rootThreadId: observedRootThreadId,
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
            const timer = { callback, cancelled: false };
            timers.push(timer);
            return () => {
              timer.cancelled = true;
            };
          },
        },
        ['supervisor-terra', 'unsupported-terra-effort'].includes(scenario)
          ? versionedText()
              .replace(':MODEL: gpt-6.1-sol', ':MODEL: gpt-6.1-terra')
              .replace(':REASONING_EFFORT: medium', ':REASONING_EFFORT: high')
          : versionedText(),
      );
      onTestFinished(() => f.app.close());
      const actualRootThreadId = (await f.app.inject(`/api/sessions/${f.sessionId}`)).json()
        .threadId as string;
      observedRootThreadId = actualRootThreadId;
      const pendingRead = Promise.withResolvers<unknown>();
      const pendingRecovery = Promise.withResolvers<unknown>();
      const resumeOperation = vi.spyOn(CodexSessionRuntime.prototype, 'startExecutorTurn');
      onTestFinished(() => {
        pendingRead.resolve({});
        pendingRecovery.resolve({});
        resumeOperation.mockRestore();
      });
      let sawRead = false,
        sawRecovery = false;
      let childStarts = 0;
      for (const handle of f.handles)
        handle.respond = async (method, params) => {
          if (method === 'model/list')
            return ['supervisor-terra', 'unsupported-terra-effort'].includes(scenario)
              ? {
                  data: [
                    {
                      id: 'gpt-6.1-terra',
                      supportedReasoningEfforts: [
                        { reasoningEffort: scenario === 'supervisor-terra' ? 'high' : 'medium' },
                      ],
                    },
                  ],
                }
              : policyCatalog;
          if (method === 'thread/read' && (params as { threadId: string }).threadId === 'child-1') {
            sawRead = true;
            if (
              ['off-during-read', 'policy-during-read', 'same-plan-during-read'].includes(scenario)
            )
              await pendingRead.promise;
            return {
              thread: {
                id: 'child-1',
                parentThreadId: actualRootThreadId,
                source: { subAgent: { thread_spawn: { agent_path: '/root/l1' } } },
                status: { type: 'idle' },
                model: scenario === 'mismatch' ? 'gpt-6-sol' : 'gpt-6.1-sol',
                reasoningEffort: 'medium',
                agentRole: 'default',
              },
            };
          }
          if (method === 'turn/start' && (params as { threadId: string }).threadId === 'child-1') {
            childStarts++;
            if (scenario === 'off-on-during-recovery')
              throw new CodexJsonRpcError(-32600, 'thread not found: child-1');
          }
          if (
            method === 'thread/resume' &&
            (params as { threadId: string }).threadId === 'child-1'
          ) {
            sawRecovery = true;
            await pendingRecovery.promise;
          }
          return undefined;
        };
      const delivered = new Set<object>();
      await vi.waitFor(() => {
        for (const timer of timers) {
          if (!timer.cancelled && !delivered.has(timer)) {
            delivered.add(timer);
            timer.callback();
          }
        }
        expect(sawRead).toBe(true);
      });
      if (scenario === 'off-during-read' || scenario === 'off-on-during-recovery') {
        if (scenario === 'off-on-during-recovery')
          await vi.waitFor(() => expect(sawRecovery).toBe(true));
        await f.app.inject({
          method: 'PUT',
          url: `/api/sessions/${f.sessionId}/autopilot`,
          payload: { enabled: false },
        });
        if (scenario === 'off-on-during-recovery')
          await f.app.inject({
            method: 'PUT',
            url: `/api/sessions/${f.sessionId}/autopilot`,
            payload: { enabled: true },
          });
      }
      if (scenario === 'policy-during-read') {
        await writeFile(
          join(f.workspacePath, 'autopilot.org'),
          versionedText().replace(':MODEL: gpt-6.1-sol', ':MODEL: gpt-6-sol'),
        );
        await f.app.inject(`/api/sessions/${f.sessionId}/plan`);
      }
      if (scenario === 'same-plan-during-read') {
        const planPath = join(f.workspacePath, 'autopilot.org');
        await writeFile(
          planStatusFilePath(planStatusDirectoryPath(f.workspacePath, f.sessionId), planPath),
          JSON.stringify({
            schemaVersion: 1,
            planPath,
            reason: 'supervision-start',
            updatedAt: new Date().toISOString(),
            modelPolicyVersion: 1,
            requiredCapabilities: ['l1-model-policy-v1'],
          }),
        );
        await f.app.inject(`/api/sessions/${f.sessionId}/plan`);
      }
      pendingRead.resolve({});
      pendingRecovery.resolve({});
      if (['match', 'mismatch', 'supervisor-terra', 'same-plan-during-read'].includes(scenario)) {
        await vi.waitFor(() => expect(childStarts).toBe(1));
        const call = f.handles
          .flatMap((handle) => handle.requests)
          .find((call) => call.method === 'turn/start');
        expect(call?.params).toMatchObject({
          threadId: 'child-1',
          model: scenario === 'supervisor-terra' ? 'gpt-6.1-terra' : 'gpt-6.1-sol',
          effort: scenario === 'supervisor-terra' ? 'high' : 'medium',
        });
      } else {
        await vi.waitFor(() =>
          expect(resumeOperation.mock.settledResults[0]?.type).toBe('rejected'),
        );
        expect(childStarts).toBe(scenario === 'off-on-during-recovery' ? 1 : 0);
      }
    });
    it.each(['idle', 'active', 'retry', 'configured'] as const)(
      'delivers acknowledged attention guidance to the %s supervisor and retains its explanation beyond the journal tail',
      async (mode) => {
        const fixture = await createProductionAutopilotFixture(
          {},
          mode === 'configured' ? versionedText() : undefined,
        );
        const { app, sessionId, handles } = fixture;
        onTestFinished(() => app.close());
        const handle = handles.filter((value) => value.request).at(-1)!;
        const database = new DatabaseSync(join(fixture.dataDir, 'relay.sqlite'));
        database
          .prepare('UPDATE relay_sessions SET active_turn_id = ? WHERE id = ?')
          .run('attention-turn', sessionId);
        const threadId = (await app.inject(`/api/sessions/${sessionId}`)).json().threadId as string;
        handle.notify!({
          method: 'turn/started',
          params: { threadId, turn: { id: 'attention-turn' } },
        });
        await expect(handle.request!(attentionCall(991))).resolves.toEqual(
          toOrgPlanAttentionAcknowledgement(),
        );
        handle.notify!({
          method: 'item/completed',
          params: {
            threadId,
            turnId: 'attention-turn',
            item: {
              id: 'explanation',
              type: 'agentMessage',
              phase: 'final_answer',
              text: 'The required build capability is unavailable.',
            },
          },
        });
        if (mode !== 'active')
          database
            .prepare('UPDATE relay_sessions SET active_turn_id = NULL WHERE id = ?')
            .run(sessionId);
        database.prepare('DELETE FROM session_events WHERE session_id = ?').run(sessionId);
        database.close();
        expect((await app.inject(`/api/sessions/${sessionId}/attention`)).json()).toMatchObject({
          supervisorReport: 'The required build capability is unavailable.',
        });
        const input = {
          operationKey: 'guidance-key',
          action: 'resume',
          guidance: 'Use the available local build tool.',
        };
        const url = `/api/sessions/${sessionId}/attention/991/resolve`;
        if (mode === 'retry') {
          handle.respond = (method) => {
            if (method === 'turn/start') throw new Error('TEST_WRITER_UNAVAILABLE');
          };
          expect((await app.inject({ method: 'POST', url, payload: input })).statusCode).toBe(409);
          expect((await app.inject(`/api/sessions/${sessionId}/attention`)).json()).toMatchObject({
            requestId: '991',
          });
          handle.respond = undefined;
        }
        expect((await app.inject({ method: 'POST', url, payload: input })).statusCode).toBe(202);
        expect((await app.inject({ method: 'POST', url, payload: input })).json()).toMatchObject({
          accepted: true,
          replayed: true,
        });
        const starts = handles
          .flatMap((value) => value.requests)
          .filter(
            (request) => request.method === (mode === 'active' ? 'turn/steer' : 'turn/start'),
          );
        expect(starts).toHaveLength(mode === 'retry' ? 2 : 1);
        expect(starts[0]!.params).toMatchObject({
          input: [expect.objectContaining({ text: expect.stringContaining(input.guidance) })],
        });
      },
    );

    it('retains a completed-turn quiz for late answers without blocking the next continuation', async () => {
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
      const { app, sessionId, handles } = fixture;
      onTestFinished(() => app.close());
      const database = new DatabaseSync(join(fixture.dataDir, 'relay.sqlite'));
      // Reproduce the persisted boundary: a quiz belongs to a turn that has
      // completed, but is retained so the browser can submit a late answer.
      database
        .prepare(
          'INSERT INTO pending_interactions (session_id,request_id,kind,payload_json,turn_id,requested_at) VALUES (?,?,?,?,?,?)',
        )
        .run(
          sessionId,
          'stale-quiz',
          'quiz',
          JSON.stringify({ questions: [] }),
          'completed-turn',
          new Date().toISOString(),
        );
      database.close();
      expect((await app.inject(`/api/sessions/${sessionId}`)).json().pendingInteractions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ requestId: 'stale-quiz', kind: 'quiz' }),
        ]),
      );
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: `/api/sessions/${sessionId}/autopilot`,
            payload: { enabled: true },
          })
        ).statusCode,
      ).toBe(200);
      await vi.waitFor(() => expect(timers.some((timer) => !timer.cancelled)).toBe(true));
      timers.find((timer) => !timer.cancelled)!.callback();
      await vi.waitFor(() =>
        expect(
          handles.flatMap((handle) => handle.calls).filter((call) => call === 'turn/start'),
        ).toHaveLength(1),
      );
      expect((await app.inject(`/api/sessions/${sessionId}`)).json().pendingInteractions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ requestId: 'stale-quiz', kind: 'quiz' }),
        ]),
      );
    });

    it('health reads match UI authority, reject session selection, and expose recoverable corrupt state', async () => {
      const fixture = await createProductionAutopilotFixture();
      const { app, sessionId, handles, dataDir } = fixture;
      const database = new DatabaseSync(join(dataDir, 'relay.sqlite'));
      try {
        const handle = handles.filter((value) => value.request).at(-1)!;
        const read = () =>
          handle.request!({
            id: 901,
            method: 'item/tool/call',
            params: {
              tool: 'gestalt_org_plan_health',
              arguments: {},
            },
          }) as Promise<{ success: boolean; contentItems: Array<{ text: string }> }>;
        const before = (await app.inject(`/api/sessions/${sessionId}`)).json();
        const response = await read();
        expect(response.success).toBe(true);
        const health = JSON.parse(response.contentItems[0]!.text);
        expect(health).toMatchObject({
          state: before.autopilot.state,
          enabled: before.autopilot.enabled,
        });
        expect(health.health).toMatchObject({
          phase: before.autopilot.health.phase,
          healthy: before.autopilot.health.healthy,
        });
        await expect(
          handle.request!({
            id: 902,
            method: 'item/tool/call',
            params: {
              tool: 'gestalt_org_plan_health',
              arguments: { sessionId: 'another' },
            },
          }),
        ).rejects.toThrow();
        await app.inject({
          method: 'PUT',
          url: `/api/sessions/${sessionId}/autopilot`,
          payload: { enabled: false },
        });
        database
          .prepare('UPDATE autopilot_sessions SET lifecycle_json = ? WHERE session_id = ?')
          .run('{broken', sessionId);
        expect(JSON.parse((await read()).contentItems[0]!.text)).toMatchObject({
          health: { phase: 'degraded', degradationReason: 'controllerUnavailable' },
        });
        expect(database.prepare('SELECT * FROM autopilot_state_quarantine').all()).toHaveLength(0);
        const recovered = await app.inject({
          method: 'PUT',
          url: `/api/sessions/${sessionId}/autopilot`,
          payload: { enabled: false },
        });
        expect(recovered.statusCode).toBe(200);
        expect(recovered.json()).toMatchObject({
          autopilot: { enabled: false, health: { phase: 'off' } },
        });
        expect(database.prepare('SELECT * FROM autopilot_state_quarantine').all()).toHaveLength(1);
      } finally {
        database.close();
        await app.close();
      }
    });
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
        () =>
          expect(
            handles.flatMap((handle) => handle.calls).filter((call) => call === 'turn/start'),
          ).toHaveLength(1),
        { timeout: 2_500 },
      );
      const automaticStart = handles
        .flatMap((handle) => handle.requests)
        .find((call) => call.method === 'turn/start');
      expect(automaticStart?.params).toEqual({
        threadId: expect.any(String),
        input: [
          {
            type: 'text',
            text: autopilotExecutorLaunchPrompt({
              canonicalTaskName: 'l1',
              canonicalPosition: 'L1',
              generation: 1,
              taskName: 'l1',
            }),
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
    it.each(['autopilot', 'ordinary', 'manual-send', 'stopped'])(
      'production provider recovery uses minimal continuation and respects %s ownership',
      async (mode) => {
        const timers: Array<{ callback: () => void; delay: number; cancelled: boolean }> = [];
        const fixture = await createProductionAutopilotFixture({
          autopilotSchedule: (callback, delay) => {
            const timer = { callback, delay, cancelled: false };
            timers.push(timer);
            return () => {
              timer.cancelled = true;
            };
          },
        });
        onTestFinished(() => fixture.app.close());
        const initial = timers.find((timer) => !timer.cancelled)!;
        initial.cancelled = true;
        initial.callback();
        const starts = () =>
          fixture.handles
            .flatMap((handle) => handle.requests)
            .filter((request) => request.method === 'turn/start');
        await vi.waitFor(() => expect(starts()).toHaveLength(1));
        const session = (await fixture.app.inject(`/api/sessions/${fixture.sessionId}`)).json();
        const handle = fixture.handles.find((candidate) => candidate.calls.includes('turn/start'))!;
        if (mode !== 'autopilot')
          await fixture.app.inject({
            method: 'PUT',
            url: `/api/sessions/${fixture.sessionId}/autopilot`,
            payload: { enabled: false },
          });
        handle.notify!({
          method: 'error',
          params: {
            threadId: session.threadId,
            turnId: session.activeTurnId,
            error: { codexErrorInfo: 'serverOverloaded', message: 'private capacity detail' },
            willRetry: false,
          },
        });
        handle.notify!({
          method: 'turn/completed',
          params: {
            threadId: session.threadId,
            turn: {
              id: session.activeTurnId,
              status: 'failed',
            },
          },
        });
        const retry = timers.find((timer) => !timer.cancelled && timer.delay === 60_000)!;
        expect(retry).toBeDefined();
        expect(starts()).toHaveLength(1);
        if (mode === 'manual-send') {
          expect(
            (
              await fixture.app.inject({
                method: 'POST',
                url: `/api/sessions/${fixture.sessionId}/turns`,
                payload: { text: 'new instruction' },
              })
            ).statusCode,
          ).toBe(202);
          retry.callback();
          expect(starts()).toHaveLength(2);
          expect(starts().at(-1)!.params).toMatchObject({
            input: [{ type: 'text', text: 'new instruction' }],
          });
        } else if (mode === 'stopped') {
          expect(
            (
              await fixture.app.inject({
                method: 'POST',
                url: `/api/sessions/${fixture.sessionId}/stop`,
              })
            ).statusCode,
          ).toBe(202);
          retry.callback();
          expect(starts()).toHaveLength(1);
        } else {
          vi.useFakeTimers({ toFake: ['Date'] });
          onTestFinished(() => {
            vi.useRealTimers();
          });
          vi.setSystemTime(Date.now() + 60_000);
          retry.cancelled = true;
          retry.callback();
          if (mode === 'autopilot') {
            await vi.waitFor(() => expect(timers.some((timer) => !timer.cancelled)).toBe(true));
            const continuation = timers.find((timer) => !timer.cancelled)!;
            vi.setSystemTime(Date.now() + continuation.delay);
            continuation.cancelled = true;
            continuation.callback();
          }
          await vi.waitFor(async () => {
            const database = new DatabaseSync(join(fixture.dataDir, 'relay.sqlite'), {
              readOnly: true,
            });
            const rows = database
              .prepare(
                "SELECT type,payload_json FROM session_events WHERE session_id=? AND type LIKE 'session.provider-retry-%'",
              )
              .all(fixture.sessionId);
            database.close();
            expect(starts(), JSON.stringify(rows)).toHaveLength(2);
          });
          expect(starts().at(-1)!.params).toMatchObject({
            input: [{ type: 'text', text: 'Continue.' }],
          });
          expect(
            (await fixture.app.inject(`/api/sessions/${fixture.sessionId}`)).json().autopilot
              .enabled,
          ).toBe(mode === 'autopilot');
          const trace = exportControlPlaneTrace(
            join(fixture.dataDir, 'relay.sqlite'),
            fixture.sessionId,
          );
          if (mode === 'ordinary')
            expect(
              trace.events.some((event) => event.type === 'session.provider-retry-started'),
            ).toBe(true);
          expect(JSON.stringify(trace)).not.toContain('private capacity detail');
        }
      },
    );
    it('production correlates overload recovery with a settled root turn and cancels it on Off', async () => {
      const timers: Array<{ callback: () => void; delay: number; cancelled: boolean }> = [];
      const fixture = await createProductionAutopilotFixture({
        autopilotSchedule: (callback, delay) => {
          const timer = { callback, delay, cancelled: false };
          timers.push(timer);
          return () => {
            timer.cancelled = true;
          };
        },
      });
      onTestFinished(() => fixture.app.close());
      timers.find((timer) => !timer.cancelled)!.callback();
      await vi.waitFor(() =>
        expect(fixture.handles.some((handle) => handle.calls.includes('turn/start'))).toBe(true),
      );
      const session = (await fixture.app.inject(`/api/sessions/${fixture.sessionId}`)).json();
      const handle = fixture.handles.find((candidate) => candidate.calls.includes('turn/start'))!;
      const error = { codexErrorInfo: 'serverOverloaded', message: 'private overload body' };
      handle.notify!({
        method: 'error',
        params: {
          threadId: session.threadId,
          turnId: session.activeTurnId,
          error,
          willRetry: false,
        },
      });
      expect(
        (await fixture.app.inject(`/api/sessions/${fixture.sessionId}`)).json().autopilot
          .providerRetry,
      ).toMatchObject({ turnId: session.activeTurnId, attempt: 1, pending: true, settled: false });
      handle.notify!({
        method: 'turn/completed',
        params: {
          threadId: session.threadId,
          turn: { id: session.activeTurnId, status: 'failed', error },
        },
      });
      const completed = (await fixture.app.inject(`/api/sessions/${fixture.sessionId}`)).json();
      expect(completed.activeTurnId).toBeNull();
      expect(completed.autopilot.providerRetry).toMatchObject({
        attempt: 1,
        pending: true,
        settled: true,
      });
      const retry = timers.find((timer) => timer.delay === 60_000 && !timer.cancelled)!;
      expect(retry).toBeDefined();
      await fixture.app.inject({
        method: 'PUT',
        url: `/api/sessions/${fixture.sessionId}/autopilot`,
        payload: { enabled: false },
      });
      expect(retry.cancelled).toBe(true);
      retry.callback();
      expect(
        (await fixture.app.inject(`/api/sessions/${fixture.sessionId}`)).json().autopilot,
      ).toMatchObject({ enabled: false, state: 'disabled' });
      const database = new DatabaseSync(join(fixture.dataDir, 'relay.sqlite'));
      try {
        const rows = database
          .prepare(
            "SELECT payload_json FROM session_events WHERE session_id=? AND type='autopilot.provider-failed'",
          )
          .all(fixture.sessionId);
        expect(rows).toHaveLength(1);
        expect(JSON.parse(rows[0]!.payload_json as string)).toMatchObject({
          actor: 'root',
          turnId: session.activeTurnId,
          requestedEnabled: true,
          providerFailure: { code: 'serverOverloaded' },
        });
        expect(JSON.stringify(rows)).not.toContain('private overload body');
      } finally {
        database.close();
      }
    });
    it.each(
      [
        'usageLimitExceeded',
        'contextWindowExceeded',
        'unauthorized',
        'responseStreamDisconnected',
        'futureProviderError',
      ].flatMap((code) =>
        ['error', 'turn/completed', 'child-error'].map((method) => ({ code, method })),
      ),
    )('production pauses durably on Codex $code via $method', async ({ method, code }) => {
      const timers: Array<{ callback: () => void; cancelled: boolean }> = [];
      let coordinator:
        import('./features/autopilot/application/service.js').AutopilotCoordinator | undefined;
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
      onTestFinished(() => fixture.app.close());
      timers.find((timer) => !timer.cancelled)!.callback();
      await vi.waitFor(() =>
        expect(fixture.handles.some((handle) => handle.calls.includes('turn/start'))).toBe(true),
      );
      const session = (await fixture.app.inject(`/api/sessions/${fixture.sessionId}`)).json();
      const handle = fixture.handles.find((candidate) => candidate.calls.includes('turn/start'))!;
      const failure = {
        code,
        ...(code === 'responseStreamDisconnected' ? { httpStatusCode: 503 } : {}),
      };
      const error = {
        codexErrorInfo:
          code === 'responseStreamDisconnected' ? { [code]: { httpStatusCode: 503 } } : code,
        message: 'private provider detail',
      };
      handle.notify!({
        method: 'error',
        params: {
          threadId: session.threadId,
          turnId: session.activeTurnId,
          error,
          willRetry: true,
        },
      });
      expect(
        (await fixture.app.inject(`/api/sessions/${fixture.sessionId}`)).json().autopilot.enabled,
      ).toBe(true);
      handle.notify!({
        method: 'error',
        params: {
          threadId: 'unrelated-thread',
          turnId: 'unrelated-turn',
          error,
          willRetry: false,
        },
      });
      expect(
        (await fixture.app.inject(`/api/sessions/${fixture.sessionId}`)).json().autopilot.enabled,
      ).toBe(true);
      if (method === 'child-error') {
        handle.notify!({
          method: 'item/started',
          params: {
            threadId: session.threadId,
            item: {
              id: 'spawn',
              type: 'collabAgentToolCall',
              tool: 'spawnAgent',
              receiverThreadIds: ['child'],
              senderThreadId: session.threadId,
            },
          },
        });
      }
      const params =
        method !== 'turn/completed'
          ? {
              threadId: method === 'child-error' ? 'child' : session.threadId,
              turnId: method === 'child-error' ? 'child-turn' : session.activeTurnId,
              error,
              willRetry: false,
            }
          : {
              threadId: session.threadId,
              turn: { id: session.activeTurnId, status: 'failed', error },
            };
      // Provider diagnostics remain available even when automatic supervision was disabled.
      if (code === 'unauthorized') coordinator!.disable(fixture.sessionId);
      handle.notify!({ method: method === 'child-error' ? 'error' : method, params });
      handle.notify!({ method: method === 'child-error' ? 'error' : method, params });
      handle.notify!({
        method: 'turn/completed',
        params: {
          threadId: session.threadId,
          turn: { id: session.activeTurnId, status: 'failed', error },
        },
      });
      coordinator!.evaluate(fixture.sessionId);
      coordinator!.dispose(fixture.sessionId);
      coordinator!.restore(fixture.sessionId);
      const result = (await fixture.app.inject(`/api/sessions/${fixture.sessionId}`)).json();
      expect(result.activeTurnId).toBeNull();
      expect(result.autopilot).toMatchObject({
        enabled: false,
        state: code === 'unauthorized' ? 'disabled' : 'safetyPaused',
        reason:
          code === 'unauthorized'
            ? 'manualDisabled'
            : code === 'usageLimitExceeded'
              ? 'usageLimitExceeded'
              : 'providerError',
        providerFailure: failure,
        health: { nextExpectedAction: expect.stringContaining(code) },
      });
      expect(
        fixture.handles
          .flatMap((candidate) => candidate.calls)
          .filter((call) => call === 'turn/start'),
      ).toHaveLength(1);
      const database = new DatabaseSync(join(fixture.dataDir, 'relay.sqlite'));
      try {
        const rows = database
          .prepare(
            "SELECT payload_json FROM session_events WHERE session_id = ? AND type = 'autopilot.updated'",
          )
          .all(fixture.sessionId);
        expect(JSON.stringify(rows)).not.toContain('private provider detail');
        expect(
          rows.filter(
            (row) => JSON.parse(row.payload_json as string).providerFailure?.code === code,
          ),
        ).toHaveLength(1);
      } finally {
        database.close();
      }
      coordinator!.enable(fixture.sessionId);
      expect(coordinator!.snapshot(fixture.sessionId).providerFailure).toBeUndefined();
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

    it('continues the root after a checkpoint with a completed assigned executor', async () => {
      const timers: Array<{ callback: () => void; cancelled: boolean; fired: boolean }> = [];
      let coordinator:
        import('./features/autopilot/application/service.js').AutopilotCoordinator | undefined;
      const fixture = await createProductionAutopilotFixture({
        activitySchedule: () => () => {},
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
      onTestFinished(() => fixture.app.close());
      const checkpoint = await holdCheckpointRequest(fixture, timers, 8900);
      checkpoint.handle.responseSettled!({ id: 8900, outcome: 'resultWritten' });
      await expect(checkpoint.response).resolves.toEqual(
        toOrgPlanCheckpointToolResponse('recorded'),
      );
      let rootActive = true;
      for (const handle of fixture.handles)
        handle.respond = (method, params) => {
          if (method === 'thread/read')
            return {
              thread: {
                id: (params as { threadId: string }).threadId,
                status: { type: rootActive ? 'active' : 'idle' },
                turns: [],
              },
            };
          if (method === 'thread/list')
            return {
              data: [
                {
                  id: 'checkpoint-executor',
                  status: { type: 'idle' },
                  source: { subAgent: { thread_spawn: { agent_path: '/root/l1' } } },
                },
              ],
            };
          return undefined;
        };
      await fixture.app.inject({
        method: 'POST',
        url: `/api/sessions/${fixture.sessionId}/activity/refresh`,
      });
      // The final callback may run before the activity projection drops the
      // original turn. Its stale working observation cannot release this fence.
      expect(coordinator!.turnCompleted(fixture.sessionId, checkpoint.turnId)).toBe(true);
      coordinator!.activityChanged(fixture.sessionId);
      const beforeFinal = new DatabaseSync(join(fixture.dataDir, 'relay.sqlite'));
      try {
        const row = beforeFinal
          .prepare('SELECT lifecycle_json FROM autopilot_sessions WHERE session_id = ?')
          .get(fixture.sessionId) as { lifecycle_json: string };
        expect(JSON.parse(row.lifecycle_json).checkpoints.rootContinuationFromTurnId).toBe(
          checkpoint.turnId,
        );
      } finally {
        beforeFinal.close();
      }
      rootActive = false;
      checkpoint.handle.notify!({
        method: 'turn/completed',
        params: {
          threadId: checkpoint.threadId,
          turn: { id: checkpoint.turnId, status: 'completed' },
        },
      });
      await vi.waitFor(async () =>
        expect(
          (await fixture.app.inject(`/api/sessions/${fixture.sessionId}`)).json().agentActivity.root
            .state,
        ).toBe('idle'),
      );
      const starts = () =>
        fixture.handles
          .flatMap((handle) => handle.requests)
          .filter((request) => request.method === 'turn/start');
      for (let attempt = 0; attempt < 8 && starts().length < 2; attempt++) {
        const ready = timers.filter((timer) => !timer.cancelled && !timer.fired);
        expect(ready.length).toBeGreaterThan(0);
        for (const timer of ready) {
          timer.fired = true;
          timer.callback();
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      await vi.waitFor(() => expect(starts()).toHaveLength(2));
      expect(starts().map((request) => (request.params as { threadId: string }).threadId)).toEqual([
        checkpoint.threadId,
        checkpoint.threadId,
      ]);
      coordinator!.evaluate(fixture.sessionId);
      coordinator!.turnCompleted(fixture.sessionId, checkpoint.turnId);
      for (const timer of timers.filter((timer) => !timer.cancelled && !timer.fired)) {
        timer.fired = true;
        timer.callback();
        timer.callback();
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(starts()).toHaveLength(2);
      const database = new DatabaseSync(join(fixture.dataDir, 'relay.sqlite'));
      try {
        const row = database
          .prepare('SELECT lifecycle_json FROM autopilot_sessions WHERE session_id = ?')
          .get(fixture.sessionId) as { lifecycle_json: string };
        expect(
          JSON.parse(row.lifecycle_json).checkpoints.rootContinuationFromTurnId,
        ).toBeUndefined();
        const counts = database
          .prepare(
            "SELECT type, count(*) AS count FROM session_events WHERE session_id = ? AND type IN ('org-plan.step-checkpointed', 'org-plan.step-reported', 'autopilot.executor-resumed', 'autopilot.operation-failed', 'autopilot.turn-started') GROUP BY type",
          )
          .all(fixture.sessionId);
        expect(counts).toEqual(
          expect.arrayContaining([
            { type: 'org-plan.step-checkpointed', count: 1 },
            { type: 'org-plan.step-reported', count: 1 },
            { type: 'autopilot.turn-started', count: 2 },
          ]),
        );
        expect(counts).toHaveLength(3);
      } finally {
        database.close();
      }
    });

    it('continues the root after a checkpoint while activity is refreshed', async () => {
      const timers: Array<{ callback: () => void; cancelled: boolean; fired: boolean }> = [];
      const fixture = await createProductionAutopilotFixture({
        activitySchedule: () => () => {},
        autopilotSchedule: (callback) => {
          const timer = { callback, cancelled: false, fired: false };
          timers.push(timer);
          return () => {
            timer.cancelled = true;
          };
        },
      });
      onTestFinished(() => fixture.app.close());
      const checkpoint = await holdCheckpointRequest(fixture, timers, 8901);
      checkpoint.handle.responseSettled!({ id: 8901, outcome: 'resultWritten' });
      await expect(checkpoint.response).resolves.toEqual(
        toOrgPlanCheckpointToolResponse('recorded'),
      );
      let rootActive = true;
      let holdRoster = false;
      const releaseRoster: Array<() => void> = [];
      for (const handle of fixture.handles)
        handle.respond = (method, params) => {
          if (method === 'thread/read')
            return {
              thread: {
                id: (params as { threadId: string }).threadId,
                status: { type: rootActive ? 'active' : 'idle' },
                turns: [],
              },
            };
          if (method === 'thread/list') {
            const result = {
              data: [
                {
                  id: 'checkpoint-executor',
                  status: { type: 'idle' },
                  source: { subAgent: { thread_spawn: { agent_path: '/root/l1' } } },
                },
              ],
            };
            if (holdRoster)
              return new Promise((resolve) => {
                releaseRoster.push(() => resolve(result));
              });
            return result;
          }
          return undefined;
        };
      await fixture.app.inject({
        method: 'POST',
        url: `/api/sessions/${fixture.sessionId}/activity/refresh`,
      });
      rootActive = false;
      checkpoint.handle.notify!({
        method: 'turn/completed',
        params: {
          threadId: checkpoint.threadId,
          turn: { id: checkpoint.turnId, status: 'completed' },
        },
      });
      await vi.waitFor(async () =>
        expect(
          (await fixture.app.inject(`/api/sessions/${fixture.sessionId}`)).json().agentActivity.root
            .state,
        ).toBe('idle'),
      );
      const settled = (await fixture.app.inject(`/api/sessions/${fixture.sessionId}`)).json()
        .agentActivity;
      vi.useFakeTimers({ toFake: ['Date'] });
      onTestFinished(() => {
        vi.useRealTimers();
      });
      const refreshedAt = new Date(Date.parse(settled.root.observedAt) + 60_000).toISOString();
      vi.setSystemTime(new Date(refreshedAt));
      await fixture.app.inject({
        method: 'POST',
        url: `/api/sessions/${fixture.sessionId}/activity/refresh`,
      });
      holdRoster = true;
      const refreshing = fixture.app.inject({
        method: 'POST',
        url: `/api/sessions/${fixture.sessionId}/activity/refresh`,
      });
      void refreshing.then(() => {});
      try {
        await vi.waitFor(() => expect(releaseRoster.length).toBeGreaterThan(0));
        for (const timer of timers.filter(
          (candidate) => !candidate.cancelled && !candidate.fired,
        )) {
          timer.fired = true;
          timer.callback();
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(releaseRoster).toHaveLength(1);
      } finally {
        holdRoster = false;
        for (const release of releaseRoster) release();
        await refreshing;
      }
      const starts = () =>
        fixture.handles
          .flatMap((handle) => handle.requests)
          .filter(
            (request) =>
              request.method === 'turn/start' &&
              (request.params as { threadId: string }).threadId === checkpoint.threadId,
          );
      for (let attempt = 0; attempt < 8 && starts().length < 2; attempt += 1) {
        await vi.waitFor(() =>
          expect(
            starts().length > 1 || timers.some((timer) => !timer.cancelled && !timer.fired),
          ).toBe(true),
        );
        if (starts().length > 1) break;
        const timer = timers.find((candidate) => !candidate.cancelled && !candidate.fired)!;
        timer.fired = true;
        timer.callback();
        await fixture.app.inject({
          method: 'POST',
          url: `/api/sessions/${fixture.sessionId}/activity/refresh`,
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      await vi.waitFor(() => expect(starts()).toHaveLength(2));
      const database = new DatabaseSync(join(fixture.dataDir, 'relay.sqlite'));
      const events = database
        .prepare(
          "SELECT type FROM session_events WHERE session_id = ? AND type IN ('org-plan.step-reported', 'autopilot.executor-resumed') ORDER BY sequence",
        )
        .all(fixture.sessionId);
      database.close();
      expect(events).toEqual([{ type: 'org-plan.step-reported' }]);
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
          wakeConditions: ['executorChanged', 'processExited'],
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
      await expect(checkpointResponse).resolves.toEqual(
        toOrgPlanCheckpointToolResponse('recorded'),
      );
      const replayResponse = handle.request!(
        l2CheckpointCall(812, threadId, active.active_turn_id, planIdentity),
      );
      await vi.waitFor(() => expect(handle.pendingResponses.has(812)).toBe(true));
      handle.responseSettled!({ id: 812, outcome: 'resultWritten' });
      await expect(replayResponse).resolves.toEqual(
        toOrgPlanCheckpointToolResponse('alreadyRecorded'),
      );
      const afterWriteDatabase = new DatabaseSync(join(fixture.dataDir, 'relay.sqlite'));
      const afterWrite = afterWriteDatabase
        .prepare(
          'SELECT resolved_at FROM pending_interactions WHERE session_id = ? AND request_id = ?',
        )
        .get(fixture.sessionId, '811') as { resolved_at: string | null };
      const checkpointEvents = afterWriteDatabase
        .prepare(
          "SELECT count(*) AS count FROM session_events WHERE session_id = ? AND type = 'org-plan.step-checkpointed'",
        )
        .get(fixture.sessionId) as { count: number };
      afterWriteDatabase.close();
      expect(afterWrite.resolved_at).toEqual(expect.any(String));
      expect(checkpointEvents.count).toBe(1);
      // Checkpoint ownership has priority over a process result that arrives
      // after acknowledgement but before the matching root final.
      handle.notify!({
        method: 'item/completed',
        params: {
          threadId,
          turnId: active.active_turn_id,
          item: {
            id: 'checkpoint-process',
            type: 'commandExecution',
            status: 'completed',
            exitCode: 1,
          },
        },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
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

    it('expands and acknowledges a compact checkpoint signal from the active root', async () => {
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
      const { handle, response } = await holdCheckpointRequest(fixture, timers, 812, true, true);
      handle.responseSettled!({ id: 812, outcome: 'resultWritten' });
      await expect(response).resolves.toEqual(toOrgPlanCheckpointToolResponse('recorded'));
      const database = new DatabaseSync(join(fixture.dataDir, 'relay.sqlite'));
      const checkpoint = database
        .prepare(
          "SELECT count(*) AS count FROM session_events WHERE session_id = ? AND type = 'org-plan.step-checkpointed'",
        )
        .get(fixture.sessionId) as { count: number };
      database.close();
      expect(checkpoint.count).toBe(1);
      await fixture.app.close();
    });

    it.each(['l2:second-child:DONE', 'measure:finish:second-child'])(
      'refreshes the published L2 boundary %s before selecting among multiple DONE children',
      async (reason) => {
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
        timers.find((timer) => !timer.cancelled)!.callback();
        await vi.waitFor(async () =>
          expect(
            (await fixture.app.inject(`/api/sessions/${fixture.sessionId}`)).json().activeTurnId,
          ).toEqual(expect.any(String)),
        );
        const session = (await fixture.app.inject(`/api/sessions/${fixture.sessionId}`)).json();
        const handle = fixture.handles.find((candidate) =>
          candidate.requests.some((request) => request.method === 'turn/start'),
        )!;
        const planPath = join(fixture.workspacePath, 'autopilot.org');
        await writeFile(
          planPath,
          `${autopilotPlanText('DONE')}
** DONE [#A] Newly completed child
:PROPERTIES:
:ID: second-child
:END:
- Why :: Verify a resumed plan with earlier completed work.
- Change :: Preserve the publication target.
- Tests :: Checkpoint immediately after writing the signal.
- Done when :: L1.2 is recorded exactly once.
`,
        );
        await writeFile(
          planStatusFilePath(
            planStatusDirectoryPath(fixture.workspacePath, fixture.sessionId),
            planPath,
          ),
          JSON.stringify({
            schemaVersion: 1,
            planPath,
            reason,
            updatedAt: new Date().toISOString(),
          }),
        );
        // No watcher wait or GET /plan refresh: the checkpoint itself is the barrier.
        await expect(
          handle.request!({
            id: 818,
            method: 'item/tool/call',
            params: {
              threadId: session.threadId,
              turnId: session.activeTurnId,
              tool: 'gestalt_org_plan_checkpoint',
              arguments: { kind: 'l2Completed' },
            },
          }),
        ).resolves.toEqual(toOrgPlanCheckpointToolResponse('recorded'));
        const db = new DatabaseSync(join(fixture.dataDir, 'relay.sqlite'));
        const rows = db
          .prepare(
            "SELECT payload_json FROM session_events WHERE session_id = ? AND type = 'org-plan.step-checkpointed'",
          )
          .all(fixture.sessionId) as { payload_json: string }[];
        expect(rows).toHaveLength(1);
        expect(JSON.parse(rows[0]!.payload_json)).toMatchObject({
          l2Id: 'second-child',
          position: 'L1.2',
        });
        db.close();
        await fixture.app.close();
      },
    );

    it('records the final measured L1 among six reviewed milestones without observing the review publication', async () => {
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
      try {
        // Establish the retained checkpoint protocol, as in a resumed supervised plan.
        const prior = await holdCheckpointRequest(fixture, timers, 817, true, true);
        prior.handle.responseSettled!({ id: 817, outcome: 'resultWritten' });
        await expect(prior.response).resolves.toEqual(toOrgPlanCheckpointToolResponse('recorded'));
        prior.handle.deferResponseSettlement = false;
        const priorTimerCount = timers.length;
        prior.handle.notify!({
          method: 'turn/completed',
          params: { threadId: prior.threadId, turn: { id: prior.turnId } },
        });
        await vi.waitFor(() => expect(timers.length).toBeGreaterThan(priorTimerCount));
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const timer = timers.at(-1)!;
          timer.callback();
          await vi.waitFor(() =>
            expect(
              fixture.handles
                .flatMap((candidate) => candidate.requests)
                .filter((request) => request.method === 'turn/start').length > 1 ||
                timers.at(-1) !== timer,
            ).toBe(true),
          );
          if (
            fixture.handles
              .flatMap((candidate) => candidate.requests)
              .filter((request) => request.method === 'turn/start').length > 1
          )
            break;
        }
        const session = (await fixture.app.inject(`/api/sessions/${fixture.sessionId}`)).json();
        const handle = fixture.handles.find((candidate) =>
          candidate.requests.some((request) => request.method === 'turn/start'),
        )!;
        const planPath = join(fixture.workspacePath, 'autopilot.org');
        await writeFile(
          planPath,
          '#+TITLE: Completed plan\n' +
            Array.from({ length: 6 }, (_, index) =>
              completedAutopilotPlanText()
                .replace(/^#\+TITLE:.*\n/, '')
                .replace(
                  ':ID: parent',
                  `:ID: ${index === 5 ? 'end-to-end-acceptance' : `parent-${index}`}`,
                )
                .replace(':ID: child', `:ID: child-${index}`),
            ).join('\n'),
        );
        // The watcher may coalesce review and measurement writes. Only the durable final
        // publication is available, just as after a relay restart.
        await writeFile(
          planStatusFilePath(
            planStatusDirectoryPath(fixture.workspacePath, fixture.sessionId),
            planPath,
          ),
          JSON.stringify({
            schemaVersion: 1,
            planPath,
            reason: 'measure:finish:end-to-end-acceptance',
            updatedAt: new Date().toISOString(),
          }),
        );
        const checkpointCall = (id: number) => ({
          id,
          method: 'item/tool/call',
          params: {
            threadId: session.threadId,
            turnId: session.activeTurnId,
            tool: 'gestalt_org_plan_checkpoint',
            arguments: { kind: 'l1Accepted' },
          },
        });
        await expect(handle.request!(checkpointCall(819))).resolves.toEqual(
          toOrgPlanCheckpointToolResponse('recorded'),
        );
        await expect(handle.request!(checkpointCall(820))).resolves.toEqual(
          toOrgPlanCheckpointToolResponse('alreadyRecorded'),
        );
        const db = new DatabaseSync(join(fixture.dataDir, 'relay.sqlite'));
        try {
          const rows = db
            .prepare(
              "SELECT payload_json FROM session_events WHERE session_id = ? AND type = 'org-plan.milestone-checkpointed'",
            )
            .all(fixture.sessionId) as { payload_json: string }[];
          expect(rows).toHaveLength(1);
          expect(JSON.parse(rows[0]!.payload_json)).toMatchObject({
            l1Id: 'end-to-end-acceptance',
            position: 'L6',
          });
          // The accepted final milestone must release a new root turn for independent
          // terminal review, rather than treating implementation completion as final.
          const timerCount = timers.length;
          handle.notify!({
            method: 'turn/completed',
            params: {
              threadId: session.threadId,
              turn: { id: session.activeTurnId },
            },
          });
          await vi.waitFor(() => expect(timers.length).toBeGreaterThan(timerCount));
          const startedTurns = () =>
            fixture.handles
              .flatMap((candidate) => candidate.requests)
              .filter((request) => request.method === 'turn/start').length;
          for (let attempt = 0; attempt < 3 && startedTurns() === 2; attempt += 1) {
            const timer = timers.at(-1)!;
            timer.callback();
            await vi.waitFor(() =>
              expect(startedTurns() > 2 || timers.at(-1) !== timer).toBe(true),
            );
          }
          await vi.waitFor(() => expect(startedTurns()).toBe(3));
          const lifecycle = db
            .prepare('SELECT lifecycle_json FROM autopilot_sessions WHERE session_id = ?')
            .get(fixture.sessionId) as { lifecycle_json: string };
          expect(JSON.parse(lifecycle.lifecycle_json).checkpoints).toMatchObject({
            reportedL1Ids: ['end-to-end-acceptance'],
            terminalReviewAccepted: false,
          });
        } finally {
          db.close();
        }
      } finally {
        await fixture.app.close();
      }
    });

    it('records and idempotently replays accepted L1 after REVIEWED advances to the next TODO L1', async () => {
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
      const initial = timers.find((timer) => !timer.cancelled && !timer.fired)!;
      initial.fired = true;
      initial.callback();
      await vi.waitFor(() =>
        expect(
          fixture.handles.flatMap((candidate) =>
            candidate.requests.filter((request) => request.method === 'turn/start'),
          ),
        ).toHaveLength(1),
      );
      const handle = fixture.handles.find((candidate) => candidate.request)!;
      const session = (await fixture.app.inject(`/api/sessions/${fixture.sessionId}`)).json();
      const threadId = session.threadId as string;
      const turnId = session.activeTurnId as string;
      await writeFile(
        join(fixture.workspacePath, 'autopilot.org'),
        acceptedL1WithNextTodoPlanText(),
      );
      await expect
        .poll(
          async () =>
            (await fixture.app.inject(`/api/sessions/${fixture.sessionId}/plan`)).json()
              .currentStepId,
        )
        .toBe('next-parent');
      handle.deferResponseSettlement = true;
      const checkpointCall = (id: number) => ({
        id,
        method: 'item/tool/call',
        params: {
          threadId,
          turnId,
          tool: 'gestalt_org_plan_checkpoint',
          arguments: { kind: 'l1Accepted' },
        },
      });
      const startsBefore = fixture.handles
        .flatMap((candidate) => candidate.requests)
        .filter((request) => request.method === 'turn/start').length;
      const unresolvedCall = handle.request!({
        ...checkpointCall(815),
        params: { ...checkpointCall(815).params, arguments: { kind: 'l2Completed' } },
      });
      await vi.waitFor(() => expect(handle.pendingResponses.has(815)).toBe(true));
      handle.responseSettled!({ id: 815, outcome: 'resultWritten' });
      await expect(unresolvedCall).resolves.toEqual(
        toOrgPlanCheckpointToolResponse('failed', { reasonCode: 'checkpointBoundaryAmbiguous' }),
      );
      const first = handle.request!(checkpointCall(813));
      await vi.waitFor(() => expect(handle.pendingResponses.has(813)).toBe(true));
      handle.responseSettled!({ id: 813, outcome: 'resultWritten' });
      await expect(first).resolves.toEqual(toOrgPlanCheckpointToolResponse('recorded'));
      const replay = handle.request!(checkpointCall(814));
      await vi.waitFor(() => expect(handle.pendingResponses.has(814)).toBe(true));
      handle.responseSettled!({ id: 814, outcome: 'resultWritten' });
      await expect(replay).resolves.toEqual(toOrgPlanCheckpointToolResponse('alreadyRecorded'));
      const database = new DatabaseSync(join(fixture.dataDir, 'relay.sqlite'));
      const acceptedEvents = database
        .prepare(
          "SELECT count(*) AS count FROM session_events WHERE session_id = ? AND type = 'org-plan.milestone-checkpointed'",
        )
        .get(fixture.sessionId) as { count: number };
      const pendingInteractions = database
        .prepare(
          'SELECT count(*) AS count FROM pending_interactions WHERE session_id = ? AND resolved_at IS NULL',
        )
        .get(fixture.sessionId) as { count: number };
      database.close();
      expect(acceptedEvents.count).toBe(1);
      expect(pendingInteractions.count).toBe(0);
      expect(
        fixture.handles
          .flatMap((candidate) => candidate.requests)
          .filter((request) => request.method === 'turn/start'),
      ).toHaveLength(startsBefore);
      handle.notify!({ method: 'turn/completed', params: { threadId, turn: { id: turnId } } });
      await expect
        .poll(
          async () =>
            (await fixture.app.inject(`/api/sessions/${fixture.sessionId}`)).json().activeTurnId,
        )
        .toBeNull();
      await expect
        .poll(() => {
          const database = new DatabaseSync(join(fixture.dataDir, 'relay.sqlite'));
          const scheduled = database
            .prepare(
              "SELECT count(*) AS count FROM session_events WHERE session_id = ? AND type = 'autopilot.continuation-scheduled'",
            )
            .get(fixture.sessionId) as { count: number };
          database.close();
          return scheduled.count;
        })
        .toBeGreaterThan(0);
      const startedTurns = () =>
        fixture.handles
          .flatMap((candidate) => candidate.requests)
          .filter((request) => request.method === 'turn/start').length;
      for (let attempts = 0; attempts < 3 && startedTurns() === startsBefore; attempts += 1) {
        await vi.waitFor(() =>
          expect(timers.find((timer) => !timer.cancelled && !timer.fired)).toBeDefined(),
        );
        const continuation = timers.find((timer) => !timer.cancelled && !timer.fired)!;
        continuation.fired = true;
        continuation.callback();
        await vi.waitFor(() =>
          expect(
            startedTurns() > startsBefore ||
              timers.some((timer) => !timer.cancelled && !timer.fired),
          ).toBe(true),
        );
      }
      await vi.waitFor(() => expect(startedTurns()).toBe(startsBefore + 1));
      await fixture.app.close();
    });

    it('returns a typed failed checkpoint result when persistence never occurs', async () => {
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
      const { handle, response, startsBefore, writersBefore } = await holdCheckpointRequest(
        fixture,
        timers,
        995,
        false,
      );
      await vi.waitFor(() => expect(handle.pendingResponses.has(995)).toBe(true));
      handle.responseSettled!({ id: 995, outcome: 'resultWritten' });
      const failure = (await response) as {
        success: boolean;
        contentItems: Array<{ text: string }>;
      };
      expect(failure.success).toBe(false);
      expect(JSON.parse(failure.contentItems[0]!.text)).toMatchObject({
        status: 'failed',
        reasonCode: 'checkpointPersistenceFailed',
        correlationId: expect.any(String),
      });
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
        await expect(response).resolves.toEqual(toOrgPlanCheckpointToolResponse('recorded'));
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(fixture.handles).toHaveLength(writersBefore);
        expect(failures()).toBe(0);
      } else if (scenario === 'duplicate-settlement') {
        handle.responseSettled!({ id: 992, outcome: 'resultWritten' });
        handle.responseSettled!({ id: 992, outcome: 'resultWritten' });
        await expect(response).resolves.toEqual(toOrgPlanCheckpointToolResponse('recorded'));
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

    it('returns failed for a checkpoint delivered after its owning root final has closed', async () => {
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
      const rejected = (await handle.request!(
        l2CheckpointCall(812, threadId, active.active_turn_id, planIdentity),
      )) as { success: boolean; contentItems: Array<{ text: string }> };
      expect(rejected.success).toBe(false);
      expect(JSON.parse(rejected.contentItems[0]!.text)).toMatchObject({
        status: 'failed',
        reasonCode: 'rootNotOwner',
        correlationId: expect.any(String),
      });
      expect(timers).toHaveLength(timersAfterFinal);
      expect(
        fixture.handles
          .flatMap((candidate) => candidate.requests)
          .filter((request) => request.method === 'turn/start'),
      ).toHaveLength(startsAfterFinal);
      await fixture.app.close();
    });

    it('production attention approval resumes Autopilot and a complete plan transitions to completed', async () => {
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
      await expect(attention).resolves.toEqual(toOrgPlanAttentionAcknowledgement());
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
      for (let attempts = 0; attempts < 3; attempts += 1) {
        const pending = timers.find((timer) => !timer.cancelled && !timer.fired);
        if (!pending) break;
        pending.fired = true;
        pending.callback();
        await Promise.resolve();
      }
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

    it.each([
      'completion-before-deadline',
      'deadline-before-completion',
      'registration-after-final',
      'manual-off',
      'human-turn',
      'restored-wait',
      'owned-ci-watcher',
      'process-error',
      'restored-scheduled',
      'restored-accepted',
    ] as const)('production wake coalescing: %s', async (scenario) => {
      const timers: Array<{ callback: () => void; cancelled: boolean; fired: boolean }> = [];
      let coordinator!: import('./features/autopilot/application/service.js').AutopilotCoordinator;
      const fixture = await createProductionAutopilotFixture({
        activitySchedule: () => () => {},
        onAutopilotCoordinator: (value) => {
          coordinator = value;
        },
        autopilotSchedule: (callback) => {
          const timer = { callback, cancelled: false, fired: false };
          timers.push(timer);
          return () => {
            timer.cancelled = true;
          };
        },
      });
      onTestFinished(() => fixture.app.close());
      const starts = () =>
        fixture.handles
          .flatMap((handle) => handle.requests)
          .filter((request) => request.method === 'turn/start');
      const runUntilStarts = async (count: number) => {
        for (let attempt = 0; attempt < 10 && starts().length < count; attempt += 1) {
          await vi.waitFor(() =>
            expect(
              timers.some((timer) => !timer.cancelled && !timer.fired) || starts().length >= count,
            ).toBe(true),
          );
          if (starts().length >= count) break;
          const timer = timers.find((entry) => !entry.cancelled && !entry.fired)!;
          timer.fired = true;
          timer.callback();
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        await vi.waitFor(() => expect(starts()).toHaveLength(count));
      };
      await runUntilStarts(1);
      const session = (await fixture.app.inject(`/api/sessions/${fixture.sessionId}`)).json();
      const threadId = session.threadId as string;
      const turnId = session.activeTurnId as string;
      const handle = fixture.handles.find((candidate) =>
        candidate.requests.some((request) => request.method === 'turn/start'),
      )!;
      let rootActive = true;
      handle.respond = (method, params) =>
        method === 'thread/read'
          ? {
              thread: {
                id: (params as { threadId: string }).threadId,
                status: { type: rootActive ? 'active' : 'idle' },
                turns: [],
              },
            }
          : undefined;
      handle.notify!({ method: 'turn/started', params: { threadId, turn: { id: turnId } } });
      const finish = () => {
        rootActive = false;
        const completion = {
          method: 'turn/completed',
          params: { threadId, turn: { id: turnId, status: 'completed' } },
        };
        handle.notify!(completion);
        handle.notify!(completion);
      };
      const register = async (id: number) => {
        const response = (await handle.request!({
          id,
          method: 'item/tool/call',
          params: {
            threadId,
            turnId,
            tool: 'gestalt_autopilot_wait_lease',
            arguments: {
              version: 2,
              reportId: 'race-report',
              leaseId: 'race-lease',
              wakeConditions: ['processExited'],
              maxWaitMs: 60_000,
            },
          },
        })) as { contentItems: Array<{ text: string }> };
        return JSON.parse(response.contentItems[0]!.text) as { accepted: boolean; reason?: string };
      };
      const completedProcess = () =>
        handle.notify!({
          method: 'item/completed',
          params: {
            threadId,
            turnId,
            item: {
              id: 'race-process',
              type: 'commandExecution',
              status: 'completed',
              exitCode: scenario === 'process-error' ? 1 : 0,
            },
          },
        });
      const audit = () => {
        const database = new DatabaseSync(join(fixture.dataDir, 'relay.sqlite'));
        try {
          return database
            .prepare(
              'SELECT type,payload_json FROM session_events WHERE session_id = ? ORDER BY sequence',
            )
            .all(fixture.sessionId) as Array<{ type: string; payload_json: string }>;
        } finally {
          database.close();
        }
      };
      if (scenario === 'registration-after-final') {
        finish();
        await vi.waitFor(async () =>
          expect(
            (await fixture.app.inject(`/api/sessions/${fixture.sessionId}`)).json().activeTurnId,
          ).toBeNull(),
        );
        expect(await register(9100)).toMatchObject({
          accepted: false,
          reason: 'automaticContinuationUnavailable',
        });
        await runUntilStarts(2);
        expect(audit().filter((event) => event.type === 'autopilot.wait-registered')).toHaveLength(
          0,
        );
      } else {
        expect(await register(9100)).toMatchObject({ accepted: true });
        if (scenario !== 'owned-ci-watcher')
          expect(await register(9101)).toMatchObject({ accepted: false });
        let deadline = timers.at(-1)!;
        // A fresh timestamp and repeated active observations cannot consume a process lease.
        const revision = coordinator.snapshot(fixture.sessionId).supervisionDelta!.revision;
        vi.useFakeTimers({ toFake: ['Date'] });
        onTestFinished(() => {
          vi.useRealTimers();
        });
        vi.setSystemTime(Date.now() + 1_000);
        for (let index = 0; index < 3; index += 1)
          await fixture.app.inject({
            method: 'POST',
            url: `/api/sessions/${fixture.sessionId}/activity/refresh`,
          });
        expect(coordinator.snapshot(fixture.sessionId).supervisionDelta!.revision).toBe(revision);
        expect(starts()).toHaveLength(1);
        finish();
        await vi.waitFor(async () =>
          expect(
            (await fixture.app.inject(`/api/sessions/${fixture.sessionId}`)).json().activeTurnId,
          ).toBeNull(),
        );
        expect(coordinator.snapshot(fixture.sessionId).health.phase).toBe('waitingForAgentEvent');
        if (scenario === 'restored-wait') {
          coordinator.dispose(fixture.sessionId);
          coordinator.restore(fixture.sessionId);
          deadline = timers.at(-1)!;
        }
        if (scenario === 'manual-off') {
          await fixture.app.inject({
            method: 'PUT',
            url: `/api/sessions/${fixture.sessionId}/autopilot`,
            payload: { enabled: false },
          });
        } else if (scenario === 'human-turn') {
          rootActive = true;
          expect(
            (
              await fixture.app.inject({
                method: 'POST',
                url: `/api/sessions/${fixture.sessionId}/turns`,
                payload: { text: 'user continues work', clientUserMessageId: 'human-race' },
              })
            ).statusCode,
          ).toBe(202);
        }
        if (scenario === 'owned-ci-watcher') {
          const gh = join(fixture.root, 'gh');
          const pollFile = join(fixture.root, 'polls');
          const evidenceDirectory = join(fixture.root, 'ci-evidence');
          await writeFile(
            gh,
            `#!${process.execPath}\nconst fs=require('fs');let polls=0;try{polls=Number(fs.readFileSync(${JSON.stringify(pollFile)},'utf8'))}catch{};fs.writeFileSync(${JSON.stringify(pollFile)},String(++polls));console.log(JSON.stringify({databaseId:123,attempt:2,headSha:'${'a'.repeat(40)}',status:polls<10?'in_progress':'completed',conclusion:polls<10?null:'success',jobs:[],updatedAt:'2026-10-21T08:00:00Z'}));`,
            { mode: 0o700 },
          );
          const script = `import {watchGithubRun} from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'scripts/watch-github-run.mjs')).href)};process.exitCode=await watchGithubRun({repository:'dyne/gestalt-mobile',runId:'123',attempt:2,candidate:'${'a'.repeat(40)}',evidenceDirectory:${JSON.stringify(evidenceDirectory)},gh:${JSON.stringify(gh)},pollIntervalMs:1});`;
          const { stdout } = await promisify(execFile)(process.execPath, [
            '--input-type=module',
            '-e',
            script,
          ]);
          expect(stdout.trim().split('\n')).toHaveLength(3);
          const summary = JSON.parse(
            await readFile(join(evidenceDirectory, 'summary.json'), 'utf8'),
          );
          expect(summary).toMatchObject({
            exitCode: 0,
            completeness: 'complete',
            counts: { polls: 10, changes: 2 },
            processExitedAt: null,
          });
          // No polling observation becomes a model turn. Only this owned
          // process's terminal command notification consumes the one lease.
          expect(starts()).toHaveLength(1);
        }
        vi.setSystemTime(Date.now() + 60_000);
        if (scenario === 'deadline-before-completion') deadline.callback();
        completedProcess();
        completedProcess();
        if (scenario === 'restored-scheduled') {
          // Reach the durable scheduled boundary first. Merely receiving a
          // command notification can still have an unfired quiescence timer.
          for (
            let attempt = 0;
            attempt < 5 && coordinator.snapshot(fixture.sessionId).state !== 'backoff';
            attempt += 1
          ) {
            const pending = timers.find((timer) => !timer.cancelled && !timer.fired);
            expect(pending).toBeDefined();
            pending!.fired = true;
            pending!.callback();
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
          expect(coordinator.snapshot(fixture.sessionId).state).toBe('backoff');
          coordinator.dispose(fixture.sessionId);
          coordinator.restore(fixture.sessionId);
        }
        // Delivery of an already-canceled deadline must be harmless too.
        deadline.callback();
        deadline.callback();
        if (scenario === 'manual-off' || scenario === 'human-turn') {
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(starts()).toHaveLength(scenario === 'manual-off' ? 1 : 2);
        } else {
          await runUntilStarts(2);
          if (scenario === 'restored-accepted') {
            const acknowledgement = coordinator.snapshot(fixture.sessionId).supervisionDelta;
            coordinator.dispose(fixture.sessionId);
            coordinator.restore(fixture.sessionId);
            expect(coordinator.snapshot(fixture.sessionId).supervisionDelta).toEqual(
              acknowledgement,
            );
          }
          const delivered = timers.filter((timer) => timer.fired);
          for (const timer of delivered) timer.callback();
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(starts()).toHaveLength(2);
        }
        const events = audit();
        expect(events.filter((event) => event.type === 'autopilot.wait-registered')).toHaveLength(
          1,
        );
        expect(
          events.filter(
            (event) =>
              event.type === 'autopilot.wait-woken' || event.type === 'autopilot.wait-expired',
          ),
        ).toHaveLength(scenario === 'manual-off' || scenario === 'human-turn' ? 0 : 1);
      }
      const events = audit();
      const accepted = events
        .filter((event) => event.type === 'autopilot.turn-started')
        .map(
          (event) =>
            JSON.parse(event.payload_json) as {
              controlId: string;
              turnId: string;
              trafficClass: string;
            },
        );
      expect(accepted).toHaveLength(scenario === 'manual-off' || scenario === 'human-turn' ? 1 : 2);
      expect(new Set(accepted.map((event) => event.controlId)).size).toBe(accepted.length);
      expect(new Set(accepted.map((event) => event.turnId)).size).toBe(accepted.length);
      expect(accepted.every((event) => event.trafficClass === 'acceptedRootTurn')).toBe(true);
      expect(
        events.filter((event) => event.type === 'autopilot.continuation-scheduled'),
      ).toHaveLength(accepted.length);
      expect(events.filter((event) => event.type === 'autopilot.control-issued')).toHaveLength(
        accepted.length,
      );
    });

    it('isolates identical process IDs and wait lease IDs across production sessions', async () => {
      const timers: Array<{ callback: () => void; cancelled: boolean; fired: boolean }> = [];
      const fixture = await createProductionAutopilotFixture({
        activitySchedule: () => () => {},
        autopilotSchedule: (callback) => {
          const timer = { callback, cancelled: false, fired: false };
          timers.push(timer);
          return () => {
            timer.cancelled = true;
          };
        },
      });
      onTestFinished(() => fixture.app.close());
      const peer = await createComposedSession(fixture.app);
      await installAutopilotPlan(fixture.app, peer, fixture.workspacePath, 'peer-plan');
      const starts = () =>
        fixture.handles
          .flatMap((handle) => handle.requests)
          .filter((request) => request.method === 'turn/start');
      const drainTo = async (count: number) => {
        for (let attempt = 0; attempt < 12 && starts().length < count; attempt += 1) {
          const pending = timers.find((timer) => !timer.cancelled && !timer.fired);
          expect(pending).toBeDefined();
          pending!.fired = true;
          pending!.callback();
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        await vi.waitFor(() => expect(starts()).toHaveLength(count));
      };
      await drainTo(2);
      const actors: Array<{
        sessionId: string;
        handle: LiveServerHandle;
        threadId: string;
        turnId: string;
      }> = [];
      for (const sessionId of [fixture.sessionId, peer]) {
        const session = (await fixture.app.inject(`/api/sessions/${sessionId}`)).json();
        const threadId = session.threadId as string;
        const turnId = session.activeTurnId as string;
        const handle = fixture.handles.find((candidate) =>
          candidate.requests.some(
            (request) =>
              request.method === 'turn/start' &&
              (request.params as { threadId?: string }).threadId === threadId,
          ),
        )!;
        const response = (await handle.request!({
          id: 9300,
          method: 'item/tool/call',
          params: {
            threadId,
            turnId,
            tool: 'gestalt_autopilot_wait_lease',
            arguments: {
              version: 2,
              reportId: 'same-report',
              leaseId: 'same-lease',
              wakeConditions: ['processExited'],
              maxWaitMs: 60_000,
            },
          },
        })) as { contentItems: Array<{ text: string }> };
        expect(JSON.parse(response.contentItems[0]!.text)).toMatchObject({ accepted: true });
        handle.notify!({
          method: 'turn/completed',
          params: { threadId, turn: { id: turnId, status: 'completed' } },
        });
        actors.push({ sessionId, handle, threadId, turnId });
      }
      expect(new Set(actors.map((actor) => actor.threadId)).size).toBe(2);
      for (const actor of actors)
        await vi.waitFor(async () =>
          expect(
            (await fixture.app.inject(`/api/sessions/${actor.sessionId}`)).json().autopilot.health
              .phase,
          ).toBe('waitingForAgentEvent'),
        );
      const complete = (actor: (typeof actors)[number]) =>
        actor.handle.notify!({
          method: 'item/completed',
          params: {
            threadId: actor.threadId,
            turnId: actor.turnId,
            item: {
              id: 'same-process',
              type: 'commandExecution',
              status: 'completed',
              exitCode: 1,
            },
          },
        });
      complete(actors[0]!);
      complete(actors[0]!);
      await drainTo(3);
      expect((await fixture.app.inject(`/api/sessions/${peer}`)).json()).toMatchObject({
        activeTurnId: null,
        autopilot: { health: { phase: 'waitingForAgentEvent' } },
      });
      const database = new DatabaseSync(join(fixture.dataDir, 'relay.sqlite'));
      try {
        const eventsFor = (sessionId: string, type: string) =>
          (
            database
              .prepare(
                'SELECT count(*) AS count FROM session_events WHERE session_id = ? AND type = ?',
              )
              .get(sessionId, type) as { count: number }
          ).count;
        expect(eventsFor(peer, 'autopilot.root-process-observed')).toBe(0);
        expect(eventsFor(peer, 'autopilot.wait-woken')).toBe(0);
        complete(actors[1]!);
        await drainTo(4);
        for (const actor of actors) {
          expect(eventsFor(actor.sessionId, 'autopilot.wait-registered')).toBe(1);
          expect(eventsFor(actor.sessionId, 'autopilot.wait-woken')).toBe(1);
          expect(eventsFor(actor.sessionId, 'autopilot.control-issued')).toBe(2);
          expect(eventsFor(actor.sessionId, 'autopilot.turn-started')).toBe(2);
          const rows = database
            .prepare(
              "SELECT sequence,type,payload_json FROM session_events WHERE session_id = ? AND type IN ('autopilot.root-process-observed','autopilot.wait-woken','autopilot.continuation-scheduled','autopilot.control-issued','autopilot.turn-started') ORDER BY sequence",
            )
            .all(actor.sessionId) as Array<{
            sequence: number;
            type: string;
            payload_json: string;
          }>;
          const woken = rows.find((row) => row.type === 'autopilot.wait-woken')!;
          const afterWake = rows.filter(
            (row) =>
              row.sequence > woken.sequence && row.type !== 'autopilot.root-process-observed',
          );
          expect(afterWake.map((row) => row.type)).toEqual([
            'autopilot.continuation-scheduled',
            'autopilot.control-issued',
            'autopilot.turn-started',
          ]);
          expect(new Set(afterWake.map((row) => JSON.parse(row.payload_json).controlId)).size).toBe(
            1,
          );
          expect(JSON.parse(afterWake.at(-1)!.payload_json)).toMatchObject({
            trafficClass: 'acceptedRootTurn',
            turnId: expect.any(String),
            wakeReason: 'processExited',
          });
        }
      } finally {
        database.close();
      }
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

    it('production resumes an unloaded executor without leaving its command issued or replacing it', async () => {
      const timers: Array<{ callback: () => void; cancelled: boolean }> = [];
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
          const timer = { callback, cancelled: false };
          timers.push(timer);
          return () => {
            timer.cancelled = true;
          };
        },
      });
      onTestFinished(() => fixture.app.close());
      for (const handle of fixture.handles) {
        let loaded = false;
        handle.respond = (method, params) => {
          if ((params as { threadId?: string }).threadId !== 'child-1') return undefined;
          if (method === 'thread/resume') {
            loaded = true;
            return { thread: { id: 'child-1' } };
          }
          if (method === 'turn/start') {
            if (!loaded) throw new CodexJsonRpcError(-32600, 'thread not found: child-1');
            return { turn: { id: 'child-turn' } };
          }
          return undefined;
        };
      }
      expect(
        (
          await fixture.app.inject({
            method: 'PUT',
            url: `/api/sessions/${fixture.sessionId}/autopilot`,
            payload: { enabled: true },
          })
        ).statusCode,
      ).toBe(200);
      await vi.waitFor(() => expect(timers.some((timer) => !timer.cancelled)).toBe(true));
      timers.find((timer) => !timer.cancelled)!.callback();
      const database = new DatabaseSync(join(fixture.dataDir, 'relay.sqlite'));
      onTestFinished(() => database.close());
      await vi.waitFor(() => {
        const row = database
          .prepare('SELECT lifecycle_json FROM autopilot_sessions WHERE session_id = ?')
          .get(fixture.sessionId) as { lifecycle_json: string };
        expect(JSON.parse(row.lifecycle_json)).toMatchObject({
          executor: {
            continuationCount: 1,
            commands: [expect.objectContaining({ status: 'accepted', threadId: 'child-1' })],
          },
        });
      });
      const calls = fixture.handles
        .flatMap((handle) => handle.requests)
        .filter((call) => (call.params as { threadId?: string }).threadId === 'child-1');
      expect(calls.filter((call) => call.method === 'turn/start')).toHaveLength(2);
      expect(calls.filter((call) => call.method === 'thread/resume')).toHaveLength(1);
      const failures = database
        .prepare(
          "SELECT count(*) AS count FROM session_events WHERE session_id = ? AND type IN ('autopilot.operation-failed', 'autopilot.executor-replacement-scheduled')",
        )
        .get(fixture.sessionId) as { count: number };
      expect(failures.count).toBe(0);
    });

    it.each(['missing rollout', 'unloaded child without rollout'])(
      'production treats %s as an executor rejection and starts one fenced replacement',
      async (scenario) => {
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
            if ((params as { threadId?: string }).threadId !== 'child-1') return undefined;
            if (method === 'turn/start' && scenario === 'unloaded child without rollout')
              throw new CodexJsonRpcError(-32600, 'thread not found: child-1');
            if (method === 'turn/start' || method === 'thread/resume')
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
        ).toContain('The supervisor chooses the exact runtime-supported model');
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
              (request) =>
                (request.params as { input?: Array<{ text?: string }> }).input?.[0]?.text,
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
      },
    );

    it.each([
      ['transport-lost', new Error('CODEX_CONNECTION_LOST'), false],
      ['ambiguous RPC failure', new CodexJsonRpcError(-32603, 'internal error'), false],
      ['manual Off after RPC failure', new CodexJsonRpcError(-32603, 'internal error'), true],
    ])(
      'production recovers through the root after %s without replaying or replacing the executor',
      async (_scenario, failure, disableBeforeRecovery) => {
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
              throw failure;
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
        const database = new DatabaseSync(join(fixture.dataDir, 'relay.sqlite'));
        const operationQuery = database.prepare(
          "SELECT payload_json FROM session_events WHERE session_id = ? AND type = 'autopilot.operation-failed' ORDER BY sequence LIMIT 1",
        );
        for (let attempt = 0; attempt < 8 && !operationQuery.get(fixture.sessionId); attempt++) {
          const pending = timers.find((candidate) => !candidate.cancelled && !candidate.fired);
          expect(pending).toBeDefined();
          pending!.fired = true;
          pending!.callback();
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        await vi.waitFor(() => expect(operationQuery.get(fixture.sessionId)).toBeDefined());
        const operation = operationQuery.get(fixture.sessionId) as { payload_json: string };
        const lifecycle = database
          .prepare('SELECT lifecycle_json FROM autopilot_sessions WHERE session_id = ?')
          .get(fixture.sessionId) as { lifecycle_json: string };
        if (failure instanceof CodexJsonRpcError)
          expect(JSON.parse(operation.payload_json)).toMatchObject({
            kind: 'executorResume',
            rpcCode: -32603,
          });
        else expect(JSON.parse(operation.payload_json)).not.toHaveProperty('rpcCode');
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
        const starts = () =>
          fixture.handles
            .flatMap((candidate) => candidate.requests)
            .filter((request) => request.method === 'turn/start');
        const rootStarts = () =>
          starts().filter(
            (request) => (request.params as { threadId: string }).threadId !== 'child-1',
          );
        if (disableBeforeRecovery) {
          const pending = timers.filter((candidate) => !candidate.cancelled && !candidate.fired);
          await fixture.app.inject({
            method: 'PUT',
            url: `/api/sessions/${fixture.sessionId}/autopilot`,
            payload: { enabled: false },
          });
          for (const timer of pending) timer.callback();
        } else {
          for (let attempt = 0; attempt < 8 && rootStarts().length === 0; attempt++) {
            const timer = timers.find((candidate) => !candidate.cancelled && !candidate.fired);
            expect(timer).toBeDefined();
            timer!.fired = true;
            timer!.callback();
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
          await vi.waitFor(() => expect(rootStarts()).toHaveLength(1));
          expect(
            (rootStarts()[0]!.params as { input: { text: string }[] }).input[0]!.text,
          ).toContain('unconfirmed outcome');
        }
        for (const timer of timers.filter((candidate) => candidate.fired)) timer.callback();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(
          starts().filter(
            (request) => (request.params as { threadId: string }).threadId === 'child-1',
          ),
        ).toHaveLength(1);
        expect(rootStarts()).toHaveLength(disableBeforeRecovery ? 0 : 1);
        await fixture.app.close();
      },
    );

    it.each([
      { status: 'failed', retainedQuiz: false },
      { status: 'completed', retainedQuiz: true },
    ])(
      'production $status child wakes the idle supervisor with retainedQuiz=$retainedQuiz',
      async ({ status, retainedQuiz }) => {
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
        if (retainedQuiz) {
          const database = new DatabaseSync(join(fixture.dataDir, 'relay.sqlite'));
          database
            .prepare(
              'INSERT INTO pending_interactions (session_id,request_id,kind,payload_json,turn_id,requested_at) VALUES (?,?,?,?,?,?)',
            )
            .run(
              fixture.sessionId,
              'earlier-quiz',
              'quiz',
              JSON.stringify({ questions: [] }),
              'ended-root-turn',
              new Date().toISOString(),
            );
          database.close();
        }
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
              status: status === 'failed' ? 'failed' : 'completed',
              senderThreadId: 'thread-1',
              receiverThreadId: 'child-1',
              agentStatus: status,
            },
          },
        });

        if (retainedQuiz)
          expect(
            (await fixture.app.inject(`/api/sessions/${fixture.sessionId}`)).json(),
          ).toMatchObject({ agentActivity: { aggregateSubagents: 'idle' } });

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
      },
    );

    it('continues the same unloaded executor once after authoritative roster recovery', async () => {
      const handles: LiveServerHandle[] = [];
      const launch = liveAppServer(handles);
      let unavailable = true;
      const retries: Array<() => void> = [];
      const timers: Array<{ callback: () => void; cancelled: boolean; fired: boolean }> = [];
      const fixture = await createProductionAutopilotFixture({
        activitySchedule: (callback) => {
          retries.push(callback);
          return () => {};
        },
        autopilotSchedule: (callback) => {
          const timer = { callback, cancelled: false, fired: false };
          timers.push(timer);
          return () => {
            timer.cancelled = true;
          };
        },
        launchAppServer: () => {
          const server = launch();
          handles.at(-1)!.respond = (method) => {
            if (method === 'thread/list' && unavailable) throw new Error('RPC_DOWN');
            if (method === 'thread/list')
              return {
                data: [
                  {
                    id: 'preserved-executor',
                    status: { type: 'notLoaded' },
                    source: { subAgent: { thread_spawn: { agent_path: '/root/l1' } } },
                  },
                ],
              };
            if (method === 'thread/backgroundTerminals/list')
              throw new CodexJsonRpcError(-32600, 'thread not found: preserved-executor');
            return undefined;
          };
          return server;
        },
      });
      onTestFinished(() => fixture.app.close());
      // A refresh settles only after its bounded retry sequence, rather than
      // exposing the first intermediate reconciling snapshot as a failure.
      for (let retry = 0; retry < 3; retry++) {
        await vi.waitFor(() => expect(retries.length).toBeGreaterThan(0));
        retries.shift()!();
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      await vi.waitFor(async () => {
        expect(
          (await fixture.app.inject(`/api/sessions/${fixture.sessionId}`)).json(),
        ).toMatchObject({ autopilot: { enabled: true, reason: 'reconcileFailed' } });
      });
      unavailable = false;
      await fixture.app.inject({
        method: 'POST',
        url: `/api/sessions/${fixture.sessionId}/activity/refresh`,
      });
      const starts = () =>
        handles
          .flatMap((handle) => handle.requests)
          .filter((request) => request.method === 'turn/start');
      await vi.waitFor(async () => {
        expect(
          (await fixture.app.inject(`/api/sessions/${fixture.sessionId}`)).json(),
        ).toMatchObject({
          agentActivity: {
            confidence: 'fresh',
            subagents: [
              {
                id: 'preserved-executor',
                canonicalPosition: 'L1',
              },
            ],
          },
          autopilot: { enabled: true },
        });
        expect(
          (await fixture.app.inject(`/api/sessions/${fixture.sessionId}`)).json().autopilot.reason,
        ).toBeUndefined();
        expect(timers.some((timer) => !timer.cancelled && !timer.fired)).toBe(true);
      });
      for (let attempt = 0; attempt < 8 && starts().length === 0; attempt += 1) {
        const timer = timers.find((candidate) => !candidate.cancelled && !candidate.fired);
        expect(timer).toBeDefined();
        timer!.fired = true;
        timer!.callback();
        await vi.waitFor(() =>
          expect(
            starts().length > 0 ||
              timers.some((candidate) => !candidate.cancelled && !candidate.fired),
          ).toBe(true),
        );
      }
      expect(starts()).toHaveLength(1);
      expect(starts()[0]!.params).toMatchObject({ threadId: 'preserved-executor' });
      for (const timer of timers.filter((candidate) => candidate.fired)) timer.callback();
      await Promise.resolve();
      expect(starts()).toHaveLength(1);
    });

    it.each([
      { reported: false, completed: false },
      { reported: true, completed: false },
      { reported: true, completed: true },
    ])(
      'continues past a disconnected auxiliary helper after L2 completion, %j',
      async ({ reported, completed }) => {
        const handles: LiveServerHandle[] = [];
        const launch = liveAppServer(handles);
        const timers: Array<{ callback: () => void; cancelled: boolean; fired: boolean }> = [];
        const fixture = await createProductionAutopilotFixture({
          activitySchedule: () => () => {},
          autopilotSchedule: (callback) => {
            const timer = { callback, cancelled: false, fired: false };
            timers.push(timer);
            return () => {
              timer.cancelled = true;
            };
          },
          launchAppServer: () => {
            const server = launch();
            handles.at(-1)!.respond = (method) => {
              if (method === 'thread/list')
                return {
                  data: [
                    {
                      id: 'old-helper',
                      status: { type: 'notLoaded' },
                      source: {
                        subAgent: { thread_spawn: { agent_path: '/root/editorial_review' } },
                      },
                    },
                    {
                      id: 'previous-executor',
                      status: { type: 'idle' },
                      source: { subAgent: { thread_spawn: { agent_path: '/root/l1' } } },
                    },
                    {
                      id: 'executor',
                      status: { type: 'idle' },
                      source: { subAgent: { thread_spawn: { agent_path: '/root/l2' } } },
                    },
                  ],
                };
              if (method === 'thread/backgroundTerminals/list') return { terminals: [] };
              return undefined;
            };
            return server;
          },
        });
        onTestFinished(() => fixture.app.close());
        await fixture.app.inject({
          method: 'PUT',
          url: `/api/sessions/${fixture.sessionId}/autopilot`,
          payload: { enabled: false },
        });
        await writeFile(
          join(fixture.workspacePath, 'autopilot.org'),
          acceptedL1WithNextTodoPlanText()
            .replace('* TODO [#B] Next parent', `* ${completed ? 'DONE' : 'WIP'} [#B] Next parent`)
            .replace('** TODO [#B] Next child', '** DONE [#B] Next child') +
            (completed
              ? ''
              : `
** TODO [#B] Next child two
:PROPERTIES:
:ID: next-child-two
:END:
- Why :: Continue the same L1 after its first report.
- Change :: Resume the canonical executor.
- Tests :: Verify one fenced continuation.
- Done when :: The next L2 starts.
`),
        );
        await expect
          .poll(
            async () =>
              (await fixture.app.inject(`/api/sessions/${fixture.sessionId}/plan`)).json()
                .currentStepId,
          )
          .toBe('next-parent');
        await fixture.app.inject({
          method: 'POST',
          url: `/api/sessions/${fixture.sessionId}/activity/refresh`,
        });
        expect(
          (await fixture.app.inject(`/api/sessions/${fixture.sessionId}`)).json(),
        ).toMatchObject({
          agentActivity: {
            confidence: 'fresh',
            aggregateSubagents: 'idle',
            subagents: expect.arrayContaining([
              expect.objectContaining({ id: 'old-helper', state: 'disconnected' }),
              expect.objectContaining({ id: 'previous-executor', state: 'idle' }),
              expect.objectContaining({ id: 'executor', state: 'idle' }),
            ]),
          },
        });
        if (reported) {
          const database = new DatabaseSync(join(fixture.dataDir, 'relay.sqlite'));
          try {
            const row = database
              .prepare('SELECT lifecycle_json FROM autopilot_sessions WHERE session_id = ?')
              .get(fixture.sessionId) as { lifecycle_json: string };
            const lifecycle = JSON.parse(row.lifecycle_json);
            lifecycle.checkpoints = {
              protocolVersion: 1,
              planIdentity: createHash('sha256')
                .update(join(fixture.workspacePath, 'autopilot.org'))
                .digest('hex'),
              reportedL1Ids: ['parent'],
              reportedL2Ids: [
                JSON.stringify(['parent', 'child']),
                JSON.stringify(['next-parent', 'next-child']),
              ],
              acceptedKeys: [],
              pendingTurnId: null,
              terminalReviewAccepted: false,
            };
            database
              .prepare('UPDATE autopilot_sessions SET lifecycle_json = ? WHERE session_id = ?')
              .run(JSON.stringify(lifecycle), fixture.sessionId);
          } finally {
            database.close();
          }
        }
        await fixture.app.inject({
          method: 'PUT',
          url: `/api/sessions/${fixture.sessionId}/autopilot`,
          payload: { enabled: true },
        });
        const starts = () =>
          handles
            .flatMap((handle) => handle.requests)
            .filter((request) => request.method === 'turn/start');
        for (let attempt = 0; attempt < 8 && starts().length === 0; attempt += 1) {
          const timer = timers.find((candidate) => !candidate.cancelled && !candidate.fired);
          expect(timer).toBeDefined();
          timer!.fired = true;
          timer!.callback();
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        await vi.waitFor(() => expect(starts()).toHaveLength(1));
        const rootThreadId = (await fixture.app.inject(`/api/sessions/${fixture.sessionId}`)).json()
          .threadId;
        expect(starts()[0]!.params).toMatchObject({
          threadId: reported && !completed ? 'executor' : rootThreadId,
        });
        // Replayed timers cannot duplicate the root report or the later
        // continuation of the same canonical executor.
        for (const timer of timers.filter((candidate) => candidate.fired)) timer.callback();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(starts()).toHaveLength(1);
        const database = new DatabaseSync(join(fixture.dataDir, 'relay.sqlite'));
        try {
          expect(
            database
              .prepare(
                'SELECT count(*) AS count FROM session_events WHERE session_id = ? AND type = ?',
              )
              .get(
                fixture.sessionId,
                reported && !completed ? 'autopilot.executor-resumed' : 'autopilot.control-issued',
              ),
          ).toMatchObject({ count: 1 });
        } finally {
          database.close();
        }
      },
    );

    it('refreshes unchanged idle evidence so a stale handoff can continue', async () => {
      const timers: Array<{ callback: () => void; cancelled: boolean; fired: boolean }> = [];
      const fixture = await createProductionAutopilotFixture({
        activitySchedule: () => () => {},
        autopilotSchedule: (callback) => {
          const timer = { callback, cancelled: false, fired: false };
          timers.push(timer);
          return () => {
            timer.cancelled = true;
          };
        },
      });
      onTestFinished(() => fixture.app.close());
      await fixture.app.inject({
        method: 'PUT',
        url: `/api/sessions/${fixture.sessionId}/autopilot`,
        payload: { enabled: false },
      });
      await fixture.app.inject({
        method: 'POST',
        url: `/api/sessions/${fixture.sessionId}/activity/refresh`,
      });
      const before = (await fixture.app.inject(`/api/sessions/${fixture.sessionId}`)).json()
        .agentActivity;
      vi.useFakeTimers({ toFake: ['Date'] });
      onTestFinished(() => {
        vi.useRealTimers();
      });
      const refreshedAt = new Date(Date.parse(before.root.observedAt) + 60_000).toISOString();
      vi.setSystemTime(new Date(refreshedAt));
      await fixture.app.inject({
        method: 'POST',
        url: `/api/sessions/${fixture.sessionId}/activity/refresh`,
      });
      const after = (await fixture.app.inject(`/api/sessions/${fixture.sessionId}`)).json()
        .agentActivity;
      expect(after).toMatchObject({
        confidence: 'fresh',
        root: {
          state: 'idle',
          observedAt: refreshedAt,
          lastActivityAt: before.root.lastActivityAt,
        },
      });
      await fixture.app.inject({
        method: 'PUT',
        url: `/api/sessions/${fixture.sessionId}/autopilot`,
        payload: { enabled: true },
      });
      const starts = () =>
        fixture.handles.flatMap((handle) => handle.calls).filter((call) => call === 'turn/start');
      for (let attempt = 0; attempt < 8 && starts().length === 0; attempt += 1) {
        const timer = timers.find((candidate) => !candidate.cancelled && !candidate.fired);
        expect(timer).toBeDefined();
        timer!.fired = true;
        timer!.callback();
        await vi.waitFor(() =>
          expect(
            starts().length > 0 ||
              timers.some((candidate) => !candidate.cancelled && !candidate.fired),
          ).toBe(true),
        );
      }
      expect(starts()).toHaveLength(1);
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
    it('includes the same blocked root turn explanation in attention and session reloads', async () => {
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
      timers.find((timer) => !timer.cancelled)!.callback();
      await vi.waitFor(async () =>
        expect(
          (await fixture.app.inject(`/api/sessions/${fixture.sessionId}`)).json().activeTurnId,
        ).toEqual(expect.any(String)),
      );
      const session = (await fixture.app.inject(`/api/sessions/${fixture.sessionId}`)).json();
      const handle = fixture.handles.find((candidate) =>
        candidate.requests.some((request) => request.method === 'turn/start'),
      )!;
      await expect(
        handle.request!({
          id: 698,
          method: 'item/tool/call',
          params: {
            threadId: session.threadId,
            turnId: session.activeTurnId,
            tool: 'gestalt_org_plan_attention',
            arguments: { reason: 'hardBlock', resumeCondition: 'externalStateChanged' },
          },
        }),
      ).resolves.toEqual(toOrgPlanAttentionAcknowledgement());
      const report = 'The checkpoint cannot identify L1.2. Refresh plan state, then retry.';
      handle.notify!({
        method: 'item/completed',
        params: {
          threadId: session.threadId,
          turnId: session.activeTurnId,
          item: { id: 'blocker-final', type: 'agentMessage', phase: 'final_answer', text: report },
        },
      });
      handle.notify!({
        method: 'item/completed',
        params: {
          threadId: session.threadId,
          turnId: 'another-turn',
          item: {
            id: 'unrelated-final',
            type: 'agentMessage',
            phase: 'final_answer',
            text: 'Unrelated report',
          },
        },
      });
      expect(
        (await fixture.app.inject(`/api/sessions/${fixture.sessionId}/attention`)).json(),
      ).toMatchObject({ supervisorReport: report });
      expect(
        (await fixture.app.inject(`/api/sessions/${fixture.sessionId}`)).json().pendingInteractions,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ requestId: '698', supervisorReport: report }),
        ]),
      );
      await fixture.app.close();
    });
    it('bounds a wedged attention acknowledgement writer without losing durable attention', async () => {
      const fixture = await createProductionAutopilotFixture({
        attentionAcknowledgementDeadlineMs: 100,
      });
      const handle = fixture.handles.find((candidate) => candidate.request)!;
      handle.deferResponseSettlement = true;
      const response = handle.request!(attentionCall(699));
      const rejected = expect(response).rejects.toThrow('CODEX_SERVER_REQUEST_CANCELLED');
      await vi.waitFor(() => expect(handle.pendingResponses.has(699)).toBe(true));
      await rejected;
      expect(
        (await fixture.app.inject(`/api/sessions/${fixture.sessionId}/attention`)).json(),
      ).toMatchObject({ requestId: '699', attention: { reason: 'hardBlock' } });
      await fixture.app.close();
    });

    it('returns a bounded failure when durable attention persistence fails', async () => {
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
      await createComposedSession(app);
      const handle = await vi.waitFor(() => {
        const candidate = handles.find((item) => item.request);
        expect(candidate).toBeDefined();
        return candidate!;
      });
      const database = new DatabaseSync(join(dataDir, 'relay.sqlite'));
      database.exec(`CREATE TRIGGER reject_attention_insert
        BEFORE INSERT ON pending_interactions
        WHEN NEW.kind = 'orgPlanAttention'
        BEGIN SELECT RAISE(ABORT, 'injected attention persistence failure'); END`);
      database.close();
      await expect(handle.request!(attentionCall(700))).resolves.toEqual(
        toOrgPlanAttentionAcknowledgement({ accepted: false, reason: 'persistenceFailed' }),
      );
      await app.close();
    });

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
      await expect(resolving).resolves.toEqual(toOrgPlanAttentionAcknowledgement());
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
      await vi.waitFor(() =>
        expect(receivedA).toEqual([
          expect.objectContaining({ kind: 'required', requestId: '701' }),
          expect.objectContaining({ kind: 'resolved', requestId: '701' }),
        ]),
      );
      const failing = handleB.request!(attentionCall(702, 'permissionRequired'));
      await expect(failing).resolves.toEqual(toOrgPlanAttentionAcknowledgement());
      await vi.waitFor(() =>
        expect(receivedB).toEqual([
          expect.objectContaining({ kind: 'required', requestId: '702' }),
        ]),
      );
      handleB.notify!({
        method: 'serverRequest/resolved',
        params: { threadId: 'thread-ignored', requestId: 702 },
      });
      expect(receivedB).toEqual([expect.objectContaining({ kind: 'required', requestId: '702' })]);
      unsubscribeA();
      const afterUnsubscribe = handleA.request!(attentionCall(703));
      await expect(afterUnsubscribe).resolves.toEqual(toOrgPlanAttentionAcknowledgement());
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
      await expect(attentionFirst).resolves.toEqual(toOrgPlanAttentionAcknowledgement());
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
      await vi.waitFor(async () =>
        expect((await app.inject(`/api/sessions/${sessionId}`)).json()).toMatchObject({
          agentActivity: { root: { state: 'working' } },
        }),
      );

      const attentionSecond = handle.request!(attentionCall(713));
      await expect(attentionSecond).resolves.toEqual(toOrgPlanAttentionAcknowledgement());
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
      await expect(active).resolves.toEqual(toOrgPlanAttentionAcknowledgement());
      await expect(terminal).resolves.toEqual(toOrgPlanAttentionAcknowledgement());
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
      await first.close();

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

    it('resolves acknowledged attention offline while retaining legacy writer diagnostics', async () => {
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
      await expect(supportedRequest).resolves.toEqual(toOrgPlanAttentionAcknowledgement());
      await expect(legacyRequest).resolves.toEqual(toOrgPlanAttentionAcknowledgement());
      await vi.waitFor(async () =>
        expect((await first.inject(`/api/sessions/${legacySession}/attention`)).statusCode).toBe(
          200,
        ),
      );
      await first.close();
      const database = new DatabaseSync(join(dataDir, 'relay.sqlite'));
      database
        .prepare('UPDATE relay_sessions SET attention_tool_capability = NULL WHERE id = ?')
        .run(legacySession);
      database
        .prepare(
          "UPDATE pending_interactions SET resolution_state = 'active' WHERE session_id = ? AND request_id = '902'",
        )
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
        ).statusCode,
      ).toBe(202);
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
      // Launching the replacement precedes its asynchronous thread resume.
      // Wait for the recovery operation, not merely the new process handle.
      await expect
        .poll(() =>
          handles
            .filter((candidate) => candidate !== first)
            .flatMap((candidate) => candidate.requests),
        )
        .toContainEqual({
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

    it('drains an in-flight capacity recovery before closing its session database', async () => {
      const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-root-'));
      const dataDir = await mkdtemp(join(tmpdir(), 'gestalt-mobile-state-'));
      ownTemporaryPaths(root, dataDir);
      await mkdir(join(root, 'workspace'));
      const handles: LiveServerHandle[] = [];
      const launch = liveAppServer(handles);
      let blockResume = false;
      let resumeStarted!: () => void;
      let releaseResume!: () => void;
      const resumeStarting = new Promise<void>((resolve) => (resumeStarted = resolve));
      const resumeGate = new Promise<void>((resolve) => (releaseResume = resolve));
      const app = await composeAuthorizedApp({
        root,
        dataDir,
        relyingParty,
        installedCodexVersion: 'codex-cli 0.144.3',
        startAppServers: true,
        launchAppServer: () => {
          const server = launch();
          const handle = handles.at(-1)!;
          handle.respond = async (method, params) => {
            if (!blockResume || method !== 'thread/resume') return undefined;
            resumeStarted();
            await resumeGate;
            return { thread: { id: (params as { threadId: string }).threadId } };
          };
          return server;
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
      const sessionId = await createComposedSession(app);
      const first = handles.find((candidate) => candidate.calls.includes('thread/start'))!;
      const started = await app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/turns`,
        payload: { text: 'continue supervised work' },
      });
      const turnId = started.json().activeTurnId as string;
      const threadId = (await app.inject(`/api/sessions/${sessionId}`)).json().threadId as string;
      first.notify?.({ method: 'turn/started', params: { threadId, turn: { id: turnId } } });
      blockResume = true;

      await expect(
        first.request!({
          id: 92,
          method: 'item/tool/call',
          params: {
            threadId,
            turnId,
            tool: 'gestalt_agent_capacity_recovery',
            arguments: { version: 1, reason: 'agentThreadLimit' },
          },
        }),
      ).resolves.toMatchObject({ success: true });
      await resumeStarting;

      let closed = false;
      const close = app.close().then(() => {
        closed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      const closedBeforeRecoverySettled = closed;
      releaseResume();
      await close;

      expect(closedBeforeRecoverySettled).toBe(false);
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
        ['GET', '/api/codex/allowance', '/api/codex/allowance', 'protected'],
        ['HEAD', '/api/codex/allowance', '/api/codex/allowance', 'protected'],
        ['GET', '/api/xerj', '/api/xerj', 'protected'],
        ['HEAD', '/api/xerj', '/api/xerj', 'protected'],
        ['GET', '/api/session-defaults', '/api/session-defaults', 'protected'],
        ['HEAD', '/api/session-defaults', '/api/session-defaults', 'protected'],
        ['PUT', '/api/session-defaults', '/api/session-defaults', 'protected'],
        ['POST', '/api/session-models/:provider', '/api/session-models/codex', 'protected'],
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
          '/api/sessions/:id/retrieval-readiness',
          '/api/sessions/session-1/retrieval-readiness',
          'protected',
        ],
        [
          'HEAD',
          '/api/sessions/:id/retrieval-readiness',
          '/api/sessions/session-1/retrieval-readiness',
          'protected',
        ],
        [
          'POST',
          '/api/workspaces/:workspaceId/files/references',
          '/api/workspaces/workspace-1/files/references',
          'protected',
        ],
        [
          'GET',
          '/api/workspaces/:workspaceId/files/preview',
          '/api/workspaces/workspace-1/files/preview?path=README.md',
          'protected',
        ],
        [
          'HEAD',
          '/api/workspaces/:workspaceId/files/preview',
          '/api/workspaces/workspace-1/files/preview?path=README.md',
          'protected',
        ],
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
          'POST',
          '/api/workspaces/:workspaceId/plans/:planName/archive',
          '/api/workspaces/workspace-1/plans/.gestalt%2Fplan.org/archive',
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
        ['POST', '/api/maintenance/quit', '/api/maintenance/quit', 'protected'],
        ['POST', '/api/maintenance/upgrade', '/api/maintenance/upgrade', 'protected'],
        ['GET', '/api/maintenance/upgrade', '/api/maintenance/upgrade', 'protected'],
        ['HEAD', '/api/maintenance/upgrade', '/api/maintenance/upgrade', 'protected'],
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
    it('persists replay-stable tool groups from runtime notifications without charging provider tokens', async () => {
      const homeDirectory = await mkdtemp(join(tmpdir(), 'gestalt-efficiency-home-'));
      ownTemporaryPaths(homeDirectory);
      const { app, sessionId, handles, dataDir, root } = await createProductionAutopilotFixture({
        homeDirectory,
      });
      onTestFinished(() => app.close());
      await app.inject({
        method: 'PUT',
        url: `/api/sessions/${sessionId}/autopilot`,
        payload: { enabled: false },
      });
      const database = new DatabaseSync(join(dataDir, 'relay.sqlite'));
      onTestFinished(() => database.close());
      const journal = new SqliteEventJournal(database);
      const before = journal.currentSequence(sessionId);
      const handle = handles.findLast((candidate) => candidate.calls.includes('thread/start'))!;
      const threadId = (await app.inject(`/api/sessions/${sessionId}`)).json().threadId as string;
      const notify = (
        item: Record<string, unknown>,
        phase = 'item/completed',
        owner: string | null = threadId,
        turnId = 'turn',
      ) =>
        handle.notify!({
          method: phase,
          params: { ...(owner ? { threadId: owner } : {}), turnId, item },
        });
      notify({
        id: 'spawn',
        type: 'collabAgentToolCall',
        tool: 'spawnAgent',
        status: 'completed',
        senderThreadId: threadId,
        receiverThreadIds: ['child'],
        agentsStates: { child: { status: 'running' } },
      });
      const wrapper = {
        id: 'wrapper',
        type: 'dynamicToolCall',
        namespace: 'functions',
        tool: 'exec',
        status: 'completed',
        durationMs: 10,
        arguments: {
          code: 'await tools.exec_command({cmd:"secret nested"});\nawait tools.other()',
        },
        contentItems: [],
      };
      notify(wrapper);
      notify(wrapper);
      const command = {
        id: 'nested',
        type: 'commandExecution',
        status: 'completed',
        durationMs: 0,
        aggregatedOutput: '',
        command: 'synthetic command',
      };
      notify(command, 'item/started', 'child');
      notify(command, 'item/completed', 'child');
      notify(command, 'item/completed', 'child');
      notify(command, 'item/started', 'child');
      notify(
        { ...command, id: 'resumed', durationMs: null, aggregatedOutput: null },
        'item/completed',
        'child',
        'resumed-turn',
      );
      notify({ ...wrapper, id: 'uncorrelated' }, 'item/completed', null, 'unknown-turn');
      handle.notify!({
        method: 'thread/tokenUsage/updated',
        params: {
          threadId,
          tokenUsage: { last: { totalTokens: 500 }, total: { totalTokens: 1000 } },
        },
      });
      const snapshot = (await app.inject(`/api/sessions/${sessionId}`)).json()
        .toolEfficiency as ToolEfficiencySnapshot;
      expect(snapshot).toMatchObject({
        scope: 'observedCallsOnly',
        coverage: 'partial',
        missingCorrelation: true,
        retentionLimited: false,
      });
      expect(snapshot.groups).toHaveLength(3);
      expect(snapshot.groups.find((group) => group.layer === 'wrapper')).toMatchObject({
        actor: 'root',
        calls: 1,
        durationMs: { value: 10 },
      });
      expect(snapshot.groups.find((group) => group.threadId === 'child')).toMatchObject({
        actor: 'child',
        calls: 2,
        durationMs: { value: 0, measuredCalls: 1, coverage: 'partial' },
      });
      const replay = journal.replay(sessionId, before);
      if (replay.kind !== 'replay') throw new Error('Expected focused replay');
      const analytics = replay.events.filter((event) => event.type === 'tool.efficiency.updated');
      expect(analytics).toHaveLength(6);
      expect(analytics.at(-1)?.payload).toEqual(snapshot);
      expect(JSON.stringify(analytics)).not.toMatch(/secret|synthetic command|500|1000|nested/);
      const sameEvents = journal.currentSequence(sessionId);
      notify(wrapper);
      expect((await app.inject(`/api/sessions/${sessionId}`)).json().toolEfficiency).toEqual(
        snapshot,
      );
      // Raw activity may publish independently; efficiency duplicates never publish another snapshot.
      const duplicateReplay = journal.replay(sessionId, sameEvents);
      if (duplicateReplay.kind !== 'replay') throw new Error('Expected bounded duplicate replay');
      expect(
        duplicateReplay.events.filter((event) => event.type === 'tool.efficiency.updated'),
      ).toEqual([]);
      await app.close();
      const reopened = await composeAuthorizedApp({
        root,
        dataDir,
        homeDirectory,
        relyingParty,
        installedCodexVersion: null,
        profiles: {
          list: async () => [],
          require: async () => ({ name: 'default', state: 'ok', status: 'ready' }),
        },
      });
      onTestFinished(() => reopened.close());
      expect((await reopened.inject(`/api/sessions/${sessionId}`)).json().toolEfficiency).toEqual(
        snapshot,
      );
    });
    it('retains child MCP startup attempts through trace, activity, snapshot and reconnect without changing manual Off', async () => {
      const fixture = await createProductionAutopilotFixture();
      const { app, sessionId, handles, dataDir } = fixture;
      onTestFinished(() => app.close());
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: `/api/sessions/${sessionId}/autopilot`,
            payload: { enabled: false },
          })
        ).statusCode,
      ).toBe(200);
      const databasePath = join(dataDir, 'relay.sqlite');
      const database = new DatabaseSync(databasePath);
      onTestFinished(() => database.close());
      const journal = new SqliteEventJournal(database);
      const before = journal.currentSequence(sessionId);
      const handle = handles.findLast((candidate) => candidate.calls.includes('thread/start'))!;
      const callsBefore = [...handle.calls];
      const notify = (status: string, name = 'context-mode', threadId: string | null = 'child-1') =>
        handle.notify!({
          method: 'mcpServer/startupStatus/updated',
          params: {
            name,
            status,
            threadId,
            error: 'TOKEN=secret prompt model output stderr',
            exitCode: 1,
            signal: 'SIGKILL',
          },
        });
      notify('starting');
      notify('failed');
      notify('failed');
      notify('failed', 'gestalt-serena');
      notify('failed', 'context-mode', 'child-2');
      notify('starting');
      notify('failed');
      const failureCut = journal.currentSequence(sessionId);
      const failureHistory = (await app.inject(`/api/sessions/${sessionId}/history`)).json();
      const beforeRecovery = failureHistory.activities.find(
        (row: { mcpStartup?: McpStartupStatus }) =>
          row.mcpStartup?.threadId === 'child-1' && row.mcpStartup.serverName === 'context-mode',
      );
      expect(beforeRecovery.mcpStartup).toMatchObject({
        status: 'failed',
        failure: { exitCode: null, signal: null },
      });
      notify('ready');
      notify('ready', 'context-mode', 'secret\nthread');
      const trace = exportControlPlaneTrace(databasePath, sessionId);
      const transitions = trace.events.filter(
        (event) => event.type === 'agent.activity.mcp-startup',
      );
      const statuses = transitions.map((event) => event.payload as unknown as McpStartupStatus);
      const failures = statuses.filter((status) => status.failure);
      expect(failures).toHaveLength(4);
      const childFailures = failures.filter(
        (status) => status.threadId === 'child-1' && status.serverName === 'context-mode',
      );
      expect(childFailures).toHaveLength(2);
      expect(new Set(childFailures.map((status) => status.attemptId)).size).toBe(2);
      expect(new Set(statuses.map((status) => status.runtimeId)).size).toBe(1);
      expect(
        transitions
          .filter((event) => (event.payload as unknown as McpStartupStatus).failure)
          .map((event) => event.traceId),
      ).toEqual(failures.map((status) => status.failure!.failureId));
      expect(JSON.stringify(trace)).not.toMatch(/TOKEN|secret|prompt|stderr/);
      const history = (await app.inject(`/api/sessions/${sessionId}/history`)).json();
      const current = history.activities.filter(
        (row: { mcpStartup?: McpStartupStatus }) => row.mcpStartup,
      );
      expect(current).toHaveLength(3);
      expect(
        current.find((row: { id: string }) => row.id === beforeRecovery.id).mcpStartup,
      ).toMatchObject({ status: 'ready', failure: null });
      expect(
        current.filter(
          (row: { mcpStartup: McpStartupStatus }) => row.mcpStartup.status === 'failed',
        ),
      ).toHaveLength(2);
      const hydrated = acceptSnapshot(createChatProjection(sessionId), history);
      expect(hydrated.activities.filter((row) => row.mcpStartup?.status === 'failed')).toHaveLength(
        2,
      );
      expect(journal.replay(sessionId, before)).toMatchObject({ kind: 'replay' });
      const replay = journal.replay(sessionId, failureCut);
      if (replay.kind !== 'replay') throw new Error('Expected bounded replay');
      const recovered = replay.events.reduce(
        (projection, event) => applyProjectionEvent(projection, event),
        acceptSnapshot(createChatProjection(sessionId), failureHistory),
      );
      expect(
        recovered.activities.find((row) => row.id === beforeRecovery.id)?.mcpStartup,
      ).toMatchObject({ status: 'ready', failure: null });
      expect(handle.calls.filter((method) => method !== 'thread/read')).toEqual(
        callsBefore.filter((method) => method !== 'thread/read'),
      );
      expect((await app.inject(`/api/sessions/${sessionId}`)).json()).toMatchObject({
        autopilot: { enabled: false },
      });
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
      const socket = new WebSocket(
        `ws://127.0.0.1:${address.port}/api/sessions/${sessionId}/events?after=${failureCut}`,
        {
          headers: {
            origin: relyingParty.publicOrigin,
            cookie: 'gestalt_mobile_session=test-session',
          },
        },
      );
      onTestFinished(() => socket.close());
      const messages: Array<{
        event?: { type?: string; payload?: { status?: string; mcpStartup?: McpStartupStatus } };
      }> = [];
      socket.on('message', (data) => messages.push(JSON.parse(String(data))));
      await vi.waitFor(() =>
        expect(
          messages.some(
            (message) =>
              message.event?.type === 'agent.activity.mcp-startup' &&
              message.event.payload?.status === 'ready',
          ),
        ).toBe(true),
      );
      expect(JSON.stringify(messages)).not.toMatch(/TOKEN|secret|stderr/);
    });
    it('hydrates chat and resyncs a large replay without materializing the journal', async () => {
      const fixture = await createProductionAutopilotFixture();
      const { app, sessionId } = fixture;
      onTestFinished(() => app.close());
      const database = new DatabaseSync(join(fixture.dataDir, 'relay.sqlite'));
      const journal = new SqliteEventJournal(database);
      for (let index = 0; index < 250; index++)
        journal.append(
          sessionId,
          'agent.activity.updated',
          { synthetic: 'x'.repeat(4096) },
          new Date().toISOString(),
        );
      const activity = journal.append(
        sessionId,
        'activity.updated',
        { id: 'command', label: 'Command', detail: 'completed' },
        new Date().toISOString(),
      );
      database.close();
      const fullRead = vi.spyOn(SqliteEventJournal.prototype, 'since').mockImplementation(() => {
        throw new Error('Unbounded journal reads must not be used by Chat');
      });
      onTestFinished(() => fullRead.mockRestore());
      const history = await app.inject(`/api/sessions/${sessionId}/history`);
      expect(history.statusCode).toBe(200);
      expect(history.json()).toMatchObject({
        baseSequence: expect.any(Number),
        activities: expect.arrayContaining([
          expect.objectContaining({ id: 'command', detail: 'completed' }),
        ]),
      });
      expect(history.json().baseSequence).toBeGreaterThanOrEqual(activity.sequence);
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
      try {
        const [data] = await once(socket, 'message');
        expect(JSON.parse(String(data))).toMatchObject({
          type: 'relay.resyncRequired',
          currentSequence: expect.any(Number),
        });
        expect(fullRead).not.toHaveBeenCalled();
      } finally {
        socket.close();
      }
    });
    it('starts Self DEBUG with the configured executor model and exact source skill profile', async () => {
      const root = await mkdtemp(join(tmpdir(), 'gestalt-debug-root-'));
      const dataDir = await mkdtemp(join(tmpdir(), 'gestalt-debug-state-'));
      const homeDirectory = await mkdtemp(join(tmpdir(), 'gestalt-debug-home-'));
      ownTemporaryPaths(root, dataDir, homeDirectory);
      await mkdir(join(root, 'workspace'));
      const debugRoot = join(homeDirectory, '.gestalt', 'self-debug');
      await mkdir(debugRoot, { recursive: true });
      const exec = promisify(execFile);
      for (const name of ['gestalt', 'gestalt-mobile', 'gestalt-agents']) {
        await exec('git', ['init', join(debugRoot, name)]);
        await exec('git', [
          '-C',
          join(debugRoot, name),
          'remote',
          'add',
          'origin',
          `https://github.com/dyne/${name}.git`,
        ]);
      }
      // Isolate the same profile path production resolves, including an explicit CODEX_HOME.
      const codexHome = join(homeDirectory, '.codex');
      vi.stubEnv('CODEX_HOME', codexHome);
      onTestFinished(() => {
        vi.unstubAllEnvs();
      });
      await mkdir(join(codexHome, 'agents'), { recursive: true });
      await writeFile(
        join(codexHome, 'agents', 'org-plan-executor.toml'),
        'model = "configured-debug-model"\nmodel_reasoning_effort = "high"\n',
      );
      const handles: LiveServerHandle[] = [];
      const app = await composeAuthorizedApp({
        root,
        dataDir,
        homeDirectory,
        relyingParty,
        installedCodexVersion: 'codex-cli 0.144.3',
        startAppServers: true,
        launchAppServer: liveAppServer(handles),
        componentVersions: [{ id: 'codex', label: 'Codex', version: '0.144.3' }],
        sessionModelCatalog: {
          list: async () => ['gpt-5.6-terra', 'configured-debug-model', 'source-root-model'],
        },
        profiles: {
          list: async () => [],
          require: async () => ({ name: 'default', state: 'ok', status: 'ready' }),
        },
      });
      onTestFinished(() => app.close());
      const sourceId = await createComposedSession(app);
      const inheritedSkills = {
        selectedProfileName: 'js-devel',
        skills: [
          { name: 'disabled', path: '/skills/disabled/SKILL.md', enabled: false },
          { name: 'selected', path: '/skills/selected/SKILL.md', enabled: true },
        ],
      };
      const database = new DatabaseSync(join(dataDir, 'relay.sqlite'));
      database
        .prepare(
          'UPDATE relay_sessions SET model = ?, profile = ?, model_settings_json = ?, effective_skill_selection_json = ? WHERE id = ?',
        )
        .run(
          'source-root-model',
          'supervisor',
          JSON.stringify({
            reasoningEffort: 'medium',
            executorModel: 'configured-debug-model',
            executorReasoningEffort: 'high',
          }),
          JSON.stringify(inheritedSkills),
          sourceId,
        );
      database
        .prepare(
          'INSERT INTO pending_interactions (session_id,request_id,kind,payload_json,turn_id,requested_at,supervisor_report) VALUES (?,?,?,?,?,?,?)',
        )
        .run(
          sourceId,
          'debug-blocker',
          'orgPlanAttention',
          JSON.stringify({
            reason: 'externalState',
            resumeCondition: 'externalStateChanged',
            summary: 'Installed guard mismatch.',
            requestedAction: 'Reconcile compatible tooling.',
          }),
          'blocked-turn',
          '2026-10-17T08:10:33.000Z',
          'FOCUSED_BLOCKER_EXPLANATION',
        );
      database.close();
      const confirmation = (
        await app.inject(`/api/sessions/${sourceId}/debug?attentionRequestId=debug-blocker`)
      ).json();
      expect(confirmation.context.mobileSession).toBe(sourceId);
      expect(confirmation.problem.supervisorReport).toBe('FOCUSED_BLOCKER_EXPLANATION');
      const response = await app.inject({
        method: 'POST',
        url: `/api/sessions/${sourceId}/debug`,
        payload: { confirmationId: confirmation.confirmationId },
      });
      expect(response.statusCode).toBe(202);
      const debug = response.json();
      expect(debug.id).not.toBe(sourceId);
      expect(debug.workspacePath).toBe(debugRoot);
      expect(debug.model).toBe('configured-debug-model');
      expect(debug.profile).toBe('supervisor');
      expect(debug.effectiveSkillSelection).toEqual(inheritedSkills);
      expect(debug.selfDebug.agent.name).toBe('root');
      expect(debug.threadId).not.toBe(confirmation.context.codexThread);
      expect((await app.inject(`/api/sessions/${sourceId}`)).json()).toMatchObject({
        state: 'ready',
        activeTurnId: null,
      });
      expect(
        handles
          .flatMap((handle) => handle.requests)
          .filter(
            (request) =>
              request.method === 'turn/start' &&
              (request.params as { threadId?: string }).threadId ===
                confirmation.context.codexThread,
          ),
      ).toHaveLength(0);
      const request = handles
        .flatMap((handle) => handle.requests)
        .find(
          (request) =>
            request.method === 'turn/start' &&
            (request.params as { threadId?: string }).threadId === debug.threadId,
        );
      expect(request?.params).toMatchObject({
        model: 'configured-debug-model',
        effort: 'high',
        input: [{ type: 'text', text: expect.stringContaining('User detected an error') }],
      });
      expect(JSON.stringify(request?.params)).toContain('FOCUSED_BLOCKER_EXPLANATION');
      expect(JSON.stringify(debug.selfDebug)).not.toContain('FOCUSED_BLOCKER_EXPLANATION');
      expect((await app.inject(`/api/sessions/${debug.id}/debug/trace`)).body).not.toContain(
        'FOCUSED_BLOCKER_EXPLANATION',
      );
      expect((await app.inject(`/api/sessions/${sourceId}/attention`)).json().requestId).toBe(
        'debug-blocker',
      );
      expect(
        (await app.inject('/api/sessions'))
          .json()
          .find((session: { id: string }) => session.id === debug.id).selfDebug,
      ).toEqual(debug.selfDebug);
      expect((await app.inject(`/api/sessions/${debug.id}/debug/trace`)).json()).toMatchObject({
        context: confirmation.context,
        sourceAgent: { status: 'unavailable' },
      });
    });
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

    it('restores explicit plan attachments and fresh progress without launching a writer and persists closure', async () => {
      const root = await mkdtemp(join(tmpdir(), 'gestalt-attached-root-'));
      const dataDir = await mkdtemp(join(tmpdir(), 'gestalt-attached-state-'));
      ownTemporaryPaths(root, dataDir);
      const workspacePath = join(root, 'workspace');
      await mkdir(workspacePath);
      const planPath = join(workspacePath, 'plan.org');
      const source = (state: string) => `#+TITLE: Persistent attachment
* ${state} [#A] Remember plan
:PROPERTIES:
:ID: remember
:SKILLS: $gestalt:org-plan
:REVIEW_STATUS: UNREVIEWED
:END:
- Effort :: Small
- Goal :: Keep attachment after restart.
- Notes :: Persist assignment.
`;
      await writeFile(planPath, source('WIP'));
      const profiles = {
        list: async () => [{ name: 'default', state: 'ok' as const, status: 'ready' as const }],
        require: async () => ({ name: 'default', state: 'ok' as const, status: 'ready' as const }),
      };
      const options = {
        root,
        dataDir,
        relyingParty,
        profiles,
        installedCodexVersion: 'codex-cli 0.144.3',
        startAppServers: false,
        launchAppServer: () => fakeAppServer([]),
      };
      const first = await composeAuthorizedApp(options);
      await first.listen({ host: '127.0.0.1', port: 0 });
      const workspace = (await first.inject('/api/bootstrap'))
        .json()
        .workspaces[0].children.find((item: { name: string }) => item.name === 'workspace');
      const created = await first.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { workspaceId: workspace.id, profile: 'default', provider: 'codex' },
      });
      expect(created.statusCode).toBe(202);
      const id = created.json().id;
      expect(
        (
          await first.inject({
            method: 'PUT',
            url: `/api/sessions/${id}/plan`,
            payload: { planName: 'plan.org' },
          })
        ).statusCode,
      ).toBe(200);
      expect((await first.inject(`/api/sessions/${id}`)).json().lastOrgPlan).toMatchObject({
        attached: true,
        path: planPath,
        filename: 'plan.org',
      });
      await first.close();
      await rm(planStatusDirectoryPath(workspacePath, id), { recursive: true, force: true });
      await writeFile(planPath, source('DONE'));
      const second = await composeAuthorizedApp(options);
      await second.listen({ host: '127.0.0.1', port: 0 });
      await expect
        .poll(async () =>
          (await second.inject('/api/bootstrap'))
            .json()
            .sessions.find((session: { id: string }) => session.id === id),
        )
        .toMatchObject({
          lastOrgPlan: { attached: true },
          plan: { title: 'Persistent attachment', allDone: true, doneSteps: 1 },
        });
      expect((await second.inject(`/api/sessions/${id}/plan`)).json().allDone).toBe(true);
      expect(
        (await second.inject({ method: 'DELETE', url: `/api/sessions/${id}/plan` })).statusCode,
      ).toBe(204);
      expect((await second.inject(`/api/sessions/${id}`)).json().lastOrgPlan.attached).toBe(false);
      await second.close();
      const third = await composeAuthorizedApp(options);
      await third.listen({ host: '127.0.0.1', port: 0 });
      expect((await third.inject(`/api/sessions/${id}/plan`)).statusCode).toBe(204);
      expect((await third.inject(`/api/sessions/${id}`)).json().lastOrgPlan).toMatchObject({
        attached: false,
        filename: 'plan.org',
      });
      await third.close();
    }, 20000);

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
      expect(firstCalls.filter((method) => method === 'thread/start')).toHaveLength(1);
      expect(firstCalls).not.toContain('thread/resume');
      expect(firstCalls.indexOf('skills/list')).toBeLessThan(firstCalls.indexOf('thread/start'));
      expect(firstCalls.indexOf('config/read')).toBeLessThan(firstCalls.indexOf('thread/start'));
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
      await expect
        .poll(async () => (await second.inject(`/api/sessions/${created.json().id}`)).json())
        .toMatchObject({
          threadId: 'thread-1',
          state: 'stopped',
          agentActivity: { confidence: 'stale', root: { state: 'disconnected' } },
        });
      await second.close();
    });

    it('quits through graceful relay shutdown and closes an active Codex child', async () => {
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

      const quit = await app.inject({ method: 'POST', url: '/api/maintenance/quit' });

      expect(quit.statusCode).toBe(202);
      expect(quit.json()).toEqual({ accepted: true });
      // Model and skill catalogs run for bootstrap and session start; the active child closes with the relay.
      await vi.waitFor(() => expect(closed).toBe(5));
    });

    it('reconciles cleared interactions and unloaded child rosters through later activity', async () => {
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
      let includeUnloadedChild = false;
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
                if (method === 'turn/start') return { turn: { id: 'attention-guidance-turn' } };
                if (method === 'thread/read') {
                  if (handle.failReads) throw new Error('READ_DOWN');
                  return { thread: { id: 'thread-1', status: { type: 'idle' }, turns: [] } };
                }
                if (method === 'thread/list')
                  return {
                    data: includeUnloadedChild
                      ? [
                          {
                            id: 'l4',
                            status: { type: 'notLoaded' },
                            source: { subAgent: { thread_spawn: { agent_path: '/root/l4' } } },
                          },
                        ]
                      : [],
                  };
                if (method === 'thread/backgroundTerminals/list')
                  throw new CodexJsonRpcError(-32600, 'thread not found: l4');
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
      // A durable child may be absent from the writer's process registry.
      // Its process RPC must not prevent roster publication or future refreshes.
      includeUnloadedChild = true;
      await app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/activity/refresh` });
      await vi.waitFor(async () => {
        expect((await app.inject(`/api/sessions/${sessionId}`)).json()).toMatchObject({
          agentActivity: {
            confidence: 'fresh',
            subagents: [{ id: 'l4', canonicalPosition: 'L4', state: 'disconnected' }],
          },
        });
      });
      expect(activityDiagnostic).not.toHaveBeenCalled();
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
      expect(activityDiagnostic).toHaveBeenCalledWith(sessionId, 'reconcileExhausted', {
        attempt: 4,
      });
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
        agentActivity: {
          root: { state: 'working' },
          subagents: [{ id: 'l4', canonicalPosition: 'L4', state: 'disconnected' }],
        },
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
            resumeCondition: 'permissionGranted',
          },
        },
      });
      await expect(attention).resolves.toEqual(toOrgPlanAttentionAcknowledgement());
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
      // Clearing the already-acknowledged dynamic request must not erase the
      // durable attention record or wedge the caller.
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
      await expect(clearedAttention).resolves.toEqual(toOrgPlanAttentionAcknowledgement());
      await vi.waitFor(async () =>
        expect((await app.inject(`/api/sessions/${sessionId}`)).json()).toMatchObject({
          agentActivity: { root: { state: 'awaitingHuman' } },
        }),
      );
      handle!.notify!({
        method: 'serverRequest/resolved',
        params: { threadId: 'thread-1', requestId: 9 },
      });
      await vi.waitFor(async () =>
        expect((await app.inject(`/api/sessions/${sessionId}`)).json()).toMatchObject({
          agentActivity: { root: { state: 'awaitingHuman' } },
        }),
      );
      expect((await app.inject(`/api/sessions/${sessionId}/history`)).json().interactions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ requestId: '9', kind: 'orgPlanAttention', resolvedAt: null }),
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
