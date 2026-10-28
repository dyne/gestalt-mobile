/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqliteEventJournal } from '../../../platform/persistence/sqlite-event-journal.js';
import { migrate } from '../../../platform/persistence/migrate.js';
import { SqliteAutopilotStore } from '../../../platform/persistence/sqlite-autopilot-store.js';
import { createAgentActivitySnapshot } from '../../agent-activity/model.js';
import { AutopilotCoordinator } from './service.js';
import { defaultAutopilotPolicy } from './policy.js';

describe('continuation deadline across reconciliation', () => {
  afterEach(() => vi.useRealTimers());

  function fixture(
    pendingProcessResult?: (sessionId: string) => boolean,
    rootState: 'idle' | 'working' = 'idle',
    processResultState?: (sessionId: string, runId: string) => 'running' | 'completed' | 'missing',
  ) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-18T05:59:19.000Z'));
    const database = new DatabaseSync(':memory:');
    migrate(database);
    database.exec(
      "INSERT INTO relay_sessions (id,workspace_id,workspace_path,profile,state,desired_state,failure_count,next_sequence,created_at,updated_at) VALUES ('s','w','/w','p','ready','active',0,1,'t','t')",
    );
    const store = new SqliteAutopilotStore(database);
    const journal = new SqliteEventJournal(database);
    const now = () => new Date().toISOString();
    const base = createAgentActivitySnapshot('s', now());
    const activity = {
      ...base,
      confidence: 'fresh' as 'fresh' | 'reconciling',
      root: { ...base.root, state: rootState },
    };
    let activeTurnId: string | null = null;
    let pendingInteraction = false;
    const start = vi.fn(async () => {
      activeTurnId = 'continued';
    });
    const reconcile = vi.fn(async () => {
      activity.confidence = 'fresh';
      activity.root.observedAt = now();
      return { compatible: true };
    });
    const events: string[] = [];
    let controlNumber = 0;
    const coordinator = new AutopilotCoordinator({
      store,
      now,
      policy: { ...defaultAutopilotPolicy, backoffMs: () => 4_000 },
      plan: () => ({
        identity: 'p',
        plan: {
          title: 'p',
          steps: [
            {
              id: 'l1',
              title: 'l1',
              level: 1,
              state: 'WIP',
              priority: 'A',
              reviewStatus: 'UNREVIEWED',
              description: {},
              children: [],
            },
          ],
          totalSteps: 1,
          doneSteps: 0,
          allDone: false,
          executionComplete: false,
          currentStepId: 'l1',
        },
      }),
      session: () => ({ state: 'ready', threadId: 'root', activeTurnId }),
      activity: () => activity,
      pendingInteraction: () => pendingInteraction,
      pendingProcessResult,
      processResultState,
      reconcile,
      schedule: (callback, delay) => {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
      nextControlId: () => `control-${++controlNumber}`,
      turnStarter: { start },
      publish: (sessionId, type, payload, at, outboxId) => {
        events.push(type);
        journal.append(sessionId, type, payload, at, outboxId);
      },
    });
    coordinator.enable('s');
    return {
      coordinator,
      database,
      store,
      activity,
      start,
      reconcile,
      events,
      block: () => {
        pendingInteraction = true;
      },
      close: () => {
        coordinator.dispose('s');
        database.close();
      },
    };
  }

  it('persists a run-scoped lease and ignores unrelated or unscoped process wakeups', () => {
    const runId = '00000000-0000-4000-8000-000000000001';
    const f = fixture(
      () => true,
      'idle',
      (_sessionId, id) => (id === runId ? 'running' : 'missing'),
    );
    try {
      expect(
        f.coordinator.registerProactiveWait('s', {
          id: 'specific-run',
          leaseId: 'specific-lease',
          runId,
          maxWaitMs: 60_000,
          wakeConditions: ['processResultAvailable'],
        }),
      ).toBe(true);
      expect(f.store.find('s')!.supervision?.waitLease?.runId).toBe(runId);
      expect(f.coordinator.rootProcessCompleted('s', 'unrelated-run')).toBe(false);
      expect(f.coordinator.semanticEvent('s', 'processResultAvailable')).toBe(false);
      expect(f.coordinator.rootProcessCompleted('s', runId)).toBe(true);
      expect(f.coordinator.rootProcessCompleted('s', runId)).toBe(false);
      expect(f.events.filter((type) => type === 'autopilot.wait-woken')).toHaveLength(1);
    } finally {
      f.close();
    }
  });

  it('recovers a completed run after restoring its durable wait', () => {
    let result: 'running' | 'completed' = 'running';
    const f = fixture(undefined, 'idle', () => result);
    try {
      expect(
        f.coordinator.registerProactiveWait('s', {
          id: 'restored-run',
          leaseId: 'restored-wait',
          runId: '00000000-0000-4000-8000-000000000001',
          maxWaitMs: 60_000,
          wakeConditions: ['processResultAvailable'],
        }),
      ).toBe(true);
      f.coordinator.dispose('s');
      result = 'completed';
      f.coordinator.restore('s');
      expect(f.events.filter((type) => type === 'autopilot.wait-woken')).toHaveLength(1);
      expect(f.store.find('s')!.supervision?.waitLease).toBeNull();
    } finally {
      f.close();
    }
  });

  it('does not park for completed, missing or foreign runs and retains the deadline fallback', async () => {
    let result: 'completed' | 'running' | 'missing' = 'completed';
    const f = fixture(undefined, 'idle', () => result);
    try {
      const report = {
        id: 'bounded-run',
        leaseId: 'bounded-wait',
        runId: '00000000-0000-4000-8000-000000000001',
        maxWaitMs: 60_000,
        wakeConditions: ['processResultAvailable'] as const,
      };
      expect(f.coordinator.registerProactiveWait('s', report)).toBe('wakeAlreadySatisfied');
      result = 'missing';
      expect(f.coordinator.registerProactiveWait('s', report)).toBe(false);
      result = 'running';
      expect(f.coordinator.registerProactiveWait('s', report)).toBe(true);
      await vi.advanceTimersByTimeAsync(64_000);
      expect(f.events).toContain('autopilot.wait-expired');
      expect(f.start).toHaveBeenCalledOnce();
    } finally {
      f.close();
    }
  });

  it('keeps supervision in the current turn when a host result arrived before registration', async () => {
    let unread = true;
    const f = fixture(() => unread);
    try {
      const report = {
        id: 'focused-running',
        leaseId: 'focused-wait',
        maxWaitMs: 600_000,
        wakeConditions: ['processResultAvailable'] as const,
      };
      expect(f.coordinator.registerProactiveWait('s', report)).toBe('wakeAlreadySatisfied');
      expect(f.store.find('s')!.supervision?.waitLease ?? null).toBeNull();
      await vi.advanceTimersByTimeAsync(600_000);
      expect(f.start).not.toHaveBeenCalled();
      unread = false;
      expect(f.coordinator.registerProactiveWait('s', report)).toBe(true);
    } finally {
      f.close();
    }
  });

  it('does not wake an activity lease when only the registering root becomes idle', () => {
    const f = fixture(undefined, 'working');
    try {
      f.activity.root.state = 'working';
      expect(
        f.coordinator.registerProactiveWait('s', {
          id: 'executor-running',
          leaseId: 'executor-wait',
          maxWaitMs: 600_000,
          wakeConditions: ['agentActivityChanged'],
        }),
      ).toBe(true);
      f.activity.root.state = 'idle';
      f.coordinator.activityChanged('s');
      expect(f.events).not.toContain('autopilot.wait-woken');
      expect(f.store.find('s')!.supervision?.waitLease?.id).toBe('executor-wait');
    } finally {
      f.close();
    }
  });

  it('expires an accepted wait and dispatches once despite reconciliation, retaining diagnostic boundaries', async () => {
    const f = fixture();
    try {
      expect(
        f.coordinator.registerProactiveWait('s', {
          id: 'ci-running',
          leaseId: 'ci-wait',
          maxWaitMs: 600_000,
          wakeConditions: ['processExited', 'processResultAvailable'],
        }),
      ).toBe(true);
      await vi.advanceTimersByTimeAsync(600_000);
      const due = f.store.find('s')!.nextEvaluationAt;
      for (let i = 0; i < 3; i++) {
        await vi.advanceTimersByTimeAsync(1_000);
        f.activity.confidence = 'reconciling';
        f.coordinator.evaluate('s');
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(f.store.find('s')!.nextEvaluationAt).toBe(due);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(f.start).toHaveBeenCalledOnce();
      const rows = f.database
        .prepare(
          "SELECT type,payload_json,occurred_at FROM session_events WHERE type IN ('autopilot.wait-registered','autopilot.wait-expired','autopilot.continuation-scheduled','autopilot.turn-started') ORDER BY sequence",
        )
        .all() as { type: string; payload_json: string; occurred_at: string }[];
      const registered = rows.find((row) => row.type === 'autopilot.wait-registered')!;
      expect(JSON.parse(registered.payload_json)).toMatchObject({
        leaseId: 'ci-wait',
        reportId: 'ci-running',
        resumeAt: '2026-10-18T06:09:19.000Z',
      });
      expect(rows.find((row) => row.type === 'autopilot.wait-expired')?.occurred_at).toBe(
        '2026-10-18T06:09:19.000Z',
      );
      expect(
        JSON.parse(
          rows.filter((row) => row.type === 'autopilot.continuation-scheduled').at(-1)!
            .payload_json,
        ),
      ).toMatchObject({ reportId: 'ci-running', nextEvaluationAt: due });
      expect(rows.at(-1)?.type).toBe('autopilot.turn-started');
    } finally {
      f.close();
    }
  });

  it('records duplicate process completion observations after the wake was consumed', async () => {
    const f = fixture();
    try {
      expect(
        f.coordinator.registerProactiveWait('s', {
          id: 'process-report',
          leaseId: 'process-wait',
          maxWaitMs: 60_000,
          wakeConditions: ['processResultAvailable'],
        }),
      ).toBe(true);
      expect(f.coordinator.rootProcessCompleted('s', 'watcher-48778')).toBe(true);
      expect(f.coordinator.rootProcessCompleted('s', 'watcher-48778')).toBe(false);
      const rows = f.database
        .prepare(
          "SELECT type,payload_json,occurred_at FROM session_events WHERE type IN ('autopilot.wait-woken','autopilot.root-process-observed') ORDER BY sequence",
        )
        .all() as { type: string; payload_json: string; occurred_at: string }[];
      expect(rows.filter((row) => row.type === 'autopilot.wait-woken')).toHaveLength(1);
      const observations = rows.filter((row) => row.type === 'autopilot.root-process-observed');
      expect(observations).toHaveLength(2);
      expect(JSON.parse(observations[0]!.payload_json)).toMatchObject({
        processId: 'watcher-48778',
        leaseId: 'process-wait',
        observedAt: '2026-10-18T05:59:19.000Z',
      });
      expect(JSON.parse(observations[1]!.payload_json)).toMatchObject({
        processId: 'watcher-48778',
        leaseId: null,
      });
    } finally {
      f.close();
    }
  });

  it('timestamps a process completion after expiry without creating another wake', async () => {
    const f = fixture();
    try {
      f.coordinator.registerProactiveWait('s', {
        id: 'late-report',
        leaseId: 'late-wait',
        maxWaitMs: 60_000,
        wakeConditions: ['processResultAvailable'],
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.coordinator.rootProcessCompleted('s', 'late-process')).toBe(false);
      expect(f.events.filter((type) => type === 'autopilot.wait-expired')).toHaveLength(1);
      expect(f.events).not.toContain('autopilot.wait-woken');
      const row = f.database
        .prepare(
          "SELECT payload_json,occurred_at FROM session_events WHERE type='autopilot.root-process-observed'",
        )
        .get() as { payload_json: string; occurred_at: string };
      expect(row.occurred_at).toBe('2026-10-18T06:00:19.000Z');
      expect(JSON.parse(row.payload_json)).toMatchObject({
        leaseId: null,
        reportId: 'late-report',
        observedAt: row.occurred_at,
      });
    } finally {
      f.close();
    }
  });

  it('retains lease cancellation and never expires it after manual intervention', async () => {
    const f = fixture();
    try {
      f.coordinator.registerProactiveWait('s', {
        id: 'manual-report',
        leaseId: 'manual-wait',
        maxWaitMs: 60_000,
        wakeConditions: ['processExited'],
      });
      f.coordinator.manualSend('s');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.events).toContain('autopilot.wait-ended');
      expect(f.events).not.toContain('autopilot.wait-expired');
      expect(f.events).toContain('autopilot.control-cancelled');
      expect(f.start).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });

  it('dispatches the original durable control on time despite repeated reconciliation', async () => {
    const f = fixture();
    try {
      const scheduled = f.store.find('s')!;
      for (let i = 0; i < 3; i += 1) {
        await vi.advanceTimersByTimeAsync(1_000);
        f.activity.confidence = 'reconciling';
        f.coordinator.evaluate('s');
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(f.store.find('s')?.nextEvaluationAt).toBe(scheduled.nextEvaluationAt);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(f.start).toHaveBeenCalledOnce();
      expect(f.store.findControl('s', scheduled.lastControlId!)?.status).toBe('started');
      expect(f.events.filter((type) => type === 'autopilot.continuation-scheduled')).toHaveLength(
        1,
      );
      expect(f.events).toContain('autopilot.turn-started');
    } finally {
      f.close();
    }
  });

  it('refreshes stale evidence at the deadline without cancelling or delaying the control', async () => {
    const f = fixture();
    try {
      const scheduled = f.store.find('s')!;
      await vi.advanceTimersByTimeAsync(3_999);
      f.activity.confidence = 'reconciling';
      await vi.advanceTimersByTimeAsync(2);
      expect(f.reconcile).toHaveBeenCalledOnce();
      expect(f.start).toHaveBeenCalledOnce();
      expect(f.store.findControl('s', scheduled.lastControlId!)?.status).toBe('started');
      expect(f.events.filter((type) => type === 'autopilot.continuation-scheduled')).toHaveLength(
        1,
      );
    } finally {
      f.close();
    }
  });

  it('still cancels a pending continuation when an interaction blocks dispatch', async () => {
    const f = fixture();
    try {
      const scheduled = f.store.find('s')!;
      f.block();
      await vi.advanceTimersByTimeAsync(4_000);
      expect(f.start).not.toHaveBeenCalled();
      expect(f.store.findControl('s', scheduled.lastControlId!)?.status).toBe('cancelled');
    } finally {
      f.close();
    }
  });

  it('waits for fresh evidence without spinning when reconciliation remains stale', async () => {
    const f = fixture();
    try {
      const scheduled = f.store.find('s')!;
      f.reconcile.mockImplementation(async () => ({ compatible: true }));
      f.activity.confidence = 'reconciling';
      await vi.advanceTimersByTimeAsync(5_000);
      expect(f.start).not.toHaveBeenCalled();
      expect(f.reconcile).toHaveBeenCalledOnce();
      expect(f.store.findControl('s', scheduled.lastControlId!)?.status).toBe('scheduled');
      expect(f.store.find('s')?.nextEvaluationAt).toBe(scheduled.nextEvaluationAt);

      f.activity.confidence = 'fresh';
      f.coordinator.evaluate('s');
      await vi.advanceTimersByTimeAsync(1);
      expect(f.start).toHaveBeenCalledOnce();
    } finally {
      f.close();
    }
  });

  it('honors disable while the due control is awaiting reconciliation', async () => {
    const f = fixture();
    let finish!: (result: { compatible: boolean }) => void;
    const result = new Promise<{ compatible: boolean }>((resolve) => {
      finish = resolve;
    });
    try {
      const scheduled = f.store.find('s')!;
      f.reconcile.mockReturnValue(result);
      f.activity.confidence = 'reconciling';
      await vi.advanceTimersByTimeAsync(4_000);
      expect(f.reconcile).toHaveBeenCalledOnce();
      f.coordinator.disable('s');
      f.activity.confidence = 'fresh';
      finish({ compatible: true });
      await vi.advanceTimersByTimeAsync(1);
      expect(f.start).not.toHaveBeenCalled();
      expect(f.store.findControl('s', scheduled.lastControlId!)?.status).toBe('cancelled');
    } finally {
      finish({ compatible: true });
      await vi.advanceTimersByTimeAsync(0);
      f.close();
    }
  });
});
