/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it, vi } from 'vitest';
import { toOrgPlanCheckpointToolResponse } from '../../../../shared/contracts/org-plan-checkpoint.js';
import {
  RelaySession,
  type PendingInteraction,
  type RelaySessionSnapshot,
} from '../../sessions/model/relay-session.js';
import type { SupervisedPlan } from '../../plans/domain/supervised-plan.js';
import { CheckpointCoordination, type CheckpointCoordinationPorts } from './coordinate.js';

const now = '2026-11-01T18:00:00.000Z';
const plan: SupervisedPlan = {
  title: 'Checkpoint plan',
  totalSteps: 2,
  doneSteps: 1,
  allDone: false,
  currentStepId: 'parent',
  steps: [
    {
      id: 'parent',
      title: 'Parent',
      level: 1,
      state: 'WIP',
      priority: 'A',
      reviewStatus: 'UNREVIEWED',
      description: {},
      children: [
        {
          id: 'child',
          title: 'Child',
          level: 2,
          state: 'DONE',
          priority: 'A',
          description: {},
          children: [],
        },
      ],
    },
  ],
};
const interaction: PendingInteraction = {
  requestId: 'request',
  kind: 'orgPlanCheckpoint',
  payload: {
    version: 1,
    kind: 'l2Completed',
    planIdentity: 'plan',
    l1Id: 'parent',
    l2Id: 'child',
    position: 'L1.1',
    status: 'DONE',
    changes: 'Done.',
    files: 'src/feature.ts',
    tests: 'Focused tests passed.',
  },
};
const authority = { activeTurnId: 'turn', rootOwned: true, compactKind: null };

