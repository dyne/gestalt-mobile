/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import {
  startOrgPlanSupervision,
  OrgPlanSessionNotPublished,
} from './start-org-plan-supervision.js';
import { startSession } from '../../sessions/start-session/use-case.js';
import { createStartTurn, readAcceptedTurn } from '../../sessions/start-turn/use-case.js';
import { RelaySession, type EffectiveSkillSelection } from '../../sessions/model/relay-session.js';
import { SqliteSessionRepository } from '../../../platform/persistence/sqlite-session-repository.js';
import { SqliteOrgPlanLaunchStore } from '../../../platform/persistence/sqlite-org-plan-launch-store.js';
import { SqliteIdempotencyStore } from '../../../platform/persistence/sqlite-idempotency-store.js';
import { SqliteEventJournal } from '../../../platform/persistence/sqlite-event-journal.js';
import { migrate } from '../../../platform/persistence/migrate.js';
import { newSessionFallback } from '../../../../shared/contracts/session-defaults.js';
import type {
  OrgPlanLaunchRequest,
  OrgPlanPreparation,
} from '../../../../shared/contracts/org-plan-execution.js';
import type { OrgPlanLaunchRecord } from './org-plan-launch-store.js';
import { prepareOrgPlanSupervision } from './prepare-org-plan-supervision.js';
import { FilesystemWorkspacePlanCatalog } from '../../../platform/plans/filesystem-workspace-plan-catalog.js';
import { assessModelPolicyAdmission } from '../domain/model-policy-admission.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'org-plan-recovery-'));
  const databasePath = join(root, 'relay.sqlite');
  const planPath = join(root, '.gestalt', 'plan.org');
  const source =
    '#+TITLE: Plan\n* TODO [#A] Work\n:PROPERTIES:\n:ID: work\n:SKILLS: $gestalt:coding\n:REVIEW_STATUS: UNREVIEWED\n:END:\n- Effort :: Small\n- Goal :: Recover the session.\n- Notes :: Keep ordinary ownership.\n';
  await mkdir(join(root, '.gestalt'));
  await writeFile(planPath, source);
  const catalog = new FilesystemWorkspacePlanCatalog();
  const initial = await catalog.readExecution(root, '.gestalt/plan.org');
  if (initial.kind !== 'available') throw new Error('FIXTURE_PLAN_UNAVAILABLE');
  const calls = {
    creates: 0,
    recovers: 0,
    activations: 0,
    publications: 0,
    turns: [] as Array<string | undefined>,
    settled: [] as string[],
  };
  const controls = { publicationGate: null as Promise<void> | null };
  const faults = {
    pre: false,
    publication: false,
    unknown: false,
    activation: false,
    snapshot: false,
    launchReceipt: false,
    receipt: false,
  };
  let allocation = 0;
  const request: OrgPlanLaunchRequest = {
    reference: { kind: 'workspace', workspaceId: 'project', planName: '.gestalt/plan.org' },
    expectedRevision: initial.revision,
    skillProfile: '',
    launchId: 'intent',
  };
  const context: Extract<OrgPlanPreparation, { kind: 'eligible' }> = {
    kind: 'eligible',
    reference: request.reference,
    title: 'Plan',
    revision: initial.revision,
    sourcePath: join(root, '.gestalt', 'plan.org'),
    workspace: { id: 'project', name: 'Project', path: root },
    settings: { ...newSessionFallback, provider: 'codex', profile: 'default', skillProfile: '' },
    skillProfiles: [],
    warnings: [],
  };
  const selection = {
    skills: [{ name: 'gestalt:org-plan', path: '/skills/org/SKILL.md', enabled: true }],
  };
  const handles = new Set<DatabaseSync>();
  onTestFinished(async () => {
    for (const db of handles) db.close();
    await rm(root, { recursive: true, force: true });
  });
  const open = () => {
    const db = new DatabaseSync(databasePath);
    handles.add(db);
    migrate(db);
    const sessions = new SqliteSessionRepository(db);
    const launches = new SqliteOrgPlanLaunchStore(db);
    const idempotency = new SqliteIdempotencyStore(db);
    const journal = new SqliteEventJournal(db);
    const originalSave = launches.save.bind(launches);
    vi.spyOn(launches, 'save').mockImplementation((record, expected) => {
      if (faults.launchReceipt && record.phase === 'accepted') {
        faults.launchReceipt = false;
        throw new Error('launch receipt write failed');
      }
      return originalSave(record, expected);
    });
    const originalPut = idempotency.put.bind(idempotency);
    vi.spyOn(idempotency, 'put').mockImplementation((scope, key, status, body) => {
      if (faults.receipt) {
        faults.receipt = false;
        throw new Error('ordinary acceptance receipt unavailable');
      }
      originalPut(scope, key, status, body);
    });
    const submitTurn = createStartTurn({
      find: (id) => sessions.find(id),
      idempotency,
      save: (session) => {
        if (faults.snapshot && session.state === 'turnActive') {
          faults.snapshot = false;
          throw new Error('snapshot write failed');
        }
        sessions.save(session);
      },
      start: async (session, _text, key) => {
        calls.turns.push(key);
        journal.append(
          session.id,
          'message.user',
          { clientUserMessageId: key },
          '2026-11-08T12:00:00Z',
        );
        return RelaySession.rehydrate(session).startTurn(
          `turn-${calls.turns.length}`,
          '2026-11-08T12:00:00Z',
        ).snapshot;
      },
      onAccepted: (session, key) => {
        const record = launches.forSession(session.id);
        if (
          record?.phase === 'submitting' &&
          key !== `org-plan-bootstrap:${record.launchId}` &&
          session.activeTurnId
        )
          launches.save({ ...record, manualRecoveryTurnId: session.activeTurnId }, 'submitting');
      },
    });
    const deps = {
      createId: () => `session-${++allocation}`,
      launches,
      prepare: async (
        reference: OrgPlanLaunchRequest['reference'],
        expectedRevision: string,
        skillProfile?: string,
        ownUnpublishedLaunchId?: string,
      ): Promise<OrgPlanPreparation> =>
        prepareOrgPlanSupervision(
          reference,
          {
            resolveReference: async () => ({ workspacePath: root, planName: '.gestalt/plan.org' }),
            read: (workspace, name) => catalog.readExecution(workspace, name),
            workspace: async (_path, revision) => ({ workspace: context.workspace, revision }),
            runtimeAvailable: async () => ({ available: true }),
            policy: assessModelPolicyAdmission,
            owner: async (path) => {
              const owner = launches.owner(path);
              return owner && owner.launchId !== ownUnpublishedLaunchId
                ? { ...(sessions.find(owner.sessionId) ? { sessionId: owner.sessionId } : {}) }
                : null;
            },
            settings: async () => ({
              kind: 'available',
              settings: context.settings,
              skillProfiles: [],
              warnings: [],
              effectiveSkillSelection: selection,
            }),
          },
          expectedRevision,
          skillProfile,
        ),
      authorizeReplay: async () => true,
      captureSkills: async () => selection,
      submitTurn,
      acceptedTurn: (record: Parameters<typeof launches.save>[0]) =>
        record.bootstrapFingerprint
          ? readAcceptedTurn(
              idempotency,
              record.sessionId,
              `org-plan-bootstrap:${record.launchId}`,
              record.bootstrapFingerprint,
            )
          : null,
      onSettled: (id: string) => {
        calls.settled.push(id);
      },
      sessions: {
        find: (id: string) => sessions.find(id),
        create: async (
          id: string,
          confirmed: typeof context,
          _selection: EffectiveSkillSelection,
          publication: OrgPlanLaunchRecord,
        ) => {
          calls.creates++;
          if (faults.pre) {
            faults.pre = false;
            throw new OrgPlanSessionNotPublished();
          }
          if (faults.unknown) {
            faults.unknown = false;
            throw new Error('publication outcome unknown');
          }
          let ownsPublication = false;
          return startSession(
            { ...confirmed.settings, workspaceId: confirmed.workspace.id },
            {
              createId: () => id,
              now: () => '2026-11-08T12:00:00Z',
              save: (session) => {
                if (ownsPublication && sessions.find(id)?.desiredState === 'active')
                  sessions.save(session);
              },
              publish: async (session) => {
                const gate = controls.publicationGate;
                controls.publicationGate = null;
                if (gate) await gate;
                const receipt = launches.publishSession(publication, session, sessions);
                ownsPublication = receipt.created;
                if (receipt.created) calls.publications++;
                if (faults.publication) {
                  faults.publication = false;
                  throw new Error('publication response lost');
                }
              },
              workspaces: {
                resolve: async () => ({ id: 'project', name: 'Project', realPath: root }),
              },
              profiles: {
                require: async () => ({ name: 'default', state: 'ok', status: 'ready' }),
              },
              skillProfiles: {
                readGlobalProfile: async () => undefined,
                readWorkspaceDefault: async () => undefined,
              },
              skillCatalog: () => ({ list: async () => ({ skills: [], errors: [] }) }),
              inheritedSkillSelection: selection,
              activate: async (session) => {
                if (!ownsPublication) return sessions.find(id) ?? session;
                calls.activations++;
                if (faults.activation) {
                  faults.activation = false;
                  throw new Error('runtime start failed');
                }
                return RelaySession.rehydrate(session).bindThread(
                  'same-thread',
                  '2026-11-08T12:00:00Z',
                ).snapshot;
              },
            },
          );
        },
        recover: async (session: NonNullable<ReturnType<typeof sessions.find>>) => {
          calls.recovers++;
          const ready = RelaySession.rehydrate(session).bindThread(
            'same-thread',
            '2026-11-08T12:00:00Z',
          ).snapshot;
          sessions.save(ready);
          return ready;
        },
      },
    };
    return {
      db,
      sessions,
      launches,
      deps,
      close: () => {
        db.close();
        handles.delete(db);
      },
    };
  };
  return { open, request, context, calls, faults, controls, planPath, source };
}

