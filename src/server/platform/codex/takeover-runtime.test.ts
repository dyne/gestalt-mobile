/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { CodexSessionRuntime } from './session-runtime.js';
import { RelaySession } from '../../features/sessions/model/relay-session.js';
import { CodexJsonRpcError } from './json-rpc-client.js';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../persistence/migrate.js';
import { SqliteSessionRepository } from '../persistence/sqlite-session-repository.js';
import { SqliteAutopilotStore } from '../persistence/sqlite-autopilot-store.js';
import { SqliteSupervisionTakeoverStore } from '../persistence/sqlite-supervision-takeover-store.js';
import { SupervisionTakeover } from '../../features/autopilot/application/takeover-supervision.js';
import { disabledAutopilot } from '../../features/autopilot/domain/autopilot-session.js';
import type { SupervisedPlan } from '../../features/plans/domain/supervised-plan.js';

describe('takeover writer quiescence', () => {
  async function fixture(
    options: {
      refusesInterrupt?: boolean;
      refusesTermination?: boolean;
      unloaded?: boolean;
      unrelated?: boolean;
      holdTermination?: boolean;
      recordedResult?: Record<string, unknown>;
      resultThreadId?: string;
    } = {},
  ) {
    const active = new Set(options.unloaded ? [] : ['root', 'child', 'nested']);
    if (options.unrelated) active.add('unrelated');
    let processActive = !options.unloaded;
    const held = Promise.withResolvers<unknown>();
    const calls: Array<{ method: string; threadId?: string }> = [];
    let closed = false;
    const runtime = new CodexSessionRuntime(() => ({
      rpc: {
        request: async (method, raw) => {
          const p = raw as { threadId?: string; parentThreadId?: string; includeTurns?: boolean };
          calls.push({ method, threadId: p?.threadId });
          if (method === 'thread/start') return { thread: { id: 'root' } };
          if (method === 'thread/read')
            return {
              thread: {
                id: p.includeTurns ? (options.resultThreadId ?? p.threadId) : p.threadId,
                status: {
                  type:
                    options.unloaded && p.threadId !== 'root'
                      ? 'notLoaded'
                      : active.has(p.threadId!)
                        ? 'active'
                        : 'idle',
                },
                turns:
                  p.includeTurns && active.has(p.threadId!)
                    ? [{ id: `${p.threadId}-turn`, status: 'inProgress', items: [] }]
                    : p.includeTurns && p.threadId === 'child' && options.recordedResult
                      ? [
                          {
                            id: 'completed-turn',
                            status: 'completed',
                            items: [options.recordedResult],
                          },
                        ]
                      : [],
              },
            };
          if (method === 'thread/list') {
            const child =
              p.parentThreadId === 'root'
                ? 'child'
                : p.parentThreadId === 'child'
                  ? 'nested'
                  : null;
            return {
              data: [
                ...(child
                  ? [
                      {
                        id: child,
                        parentThreadId: p.parentThreadId,
                        status: {
                          type: options.unloaded
                            ? 'notLoaded'
                            : active.has(child)
                              ? 'active'
                              : 'idle',
                        },
                        source: {
                          subAgent: {
                            thread_spawn: {
                              agent_path: child === 'child' ? '/root/l1' : '/root/l1/helper',
                            },
                          },
                        },
                      },
                    ]
                  : []),
                ...(options.unrelated
                  ? [
                      {
                        id: 'unrelated',
                        parentThreadId: 'another-root',
                        status: { type: 'active' },
                        source: { subAgent: { thread_spawn: { agent_path: '/root/l1' } } },
                      },
                    ]
                  : []),
              ],
            };
          }
          if (method === 'turn/interrupt') {
            if (!options.refusesInterrupt) active.delete(p.threadId!);
            return {};
          }
          if (method === 'thread/backgroundTerminals/list') {
            if (options.unloaded && p.threadId !== 'root')
              throw new CodexJsonRpcError(-32600, `thread not found: ${p.threadId}`);
            return {
              data:
                p.threadId === 'child' && processActive
                  ? [
                      {
                        itemId: 'item',
                        processId: 'process',
                        osPid: 12345,
                        cwd: '/w',
                        cpuPercent: 0,
                        rssKb: 1,
                      },
                    ]
                  : [],
            };
          }
          if (method === 'thread/backgroundTerminals/terminate') {
            if (options.holdTermination) return held.promise;
            if (!options.refusesTermination) processActive = false;
            return { terminated: !processActive };
          }
          return {};
        },
        onNotification: () => () => {},
        onServerRequest: () => () => {},
      },
      close: () => {
        closed = true;
      },
    }));
    const session = await runtime.start(
      RelaySession.create({
        id: 's',
        workspaceId: 'w',
        workspacePath: '/w',
        provider: 'codex',
        profile: 'default',
        now: 't',
        effectiveSkillSelection: { skills: [] },
      }).snapshot,
      't',
    );
    onTestFinished(() => runtime.stopAll());
    return {
      runtime,
      session,
      calls,
      closed: () => closed,
      active,
      releaseHeld: () => {
        processActive = false;
        held.resolve({ terminated: true });
      },
    };
  }

  it('stops the root, descendants and exact background process before releasing the old runtime', async () => {
    const f = await fixture();
    expect(await f.runtime.quiesceForTakeover(f.session)).toBe(true);
    expect(f.active.size).toBe(0);
    expect(f.calls.filter((c) => c.method === 'turn/interrupt').map((c) => c.threadId)).toEqual([
      'root',
      'child',
      'nested',
    ]);
    expect(f.calls.some((c) => c.method === 'thread/backgroundTerminals/terminate')).toBe(true);
    expect(f.closed()).toBe(true);
  });
  it.each([{ refusesInterrupt: true }, { refusesTermination: true }])(
    'withholds takeover when a live writer cannot be stopped: %j',
    async (options) => {
      const f = await fixture(options);
      expect(await f.runtime.quiesceForTakeover(f.session)).toBe(false);
      expect(f.closed()).toBe(false);
    },
  );
  it('does not treat an unloaded actor as proof that a previously running background process exited', async () => {
    const f = await fixture({ unloaded: true });
    expect(
      await f.runtime.quiesceForTakeover(f.session, [
        { ownerThreadId: 'child', processId: 'process', state: 'running' },
      ]),
    ).toBe(false);
  });
  it.each(['completed', 'failed', 'declined'])(
    'reconciles a closed session with a stale running process and an exact %s command result',
    async (status) => {
      const f = await fixture({
        unloaded: true,
        recordedResult: { id: 'item', type: 'commandExecution', processId: 'process', status },
      });
      f.runtime.stop(f.session.id);
      const stopped = RelaySession.rehydrate(f.session).release('t').snapshot;
      expect(
        await f.runtime.quiesceForTakeover(stopped, [
          { ownerThreadId: 'child', processId: 'process', itemId: 'item', state: 'running' },
        ]),
      ).toBe(true);
      expect(f.calls.filter((c) => c.method === 'thread/resume').map((c) => c.threadId)).toEqual([
        'root',
      ]);
      expect(f.calls.some((c) => c.method === 'turn/start')).toBe(false);
      expect(f.calls.some((c) => c.method === 'thread/backgroundTerminals/terminate')).toBe(false);
      expect(f.runtime.ownsWriter(f.session.id)).toBe(false);
    },
  );
  it.each([
    { id: 'different-item' },
    { processId: 'reused-process' },
    { processId: undefined },
    { type: 'fileChange' },
    { status: 'inProgress' },
  ])('keeps an unloaded writer blocked when completion does not match: %j', async (override) => {
    const f = await fixture({
      unloaded: true,
      recordedResult: {
        id: 'item',
        type: 'commandExecution',
        processId: 'process',
        status: 'completed',
        ...override,
      },
    });
    expect(
      await f.runtime.quiesceForTakeover(f.session, [
        { ownerThreadId: 'child', processId: 'process', itemId: 'item', state: 'running' },
      ]),
    ).toBe(false);
  });
  it('rejects completion evidence from a different thread', async () => {
    const f = await fixture({
      unloaded: true,
      resultThreadId: 'another-child',
      recordedResult: {
        id: 'item',
        type: 'commandExecution',
        processId: 'process',
        status: 'completed',
      },
    });
    expect(
      await f.runtime.quiesceForTakeover(f.session, [
        { ownerThreadId: 'child', processId: 'process', itemId: 'item', state: 'detached-active' },
      ]),
    ).toBe(false);
  });
  it('composes closed-runtime reconciliation with durable ownership transfer and idempotent replacement', async () => {
    const f = await fixture({
      unloaded: true,
      recordedResult: {
        id: 'item',
        type: 'commandExecution',
        processId: 'process',
        status: 'completed',
      },
    });
    const now = '2026-10-31T22:00:00Z';
    const db = new DatabaseSync(':memory:');
    migrate(db);
    onTestFinished(() => db.close());
    const sessions = new SqliteSessionRepository(db);
    const states = new SqliteAutopilotStore(db);
    const store = new SqliteSupervisionTakeoverStore(db, states);
    const plan: SupervisedPlan = {
      title: 'Work',
      totalSteps: 1,
      doneSteps: 0,
      allDone: false,
      currentStepId: 'l1',
      steps: [
        {
          id: 'l1',
          title: 'Pending review',
          level: 1,
          state: 'WIP',
          priority: 'A',
          reviewStatus: 'UNREVIEWED',
          description: {},
          children: [],
        },
      ],
    };
    f.runtime.stop(f.session.id);
    sessions.save(RelaySession.rehydrate(f.session).release(now).snapshot);
    sessions.save(
      RelaySession.create({
        id: 'new',
        workspaceId: 'w',
        workspacePath: '/w',
        provider: 'codex',
        profile: 'default',
        now,
        effectiveSkillSelection: { skills: [] },
      })
        .bindThread('new-root', now)
        .startTurn('new-turn', now).snapshot,
    );
    states.save({
      ...disabledAutopilot('s', now),
      planIdentity: 'plan',
      executor: {
        canonicalPosition: 'L1',
        canonicalTaskName: 'l1',
        taskPath: '/root/l1',
        threadId: 'child',
        l1State: 'WIP',
        lastActivityAt: now,
        outcome: 'partial',
        continuationGeneration: 1,
        continuationCount: 0,
        ownedProcesses: [
          {
            ownerThreadId: 'child',
            ownerTaskPath: '/root/l1',
            ownership: 'executor',
            processId: 'process',
            itemId: 'item',
            state: 'running',
            observedAt: now,
            elapsedMs: 0,
            cpuPercent: 0,
            rssBytes: 0,
          },
        ],
      },
      checkpoints: {
        protocolVersion: 1,
        planIdentity: 'plan',
        acceptedKeys: ['evidence'],
        reportedL1Ids: [],
        reportedL2Ids: [JSON.stringify(['l1', 'evidence'])],
        pendingTurnId: null,
        terminalReviewAccepted: false,
      },
    });
    states.save({ ...disabledAutopilot('new', now), planIdentity: 'plan' });
    const coordinator = new SupervisionTakeover({
      store,
      now: () => now,
      context: () => ({
        session: sessions.find('new')!,
        state: states.find('new'),
        plan,
        identity: 'plan',
        held: false,
        localExecutor: false,
        admission: true,
      }),
      predecessors: () => [{ session: sessions.find('s')!, state: states.find('s')! }],
      fence: vi.fn(),
      changed: vi.fn(),
      stop: ({ session, state }) =>
        f.runtime.quiesceForTakeover(session, state.executor!.ownedProcesses, state.executor),
    });
    expect(await coordinator.takeOver('new', 'new-root', 'new-turn')).toMatchObject({
      accepted: true,
      identity: { taskName: 'l1_g2', generation: 2 },
    });
    expect(store.owner('plan')).toMatchObject({ sessionId: 'new', phase: 'ready' });
    expect(store.stopped('plan', 's')).toBe(true);
    expect(states.find('new')).toMatchObject({
      checkpoints: {
        acceptedKeys: ['evidence'],
        reportedL2Ids: [JSON.stringify(['l1', 'evidence'])],
      },
      executor: { ownedProcesses: [], replacement: { taskName: 'l1_g2' } },
    });
    expect(plan.steps[0]).toMatchObject({ state: 'WIP', reviewStatus: 'UNREVIEWED' });
    expect(await coordinator.takeOver('new', 'new-root', 'new-turn')).toMatchObject({
      accepted: true,
      alreadyOwner: true,
      identity: { taskName: 'l1_g2', generation: 2 },
    });
    expect(states.drainOutbox('new').map((e) => e.type)).toEqual([
      'autopilot.supervisor-taken-over',
    ]);
  });
  it('does not stop an unrelated actor when a provider ignores the parent-thread list filter', async () => {
    const f = await fixture({ unrelated: true });
    expect(await f.runtime.quiesceForTakeover(f.session)).toBe(true);
    expect(f.active.has('unrelated')).toBe(true);
    expect(f.calls.some((c) => c.method === 'turn/interrupt' && c.threadId === 'unrelated')).toBe(
      false,
    );
  });
  it('bounds an unresponsive stop and suppresses later actor operations after timeout', async () => {
    const f = await fixture({ holdTermination: true });
    vi.useFakeTimers();
    onTestFinished(() => {
      f.releaseHeld();
      vi.useRealTimers();
    });
    const stopping = f.runtime.quiesceForTakeover(f.session);
    await vi.waitFor(() =>
      expect(f.calls.some((c) => c.method === 'thread/backgroundTerminals/terminate')).toBe(true),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(stopping).resolves.toBe(false);
    expect(f.closed()).toBe(true);
    f.releaseHeld();
    await vi.runAllTimersAsync();
    expect(f.calls.some((c) => c.method === 'turn/interrupt' && c.threadId === 'nested')).toBe(
      false,
    );
  });
});
