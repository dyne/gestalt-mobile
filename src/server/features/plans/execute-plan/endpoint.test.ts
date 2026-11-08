/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import type { LightMyRequestResponse } from 'fastify';
import { expect, it, vi, onTestFinished } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../../platform/persistence/migrate.js';
import { SqliteOrgPlanLaunchStore } from '../../../platform/persistence/sqlite-org-plan-launch-store.js';
import { registerPlanRoutes } from '../register-routes.js';
import { startOrgPlanSupervision } from '../application/start-org-plan-supervision.js';
import type {
  OrgPlanLaunchRequest,
  OrgPlanPreparation,
} from '../../../../shared/contracts/org-plan-execution.js';
import { startSession } from '../../sessions/start-session/use-case.js';
import { createStartTurn } from '../../sessions/start-turn/use-case.js';
import type { RelaySessionSnapshot } from '../../sessions/model/relay-session.js';
import { newSessionFallback } from '../../../../shared/contracts/session-defaults.js';

const input = {
  reference: { kind: 'workspace' as const, workspaceId: 'project', planName: '.gestalt/plan.org' },
  expectedRevision: 'confirmed-revision',
  skillProfile: 'supervisor',
  launchId: 'intent-1',
};
const context: Extract<OrgPlanPreparation, { kind: 'eligible' }> = {
  kind: 'eligible',
  reference: input.reference,
  title: 'Plan',
  revision: input.expectedRevision,
  sourcePath: '/project/.gestalt/plan.org',
  workspace: { id: 'project', name: 'Project', path: '/project' },
  settings: {
    ...newSessionFallback,
    provider: 'codex',
    profile: 'default',
    skillProfile: 'supervisor',
  },
  skillProfiles: [{ name: 'supervisor' }],
  warnings: [],
};

function lifecycle() {
  const database = new DatabaseSync(':memory:');
  migrate(database);
  onTestFinished(() => database.close());
  const rows = new Map<string, RelaySessionSnapshot>();
  const published: RelaySessionSnapshot[] = [];
  const history: { sessionId: string; text: string; key?: string }[] = [];
  const save = (session: RelaySessionSnapshot) => {
    rows.set(session.id, session);
  };
  const activate = vi.fn(async (session: RelaySessionSnapshot) => ({
    ...session,
    state: 'ready' as const,
    threadId: 'ordinary-thread',
  }));
  const create = vi.fn((id: string, confirmed: typeof context) =>
    startSession(
      { ...confirmed.settings, workspaceId: confirmed.workspace.id },
      {
        createId: () => id,
        now: () => '2026-11-08T12:00:00Z',
        save,
        publish: async (session) => {
          save(session);
          published.push(session);
        },
        workspaces: {
          resolve: async (id) => ({ id, name: 'Project', realPath: context.workspace.path }),
        },
        profiles: { require: async () => ({ name: 'default', state: 'ok', status: 'ready' }) },
        skillProfiles: {
          readGlobalProfile: async () => undefined,
          readWorkspaceDefault: async () => undefined,
        },
        skillCatalog: () => ({ list: async () => ({ skills: [], errors: [] }) }),
        inheritedSkillSelection: {
          selectedProfileName: 'supervisor',
          skills: [{ name: 'gestalt:org-plan', path: '/skills/org/SKILL.md', enabled: true }],
        },
        models: { list: async () => [newSessionFallback.model, newSessionFallback.executorModel] },
        activate,
      },
    ),
  );
  const submitTurn = createStartTurn({
    find: (id) => rows.get(id) ?? null,
    save,
    start: async (session, text, key) => {
      history.push({ sessionId: session.id, text, key });
      return { ...session, state: 'turnActive', activeTurnId: 'ordinary-turn' };
    },
  });
  return {
    launches: new SqliteOrgPlanLaunchStore(database),
    authorizeReplay: async () => true,
    captureSkills: async () => ({
      selectedProfileName: 'supervisor',
      skills: [{ name: 'gestalt:org-plan', path: '/skills/org/SKILL.md', enabled: true }],
    }),
    createId: () => 'ordinary-session',
    sessions: { create, find: (id: string) => rows.get(id) ?? null },
    submitTurn,
    rows,
    published,
    history,
    activate,
  };
}