it('rechecks workspace work after asynchronous skill capture before reserving or creating a session', async () => {
  const f = await fixture();
  const run = f.open();
  let busy = false;
  const result = await startOrgPlanSupervision(f.request, {
    ...run.deps,
    captureSkills: async () => {
      const skills = await run.deps.captureSkills();
      busy = true;
      return skills;
    },
    workspaceBusy: () =>
      busy ? { sessionId: 'working-session', reason: 'Another session started work.' } : null,
  });
  expect(result).toMatchObject({
    kind: 'blocked',
    code: 'ACTIVE_SUPERVISION',
    existingSessionId: 'working-session',
  });
  expect(run.launches.find(f.request.launchId)).toBeNull();
  expect(f.calls.creates).toBe(0);
  expect(run.sessions.list()).toHaveLength(0);
});

it.each(['publication', 'activation'] as const)(
  'recovers the persisted ordinary session after %s failure across file database reopen',
  async (stage) => {
    const f = await fixture();
    f.faults[stage] = true;
    const first = f.open();
    expect(await startOrgPlanSupervision(f.request, first.deps)).toMatchObject({
      kind: 'partial',
      stage: 'activation',
      session: { id: 'session-1' },
    });
    expect(first.sessions.list()).toHaveLength(1);
    first.close();
    const restarted = f.open();
    expect(await startOrgPlanSupervision(f.request, restarted.deps)).toMatchObject({
      kind: 'started',
      session: { id: 'session-1', threadId: 'same-thread' },
      bootstrap: { kind: 'accepted' },
    });
    expect(f.calls.creates).toBe(1);
    expect(f.calls.recovers).toBe(1);
    expect(f.calls.turns).toEqual(['org-plan-bootstrap:intent']);
    expect(restarted.sessions.list()).toHaveLength(1);
  },
);

