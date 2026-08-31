/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
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
        activity: () => null,
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
        set identity(value: string) {
          identity = value;
        },
        set plan(value: typeof plan) {
          currentPlan = value;
        },
        set session(value: typeof session) {
          session = value;
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

    it('does not arm a completed plan', () => {
      const fixture = subject();
      fixture.plan = { ...plan, executionComplete: true, allDone: true, doneSteps: 1 };

      expect(fixture.coordinator.supervisionStarted('s')).toEqual({
        code: 'AUTOPILOT_PLAN_COMPLETE',
      });
      expect(fixture.state).toBeNull();
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
    'does not recurse when compatible reconciliation leaves %s stale',
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
      expect(schedules).toBe(0);
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
    });
    expect(control.status).toBe('cancelled');
  });
  it('ignores ordinary updates within the retained incomplete plan', () => {
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

    expect(state).toBe(initial);
    expect(schedule).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
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
      const transferProcess = vi.fn();
      const consumeProcess = vi.fn();
      const terminateProcess = vi.fn(async () => true);
      const rootStart = vi.fn(async () => undefined);
      const controls = new Map<string, import('./ports.js').AutopilotControl>();
      const activity = {
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
        },
        plan: () => ({
          plan: {
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
          },
          identity: 'p',
        }),
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
        nextControlId: () => 'root-control',
        turnStarter: { start: rootStart },
        executorController: {
          resume,
          refresh,
          transferProcess,
          consumeProcess,
          terminateProcess,
        },
        publish: () => {},
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
      };
      return {
        coordinator,
        runNext,
        resume,
        refresh,
        transferProcess,
        consumeProcess,
        terminateProcess,
        rootStart,
        get state() {
          return state;
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
      expect(fixture.transferProcess).toHaveBeenCalledWith('s', 'thread-l1', 'process-1');
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
      expect(fixture.consumeProcess).toHaveBeenCalledWith('s', 'thread-l1', 'process-1');
      await fixture.runNext();
      expect(fixture.resume).toHaveBeenCalledWith('s', 'thread-l1', 2, {
        kind: 'processExited',
        processId: 'process-1',
        resultArtifact: 'thread-l1:item-1',
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
      expect(fixture.terminateProcess).toHaveBeenCalledWith('s', 'thread-l1', 'process-large');
      await fixture.runNext();
      expect(fixture.resume).toHaveBeenCalledWith('s', 'thread-l1', 2, {
        kind: 'processResourceLimit',
        processId: 'process-large',
      });
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
