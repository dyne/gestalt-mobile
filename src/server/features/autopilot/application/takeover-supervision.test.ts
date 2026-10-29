/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { SupervisionTakeover } from './takeover-supervision.js';
import { fingerprint } from './service.js';
import { disabledAutopilot } from '../domain/autopilot-session.js';
import type { SupervisedPlan } from '../../plans/domain/supervised-plan.js';
import { RelaySession } from '../../sessions/model/relay-session.js';
import { migrate } from '../../../platform/persistence/migrate.js';
import { SqliteSessionRepository } from '../../../platform/persistence/sqlite-session-repository.js';
import { SqliteAutopilotStore } from '../../../platform/persistence/sqlite-autopilot-store.js';
import { SqliteSupervisionTakeoverStore } from '../../../platform/persistence/sqlite-supervision-takeover-store.js';

const now = '2026-10-29T16:00:00Z';
function fixture() {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  onTestFinished(() => db.close());
  const sessions = new SqliteSessionRepository(db);
  const states = new SqliteAutopilotStore(db);
  const owners = new SqliteSupervisionTakeoverStore(db, states);
  for (const id of ['old', 'new', 'other'])
    sessions.save(
      RelaySession.create({
        id,
        workspaceId: 'w',
        workspacePath: '/w',
        provider: 'codex',
        profile: 'default',
        now,
        effectiveSkillSelection: { skills: [] },
      })
        .bindThread(`${id}-root`, now)
        .startTurn(`${id}-turn`, now).snapshot,
    );
  const plan: SupervisedPlan = {
    title: 'Work',
    totalSteps: 3,
    doneSteps: 1,
    allDone: false,
    executionComplete: false,
    currentStepId: 'second',
    steps: [
      {
        id: 'l1',
        title: 'L1',
        level: 1,
        state: 'WIP',
        priority: 'A',
        reviewStatus: 'UNREVIEWED',
        description: {},
        children: [
          {
            id: 'first',
            title: 'First',
            level: 2,
            state: 'DONE',
            priority: 'A',
            description: {},
            children: [],
          },
          {
            id: 'second',
            title: 'Second',
            level: 2,
            state: 'WIP',
            priority: 'A',
            description: {},
            children: [],
          },
        ],
      },
    ],
  };
  states.save({
    ...disabledAutopilot('old', now),
    planIdentity: 'plan',
    planFingerprint: fingerprint(plan),
    executor: {
      canonicalPosition: 'L1',
      canonicalTaskName: 'l1',
      taskPath: '/root/l1',
      threadId: 'old-child',
      l1State: 'TODO',
      lastActivityAt: now,
      ownedProcesses: [],
      outcome: 'partial',
      continuationGeneration: 1,
      continuationCount: 3,
    },
    checkpoints: {
      protocolVersion: 1,
      planIdentity: 'plan',
      acceptedKeys: ['first'],
      reportedL1Ids: [],
      reportedL2Ids: [JSON.stringify(['l1', 'first'])],
      pendingTurnId: null,
      terminalReviewAccepted: false,
    },
  });
  states.save({ ...disabledAutopilot('new', now), planIdentity: 'plan' });
  states.save({ ...disabledAutopilot('other', now), planIdentity: 'elsewhere' });
  let held = false,
    localExecutor = false,
    admission = true;
  const order: string[] = [];
  const stop = vi.fn(async () => {
    order.push('stop');
    return true;
  });
  const changed = vi.fn();
  const takeover = new SupervisionTakeover({
    store: owners,
    now: () => now,
    context: (id) => ({
      session: sessions.find(id)!,
      plan,
      identity: 'plan',
      state: states.find(id),
      held,
      localExecutor,
      admission,
    }),
    predecessors: () => [
      { session: sessions.find('old')!, state: states.find('old')! },
      { session: sessions.find('other')!, state: states.find('other')! },
    ],
    fence: (id) => {
      order.push(`fence:${id}`);
    },
    stop,
    changed,
  });
  return {
    db,
    sessions,
    states,
    owners,
    takeover,
    stop,
    changed,
    order,
    plan,
    held: () => {
      held = true;
    },
    local: () => {
      localExecutor = true;
    },
    deny: () => {
      admission = false;
    },
  };
}