it.each(['snapshot', 'launchReceipt'] as const)(
  'recovers an ordinary accepted receipt after %s failure even after the turn completes',
  async (stage) => {
    const f = await fixture();
    f.faults[stage] = true;
    const first = f.open();
    expect(await startOrgPlanSupervision(f.request, first.deps)).toMatchObject({
      kind: 'partial',
      stage: 'bootstrap',
      session: { id: 'session-1' },
    });
    const current = first.sessions.find('session-1')!;
    first.sessions.save({ ...current, state: 'ready', activeTurnId: null });
    first.close();
    const restarted = f.open();
    expect(await startOrgPlanSupervision(f.request, restarted.deps)).toMatchObject({
      kind: 'started',
      session: { id: 'session-1', state: 'ready', activeTurnId: null },
      bootstrap: { kind: 'accepted', turnId: 'turn-1' },
    });
    expect(restarted.launches.find('intent')?.phase).toBe('accepted');
    expect(f.calls.turns).toEqual(['org-plan-bootstrap:intent']);
    expect(f.calls.creates).toBe(1);
    expect(f.calls.recovers).toBe(0);
    expect(f.calls.settled).toContain('session-1');
  },
);

it('replays a lost success response across close/reopen without reading changed source or reviving a stop', async () => {
  const f = await fixture();
  const first = f.open();
  const accepted = await startOrgPlanSupervision(f.request, first.deps);
  const current = first.sessions.find('session-1')!;
  first.sessions.save(RelaySession.rehydrate(current).stop('2026-11-08T12:01:00Z').snapshot);
  await rm(f.planPath);
  first.close();
  const restarted = f.open();
  const prepare = vi.fn(async (): Promise<OrgPlanPreparation> => ({
    kind: 'blocked',
    code: 'NO_REMAINING_WORK',
    reason: 'Source changed/completed.',
  }));
  const replay = await startOrgPlanSupervision(f.request, { ...restarted.deps, prepare });
  expect(replay).toMatchObject({
    kind: 'started',
    session: { id: 'session-1', state: 'stopped', desiredState: 'stopped' },
  });
  expect(replay.kind === 'started' && accepted.kind === 'started' && replay.bootstrap).toEqual(
    accepted.kind === 'started' && accepted.bootstrap,
  );
  expect(prepare).not.toHaveBeenCalled();
  expect(f.calls.turns).toHaveLength(1);
  expect(f.calls.creates).toBe(1);
  expect(f.calls.recovers).toBe(0);
});

