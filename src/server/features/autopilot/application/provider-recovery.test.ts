/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../../../platform/persistence/migrate.js';
import { SqliteAutopilotStore } from '../../../platform/persistence/sqlite-autopilot-store.js';
import { createAgentActivitySnapshot } from '../../agent-activity/model.js';
import { AutopilotCoordinator } from './service.js';
import { defaultAutopilotPolicy } from './policy.js';

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));
function fixture() {
  const database = new DatabaseSync(':memory:');
  migrate(database);
  database
    .prepare(
      "INSERT INTO relay_sessions (id,workspace_id,workspace_path,profile,state,desired_state,failure_count,next_sequence,created_at,updated_at) VALUES ('s','w','/w','p','ready','active',0,1,'t','t')",
    )
    .run();
  const store = new SqliteAutopilotStore(database);
  let clock = Date.parse('2026-10-19T00:00:00.000Z');
  const now = () => new Date(clock).toISOString();
  const session = {
    state: 'turnActive',
    threadId: 'root',
    activeTurnId: 'turn-1' as string | null,
  };
  const initial = createAgentActivitySnapshot('s', now());
  const activity = {
    ...initial,
    confidence: 'fresh' as 'fresh' | 'stale',
    root: { ...initial.root, state: 'working' as 'working' | 'idle', observedAt: now() },
  };
  const plan = {
    title: 'p',
    steps: [
      {
        id: 'l1',
        title: 'l1',
        level: 1 as const,
        state: 'WIP' as const,
        priority: 'A' as const,
        reviewStatus: 'UNREVIEWED' as const,
        description: {},
        children: [],
      },
    ],
    totalSteps: 1,
    doneSteps: 0,
    allDone: false,
    executionComplete: false,
    currentStepId: 'l1',
  };
  const retained = { plan, identity: 'plan-1' };
  const timers: Array<{ callback: () => void; delay: number; cancelled: boolean }> = [];
  const starts = vi.fn(async () => {
    session.activeTurnId = 'continued';
    session.state = 'turnActive';
  });
  const events: Array<{ type: string; payload: unknown }> = [];
  const gate = { pending: false, compatible: true };
  const coordinator = new AutopilotCoordinator({
    store,
    now,
    policy: defaultAutopilotPolicy,
    plan: () => retained,
    session: () => session,
    activity: () => activity,
    pendingInteraction: () => gate.pending,
    schedule: (callback, delay) => {
      const t = { callback, delay, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
    nextControlId: (_id, generation) => `control-${generation}`,
    turnStarter: { start: starts },
    reconcile: async () => ({ compatible: gate.compatible }),
    publish: (_id, type, payload) => {
      events.push({ type, payload });
    },
  });
  cleanups.push(() => {
    coordinator.dispose('s');
    database.close();
  });
  coordinator.enable('s');
  const fail = (
    settled = true,
    turnId = session.activeTurnId!,
    actor: 'root' | 'child' = 'root',
    code = 'serverOverloaded',
  ) => coordinator.providerFailed('s', { code }, { actor, turnId, settled });
  const idle = () => {
    session.state = 'ready';
    session.activeTurnId = null;
    activity.root.state = 'idle';
  };
  const fire = (delay: number) => {
    clock += delay;
    activity.root.observedAt = now();
    const timer = timers.find((t) => !t.cancelled && t.delay === delay);
    expect(timer).toBeDefined();
    timer!.cancelled = true;
    timer!.callback();
  };
  return {
    coordinator,
    store,
    session,
    activity,
    retained,
    timers,
    starts,
    events,
    gate,
    fail,
    idle,
    fire,
  };
}

describe('bounded provider overload recovery', () => {
  it('preserves manual Off and completion while retaining provider diagnostics', () => {
    const f = fixture();
    f.coordinator.disable('s');
    f.fail();
    expect(f.coordinator.snapshot('s')).toMatchObject({
      state: 'disabled',
      enabled: false,
      reason: 'manualDisabled',
      providerFailure: { code: 'serverOverloaded' },
    });
    expect(f.store.find('s')?.providerRetry).toBeUndefined();
    f.store.save({
      ...f.store.find('s')!,
      state: 'completed',
      stopReason: 'planComplete',
      providerFailure: undefined,
    });
    f.fail();
    expect(f.coordinator.snapshot('s').state).toBe('completed');
    expect(f.events.filter((e) => e.type === 'autopilot.provider-failed')).toHaveLength(2);
  });
  it.each(['serverOverloaded', 'rateLimitExceeded'])(
    'waits a minute for settled %s root evidence, then resumes once without replacing it',
    async (code) => {
      const f = fixture();
      f.fail(false, 'turn-1', 'root', code);
      f.fail(true, 'turn-1', 'root', code);
      expect(f.store.find('s')?.providerRetry).toMatchObject({
        attempt: 1,
        settled: true,
        pending: true,
      });
      expect(f.events.filter((e) => e.type === 'autopilot.provider-failed')).toHaveLength(1);
      f.idle();
      f.fire(60_000);
      await vi.waitFor(() => expect(f.store.find('s')?.requestedEnabled).toBe(true));
      expect(f.store.find('s')?.providerRetry?.resumeRoot).toBe(true);
      expect(f.starts).not.toHaveBeenCalled();
      const next = f.timers.find((t) => !t.cancelled);
      expect(next).toBeDefined();
      f.fire(next!.delay);
      await vi.waitFor(() => expect(f.starts).toHaveBeenCalledOnce());
    },
  );
  it.each(['active', 'unconfirmed', 'approval', 'stale', 'replaced', 'incompatible'])(
    'does not retry with %s evidence',
    async (mode) => {
      const f = fixture();
      f.fail(mode !== 'unconfirmed');
      if (mode !== 'active') f.idle();
      if (mode === 'approval') f.gate.pending = true;
      if (mode === 'stale') f.activity.confidence = 'stale';
      if (mode === 'replaced') f.retained.identity = 'new-plan';
      if (mode === 'incompatible') f.gate.compatible = false;
      f.fire(60_000);
      await vi.waitFor(() => expect(f.store.find('s')?.providerRetry?.pending).toBe(false));
      expect(f.coordinator.snapshot('s')).toMatchObject({ state: 'safetyPaused', enabled: false });
      expect(f.starts).not.toHaveBeenCalled();
    },
  );
  it.each([
    'usageLimitExceeded',
    'unauthorized',
    'misalignmentPolicyViolation',
    'responseStreamDisconnected',
  ])('does not automatically retry %s', (code) => {
    const f = fixture();
    f.fail(true, 'turn-1', 'root', code);
    expect(f.store.find('s')?.providerRetry).toBeUndefined();
    expect(f.coordinator.snapshot('s').state).toBe('safetyPaused');
  });
  it('does not automatically retry child failures', () => {
    const f = fixture();
    f.fail(true, 'child-turn', 'child');
    expect(f.store.find('s')?.providerRetry).toBeUndefined();
  });
  it.each(['disable', 'manualSend', 'restart'])('cancels pending retry on %s', async (action) => {
    const f = fixture();
    f.fail();
    const timer = f.timers.find((t) => t.delay === 60_000)!;
    if (action === 'disable') f.coordinator.disable('s');
    else if (action === 'manualSend') f.coordinator.manualSend('s');
    else {
      f.coordinator.dispose('s');
      f.coordinator.restore('s');
    }
    f.idle();
    timer.callback();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.store.find('s')?.providerRetry?.pending).not.toBe(true);
    expect(f.starts).not.toHaveBeenCalled();
  });
  it('retains the two-retry cap in SQLite across successive failures', async () => {
    const f = fixture();
    for (let attempt = 1; attempt <= 2; attempt++) {
      f.session.activeTurnId = `turn-${attempt}`;
      f.session.state = 'turnActive';
      f.fail();
      f.idle();
      f.fire(60_000);
      await vi.waitFor(() => expect(f.store.find('s')?.requestedEnabled).toBe(true));
      expect(f.store.find('s')?.providerRetry?.attempt).toBe(attempt);
    }
    f.session.activeTurnId = 'turn-3';
    f.session.state = 'turnActive';
    f.fail();
    expect(f.store.find('s')?.providerRetry).toMatchObject({
      attempt: 2,
      pending: false,
      resumeRoot: false,
    });
    expect(f.coordinator.snapshot('s')).toMatchObject({ state: 'safetyPaused', enabled: false });
  });
});
