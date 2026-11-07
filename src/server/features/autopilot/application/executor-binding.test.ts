/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { AutopilotCoordinator, fingerprint } from './service.js';
import { defaultAutopilotPolicy } from './policy.js';
import { disabledAutopilot } from '../domain/autopilot-session.js';
import { executorAssignment, type ExecutorLifecycle } from '../domain/supervised-lifecycle.js';
import type { AgentActivitySnapshot } from '../../agent-activity/model.js';
import type { SupervisedPlan } from '../../plans/domain/supervised-plan.js';
import { ExecutorModelEvidenceReader } from '../../plans/application/executor-model-evidence.js';
import { migrate } from '../../../platform/persistence/migrate.js';
import { SqliteAutopilotStore } from '../../../platform/persistence/sqlite-autopilot-store.js';
import { compactSupervisionSnapshot, SupervisionSnapshots } from './supervision-snapshot.js';

const now = '2026-10-25T01:06:00Z';
const policy = {
  version: 1 as const,
  model: 'gpt-6.1-sol' as const,
  reasoningEffort: 'medium' as const,
  rationale: 'Existing selected policy',
  allowedFallbacks: [],
  escalationTrigger: 'Focused regression',
  necessity: null,
};
const child = (position: number, state: 'idle' | 'working' = 'working') => ({
  id: `child-${position}`,
  threadId: `child-${position}`,
  taskPath: `/root/l${position}`,
  canonicalTaskName: `l${position}`,
  canonicalPosition: `L${position}`,
  continuationGeneration: 1,
  state,
  outcome: 'partial' as const,
  reason: 'turnActive' as const,
  observedAt: now,
  lastActivityAt: now,
  ownedProcesses: [],
});
function fixture(pending = false, enabled = true) {
  let clock = now;
  const db = new DatabaseSync(':memory:');
  migrate(db);
  db.exec(
    "INSERT INTO relay_sessions (id,workspace_id,workspace_path,profile,state,desired_state,failure_count,next_sequence,created_at,updated_at) VALUES ('s','w','/w','p','ready','active',0,1,'t','t')",
  );
  const store = new SqliteAutopilotStore(db);
  let plan: SupervisedPlan = {
    title: 'Handoff',
    modelPolicyVersion: 1,
    totalSteps: 2,
    doneSteps: 1,
    allDone: false,
    currentStepId: 'second',
    steps: [
      {
        id: 'first',
        title: 'Accepted',
        level: 1,
        state: 'DONE',
        priority: 'A',
        reviewStatus: 'REVIEWED',
        description: {},
        modelPolicy: policy,
        children: [],
      },
      {
        id: 'second',
        title: 'New work',
        level: 1,
        state: 'WIP',
        priority: 'A',
        reviewStatus: 'UNREVIEWED',
        description: {},
        modelPolicy: policy,
        children: [],
      },
    ],
  };
  let activity: AgentActivitySnapshot = {
    sessionId: 's',
    rootThreadId: 'root',
    confidence: 'fresh',
    root: { state: 'working', reason: 'turnActive', observedAt: now, lastActivityAt: now },
    aggregateSubagents: 'working',
    subagents: [child(1, 'idle'), child(2)],
  };
  const old: ExecutorLifecycle = {
    canonicalPosition: 'L1',
    canonicalTaskName: 'l1',
    threadId: 'child-1',
    taskPath: '/root/l1',
    l1State: 'DONE',
    lastActivityAt: now,
    ownedProcesses: [],
    outcome: 'objective_complete',
    continuationGeneration: 1,
    continuationCount: 3,
    resumeFailures: 2,
  };
  store.save({
    ...disabledAutopilot('s', now),
    requestedEnabled: enabled,
    state: !enabled ? 'disabled' : pending ? 'attentionRequired' : 'monitoring',
    stopReason: !enabled ? 'manualDisabled' : pending ? 'attentionRequired' : null,
    generation: 7,
    planIdentity: 'plan',
    executor: { ...old, assignment: executorAssignment(old, 'closed') },
  });
  const start = vi.fn(async () => {}),
    resume = vi.fn(async () => {}),
    interrupt = vi.fn(async () => true);
  const schedule = vi.fn(() => () => {});
  const events: string[] = [];
  const coordinator = new AutopilotCoordinator({
    store,
    now: () => clock,
    policy: defaultAutopilotPolicy,
    plan: () => ({ plan, identity: 'plan' }),
    session: () => ({ state: 'ready', threadId: 'root', activeTurnId: 'root-turn' }),
    activity: () => activity,
    pendingInteraction: () => pending,
    reconcile: async () => ({ compatible: true }),
    schedule,
    nextControlId: () => 'control',
    turnStarter: { start },
    publish: (_sessionId, type) => {
      events.push(type);
    },
    executorController: {
      resume,
      interrupt,
      refresh: async () => {},
      transferProcess: () => {},
      consumeProcess: () => {},
      terminateProcess: async () => true,
    },
  });
  const runtimeRead = vi.fn(async () => ({
    kind: 'observed' as const,
    configuration: {
      source: 'runtime-thread-metadata' as const,
      observationId: 'read',
      observedAt: now,
      model: 'gpt-6.1-sol',
      reasoningEffort: 'medium',
      role: 'default',
      settingsRevision: null,
      settingsFingerprint: 'local',
      catalog: {
        source: 'runtime' as const,
        revision: 'local-catalog',
        models: [{ id: 'gpt-6.1-sol', reasoningEfforts: ['medium'] }],
      },
    },
  }));
  const evidence = new ExecutorModelEvidenceReader(
    () => ({
      sessionId: 's',
      provider: 'codex',
      rootThreadId: 'root',
      planIdentity: 'plan',
      plan,
      executor: store.find('s')?.executor ?? null,
    }),
    { read: runtimeRead },
  );
  return {
    db,
    store,
    coordinator,
    start,
    resume,
    interrupt,
    schedule,
    evidence,
    runtimeRead,
    events,
    setClock: (value: string) => {
      clock = value;
    },
    getPlan: () => plan,
    setPlan: (value: SupervisedPlan) => {
      plan = value;
    },
    getActivity: () => activity,
    setActivity: (value: AgentActivitySnapshot) => {
      activity = value;
    },
    close: () => {
      coordinator.dispose('s');
      db.close();
    },
  };
}