it.each([false, true])(
  'releases only a proved pre-publication failure and safely arbitrates a later intent (%s)',
  async (competing) => {
    const f = await fixture();
    f.faults.pre = true;
    const first = f.open();
    expect(await startOrgPlanSupervision(f.request, first.deps)).toMatchObject({
      kind: 'blocked',
      code: 'CODEX_UNAVAILABLE',
    });
    expect(first.sessions.list()).toHaveLength(0);
    expect(first.launches.owner(f.context.sourcePath)).toBeNull();
    first.close();
    const restarted = f.open();
    const retry = competing ? { ...f.request, launchId: 'other' } : f.request;
    expect(await startOrgPlanSupervision(retry, restarted.deps)).toMatchObject({
      kind: 'started',
      session: { id: competing ? 'session-2' : 'session-1' },
    });
    if (competing)
      expect(await startOrgPlanSupervision(f.request, restarted.deps)).toMatchObject({
        kind: 'blocked',
        code: 'ACTIVE_SUPERVISION',
        existingSessionId: 'session-2',
      });
    expect(restarted.sessions.list()).toHaveLength(1);
    expect(f.calls.turns).toHaveLength(1);
  },
);

it('reconciles an unknown publication window across reopen through the same allocated atomic publication gate', async () => {
  const f = await fixture();
  f.faults.unknown = true;
  const first = f.open();
  await startOrgPlanSupervision(f.request, first.deps);
  first.close();
  const restarted = f.open();
  expect(await startOrgPlanSupervision(f.request, restarted.deps)).toMatchObject({
    kind: 'started',
    session: { id: 'session-1' },
    bootstrap: { kind: 'accepted' },
  });
  expect(
    await startOrgPlanSupervision({ ...f.request, launchId: 'other' }, restarted.deps),
  ).toMatchObject({ kind: 'blocked', code: 'ACTIVE_SUPERVISION' });
  expect(restarted.sessions.list()).toHaveLength(1);
  expect(f.calls.creates).toBe(2);
  expect(f.calls.publications).toBe(1);
  expect(f.calls.activations).toBe(1);
  expect(f.calls.turns).toHaveLength(1);
});

it('keeps unprovable acceptance fenced but lets explicit ordinary Chat recovery supersede its continuation fence', async () => {
  const f = await fixture();
  f.faults.receipt = true;
  const first = f.open();
  expect(await startOrgPlanSupervision(f.request, first.deps)).toMatchObject({
    kind: 'partial',
    bootstrap: { kind: 'pending' },
  });
  first.close();
  const restarted = f.open();
  expect(await startOrgPlanSupervision(f.request, restarted.deps)).toMatchObject({
    kind: 'partial',
    session: { id: 'session-1' },
  });
  expect(f.calls.turns).toEqual(['org-plan-bootstrap:intent']);
  // The caller inspected normal history and explicitly sends recovery guidance through Chat.
  expect(
    await restarted.deps.submitTurn({
      sessionId: 'session-1',
      text: 'Continue after inspecting the existing plan request.',
      key: 'explicit-manual-recovery',
    }),
  ).toMatchObject({ kind: 'accepted' });
  expect(restarted.launches.find('intent')).toMatchObject({
    phase: 'submitting',
    manualRecoveryTurnId: 'turn-2',
  });
  expect(await startOrgPlanSupervision(f.request, restarted.deps)).toMatchObject({
    kind: 'partial',
    bootstrap: { kind: 'pending' },
  });
  expect(f.calls.turns).toEqual(['org-plan-bootstrap:intent', 'explicit-manual-recovery']);
  expect(f.calls.creates).toBe(1);
});

