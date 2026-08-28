/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { describe, expect, it, vi } from 'vitest';
import { AgentActivityRegistry } from './registry.js';
const at = '2026-01-01T00:00:00.000Z';
describe('agent activity registry', () => {
  it('publishes only semantic changes and disposes session state', () => {
    const published: string[] = [];
    const registry = new AgentActivityRegistry((snapshot) => published.push(snapshot.root.state));
    registry.observe({ sessionId: 's', occurredAt: at, kind: 'turnStarted' });
    registry.observe({ sessionId: 's', occurredAt: at, kind: 'turnStarted' });
    expect(published).toEqual(['working']);
    registry.dispose('s');
    expect(registry.snapshot('s', at).root.state).toBe('disconnected');
  });
  it('retains the last known snapshot while reconciling', () => {
    const registry = new AgentActivityRegistry(() => {});
    registry.observe({ sessionId: 's', occurredAt: at, kind: 'turnStarted' });
    expect(registry.reconciling('s', at)).toMatchObject({
      root: { state: 'working' },
      confidence: 'reconciling',
    });
  });
  it('uses an injected stale scheduler and never polls before an observed fact', async () => {
    let callback: (() => void) | undefined;
    const reconciled: string[] = [];
    const registry = new AgentActivityRegistry(() => {}, {
      now: () => at,
      schedule: (next) => {
        callback = next;
        return () => undefined;
      },
      reconcile: async (id) => {
        reconciled.push(id);
      },
    });
    expect(callback).toBeUndefined();
    registry.observe({ sessionId: 's', occurredAt: at, kind: 'turnStarted' });
    callback?.();
    await Promise.resolve();
    expect(reconciled).toEqual(['s']);
    expect(registry.snapshot('s', at).confidence).toBe('fresh');
  });
  it('returns to fresh after reconciliation and retries failures before disconnecting', async () => {
    const callbacks: Array<() => void> = [];
    let calls = 0;
    const registry = new AgentActivityRegistry(() => {}, {
      now: () => at,
      schedule: (callback) => {
        callbacks.push(callback);
        return () => undefined;
      },
      maxReconcileAttempts: 2,
      reconcile: async () => {
        calls += 1;
        if (calls === 1) throw new Error('read failed');
      },
    });
    registry.observe({ sessionId: 's', occurredAt: at, kind: 'turnStarted' });
    callbacks.shift()?.();
    await Promise.resolve();
    callbacks.shift()?.();
    await Promise.resolve();
    expect(registry.snapshot('s', at).confidence).toBe('fresh');
    expect(calls).toBe(2);
  });
  it('cancels a stale attempt on process disconnect', () => {
    let cancelled = false;
    const registry = new AgentActivityRegistry(() => {}, {
      schedule: () => () => {
        cancelled = true;
      },
      reconcile: async () => undefined,
    });
    registry.observe({ sessionId: 's', occurredAt: at, kind: 'turnStarted' });
    registry.disconnected('s', at);
    expect(cancelled).toBe(true);
  });
  it('atomically marks a disappeared reconciled child disconnected', () => {
    const registry = new AgentActivityRegistry(() => {});
    registry.childrenReconciled('s', at, [{ id: 'child', status: 'active' }]);
    const next = registry.childrenReconciled('s', '2026-01-01T00:00:01.000Z', []);
    expect(next.subagents).toMatchObject([{ id: 'child', state: 'disconnected' }]);
  });
  it('clears child identities when the owning process exits', () => {
    const registry = new AgentActivityRegistry(() => {});
    registry.childrenReconciled('s', at, [{ id: 'child', status: 'active' }]);
    const exited = registry.disconnected('s', '2026-01-01T00:00:01.000Z');
    expect(exited).toMatchObject({
      confidence: 'stale',
      root: { state: 'disconnected' },
      subagents: [],
      aggregateSubagents: 'idle',
    });
    expect(
      registry.childrenReconciled('s', '2026-01-01T00:00:02.000Z', [
        { id: 'recovered', status: 'active' },
      ]).subagents,
    ).toMatchObject([{ id: 'recovered', state: 'working' }]);
  });
  it('fails closed for an unqualified child-list row', () => {
    const registry = new AgentActivityRegistry(() => {});
    const next = registry.childrenReconciled('s', at, [
      { id: 'child', status: 'notLoaded', qualified: false },
    ]);
    expect(next).toMatchObject({
      confidence: 'stale',
      subagents: [{ id: 'child', state: 'disconnected' }],
    });
  });
  it('projects canonical executor identity and owned process metadata without command output', () => {
    const registry = new AgentActivityRegistry(() => {});
    const next = registry.childrenReconciled('s', at, [
      {
        id: 'child',
        status: 'idle',
        taskPath: '/root/l4_g2',
        processes: [
          {
            processId: 'process-1',
            itemId: 'item-1',
            ownerThreadId: 'child',
            ownerTaskPath: '/root/l4_g2',
            ownership: 'executor',
            state: 'running',
            observedAt: at,
            elapsedMs: 5_000,
            cpuPercent: 99,
            rssBytes: 1_024,
            osPid: 42,
          },
        ],
      },
    ]);
    expect(next.subagents).toMatchObject([
      {
        id: 'child',
        state: 'idle',
        outcome: 'partial',
        taskPath: '/root/l4_g2',
        canonicalTaskName: 'l4',
        canonicalPosition: 'L4',
        continuationGeneration: 2,
        ownedProcesses: [
          {
            processId: 'process-1',
            ownerThreadId: 'child',
            rssBytes: 1_024,
          },
        ],
      },
    ]);
    expect(JSON.stringify(next)).not.toContain('command');
  });
  it('coalesces concurrent manual refreshes per session', async () => {
    let release: (() => void) | undefined;
    let calls = 0;
    const registry = new AgentActivityRegistry(() => {}, {
      reconcile: async () => {
        calls += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    const first = registry.refresh('s');
    const second = registry.refresh('s');
    expect(first).toBe(second);
    expect(calls).toBe(1);
    release?.();
    await first;
  });
  it('emits one diagnostic after bounded retry exhaustion', async () => {
    const callbacks: Array<() => void> = [];
    const diagnostic = vi.fn();
    const registry = new AgentActivityRegistry(() => {}, {
      schedule: (callback) => {
        callbacks.push(callback);
        return () => undefined;
      },
      retryDelaysMs: [1],
      reconcile: async () => {
        throw new Error('unavailable');
      },
      diagnostic,
    });
    registry.observe({ sessionId: 's', occurredAt: at, kind: 'turnStarted' });
    callbacks.shift()?.();
    await Promise.resolve();
    callbacks.shift()?.();
    await Promise.resolve();
    expect(diagnostic).toHaveBeenCalledTimes(1);
  });
  it.each(['dispose', 'suspend', 'disconnected'] as const)(
    'cancels scheduled activity on %s lifecycle',
    (operation) => {
      let cancelled = 0;
      const registry = new AgentActivityRegistry(() => {}, {
        schedule: () => () => {
          cancelled += 1;
        },
        reconcile: async () => undefined,
      });
      registry.observe({ sessionId: 's', occurredAt: at, kind: 'turnStarted' });
      if (operation === 'dispose') registry.dispose('s');
      else if (operation === 'suspend') registry.suspend('s');
      else registry.disconnected('s', at);
      expect(cancelled).toBeGreaterThan(0);
    },
  );
  it('suppresses late reconcile failure after disposal', async () => {
    let reject: (error: Error) => void = () => undefined;
    const diagnostic = vi.fn();
    const registry = new AgentActivityRegistry(() => {}, {
      diagnostic,
      reconcile: () =>
        new Promise<void>((_, fail) => {
          reject = fail;
        }),
    });
    const refresh = registry.refresh('s');
    await vi.waitFor(() => expect(reject).toBeTypeOf('function'));
    registry.dispose('s');
    reject(new Error('late'));
    await refresh;
    expect(diagnostic).not.toHaveBeenCalled();
    expect(registry.snapshot('s', at).root.state).toBe('disconnected');
  });
  it('does not resurrect a disposed session from an already-dispatched stale callback', async () => {
    let callback: (() => void) | undefined;
    const publish = vi.fn();
    const reconcile = vi.fn(async () => undefined);
    const registry = new AgentActivityRegistry(publish, {
      now: () => at,
      schedule: (scheduled) => {
        callback = scheduled;
        return () => undefined;
      },
      reconcile,
    });
    registry.observe({ sessionId: 's', occurredAt: at, kind: 'turnStarted' });
    publish.mockClear();

    registry.dispose('s');
    callback?.();
    await Promise.resolve();

    expect(reconcile).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(registry.snapshot('s', at).root.state).toBe('disconnected');
  });
  it('qualifies missing collaboration child metadata without stopping root work', () => {
    const registry = new AgentActivityRegistry(() => {});
    registry.observe({ sessionId: 's', occurredAt: at, kind: 'turnStarted' });
    const snapshot = registry.observe({
      sessionId: 's',
      occurredAt: '2026-01-01T00:00:01.000Z',
      kind: 'collaboration',
    });
    expect(snapshot).toMatchObject({
      root: { state: 'working', reason: 'missingCollaborationMetadata' },
      confidence: 'stale',
    });
  });
  it('recovers from disconnected on authoritative live activity', () => {
    const registry = new AgentActivityRegistry(() => {});
    registry.disconnected('s', at);
    const snapshot = registry.observe({
      sessionId: 's',
      occurredAt: '2026-01-01T00:00:01.000Z',
      kind: 'turnStarted',
    });
    expect(snapshot).toMatchObject({ root: { state: 'working' }, confidence: 'fresh' });
  });
  it('keeps newer live work when a prior reconcile finishes late', async () => {
    let release: (() => void) | undefined;
    const publish = vi.fn();
    const registry = new AgentActivityRegistry(publish, {
      now: () => at,
      reconcile: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    const pending = registry.refresh('s');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    registry.observe({
      sessionId: 's',
      occurredAt: '2026-01-01T00:00:01.000Z',
      kind: 'turnStarted',
    });
    publish.mockClear();
    release!();
    await pending;
    expect(registry.snapshot('s', at).root.state).toBe('working');
    expect(publish).not.toHaveBeenCalled();
  });
  it('starts a fresh reconcile after process exit while an obsolete read is still pending', async () => {
    const release: Array<() => void> = [];
    const publish = vi.fn();
    let calls = 0;
    const registry = new AgentActivityRegistry(publish, {
      now: () => at,
      reconcile: () =>
        new Promise<void>((resolve) => {
          calls += 1;
          release.push(resolve);
        }),
    });
    const first = registry.refresh('s');
    await vi.waitFor(() => expect(calls).toBe(1));
    registry.disconnected('s', at);
    const second = registry.refresh('s');
    await vi.waitFor(() => expect(calls).toBe(2));
    registry.observe({
      sessionId: 's',
      occurredAt: '2026-01-01T00:00:01.000Z',
      kind: 'turnStarted',
    });
    release[1]!();
    await second;
    expect(registry.snapshot('s', at)).toMatchObject({
      confidence: 'fresh',
      root: { state: 'working' },
    });
    publish.mockClear();
    release[0]!();
    await first;
    expect(publish).not.toHaveBeenCalled();
  });
});