describe('user-directed supervision takeover', () => {
  it('preserves L1/L2 state and checkpoints, fences the old root, and authorizes one reachable replacement without an attention approval', async () => {
    const f = fixture();
    const result = await f.takeover.takeOver('new', 'new-root', 'new-turn');
    expect(result).toMatchObject({
      accepted: true,
      alreadyOwner: false,
      identity: { canonicalTaskName: 'l1', taskName: 'l1_g2', generation: 2 },
      previousSessionIds: ['old'],
    });
    expect(f.order).toEqual(['fence:old', 'stop']);
    expect(f.states.find('new')).toMatchObject({
      requestedEnabled: true,
      state: 'monitoring',
      executor: {
        l1State: 'WIP',
        replacement: { taskName: 'l1_g2', reason: 'userDirectedTakeover' },
      },
      checkpoints: { reportedL2Ids: [JSON.stringify(['l1', 'first'])] },
    });
    expect(f.plan.steps[0]!.children.map((child) => child.state)).toEqual(['DONE', 'WIP']);
    expect(f.states.find('new')!.blocking).toBeUndefined();
    expect(f.db.prepare('SELECT count(*) AS n FROM pending_interactions').get()).toEqual({ n: 0 });
    expect(f.states.drainOutbox('new').map((e) => e.type)).toEqual([
      'autopilot.supervisor-taken-over',
    ]);
    expect(f.changed).toHaveBeenCalledOnce();
    expect(await f.takeover.takeOver('new', 'new-root', 'new-turn')).toMatchObject({
      accepted: true,
      alreadyOwner: true,
      identity: { taskName: 'l1_g2', generation: 2 },
    });
    expect(f.stop).toHaveBeenCalledOnce();
  });
  it('keeps a committed takeover accepted when refresh publication fails and replays the same pending launch', async () => {
    const f = fixture();
    f.changed.mockImplementation(() => {
      throw new Error('PUBLISH_FAILED');
    });
    expect(await f.takeover.takeOver('new', 'new-root', 'new-turn')).toMatchObject({
      accepted: true,
      identity: { taskName: 'l1_g2' },
    });
    expect(await f.takeover.takeOver('new', 'new-root', 'new-turn')).toMatchObject({
      accepted: true,
      alreadyOwner: true,
      identity: { taskName: 'l1_g2' },
    });
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.states.drainOutbox('new')).toHaveLength(1);
  });

  it('does not grant a replacement when the old writer cannot be confirmed stopped, and retries without another permission request', async () => {
    const f = fixture();
    f.stop.mockResolvedValueOnce(false);
    expect(await f.takeover.takeOver('new', 'new-root', 'new-turn')).toEqual({
      accepted: false,
      code: 'PREVIOUS_WRITER_NOT_STOPPED',
    });
    expect(f.states.find('new')!.executor).toBeUndefined();
    expect(f.owners.owner('plan')!.phase).toBe('stopping');
    expect(await f.takeover.takeOver('new', 'new-root', 'new-turn')).toMatchObject({
      accepted: true,
      identity: { taskName: 'l1_g2' },
    });
  });

  it.each(['interaction', 'executor', 'admission'] as const)(
    'preserves the independent %s gate',
    async (gate) => {
      const f = fixture();
      if (gate === 'interaction') f.held();
      if (gate === 'executor') f.local();
      if (gate === 'admission') f.deny();
      expect(await f.takeover.takeOver('new', 'new-root', 'new-turn')).toMatchObject({
        accepted: false,
      });
      expect(f.stop).not.toHaveBeenCalled();
      expect(f.owners.owner('plan')).toBeNull();
    },
  );

  it('requires the current physical root turn', async () => {
    const f = fixture();
    expect(await f.takeover.takeOver('new', 'old-root', 'new-turn')).toEqual({
      accepted: false,
      code: 'CURRENT_ROOT_REQUIRED',
    });
    expect(f.stop).not.toHaveBeenCalled();
  });

  it('does not revive Manual Off that races the stop operation', async () => {
    const f = fixture();
    f.stop.mockImplementationOnce(async () => {
      const s = f.states.find('new')!;
      f.states.save({ ...s, generation: s.generation + 1 });
      return true;
    });
    expect(await f.takeover.takeOver('new', 'new-root', 'new-turn')).toEqual({
      accepted: false,
      code: 'TAKEOVER_CONTEXT_CHANGED',
    });
    expect(f.states.find('new')!.requestedEnabled).toBe(false);
  });
  it('transfers an unreported checkpoint to the current root turn before allowing later executor work', async () => {
    const f = fixture();
    const old = f.states.find('old')!;
    f.states.save({
      ...old,
      checkpoints: { ...old.checkpoints!, pendingTurnId: 'old-turn', pendingKind: 'l2Completed' },
    });
    expect(await f.takeover.takeOver('new', 'new-root', 'new-turn')).toMatchObject({
      accepted: true,
      boundaryFinalRequired: true,
    });
    expect(f.states.find('new')!.checkpoints).toMatchObject({
      pendingTurnId: 'new-turn',
      pendingKind: 'l2Completed',
    });
  });
  it('rejects a root-turn change even when no controller generation changed', async () => {
    const f = fixture();
    f.stop.mockImplementationOnce(async () => {
      f.sessions.save({ ...f.sessions.find('new')!, activeTurnId: 'another-turn' });
      return true;
    });
    expect(await f.takeover.takeOver('new', 'new-root', 'new-turn')).toEqual({
      accepted: false,
      code: 'TAKEOVER_CONTEXT_CHANGED',
    });
    expect(f.states.find('new')!.executor).toBeUndefined();
    // A confirmed stop survives a new root turn and an archived runtime.
    f.stop.mockRejectedValue(new Error('ARCHIVED_RUNTIME'));
    expect(await f.takeover.takeOver('new', 'new-root', 'another-turn')).toMatchObject({
      accepted: true,
    });
    expect(f.stop).toHaveBeenCalledOnce();
  });

  it('serializes simultaneous takeover requests and persists the reservation across coordinator reconstruction', async () => {
    const f = fixture();
    const barrier = Promise.withResolvers<boolean>();
    f.stop.mockImplementationOnce(() => barrier.promise);
    const first = f.takeover.takeOver('new', 'new-root', 'new-turn');
    const duplicate = f.takeover.takeOver('new', 'new-root', 'new-turn');
    expect(f.stop).toHaveBeenCalledOnce();
    expect(new SqliteSupervisionTakeoverStore(f.db, f.states).claim('plan', 'other')).toBeNull();
    barrier.resolve(true);
    await expect(first).resolves.toMatchObject({ accepted: true });
    await expect(duplicate).resolves.toMatchObject({ accepted: true });
    expect(f.stop).toHaveBeenCalledOnce();
  });
  it('allows a directed takeover to supersede an abandoned reservation after its root turn ended', () => {
    const f = fixture();
    const oldClaim = f.owners.claim('plan', 'new')!;
    f.sessions.save({ ...f.sessions.find('new')!, state: 'ready', activeTurnId: null });
    expect(f.owners.claim('plan', 'other')).toMatchObject({
      sessionId: 'other',
      epoch: oldClaim.epoch + 1,
    });
    expect(f.owners.markStopped(oldClaim, 'old')).toBe(false);
  });
});