describe('canonical executor handoff observations', () => {
  it.each([
    { pending: false, enabled: true },
    { pending: false, enabled: false },
    { pending: true, enabled: true },
  ])(
    'measures stable health and process observations without durable transitions (pending=$pending enabled=$enabled)',
    async ({ pending, enabled }) => {
      const f = fixture(pending, enabled);
      try {
        const process = {
          processId: 'measured-process',
          itemId: 'measured-item',
          ownerThreadId: 'child-2',
          ownerTaskPath: '/root/l2',
          ownership: 'executor' as const,
          state: 'running' as const,
          observedAt: now,
          elapsedMs: 0,
          cpuPercent: 1,
          rssBytes: 1024,
        };
        const activity = f.getActivity();
        f.setActivity({
          ...activity,
          subagents: [
            activity.subagents[0]!,
            { ...activity.subagents[1]!, ownedProcesses: [process] },
          ],
        });
        expect(f.coordinator.reconcileExecutorBinding('s').code).toBe('BINDING_RECONCILED');
        const retained = f.store.find('s')!;
        const snapshots = new SupervisionSnapshots();
        const read = async (sinceRevision?: string) => {
          const binding = f.coordinator.reconcileExecutorBinding('s');
          expect(binding.code).toBe('BINDING_MATCH');
          return snapshots.read(
            's',
            compactSupervisionSnapshot({
              autopilot: f.coordinator.snapshot('s'),
              plan: f.getPlan(),
              planIdentity: 'plan',
              activity: f.getActivity(),
              pendingInteractions: pending ? 1 : 0,
              tests: { enabled: true, running: 0, unread: 0, omitted: 0, runs: [] },
              wait: null,
              binding,
              modelPolicy: await f.evidence.read('s'),
              launch: null,
            }),
            sinceRevision,
          );
        };
        const first = await read();
        const changes = () => f.db.prepare('SELECT total_changes() AS n').get()!.n;
        const writesBefore = changes();
        const eventsBefore = f.events.length;
        const readsBefore = f.runtimeRead.mock.calls.length;
        for (let index = 1; index <= 5; index++) {
          const later = new Date(Date.parse(now) + index * 1000).toISOString();
          f.setClock(later);
          const previous = f.getActivity();
          f.setActivity({
            ...previous,
            root: { ...previous.root, observedAt: later },
            subagents: previous.subagents.map((agent) => ({
              ...agent,
              observedAt: later,
              lastActivityAt: later,
              ownedProcesses: agent.ownedProcesses?.map((owned) => ({
                ...owned,
                observedAt: later,
                elapsedMs: index * 1000,
                cpuPercent: index,
                rssBytes: 1024 + index,
              })),
            })),
          });
          expect(await read(first.revision)).toEqual({ revision: first.revision, unchanged: true });
        }
        expect({
          durableWrites: Number(changes()) - Number(writesBefore),
          events: f.events.length - eventsBefore,
          providerReads: f.runtimeRead.mock.calls.length - readsBefore,
        }).toEqual({ durableWrites: 0, events: 0, providerReads: 5 });
        expect(f.store.find('s')).toEqual(retained);
        expect(f.store.find('s')!.executor!.ownedProcesses[0]!.observedAt).toBe(now);
        expect(
          f.events.filter((type) => type === 'autopilot.executor-binding-reconciled'),
        ).toHaveLength(1);
        const observed = await f.runtimeRead();
        f.runtimeRead.mockResolvedValueOnce({
          ...observed,
          configuration: { ...observed.configuration, model: 'gpt-6-astra' },
        });
        const modelChanged = await read(first.revision);
        expect(Object.keys(modelChanged.changes!)).toEqual(['modelPolicy']);
        expect(modelChanged.changes!.modelPolicy).toMatchObject({
          code: 'MODEL_MISMATCH',
          configuration: 'mismatch',
          effective: { model: 'gpt-6-astra' },
        });
        let previousRevision = f.coordinator.snapshot('s').supervisionDelta!.revision;
        for (const transition of [
          { ownership: 'supervisor' as const, state: 'detached-active' as const },
          {
            ownership: 'supervisor' as const,
            state: 'exited-awaiting-result' as const,
            exitStatus: 0,
            resultArtifact: 'child-2:measured-item',
          },
          {
            ownership: 'supervisor' as const,
            state: 'result-consumed' as const,
            exitStatus: 0,
            resultArtifact: 'child-2:measured-item',
          },
        ]) {
          const previous = f.getActivity();
          f.setActivity({
            ...previous,
            subagents: previous.subagents.map((agent) =>
              agent.id === 'child-2'
                ? { ...agent, ownedProcesses: [{ ...process, ...transition }] }
                : agent,
            ),
          });
          const count = f.events.filter(
            (type) => type === 'autopilot.executor-binding-reconciled',
          ).length;
          expect(f.coordinator.reconcileExecutorBinding('s').code).toBe('BINDING_RECONCILED');
          expect(
            f.events.filter((type) => type === 'autopilot.executor-binding-reconciled'),
          ).toHaveLength(count + 1);
          const current = f.coordinator.snapshot('s').supervisionDelta!.revision;
          expect(current).not.toBe(previousRevision);
          previousRevision = current;
          expect(f.store.find('s')!.executor!.ownedProcesses[0]).toMatchObject({
            ...transition,
            observedAt: now,
          });
          expect(f.coordinator.reconcileExecutorBinding('s').code).toBe('BINDING_MATCH');
        }
        expect(f.start).not.toHaveBeenCalled();
        expect(f.resume).not.toHaveBeenCalled();
        expect(f.schedule).not.toHaveBeenCalled();
      } finally {
        f.close();
      }
    },
  );

  it('does not journal unchanged command-bearing bindings after SQLite hydration', () => {
    const f = fixture();
    try {
      expect(f.coordinator.reconcileExecutorBinding('s').status).toBe('ready');
      const before = f.store.find('s')!;
      f.store.save({
        ...before,
        executor: {
          ...before.executor!,
          commands: [
            {
              commandId: 'retained-command',
              status: 'issued',
              planIdentity: 'plan',
              planFingerprint: fingerprint(f.getPlan()),
              canonicalPosition: 'L2',
              canonicalTaskName: 'l2',
              taskPath: '/root/l2',
              threadId: 'child-2',
              generation: 2,
              trigger: 'partial',
              createdAt: now,
              updatedAt: now,
            },
          ],
        },
      });
      const events = f.events.length;
      for (let i = 0; i < 5; i++)
        expect(f.coordinator.reconcileExecutorBinding('s').code).toBe('BINDING_MATCH');
      expect(f.events.length).toBe(events);
      expect(f.store.find('s')?.executor?.commands?.[0]?.status).toBe('issued');
    } finally {
      f.close();
    }
  });

  it('contains rejected plan-callback state and records recovery without replacing the valid executor', () => {
    const f = fixture();
    try {
      const previous = f.store.find('s')!;
      f.setActivity({
        ...f.getActivity(),
        subagents: [
          {
            ...child(2),
            ownedProcesses: Array.from({ length: 65 }, (_, n) => ({
              processId: `process-${n}`,
              itemId: `item-${n}`,
              ownerThreadId: 'child-2',
              ownerTaskPath: '/root/l2',
              state: 'running' as const,
              ownership: 'executor' as const,
              observedAt: now,
              elapsedMs: 0,
              cpuPercent: null,
              rssBytes: null,
            })),
          },
        ],
      });
      expect(() => f.coordinator.planStatusChanged('s')).not.toThrow();
      expect(f.store.find('s')).toMatchObject({
        executor: previous.executor,
        stopReason: 'reconcileFailed',
        generation: previous.generation + 1,
      });
      const event = f.db
        .prepare(
          "SELECT payload_json FROM autopilot_outbox WHERE session_id = 's' AND type = 'autopilot.operation-failed'",
        )
        .get() as { payload_json: string };
      expect(JSON.parse(event.payload_json)).toMatchObject({
        code: 'PERSISTENCE',
        reason: 'AUTOPILOT_STATE_INVALID',
      });
      expect(f.start).not.toHaveBeenCalled();
      expect(f.resume).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });

  it('contains a persisted invalid row on plan callbacks and leaves explicit Off recovery authoritative', () => {
    const f = fixture();
    try {
      f.db
        .prepare("UPDATE autopilot_sessions SET lifecycle_json = ? WHERE session_id = 's'")
        .run('{"executor":{}}');
      expect(() => f.coordinator.planStatusChanged('s')).not.toThrow();
      expect(f.coordinator.snapshot('s')).toMatchObject({
        health: { degradationReason: 'controllerUnavailable' },
      });
      expect(
        f.db.prepare("SELECT lifecycle_json FROM autopilot_sessions WHERE session_id = 's'").get(),
      ).toMatchObject({ lifecycle_json: '{"executor":{}}' });
      expect(f.start).not.toHaveBeenCalled();
      expect(f.resume).not.toHaveBeenCalled();
    } finally {
      f.db.prepare("DELETE FROM autopilot_sessions WHERE session_id = 's'").run();
      f.close();
    }
  });

  it.each([false, true])(
    'adopts the existing new executor while root is active (attention=%s)',
    async (pending) => {
      const f = fixture(pending);
      try {
        expect(await f.evidence.read('s')).toMatchObject({
          code: 'CONTROLLER_BINDING_INVALID',
          child: { threadId: 'child-1' },
        });
        f.coordinator.activityChanged('s');
        expect(f.store.find('s')?.executor).toMatchObject({
          canonicalPosition: 'L2',
          threadId: 'child-2',
          continuationCount: 0,
          assignment: { threadId: 'child-2', taskPath: '/root/l2', state: 'resumable' },
        });
        expect(await f.evidence.read('s')).toMatchObject({
          configuration: 'match',
          child: { threadId: 'child-2' },
        });
        expect(f.start).not.toHaveBeenCalled();
        expect(f.resume).not.toHaveBeenCalled();
        expect(f.interrupt).not.toHaveBeenCalled();
        expect(f.store.find('s')).toMatchObject({
          requestedEnabled: true,
          generation: 7,
          state: pending ? 'attentionRequired' : 'monitoring',
        });
      } finally {
        f.close();
      }
    },
  );

  it('reconciles during Manual Off without enabling or dispatching work', () => {
    const f = fixture(false, false);
    try {
      f.coordinator.activityChanged('s');
      expect(f.store.find('s')).toMatchObject({
        requestedEnabled: false,
        state: 'disabled',
        stopReason: 'manualDisabled',
        generation: 7,
        executor: { threadId: 'child-2', continuationCount: 0 },
      });
      expect(f.store.find('s')?.executor).not.toHaveProperty('resumeFailures');
      expect(f.start).not.toHaveBeenCalled();
      expect(f.resume).not.toHaveBeenCalled();
      expect(f.schedule).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });

  it('repairs a handoff through plan resync idempotently even after attention disabled automation', () => {
    const f = fixture(true, false);
    try {
      f.store.save({
        ...f.store.find('s')!,
        state: 'attentionRequired',
        stopReason: 'attentionRequired',
      });
      f.coordinator.planStatusChanged('s');
      f.coordinator.planStatusChanged('s');
      expect(f.store.find('s')).toMatchObject({
        state: 'attentionRequired',
        requestedEnabled: false,
        generation: 7,
        executor: { threadId: 'child-2', assignment: { state: 'resumable' } },
      });
      expect(
        f.events.filter((type) => type === 'autopilot.executor-binding-reconciled'),
      ).toHaveLength(1);
      expect(f.resume).not.toHaveBeenCalled();
      expect(f.interrupt).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });

  it.each([
    'stale',
    'wrong-root',
    'unreviewed',
    'previous-active',
    'duplicates',
    'closed-target',
  ] as const)('does not invent a sole writer from %s evidence', (scenario) => {
    const f = fixture();
    try {
      const a = f.getActivity();
      if (scenario === 'stale') f.setActivity({ ...a, confidence: 'stale' });
      if (scenario === 'wrong-root') f.setActivity({ ...a, rootThreadId: 'different-root' });
      if (scenario === 'unreviewed')
        f.setPlan({
          ...f.getPlan(),
          steps: [{ ...f.getPlan().steps[0]!, reviewStatus: 'UNREVIEWED' }, f.getPlan().steps[1]!],
        });
      if (scenario === 'previous-active') f.setActivity({ ...a, subagents: [child(1), child(2)] });
      if (scenario === 'duplicates')
        f.setActivity({
          ...a,
          subagents: [
            ...a.subagents,
            {
              ...child(2),
              id: 'unauthorized',
              threadId: 'unauthorized',
              taskPath: '/root/l2_g2',
              continuationGeneration: 2,
            },
          ],
        });
      if (scenario === 'closed-target')
        f.setActivity({
          ...a,
          subagents: [child(1, 'idle'), { ...child(2, 'idle'), outcome: 'cancelled' }],
        });
      const result = f.coordinator.reconcileExecutorBinding('s');
      expect(result.status).not.toBe('ready');
      expect(result.authorizesExecution).toBe(false);
      expect(f.store.find('s')?.executor?.threadId).toBe('child-1');
      expect(f.resume).not.toHaveBeenCalled();
      expect(f.interrupt).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });

  it('does not replace an assigned l2 with an unapproved physical generation', () => {
    const f = fixture();
    try {
      f.coordinator.reconcileExecutorBinding('s');
      f.setActivity({
        ...f.getActivity(),
        subagents: [
          child(1, 'idle'),
          {
            ...child(2),
            id: 'new',
            threadId: 'new',
            taskPath: '/root/l2_g2',
            continuationGeneration: 2,
          },
        ],
      });
      expect(f.coordinator.reconcileExecutorBinding('s')).toMatchObject({
        status: 'conflict',
        code: 'REPLACEMENT_NOT_AUTHORIZED',
      });
      expect(f.store.find('s')?.executor?.threadId).toBe('child-2');
    } finally {
      f.close();
    }
  });

  it('rejects duplicate physical children sharing an authorized replacement task', () => {
    const f = fixture();
    try {
      f.coordinator.reconcileExecutorBinding('s');
      const plan = f.getPlan();
      const planFingerprint = JSON.stringify(
        plan.steps.map((step) => [
          step.id,
          step.state,
          step.reviewStatus,
          step.children.map((child) => [child.id, child.state]),
          {
            version: 1,
            assurance: 'configured',
            model: step.modelPolicy?.model,
            reasoningEffort: step.modelPolicy?.reasoningEffort,
            necessity: step.modelPolicy?.necessity,
          },
        ]),
      );
      const state = f.store.find('s')!;
      f.store.save({
        ...state,
        executor: {
          ...state.executor!,
          replacement: {
            canonicalTaskName: 'l2',
            canonicalPosition: 'L2',
            taskName: 'l2_g2',
            generation: 2,
            planIdentity: 'plan',
            planFingerprint,
          },
        },
      });
      const replacement = {
        ...child(2, 'idle'),
        taskPath: '/root/l2_g2',
        continuationGeneration: 2,
      };
      f.setActivity({
        ...f.getActivity(),
        subagents: [
          child(1, 'idle'),
          child(2, 'idle'),
          { ...replacement, id: 'replacement-a', threadId: 'replacement-a' },
          { ...replacement, id: 'replacement-b', threadId: 'replacement-b' },
        ],
      });
      expect(f.coordinator.reconcileExecutorBinding('s')).toMatchObject({
        status: 'conflict',
        code: 'EXECUTOR_AMBIGUOUS',
      });
      expect(f.store.find('s')?.executor?.threadId).toBe('child-2');
      expect(f.resume).not.toHaveBeenCalled();
      expect(f.interrupt).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });

  it('binds the same interrupted/idle executor while attention remains pending', () => {
    const f = fixture(true);
    try {
      f.setActivity({
        ...f.getActivity(),
        aggregateSubagents: 'idle',
        subagents: [child(1, 'idle'), child(2, 'idle')],
      });
      expect(f.coordinator.reconcileExecutorBinding('s')).toMatchObject({ status: 'ready' });
      expect(f.store.find('s')).toMatchObject({
        state: 'attentionRequired',
        executor: { threadId: 'child-2', outcome: 'partial' },
      });
      expect(f.resume).not.toHaveBeenCalled();
      expect(f.interrupt).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });
});