it('creates and publishes an ordinary Codex session and one accepted recorded bootstrap through direct and HTTP callers', async () => {
  for (const throughHttp of [false, true]) {
    const app = fastify();
    const ports = lifecycle();
    const prepare = vi.fn(async () => context);
    const start = (request: OrgPlanLaunchRequest) =>
      startOrgPlanSupervision(request, { ...ports, prepare });
    registerPlanRoutes(app, { executeOrgPlanRoutes: { startOrgPlanSupervision: start } });
    try {
      const result = throughHttp
        ? (await app.inject({ method: 'POST', url: '/api/plans/execute', payload: input })).json()
        : await start(input);
      expect(result).toMatchObject({
        kind: 'started',
        session: {
          id: 'ordinary-session',
          state: 'turnActive',
          workspaceId: 'project',
          workspacePath: '/project',
          provider: 'codex',
          profile: 'default',
          threadId: 'ordinary-thread',
          model: newSessionFallback.model,
          modelSettings: {
            reasoningEffort: newSessionFallback.reasoningEffort,
            executorModel: newSessionFallback.executorModel,
            executorReasoningEffort: newSessionFallback.executorReasoningEffort,
          },
          executionPolicy: { sandbox: 'workspace-git', approvalPolicy: 'never' },
          effectiveSkillSelection: { selectedProfileName: 'supervisor' },
        },
        bootstrap: {
          kind: 'accepted',
          requestId: 'org-plan-bootstrap:intent-1',
          turnId: 'ordinary-turn',
        },
      });
      expect(prepare).toHaveBeenCalledExactlyOnceWith(
        input.reference,
        input.expectedRevision,
        input.skillProfile,
      );
      expect(ports.published).toHaveLength(1);
      expect(ports.published[0].state).toBe('starting');
      expect(ports.activate).toHaveBeenCalledTimes(1);
      expect(ports.rows.get('ordinary-session')?.lastOrgPlan).toBeUndefined();
      expect(ports.history).toHaveLength(1);
      expect(ports.history[0]).toMatchObject({
        sessionId: 'ordinary-session',
        key: 'org-plan-bootstrap:intent-1',
      });
      for (const required of [
        '$gestalt:org-plan',
        JSON.stringify(context.sourcePath),
        'single writer',
        'review',
        'commit',
        'checkpoints',
        'terminal whole-branch review',
        'Manual Off',
      ])
        expect(ports.history[0].text).toContain(required);
    } finally {
      await app.close();
    }
  }
});

it('keeps a real published session visible when activation or bootstrap acceptance fails', async () => {
  for (const stage of ['activation', 'bootstrap'] as const) {
    const ports = lifecycle();
    if (stage === 'activation') ports.activate.mockRejectedValueOnce(new Error('runtime failed'));
    else
      ports.submitTurn = async () => ({
        kind: 'rejected',
        statusCode: 409,
        problem: { code: 'SESSION_NOT_READY' },
      });
    const result = await startOrgPlanSupervision(input, { ...ports, prepare: async () => context });
    expect(result).toMatchObject({
      kind: 'partial',
      session: { id: 'ordinary-session' },
      stage,
      bootstrap: { kind: 'pending' },
    });
    expect(ports.rows.size).toBe(1);
    expect(ports.published).toHaveLength(1);
    expect(ports.history).toHaveLength(0);
  }
});

it('fails before session publication when effective models disappear after preparation', async () => {
  const ports = lifecycle();
  const result = await startOrgPlanSupervision(input, {
    ...ports,
    prepare: async () => ({ ...context, settings: { ...context.settings, model: 'unavailable' } }),
  });
  expect(result).toMatchObject({ kind: 'blocked', code: 'CODEX_UNAVAILABLE' });
  expect(ports.rows.size).toBe(0);
  expect(ports.published).toHaveLength(0);
  expect(ports.activate).not.toHaveBeenCalled();
  expect(ports.history).toHaveLength(0);
});