function fixture() {
  const effects: string[] = [];
  const pending = new Map<string, PendingInteraction>();
  const replies: unknown[] = [];
  const saved: RelaySessionSnapshot[] = [];
  const timers: Array<{ callback(): void; cancelled: boolean }> = [];
  const ports: CheckpointCoordinationPorts = {
    plans: {
      refresh: async () => true,
      find: () => plan,
      identity: () => 'plan',
      publicationReason: () => 'l2:child:DONE',
      completedTargets: () => [],
      pendingTarget: () => undefined,
    },
    activity: () => ({ subagents: [] }),
    pending: {
      add: (id, value) => {
        effects.push('pending');
        pending.set(`${id}:${value.requestId}`, value);
      },
      find: (id, requestId) => pending.get(`${id}:${requestId}`) ?? null,
      list: (id) =>
        [...pending.entries()]
          .filter(([key]) => key.startsWith(`${id}:`))
          .map(([, value]) => value),
      resolve: (id, requestId, _at, outcome) => {
        if (!pending.delete(`${id}:${requestId}`)) return false;
        effects.push(`settle:${outcome}`);
        return true;
      },
    },
    autopilot: {
      accept: () => {
        effects.push('accepted');
        return 'recorded';
      },
      failed: () => {
        effects.push('handoff-failed');
        return true;
      },
      recover: () => {
        effects.push('recovered');
      },
    },
    writer: {
      resolve: (_id, _request, response) => {
        effects.push('reply');
        replies.push(response);
        return true;
      },
      reject: () => {
        effects.push('reject');
        return true;
      },
      recovery: () => null,
    },
    currentTurn: () => 'turn',
    saveSession: (session) => {
      saved.push(session);
      effects.push('save');
    },
    turnCompleted: () => {
      effects.push('turn-completed');
    },
    publishFailure: () => {
      effects.push('failure-audit');
    },
    publishSettlement: (_id, _request, _at, outcome) => {
      effects.push(`publish:${outcome}`);
    },
    failureResponse: (reasonCode, details) =>
      toOrgPlanCheckpointToolResponse('failed', { reasonCode, ...details }),
    now: () => now,
    schedule: (callback) => {
      effects.push('deadline');
      const timer = { callback, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    deadlineMs: 5_000,
  };
  return {
    ports,
    effects,
    pending,
    replies,
    timers,
    saved,
    coordinator: new CheckpointCoordination(ports),
  };
}

describe('checkpoint coordination', () => {
  it('waits for the authoritative refresh and preserves the failed transport outcome', async () => {
    const f = fixture();
    let release!: (ready: boolean) => void;
    const gate = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    f.ports.plans.refresh = () => gate;
    f.ports.writer.resolve = (_id, _request, response) => {
      f.replies.push(response);
      return false;
    };
    const refreshing = f.coordinator.refresh('session', 'request');
    try {
      expect(f.replies).toEqual([]);
      release(false);
      expect(await refreshing).toBe(false);
      expect(f.replies).toEqual([
        toOrgPlanCheckpointToolResponse('failed', { reasonCode: 'planProjectionUnavailable' }),
      ]);
      f.ports.plans.refresh = async () => true;
      expect(await f.coordinator.refresh('session', 'request')).toBeNull();
    } finally {
      release(false);
      await Promise.allSettled([refreshing]);
    }
  });

  it('expands the retained boundary and returns a typed failure when no boundary is available', () => {
    const f = fixture();
    expect(f.coordinator.expand('session', 'request', 'l2Completed')).toMatchObject({
      interaction: {
        requestId: 'request',
        payload: { l1Id: 'parent', l2Id: 'child', position: 'L1.1' },
      },
    });
    f.ports.plans.find = () => null;
    expect(f.coordinator.expand('session', 'request', 'l2Completed')).toEqual({ handled: true });
    expect(f.replies).toEqual([
      toOrgPlanCheckpointToolResponse('failed', { reasonCode: 'checkpointBoundaryAmbiguous' }),
    ]);
    expect(f.pending.size).toBe(0);
  });

  it.each(['rootNotOwner', 'planIdentityMismatch', 'rootTurnNotActive', 'l2NotDone'] as const)(
    'rejects %s before persisting a checkpoint or arming a deadline',
    (reasonCode) => {
      const f = fixture();
      const current = { ...authority };
      if (reasonCode === 'rootNotOwner') current.rootOwned = false;
      if (reasonCode === 'planIdentityMismatch') f.ports.plans.identity = () => 'other-plan';
      if (reasonCode === 'rootTurnNotActive') Object.assign(current, { activeTurnId: null });
      if (reasonCode === 'l2NotDone')
        f.ports.plans.find = () => ({
          ...plan,
          steps: [
            { ...plan.steps[0]!, children: [{ ...plan.steps[0]!.children[0]!, state: 'TODO' }] },
          ],
        });
      expect(f.coordinator.accept('session', interaction, current)).toBe(true);
      const response = f.replies[0] as ReturnType<typeof toOrgPlanCheckpointToolResponse>;
      expect(JSON.parse(response.contentItems[0]!.text)).toMatchObject({
        status: 'failed',
        reasonCode,
      });
      expect(f.effects).toEqual(['reply']);
      expect(f.pending.size).toBe(0);
    },
  );

  it('persists before acknowledging and settles only a successful response write once', () => {
    const f = fixture();
    expect(f.coordinator.accept('session', interaction, authority)).toBe(true);
    expect(f.effects).toEqual(['accepted', 'pending', 'deadline', 'reply']);
    expect(f.pending.get('session:request')).toMatchObject({ turnId: 'turn', requestedAt: now });
    expect(f.replies).toEqual([toOrgPlanCheckpointToolResponse('recorded')]);
    f.coordinator.responseSettled('session', 'request', 'resultWritten');
    f.coordinator.responseSettled('session', 'request', 'resultWritten');
    f.timers[0]!.callback();
    expect(f.effects.slice(4)).toEqual(['settle:answered', 'publish:answered']);
    expect(f.timers[0]!.cancelled).toBe(true);
    expect(f.pending.size).toBe(0);
  });

  it('replays an already recorded checkpoint without creating a pending handoff', () => {
    const f = fixture();
    f.ports.autopilot.accept = () => 'alreadyRecorded';
    expect(f.coordinator.accept('session', interaction, authority)).toBe(true);
    expect(f.replies).toEqual([toOrgPlanCheckpointToolResponse('alreadyRecorded')]);
    expect(f.pending.size).toBe(0);
    expect(f.timers).toEqual([]);
  });

  it.each(['before persistence', 'after persistence'] as const)(
    'handles an exception %s without inventing an acknowledgement',
    (phase) => {
      const f = fixture();
      f.ports.autopilot.accept = () => {
        throw new Error('injected persistence exception');
      };
      f.ports.autopilot.failed = () => phase === 'after persistence';
      expect(f.coordinator.accept('session', interaction, authority)).toBe(true);
      if (phase === 'before persistence') {
        expect(f.replies).toEqual([
          toOrgPlanCheckpointToolResponse('failed', { reasonCode: 'checkpointPersistenceFailed' }),
        ]);
        expect(f.effects).toEqual(['reply']);
      } else {
        expect(f.replies).toEqual([]);
        expect(f.effects).toEqual([
          'pending',
          'settle:failed',
          'failure-audit',
          'publish:failed',
          'reject',
        ]);
      }
      expect(f.pending.size).toBe(0);
      expect(f.timers).toEqual([]);
    },
  );

  it('ignores an obsolete deadline and retains a single failed handoff through late response settlement', () => {
    const f = fixture();
    f.coordinator.accept('session', interaction, authority);
    f.coordinator.accept('session', interaction, authority);
    expect(f.timers[0]!.cancelled).toBe(true);
    f.timers[0]!.callback();
    expect(f.pending.size).toBe(1);
    f.timers[1]!.callback();
    f.coordinator.responseSettled('session', 'request', 'resultWritten');
    f.timers[1]!.callback();
    expect(f.effects.filter((effect) => effect === 'failure-audit')).toHaveLength(1);
    expect(f.effects).not.toContain('publish:answered');
    expect(f.effects).not.toContain('recovered');
  });

  it('disposes only the session deadline and retains its durable checkpoint for restart', () => {
    const f = fixture();
    f.coordinator.accept('session', interaction, authority);
    f.coordinator.accept('other-session', interaction, authority);
    f.coordinator.disposeSession('session');
    expect(f.timers.map((timer) => timer.cancelled)).toEqual([true, false]);
    f.timers[0]!.callback();
    expect(f.pending.has('session:request')).toBe(true);
    f.timers[1]!.callback();
    expect(f.pending.has('other-session:request')).toBe(false);
    expect(f.pending.has('session:request')).toBe(true);
  });

  it.each([
    'runtime changed before recycle',
    'runtime changed during recycle',
    'root turn changed',
    'owned writer',
  ] as const)('fences checkpoint writer recovery when %s', async (scenario) => {
    const f = fixture();
    const rebuilt = {
      ...RelaySession.fromExistingThread({
        id: 'session',
        workspaceId: 'workspace',
        workspacePath: '/workspace',
        provider: 'codex',
        profile: 'default',
        threadId: 'thread',
        now,
      }).snapshot,
      state: 'turnActive' as const,
      activeTurnId: 'turn',
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let currentRuntime = scenario !== 'runtime changed before recycle';
    let started = false;
    let finished = false;
    let checkedAfterRecycle = false;
    const recycles: Array<Promise<RelaySessionSnapshot>> = [];
    f.ports.writer.reject = () => false;
    f.ports.writer.recovery = () => ({
      activeTurnId: 'turn',
      current: () => {
        if (finished) checkedAfterRecycle = true;
        return currentRuntime;
      },
      recycle: () => {
        started = true;
        const recycling = gate.then(() => {
          finished = true;
          return rebuilt;
        });
        recycles.push(recycling);
        return recycling;
      },
    });
    if (scenario === 'root turn changed') f.ports.currentTurn = () => 'new-turn';
    try {
      f.coordinator.accept('session', interaction, authority);
      f.coordinator.responseSettled('session', 'request', 'writeFailed');
      if (scenario === 'runtime changed before recycle' || scenario === 'root turn changed') {
        expect(started).toBe(false);
      } else {
        await vi.waitFor(() => expect(started).toBe(true));
        if (scenario === 'runtime changed during recycle') currentRuntime = false;
        release();
        await vi.waitFor(() => expect(checkedAfterRecycle).toBe(true));
      }
      if (scenario === 'owned writer') {
        expect(f.saved).toEqual([expect.objectContaining({ activeTurnId: null, state: 'ready' })]);
        expect(f.effects.slice(-3)).toEqual(['save', 'turn-completed', 'recovered']);
      } else {
        expect(f.saved).toEqual([]);
        expect(f.effects).not.toContain('recovered');
      }
      expect(f.effects.filter((effect) => effect === 'failure-audit')).toHaveLength(1);
    } finally {
      release();
      await Promise.allSettled(recycles);
      f.coordinator.disposeSession('session');
    }
  });

  it('fails only checkpoint interactions on exit and recovers their boundary only on explicit restoration', () => {
    const f = fixture();
    f.coordinator.accept('session', interaction, authority);
    f.pending.set('session:quiz', { requestId: 'quiz', kind: 'quiz', payload: {} });
    f.coordinator.failPending('session', false);
    expect(f.pending.has('session:quiz')).toBe(true);
    expect(f.pending.has('session:request')).toBe(false);
    expect(f.effects).not.toContain('recovered');
    f.coordinator.failPending('session', true);
    expect(f.effects.filter((effect) => effect === 'failure-audit')).toHaveLength(1);
    expect(f.effects.at(-1)).toBe('recovered');
  });
});
