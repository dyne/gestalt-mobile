/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { expect, it } from 'vitest';
import { compactSupervisionSnapshot, SupervisionSnapshots } from './supervision-snapshot.js';
import { autopilotSnapshot, disabledAutopilot } from '../domain/autopilot-session.js';
import { createAgentActivitySnapshot } from '../../agent-activity/model.js';
import type { SupervisedPlan } from '../../plans/domain/supervised-plan.js';

const input = () => ({
  autopilot: autopilotSnapshot(disabledAutopilot('s', '2026-10-28T00:00:00Z'), 3),
  plan: null,
  planIdentity: null,
  activity: createAgentActivitySnapshot('s', '2026-10-28T00:00:00Z'),
  pendingInteractions: 0,
  tests: { enabled: true, running: 0, unread: 0, runs: [], omitted: 0 },
  wait: null,
  binding: null,
  modelPolicy: null,
  launch: null,
});

it('preserves suspension, unreviewed completion and denied execution admission', () => {
  const original = input();
  const plan: SupervisedPlan = {
    title: 'fixture',
    totalSteps: 1,
    doneSteps: 1,
    allDone: true,
    currentStepId: 'parent',
    steps: [
      {
        id: 'parent',
        title: 'fixture',
        level: 1,
        state: 'DONE',
        reviewStatus: 'UNREVIEWED',
        priority: 'A',
        description: {},
        children: [],
      },
    ],
  };
  const denied = compactSupervisionSnapshot({
    ...original,
    plan,
    autopilot: {
      ...original.autopilot,
      executionAdmission: {
        allowed: false,
        code: 'AUTOPILOT_MODEL_POLICY_UNAVAILABLE',
        reason: 'POLICY_PROJECTION_UNAVAILABLE',
        action: 'Repair policy',
      },
    },
  });
  expect(denied.plan?.complete).toBe(false);
  expect(denied.admission).toMatchObject({
    allowed: false,
    reason: 'POLICY_PROJECTION_UNAVAILABLE',
  });
  expect(
    compactSupervisionSnapshot({
      ...original,
      plan: { ...plan, steps: [{ ...plan.steps[0]!, state: 'SUSPENDED' }] },
    }).plan,
  ).toMatchObject({
    l1: null,
    complete: false,
    barrier: { id: 'parent', state: 'SUSPENDED' },
  });
});

it('invalidates the plan section for changed instructions but ignores measurement updates', () => {
  const original = input();
  const plan: SupervisedPlan = {
    title: 'fixture',
    currentStepId: 'parent',
    totalSteps: 1,
    doneSteps: 0,
    allDone: false,
    steps: [
      {
        id: 'parent',
        title: 'fixture',
        state: 'WIP',
        level: 1,
        priority: 'A',
        reviewStatus: 'UNREVIEWED',
        description: { goal: 'First goal' },
        children: [],
      },
    ],
  };
  const cache = new SupervisionSnapshots();
  const first = cache.read('s', compactSupervisionSnapshot({ ...original, plan }));
  const heartbeat = { ...plan, steps: [{ ...plan.steps[0]!, measurement: { tokensUsed: 1234 } }] };
  expect(
    cache.read('s', compactSupervisionSnapshot({ ...original, plan: heartbeat }), first.revision),
  ).toMatchObject({ unchanged: true });
  const changed = {
    ...plan,
    steps: [{ ...plan.steps[0]!, description: { goal: 'Revised goal' } }],
  };
  const response = cache.read(
    's',
    compactSupervisionSnapshot({ ...original, plan: changed }),
    first.revision,
  );
  expect(Object.keys(response.changes!)).toEqual(['plan']);
  expect(JSON.stringify(response)).not.toContain('Revised goal');
});

it('ignores heartbeat timestamps, returns a small unchanged response and only changed sections', () => {
  const cache = new SupervisionSnapshots();
  const original = input();
  const first = cache.read('s', compactSupervisionSnapshot(original));
  const later = structuredClone(original);
  later.autopilot = {
    ...later.autopilot,
    updatedAt: '2026-10-28T01:00:00Z',
    health: { ...later.autopilot.health, observedAt: '2026-10-28T01:00:00Z' },
  };
  const unchanged = cache.read('s', compactSupervisionSnapshot(later), first.revision);
  expect(unchanged).toEqual({ revision: first.revision, unchanged: true });
  expect(Buffer.byteLength(JSON.stringify(unchanged))).toBeLessThan(120);
  const changed = cache.read(
    's',
    compactSupervisionSnapshot({
      ...later,
      tests: {
        enabled: true,
        running: 1,
        unread: 0,
        omitted: 0,
        runs: [
          { runId: '00000000-0000-4000-8000-000000000001', suite: 'focused', state: 'running' },
        ],
      },
    }),
    first.revision,
  );
  expect(Object.keys(changed.changes!)).toEqual(['tests']);
  expect(Buffer.byteLength(JSON.stringify(changed))).toBeLessThan(400);
});

it('represents removals explicitly and falls back to a full view for unknown or evicted revisions', () => {
  const cache = new SupervisionSnapshots();
  const snapshot = compactSupervisionSnapshot(input());
  const first = cache.read('s', { ...snapshot, binding: { status: 'ready', code: 'BOUND' } });
  const removal = cache.read('s', snapshot, first.revision);
  expect(removal.changes).toEqual({ binding: null });
  expect(cache.read('another-session', snapshot, first.revision)).toMatchObject({
    reset: true,
    snapshot,
  });
  for (let pendingInteractions = 1; pendingInteractions < 12; pendingInteractions++) {
    cache.read('s', { ...snapshot, control: { ...snapshot.control, pendingInteractions } });
  }
  expect(cache.read('s', snapshot, first.revision)).toMatchObject({ reset: true, snapshot });
  expect(new SupervisionSnapshots().read('s', snapshot, first.revision)).toMatchObject({
    reset: true,
    snapshot,
  });
});

it('bounds roster output and excludes task prose, process histories and source paths', () => {
  const original = input();
  const snapshot = compactSupervisionSnapshot({
    ...original,
    activity: {
      ...original.activity,
      subagents: Array.from({ length: 100 }, (_, n) => ({
        id: `agent-${n}`,
        nickname: 'private prose',
        taskPath: '/private/workspace/task',
        state: 'idle' as const,
        reason: 'turnCompleted' as const,
        observedAt: 't',
        lastActivityAt: 't',
      })),
    },
  });
  expect(snapshot.activity).toMatchObject({ total: 100, omitted: 92 });
  expect(snapshot.activity.agents).toHaveLength(8);
  expect(JSON.stringify(snapshot)).not.toMatch(/private prose|private\/workspace|observedAt/);
  const reversed = compactSupervisionSnapshot({
    ...original,
    activity: {
      ...original.activity,
      subagents: Array.from({ length: 100 }, (_, n) => ({
        id: `agent-${99 - n}`,
        state: 'idle' as const,
        reason: 'turnCompleted' as const,
        observedAt: 'later',
        lastActivityAt: 'later',
      })),
    },
  });
  expect(reversed).toEqual(snapshot);
});
