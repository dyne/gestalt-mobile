/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { describe, expect, it, vi } from 'vitest';
import { AutopilotCoordinator } from './service.js';
import { defaultAutopilotPolicy } from './policy.js';
import { createAgentActivitySnapshot } from '../../agent-activity/model.js';
import type { AutopilotSession } from '../domain/autopilot-session.js';

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
      nextControlId: () => 'activity-control',
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
    expect(controls.size).toBe(1);
    expect(controls.get('s:activity-control')?.status).toBe('started');
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
    expect(state).toMatchObject({ state: 'attentionRequired', stopReason: 'reconcileFailed' });
  });
  it('turns a typed unavailable starter failure into durable attention without retrying', async () => {
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
    expect(state).toMatchObject({ state: 'attentionRequired', stopReason: 'attentionRequired' });
    expect(controls.get('s:c')).toMatchObject({
      status: 'failed',
      failureCode: 'START_UNAVAILABLE',
    });
    expect(events.find((event) => event.type === 'autopilot.turn-failed')).toMatchObject({
      payload: { controlId: 'c', code: 'START_UNAVAILABLE' },
    });
  });
  it('classifies a missing runtime writer as immediate human attention rather than retrying', async () => {
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
    expect(state).toMatchObject({ state: 'attentionRequired', stopReason: 'attentionRequired' });
    expect(controls.get('s:writer-control')).toMatchObject({
      status: 'failed',
      failureCode: 'START_UNAVAILABLE',
    });
  });
  it('does not recurse when compatible reconciliation leaves activity stale', async () => {
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
      activity: () => null,
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
  });
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
    let timerCancelled = false;
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
  it('stops once when fresh actor status requires human attention without a stored interaction', () => {
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
      state: 'attentionRequired',
      requestedEnabled: false,
      stopReason: 'attentionRequired',
      generation: 2,
    });
    expect(events.filter((type) => type === 'autopilot.updated')).toHaveLength(1);
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
});
