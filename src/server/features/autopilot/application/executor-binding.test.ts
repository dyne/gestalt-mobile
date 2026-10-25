/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { AutopilotCoordinator } from './service.js';
import { defaultAutopilotPolicy } from './policy.js';
import { disabledAutopilot } from '../domain/autopilot-session.js';
import { executorAssignment, type ExecutorLifecycle } from '../domain/supervised-lifecycle.js';
import type { AgentActivitySnapshot } from '../../agent-activity/model.js';
import type { SupervisedPlan } from '../../plans/domain/supervised-plan.js';
import { ExecutorModelEvidenceReader } from '../../plans/application/executor-model-evidence.js';
import { migrate } from '../../../platform/persistence/migrate.js';
import { SqliteAutopilotStore } from '../../../platform/persistence/sqlite-autopilot-store.js';

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
    now: () => now,
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
