/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutopilotCoordinator } from './service.js';
import { defaultAutopilotPolicy } from './policy.js';
import { createAgentActivitySnapshot } from '../../agent-activity/model.js';
import type { AutopilotSession } from '../domain/autopilot-session.js';
import { migrate } from '../../../platform/persistence/migrate.js';
import { SqliteAutopilotStore } from '../../../platform/persistence/sqlite-autopilot-store.js';
import {
  recordAutomaticContinuation,
  semanticProgressKey,
  startSupervisionProtocol,
} from '../domain/supervision-protocol.js';

const now = '2026-08-20T12:00:00.000Z';
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

describe('AutopilotCoordinator', () => {
  describe('supervision start', () => {
    function subject(options: Readonly<{ sessionState?: string; threadId?: string | null }> = {}) {
      let state: AutopilotSession | null = null;
      let identity = 'p1';
      let currentPlan = plan;
      let currentActivity: import('../../agent-activity/model.js').AgentActivitySnapshot | null =
        null;
      let session = {
        state: options.sessionState ?? 'ready',
        threadId: options.threadId === undefined ? 't' : options.threadId,
        activeTurnId: null as string | null,
      };
      let schedules = 0;
      const coordinator = new AutopilotCoordinator({
        store: {
          find: () => state,
          save: (next) => {
            state = next;
          },
          remove: () => {},
          findControl: () => null,
          saveControl: () => {},
          controlIds: () => new Set(),
        },
        now: () => now,
        policy: defaultAutopilotPolicy,
        plan: () => ({ plan: currentPlan, identity }),
        session: () => session,
        activity: () => currentActivity,
        pendingInteraction: () => false,
        reconcile: async () => ({ compatible: true }),
        schedule: () => {
          schedules += 1;
          return () => {};
        },
        nextControlId: () => 'control',
        turnStarter: { start: async () => {} },
        publish: () => {},
      });
      return {
        coordinator,
        get state() {
          return state;
        },
        get schedules() {
          return schedules;
        },
        set state(value: AutopilotSession | null) {
          state = value;
        },
        set identity(value: string) {
          identity = value;
        },
        set plan(value: typeof plan) {
          currentPlan = value;
        },
        set session(value: typeof session) {
          session = value;
        },
        set activity(value: import('../../agent-activity/model.js').AgentActivitySnapshot | null) {
          currentActivity = value;
        },
      };
    }

    it('records one enabled intent for a fresh supervision signal and ignores duplicates', () => {
      const fixture = subject();
      fixture.coordinator.supervisionStarted('s');
      const first = fixture.state!;
      fixture.coordinator.supervisionStarted('s');

      expect(fixture.state).toBe(first);
      expect(fixture.state).toMatchObject({
        state: 'monitoring',
        requestedEnabled: true,
        planIdentity: 'p1',
      });
      expect(fixture.schedules).toBe(0);
    });

    it('retains a supervision request before readiness and evaluates it once on restore', () => {
      const fixture = subject({ sessionState: 'starting', threadId: null });
      fixture.coordinator.supervisionStarted('s');
      expect(fixture.state).toMatchObject({ requestedEnabled: true, state: 'monitoring' });
      expect(fixture.schedules).toBe(0);

      fixture.session = { state: 'ready', threadId: 't', activeTurnId: null };
      fixture.coordinator.restore('s');
      fixture.coordinator.restore('s');
      expect(fixture.state).toMatchObject({ requestedEnabled: true, planIdentity: 'p1' });
      expect(fixture.schedules).toBe(0);
    });

    it('keeps a manual Off for the retained plan but allows a new plan supervision request', () => {
      const fixture = subject();
      fixture.coordinator.disable('s');
      fixture.coordinator.supervisionStarted('s');
      expect(fixture.state).toMatchObject({
        requestedEnabled: false,
        state: 'disabled',
        planIdentity: 'p1',
        stopReason: 'manualDisabled',
      });

      fixture.identity = 'p2';
      fixture.coordinator.supervisionStarted('s');
      expect(fixture.state).toMatchObject({
        requestedEnabled: true,
        state: 'monitoring',
        planIdentity: 'p2',
      });
    });

    it.each(['parked', 'probeRequired', 'retrying'] as const)(
      'starts a fresh protocol when replacing a %s plan',
      (outcome) => {
        const fixture = subject();
        fixture.coordinator.supervisionStarted('s');
        fixture.state = {
          ...fixture.state!,
          supervision: {
            ...fixture.state!.supervision!,
            outcome,
            ...(outcome === 'parked'
              ? {
                  waitLease: {
                    id: 'old',
                    probeKey: 'old',
                    wakeConditions: ['checkpointChanged'] as const,
                  },
                }
              : {}),
          },
        };
        fixture.identity = 'p2';
        fixture.coordinator.supervisionStarted('s');
        expect(fixture.state?.supervision).toMatchObject({ outcome: 'active' });
        expect(fixture.state?.supervision?.waitLease).toBeNull();
      },
    );

    it('does not arm a completed plan', () => {
      const fixture = subject();
      fixture.plan = { ...plan, executionComplete: true, allDone: true, doneSteps: 1 };

      expect(fixture.coordinator.supervisionStarted('s')).toEqual({
        code: 'AUTOPILOT_PLAN_COMPLETE',
      });
      expect(fixture.state).toBeNull();
    });

    it('uses only the fresh current canonical executor for snapshot health', async () => {
      const fixture = subject();
      fixture.coordinator.supervisionStarted('s');
      await Promise.resolve();
      await Promise.resolve();
      const activity = (
        child: Record<string, unknown>,
        confidence: 'fresh' | 'stale' = 'fresh',
      ) => ({
        ...createAgentActivitySnapshot('s', now),
        confidence,
        root: { ...createAgentActivitySnapshot('s', now).root, state: 'idle' as const },
        subagents: [
          {
            id: 'child',
            state: 'working' as const,
            reason: 'turnActive' as const,
            observedAt: now,
            lastActivityAt: now,
            ...child,
          },
        ],
      });
      fixture.activity = activity({
        canonicalPosition: 'L1',
        canonicalTaskName: 'l1',
        taskPath: '/root/l1',
        threadId: 't1',
        continuationGeneration: 2,
      });
      expect(fixture.coordinator.snapshot('s').health).toMatchObject({ healthy: true });
      fixture.activity = activity({
        canonicalPosition: 'L2',
        canonicalTaskName: 'l2',
        taskPath: '/root/l2',
      });
      expect(fixture.coordinator.snapshot('s').health).toMatchObject({
        healthy: false,
        phase: 'degraded',
      });
      fixture.activity = activity({
        canonicalPosition: 'L1',
        canonicalTaskName: 'explorer',
        taskPath: '/root/x',
      });
      expect(fixture.coordinator.snapshot('s').health).toMatchObject({
        healthy: false,
        phase: 'degraded',
      });
      fixture.activity = activity(
        { canonicalPosition: 'L1', canonicalTaskName: 'l1', taskPath: '/root/l1' },
        'stale',
      );
      expect(fixture.coordinator.snapshot('s').health).toMatchObject({
        healthy: false,
        phase: 'degraded',
      });
    });

    it('re-registers a valid parked lease after restart and removes it on disposal', () => {
      const fixture = subject();
      fixture.coordinator.supervisionStarted('s');
      fixture.state = {
        ...fixture.state!,
        supervision: {
          ...fixture.state!.supervision!,
          outcome: 'parked',
          probeKey: 'progress',
          waitLease: {
            id: 'lease',
            probeKey: 'progress',
            wakeConditions: ['agentActivityChanged'],
          },
        },
      };
      fixture.coordinator.restore('s');
      expect(fixture.coordinator.snapshot('s').health).toMatchObject({
        healthy: true,
        phase: 'waitingForAgentEvent',
      });
      fixture.coordinator.dispose('s');
      expect(fixture.coordinator.snapshot('s').health).toMatchObject({
        healthy: false,
        phase: 'degraded',
      });
    });

    it('allows the root final after the authoritative final review passes', () => {
      const fixture = subject();
      fixture.coordinator.supervisionStarted('s');
      fixture.plan = { ...plan, executionComplete: true, allDone: true, doneSteps: 1 };

      expect(fixture.coordinator.turnCompleted('s')).toBe(true);
    });

    it('reopens a pending supervision intent once without overriding manual Off', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'gestalt-autopilot-supervision-'));
      const path = join(directory, 'relay.sqlite');
      let identity = 'p1';
      let session = { state: 'starting', threadId: null as string | null, activeTurnId: null };
      const activeTimers: Array<{ cancelled: boolean }> = [];
      let starts = 0;
      const coordinator = (database: DatabaseSync) =>
        new AutopilotCoordinator({
          store: new SqliteAutopilotStore(database),
          now: () => now,
          policy: defaultAutopilotPolicy,
          plan: () => ({ plan, identity }),
          session: () => session,
          activity: () => ({
            ...createAgentActivitySnapshot('s', now),
            confidence: 'fresh',
            root: { ...createAgentActivitySnapshot('s', now).root, state: 'idle' },
          }),
          pendingInteraction: () => false,
          reconcile: async () => ({ compatible: true }),
          schedule: () => {
            const timer = { cancelled: false };
            activeTimers.push(timer);
            return () => {
              timer.cancelled = true;
            };
          },
          nextControlId: (_sessionId, generation) => `control-${generation}`,
          turnStarter: {
            start: async () => {
              starts += 1;
            },
          },
          publish: () => {},
        });
      try {
        const first = new DatabaseSync(path);
        migrate(first);
        first
          .prepare(
            "INSERT INTO relay_sessions (id,workspace_id,workspace_path,profile,state,desired_state,failure_count,next_sequence,created_at,updated_at) VALUES ('s','w','/w','p','starting','active',0,1,'t','t')",
          )
          .run();
        coordinator(first).supervisionStarted('s');
        expect(new SqliteAutopilotStore(first).find('s')).toMatchObject({
          requestedEnabled: true,
          planIdentity: 'p1',
        });
        expect(activeTimers).toHaveLength(0);
        expect(starts).toBe(0);
        first.close();

        session = { state: 'ready', threadId: 'thread-1', activeTurnId: null };
        const reopened = new DatabaseSync(path);
        migrate(reopened);
        const resumed = coordinator(reopened);
        resumed.restore('s');
        resumed.restore('s');
        const store = new SqliteAutopilotStore(reopened);
        expect(store.controlIds('s')).toEqual(new Set(['control-1']));
        expect(activeTimers.filter((timer) => !timer.cancelled)).toHaveLength(1);
        expect(starts).toBe(0);

        resumed.disable('s');
        reopened.close();
        const manualOff = new DatabaseSync(path);
        migrate(manualOff);
        coordinator(manualOff).restore('s');
        expect(new SqliteAutopilotStore(manualOff).find('s')).toMatchObject({
          requestedEnabled: false,
          planIdentity: 'p1',
          stopReason: 'manualDisabled',
        });
        expect(new SqliteAutopilotStore(manualOff).controlIds('s')).toEqual(new Set(['control-1']));

        identity = 'p2';
        coordinator(manualOff).supervisionStarted('s');
        expect(new SqliteAutopilotStore(manualOff).find('s')).toMatchObject({
          requestedEnabled: true,
          planIdentity: 'p2',
        });
        expect(starts).toBe(0);
        manualOff.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  });
  it('makes repeated enable idempotent for the same retained plan', () => {
    let state: AutopilotSession | null = null;
    let currentPlan = plan;
    let saves = 0;
    let schedules = 0;
    const events: string[] = [];
    const coordinator = new AutopilotCoordinator({
      store: {
        find: () => state,
        save: (next) => {
          saves += 1;
          state = next;
        },
        remove: () => {
          state = null;
        },
        findControl: () => null,
        saveControl: () => {},
        controlIds: () => new Set(),
      },
      now: () => now,
      policy: defaultAutopilotPolicy,
      plan: () => ({ plan: currentPlan, identity: 'p1' }),
      session: () => ({ state: 'ready', threadId: 't', activeTurnId: null }),
      activity: () => ({
        ...createAgentActivitySnapshot('s', now),
        confidence: 'fresh',
        root: { ...createAgentActivitySnapshot('s', now).root, state: 'idle' },
      }),
      pendingInteraction: () => false,
      reconcile: async () => ({ compatible: true }),
      schedule: () => {
        schedules += 1;
        return () => {};
      },
      nextControlId: () => 'control',
      turnStarter: { start: async () => {} },
      publish: (_sessionId, type) => events.push(type),
    });
    coordinator.enable('s');
    const first = state!.generation;
    const firstFingerprint = state!.planFingerprint;
    const enabledSaves = saves;
    const enabledSchedules = schedules;
    const enabledEvents = events.length;
    currentPlan = { ...plan, doneSteps: 1 };
    coordinator.enable('s');
    expect(state!.generation).toBe(first);
    expect(state!.planFingerprint).toBe(firstFingerprint);
    expect(saves).toBe(enabledSaves);
    expect(schedules).toBe(enabledSchedules);
    expect(events).toHaveLength(enabledEvents);
    coordinator.disable('s');
    const disabled = state!.generation;
    coordinator.disable('s');
    expect(state!.generation).toBe(disabled);
  });
  it('cancels an enabled session on plan or session lifecycle termination', () => {
    let state: AutopilotSession | null = null;
    const coordinator = new AutopilotCoordinator({
      store: {
        find: () => state,
        save: (next) => {
          state = next;
        },
        remove: () => {},
        findControl: () => null,
        saveControl: () => {},
        controlIds: () => new Set(),
      },
      now: () => now,
      policy: defaultAutopilotPolicy,
      plan: () => ({ plan, identity: 'p1' }),
      session: () => ({ state: 'ready', threadId: 't', activeTurnId: null }),
      activity: () => null,
      pendingInteraction: () => false,
      reconcile: async () => ({ compatible: true }),
      schedule: () => () => {},
      nextControlId: () => 'control',
      turnStarter: { start: async () => {} },
      publish: () => {},
    });
    coordinator.enable('s');
    coordinator.cancel('s', 'planRemoved');
    expect(state).toMatchObject({
      requestedEnabled: false,
      state: 'disabled',
      stopReason: 'planRemoved',
    });
    coordinator.cancel('s', 'sessionEnded');
    expect(state).toMatchObject({ stopReason: 'sessionEnded' });
  });
  it.each(['disable', 'lifecycle'] as const)(
    'atomically cancels a scheduled control on %s invalidation',
    (action) => {
      let state: AutopilotSession | null = {
        sessionId: 's',
        state: 'backoff',
        requestedEnabled: true,
        planIdentity: 'p',
        planFingerprint: 'f',
        generation: 2,
        consecutiveNoProgress: 0,
        nextEvaluationAt: '2026-08-20T12:01:00.000Z',
        lastControlId: 'scheduled',
        stopReason: null,
        updatedAt: now,
      };
      let control: import('./ports.js').AutopilotControl = {
        sessionId: 's',
        controlId: 'scheduled',
        status: 'scheduled',
        createdAt: now,
        updatedAt: now,
        failureCode: null,
      };
      const coordinator = new AutopilotCoordinator({
        store: {
          find: () => state,
          save: (next) => {
            state = next;
          },
          remove: () => {},
          findControl: () => control,
          saveControl: (next) => {
            control = next;
          },
          controlIds: () => new Set([control.controlId]),
        },
        now: () => now,
        policy: defaultAutopilotPolicy,
        plan: () => ({ plan, identity: 'p' }),
        session: () => ({ state: 'ready', threadId: 't', activeTurnId: null }),
        activity: () => null,
        pendingInteraction: () => false,
        reconcile: async () => ({ compatible: true }),
        schedule: () => () => {},
        nextControlId: () => 'next',
        turnStarter: { start: async () => {} },
        publish: () => {},
      });

      if (action === 'disable') coordinator.disable('s');
      else coordinator.cancel('s', 'sessionEnded');

      expect(state).toMatchObject({
        state: 'disabled',
        requestedEnabled: false,
        generation: 3,
        lastControlId: null,
      });
      expect(control.status).toBe('cancelled');
      expect(coordinator.recordControlIssued('s', control.controlId)).toBe(false);
    },
  );
  it('restores only enabled actionable rows and rearms a future backoff', () => {
    let state: AutopilotSession | null = {
      sessionId: 's',
      state: 'backoff',
      requestedEnabled: true,
      planIdentity: 'p',
      planFingerprint: 'f',
      generation: 4,
      consecutiveNoProgress: 0,
      nextEvaluationAt: '2026-08-20T12:01:00.000Z',
      lastControlId: 'c',
      stopReason: null,
      updatedAt: now,
    };
    let armed = 0;
    const coordinator = new AutopilotCoordinator({
      store: {
        find: () => state,
        save: (next) => {
          state = next;
        },
        remove: () => {},
        findControl: () => null,
        saveControl: () => {},
        controlIds: () => new Set(),
      },
      now: () => now,
      policy: defaultAutopilotPolicy,
      plan: () => ({ plan, identity: 'p' }),
      // Restart detaches the old process writer before plan-status restoration;
      // the coordinator must retain and rearm this durable eligible state.
      session: () => ({ state: 'stopped', threadId: 't', activeTurnId: null }),
      activity: () => null,
      pendingInteraction: () => false,
      reconcile: async () => ({ compatible: true }),
      schedule: () => {
        armed += 1;
        return () => {};
      },
      nextControlId: () => 'control',
      turnStarter: { start: async () => {} },
      publish: () => {},
    });
    coordinator.restore('s');
    expect(armed).toBe(1);
    state = { ...state!, state: 'completed' };
    coordinator.restore('s');
    expect(armed).toBe(1);
  });
  it('uses one durable control identity and manual send cancels its fake-clock timer', async () => {
    let state: AutopilotSession | null = null;
    const controls = new Map<string, import('./ports.js').AutopilotControl>();
    let timer: (() => void) | undefined;
    const events: Array<{ type: string; payload: unknown }> = [];
    const coordinator = new AutopilotCoordinator({
      store: {
        find: () => state,
        save: (next) => {
          state = next;
        },
        remove: () => {
          state = null;
        },
        findControl: (sessionId, controlId) => controls.get(`${sessionId}:${controlId}`) ?? null,
        saveControl: (control) =>
          controls.set(`${control.sessionId}:${control.controlId}`, control),
        controlIds: () => new Set([...controls.values()].map((control) => control.controlId)),
      },
      now: () => now,
      policy: { ...defaultAutopilotPolicy, backoffMs: () => 1_000 },
      plan: () => ({ plan, identity: 'p1' }),
      session: () => ({ state: 'ready', threadId: 't', activeTurnId: null }),
      activity: () => ({
        ...createAgentActivitySnapshot('s', now),
        confidence: 'fresh',
        root: { ...createAgentActivitySnapshot('s', now).root, state: 'idle' },
      }),
      pendingInteraction: () => false,
      reconcile: async () => ({ compatible: true }),
      schedule: (callback) => {
        timer = callback;
        return () => {
          timer = undefined;
        };
      },
      nextControlId: () => 'autopilot-control',
      turnStarter: { start: async () => {} },
      publish: (_id, type, payload) => events.push({ type, payload }),
    });
    coordinator.enable('s');
    const scheduled = state!.lastControlId;
    expect(scheduled).toMatch(/^autopilot-/);
    expect(controls.get(`s:${scheduled}`)?.status).toBe('scheduled');
    const scheduledSnapshot = events
      .filter((event) => event.type === 'autopilot.updated')
      .at(-1)!.payload;
    expect(scheduledSnapshot).toEqual(coordinator.snapshot('s'));
    expect(
      (scheduledSnapshot as { health: { phase: string; healthy: boolean } }).health,
    ).toMatchObject({
      phase: 'continuationScheduled',
      healthy: true,
    });
    expect(
      events.filter((event) => event.type === 'session.status.updated').at(-1)?.payload,
    ).toMatchObject({
      state: 'working',
      reason: 'autopilot',
    });
    await timer?.();
    expect(events.filter((event) => event.type === 'autopilot.control-issued')[0]!.payload).toEqual(
      { controlId: scheduled },
    );
    expect(events.filter((event) => event.type === 'autopilot.turn-started')[0]!.payload).toEqual({
      controlId: scheduled,
    });
    coordinator.manualSend('s');
    expect(events.filter((event) => event.type === 'autopilot.turn-started')).toHaveLength(1);
    expect(controls.get(`s:${scheduled}`)?.status).toBe('started');
  });
  it('revalidates activity before firing and rearms the same control after work becomes idle', async () => {
    let state: AutopilotSession | null = null;
    let activityState: 'idle' | 'working' = 'idle';
    let starts = 0;
    const controls = new Map<string, import('./ports.js').AutopilotControl>();
    const timers: Array<{ callback: () => void; cancelled: boolean; fired: boolean }> = [];
    const coordinator = new AutopilotCoordinator({
      store: {
        find: () => state,
        save: (next) => {
          state = next;
        },
        remove: () => {},
        findControl: (sessionId, controlId) => controls.get(`${sessionId}:${controlId}`) ?? null,
        saveControl: (control) =>
          controls.set(`${control.sessionId}:${control.controlId}`, control),
        controlIds: () => new Set([...controls.values()].map((control) => control.controlId)),
      },
      now: () => now,
      policy: { ...defaultAutopilotPolicy, quiescenceMs: 0, backoffMs: () => 0 },
      plan: () => ({ plan, identity: 'p1' }),
      session: () => ({ state: 'ready', threadId: 't', activeTurnId: null }),
      activity: () => ({
        ...createAgentActivitySnapshot('s', now),
        confidence: 'fresh',
        root: { ...createAgentActivitySnapshot('s', now).root, state: 'idle' },
        aggregateSubagents: activityState,
      }),
      pendingInteraction: () => false,
      reconcile: async () => ({ compatible: true }),
      schedule: (callback) => {
        const timer = { callback, cancelled: false, fired: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
      nextControlId: (_sessionId, generation) => `activity-control-${generation}`,
      turnStarter: {
        start: async () => {
          starts += 1;
        },
      },
      publish: () => {},
    });
    const runNextTimer = async () => {
      const timer = timers.find((candidate) => !candidate.cancelled && !candidate.fired);
      expect(timer).toBeDefined();
      timer!.fired = true;
      timer!.callback();
      await Promise.resolve();
      await Promise.resolve();
    };

    coordinator.enable('s');
    activityState = 'working';
    await runNextTimer();
    expect(starts).toBe(0);
    expect(state).toMatchObject({ state: 'monitoring', requestedEnabled: true });

    activityState = 'idle';
    coordinator.activitySettled('s');
    await runNextTimer();
    await runNextTimer();
    expect(starts).toBe(1);
    expect(controls.size).toBe(2);
    expect(controls.get('s:activity-control-1')?.status).toBe('cancelled');
    expect(controls.get('s:activity-control-2')?.status).toBe('started');
  });
  it('keeps one durable scheduled control across repeated backoff evaluations', () => {
    let state: AutopilotSession | null = null;
    const controls = new Map<string, import('./ports.js').AutopilotControl>();
    const timers: Array<{ cancelled: boolean }> = [];
    const events: string[] = [];
    const nextControlId = vi.fn(() => `control-${controls.size + 1}`);
    const coordinator = new AutopilotCoordinator({
      store: {
        find: () => state,
        save: (next) => {
          state = next;
        },
        remove: () => {},
        findControl: (sessionId, controlId) => controls.get(`${sessionId}:${controlId}`) ?? null,
        saveControl: (control) =>
          controls.set(`${control.sessionId}:${control.controlId}`, control),
        controlIds: () => new Set([...controls.values()].map((control) => control.controlId)),
      },
      now: () => now,
      policy: defaultAutopilotPolicy,
      plan: () => ({ plan, identity: 'p1' }),
      session: () => ({ state: 'ready', threadId: 't', activeTurnId: null }),
      activity: () => ({
        ...createAgentActivitySnapshot('s', now),
        confidence: 'fresh',
        root: { ...createAgentActivitySnapshot('s', now).root, state: 'idle' },
      }),
      pendingInteraction: () => false,
      reconcile: async () => ({ compatible: true }),
      schedule: () => {
        const timer = { cancelled: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
      nextControlId,
      turnStarter: { start: async () => {} },
      publish: (_sessionId, type) => events.push(type),
    });

    coordinator.enable('s');
    const scheduledControlId = state!.lastControlId;
    coordinator.evaluate('s');
    coordinator.evaluate('s');

    expect(state).toMatchObject({ state: 'backoff', lastControlId: scheduledControlId });
    expect(nextControlId).toHaveBeenCalledTimes(1);
    expect(controls.size).toBe(1);
    expect(timers.filter((timer) => !timer.cancelled)).toHaveLength(1);
    expect(events.filter((type) => type === 'autopilot.continuation-scheduled')).toHaveLength(1);
  });
  it('starts exactly one structured probe turn on the third unchanged continuation', async () => {
    const planFingerprint = JSON.stringify([['l1', 'WIP', 'UNREVIEWED', []]]);
    const progressKey = semanticProgressKey({
      plan: { identity: 'p1', fingerprint: planFingerprint, currentPosition: 'l1' },
      review: { status: null },
      checkpoint: { pendingTurnId: null, terminalReviewAccepted: false },
      pendingInteractions: [],
      executor: { generation: 0, state: null },
      ownedProcesses: [],
      childActivity: [],
      agentActivity: [{ agentId: 'root', sequence: 0, state: 'idle' }],
    });
    let supervision = startSupervisionProtocol(progressKey);
    supervision = recordAutomaticContinuation(supervision, progressKey);
    supervision = recordAutomaticContinuation(supervision, progressKey);
    let state: AutopilotSession | null = {
      sessionId: 's',
      state: 'backoff',
      requestedEnabled: true,
      planIdentity: 'p1',
      planFingerprint,
      generation: 1,
      consecutiveNoProgress: 2,
      nextEvaluationAt: now,
      lastControlId: 'probe-control',
      stopReason: null,
      supervision,
      updatedAt: now,
    };
    const controls = new Map<string, import('./ports.js').AutopilotControl>([
      [
        's:probe-control',
        {
          sessionId: 's',
          controlId: 'probe-control',
          status: 'scheduled' as const,
          createdAt: now,
          updatedAt: now,
          failureCode: null,
          turnId: null,
        },
      ],
    ]);
    const timers: Array<() => void> = [];
    const starts = vi.fn(async () => {});
    const events: string[] = [];
    const coordinator = new AutopilotCoordinator({
      store: {
        find: () => state,
        save: (next) => {
          state = next;
        },
        remove: () => {},
        findControl: (sessionId, controlId) => controls.get(`${sessionId}:${controlId}`) ?? null,
        saveControl: (control) =>
          controls.set(`${control.sessionId}:${control.controlId}`, control),
        controlIds: () => new Set([...controls.values()].map((control) => control.controlId)),
      },
      now: () => now,
      policy: { ...defaultAutopilotPolicy, backoffMs: () => 0 },
      plan: () => ({ plan, identity: 'p1' }),
      session: () => ({ state: 'ready', threadId: 't', activeTurnId: null }),
      activity: () => ({
        ...createAgentActivitySnapshot('s', now),
        confidence: 'fresh',
        root: { ...createAgentActivitySnapshot('s', now).root, state: 'idle' },
      }),
      pendingInteraction: () => false,
      reconcile: async () => ({ compatible: true }),
      schedule: (callback) => {
        timers.push(callback);
        return () => {};
      },
      nextControlId: () => 'unused',
      turnStarter: { start: starts },
      publish: (_sessionId, type) => events.push(type),
    });

    coordinator.restore('s');
    timers.shift()!();
    await vi.waitFor(() => expect(starts).toHaveBeenCalledTimes(1));

    expect(state?.supervision).toMatchObject({ outcome: 'probeRequired', probeKey: progressKey });
    expect(events.filter((type) => type === 'autopilot.probe-required')).toHaveLength(1);
  });

  it('keeps a structured wait turn-free until a matching semantic event grants one retry', () => {
    let currentPlan: import('../../plans/domain/supervised-plan.js').SupervisedPlan = plan;
    let state: AutopilotSession | null = null;
    let scheduled = 0;
    const coordinator = new AutopilotCoordinator({
      store: {
        find: () => state,
        save: (next) => {
          state = next;
        },
        remove: () => {},
        findControl: () => null,
        saveControl: () => {},
        controlIds: () => new Set(),
      },
      now: () => now,
      policy: { ...defaultAutopilotPolicy, backoffMs: () => 0 },
      plan: () => ({ plan: currentPlan, identity: 'p1' }),
      session: () => ({ state: 'ready', threadId: 't', activeTurnId: null }),
      activity: () => ({
        ...createAgentActivitySnapshot('s', now),
        confidence: 'fresh',
        root: { ...createAgentActivitySnapshot('s', now).root, state: 'idle' },
      }),
      pendingInteraction: () => false,
      reconcile: async () => ({ compatible: true }),
      schedule: () => {
        scheduled += 1;
        return () => {};
      },
      nextControlId: () => 'retry-control',
      turnStarter: { start: async () => {} },
      publish: () => {},
    });
    coordinator.enable('s');
    state = {
      ...state!,
      state: 'monitoring',
      nextEvaluationAt: null,
      lastControlId: null,
      supervision: {
        ...state!.supervision!,
        outcome: 'probeRequired',
        unchangedContinuations: 3,
        probeKey: state!.supervision!.progressKey,
      },
    };
    expect(
      coordinator.reportProbe('s', {
        id: 'wait-report',
        kind: 'wait',
        leaseId: 'lease-1',
        wakeConditions: ['planChanged'],
      }),
    ).toBe(true);
    const parkedScheduleCount = scheduled;

    coordinator.evaluate('s');
    coordinator.semanticEvent('s', 'agentActivityChanged');
    expect(scheduled).toBe(parkedScheduleCount);
    expect(state?.supervision?.outcome).toBe('parked');

    currentPlan = {
      ...plan,
      steps: [{ ...plan.steps[0]!, state: 'TODO' as const }],
    };
    expect(coordinator.semanticEvent('s', 'planChanged')).toBe(true);
    expect(state?.supervision).toMatchObject({ outcome: 'retrying', retryKey: expect.any(String) });
    expect(scheduled).toBe(parkedScheduleCount + 1);
    expect(coordinator.semanticEvent('s', 'planChanged')).toBe(false);
    expect(scheduled).toBe(parkedScheduleCount + 1);
  });

  it('parks a proactive wait immediately and restores normal policy at its one-shot deadline', () => {
    let currentTime = now;
    let state: AutopilotSession | null = {
      sessionId: 's',
      state: 'monitoring',
      requestedEnabled: true,
      planIdentity: 'p1',
      planFingerprint: 'f1',
      generation: 1,
      consecutiveNoProgress: 0,
      nextEvaluationAt: null,
      lastControlId: null,
      stopReason: null,
      supervision: startSupervisionProtocol('progress'),
      updatedAt: now,
    };
    const timers: Array<{
      callback: () => void;
      delayMs: number;
      cancel: ReturnType<typeof vi.fn>;
    }> = [];
    const coordinator = new AutopilotCoordinator({
      store: {
        find: () => state,
        save: (next) => {
          state = next;
        },
        remove: () => {},
        findControl: () => null,
        saveControl: () => {},
        controlIds: () => new Set(),
      },
      now: () => currentTime,
      policy: { ...defaultAutopilotPolicy, backoffMs: () => 0 },
      plan: () => ({ plan, identity: 'p1' }),
      session: () => ({ state: 'ready', threadId: 't', activeTurnId: null }),
      activity: () => ({
        ...createAgentActivitySnapshot('s', currentTime),
        confidence: 'fresh',
        root: { ...createAgentActivitySnapshot('s', currentTime).root, state: 'idle' },
      }),
      pendingInteraction: () => false,
      reconcile: async () => ({ compatible: true }),
      schedule: (callback, delayMs) => {
        const cancel = vi.fn();
        timers.push({ callback, delayMs, cancel });
        return cancel;
      },
      nextControlId: () => 'deadline-control',
      turnStarter: { start: async () => {} },
      publish: () => {},
    });

    expect(
      coordinator.registerProactiveWait('s', {
        id: 'invalid-report',
        leaseId: 'invalid-lease',
        wakeConditions: ['processExited'],
        maxWaitMs: 59_999,
      }),
    ).toBe(false);
    expect(timers).toHaveLength(0);
    expect(
      coordinator.registerProactiveWait('s', {
        id: 'long-wait-report',
        leaseId: 'long-wait-lease',
        wakeConditions: ['processExited'],
        maxWaitMs: 3_600_000,
      }),
    ).toBe(true);
    expect(state?.supervision).toMatchObject({
      outcome: 'parked',
      waitLease: {
        id: 'long-wait-lease',
        resumeAt: '2026-08-20T13:00:00.000Z',
      },
    });
    expect(timers[0]?.delayMs).toBe(3_600_000);
    expect(
      coordinator.registerProactiveWait('s', {
        id: 'long-wait-report',
        leaseId: 'long-wait-lease',
        wakeConditions: ['processExited'],
        maxWaitMs: 3_600_000,
      }),
    ).toBe(false);

    currentTime = '2026-08-20T13:00:00.000Z';
    timers[0]!.callback();

    expect(state?.supervision).toMatchObject({ outcome: 'active', waitLease: null });
    expect(state?.supervision?.lastReportId).toBe('long-wait-report');
    expect(timers).toHaveLength(2);
  });

  it.each(['agentActivityChanged', 'executorChanged'] as const)(
    'consumes a %s lease exactly once when a child becomes idle',
    async (wakeCondition) => {
      const planFingerprint = JSON.stringify([['l1', 'WIP', 'UNREVIEWED', []]]);
      const child = {
        id: 'child-1',
        threadId: 'child-thread',
        taskPath: '/root/l1',
        canonicalTaskName: 'l1',
        canonicalPosition: 'L1',
        continuationGeneration: 1,
        outcome: 'partial' as const,
        ownedProcesses: [
          { processId: 'child-process', state: 'running' as const, ownership: 'executor' as const },
        ],
        state: 'working' as const,
        reason: 'turnActive' as const,
        observedAt: now,
        lastActivityAt: now,
      };
      const activity = (children: Array<Record<string, unknown>> = [child]) =>
        ({
          sessionId: 's',
          rootThreadId: 'root-thread',
          root: {
            state: 'idle' as const,
            reason: 'turnCompleted' as const,
            observedAt: now,
            lastActivityAt: now,
          },
          subagents: children,
          aggregateSubagents: children.some((candidate) => candidate.state === 'working')
            ? ('working' as const)
            : ('idle' as const),
          confidence: 'fresh' as const,
        }) as unknown as ReturnType<typeof createAgentActivitySnapshot>;
      const initialKey = semanticProgressKey({
        plan: { identity: 'p1', fingerprint: planFingerprint, currentPosition: 'l1' },
        review: { status: null },
        checkpoint: { pendingTurnId: null, terminalReviewAccepted: false },
        pendingInteractions: [],
        executor: { generation: 0, state: null },
        ownedProcesses: [],
        childActivity: [
          {
            id: child.id,
            threadId: child.threadId,
            taskName: child.canonicalTaskName,
            position: child.canonicalPosition,
            generation: child.continuationGeneration,
            state: child.state,
            outcome: child.outcome,
            ownedProcesses: [{ id: 'child-process', state: 'running', ownership: 'executor' }],
          },
        ],
        agentActivity: [{ agentId: 'root', sequence: 0, state: 'idle' }],
      });
      let currentActivity = activity();
      let state: AutopilotSession | null = {
        sessionId: 's',
        state: 'monitoring',
        requestedEnabled: true,
        planIdentity: 'p1',
        planFingerprint,
        generation: 1,
        consecutiveNoProgress: 0,
        nextEvaluationAt: null,
        lastControlId: null,
        stopReason: null,
        supervision: {
          ...startSupervisionProtocol(initialKey),
          outcome: 'parked',
          waitLease: {
            id: 'child-lease',
            probeKey: initialKey,
            wakeConditions: [wakeCondition],
            resumeAt: '2026-08-20T13:00:00.000Z',
          },
        },
        updatedAt: now,
      };
      let saves = 0;
      const scheduled: Array<() => void> = [];
      const coordinator = new AutopilotCoordinator({
        store: {
          find: () => state,
          save: (next) => {
            saves += 1;
            state = next;
          },
          remove: () => {},
          findControl: () => null,
          saveControl: () => {},
          controlIds: () => new Set(),
        },
        now: () => now,
        policy: { ...defaultAutopilotPolicy, backoffMs: () => 0 },
        plan: () => ({ plan, identity: 'p1' }),
        session: () => ({ state: 'ready', threadId: 'root-thread', activeTurnId: null }),
        activity: () => currentActivity,
        pendingInteraction: () => false,
        reconcile: async () => ({ compatible: true }),
        schedule: (callback) => {
          scheduled.push(callback);
          return () => {};
        },
        nextControlId: () => 'control',
        turnStarter: { start: async () => {} },
        executorController: {
          resume: async () => {},
          refresh: async () => {},
          interrupt: async () => false,
          transferProcess: () => {},
          consumeProcess: () => {},
          terminateProcess: async () => false,
        },
        publish: () => {},
      });
      currentActivity = activity([
        {
          ...child,
          state: 'idle',
          outcome: 'partial',
          observedAt: 'later',
          lastActivityAt: 'later',
        },
      ]);
      coordinator.activityChanged('s');
      coordinator.activityChanged('s');
      if (wakeCondition === 'executorChanged') {
        expect(scheduled).toHaveLength(1);
        scheduled.shift()!();
        await vi.waitFor(() => expect(state?.supervision?.waitLease).toBeNull());
      }
      expect(state?.supervision).toMatchObject({ outcome: 'active', waitLease: null });
      const savesAfterWake = saves;
      expect(savesAfterWake).toBeGreaterThan(0);
      currentActivity = activity([
        { ...currentActivity.subagents[0]!, observedAt: 'newer', lastActivityAt: 'newer' },
      ]);
      coordinator.activityChanged('s');
      expect(saves).toBe(savesAfterWake);
    },
  );

  it.each([
    ['proactive', '2026-08-20T13:00:00.000Z'],
    ['probe', undefined],
  ] as const)(
    'consumes a persisted %s lease through Off, restart, and explicit On',
    (_kind, resumeAt) => {
      let state: AutopilotSession | null = {
        sessionId: 's',
        state: 'monitoring',
        requestedEnabled: true,
        planIdentity: 'p1',
        planFingerprint: 'f1',
        generation: 1,
        consecutiveNoProgress: 0,
        nextEvaluationAt: null,
        lastControlId: null,
        stopReason: null,
        supervision: {
          ...startSupervisionProtocol('stale-wait'),
          outcome: 'parked',
          waitLease: {
            id: `${_kind}-lease`,
            probeKey: 'stale-wait',
            wakeConditions: ['executorChanged'],
            ...(resumeAt ? { resumeAt } : {}),
          },
        },
        updatedAt: now,
      };
      const cancellations: ReturnType<typeof vi.fn>[] = [];
      const coordinator = new AutopilotCoordinator({
        store: {
          find: () => state,
          save: (next) => {
            state = next;
          },
          remove: () => {},
          findControl: () => null,
          saveControl: () => {},
          controlIds: () => new Set(),
        },
        now: () => now,
        policy: defaultAutopilotPolicy,
        plan: () => ({ plan, identity: 'p1' }),
        session: () => ({ state: 'ready', threadId: 't', activeTurnId: null }),
        activity: () => null,
        pendingInteraction: () => false,
        reconcile: async () => ({ compatible: true }),
        schedule: () => {
          const cancel = vi.fn();
          cancellations.push(cancel);
          return cancel;
        },
        nextControlId: () => 'control',
        turnStarter: { start: async () => {} },
        publish: () => {},
      });

      coordinator.restore('s');
      coordinator.disable('s');
      expect(state).toMatchObject({
        requestedEnabled: false,
        supervision: { outcome: 'active', waitLease: null },
      });
      expect(cancellations).toHaveLength(resumeAt ? 1 : 0);
      expect(cancellations.every((cancel) => cancel.mock.calls.length === 1)).toBe(true);

      // A new coordinator observes only the persisted disabled state; it must
      // not resurrect the old lease before the explicit On transition.
      const restarted = new AutopilotCoordinator({
        store: {
          find: () => state,
          save: (next) => {
            state = next;
          },
          remove: () => {},
          findControl: () => null,
          saveControl: () => {},
          controlIds: () => new Set(),
        },
        now: () => now,
        policy: defaultAutopilotPolicy,
        plan: () => ({ plan, identity: 'p1' }),
        session: () => ({ state: 'ready', threadId: 't', activeTurnId: null }),
        activity: () => null,
        pendingInteraction: () => false,
        reconcile: async () => ({ compatible: true }),
        schedule: () => () => {},
        nextControlId: () => 'control',
        turnStarter: { start: async () => {} },
        publish: () => {},
      });
      restarted.restore('s');
      restarted.enable('s');
      expect(state).toMatchObject({
        requestedEnabled: true,
        supervision: { outcome: 'active', waitLease: null },
      });
      restarted.disable('s');
      expect(state?.supervision?.waitLease).toBeNull();
    },
  );

  it('cancels a replacement lease and makes its late deadline callback a no-op', () => {
    let identity = 'p1';
    let state: AutopilotSession | null = {
      sessionId: 's',
      state: 'monitoring',
      requestedEnabled: true,
      planIdentity: 'p1',
      planFingerprint: 'f1',
      generation: 1,
      consecutiveNoProgress: 0,
      nextEvaluationAt: null,
      lastControlId: null,
      stopReason: null,
      supervision: {
        ...startSupervisionProtocol('stale-wait'),
        outcome: 'parked',
        waitLease: {
          id: 'replacement-lease',
          probeKey: 'stale-wait',
          wakeConditions: ['executorChanged'],
          resumeAt: '2026-08-20T13:00:00.000Z',
        },
      },
      updatedAt: now,
    };
    const timers: Array<{ callback: () => void; cancel: ReturnType<typeof vi.fn> }> = [];
    const coordinator = new AutopilotCoordinator({
      store: {
        find: () => state,
        save: (next) => {
          state = next;
        },
        remove: () => {},
        findControl: () => null,
        saveControl: () => {},
        controlIds: () => new Set(),
      },
      now: () => now,
      policy: defaultAutopilotPolicy,
      plan: () => ({ plan, identity }),
      session: () => ({ state: 'ready', threadId: 't', activeTurnId: null }),
      activity: () => null,
      pendingInteraction: () => false,
      reconcile: async () => ({ compatible: true }),
      schedule: (callback) => {
        const cancel = vi.fn();
        timers.push({ callback, cancel });
        return cancel;
      },
      nextControlId: () => 'control',
      turnStarter: { start: async () => {} },
      publish: () => {},
    });
    coordinator.restore('s');
    identity = 'p2';
    coordinator.enable('s');
    expect(timers).toHaveLength(1);
    expect(timers[0]!.cancel).toHaveBeenCalledTimes(1);
    const schedulesBeforeLateCallback = timers.length;
    timers[0]!.callback();
    expect(timers).toHaveLength(schedulesBeforeLateCallback);
    expect(state).toMatchObject({ planIdentity: 'p2', supervision: { waitLease: null } });
  });

  it.each(['attentionRequired', 'safetyPaused'] as const)(
    'keeps the %s stop while explicit recovery removes stale wait ownership',
    (outcome) => {
      let state: AutopilotSession | null = {
        sessionId: 's',
        state: outcome,
        requestedEnabled: false,
        planIdentity: 'p1',
        planFingerprint: 'f1',
        generation: 1,
        consecutiveNoProgress: 0,
        nextEvaluationAt: null,
        lastControlId: null,
        stopReason: outcome === 'attentionRequired' ? 'attentionRequired' : null,
        supervision: {
          ...startSupervisionProtocol('stale-wait'),
          outcome,
          waitLease: {
            id: `${outcome}-lease`,
            probeKey: 'stale-wait',
            wakeConditions: ['executorChanged'],
          },
        },
        updatedAt: now,
      };
      const coordinator = new AutopilotCoordinator({
        store: {
          find: () => state,
          save: (next) => {
            state = next;
          },
          remove: () => {},
          findControl: () => null,
          saveControl: () => {},
          controlIds: () => new Set(),
        },
        now: () => now,
        policy: defaultAutopilotPolicy,
        plan: () => ({ plan, identity: 'p1' }),
        session: () => ({ state: 'ready', threadId: 't', activeTurnId: null }),
        activity: () => null,
        pendingInteraction: () => false,
        reconcile: async () => ({ compatible: true }),
        schedule: () => () => {},
        nextControlId: () => 'control',
        turnStarter: { start: async () => {} },
        publish: () => {},
      });
      coordinator.enable('s');
      expect(state?.supervision).toMatchObject({
        outcome: outcome === 'safetyPaused' ? 'active' : 'attentionRequired',
        waitLease: null,
      });
    },
  );

  it('cancels a proactive deadline when its root-owned process completes first', () => {
    let state: AutopilotSession | null = {
      sessionId: 's',
      state: 'monitoring',
      requestedEnabled: true,
      planIdentity: 'p1',
      planFingerprint: 'f1',
      generation: 1,
      consecutiveNoProgress: 0,
      nextEvaluationAt: null,
      lastControlId: null,
      stopReason: null,
      supervision: startSupervisionProtocol('before-change'),
      updatedAt: now,
    };
    const cancels: Array<ReturnType<typeof vi.fn>> = [];
    const coordinator = new AutopilotCoordinator({
      store: {
        find: () => state,
        save: (next) => {
          state = next;
        },
        remove: () => {},
        findControl: () => null,
        saveControl: () => {},
        controlIds: () => new Set(),
      },
      now: () => now,
      policy: { ...defaultAutopilotPolicy, backoffMs: () => 0 },
      plan: () => ({ plan, identity: 'p1' }),
      session: () => ({ state: 'ready', threadId: 't', activeTurnId: null }),
      activity: () => null,
      pendingInteraction: () => false,
      reconcile: async () => ({ compatible: true }),
      schedule: () => {
        const cancel = vi.fn();
        cancels.push(cancel);
        return cancel;
      },
      nextControlId: () => 'event-control',
      turnStarter: { start: async () => {} },
      publish: () => {},
    });

    expect(
      coordinator.registerProactiveWait('s', {
        id: 'event-report',
        leaseId: 'event-lease',
        wakeConditions: ['processExited', 'processResultAvailable'],
        maxWaitMs: 7_200_000,
      }),
    ).toBe(true);
    const waitTimerCancel = cancels[0]!;

    expect(coordinator.rootProcessCompleted('s', 'gh-watch-item')).toBe(true);
    expect(waitTimerCancel).toHaveBeenCalledTimes(1);
    expect(state?.supervision).toMatchObject({ outcome: 'active', waitLease: null });
    expect(coordinator.rootProcessCompleted('s', 'gh-watch-item')).toBe(false);
  });
  it.each(['none', 'checkpoint', 'executor'] as const)(
    'acknowledges a checkpoint without scheduling, cancels a %s lease, and continues after the root final',
    (lease) => {
      let state: AutopilotSession | null = {
        sessionId: 's',
        state: 'monitoring',
        requestedEnabled: true,
        planIdentity: 'p',
        planFingerprint: 'f',
        generation: 1,
        consecutiveNoProgress: 0,
        nextEvaluationAt: null,
        lastControlId: null,
        stopReason: null,
        updatedAt: now,
        supervision:
          lease !== 'none'
            ? {
                ...startSupervisionProtocol('progress'),
                outcome: 'parked',
                probeKey: 'progress',
                waitLease: {
                  id: 'lease',
                  probeKey: 'progress',
                  wakeConditions:
                    lease === 'checkpoint' ? ['checkpointChanged'] : ['executorChanged'],
                },
              }
            : startSupervisionProtocol('progress'),
      };
      const controls = new Map<string, import('./ports.js').AutopilotControl>();
      let schedules = 0;
      const coordinator = new AutopilotCoordinator({
        store: {
          find: () => state,
          save: (next) => {
            state = next;
          },
          remove: () => {},
          findControl: (_s, id) => controls.get(id) ?? null,
          saveControl: (control) => controls.set(control.controlId, control),
          controlIds: () => new Set(controls.keys()),
        },
        now: () => now,
        policy: { ...defaultAutopilotPolicy, backoffMs: () => 0 },
        plan: () => ({ plan, identity: 'p' }),
        session: () => ({ state: 'ready', threadId: 't', activeTurnId: null }),
        activity: () => ({
          ...createAgentActivitySnapshot('s', now),
          confidence: 'fresh',
          root: { ...createAgentActivitySnapshot('s', now).root, state: 'idle' },
        }),
        pendingInteraction: () => false,
        reconcile: async () => ({ compatible: true }),
        schedule: () => {
          schedules += 1;
          return () => {};
        },
        nextControlId: () => 'checkpoint-control',
        turnStarter: { start: async () => {} },
        publish: () => {},
      });
      const checkpoint = {
        version: 1 as const,
        kind: 'l2Completed' as const,
        planIdentity: 'p',
        l1Id: 'l1',
        l2Id: 'l2',
        position: 'L1.1',
        status: 'DONE' as const,
        changes: 'Added the report boundary.',
        files: 'src/reporting.ts',
        tests: 'Focused tests passed.',
      };
      expect(coordinator.checkpointAccepted('s', checkpoint, 'turn-1', now)).toBe(true);
      expect(schedules).toBe(0);
      expect(state?.supervision).toMatchObject({ outcome: 'active', waitLease: null });
      expect(coordinator.checkpointAccepted('s', checkpoint, 'turn-1', now)).toBe(true);
      expect(schedules).toBe(0);
      expect(
        coordinator.checkpointAccepted(
          's',
          { ...checkpoint, changes: 'Conflicting replay.' },
          'turn-1',
          now,
        ),
      ).toBe(true);
      expect(state?.checkpoints).toMatchObject({
        reportedL2Ids: ['["l1","l2"]'],
        pendingTurnId: 'turn-1',
        pendingKind: 'l2Completed',
      });
      // A failed transport is durable but cannot bypass the root-final fence.
      expect(coordinator.checkpointHandoffFailed('s', 'turn-1')).toBe(true);
      expect(coordinator.checkpointHandoffFailed('s', 'turn-1')).toBe(false);
      expect(state?.checkpoints).toMatchObject({
        pendingTurnId: 'turn-1',
        checkpointHandoffFailed: true,
      });
      expect(schedules).toBe(0);
      expect(coordinator.recoverCheckpointHandoff('s')).toBe(true);
      expect(schedules).toBe(1);
      expect(state?.checkpoints).toMatchObject({
        pendingTurnId: null,
        pendingKind: null,
        checkpointHandoffFailed: false,
      });
      expect(coordinator.recoverCheckpointHandoff('s')).toBe(false);
    },
  );
  it('reports a reopened L2 once while ignoring append-only plan refinement', () => {
    const completedPlan: import('../../plans/domain/supervised-plan.js').SupervisedPlan = {
      ...plan,
      steps: [
        {
          ...plan.steps[0]!,
          children: [
            {
              id: 'l2',
              title: 'l2',
              level: 2 as const,
              state: 'DONE' as const,
              priority: 'A' as const,
              description: {},
              children: [],
            },
          ],
        },
      ],
    };
    let planState = completedPlan;
    let state: AutopilotSession | null = {
      sessionId: 's',
      state: 'monitoring',
      requestedEnabled: true,
      planIdentity: 'p',
      planFingerprint: 'f',
      generation: 1,
      consecutiveNoProgress: 0,
      nextEvaluationAt: null,
      lastControlId: null,
      stopReason: null,
      updatedAt: now,
    };
    const coordinator = new AutopilotCoordinator({
      store: {
        find: () => state,
        save: (next) => {
          state = next;
        },
        remove: () => {},
        findControl: () => null,
        saveControl: () => {},
        controlIds: () => new Set(),
      },
      now: () => now,
      policy: defaultAutopilotPolicy,
      plan: () => ({ plan: planState, identity: 'p' }),
      session: () => ({ state: 'ready', threadId: 't', activeTurnId: null }),
      activity: () => null,
      pendingInteraction: () => false,
      reconcile: async () => ({ compatible: true }),
      schedule: () => () => {},
      nextControlId: () => 'c',
      turnStarter: { start: async () => {} },
      publish: () => {},
    });
    const checkpoint = {
      version: 1 as const,
      kind: 'l2Completed' as const,
      planIdentity: 'p',
      l1Id: 'l1',
      l2Id: 'l2',
      position: 'L1.1',
      status: 'DONE' as const,
      changes: 'x',
      files: 'x',
      tests: 'x',
    };
    expect(coordinator.checkpointAccepted('s', checkpoint, 'turn-1', now)).toBe(true);
    expect(coordinator.checkpointAccepted('s', checkpoint, 'turn-1', now)).toBe(true);
    planState = {
      ...planState,
      steps: [{ ...completedPlan.steps[0]!, reviewStatus: 'REVIEWED' as const }],
    };
    coordinator.planStatusChanged('s');
    planState = completedPlan;
    coordinator.planStatusChanged('s');
    expect(state?.checkpoints?.completionEpochs).toContainEqual({
      target: '["l2","l1","l2"]',
      epoch: 0,
      reopened: false,
      completed: true,
    });
    // A parent review/reopen cycle is not a child completion epoch.
    expect(coordinator.checkpointAccepted('s', checkpoint, 'turn-1-replay', now)).toBe(false);
    planState = {
      ...planState,
      steps: [...planState.steps, { ...planState.steps[0]!, id: 'append', children: [] }],
    };
    coordinator.planStatusChanged('s');
    expect(coordinator.checkpointAccepted('s', checkpoint, 'turn-2', now)).toBe(false);
    planState = {
      ...planState,
      steps: [
        {
          ...completedPlan.steps[0]!,
          children: [{ ...completedPlan.steps[0]!.children[0]!, state: 'WIP' as const }],
        },
      ],
    };
    coordinator.planStatusChanged('s');
    planState = completedPlan;
    coordinator.planStatusChanged('s');
    expect(coordinator.checkpointAccepted('s', checkpoint, 'turn-3', now)).toBe(true);
    expect(state?.checkpoints?.completionEpochs).toContainEqual({
      target: '["l2","l1","l2"]',
      epoch: 1,
      reopened: false,
      completed: true,
    });
    expect(state?.checkpoints?.reportedL2Ids).toEqual(['["l1","l2"]']);
  });
  it('advances an L1 epoch only when its own accepted review state reopens', () => {
    const acceptedPlan: import('../../plans/domain/supervised-plan.js').SupervisedPlan = {
      ...plan,
      steps: [{ ...plan.steps[0]!, state: 'DONE', reviewStatus: 'REVIEWED' }],
      doneSteps: 1,
      allDone: true,
    };
    let planState = acceptedPlan;
    let state: AutopilotSession | null = {
      sessionId: 's',
      state: 'monitoring',
      requestedEnabled: true,
      planIdentity: 'p',
      planFingerprint: 'f',
      generation: 1,
      consecutiveNoProgress: 0,
      nextEvaluationAt: null,
      lastControlId: null,
      stopReason: null,
      updatedAt: now,
    };
    const coordinator = new AutopilotCoordinator({
      store: {
        find: () => state,
        save: (next) => {
          state = next;
        },
        remove: () => {},
        findControl: () => null,
        saveControl: () => {},
        controlIds: () => new Set(),
      },
      now: () => now,
      policy: defaultAutopilotPolicy,
      plan: () => ({ plan: planState, identity: 'p' }),
      session: () => ({ state: 'ready', threadId: 't', activeTurnId: null }),
      activity: () => null,
      pendingInteraction: () => false,
      reconcile: async () => ({ compatible: true }),
      schedule: () => () => {},
      nextControlId: () => 'c',
      turnStarter: { start: async () => {} },
      publish: () => {},
    });
    const checkpoint = {
      version: 1 as const,
      kind: 'l1Accepted' as const,
      planIdentity: 'p',
      l1Id: 'l1',
      position: 'L1',
      verdict: 'ACCEPT' as const,
      commit: { kind: 'notRequired' as const },
    };
    expect(coordinator.checkpointAccepted('s', checkpoint, 'turn-1', now)).toBe(true);
    expect(
      coordinator.checkpointAccepted(
        's',
        { ...checkpoint, findings: 'conflicting summary' },
        'turn-1',
        now,
      ),
    ).toBe(true);
    planState = { ...acceptedPlan, title: 'append-only refinement' };
    coordinator.planStatusChanged('s');
    expect(state?.checkpoints?.completionEpochs).toContainEqual({
      target: '["l1","l1"]',
      epoch: 0,
      reopened: false,
      completed: true,
    });
    planState = {
      ...acceptedPlan,
      steps: [{ ...acceptedPlan.steps[0]!, reviewStatus: 'UNREVIEWED' }],
    };
    coordinator.planStatusChanged('s');
    planState = acceptedPlan;
    coordinator.planStatusChanged('s');
    expect(coordinator.checkpointAccepted('s', checkpoint, 'turn-2', now)).toBe(true);
    expect(state?.checkpoints?.completionEpochs).toContainEqual({
      target: '["l1","l1"]',
      epoch: 1,
      reopened: false,
      completed: true,
    });
  });
  it('persists a reopened L2 epoch and idempotent replay through a SQLite restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gestalt-checkpoint-epoch-'));
    const path = join(directory, 'relay.sqlite');
    const completedPlan: import('../../plans/domain/supervised-plan.js').SupervisedPlan = {
      ...plan,
      steps: [
        {
          ...plan.steps[0]!,
          children: [
            {
              id: 'l2',
              title: 'l2',
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
    let planState = completedPlan;
    const checkpoint = {
      version: 1 as const,
      kind: 'l2Completed' as const,
      planIdentity: 'p',
      l1Id: 'l1',
      l2Id: 'l2',
      position: 'L1.1',
      status: 'DONE' as const,
      changes: 'x',
      files: 'x',
      tests: 'x',
    };
    const coordinator = (database: DatabaseSync) =>
      new AutopilotCoordinator({
        store: new SqliteAutopilotStore(database),
        now: () => now,
        policy: defaultAutopilotPolicy,
        plan: () => ({ plan: planState, identity: 'p' }),
        session: () => ({ state: 'ready', threadId: 't', activeTurnId: null }),
        activity: () => null,
        pendingInteraction: () => false,
        reconcile: async () => ({ compatible: true }),
        schedule: () => () => {},
        nextControlId: () => 'c',
        turnStarter: { start: async () => {} },
        publish: () => {},
      });
    try {
      const first = new DatabaseSync(path);
      migrate(first);
      first
        .prepare(
          "INSERT INTO relay_sessions (id,workspace_id,workspace_path,profile,state,desired_state,failure_count,next_sequence,created_at,updated_at) VALUES ('s','w','/w','p','ready','active',0,1,'t','t')",
        )
        .run();
      new SqliteAutopilotStore(first).save({
        sessionId: 's',
        state: 'monitoring',
        requestedEnabled: true,
        planIdentity: 'p',
        planFingerprint: 'f',
        generation: 1,
        consecutiveNoProgress: 0,
        nextEvaluationAt: null,
        lastControlId: null,
        stopReason: null,
        updatedAt: now,
      });
      const active = coordinator(first);
      expect(active.checkpointAccepted('s', checkpoint, 'first', now)).toBe(true);
      planState = {
        ...completedPlan,
        steps: [
          {
            ...completedPlan.steps[0]!,
            children: [{ ...completedPlan.steps[0]!.children[0]!, state: 'WIP' }],
          },
        ],
      };
      active.planStatusChanged('s');
      planState = completedPlan;
      active.planStatusChanged('s');
      expect(active.checkpointAccepted('s', checkpoint, 'second', now)).toBe(true);
      await Promise.resolve();
      await Promise.resolve();
      first.close();
      const reopened = new DatabaseSync(path);
      migrate(reopened);
      const restored = new SqliteAutopilotStore(reopened).find('s');
      expect(restored?.checkpoints).toMatchObject({
        completionEpochs: [
          { target: '["l2","l1","l2"]', epoch: 1, reopened: false, completed: true },
        ],
        reportedL2Ids: ['["l1","l2"]'],
      });
      expect(coordinator(reopened).checkpointAccepted('s', checkpoint, 'replay', now)).toBe(false);
      await Promise.resolve();
      await Promise.resolve();
      reopened.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('restores a checkpointed root boundary without a duplicate report, then resumes one executor', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gestalt-checkpoint-executor-restart-'));
    const path = join(directory, 'relay.sqlite');
    const timers: Array<{ callback: () => void; cancelled: boolean }> = [];
    const resume = vi.fn(async () => undefined);
    const published: string[] = [];
    let session = {
      state: 'ready',
      threadId: 'root',
      activeTurnId: 'turn-checkpoint' as string | null,
    };
    const checkpointPlan: import('../../plans/domain/supervised-plan.js').SupervisedPlan = {
      ...plan,
      steps: [
        {
          ...plan.steps[0]!,
          children: [
            {
              id: 'l2',
              title: 'l2',
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
    const checkpoint = {
      version: 1 as const,
      kind: 'l2Completed' as const,
      planIdentity: 'p',
      l1Id: 'l1',
      l2Id: 'l2',
      position: 'L1.1',
      status: 'DONE' as const,
      changes: 'x',
      files: 'x',
      tests: 'x',
    };
    const activity = {
      ...createAgentActivitySnapshot('s', now),
      confidence: 'fresh' as const,
      root: {
        ...createAgentActivitySnapshot('s', now).root,
        state: 'idle' as const,
        reason: 'turnCompleted' as const,
      },
      aggregateSubagents: 'idle' as const,
      subagents: [
        {
          id: 'thread-l1',
          threadId: 'thread-l1',
          taskPath: '/root/l1',
          canonicalTaskName: 'l1',
          canonicalPosition: 'L1',
          continuationGeneration: 1,
          outcome: 'partial' as const,
          ownedProcesses: [],
          state: 'idle' as const,
          reason: 'turnCompleted' as const,
          observedAt: now,
          lastActivityAt: now,
        },
      ],
    };
    const coordinator = (database: DatabaseSync) =>
      new AutopilotCoordinator({
        store: new SqliteAutopilotStore(database),
        now: () => now,
        policy: {
          ...defaultAutopilotPolicy,
          quiescenceMs: 0,
          executorContinuationBaseMs: 0,
          executorContinuationMaxMs: 0,
        },
        plan: () => ({ plan: checkpointPlan, identity: 'p' }),
        session: () => session,
        activity: () => activity,
        pendingInteraction: () => false,
        reconcile: async () => ({ compatible: true }),
        schedule: (callback) => {
          const timer = { callback, cancelled: false };
          timers.push(timer);
          return () => {
            timer.cancelled = true;
          };
        },
        nextControlId: () => 'unexpected-root-control',
        turnStarter: { start: async () => {} },
        executorController: {
          resume,
          refresh: async () => {},
          interrupt: async () => false,
          transferProcess: () => {},
          consumeProcess: () => {},
          terminateProcess: async () => false,
        },
        publish: (_sessionId, type) => published.push(type),
      });
    try {
      const first = new DatabaseSync(path);
      migrate(first);
      first
        .prepare(
          "INSERT INTO relay_sessions (id,workspace_id,workspace_path,profile,state,desired_state,failure_count,next_sequence,created_at,updated_at) VALUES ('s','w','/w','p','ready','active',0,1,'t','t')",
        )
        .run();
      const active = coordinator(first);
      active.supervisionStarted('s');
      expect(active.checkpointAccepted('s', checkpoint, 'turn-checkpoint', now)).toBe(true);
      expect(published.filter((type) => type === 'org-plan.step-checkpointed')).toHaveLength(1);
      first.close();

      const reopened = new DatabaseSync(path);
      migrate(reopened);
      const restored = coordinator(reopened);
      restored.restore('s');
      // Replayed delivery is accepted idempotently, but cannot report or start
      // the child while the durable owning root turn remains active.
      expect(restored.checkpointAccepted('s', checkpoint, 'turn-checkpoint', now)).toBe(true);
      expect(timers.filter((timer) => !timer.cancelled)).toHaveLength(0);
      expect(resume).not.toHaveBeenCalled();
      expect(published.filter((type) => type === 'org-plan.step-checkpointed')).toHaveLength(1);

      session = { ...session, activeTurnId: null };
      expect(restored.turnCompleted('s')).toBe(true);
      await vi.waitFor(() => expect(timers.filter((timer) => !timer.cancelled)).toHaveLength(1));
      const continuation = timers.find((timer) => !timer.cancelled)!;
      continuation.callback();
      continuation.callback();
      await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
      expect(resume).toHaveBeenCalledWith('s', 'thread-l1', 2, { kind: 'partial' });
      expect(new SqliteAutopilotStore(reopened).find('s')?.checkpoints).toMatchObject({
        pendingTurnId: null,
        pendingKind: null,
        reportedL2Ids: ['["l1","l2"]'],
      });
      expect(published.filter((type) => type === 'org-plan.step-reported')).toHaveLength(1);
      expect(restored.checkpointAccepted('s', checkpoint, 'turn-checkpoint', now)).toBe(false);
      reopened.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('does not replay an issued command after a restart boundary', () => {
    let state: AutopilotSession | null = {
      sessionId: 's',
      state: 'backoff',
      requestedEnabled: true,
      planIdentity: 'p',
      planFingerprint: 'f',
      generation: 1,
      consecutiveNoProgress: 0,
      nextEvaluationAt: '2026-08-20T12:01:00.000Z',
      lastControlId: 'c',
      stopReason: null,
      updatedAt: now,
    };
    const issued = {
      sessionId: 's',
      controlId: 'c',
      status: 'issued' as const,
      createdAt: now,
      updatedAt: now,
      failureCode: null,
    };
    let starts = 0;
    const coordinator = new AutopilotCoordinator({
      store: {
        find: () => state,
        save: (next) => {
          state = next;
        },
        remove: () => {},
        findControl: () => issued,
        saveControl: () => {},
        controlIds: () => new Set(['c']),
      },
      now: () => now,
      policy: defaultAutopilotPolicy,
      plan: () => ({ plan, identity: 'p' }),
      session: () => ({ state: 'ready', threadId: 't', activeTurnId: null }),
      activity: () => null,
      pendingInteraction: () => false,
      reconcile: async () => ({ compatible: true }),
      schedule: () => () => {},
      turnStarter: {
        start: async () => {
          starts += 1;
        },
      },
      publish: () => {},
      nextControlId: () => 'unused',
    });
    coordinator.restore('s');
    expect(starts).toBe(0);
    expect(state).toMatchObject({
      state: 'monitoring',
      requestedEnabled: true,
      stopReason: 'reconcileFailed',
    });
  });
  it('keeps a typed unavailable starter failure under condition-based inspection', async () => {
    let state: AutopilotSession | null = null;
    let fire: (() => void) | undefined;
    const controls = new Map<string, import('./ports.js').AutopilotControl>();
    const events: Array<{ type: string; payload: unknown }> = [];
    const coordinator = new AutopilotCoordinator({
      store: {
        find: () => state,
        save: (next) => {
          state = next;
        },
        remove: () => {},
        findControl: (sessionId, controlId) => controls.get(`${sessionId}:${controlId}`) ?? null,
        saveControl: (control) =>
          controls.set(`${control.sessionId}:${control.controlId}`, control),
        controlIds: () => new Set(controls.keys()),
      },
      now: () => now,
      policy: { ...defaultAutopilotPolicy, backoffMs: () => 0 },
      plan: () => ({ plan, identity: 'p' }),
      session: () => ({ state: 'ready', threadId: 't', activeTurnId: null }),
      activity: () => ({
        ...createAgentActivitySnapshot('s', now),
        confidence: 'fresh',
        root: { ...createAgentActivitySnapshot('s', now).root, state: 'idle' },
      }),
      pendingInteraction: () => false,
      reconcile: async () => ({ compatible: true }),
      schedule: (callback) => {
        fire = callback;
        return () => {
          fire = undefined;
        };
      },
      nextControlId: () => 'c',
      turnStarter: {
        start: async () => {
          throw Object.assign(new Error('unavailable'), { code: 'AUTOPILOT_START_UNAVAILABLE' });
        },
      },
      publish: (_id, type, payload) => events.push({ type, payload }),
    });
    coordinator.enable('s');
    await fire?.();
    expect(state).toMatchObject({
      state: 'monitoring',
      requestedEnabled: true,
      stopReason: 'startUnavailable',
    });
    expect(controls.get('s:c')).toMatchObject({
      status: 'failed',
      failureCode: 'START_UNAVAILABLE',
    });
    expect(events.find((event) => event.type === 'autopilot.turn-failed')).toMatchObject({
      payload: { controlId: 'c', code: 'START_UNAVAILABLE' },
    });
  });
  it('does not manufacture human attention from a missing runtime writer', async () => {
    let state: AutopilotSession | null = null;
    let fire: (() => void) | undefined;
    const controls = new Map<string, import('./ports.js').AutopilotControl>();
    const coordinator = new AutopilotCoordinator({
      store: {
        find: () => state,
        save: (next) => {
          state = next;
        },
        remove: () => {},
        findControl: (sessionId, controlId) => controls.get(`${sessionId}:${controlId}`) ?? null,
        saveControl: (control) =>
          controls.set(`${control.sessionId}:${control.controlId}`, control),
        controlIds: () => new Set(controls.keys()),
      },
      now: () => now,
      policy: { ...defaultAutopilotPolicy, backoffMs: () => 0 },
      plan: () => ({ plan, identity: 'p' }),
      session: () => ({ state: 'ready', threadId: 't', activeTurnId: null }),
      activity: () => ({
        ...createAgentActivitySnapshot('s', now),
        confidence: 'fresh',
        root: { ...createAgentActivitySnapshot('s', now).root, state: 'idle' },
      }),
      pendingInteraction: () => false,
      reconcile: async () => ({ compatible: true }),
      schedule: (callback) => {
        fire = callback;
        return () => {
          fire = undefined;
        };
      },
      nextControlId: () => 'writer-control',
      turnStarter: {
        start: async () => {
          throw new Error('CODEX_SESSION_NOT_RUNNING');
        },
      },
      publish: () => {},
    });
    coordinator.enable('s');
    await fire?.();
    expect(state).toMatchObject({
      state: 'monitoring',
      requestedEnabled: true,
      stopReason: 'startUnavailable',
    });
    expect(controls.get('s:writer-control')).toMatchObject({
      status: 'failed',
      failureCode: 'START_UNAVAILABLE',
    });
  });
  it.each(['confidence', 'timestamp'] as const)(
    'arms one bounded watchdog when compatible reconciliation leaves %s stale',
    async (staleBy) => {
      let state: AutopilotSession | null = null;
      let reconciliations = 0;
      let schedules = 0;
      const coordinator = new AutopilotCoordinator({
        store: {
          find: () => state,
          save: (next) => {
            state = next;
          },
          remove: () => {},
          findControl: () => null,
          saveControl: () => {},
          controlIds: () => new Set(),
        },
        now: () => now,
        policy: defaultAutopilotPolicy,
        plan: () => ({ plan, identity: 'p' }),
        session: () => ({ state: 'ready', threadId: 't', activeTurnId: null }),
        activity: () =>
          staleBy === 'confidence'
            ? null
            : {
                ...createAgentActivitySnapshot('s', now),
                confidence: 'fresh',
                root: {
                  ...createAgentActivitySnapshot('s', now).root,
                  state: 'idle',
                  lastActivityAt: '2026-08-20T11:00:00.000Z',
                },
              },
        pendingInteraction: () => false,
        reconcile: async () => {
          reconciliations += 1;
          return { compatible: true };
        },
        schedule: () => {
          schedules += 1;
          return () => {};
        },
        nextControlId: () => 'unused',
        turnStarter: { start: async () => {} },
        publish: () => {},
      });

      coordinator.enable('s');
      await Promise.resolve();
      await Promise.resolve();

      expect(reconciliations).toBe(1);
      expect(schedules).toBe(1);
      expect(state).toMatchObject({ state: 'monitoring', requestedEnabled: true });
    },
  );
  it('durably invalidates a pending control when a manual turn wins the race', () => {
    let state: AutopilotSession | null = {
      sessionId: 's',
      state: 'backoff',
      requestedEnabled: true,
      planIdentity: 'p',
      planFingerprint: 'f',
      generation: 2,
      consecutiveNoProgress: 0,
      nextEvaluationAt: '2026-08-20T12:01:00.000Z',
      lastControlId: 'control',
      stopReason: null,
      supervision: {
        ...startSupervisionProtocol('stale-wait'),
        outcome: 'parked',
        waitLease: {
          id: 'manual-send-lease',
          probeKey: 'stale-wait',
          wakeConditions: ['executorChanged'],
        },
      },
      updatedAt: now,
    };
    let control: import('./ports.js').AutopilotControl = {
      sessionId: 's',
      controlId: 'control',
      status: 'scheduled',
      createdAt: now,
      updatedAt: now,
      failureCode: null,
    };
    const coordinator = new AutopilotCoordinator({
      store: {
        find: () => state,
        save: (next) => {
          state = next;
        },
        remove: () => {},
        findControl: () => control,
        saveControl: (next) => {
          control = next;
        },
        controlIds: () => new Set(),
      },
      now: () => now,
      policy: defaultAutopilotPolicy,
      plan: () => ({ plan, identity: 'p' }),
      session: () => ({ state: 'ready', threadId: 't', activeTurnId: null }),
      activity: () => null,
      pendingInteraction: () => false,
      reconcile: async () => ({ compatible: true }),
      schedule: () => () => {},
      nextControlId: () => 'next',
      turnStarter: { start: async () => {} },
      publish: () => {},
    });
    coordinator.manualSend('s');
    expect(state).toMatchObject({
      state: 'monitoring',
      generation: 3,
      nextEvaluationAt: null,
      lastControlId: null,
      supervision: { outcome: 'active', waitLease: null },
    });
    expect(control.status).toBe('cancelled');
  });
  it('reconciles an ordinary retained incomplete-plan update without a wait lease', async () => {
    const initial: AutopilotSession = {
      sessionId: 's',
      state: 'monitoring',
      requestedEnabled: true,
      planIdentity: 'p',
      planFingerprint: 'old-fingerprint',
      generation: 1,
      consecutiveNoProgress: 2,
      nextEvaluationAt: null,
      lastControlId: 'prior',
      stopReason: null,
      updatedAt: now,
    };
    let state: AutopilotSession | null = initial;
    const publish = vi.fn();
    const schedule = vi.fn(() => () => {});
    const coordinator = new AutopilotCoordinator({
      store: {
        find: () => state,
        save: (next) => {
          state = next;
        },
        remove: () => {},
        findControl: () => null,
        saveControl: () => {},
        controlIds: () => new Set(),
      },
      now: () => now,
      policy: defaultAutopilotPolicy,
      plan: () => ({ plan: { ...plan, doneSteps: 1 }, identity: 'p' }),
      session: () => ({ state: 'ready', threadId: 't', activeTurnId: null }),
      activity: () => null,
      pendingInteraction: () => false,
      reconcile: async () => ({ compatible: true }),
      schedule,
      nextControlId: () => 'next',
      turnStarter: { start: async () => {} },
      publish,
    });

    coordinator.planStatusChanged('s');
    coordinator.planStatusChanged('s');
    await Promise.resolve();
    await Promise.resolve();

    expect(state).toMatchObject({ state: 'monitoring', requestedEnabled: true });
    expect(state).not.toBe(initial);
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      's',
      'autopilot.updated',
      expect.objectContaining({ enabled: true, state: 'monitoring' }),
      now,
    );
  });
  it('cancels pending continuation and resets retries only when subagents resume work', () => {
    let state: AutopilotSession | null = {
      sessionId: 's',
      state: 'backoff',
      requestedEnabled: true,
      planIdentity: 'p',
      planFingerprint: 'f',
      generation: 1,
      consecutiveNoProgress: 2,
      nextEvaluationAt: '2026-08-20T12:01:00.000Z',
      lastControlId: 'pending',
      stopReason: null,
      updatedAt: now,
    };
    let control: import('./ports.js').AutopilotControl = {
      sessionId: 's',
      controlId: 'pending',
      status: 'scheduled',
      createdAt: now,
      updatedAt: now,
      failureCode: null,
    };
    let timerCancelled = false;
    const events: string[] = [];
    const coordinator = new AutopilotCoordinator({
      store: {
        find: () => state,
        save: (next) => {
          state = next;
        },
        remove: () => {},
        findControl: () => control,
        saveControl: (next) => {
          control = next;
        },
        controlIds: () => new Set(),
      },
      now: () => now,
      policy: defaultAutopilotPolicy,
      plan: () => ({ plan, identity: 'p' }),
      session: () => ({ state: 'ready', threadId: 't', activeTurnId: null }),
      activity: () => ({
        ...createAgentActivitySnapshot('s', now),
        confidence: 'fresh',
        root: { ...createAgentActivitySnapshot('s', now).root, state: 'idle' },
        aggregateSubagents: 'working',
      }),
      pendingInteraction: () => false,
      reconcile: async () => ({ compatible: true }),
      schedule: () => () => {
        timerCancelled = true;
      },
      nextControlId: () => 'next',
      turnStarter: { start: async () => {} },
      publish: (_id, type) => events.push(type),
    });
    coordinator.restore('s');
    coordinator.activityChanged('s');
    expect(state).toMatchObject({
      state: 'monitoring',
      requestedEnabled: true,
      generation: 2,
      consecutiveNoProgress: 0,
      nextEvaluationAt: null,
      lastControlId: null,
    });
    expect(timerCancelled).toBe(true);
    expect(control.status).toBe('cancelled');
    expect(events).not.toContain('autopilot.progress-reset');
  });
  it.each([
    ['idle', true],
    ['blocked', true],
    ['working', false],
    ['awaitingAgent', false],
  ] as const)(
    'treats a root awaitingAgent with %s subagents as continuation eligible: %s',
    (aggregateSubagents, eligible) => {
      let state: AutopilotSession | null = {
        sessionId: 's',
        state: 'monitoring',
        requestedEnabled: true,
        planIdentity: 'p',
        planFingerprint: 'f',
        generation: 1,
        consecutiveNoProgress: 0,
        nextEvaluationAt: null,
        lastControlId: null,
        stopReason: null,
        updatedAt: now,
      };
      const timers: Array<() => void> = [];
      const coordinator = new AutopilotCoordinator({
        store: {
          find: () => state,
          save: (next) => {
            state = next;
          },
          remove: () => {},
          findControl: () => null,
          saveControl: () => {},
          controlIds: () => new Set(),
        },
        now: () => now,
        policy: { ...defaultAutopilotPolicy, quiescenceMs: 0 },
        plan: () => ({ plan, identity: 'p' }),
        session: () => ({ state: 'ready', threadId: 't', activeTurnId: null }),
        activity: () => ({
          ...createAgentActivitySnapshot('s', now),
          confidence: 'fresh',
          root: {
            ...createAgentActivitySnapshot('s', now).root,
            state: 'awaitingAgent',
            lastActivityAt: now,
          },
          aggregateSubagents,
        }),
        pendingInteraction: () => false,
        reconcile: async () => ({ compatible: true }),
        schedule: (callback) => {
          timers.push(callback);
          return () => {};
        },
        nextControlId: () => 'next',
        turnStarter: { start: async () => {} },
        publish: () => {},
      });

      coordinator.activityChanged('s');
      expect(timers).toHaveLength(eligible ? 1 : 0);
    },
  );
  it('does not stop from an unstructured awaiting-human projection', () => {
    let state: AutopilotSession | null = {
      sessionId: 's',
      state: 'monitoring',
      requestedEnabled: true,
      planIdentity: 'p',
      planFingerprint: 'f',
      generation: 1,
      consecutiveNoProgress: 0,
      nextEvaluationAt: null,
      lastControlId: null,
      stopReason: null,
      updatedAt: now,
    };
    const events: string[] = [];
    const coordinator = new AutopilotCoordinator({
      store: {
        find: () => state,
        save: (next) => {
          state = next;
        },
        remove: () => {},
        findControl: () => null,
        saveControl: () => {},
        controlIds: () => new Set(),
      },
      now: () => now,
      policy: defaultAutopilotPolicy,
      plan: () => ({ plan, identity: 'p' }),
      session: () => ({ state: 'ready', threadId: 't', activeTurnId: null }),
      activity: () => ({
        ...createAgentActivitySnapshot('s', now),
        confidence: 'fresh',
        root: {
          ...createAgentActivitySnapshot('s', now).root,
          state: 'awaitingHuman',
          lastActivityAt: now,
        },
      }),
      pendingInteraction: () => false,
      reconcile: async () => ({ compatible: true }),
      schedule: () => () => {},
      nextControlId: () => 'next',
      turnStarter: { start: async () => {} },
      publish: (_sessionId, type) => events.push(type),
    });

    coordinator.activityChanged('s');
    coordinator.activityChanged('s');

    expect(state).toMatchObject({
      state: 'monitoring',
      requestedEnabled: true,
      stopReason: null,
      generation: 1,
    });
    expect(events.filter((type) => type === 'autopilot.updated')).toHaveLength(0);
  });
  it('allows yielding only for a validated decision-table attention record', () => {
    let state: AutopilotSession | null = {
      sessionId: 's',
      state: 'monitoring',
      requestedEnabled: true,
      planIdentity: 'p',
      planFingerprint: 'f',
      generation: 1,
      consecutiveNoProgress: 0,
      nextEvaluationAt: null,
      lastControlId: null,
      stopReason: null,
      updatedAt: now,
    };
    const coordinator = new AutopilotCoordinator({
      store: {
        find: () => state,
        save: (next) => {
          state = next;
        },
        remove: () => {},
        findControl: () => null,
        saveControl: () => {},
        controlIds: () => new Set(),
      },
      now: () => now,
      policy: defaultAutopilotPolicy,
      plan: () => ({ plan, identity: 'p' }),
      session: () => ({ state: 'ready', threadId: 't', activeTurnId: null }),
      activity: () => ({
        ...createAgentActivitySnapshot('s', now),
        confidence: 'fresh',
        root: { ...createAgentActivitySnapshot('s', now).root, state: 'awaitingHuman' },
      }),
      pendingInteraction: () => true,
      attention: () => ({
        reason: 'permissionRequired',
        resumeCondition: 'permissionGranted',
      }),
      reconcile: async () => ({ compatible: true }),
      schedule: () => () => {},
      nextControlId: () => 'unused',
      turnStarter: { start: async () => {} },
      publish: () => {},
    });

    coordinator.activityChanged('s');

    expect(state).toMatchObject({
      state: 'attentionRequired',
      requestedEnabled: false,
      blocking: {
        reason: 'permissionRequired',
        resumeCondition: 'permissionGranted',
      },
    });
    expect(coordinator.turnCompleted('s')).toBe(true);
  });
  it('cancels an armed continuation when structured attention arrives', async () => {
    let state: AutopilotSession | null = {
      sessionId: 's',
      state: 'monitoring',
      requestedEnabled: true,
      planIdentity: 'p',
      planFingerprint: 'f',
      generation: 1,
      consecutiveNoProgress: 0,
      nextEvaluationAt: null,
      lastControlId: null,
      stopReason: null,
      updatedAt: now,
    };
    let control: import('./ports.js').AutopilotControl | null = null;
    let attention = false;
    let scheduled: () => void = () => {
      throw new Error('continuation was not scheduled');
    };
    const cancel = vi.fn();
    const start = vi.fn(async () => {});
    const coordinator = new AutopilotCoordinator({
      store: {
        find: () => state,
        save: (next) => {
          state = next;
        },
        remove: () => {},
        findControl: () => control,
        saveControl: (next) => {
          control = next;
        },
        controlIds: () => new Set(),
      },
      now: () => now,
      policy: defaultAutopilotPolicy,
      plan: () => ({ plan, identity: 'p' }),
      session: () => ({ state: 'ready', threadId: 't', activeTurnId: null }),
      activity: () => ({
        ...createAgentActivitySnapshot('s', now),
        confidence: 'fresh',
        root: { ...createAgentActivitySnapshot('s', now).root, state: 'idle' },
        aggregateSubagents: 'idle',
      }),
      pendingInteraction: () => attention,
      attention: () =>
        attention ? { reason: 'permissionRequired', resumeCondition: 'permissionGranted' } : null,
      reconcile: async () => ({ compatible: true }),
      schedule: (callback) => {
        scheduled = callback;
        return cancel;
      },
      nextControlId: () => 'armed-control',
      turnStarter: { start },
      publish: () => {},
    });

    coordinator.evaluate('s');
    expect(state).toMatchObject({ state: 'backoff', lastControlId: 'armed-control' });
    expect(control).toMatchObject({ status: 'scheduled' });

    attention = true;
    coordinator.evaluate('s');
    expect(cancel).toHaveBeenCalledOnce();
    expect(state).toMatchObject({
      state: 'attentionRequired',
      requestedEnabled: false,
      lastControlId: null,
      blocking: { reason: 'permissionRequired', resumeCondition: 'permissionGranted' },
    });
    expect(control).toMatchObject({ status: 'cancelled' });

    scheduled();
    await Promise.resolve();
    await Promise.resolve();
    expect(start).not.toHaveBeenCalled();
  });
  it('paces a settled oscillating session without manufacturing a human blocker', () => {
    let state: AutopilotSession | null = {
      sessionId: 's',
      state: 'monitoring',
      requestedEnabled: true,
      planIdentity: 'p',
      planFingerprint: 'f',
      generation: 4,
      consecutiveNoProgress: 0,
      nextEvaluationAt: null,
      lastControlId: null,
      stopReason: null,
      updatedAt: now,
    };
    let since = '';
    const coordinator = new AutopilotCoordinator({
      store: {
        find: () => state,
        save: (next) => {
          state = next;
        },
        remove: () => {},
        findControl: () => null,
        saveControl: () => {},
        automaticActionsSince: (_sessionId, value) => {
          since = value;
          return defaultAutopilotPolicy.actionLimit;
        },
        controlIds: () => new Set(),
      },
      now: () => now,
      policy: defaultAutopilotPolicy,
      plan: () => ({ plan, identity: 'p' }),
      session: () => ({ state: 'ready', threadId: 't', activeTurnId: null }),
      activity: () => ({
        ...createAgentActivitySnapshot('s', now),
        confidence: 'fresh',
        root: {
          ...createAgentActivitySnapshot('s', now).root,
          state: 'idle',
          lastActivityAt: now,
        },
      }),
      pendingInteraction: () => false,
      reconcile: async () => ({ compatible: true }),
      schedule: () => () => {},
      nextControlId: () => 'unused',
      turnStarter: { start: async () => {} },
      publish: () => {},
    });

    coordinator.evaluate('s');

    expect(since).toBe('2026-08-20T11:50:00.000Z');
    expect(state).toMatchObject({
      state: 'backoff',
      requestedEnabled: true,
      stopReason: null,
    });
  });
  describe('mechanical executor continuation', () => {
    function subject(
      processes: NonNullable<
        ReturnType<typeof createAgentActivitySnapshot>['subagents'][number]['ownedProcesses']
      > = [],
      outcome: 'partial' | 'cancelled' | 'failed' = 'partial',
      childState: 'TODO' | 'WIP' | 'DONE' = 'WIP',
      retryLimit = defaultAutopilotPolicy.retryLimit,
    ) {
      let state: AutopilotSession | null = {
        sessionId: 's',
        state: 'monitoring',
        requestedEnabled: true,
        planIdentity: 'p',
        planFingerprint: 'f',
        generation: 1,
        consecutiveNoProgress: 0,
        nextEvaluationAt: null,
        lastControlId: null,
        stopReason: null,
        updatedAt: now,
      };
      const timers: Array<{ callback: () => void; cancelled: boolean; fired: boolean }> = [];
      const resume = vi.fn(async () => undefined);
      const refresh = vi.fn(async () => undefined);
      const interrupt = vi.fn(async () => true);
      const transferProcess = vi.fn();
      const consumeProcess = vi.fn();
      const terminateProcess = vi.fn(async () => true);
      const rootStart = vi.fn(async () => undefined);
      const published: string[] = [];
      const diagnostic = vi.fn();
      const controls = new Map<string, import('./ports.js').AutopilotControl>();
      let planIdentity = 'p';
      let currentPlan = {
        ...plan,
        steps: [
          {
            ...plan.steps[0]!,
            children: [
              {
                id: 'l1-1',
                title: 'child',
                level: 2 as const,
                state: childState,
                priority: 'A' as const,
                description: {},
                children: [],
              },
            ],
          },
        ],
      };
      let session = { state: 'ready', threadId: 'root', activeTurnId: null as string | null };
      let pending = false;
      let attention: import('../domain/supervised-lifecycle.js').StructuredBlock | null = null;
      let activity: ReturnType<typeof createAgentActivitySnapshot> = {
        ...createAgentActivitySnapshot('s', now),
        confidence: 'fresh' as const,
        root: { ...createAgentActivitySnapshot('s', now).root, state: 'idle' as const },
        aggregateSubagents: 'idle' as const,
        subagents: [
          {
            id: 'thread-l1',
            threadId: 'thread-l1',
            taskPath: '/root/l1',
            canonicalTaskName: 'l1',
            canonicalPosition: 'L1',
            continuationGeneration: 1,
            outcome,
            ownedProcesses: processes,
            state: 'idle' as const,
            reason: 'turnCompleted' as const,
            observedAt: now,
            lastActivityAt: now,
          },
        ],
      };
      const coordinator = new AutopilotCoordinator({
        store: {
          find: () => state,
          save: (next) => {
            state = next;
          },
          remove: () => {},
          findControl: (sessionId, controlId) => controls.get(`${sessionId}:${controlId}`) ?? null,
          saveControl: (control) =>
            controls.set(`${control.sessionId}:${control.controlId}`, control),
          controlIds: () => new Set(controls.keys()),
        },
        now: () => now,
        policy: {
          ...defaultAutopilotPolicy,
          quiescenceMs: 0,
          executorContinuationBaseMs: 0,
          executorContinuationMaxMs: 0,
          processPollMs: 0,
          processMaxElapsedMs: 60_000,
          processMaxRssBytes: 12 * 1024 * 1024 * 1024,
          retryLimit,
        },
        plan: () => ({ plan: currentPlan, identity: planIdentity }),
        session: () => session,
        activity: () => activity,
        pendingInteraction: () => pending,
        attention: () => attention,
        reconcile: async () => ({ compatible: true }),
        schedule: (callback) => {
          const timer = { callback, cancelled: false, fired: false };
          timers.push(timer);
          return () => {
            timer.cancelled = true;
          };
        },
        nextControlId: () => 'root-control',
        turnStarter: { start: rootStart },
        executorController: {
          resume,
          refresh,
          interrupt,
          transferProcess,
          consumeProcess,
          terminateProcess,
        },
        publish: (_sessionId, type) => published.push(type),
        diagnostic,
      });
      const runNext = async () => {
        const timer = timers.find((candidate) => !candidate.cancelled && !candidate.fired);
        expect(timer).toBeDefined();
        timer!.fired = true;
        timer!.callback();
        await vi.waitFor(() =>
          expect(timers.filter((candidate) => candidate.fired).length).toBeGreaterThan(0),
        );
        await Promise.resolve();
        await Promise.resolve();
        return timer!;
      };
      return {
        coordinator,
        runNext,
        resume,
        refresh,
        interrupt,
        transferProcess,
        consumeProcess,
        terminateProcess,
        rootStart,
        timers,
        published,
        diagnostic,
        get state() {
          return state;
        },
        set state(value: AutopilotSession | null) {
          state = value;
        },
        get plan() {
          return currentPlan;
        },
        set plan(value: typeof currentPlan) {
          currentPlan = value;
        },
        set planIdentity(value: string) {
          planIdentity = value;
        },
        get activity() {
          return activity;
        },
        set activity(value: typeof activity) {
          activity = value;
        },
        set session(value: typeof session) {
          session = value;
        },
        set pending(value: boolean) {
          pending = value;
        },
        set attention(value: import('../domain/supervised-lifecycle.js').StructuredBlock | null) {
          attention = value;
        },
      };
    }

    it.each(['rootFinalAttempt', 'checkpoint', 'waitTimeout', 'userStatusAnswered'] as const)(
      'resumes the same executor after %s while L1 remains WIP',
      async (event) => {
        const fixture = subject();
        if (event === 'rootFinalAttempt')
          expect(fixture.coordinator.turnCompleted('s')).toBe(false);
        else fixture.coordinator.activitySettled('s', event);
        await fixture.runNext();
        await fixture.runNext();
        expect(fixture.resume).toHaveBeenCalledWith('s', 'thread-l1', 2, { kind: 'partial' });
        expect(fixture.rootStart).not.toHaveBeenCalled();
        expect(fixture.state).toMatchObject({ requestedEnabled: true, state: 'monitoring' });
      },
    );

    it('rejects an executor wait when its completion is already settled or pending', () => {
      const fixture = subject();
      fixture.coordinator.activitySettled('s', 'stateChanged');
      const settlement = fixture.timers[0]!;

      expect(
        fixture.coordinator.registerProactiveWait('s', {
          id: 'late-wait-report',
          leaseId: 'late-wait-lease',
          wakeConditions: ['executorChanged'],
          maxWaitMs: 60_000,
        }),
      ).toBe('wakeAlreadySatisfied');

      expect(settlement.cancelled).toBe(true);
      expect(fixture.state?.supervision?.waitLease).toBeFalsy();
      expect(fixture.timers).toHaveLength(1);
      expect(fixture.resume).not.toHaveBeenCalled();
    });

    it('accepts an executor wait while the canonical executor is still working', () => {
      const fixture = subject();
      fixture.activity = {
        ...fixture.activity,
        aggregateSubagents: 'working',
        subagents: [{ ...fixture.activity.subagents[0]!, state: 'working' }],
      };

      expect(
        fixture.coordinator.registerProactiveWait('s', {
          id: 'active-wait-report',
          leaseId: 'active-wait-lease',
          wakeConditions: ['executorChanged'],
          maxWaitMs: 60_000,
        }),
      ).toBe(true);

      expect(fixture.state?.supervision).toMatchObject({
        outcome: 'parked',
        waitLease: { id: 'active-wait-lease' },
      });
      expect(fixture.timers).toHaveLength(1);
    });

    it('durably records an executor command before its callback can start work', async () => {
      const fixture = subject();
      fixture.coordinator.activitySettled('s', 'rootFinalAttempt');
      fixture.coordinator.activitySettled('s', 'rootFinalAttempt');
      await fixture.runNext();
      await fixture.runNext();

      expect(fixture.state?.executor?.commands).toEqual([
        expect.objectContaining({
          status: 'accepted',
          planIdentity: 'p',
          canonicalPosition: 'L1',
          canonicalTaskName: 'l1',
          threadId: 'thread-l1',
          generation: 2,
          trigger: 'partial',
        }),
      ]);
      expect(fixture.resume).toHaveBeenCalledTimes(1);
    });

    it.each(['synchronous', 'asynchronous'] as const)(
      'contains an ambiguous %s resume failure and keeps the serial queue live',
      async (delivery) => {
        const fixture = subject();
        if (delivery === 'synchronous')
          fixture.resume.mockImplementationOnce(() => {
            throw new Error('transport lost');
          });
        else fixture.resume.mockRejectedValueOnce(new Error('transport lost'));
        fixture.coordinator.activitySettled('s', 'rootFinalAttempt');
        await fixture.runNext();
        await fixture.runNext();
        await vi.waitFor(() =>
          expect(
            fixture.published.filter((type) => type === 'autopilot.operation-failed'),
          ).toHaveLength(1),
        );
        expect(fixture.state).toMatchObject({
          requestedEnabled: true,
          state: 'monitoring',
          stopReason: 'reconcileFailed',
        });
        await fixture.runNext();
        expect(fixture.refresh).toHaveBeenCalledOnce();
        expect(
          fixture.published.filter((type) => type === 'autopilot.operation-failed'),
        ).toHaveLength(1);
      },
    );

    it.each(['synchronous', 'asynchronous'] as const)(
      'contains an %s refresh failure and retries through a later queued operation',
      async (delivery) => {
        const fixture = subject([
          {
            processId: 'process-1',
            itemId: 'item-1',
            ownerThreadId: 'thread-l1',
            ownerTaskPath: '/root/l1',
            ownership: 'executor',
            state: 'running',
            observedAt: now,
            elapsedMs: 1,
            cpuPercent: 1,
            rssBytes: 1,
          },
        ]);
        if (delivery === 'synchronous')
          fixture.refresh.mockImplementationOnce(() => {
            throw new Error('refresh lost');
          });
        else fixture.refresh.mockRejectedValueOnce(new Error('refresh lost'));
        fixture.coordinator.turnCompleted('s');
        await fixture.runNext();
        await fixture.runNext();
        await vi.waitFor(() =>
          expect(
            fixture.published.filter((type) => type === 'autopilot.operation-failed'),
          ).toHaveLength(1),
        );
        expect(fixture.state).toMatchObject({
          requestedEnabled: true,
          stopReason: 'reconcileFailed',
        });
        await fixture.runNext();
        expect(fixture.refresh).toHaveBeenCalledTimes(2);
      },
    );

    it.each(['persistence', 'publication'] as const)(
      'contains a %s failure without poisoning later queued work',
      async (failure) => {
        const fixture = subject();
        const internal = fixture.coordinator as unknown as {
          deps: {
            store: { save(state: AutopilotSession): void };
            publish(sessionId: string, type: string, payload: unknown, occurredAt: string): void;
          };
        };
        if (failure === 'persistence') {
          const store = internal.deps.store;
          let failed = false;
          internal.deps.store = {
            ...store,
            save(state) {
              if (!failed) {
                failed = true;
                throw new Error('PERSISTENCE_UNAVAILABLE');
              }
              store.save(state);
            },
          };
        } else {
          const publish = internal.deps.publish;
          let failed = false;
          internal.deps.publish = (sessionId, type, payload, occurredAt) => {
            if (!failed) {
              failed = true;
              throw new Error('OUTBOX_PUBLICATION_LOST');
            }
            publish(sessionId, type, payload, occurredAt);
          };
        }
        fixture.coordinator.activitySettled('s', 'rootFinalAttempt');
        await fixture.runNext();
        await vi.waitFor(() =>
          expect(
            fixture.published.filter((type) => type === 'autopilot.operation-failed'),
          ).toHaveLength(1),
        );
        expect(fixture.state).toMatchObject({
          requestedEnabled: true,
          stopReason: 'reconcileFailed',
        });
        expect(fixture.diagnostic).toHaveBeenCalledWith(
          's',
          failure === 'persistence' ? 'operationFailed:PERSISTENCE' : 'operationFailed:PUBLICATION',
        );
        await fixture.runNext();
        expect(fixture.refresh).toHaveBeenCalledOnce();
      },
    );

    it('keeps a persistent store outage observable and re-enters work once persistence returns', async () => {
      const fixture = subject();
      const internal = fixture.coordinator as unknown as {
        deps: { store: { save(state: AutopilotSession): void } };
      };
      const store = internal.deps.store;
      internal.deps.store = {
        ...store,
        save: () => {
          throw new Error('PERSISTENCE_UNAVAILABLE');
        },
      };
      fixture.coordinator.activitySettled('s', 'rootFinalAttempt');
      await fixture.runNext();
      expect(fixture.diagnostic).toHaveBeenCalledWith('s', 'operationFailed:PERSISTENCE');
      expect(
        fixture.published.filter((type) => type === 'autopilot.operation-failed'),
      ).toHaveLength(0);
      expect(fixture.timers.some((timer) => !timer.cancelled && !timer.fired)).toBe(true);

      internal.deps.store = store;
      await fixture.runNext();
      expect(fixture.refresh).toHaveBeenCalledOnce();
    });

    it('arms a store-independent retry when a lifecycle read fails after timer delivery', async () => {
      const fixture = subject();
      const internal = fixture.coordinator as unknown as {
        deps: { store: import('./ports.js').AutopilotStore };
      };
      const store = internal.deps.store;
      let readsFail = false;
      internal.deps.store = {
        ...store,
        find(sessionId) {
          if (readsFail) throw new Error('PERSISTENCE_UNAVAILABLE');
          return store.find(sessionId);
        },
      };
      fixture.coordinator.activitySettled('s', 'rootFinalAttempt');
      readsFail = true;
      await fixture.runNext();
      expect(fixture.diagnostic).toHaveBeenCalledWith('s', 'operationFailed:PERSISTENCE');
      expect(fixture.timers.some((timer) => !timer.cancelled && !timer.fired)).toBe(true);

      readsFail = false;
      await fixture.runNext();
      await fixture.runNext();
      await vi.waitFor(() => expect(fixture.resume).toHaveBeenCalledOnce());
    });

    it('uses a safe terminal state when recovery scheduling fails', async () => {
      const fixture = subject();
      const internal = fixture.coordinator as unknown as {
        deps: { schedule(callback: () => void, delayMs: number): () => void };
      };
      fixture.resume.mockRejectedValueOnce(new Error('transport lost'));
      fixture.coordinator.activitySettled('s', 'rootFinalAttempt');
      await fixture.runNext();
      internal.deps.schedule = () => {
        throw new Error('SCHEDULER_UNAVAILABLE');
      };
      await fixture.runNext();
      await vi.waitFor(() =>
        expect(fixture.state).toMatchObject({
          state: 'safetyPaused',
          requestedEnabled: false,
          stopReason: 'safetyPaused',
        }),
      );
      expect(
        fixture.published.filter((type) => type === 'autopilot.operation-failed'),
      ).toHaveLength(1);
    });

    it('interrupts the older working generation and requires a fresh reconciliation', async () => {
      const fixture = subject();
      fixture.activity = {
        ...fixture.activity,
        subagents: [
          { ...fixture.activity.subagents[0]!, state: 'working', continuationGeneration: 1 },
          {
            ...fixture.activity.subagents[0]!,
            id: 'thread-l1-g2',
            threadId: 'thread-l1-g2',
            taskPath: '/root/l1_g2',
            state: 'idle',
            continuationGeneration: 2,
          },
        ],
      } as never;
      fixture.coordinator.activitySettled('s', 'rootFinalAttempt');
      await fixture.runNext();
      await vi.waitFor(() => expect(fixture.interrupt).toHaveBeenCalledWith('s', 'thread-l1'));
      expect(fixture.state?.executor).toMatchObject({
        threadId: 'thread-l1-g2',
        taskPath: '/root/l1_g2',
      });
      expect(fixture.refresh).toHaveBeenCalledWith('s');
      expect(fixture.resume).not.toHaveBeenCalled();
    });

    it('persists a disconnected newest generation and never resumes the idle old owner', async () => {
      const fixture = subject();
      fixture.activity = {
        ...fixture.activity,
        subagents: [
          { ...fixture.activity.subagents[0]!, state: 'idle', continuationGeneration: 1 },
          {
            ...fixture.activity.subagents[0]!,
            id: 'thread-l1-g2',
            threadId: 'thread-l1-g2',
            taskPath: '/root/l1_g2',
            state: 'disconnected',
            continuationGeneration: 2,
          },
        ],
      } as never;
      fixture.coordinator.activitySettled('s', 'rootFinalAttempt');
      await fixture.runNext();
      await vi.waitFor(() => expect(fixture.refresh).toHaveBeenCalledWith('s'));
      expect(fixture.state?.executor).toMatchObject({
        threadId: 'thread-l1-g2',
        taskPath: '/root/l1_g2',
        continuationGeneration: 2,
      });
      expect(fixture.resume).not.toHaveBeenCalled();
    });

    it.each(['stale roster', 'incomplete competing metadata'])(
      'fences continuation for %s',
      async (kind) => {
        const fixture = subject();
        fixture.activity = {
          ...fixture.activity,
          ...(kind === 'stale roster'
            ? { confidence: 'stale' }
            : {
                subagents: [
                  fixture.activity.subagents[0]!,
                  { ...fixture.activity.subagents[0]!, id: 'unknown-peer', threadId: undefined },
                ],
              }),
        } as never;
        fixture.coordinator.activitySettled('s', 'rootFinalAttempt');
        await fixture.runNext();
        expect(fixture.resume).not.toHaveBeenCalled();
      },
    );

    it.each(['two working', 'old owned process', 'reordered activity'])(
      'chooses the newest durable generation deterministically for %s',
      async (kind) => {
        const fixture = subject();
        const old = {
          ...fixture.activity.subagents[0]!,
          state: kind === 'old owned process' ? 'idle' : 'working',
          continuationGeneration: 1,
          ...(kind === 'old owned process'
            ? {
                ownedProcesses: [
                  {
                    processId: 'p',
                    itemId: 'i',
                    ownerThreadId: 'thread-l1',
                    ownerTaskPath: '/root/l1',
                    ownership: 'executor' as const,
                    state: 'running' as const,
                    observedAt: now,
                    elapsedMs: 0,
                    cpuPercent: 0,
                    rssBytes: 0,
                  },
                ],
              }
            : {}),
        };
        const newest = {
          ...old,
          id: 'new',
          threadId: 'new',
          taskPath: '/root/l1_g2',
          state: 'working' as const,
          continuationGeneration: 2,
          ownedProcesses: [],
        };
        fixture.activity = {
          ...fixture.activity,
          subagents: kind === 'reordered activity' ? [newest, old] : [old, newest],
        } as never;
        fixture.coordinator.activitySettled('s', 'rootFinalAttempt');
        await fixture.runNext();
        await vi.waitFor(() => expect(fixture.interrupt).toHaveBeenCalledWith('s', 'thread-l1'));
        expect(fixture.resume).not.toHaveBeenCalled();
      },
    );

    it.each([false, true])(
      'persists the same owner when equal-generation activity is reordered: %s',
      async (reversed) => {
        const fixture = subject();
        const a = {
          ...fixture.activity.subagents[0]!,
          id: 'a',
          threadId: 'a',
          continuationGeneration: 1,
        };
        const b = {
          ...fixture.activity.subagents[0]!,
          id: 'b',
          threadId: 'b',
          taskPath: '/root/l1-peer',
          continuationGeneration: 1,
        };
        fixture.activity = { ...fixture.activity, subagents: reversed ? [b, a] : [a, b] } as never;
        fixture.coordinator.activitySettled('s', 'rootFinalAttempt');
        await fixture.runNext();
        expect(fixture.state?.executor?.threadId).toBe('a');
      },
    );

    it('resumes only after a fresh roster converges to the durable owner', async () => {
      const fixture = subject();
      const old = { ...fixture.activity.subagents[0]!, state: 'working' as const };
      const owner = {
        ...old,
        id: 'new',
        threadId: 'new',
        taskPath: '/root/l1_g2',
        state: 'idle' as const,
        continuationGeneration: 2,
      };
      fixture.activity = { ...fixture.activity, subagents: [old, owner] } as never;
      fixture.coordinator.activitySettled('s', 'rootFinalAttempt');
      await fixture.runNext();
      expect(fixture.resume).not.toHaveBeenCalled();
      fixture.activity = { ...fixture.activity, subagents: [owner] } as never;
      fixture.coordinator.activitySettled('s', 'rootFinalAttempt');
      await fixture.runNext();
      await fixture.runNext();
      expect(fixture.resume).toHaveBeenCalledWith('s', 'new', 3, { kind: 'partial' });
    });

    it('recovers a transiently unloaded executor without replacing its physical generation', async () => {
      const fixture = subject([], 'partial', 'WIP', 2);
      fixture.resume.mockRejectedValueOnce(new Error('AUTOPILOT_EXECUTOR_UNAVAILABLE'));
      fixture.coordinator.activitySettled('s', 'rootFinalAttempt');
      await fixture.runNext();
      await fixture.runNext();
      expect(fixture.state?.executor).toMatchObject({ threadId: 'thread-l1', resumeFailures: 1 });
      expect(fixture.state?.executor?.replacement).toBeUndefined();
      fixture.coordinator.activitySettled('s', 'rootFinalAttempt');
      await fixture.runNext();
      await fixture.runNext();
      await fixture.runNext();
      expect(fixture.resume).toHaveBeenCalledTimes(2);
      expect(fixture.state?.executor?.resumeFailures).toBe(1);
      expect(fixture.rootStart).not.toHaveBeenCalled();
    });

    it('schedules one fenced root-owned replacement after an exhausted missing executor', async () => {
      const fixture = subject([], 'partial', 'WIP', 1);
      fixture.resume.mockRejectedValue(new Error('AUTOPILOT_EXECUTOR_UNAVAILABLE'));
      fixture.coordinator.activitySettled('s', 'rootFinalAttempt');
      await fixture.runNext();
      await fixture.runNext();
      expect(fixture.state?.executor).toMatchObject({
        outcome: 'failed',
        replacement: {
          canonicalPosition: 'L1',
          canonicalTaskName: 'l1',
          generation: 2,
          taskName: 'l1_g2',
          planIdentity: 'p',
        },
      });
      expect(fixture.resume).toHaveBeenCalledOnce();
      await fixture.runNext();
      expect(fixture.rootStart).toHaveBeenCalledWith(
        's',
        'root-control',
        1,
        expect.objectContaining({ taskName: 'l1_g2', generation: 2 }),
      );
      expect(fixture.resume).toHaveBeenCalledOnce();
      fixture.activity = {
        ...fixture.activity,
        subagents: [
          {
            ...fixture.activity.subagents[0]!,
            id: 'thread-l1-g2',
            threadId: 'thread-l1-g2',
            taskPath: '/root/l1_g2',
            continuationGeneration: 2,
          },
        ],
      } as never;
      fixture.coordinator.activitySettled('s', 'rootFinalAttempt');
      await fixture.runNext();
      expect(fixture.state?.executor).toMatchObject({
        threadId: 'thread-l1-g2',
        continuationGeneration: 2,
      });
      expect(fixture.state?.executor?.replacement).toBeUndefined();
      expect(fixture.rootStart).toHaveBeenCalledOnce();
    });

    it('supersedes a pending replacement when its plan advances before root start', async () => {
      const fixture = subject([], 'partial', 'WIP', 1);
      fixture.resume.mockRejectedValue(new Error('AUTOPILOT_EXECUTOR_UNAVAILABLE'));
      fixture.coordinator.activitySettled('s', 'rootFinalAttempt');
      await fixture.runNext();
      await fixture.runNext();
      fixture.planIdentity = 'advanced';
      await fixture.runNext();
      expect(fixture.rootStart).not.toHaveBeenCalled();
      expect(fixture.state?.executor?.replacement).toBeUndefined();
      expect(fixture.state?.lastControlId).toBeNull();
    });

    it('retains the reconciled owner across SQLite restart until the roster converges', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'gestalt-split-brain-restart-'));
      const path = join(directory, 'relay.sqlite');
      const timers: Array<{ callback: () => void; cancelled: boolean; fired: boolean }> = [];
      const resume = vi.fn(async () => undefined);
      const interrupt = vi.fn(async () => true);
      const refresh = vi.fn(async () => undefined);
      const old = {
        id: 'old',
        threadId: 'old',
        taskPath: '/root/l1',
        canonicalTaskName: 'l1',
        canonicalPosition: 'L1',
        continuationGeneration: 1,
        outcome: 'partial' as const,
        ownedProcesses: [],
        state: 'working' as const,
        reason: 'turnCompleted' as const,
        observedAt: now,
        lastActivityAt: now,
      };
      const owner = {
        ...old,
        id: 'new',
        threadId: 'new',
        taskPath: '/root/l1_g2',
        continuationGeneration: 2,
        state: 'idle' as const,
      };
      let activity: import('../../agent-activity/model.js').AgentActivitySnapshot = {
        ...createAgentActivitySnapshot('s', now),
        confidence: 'fresh' as const,
        root: { ...createAgentActivitySnapshot('s', now).root, state: 'idle' as const },
        aggregateSubagents: 'working' as const,
        subagents: [old, owner],
      };
      const coordinator = (database: DatabaseSync) =>
        new AutopilotCoordinator({
          store: new SqliteAutopilotStore(database),
          now: () => now,
          policy: {
            ...defaultAutopilotPolicy,
            quiescenceMs: 0,
            executorContinuationBaseMs: 0,
            executorContinuationMaxMs: 0,
          },
          plan: () => ({ plan, identity: 'p' }),
          session: () => ({ state: 'ready', threadId: 'root', activeTurnId: null }),
          activity: () => activity,
          pendingInteraction: () => false,
          reconcile: async () => ({ compatible: true }),
          schedule: (callback) => {
            const timer = { callback, cancelled: false, fired: false };
            timers.push(timer);
            return () => {
              timer.cancelled = true;
            };
          },
          nextControlId: () => 'unused',
          turnStarter: { start: async () => {} },
          executorController: {
            resume,
            refresh,
            interrupt,
            transferProcess: () => {},
            consumeProcess: () => {},
            terminateProcess: async () => false,
          },
          publish: () => {},
        });
      const fireNext = async () => {
        const timer = timers.find((candidate) => !candidate.cancelled && !candidate.fired);
        expect(timer).toBeDefined();
        timer!.fired = true;
        timer!.callback();
        await Promise.resolve();
        await Promise.resolve();
      };
      const persisted: AutopilotSession = {
        sessionId: 's',
        state: 'monitoring',
        requestedEnabled: true,
        planIdentity: 'p',
        planFingerprint: 'f',
        generation: 1,
        consecutiveNoProgress: 0,
        nextEvaluationAt: null,
        lastControlId: null,
        stopReason: null,
        updatedAt: now,
      };
      try {
        const first = new DatabaseSync(path);
        migrate(first);
        first
          .prepare(
            "INSERT INTO relay_sessions (id,workspace_id,workspace_path,profile,state,desired_state,failure_count,next_sequence,created_at,updated_at) VALUES ('s','w','/w','p','ready','active',0,1,'t','t')",
          )
          .run();
        new SqliteAutopilotStore(first).save(persisted);
        const initial = coordinator(first);
        initial.activitySettled('s', 'rootFinalAttempt');
        await fireNext();
        await vi.waitFor(() => expect(interrupt).toHaveBeenCalledWith('s', 'old'));
        expect(new SqliteAutopilotStore(first).find('s')?.executor).toMatchObject({
          threadId: 'new',
          taskPath: '/root/l1_g2',
          continuationGeneration: 2,
        });
        expect(resume).not.toHaveBeenCalled();
        first.close();

        timers.length = 0;
        activity = { ...activity, subagents: [owner, old] };
        const reopened = new DatabaseSync(path);
        migrate(reopened);
        const restored = coordinator(reopened);
        restored.restore('s');
        restored.activitySettled('s', 'rootFinalAttempt');
        await fireNext();
        await vi.waitFor(() => expect(interrupt).toHaveBeenCalledTimes(2));
        expect(new SqliteAutopilotStore(reopened).find('s')?.executor).toMatchObject({
          threadId: 'new',
          taskPath: '/root/l1_g2',
          continuationGeneration: 2,
        });
        expect(resume).not.toHaveBeenCalled();

        activity = { ...activity, aggregateSubagents: 'idle', subagents: [owner] };
        restored.activitySettled('s', 'rootFinalAttempt');
        await fireNext();
        await fireNext();
        await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
        expect(resume).toHaveBeenCalledWith('s', 'new', 3, { kind: 'partial' });
        expect(refresh).toHaveBeenCalledTimes(2);
        reopened.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    it.each(['false', 'throw'] as const)(
      'keeps reconciliation fenced when interrupt returns %s',
      async (outcome) => {
        const fixture = subject();
        fixture.interrupt.mockImplementation(async () => {
          if (outcome === 'throw') throw new Error('lost writer');
          return false;
        });
        fixture.activity = {
          ...fixture.activity,
          subagents: [
            { ...fixture.activity.subagents[0]!, state: 'working' },
            {
              ...fixture.activity.subagents[0]!,
              id: 'new',
              threadId: 'new',
              taskPath: '/root/l1_g2',
              continuationGeneration: 2,
            },
          ],
        } as never;
        fixture.coordinator.activitySettled('s', 'rootFinalAttempt');
        await fixture.runNext();
        await vi.waitFor(() => expect(fixture.refresh).toHaveBeenCalled());
        expect(fixture.resume).not.toHaveBeenCalled();
      },
    );

    it('rearms scheduled executor commands once after SQLite restart but never replays issued ambiguity', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'gestalt-executor-command-restart-'));
      const path = join(directory, 'relay.sqlite');
      const executorPlan = {
        ...plan,
        steps: [
          {
            ...plan.steps[0]!,
            children: [
              {
                id: 'l1-1',
                title: 'child',
                level: 2 as const,
                state: 'WIP' as const,
                priority: 'A' as const,
                description: {},
                children: [],
              },
            ],
          },
        ],
      };
      const planFingerprint = '[["l1","WIP","UNREVIEWED",[["l1-1","WIP"]]]]';
      const commandId = createHash('sha256')
        .update(
          JSON.stringify(['p', planFingerprint, 'L1', 'l1', '/root/l1', 'thread-l1', 2, 'partial']),
        )
        .digest('hex');
      const stateFor = (status: 'scheduled' | 'issued'): AutopilotSession => ({
        sessionId: 's',
        state: 'monitoring',
        requestedEnabled: true,
        planIdentity: 'p',
        planFingerprint,
        generation: 1,
        consecutiveNoProgress: 0,
        nextEvaluationAt: null,
        lastControlId: null,
        stopReason: null,
        executor: {
          canonicalPosition: 'L1',
          canonicalTaskName: 'l1',
          taskPath: '/root/l1',
          threadId: 'thread-l1',
          l1State: 'WIP',
          l2State: 'WIP',
          lastActivityAt: now,
          ownedProcesses: [],
          outcome: 'partial',
          continuationGeneration: 1,
          continuationCount: 0,
          commands: [
            {
              commandId,
              status,
              planIdentity: 'p',
              planFingerprint,
              canonicalPosition: 'L1',
              canonicalTaskName: 'l1',
              taskPath: '/root/l1',
              threadId: 'thread-l1',
              generation: 2,
              trigger: 'partial',
              createdAt: now,
              updatedAt: now,
            },
          ],
        },
        updatedAt: now,
      });
      const timers: Array<{ callback: () => void; cancelled: boolean }> = [];
      const resume = vi.fn(async () => undefined);
      const coordinator = (database: DatabaseSync) =>
        new AutopilotCoordinator({
          store: new SqliteAutopilotStore(database),
          now: () => now,
          policy: { ...defaultAutopilotPolicy, executorContinuationBaseMs: 0 },
          plan: () => ({ plan: executorPlan, identity: 'p' }),
          session: () => ({ state: 'ready', threadId: 'root', activeTurnId: null }),
          activity: () => ({
            ...createAgentActivitySnapshot('s', now),
            confidence: 'fresh',
            root: { ...createAgentActivitySnapshot('s', now).root, state: 'idle' },
            subagents: [
              {
                id: 'thread-l1',
                threadId: 'thread-l1',
                taskPath: '/root/l1',
                canonicalTaskName: 'l1',
                canonicalPosition: 'L1',
                continuationGeneration: 1,
                outcome: 'partial',
                ownedProcesses: [],
                state: 'idle',
                reason: 'turnCompleted',
                observedAt: now,
                lastActivityAt: now,
              },
            ],
          }),
          pendingInteraction: () => false,
          reconcile: async () => ({ compatible: true }),
          schedule: (callback) => {
            const timer = { callback, cancelled: false };
            timers.push(timer);
            return () => {
              timer.cancelled = true;
            };
          },
          nextControlId: () => 'unused',
          turnStarter: { start: async () => {} },
          executorController: {
            resume,
            refresh: async () => {},
            interrupt: async () => false,
            transferProcess: () => {},
            consumeProcess: () => {},
            terminateProcess: async () => false,
          },
          publish: () => {},
        });
      try {
        const first = new DatabaseSync(path);
        migrate(first);
        first
          .prepare(
            "INSERT INTO relay_sessions (id,workspace_id,workspace_path,profile,state,desired_state,failure_count,next_sequence,created_at,updated_at) VALUES ('s','w','/w','p','ready','active',0,1,'t','t')",
          )
          .run();
        new SqliteAutopilotStore(first).save(stateFor('scheduled'));
        first.close();

        const reopened = new DatabaseSync(path);
        migrate(reopened);
        const restored = coordinator(reopened);
        restored.restore('s');
        restored.restore('s');
        await vi.waitFor(() => expect(timers.filter((timer) => !timer.cancelled)).toHaveLength(1));
        const scheduledTimer = timers.find((timer) => !timer.cancelled)!;
        scheduledTimer.callback();
        scheduledTimer.callback();
        await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
        expect(new SqliteAutopilotStore(reopened).find('s')?.executor?.commands?.[0]).toMatchObject(
          { status: 'accepted' },
        );
        reopened.close();

        const issue = new DatabaseSync(path);
        migrate(issue);
        new SqliteAutopilotStore(issue).save(stateFor('issued'));
        issue.close();
        timers.length = 0;
        const ambiguous = new DatabaseSync(path);
        migrate(ambiguous);
        coordinator(ambiguous).restore('s');
        await Promise.resolve();
        await Promise.resolve();
        expect(timers.filter((timer) => !timer.cancelled)).toHaveLength(0);
        expect(resume).toHaveBeenCalledTimes(1);
        expect(
          new SqliteAutopilotStore(ambiguous).find('s')?.executor?.commands?.[0],
        ).toMatchObject({ status: 'issued' });
        ambiguous.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    it.each(['scheduled', 'issued', 'started'] as const)(
      'keeps replacement root control %s fenced across a SQLite reopen',
      async (status) => {
        const directory = await mkdtemp(join(tmpdir(), 'gestalt-replacement-control-'));
        const path = join(directory, 'relay.sqlite');
        const timers: Array<{ callback: () => void; cancelled: boolean }> = [];
        const rootStart = vi.fn(async () => undefined);
        const replacement = {
          canonicalPosition: 'L1',
          canonicalTaskName: 'l1',
          taskName: 'l1_g2',
          generation: 2,
          planIdentity: 'p',
          planFingerprint: '[["l1","WIP","UNREVIEWED",[]]]',
        };
        const settledActivity = {
          ...createAgentActivitySnapshot('s', now),
          confidence: 'fresh' as const,
          root: {
            ...createAgentActivitySnapshot('s', now).root,
            state: 'idle' as const,
            reason: 'turnCompleted' as const,
          },
        };
        const state: AutopilotSession = {
          sessionId: 's',
          state: status === 'scheduled' ? 'backoff' : 'monitoring',
          requestedEnabled: true,
          planIdentity: 'p',
          planFingerprint: replacement.planFingerprint,
          generation: 1,
          consecutiveNoProgress: 0,
          nextEvaluationAt: status === 'scheduled' ? now : null,
          lastControlId: 'replacement-control',
          stopReason: null,
          updatedAt: now,
          executor: {
            canonicalPosition: 'L1',
            canonicalTaskName: 'l1',
            taskPath: '/root/l1',
            threadId: 'old',
            l1State: 'WIP',
            l2State: 'WIP',
            lastActivityAt: now,
            ownedProcesses: [],
            outcome: 'failed',
            continuationGeneration: 1,
            continuationCount: 0,
            replacement,
          },
        };
        try {
          const first = new DatabaseSync(path);
          migrate(first);
          first
            .prepare(
              "INSERT INTO relay_sessions (id,workspace_id,workspace_path,profile,state,desired_state,failure_count,next_sequence,created_at,updated_at) VALUES ('s','w','/w','p','ready','active',0,1,'t','t')",
            )
            .run();
          const store = new SqliteAutopilotStore(first);
          store.save(state);
          store.saveControl({
            sessionId: 's',
            controlId: 'replacement-control',
            status,
            createdAt: now,
            updatedAt: now,
            failureCode: null,
            ...(status === 'started' ? { turnId: 'turn-1' } : {}),
          });
          first.close();
          const reopened = new DatabaseSync(path);
          migrate(reopened);
          const coordinator = new AutopilotCoordinator({
            store: new SqliteAutopilotStore(reopened),
            now: () => now,
            policy: { ...defaultAutopilotPolicy, executorContinuationMaxMs: 0 },
            plan: () => ({ plan, identity: 'p' }),
            session: () => ({
              state: 'ready',
              threadId: 'root',
              activeTurnId: status === 'started' ? 'turn-1' : null,
            }),
            activity: () => settledActivity,
            pendingInteraction: () => false,
            reconcile: async () => ({ compatible: true }),
            schedule: (callback) => {
              const timer = { callback, cancelled: false };
              timers.push(timer);
              return () => {
                timer.cancelled = true;
              };
            },
            nextControlId: () => 'unexpected',
            turnStarter: { start: rootStart },
            publish: () => {},
          });
          coordinator.restore('s');
          coordinator.restore('s');
          if (status === 'scheduled') {
            const timer = timers.find((candidate) => !candidate.cancelled)!;
            timer.callback();
            timer.callback();
            await Promise.resolve();
            await Promise.resolve();
            await vi.waitFor(() => expect(rootStart).toHaveBeenCalledTimes(1));
            expect(rootStart).toHaveBeenCalledWith(
              's',
              'replacement-control',
              1,
              expect.objectContaining({ taskName: 'l1_g2', generation: 2 }),
            );
          } else {
            await Promise.resolve();
            await Promise.resolve();
            expect(rootStart).not.toHaveBeenCalled();
          }
          reopened.close();
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
    );

    it('keeps an adopted replacement owner durable across a SQLite reopen', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'gestalt-replacement-adopted-'));
      const path = join(directory, 'relay.sqlite');
      const rootStart = vi.fn(async () => undefined);
      const resume = vi.fn(async () => undefined);
      const schedule = vi.fn();
      const adopted = {
        canonicalPosition: 'L1',
        canonicalTaskName: 'l1',
        taskPath: '/root/l1_g2',
        threadId: 'thread-l1-g2',
        l1State: 'WIP' as const,
        l2State: 'WIP' as const,
        lastActivityAt: now,
        ownedProcesses: [],
        outcome: 'partial' as const,
        continuationGeneration: 2,
        continuationCount: 0,
      };
      const state: AutopilotSession = {
        sessionId: 's',
        state: 'monitoring',
        requestedEnabled: true,
        planIdentity: 'p',
        planFingerprint: '[["l1","WIP","UNREVIEWED",[]]]',
        generation: 1,
        consecutiveNoProgress: 0,
        nextEvaluationAt: null,
        lastControlId: 'replacement-control',
        stopReason: null,
        updatedAt: now,
        executor: adopted,
      };
      const adoptedActivity = {
        ...createAgentActivitySnapshot('s', now),
        confidence: 'fresh' as const,
        root: {
          ...createAgentActivitySnapshot('s', now).root,
          state: 'idle' as const,
          reason: 'turnCompleted' as const,
        },
        subagents: [
          {
            id: adopted.threadId,
            threadId: adopted.threadId,
            taskPath: adopted.taskPath,
            canonicalTaskName: 'l1',
            canonicalPosition: 'L1',
            continuationGeneration: 2,
            outcome: 'partial' as const,
            ownedProcesses: [],
            state: 'idle' as const,
            reason: 'turnCompleted' as const,
            observedAt: now,
            lastActivityAt: now,
          },
        ],
        aggregateSubagents: 'idle' as const,
      };
      try {
        const first = new DatabaseSync(path);
        migrate(first);
        first
          .prepare(
            "INSERT INTO relay_sessions (id,workspace_id,workspace_path,profile,state,desired_state,failure_count,next_sequence,created_at,updated_at) VALUES ('s','w','/w','p','ready','active',0,1,'t','t')",
          )
          .run();
        const store = new SqliteAutopilotStore(first);
        store.save(state);
        store.saveControl({
          sessionId: 's',
          controlId: 'replacement-control',
          status: 'started',
          createdAt: now,
          updatedAt: now,
          failureCode: null,
          turnId: 'turn-1',
        });
        first.close();

        const reopened = new DatabaseSync(path);
        migrate(reopened);
        const coordinator = new AutopilotCoordinator({
          store: new SqliteAutopilotStore(reopened),
          now: () => now,
          policy: { ...defaultAutopilotPolicy, executorContinuationMaxMs: 0 },
          plan: () => ({ plan, identity: 'p' }),
          session: () => ({ state: 'ready', threadId: 'root', activeTurnId: null }),
          activity: () => adoptedActivity,
          pendingInteraction: () => false,
          reconcile: async () => ({ compatible: true }),
          schedule: () => {
            schedule();
            return () => {};
          },
          nextControlId: () => 'unexpected',
          turnStarter: { start: rootStart },
          executorController: {
            resume,
            refresh: async () => {},
            interrupt: async () => false,
            transferProcess: () => {},
            consumeProcess: () => {},
            terminateProcess: async () => false,
          },
          publish: () => {},
        });
        coordinator.restore('s');
        coordinator.restore('s');
        await vi.waitFor(() => expect(schedule).toHaveBeenCalledTimes(1));
        await vi.waitFor(() =>
          expect(new SqliteAutopilotStore(reopened).find('s')?.executor).toMatchObject({
            threadId: adopted.threadId,
            taskPath: adopted.taskPath,
            continuationGeneration: 2,
          }),
        );
        const restored = new SqliteAutopilotStore(reopened).find('s')!;
        expect(restored.executor?.replacement).toBeUndefined();
        expect(rootStart).not.toHaveBeenCalled();
        expect(resume).not.toHaveBeenCalled();
        reopened.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    it('supersedes a durable executor command when its plan fence goes stale', async () => {
      const fixture = subject();
      fixture.coordinator.activitySettled('s', 'rootFinalAttempt');
      await fixture.runNext();
      fixture.planIdentity = 'replacement';
      const armed = fixture.timers.find((timer) => !timer.cancelled && !timer.fired)!;
      armed.fired = true;
      armed.callback();
      await vi.waitFor(() =>
        expect(fixture.state?.executor?.commands?.[0]).toMatchObject({ status: 'superseded' }),
      );
      expect(fixture.resume).not.toHaveBeenCalled();
    });

    it('supersedes a scheduled command before a plan revision cancels its timer', async () => {
      const fixture = subject();
      fixture.coordinator.activitySettled('s', 'rootFinalAttempt');
      await fixture.runNext();
      fixture.state = {
        ...fixture.state!,
        checkpoints: {
          protocolVersion: 1,
          planIdentity: 'p',
          completionEpochs: [
            {
              target: '["l2","l1","l1-1"]',
              epoch: 0,
              reopened: false,
              completed: true,
            },
          ],
          reportedL2Ids: ['["l1","l1-1"]'],
          reportedL1Ids: [],
          acceptedKeys: ['accepted'],
          pendingTurnId: null,
          pendingKind: null,
          terminalReviewAccepted: false,
        },
      };
      fixture.plan = {
        ...fixture.plan,
        steps: [
          {
            ...fixture.plan.steps[0]!,
            children: [{ ...fixture.plan.steps[0]!.children[0]!, state: 'TODO' as const }],
          },
        ],
      };
      fixture.coordinator.planStatusChanged('s');
      expect(fixture.state?.executor?.commands?.[0]).toMatchObject({ status: 'superseded' });
      expect(fixture.state?.checkpoints?.completionEpochs).toContainEqual({
        target: '["l2","l1","l1-1"]',
        epoch: 1,
        reopened: true,
        completed: false,
      });
      expect(fixture.resume).not.toHaveBeenCalled();
    });

    it('supersedes scheduled ownership before a plan-identity replacement cancels its timer', async () => {
      const fixture = subject();
      fixture.coordinator.activitySettled('s', 'rootFinalAttempt');
      await fixture.runNext();
      fixture.planIdentity = 'replacement';
      fixture.coordinator.planStatusChanged('s');
      expect(fixture.state?.executor?.commands?.[0]).toMatchObject({ status: 'superseded' });
      expect(fixture.resume).not.toHaveBeenCalled();
    });

    it.each(['disable', 'manualSend'] as const)(
      'makes a duplicate continuation delivery stale after %s',
      async (boundary) => {
        const fixture = subject();
        fixture.coordinator.activitySettled('s', 'rootFinalAttempt');
        await fixture.runNext();
        const armed = fixture.timers.find((timer) => !timer.cancelled && !timer.fired)!;
        if (boundary === 'disable') fixture.coordinator.disable('s');
        else fixture.coordinator.manualSend('s');
        armed.callback();
        await Promise.resolve();
        await Promise.resolve();
        expect(fixture.resume).not.toHaveBeenCalled();
        expect(fixture.state?.executor?.commands?.[0]).toMatchObject({ status: 'cancelled' });
      },
    );

    it.each(['arm', 'delivery'] as const)(
      'never resumes an executor while the root is active at %s',
      async (phase) => {
        const fixture = subject();
        if (phase === 'arm')
          fixture.session = { state: 'ready', threadId: 'root', activeTurnId: 'active-root-turn' };
        fixture.coordinator.activitySettled('s', 'rootFinalAttempt');
        await fixture.runNext();
        if (phase === 'delivery') {
          const armed = fixture.timers.find((timer) => !timer.cancelled && !timer.fired)!;
          fixture.session = { state: 'ready', threadId: 'root', activeTurnId: 'active-root-turn' };
          armed.callback();
          await vi.waitFor(() =>
            expect(
              fixture.published.filter((type) => type === 'autopilot.executor-continuation-stale'),
            ).toHaveLength(1),
          );
        }
        expect(fixture.resume).not.toHaveBeenCalled();
      },
    );

    it.each([
      {
        name: 'checkpoint persistence',
        kinds: ['continuation', 'refresh'] as const,
        apply: (fixture: ReturnType<typeof subject>) => {
          expect(
            fixture.coordinator.checkpointAccepted(
              's',
              {
                version: 1,
                kind: 'l2Completed',
                planIdentity: 'p',
                l1Id: 'l1',
                l2Id: 'l1-1',
                position: 'L1.1',
                status: 'DONE',
                changes: 'Persisted checkpoint.',
                files: 'src/checkpoint.ts',
                tests: 'Focused tests passed.',
              },
              'turn-checkpoint',
              now,
            ),
          ).toBe(true);
          fixture.coordinator.turnCompleted('s');
        },
      },
      {
        name: 'proactive wait registration',
        kinds: ['continuation', 'refresh'] as const,
        apply: (fixture: ReturnType<typeof subject>) => {
          const executorStillWorking = fixture.activity.subagents[0]?.ownedProcesses?.some(
            (process) => process.state === 'running' || process.state === 'detached-active',
          );
          expect(
            fixture.coordinator.registerProactiveWait('s', {
              id: 'wait-report',
              leaseId: 'wait-lease',
              wakeConditions: ['executorChanged'],
              maxWaitMs: 60_000,
            }),
          ).toBe(executorStillWorking ? true : 'wakeAlreadySatisfied');
        },
      },
      {
        name: 'manual intervention before a duplicate timer delivery',
        kinds: ['continuation', 'refresh'] as const,
        apply: (fixture: ReturnType<typeof subject>) => fixture.coordinator.manualSend('s'),
      },
      {
        name: 'plan fingerprint advance and reopen',
        kinds: ['continuation', 'refresh'] as const,
        apply: (fixture: ReturnType<typeof subject>) => {
          fixture.plan = {
            ...fixture.plan,
            steps: [{ ...fixture.plan.steps[0]!, state: 'TODO' as never }],
            currentStepId: undefined as never,
          };
          fixture.coordinator.planStatusChanged('s');
        },
      },
      {
        name: 'plan identity replacement',
        kinds: ['continuation', 'refresh'] as const,
        apply: (fixture: ReturnType<typeof subject>) => {
          fixture.planIdentity = 'replacement';
          fixture.coordinator.planStatusChanged('s');
        },
      },
      {
        name: 'structured attention',
        kinds: ['continuation', 'refresh'] as const,
        apply: (fixture: ReturnType<typeof subject>) => {
          fixture.attention = {
            reason: 'permissionRequired',
            resumeCondition: 'permissionGranted',
          };
          fixture.coordinator.evaluate('s');
        },
      },
      {
        name: 'terminal completion',
        kinds: ['continuation', 'refresh'] as const,
        apply: (fixture: ReturnType<typeof subject>) => {
          fixture.plan = { ...fixture.plan, allDone: true, executionComplete: true, doneSteps: 1 };
          fixture.coordinator.planStatusChanged('s');
        },
      },
      {
        name: 'an active root turn',
        kinds: ['continuation', 'refresh'] as const,
        apply: (fixture: ReturnType<typeof subject>) => {
          fixture.session = { state: 'ready', threadId: 'root', activeTurnId: 'active-root-turn' };
        },
      },
      {
        name: 'a pending interaction',
        kinds: ['continuation', 'refresh'] as const,
        apply: (fixture: ReturnType<typeof subject>) => {
          fixture.pending = true;
        },
      },
      {
        name: 'a session generation change',
        kinds: ['continuation', 'refresh'] as const,
        apply: (fixture: ReturnType<typeof subject>) => {
          fixture.state = { ...fixture.state!, generation: fixture.state!.generation + 1 };
        },
      },
      {
        name: 'a child thread or generation change',
        kinds: ['continuation', 'refresh'] as const,
        apply: (fixture: ReturnType<typeof subject>) => {
          fixture.activity = {
            ...fixture.activity,
            subagents: [
              {
                ...fixture.activity.subagents[0]!,
                threadId: 'replacement-thread',
                continuationGeneration: 2,
              },
            ],
          };
          fixture.coordinator.activityChanged('s');
        },
      },
    ])('L0/L# ordering matrix fences stale $name callbacks', async ({ kinds, apply }) => {
      for (const kind of kinds) {
        const fixture = subject(
          kind === 'refresh'
            ? [
                {
                  processId: 'process-1',
                  itemId: 'item-1',
                  ownerThreadId: 'thread-l1',
                  ownerTaskPath: '/root/l1',
                  ownership: 'executor',
                  state: 'running',
                  observedAt: now,
                  elapsedMs: 1_000,
                  cpuPercent: 1,
                  rssBytes: 1,
                },
              ]
            : [],
        );
        if (kind === 'refresh') {
          fixture.coordinator.turnCompleted('s');
          await fixture.runNext();
        } else {
          fixture.coordinator.activitySettled('s', 'rootFinalAttempt');
          await fixture.runNext();
        }
        const armed = fixture.timers.find((timer) => !timer.cancelled && !timer.fired)!;
        apply(fixture);
        armed.callback();
        await vi.waitFor(() =>
          expect(
            fixture.published.filter((type) => type === `autopilot.executor-${kind}-stale`),
          ).toHaveLength(1),
        );
        expect(fixture.resume).not.toHaveBeenCalled();
        expect(fixture.refresh).not.toHaveBeenCalled();
        expect(
          fixture.published.filter((type) => type === `autopilot.executor-${kind}-stale`),
        ).toHaveLength(1);
      }
    });

    it('delivers each armed callback once, then audits duplicate delivery without another external call', async () => {
      for (const kind of ['continuation', 'refresh'] as const) {
        const fixture = subject(
          kind === 'refresh'
            ? [
                {
                  processId: 'process-1',
                  itemId: 'item-1',
                  ownerThreadId: 'thread-l1',
                  ownerTaskPath: '/root/l1',
                  ownership: 'executor',
                  state: 'running',
                  observedAt: now,
                  elapsedMs: 1_000,
                  cpuPercent: 1,
                  rssBytes: 1,
                },
              ]
            : [],
        );
        if (kind === 'refresh') fixture.coordinator.turnCompleted('s');
        else fixture.coordinator.activitySettled('s', 'rootFinalAttempt');
        await fixture.runNext();
        const armed = await fixture.runNext();
        expect(kind === 'continuation' ? fixture.resume : fixture.refresh).toHaveBeenCalledTimes(1);
        armed.callback();
        expect(kind === 'continuation' ? fixture.resume : fixture.refresh).toHaveBeenCalledTimes(1);
        expect(
          fixture.published.filter((type) => type === `autopilot.executor-${kind}-stale`),
        ).toHaveLength(1);
      }
    });

    it('continues after an L2 checkpoint reaches DONE while its L1 remains WIP', async () => {
      const fixture = subject([], 'partial', 'DONE');
      fixture.coordinator.activitySettled('s', 'checkpoint');
      await fixture.runNext();
      await fixture.runNext();
      expect(fixture.resume).toHaveBeenCalledWith('s', 'thread-l1', 2, { kind: 'partial' });
      expect(fixture.state).toMatchObject({
        requestedEnabled: true,
        executor: { l1State: 'WIP' },
      });
    });

    it('transfers and conditionally monitors an active detached process', async () => {
      const fixture = subject([
        {
          processId: 'process-1',
          itemId: 'item-1',
          ownerThreadId: 'thread-l1',
          ownerTaskPath: '/root/l1',
          ownership: 'executor',
          state: 'running',
          observedAt: now,
          elapsedMs: 1_000,
          cpuPercent: 100,
          rssBytes: 1_024,
        },
      ]);
      fixture.coordinator.turnCompleted('s');
      await fixture.runNext();
      expect(fixture.transferProcess).toHaveBeenCalledWith(
        's',
        'thread-l1',
        'process-1',
        expect.any(String),
      );
      expect(fixture.resume).not.toHaveBeenCalled();
      await fixture.runNext();
      expect(fixture.refresh).toHaveBeenCalledWith('s');
    });

    it('consumes an exited artifact and then resumes the owning executor', async () => {
      const fixture = subject([
        {
          processId: 'process-1',
          itemId: 'item-1',
          ownerThreadId: 'thread-l1',
          ownerTaskPath: '/root/l1',
          ownership: 'supervisor',
          state: 'exited-awaiting-result',
          observedAt: now,
          elapsedMs: 2_000,
          cpuPercent: 0,
          rssBytes: 0,
          exitStatus: 0,
          resultArtifact: 'thread-l1:item-1',
        },
      ]);
      fixture.coordinator.turnCompleted('s');
      await fixture.runNext();
      expect(fixture.consumeProcess).toHaveBeenCalledWith(
        's',
        'thread-l1',
        'process-1',
        expect.any(String),
      );
      await fixture.runNext();
      expect(fixture.resume).toHaveBeenCalledWith('s', 'thread-l1', 2, {
        kind: 'processExited',
        processId: 'process-1',
        resultArtifact: 'thread-l1:item-1',
      });
    });

    it('consumes a result from the adopted replacement generation before resuming it', async () => {
      const fixture = subject();
      fixture.activity = {
        ...fixture.activity,
        subagents: [
          {
            ...fixture.activity.subagents[0]!,
            id: 'thread-l1-g2',
            threadId: 'thread-l1-g2',
            taskPath: '/root/l1_g2',
            continuationGeneration: 2,
            ownedProcesses: [
              {
                processId: 'replacement-result',
                itemId: 'item-1',
                ownerThreadId: 'thread-l1-g2',
                ownerTaskPath: '/root/l1_g2',
                ownership: 'supervisor',
                state: 'exited-awaiting-result',
                observedAt: now,
                elapsedMs: 1,
                cpuPercent: 0,
                rssBytes: 0,
                resultArtifact: 'thread-l1-g2:item-1',
              },
            ],
          },
        ],
      } as never;
      fixture.coordinator.turnCompleted('s');
      await fixture.runNext();
      expect(fixture.consumeProcess).toHaveBeenCalledWith(
        's',
        'thread-l1-g2',
        'replacement-result',
        expect.any(String),
      );
      await fixture.runNext();
      expect(fixture.resume).toHaveBeenCalledWith('s', 'thread-l1-g2', 3, {
        kind: 'processExited',
        processId: 'replacement-result',
        resultArtifact: 'thread-l1-g2:item-1',
      });
    });

    it('terminates only an over-budget process and resumes systematic diagnosis', async () => {
      const fixture = subject([
        {
          processId: 'process-large',
          itemId: 'item-large',
          ownerThreadId: 'thread-l1',
          ownerTaskPath: '/root/l1',
          ownership: 'supervisor',
          state: 'detached-active',
          observedAt: now,
          elapsedMs: 60_001,
          cpuPercent: 100,
          rssBytes: 13 * 1024 * 1024 * 1024,
        },
      ]);
      fixture.coordinator.turnCompleted('s');
      await fixture.runNext();
      expect(fixture.terminateProcess).toHaveBeenCalledWith(
        's',
        'thread-l1',
        'process-large',
        expect.any(String),
        { itemId: 'item-large' },
      );
      await fixture.runNext();
      expect(fixture.resume).toHaveBeenCalledWith('s', 'thread-l1', 2, {
        kind: 'processResourceLimit',
        processId: 'process-large',
      });
    });

    it('keeps a resource-limited process terminal through a duplicate stale observation', async () => {
      const fixture = subject([
        {
          processId: 'process-large',
          itemId: 'item-large',
          ownerThreadId: 'thread-l1',
          ownerTaskPath: '/root/l1',
          ownership: 'supervisor',
          state: 'detached-active',
          observedAt: now,
          elapsedMs: 60_001,
          cpuPercent: 100,
          rssBytes: 13 * 1024 * 1024 * 1024,
        },
      ]);
      fixture.coordinator.turnCompleted('s');
      await fixture.runNext();
      await vi.waitFor(() =>
        expect(fixture.state?.executor?.ownedProcesses[0]?.state).toBe('terminated-for-budget'),
      );
      fixture.coordinator.activitySettled('s', 'processObserved');
      const staleObservation = fixture.timers.at(-1)!;
      staleObservation.fired = true;
      staleObservation.callback();
      await vi.waitFor(() =>
        expect(fixture.state?.executor?.ownedProcesses[0]?.state).toBe('terminated-for-budget'),
      );
      expect(fixture.terminateProcess).toHaveBeenCalledOnce();
    });

    it.each([
      {
        kind: 'transfer',
        process: {
          processId: 'process-1',
          itemId: 'item-1',
          ownerThreadId: 'thread-l1',
          ownerTaskPath: '/root/l1',
          ownership: 'executor' as const,
          state: 'running' as const,
          observedAt: now,
          elapsedMs: 1_000,
          cpuPercent: 1,
          rssBytes: 1,
        },
      },
      {
        kind: 'consume',
        process: {
          processId: 'process-1',
          itemId: 'item-1',
          ownerThreadId: 'thread-l1',
          ownerTaskPath: '/root/l1',
          ownership: 'supervisor' as const,
          state: 'exited-awaiting-result' as const,
          observedAt: now,
          elapsedMs: 1_000,
          cpuPercent: 0,
          rssBytes: 0,
          resultArtifact: 'thread-l1:item-1',
        },
      },
      {
        kind: 'terminate',
        process: {
          processId: 'process-1',
          itemId: 'item-1',
          ownerThreadId: 'thread-l1',
          ownerTaskPath: '/root/l1',
          ownership: 'supervisor' as const,
          state: 'detached-active' as const,
          observedAt: now,
          elapsedMs: 60_001,
          cpuPercent: 1,
          rssBytes: 13 * 1024 * 1024 * 1024,
        },
      },
    ] as const)(
      'replays an issued $kind action with its same durable idempotency key after an external fault',
      async ({ kind, process }) => {
        const fixture = subject([process]);
        const action =
          kind === 'transfer'
            ? fixture.transferProcess
            : kind === 'consume'
              ? fixture.consumeProcess
              : fixture.terminateProcess;
        if (kind === 'terminate')
          fixture.terminateProcess
            .mockRejectedValueOnce(new Error('lost'))
            .mockResolvedValueOnce(true);
        else
          action.mockImplementationOnce(() => {
            throw new Error('lost');
          });

        fixture.coordinator.turnCompleted('s');
        await fixture.runNext();
        expect(action).toHaveBeenCalledTimes(1);
        expect(fixture.state?.executor?.commands?.at(-1)).toMatchObject({
          status: 'issued',
          processAction: { kind, processKey: expect.any(String) },
        });
        expect(
          fixture.published.filter((type) => type === 'autopilot.operation-failed'),
        ).toHaveLength(1);

        fixture.coordinator.turnCompleted('s');
        await fixture.runNext();
        expect(action).toHaveBeenCalledTimes(2);
        const actionIds = action.mock.calls.map((call) => call[3]);
        expect(new Set(actionIds).size).toBe(1);
        await vi.waitFor(() =>
          expect(
            fixture.state?.executor?.commands?.find(
              (command) => command.processAction?.kind === kind,
            )?.status,
          ).toBe('accepted'),
        );
      },
    );

    it.each(['transfer', 'consume'] as const)(
      'contains an asynchronously rejected %s action with the same durable fence',
      async (kind) => {
        const process =
          kind === 'transfer'
            ? {
                processId: 'process-1',
                itemId: 'item-1',
                ownerThreadId: 'thread-l1',
                ownerTaskPath: '/root/l1',
                ownership: 'executor' as const,
                state: 'running' as const,
                observedAt: now,
                elapsedMs: 1,
                cpuPercent: 1,
                rssBytes: 1,
              }
            : {
                processId: 'process-1',
                itemId: 'item-1',
                ownerThreadId: 'thread-l1',
                ownerTaskPath: '/root/l1',
                ownership: 'supervisor' as const,
                state: 'exited-awaiting-result' as const,
                observedAt: now,
                elapsedMs: 1,
                cpuPercent: 0,
                rssBytes: 0,
                resultArtifact: 'thread-l1:item-1',
              };
        const fixture = subject([process]);
        const action = kind === 'transfer' ? fixture.transferProcess : fixture.consumeProcess;
        action.mockRejectedValueOnce(new Error('async action lost'));
        fixture.coordinator.turnCompleted('s');
        await fixture.runNext();
        expect(action).toHaveBeenCalledOnce();
        expect(
          fixture.published.filter((type) => type === 'autopilot.operation-failed'),
        ).toHaveLength(1);
        expect(fixture.state?.executor?.commands?.at(-1)).toMatchObject({
          status: 'issued',
          processAction: { kind },
        });
      },
    );

    it('contains a synchronously rejected terminate action', async () => {
      const fixture = subject([
        {
          processId: 'process-1',
          itemId: 'item-1',
          ownerThreadId: 'thread-l1',
          ownerTaskPath: '/root/l1',
          ownership: 'supervisor',
          state: 'detached-active',
          observedAt: now,
          elapsedMs: 60_001,
          cpuPercent: 1,
          rssBytes: 13 * 1024 * 1024 * 1024,
        },
      ]);
      fixture.terminateProcess.mockImplementationOnce(() => {
        throw new Error('terminate lost');
      });
      fixture.coordinator.turnCompleted('s');
      await fixture.runNext();
      expect(fixture.terminateProcess).toHaveBeenCalledOnce();
      expect(
        fixture.published.filter((type) => type === 'autopilot.operation-failed'),
      ).toHaveLength(1);
      expect(fixture.state?.executor?.commands?.at(-1)).toMatchObject({
        status: 'issued',
        processAction: { kind: 'terminate' },
      });
    });

    it.each([
      {
        kind: 'transfer' as const,
        process: {
          processId: 'process-1',
          itemId: 'item-1',
          ownerThreadId: 'thread-l1',
          ownerTaskPath: '/root/l1',
          ownership: 'executor' as const,
          state: 'running' as const,
          observedAt: now,
          elapsedMs: 1,
          cpuPercent: 1,
          rssBytes: 1,
        },
      },
      {
        kind: 'consume' as const,
        process: {
          processId: 'process-1',
          itemId: 'item-1',
          ownerThreadId: 'thread-l1',
          ownerTaskPath: '/root/l1',
          ownership: 'supervisor' as const,
          state: 'exited-awaiting-result' as const,
          observedAt: now,
          elapsedMs: 1,
          cpuPercent: 0,
          rssBytes: 0,
          resultArtifact: 'thread-l1:item-1',
        },
      },
      {
        kind: 'terminate' as const,
        process: {
          processId: 'process-1',
          itemId: 'item-1',
          ownerThreadId: 'thread-l1',
          ownerTaskPath: '/root/l1',
          ownership: 'supervisor' as const,
          state: 'detached-active' as const,
          observedAt: now,
          elapsedMs: 60_001,
          cpuPercent: 1,
          rssBytes: 13 * 1024 * 1024 * 1024,
        },
      },
    ] as const)(
      'replays an issued $kind process action exactly once with its stable id after a SQLite reopen',
      async ({ kind, process }) => {
        const directory = await mkdtemp(join(tmpdir(), 'gestalt-process-action-restart-'));
        const path = join(directory, 'relay.sqlite');
        const processKey = JSON.stringify([
          process.ownerThreadId,
          process.ownerTaskPath,
          process.processId,
          process.itemId,
          null,
        ]);
        const planFingerprint = '[["l1","WIP","UNREVIEWED",[["l1-1","WIP"]]]]';
        const commandId = createHash('sha256')
          .update(
            JSON.stringify([
              'p',
              planFingerprint,
              'L1',
              'l1',
              '/root/l1',
              'thread-l1',
              1,
              kind,
              processKey,
            ]),
          )
          .digest('hex');
        const action = vi.fn(async (actionId: string) => {
          void actionId;
          return true;
        });
        const timers: Array<{ callback: () => void; cancelled: boolean }> = [];
        const executorPlan = {
          ...plan,
          steps: [
            {
              ...plan.steps[0]!,
              children: [
                {
                  id: 'l1-1',
                  title: 'child',
                  level: 2 as const,
                  state: 'WIP' as const,
                  priority: 'A' as const,
                  description: {},
                  children: [],
                },
              ],
            },
          ],
        };
        const state: AutopilotSession = {
          sessionId: 's',
          state: 'monitoring',
          requestedEnabled: true,
          planIdentity: 'p',
          planFingerprint,
          generation: 1,
          consecutiveNoProgress: 0,
          nextEvaluationAt: null,
          lastControlId: null,
          stopReason: null,
          updatedAt: now,
          executor: {
            canonicalPosition: 'L1',
            canonicalTaskName: 'l1',
            taskPath: '/root/l1',
            threadId: 'thread-l1',
            l1State: 'WIP',
            l2State: 'WIP',
            lastActivityAt: now,
            ownedProcesses: [process],
            outcome: 'partial',
            continuationGeneration: 1,
            continuationCount: 0,
            commands: [
              {
                commandId,
                status: 'issued',
                planIdentity: 'p',
                planFingerprint,
                canonicalPosition: 'L1',
                canonicalTaskName: 'l1',
                taskPath: '/root/l1',
                threadId: 'thread-l1',
                generation: 1,
                trigger: 'partial',
                processAction: { kind, processKey },
                createdAt: now,
                updatedAt: now,
              },
            ],
          },
        };
        try {
          const first = new DatabaseSync(path);
          migrate(first);
          first
            .prepare(
              "INSERT INTO relay_sessions (id,workspace_id,workspace_path,profile,state,desired_state,failure_count,next_sequence,created_at,updated_at) VALUES ('s','w','/w','p','ready','active',0,1,'t','t')",
            )
            .run();
          new SqliteAutopilotStore(first).save(state);
          first.close();

          const reopened = new DatabaseSync(path);
          migrate(reopened);
          const coordinator = new AutopilotCoordinator({
            store: new SqliteAutopilotStore(reopened),
            now: () => now,
            policy: {
              ...defaultAutopilotPolicy,
              quiescenceMs: 0,
              processPollMs: 0,
              processMaxElapsedMs: 60_000,
              processMaxRssBytes: 12 * 1024 * 1024 * 1024,
            },
            plan: () => ({ plan: executorPlan, identity: 'p' }),
            session: () => ({ state: 'ready', threadId: 'root', activeTurnId: null }),
            activity: () => ({
              ...createAgentActivitySnapshot('s', now),
              confidence: 'fresh',
              root: { ...createAgentActivitySnapshot('s', now).root, state: 'idle' },
              aggregateSubagents: 'idle',
              subagents: [
                {
                  id: 'thread-l1',
                  threadId: 'thread-l1',
                  taskPath: '/root/l1',
                  canonicalTaskName: 'l1',
                  canonicalPosition: 'L1',
                  continuationGeneration: 1,
                  outcome: 'partial',
                  ownedProcesses: [process],
                  state: 'idle',
                  reason: 'turnCompleted',
                  observedAt: now,
                  lastActivityAt: now,
                },
              ],
            }),
            pendingInteraction: () => false,
            reconcile: async () => ({ compatible: true }),
            schedule: (callback) => {
              const timer = { callback, cancelled: false };
              timers.push(timer);
              return () => {
                timer.cancelled = true;
              };
            },
            nextControlId: () => 'unused',
            turnStarter: { start: async () => {} },
            executorController: {
              resume: async () => {},
              refresh: async () => {},
              interrupt: async () => false,
              transferProcess: (_sessionId, _threadId, _processId, actionId) => {
                action(actionId);
              },
              consumeProcess: (_sessionId, _threadId, _processId, actionId) => {
                action(actionId);
              },
              terminateProcess: async (_sessionId, _threadId, _processId, actionId) => {
                action(actionId);
                return true;
              },
            },
            publish: () => {},
          });
          coordinator.restore('s');
          coordinator.turnCompleted('s');
          const timer = timers.find((candidate) => !candidate.cancelled)!;
          timer.callback();
          await vi.waitFor(() => expect(action).toHaveBeenCalledTimes(1));
          expect(action).toHaveBeenCalledWith(commandId);
          await vi.waitFor(() =>
            expect(
              new SqliteAutopilotStore(reopened)
                .find('s')
                ?.executor?.commands?.find((command) => command.commandId === commandId)?.status,
            ).toBe('accepted'),
          );
          reopened.close();
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
    );

    it('does not apply a late process action to a replacement generation with a reused process id', async () => {
      const fixture = subject([
        {
          processId: 'reused',
          itemId: 'old-item',
          ownerThreadId: 'thread-l1',
          ownerTaskPath: '/root/l1',
          ownership: 'supervisor',
          state: 'exited-awaiting-result',
          observedAt: now,
          elapsedMs: 1,
          cpuPercent: 0,
          rssBytes: 0,
          resultArtifact: 'thread-l1:old-item',
        },
      ]);
      fixture.consumeProcess.mockImplementationOnce(() => {
        fixture.activity = {
          ...fixture.activity,
          subagents: [
            {
              ...fixture.activity.subagents[0]!,
              threadId: 'thread-l1-g2',
              taskPath: '/root/l1_g2',
              continuationGeneration: 2,
              ownedProcesses: [
                {
                  processId: 'reused',
                  itemId: 'new-item',
                  ownerThreadId: 'thread-l1-g2',
                  ownerTaskPath: '/root/l1_g2',
                  ownership: 'supervisor',
                  state: 'exited-awaiting-result',
                  observedAt: now,
                  elapsedMs: 1,
                  cpuPercent: 0,
                  rssBytes: 0,
                  resultArtifact: 'thread-l1-g2:new-item',
                },
              ],
            },
          ],
        } as never;
      });
      fixture.coordinator.turnCompleted('s');
      await fixture.runNext();
      expect(fixture.state?.executor?.commands?.at(-1)).toMatchObject({ status: 'superseded' });
      expect(fixture.state?.executor?.continuationGeneration).toBe(1);
      expect(fixture.resume).not.toHaveBeenCalled();
    });

    it('launches a fresh physical generation for a failed historical canonical executor', async () => {
      const fixture = subject([], 'failed');
      fixture.coordinator.turnCompleted('s');
      await fixture.runNext();
      await fixture.runNext();
      expect(fixture.rootStart).toHaveBeenCalledWith(
        's',
        'root-control',
        1,
        expect.objectContaining({
          canonicalPosition: 'L1',
          canonicalTaskName: 'l1',
          generation: 2,
          taskName: 'l1_g2',
        }),
      );
      expect(fixture.resume).not.toHaveBeenCalled();
    });

    it('rearms an interrupted replacement root turn with the same physical generation', async () => {
      const fixture = subject([], 'failed');
      fixture.rootStart.mockRejectedValueOnce(new Error('root writer interrupted'));
      fixture.coordinator.turnCompleted('s');
      await fixture.runNext();
      await fixture.runNext();
      await vi.waitFor(() => expect(fixture.rootStart).toHaveBeenCalledOnce());
      // The failed root start never adopted an owner, so retrying must retain
      // the durable g2 identity rather than manufacturing g3.
      fixture.coordinator.evaluate('s');
      await fixture.runNext();
      await vi.waitFor(() => expect(fixture.rootStart).toHaveBeenCalledTimes(2));
      expect(
        fixture.rootStart.mock.calls.map(
          (call) => (call as unknown as [string, string, number, unknown])[3],
        ),
      ).toEqual([
        expect.objectContaining({ taskName: 'l1_g2', generation: 2 }),
        expect.objectContaining({ taskName: 'l1_g2', generation: 2 }),
      ]);
    });
  });
  it('does not publish an autopilot update for a timestamp-only persistence change', () => {
    let state: AutopilotSession | null = null;
    const events: string[] = [];
    const coordinator = new AutopilotCoordinator({
      store: {
        find: () => state,
        save: (next) => {
          state = next;
        },
        remove: () => {},
        findControl: () => null,
        saveControl: () => {},
        controlIds: () => new Set(),
      },
      now: () => now,
      policy: defaultAutopilotPolicy,
      plan: () => ({ plan, identity: 'p' }),
      session: () => ({ state: 'ready', threadId: 't', activeTurnId: null }),
      activity: () => ({
        ...createAgentActivitySnapshot('s', now),
        confidence: 'fresh',
        root: { ...createAgentActivitySnapshot('s', now).root, state: 'idle' },
      }),
      pendingInteraction: () => false,
      reconcile: async () => ({ compatible: true }),
      schedule: () => () => {},
      nextControlId: () => 'next',
      turnStarter: { start: async () => {} },
      publish: (_id, type) => events.push(type),
    });
    coordinator.enable('s');
    const published = events.filter((type) => type === 'autopilot.updated').length;
    coordinator.enable('s');
    expect(events.filter((type) => type === 'autopilot.updated')).toHaveLength(published);
  });
  it('does not schedule duplicate active observations and tears down callbacks', () => {
    let state: AutopilotSession | null = {
      sessionId: 's',
      state: 'monitoring',
      requestedEnabled: true,
      planIdentity: 'p',
      planFingerprint: 'f',
      generation: 1,
      consecutiveNoProgress: 0,
      nextEvaluationAt: null,
      lastControlId: null,
      stopReason: null,
      updatedAt: now,
    };
    let cancellations = 0;
    const active = {
      ...createAgentActivitySnapshot('s', now),
      confidence: 'fresh' as const,
      root: {
        ...createAgentActivitySnapshot('s', now).root,
        state: 'working' as const,
        lastActivityAt: now,
      },
    };
    const coordinator = new AutopilotCoordinator({
      store: {
        find: () => state,
        save: (next) => {
          state = next;
        },
        remove: () => {},
        findControl: () => null,
        saveControl: () => {},
        controlIds: () => new Set(),
      },
      now: () => now,
      policy: defaultAutopilotPolicy,
      plan: () => ({ plan, identity: 'p' }),
      session: () => ({ state: 'ready', threadId: 't', activeTurnId: null }),
      activity: () => active,
      pendingInteraction: () => false,
      reconcile: async () => ({ compatible: true }),
      schedule: () => () => {
        cancellations += 1;
      },
      nextControlId: () => 'next',
      turnStarter: { start: async () => {} },
      publish: () => {},
    });
    coordinator.activityChanged('s');
    coordinator.activityChanged('s');
    expect(state).toMatchObject({ state: 'monitoring', requestedEnabled: true });
    coordinator.dispose('s');
    expect(cancellations).toBe(0);
  });
});