it('rejects overrides at both boundaries before admission or lifecycle effects', async () => {
  const app = fastify();
  const prepare = vi.fn(async () => context);
  const ports = lifecycle();
  registerPlanRoutes(app, {
    executeOrgPlanRoutes: {
      startOrgPlanSupervision: (request) => startOrgPlanSupervision(request, { ...ports, prepare }),
    },
  });
  try {
    for (const extra of [
      { cwd: '/outside' },
      { model: 'other' },
      { autopilotEnabled: true },
      { launchId: '' },
      { reference: { ...input.reference, sourcePath: '/outside' } },
    ]) {
      const request = { ...input, ...extra };
      expect(await startOrgPlanSupervision(request, { ...ports, prepare })).toMatchObject({
        code: 'INVALID_LAUNCH_REQUEST',
      });
      expect(
        (await app.inject({ method: 'POST', url: '/api/plans/execute', payload: request }))
          .statusCode,
      ).toBe(400);
    }
    expect(prepare).not.toHaveBeenCalled();
    expect(ports.sessions.create).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it('returns current admission failures identically without calling the ordinary lifecycle', async () => {
  const app = fastify();
  const blocked = {
    kind: 'blocked' as const,
    code: 'CONTEXT_CHANGED' as const,
    reason: 'Refresh and confirm.',
  };
  const prepare = vi.fn(async () => blocked);
  const ports = lifecycle();
  const start = () => startOrgPlanSupervision(input, { ...ports, prepare });
  registerPlanRoutes(app, { executeOrgPlanRoutes: { startOrgPlanSupervision: start } });
  try {
    expect(await start()).toEqual(blocked);
    const response = await app.inject({
      method: 'POST',
      url: '/api/plans/execute',
      payload: input,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual(blocked);
    expect(ports.sessions.create).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it('replays the accepted identity before fresh admission after attachment or source/default/profile changes', async () => {
  const ports = lifecycle();
  const prepare = vi.fn(async (): Promise<OrgPlanPreparation> => context);
  const captureSkills = vi.fn(ports.captureSkills);
  const deps = { ...ports, prepare, captureSkills };
  const first = await startOrgPlanSupervision(input, deps);
  prepare.mockResolvedValue({
    kind: 'blocked',
    code: 'ACTIVE_SUPERVISION',
    reason: 'Its own supervisor attached.',
    existingSessionId: 'ordinary-session',
  });
  expect(await startOrgPlanSupervision(input, deps)).toEqual(first);
  prepare.mockResolvedValue({
    kind: 'blocked',
    code: 'NO_REMAINING_WORK',
    reason: 'Source changed/completed.',
  });
  expect(await startOrgPlanSupervision(input, deps)).toEqual(first);
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(captureSkills).toHaveBeenCalledTimes(1);
  expect(ports.sessions.create).toHaveBeenCalledTimes(1);
  expect(ports.history).toHaveLength(1);
  expect(ports.launches.find(input.launchId)).toMatchObject({
    phase: 'accepted',
    canonicalPath: context.sourcePath,
    context: {
      revision: input.expectedRevision,
      workspace: context.workspace,
      settings: context.settings,
    },
    skillSelection: { selectedProfileName: 'supervisor' },
  });
});

it.each([
  { expectedRevision: 'different' },
  { skillProfile: '' },
  { reference: { ...input.reference, workspaceId: 'different' } },
  { reference: { ...input.reference, planName: '.gestalt/other.org' } },
])('rejects changed confirmed inputs for a reserved launch identity: %j', async (change) => {
  const ports = lifecycle();
  const prepare = vi.fn(async () => context);
  await startOrgPlanSupervision(input, { ...ports, prepare });
  expect(
    await startOrgPlanSupervision({ ...input, ...change }, { ...ports, prepare }),
  ).toMatchObject({ kind: 'rejected', code: 'LAUNCH_CONFLICT' });
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(ports.sessions.create).toHaveBeenCalledTimes(1);
  expect(ports.history).toHaveLength(1);
});

it('fences internal/HTTP duplicate and competing aliased intents before supervisor attachment', async () => {
  const ports = lifecycle();
  const gate = Promise.withResolvers<void>();
  const originalActivate = ports.activate.getMockImplementation()!;
  ports.activate.mockImplementationOnce(async (session) => {
    await gate.promise;
    return originalActivate(session);
  });
  const prepare = vi.fn(async () => context);
  const start = (request: OrgPlanLaunchRequest) =>
    startOrgPlanSupervision(request, { ...ports, prepare });
  const app = fastify();
  registerPlanRoutes(app, { executeOrgPlanRoutes: { startOrgPlanSupervision: start } });
  const internal = start(input);
  let http: Promise<LightMyRequestResponse> | undefined;
  try {
    await vi.waitFor(() => expect(ports.published).toHaveLength(1));
    expect(ports.launches.find(input.launchId)).toMatchObject({
      phase: 'creating',
      sessionId: 'ordinary-session',
    });
    http = app.inject({ method: 'POST', url: '/api/plans/execute', payload: input });
    const competing = await start({
      ...input,
      launchId: 'other-client-intent',
      reference: { kind: 'session', sessionId: 'source-alias', planName: '.gestalt/plan.org' },
    });
    expect(competing).toMatchObject({
      kind: 'blocked',
      code: 'ACTIVE_SUPERVISION',
      existingSessionId: 'ordinary-session',
    });
    expect(ports.sessions.create).toHaveBeenCalledTimes(1);
    gate.resolve();
    const accepted = await internal;
    expect((await http!).json()).toEqual(accepted);
    expect(await start(input)).toEqual(accepted);
    expect(ports.history).toHaveLength(1);
    expect(ports.rows.size).toBe(1);
  } finally {
    gate.resolve();
    await Promise.allSettled([internal, ...(http ? [http] : [])]);
    await app.close();
  }
});

it('requires current authorized workspace scope for replay and never resurrects a forgotten session', async () => {
  const ports = lifecycle();
  const deps = { ...ports, prepare: async () => context };
  await startOrgPlanSupervision(input, deps);
  expect(
    await startOrgPlanSupervision(input, { ...deps, authorizeReplay: async () => false }),
  ).toMatchObject({ kind: 'blocked', code: 'REFERENCE_UNAVAILABLE' });
  ports.rows.delete('ordinary-session');
  expect(
    await startOrgPlanSupervision(input, {
      ...deps,
      sessions: { ...ports.sessions, unavailable: () => true },
    }),
  ).toMatchObject({ kind: 'blocked', code: 'REFERENCE_UNAVAILABLE' });
  expect(ports.sessions.create).toHaveBeenCalledTimes(1);
  expect(ports.history).toHaveLength(1);
});

it('retains uncertain acceptance and an explicit stop as the same session without another bootstrap', async () => {
  const ports = lifecycle();
  const ordinary = ports.submitTurn;
  const submitTurn = vi.fn(async (request: Parameters<typeof ordinary>[0]) => {
    await ordinary(request);
    throw new Error('Response lost after acceptance.');
  });
  const deps = { ...ports, submitTurn, prepare: async () => context };
  expect(await startOrgPlanSupervision(input, deps)).toMatchObject({
    kind: 'partial',
    session: { id: 'ordinary-session' },
    bootstrap: { kind: 'pending' },
  });
  const session = ports.rows.get('ordinary-session')!;
  ports.rows.set(session.id, {
    ...session,
    state: 'stopped',
    desiredState: 'stopped',
    activeTurnId: null,
  });
  expect(await startOrgPlanSupervision(input, deps)).toMatchObject({
    kind: 'partial',
    session: { id: session.id, state: 'stopped' },
  });
  expect(submitTurn).toHaveBeenCalledTimes(1);
  expect(ports.sessions.create).toHaveBeenCalledTimes(1);
  expect(ports.history).toHaveLength(1);
});
