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

describe('continuation deadline across reconciliation', () => {
  afterEach(() => vi.useRealTimers());

  function fixture() {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-18T05:59:19.000Z'));
    const database = new DatabaseSync(':memory:');
    migrate(database);
    database.exec(
      "INSERT INTO relay_sessions (id,workspace_id,workspace_path,profile,state,desired_state,failure_count,next_sequence,created_at,updated_at) VALUES ('s','w','/w','p','ready','active',0,1,'t','t')",
    );
    const store = new SqliteAutopilotStore(database);
    const now = () => new Date().toISOString();
    const base = createAgentActivitySnapshot('s', now());
    const activity = {
      ...base,
      confidence: 'fresh' as 'fresh' | 'reconciling',
      root: { ...base.root, state: 'idle' as const },
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
      reconcile,
      schedule: (callback, delay) => {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
      nextControlId: () => `control-${++controlNumber}`,
      turnStarter: { start },
      publish: (_sessionId, type) => events.push(type),
    });
    coordinator.enable('s');
    return {
      coordinator,
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
