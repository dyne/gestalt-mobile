/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { migrate } from '../../../platform/persistence/migrate.js';
import { SqliteAutopilotStore } from '../../../platform/persistence/sqlite-autopilot-store.js';
import { createAgentActivitySnapshot } from '../../agent-activity/model.js';
import type { AgentActivitySnapshot } from '../../agent-activity/model.js';
import { AutopilotCoordinator } from './service.js';
import { defaultAutopilotPolicy } from './policy.js';
import type { AutopilotAuditEvent } from './ports.js';

const now = '2026-08-20T12:00:00.000Z';
function fixture(acknowledge = true) {
  const database = new DatabaseSync(':memory:');
  migrate(database);
  database
    .prepare(
      "INSERT INTO relay_sessions (id,workspace_id,workspace_path,profile,state,desired_state,failure_count,next_sequence,created_at,updated_at) VALUES ('s','w','/w','p','ready','active',0,1,'t','t')",
    )
    .run();
  const store = new SqliteAutopilotStore(database);
  let clock = now;
  let activeTurnId: string | null = 'manual';
  const base = createAgentActivitySnapshot('s', now);
  let activity: AgentActivitySnapshot = {
    ...base,
    confidence: 'fresh',
    root: { ...base.root, state: 'working' },
  };
  const events: AutopilotAuditEvent[] = [];
  const timers: Array<{ callback: () => void; cancelled: boolean }> = [];
  const start = vi.fn(async () => {
    if (acknowledge) activeTurnId = 'accepted-root';
  });
  const construct = () =>
    new AutopilotCoordinator({
      store,
      now: () => clock,
      policy: defaultAutopilotPolicy,
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
      pendingInteraction: () => false,
      reconcile: async () => ({ compatible: true }),
      schedule: (callback) => {
        const timer = { callback, cancelled: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
      nextControlId: () => 'control',
      turnStarter: { start },
      publish: (sessionId, type, payload, occurredAt) =>
        events.push({ sessionId, type, payload, occurredAt }),
    });
  const coordinator = construct();
  coordinator.enable('s');
  const park = () => {
    expect(
      coordinator.registerProactiveWait('s', {
        id: 'report',
        leaseId: 'lease',
        maxWaitMs: 60_000,
        wakeConditions: ['processExited'],
      }),
    ).toBe(true);
    activeTurnId = null;
    activity = { ...activity, root: { ...activity.root, state: 'idle' } };
  };
  const runNext = async () => {
    const timer = timers.find((entry) => !entry.cancelled);
    expect(timer).toBeDefined();
    timer!.cancelled = true;
    timer!.callback();
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  return {
    coordinator,
    construct,
    store,
    events,
    start,
    park,
    runNext,
    lateCallback: () => timers.find((entry) => !entry.cancelled)!.callback,
    get activity() {
      return activity;
    },
    set activity(value: AgentActivitySnapshot) {
      activity = value;
    },
    setClock(value: string) {
      clock = value;
      activity = { ...activity, root: { ...activity.root, observedAt: value } };
    },
    close() {
      coordinator.dispose('s');
      database.close();
    },
  };
}

describe('wake attribution', () => {
  it.each(['processExited', 'deadline'] as const)(
    'correlates %s through durable acceptance and restart',
    async (reason) => {
      const f = fixture();
      try {
        f.park();
        expect(f.coordinator.snapshot('s').supervisionDelta?.changed).toBeNull();
        if (reason === 'deadline') {
          f.setClock('2026-08-20T12:01:00.000Z');
          await f.runNext();
        } else {
          expect(f.coordinator.rootProcessCompleted('s', 'process')).toBe(true);
          expect(f.coordinator.rootProcessCompleted('s', 'process')).toBe(false);
        }
        await f.runNext();
        await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce());
        const correlated = f.events.filter((event) =>
          [
            'autopilot.continuation-scheduled',
            'autopilot.control-issued',
            'autopilot.turn-started',
          ].includes(event.type),
        );
        expect(correlated).toHaveLength(3);
        for (const event of correlated)
          expect(event.payload).toMatchObject({
            controlId: 'control',
            wakeReason: reason,
            leaseId: 'lease',
            supervisionDelta: { revision: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) },
          });
        expect(correlated.at(-1)?.payload).toMatchObject({
          trafficClass: 'acceptedRootTurn',
          turnId: 'accepted-root',
        });
        expect(
          f.events.find((event) => event.type === 'autopilot.wait-registered')?.payload,
        ).toMatchObject({
          leaseId: 'lease',
          reportId: 'report',
          supervisionDelta: { changed: null },
        });
        const delta = f.coordinator.snapshot('s').supervisionDelta!;
        expect(Buffer.byteLength(JSON.stringify(delta), 'utf8')).toBeLessThanOrEqual(2048);
        // Receipt/status traffic and control attempts are not model-turn counts.
        expect(
          f.events.filter((event) => event.type === 'autopilot.updated').length,
        ).toBeGreaterThan(0);
        expect(
          f.events.filter((event) => event.type === 'autopilot.root-process-observed'),
        ).toHaveLength(reason === 'deadline' ? 0 : 2);
        expect(delta).toMatchObject({
          changed: false,
          acceptedControlId: 'control',
          acceptedTurnId: 'accepted-root',
        });
        expect(f.store.find('s')?.supervision?.acknowledgedRevision?.revision).toBe(delta.revision);
        const restored = f.construct();
        expect(restored.snapshot('s').supervisionDelta).toEqual(delta);
        restored.dispose('s');
        // A real semantic transition is a delta; it does not itself certify another model turn.
        f.activity = { ...f.activity, root: { ...f.activity.root, state: 'working' } };
        expect(f.coordinator.snapshot('s').supervisionDelta?.changed).toBe(true);
        f.coordinator.manualSend('s');
        expect(f.coordinator.snapshot('s').supervisionDelta?.acknowledgedRevision).toBe(
          delta.acknowledgedRevision,
        );
        expect(
          correlated.filter(
            (event) =>
              (event.payload as { trafficClass: string }).trafficClass === 'acceptedRootTurn',
          ),
        ).toHaveLength(1);
      } finally {
        f.close();
      }
    },
  );

  it('keeps timestamps, child order and duplicate activity separate from accepted turns', () => {
    const f = fixture();
    try {
      const child = {
        id: 'a',
        state: 'working' as const,
        reason: 'turnActive' as const,
        observedAt: now,
        lastActivityAt: now,
      };
      f.activity = {
        ...f.activity,
        subagents: [child, { ...child, id: 'b' }],
        aggregateSubagents: 'working',
      };
      f.coordinator.activityChanged('s');
      const revision = f.coordinator.snapshot('s').supervisionDelta?.revision;
      const count = f.events.length;
      f.setClock('2026-08-20T12:00:01.000Z');
      f.activity = { ...f.activity, subagents: [...f.activity.subagents].reverse() };
      f.coordinator.activityChanged('s');
      f.coordinator.activityChanged('s');
      expect(f.coordinator.snapshot('s').supervisionDelta?.revision).toBe(revision);
      expect(f.events).toHaveLength(count);
      expect(f.start).not.toHaveBeenCalled();
      f.activity = {
        ...f.activity,
        subagents: f.activity.subagents.map((entry) =>
          entry.id === 'a' ? { ...entry, state: 'idle', reason: 'turnCompleted' } : entry,
        ),
      };
      expect(f.coordinator.snapshot('s').supervisionDelta?.revision).not.toBe(revision);
    } finally {
      f.close();
    }
  });

  it('does not acknowledge a start lacking a runtime turn ID', async () => {
    const f = fixture(false);
    try {
      f.park();
      f.coordinator.rootProcessCompleted('s', 'process');
      await f.runNext();
      await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce());
      expect(f.coordinator.snapshot('s').supervisionDelta).toMatchObject({
        acknowledgedRevision: null,
        changed: null,
        acceptedTurnId: null,
      });
      expect(
        f.events.find((event) => event.type === 'autopilot.turn-started')?.payload,
      ).toMatchObject({ trafficClass: 'unconfirmedStart', turnId: null });
    } finally {
      f.close();
    }
  });

  it('preserves manual Off through a late completion and timer callback', async () => {
    const f = fixture();
    try {
      f.park();
      const lateCallback = f.lateCallback();
      f.coordinator.disable('s');
      expect(f.coordinator.rootProcessCompleted('s', 'process')).toBe(false);
      f.setClock('2026-08-20T12:01:00.000Z');
      lateCallback();
      // No live callback remains and no observation manufactures an acceptance.
      expect(f.coordinator.snapshot('s')).toMatchObject({
        enabled: false,
        supervisionDelta: { changed: null },
      });
      expect(f.start).not.toHaveBeenCalled();
      expect(f.events.filter((event) => event.type === 'autopilot.turn-started')).toHaveLength(0);
    } finally {
      f.close();
    }
  });
});
