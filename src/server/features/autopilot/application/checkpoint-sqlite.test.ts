/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { AutopilotCoordinator } from './service.js';
import { defaultAutopilotPolicy } from './policy.js';
import {
  createAgentActivitySnapshot,
  type AgentActivitySnapshot,
} from '../../agent-activity/model.js';
import type { AutopilotSession } from '../domain/autopilot-session.js';
import { executorAssignment } from '../domain/supervised-lifecycle.js';
import type { SupervisedPlan } from '../../plans/domain/supervised-plan.js';
import { MAX_PLAN_FINGERPRINT_BYTES, parsePlanFingerprint } from '../domain/plan-fingerprint.js';
import { migrate } from '../../../platform/persistence/migrate.js';
import { SqliteAutopilotStore } from '../../../platform/persistence/sqlite-autopilot-store.js';

// Stable, synthetic multi-milestone fixture. Never reads a user's relay database.
const now = '2026-10-05T18:23:40.593Z';
const plan: SupervisedPlan = {
  title: 'Website release',
  currentStepId: 'release-1',
  totalSteps: 6,
  doneSteps: 0,
  allDone: false,
  executionComplete: false,
  steps: Array.from({ length: 6 }, (_, i) => ({
    id: `release-${i + 1}`,
    title: `Release milestone ${i + 1}`,
    level: 1,
    state: i === 0 ? 'WIP' : 'TODO',
    reviewStatus: 'UNREVIEWED',
    priority: 'A',
    description: {},
    children: Array.from({ length: 3 }, (_, j) => ({
      id: `release-${i + 1}-task-${j + 1}`,
      title: `Task ${j + 1}`,
      level: 2,
      state: i === 0 && j === 0 ? 'DONE' : 'TODO',
      description: {},
      priority: 'A',
      children: [],
    })),
  })),
};
const fingerprint = JSON.stringify(
  plan.steps.map((step) => [
    step.id,
    step.state,
    step.reviewStatus,
    step.children.map((child) => [child.id, child.state]),
  ]),
);
const executor = {
  canonicalPosition: 'L1',
  canonicalTaskName: 'l1',
  taskPath: '/root/l1',
  threadId: 'child',
  l1State: 'WIP' as const,
  lastActivityAt: now,
  ownedProcesses: [],
  outcome: 'partial' as const,
  continuationGeneration: 1,
  continuationCount: 0,
};
const base: AutopilotSession = {
  sessionId: 's',
  state: 'monitoring',
  requestedEnabled: true,
  planIdentity: 'plan',
  planFingerprint: fingerprint,
  generation: 1,
  consecutiveNoProgress: 0,
  nextEvaluationAt: null,
  lastControlId: null,
  stopReason: null,
  updatedAt: now,
  executor,
};
function database() {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  db.prepare(
    "INSERT INTO relay_sessions (id,workspace_id,workspace_path,profile,state,desired_state,failure_count,next_sequence,created_at,updated_at) VALUES ('s','w','/w','p','ready','active',0,1,?,?)",
  ).run(now, now);
  return db;
}
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};