it.each(['changed', 'removed', 'policy'] as const)(
  'revalidates a never-published reserved restart after the plan is %s',
  async (change) => {
    for (const initialFailure of ['pre', 'unknown'] as const) {
      const f = await fixture();
      f.faults[initialFailure] = true;
      const first = f.open();
      await startOrgPlanSupervision(f.request, first.deps);
      first.close();
      if (change === 'removed') await rm(f.planPath);
      else
        await writeFile(
          f.planPath,
          change === 'policy'
            ? `#+MODEL_POLICY_VERSION: 1\n${f.source}`
            : f.source.replace('TODO', 'WIP'),
        );
      const restarted = f.open();
      expect(await startOrgPlanSupervision(f.request, restarted.deps)).toMatchObject({
        kind: 'blocked',
        code: 'CONTEXT_CHANGED',
      });
      expect(restarted.sessions.list()).toHaveLength(0);
      expect(restarted.launches.owner(f.context.sourcePath)).toBeNull();
      expect(f.calls.creates).toBe(1);
      expect(f.calls.activations).toBe(0);
      expect(f.calls.turns).toHaveLength(0);
    }
  },
);

it.each(['ready', 'stopped', 'forgotten'] as const)(
  'lets only the winning same-session publisher activate and preserves its later %s state',
  async (state) => {
    const f = await fixture();
    const gate = Promise.withResolvers<void>();
    f.controls.publicationGate = gate.promise;
    const first = f.open();
    const pending = startOrgPlanSupervision(f.request, first.deps);
    try {
      await vi.waitFor(() => expect(f.controls.publicationGate).toBeNull());
      expect(first.sessions.list()).toHaveLength(0);
      const other = f.open();
      const accepted = await startOrgPlanSupervision(f.request, other.deps);
      expect(accepted).toMatchObject({ kind: 'started', session: { id: 'session-1' } });
      const current = other.sessions.find('session-1')!;
      if (state === 'forgotten') other.sessions.remove(current.id);
      else
        other.sessions.save(
          state === 'stopped'
            ? RelaySession.rehydrate(current).stop('2026-11-08T12:01:00Z').snapshot
            : { ...current, state: 'ready', activeTurnId: null },
        );
      gate.resolve();
      const late = await pending;
      if (state === 'forgotten') {
        expect(other.sessions.list()).toHaveLength(0);
        expect(late).toMatchObject({ kind: 'blocked' });
      } else {
        expect(other.sessions.find(current.id)?.state).toBe(state);
        expect(late).toMatchObject({ kind: 'started', session: { id: current.id, state } });
      }
      expect(f.calls.publications).toBe(1);
      expect(f.calls.activations).toBe(1);
      expect(f.calls.turns).toEqual(['org-plan-bootstrap:intent']);
    } finally {
      gate.resolve();
      await Promise.allSettled([pending]);
    }
  },
);

it('revokes a stale delayed publisher before releasing ownership and admitting a newly confirmed intent', async () => {
  const f = await fixture();
  const gate = Promise.withResolvers<void>();
  f.controls.publicationGate = gate.promise;
  const first = f.open();
  const pending = startOrgPlanSupervision(f.request, first.deps);
  try {
    await vi.waitFor(() => expect(f.controls.publicationGate).toBeNull());
    await writeFile(f.planPath, f.source.replace('TODO', 'WIP'));
    const other = f.open();
    expect(await startOrgPlanSupervision(f.request, other.deps)).toMatchObject({
      kind: 'blocked',
      code: 'CONTEXT_CHANGED',
    });
    expect(other.launches.find('intent')).toMatchObject({
      phase: 'reserved',
      notPersisted: true,
      publicationRevision: 1,
    });
    expect(other.launches.owner(f.context.sourcePath)).toBeNull();
    const read = await new FilesystemWorkspacePlanCatalog().readExecution(
      f.context.workspace.path,
      '.gestalt/plan.org',
    );
    if (read.kind !== 'available') throw new Error('FIXTURE_PLAN_UNAVAILABLE');
    const renewed = await startOrgPlanSupervision(
      { ...f.request, launchId: 'renewed', expectedRevision: read.revision },
      other.deps,
    );
    expect(renewed).toMatchObject({ kind: 'started', session: { id: 'session-2' } });
    gate.resolve();
    expect(await pending).toMatchObject({ kind: 'blocked' });
    expect(other.sessions.list().map((session) => session.id)).toEqual(['session-2']);
    expect(f.calls.publications).toBe(1);
    expect(f.calls.activations).toBe(1);
    expect(f.calls.turns).toEqual(['org-plan-bootstrap:renewed']);
  } finally {
    gate.resolve();
    await Promise.allSettled([pending]);
  }
});