describe('checkpoint continuation across SQLite', () => {
  it('reports a realistic plan checkpoint and resumes the same executor exactly once', async () => {
    const db = database();
    try {
      const store = new SqliteAutopilotStore(db);
      expect(fingerprint.length).toBeGreaterThan(512);
      store.save({
        ...base,
        executor: { ...executor, assignment: executorAssignment(executor) },
        checkpoints: {
          protocolVersion: 1,
          planIdentity: 'plan',
          completionEpochs: [
            {
              target: JSON.stringify(['l2', 'release-1', 'release-1-task-1']),
              epoch: 0,
              reopened: false,
              completed: true,
            },
          ],
          reportedL2Ids: [JSON.stringify(['release-1', 'release-1-task-1'])],
          reportedL1Ids: [],
          acceptedKeys: ['key'],
          pendingTurnId: 'root-turn',
          pendingKind: 'l2Completed',
          activeHandoffId: 'handoff',
          terminalReviewAccepted: false,
        },
      });
      const activity: AgentActivitySnapshot = {
        ...createAgentActivitySnapshot('s', now),
        root: { state: 'idle', reason: 'turnCompleted', observedAt: now, lastActivityAt: now },
        confidence: 'fresh',
        aggregateSubagents: 'idle',
        subagents: [
          {
            id: 'child',
            ...executor,
            state: 'idle',
            reason: 'turnCompleted',
            observedAt: now,
          },
        ],
      };
      const timers: Array<{ callback: () => void; cancelled: boolean }> = [];
      const resume = vi.fn(async () => {});
      const publish = vi.fn();
      const coordinator = new AutopilotCoordinator({
        store,
        now: () => now,
        policy: defaultAutopilotPolicy,
        plan: () => ({ plan, identity: 'plan' }),
        session: () => ({ state: 'ready', threadId: 'root', activeTurnId: null }),
        activity: () => activity,
        pendingInteraction: () => false,
        reconcile: async () => ({ compatible: true }),
        nextControlId: () => 'control',
        schedule: (callback) => {
          const timer = { callback, cancelled: false };
          timers.push(timer);
          return () => {
            timer.cancelled = true;
          };
        },
        turnStarter: { start: async () => {} },
        executorController: {
          resume,
          refresh: async () => {},
          interrupt: async () => true,
          transferProcess: () => {},
          consumeProcess: () => {},
          terminateProcess: async () => true,
        },
        publish,
      });
      coordinator.turnCompleted('s');
      await settle();
      expect(publish.mock.calls.some((call) => call[1] === 'org-plan.step-reported')).toBe(true);
      expect(store.find('s')?.checkpoints?.pendingTurnId).toBeNull();
      const scheduled = timers.filter((timer) => !timer.cancelled);
      expect(scheduled).toHaveLength(1);
      scheduled[0]!.callback();
      await settle();
      scheduled[0]!.callback();
      await settle();
      expect(resume).toHaveBeenCalledTimes(1);
      expect(resume.mock.calls[0]).toEqual(expect.arrayContaining(['s', 'child']));
      expect(store.find('s')).toMatchObject({
        executor: {
          threadId: 'child',
          assignment: executorAssignment(executor),
          commands: [expect.objectContaining({ planFingerprint: fingerprint, status: 'accepted' })],
        },
        checkpoints: { acceptedKeys: ['key'] },
      });
    } finally {
      db.close();
    }
  });

  it.each([
    undefined,
    ...(['transfer', 'consume', 'terminate'] as const).map((kind) => ({
      kind,
      processKey: 'process-key',
    })),
  ])('round-trips command and replacement fingerprints (%j)', (processAction) => {
    const db = database();
    try {
      const store = new SqliteAutopilotStore(db);
      const state: AutopilotSession = {
        ...base,
        executor: {
          ...executor,
          replacement: {
            canonicalPosition: 'L1',
            canonicalTaskName: 'l1',
            taskName: 'l1_g2',
            generation: 2,
            planIdentity: 'plan',
            planFingerprint: fingerprint,
          },
          commands: [
            {
              commandId: 'command',
              status: 'scheduled',
              planIdentity: 'plan',
              planFingerprint: fingerprint,
              canonicalPosition: 'L1',
              canonicalTaskName: 'l1',
              taskPath: '/root/l1',
              threadId: 'child',
              generation: 1,
              trigger: processAction ? 'processExited' : 'partial',
              processAction,
              createdAt: now,
              updatedAt: now,
            },
          ],
        },
      };
      store.save(state);
      expect(store.find('s')).toEqual(state);
      const invalid = { ...state, planFingerprint: 'x'.repeat(MAX_PLAN_FINGERPRINT_BYTES + 1) };
      expect(() =>
        store.commit({
          state: invalid,
          events: [{ sessionId: 's', type: 'test', payload: {}, occurredAt: now }],
        }),
      ).toThrow('AUTOPILOT_STATE_INVALID');
      expect(store.find('s')).toEqual(state);
      expect(store.drainOutbox('s')).toEqual([]);
      expect(() =>
        store.save({
          ...state,
          executor: {
            ...state.executor!,
            commands: [
              { ...state.executor!.commands![0]!, planFingerprint: invalid.planFingerprint },
            ],
          },
        }),
      ).toThrow('AUTOPILOT_STATE_INVALID');
      expect(store.find('s')).toEqual(state);
      expect(() =>
        store.save({
          ...state,
          executor: {
            ...state.executor!,
            replacement: {
              ...state.executor!.replacement!,
              planFingerprint: invalid.planFingerprint,
            },
          },
        }),
      ).toThrow('AUTOPILOT_STATE_INVALID');
      // Each fingerprint is valid; the repeated command history exceeds the aggregate budget.
      const large = {
        ...state,
        executor: {
          ...state.executor!,
          commands: Array.from({ length: 24 }, (_, i) => ({
            ...state.executor!.commands![0]!,
            commandId: `command-${i}`,
            planFingerprint: 'x'.repeat(MAX_PLAN_FINGERPRINT_BYTES),
          })),
        },
      };
      expect(() => store.save(large)).toThrow('AUTOPILOT_STATE_INVALID');
      expect(store.find('s')).toEqual(state);
    } finally {
      db.close();
    }
  });

  it('uses UTF-8 fingerprint boundaries without trimming or truncation', () => {
    expect(parsePlanFingerprint('x'.repeat(512))).toHaveLength(512);
    expect(parsePlanFingerprint('x'.repeat(513))).toHaveLength(513);
    expect(parsePlanFingerprint('é'.repeat(MAX_PLAN_FINGERPRINT_BYTES / 2))).toBeDefined();
    expect(parsePlanFingerprint('é'.repeat(MAX_PLAN_FINGERPRINT_BYTES / 2 + 1))).toBeUndefined();
    expect(parsePlanFingerprint(' [] ')).toBe(' [] ');
  });

  it('diagnoses corruption without changing the row, then explicitly recovers Off with a retained original', () => {
    const db = database();
    try {
      const store = new SqliteAutopilotStore(db);
      store.save(base);
      db.prepare(
        "UPDATE autopilot_sessions SET lifecycle_json = '{broken' WHERE session_id = 's'",
      ).run();
      const before = db.prepare("SELECT * FROM autopilot_sessions WHERE session_id = 's'").get();
      expect(() => store.find('s')).toThrow('AUTOPILOT_STATE_INVALID');
      expect(db.prepare("SELECT * FROM autopilot_sessions WHERE session_id = 's'").get()).toEqual(
        before,
      );
      store.recoverInvalid('s', now);
      expect(store.find('s')).toMatchObject({
        state: 'disabled',
        requestedEnabled: false,
        stopReason: 'manualDisabled',
      });
      const retained = db.prepare('SELECT record_json FROM autopilot_state_quarantine').get() as {
        record_json: string;
      };
      expect(JSON.parse(retained.record_json)).toEqual(before);
      store.recoverInvalid('s', now);
      expect(db.prepare('SELECT * FROM autopilot_state_quarantine').all()).toHaveLength(1);
      expect(store.find('absent')).toBeNull();
    } finally {
      db.close();
    }
  });
});
