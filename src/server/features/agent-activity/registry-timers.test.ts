/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it, vi } from 'vitest';
import { AgentActivityRegistry } from './registry.js';

const at = '2026-01-01T00:00:00.000Z';
const operations = ['dispose', 'suspend', 'disconnected'] as const;
type Operation = (typeof operations)[number];
function retire(registry: AgentActivityRegistry, operation: Operation) {
  if (operation === 'disconnected') registry.disconnected('s', at);
  else registry[operation]('s');
}
function scheduler() {
  const entries: Array<{ callback: () => void; active: boolean }> = [];
  return {
    entries,
    schedule(callback: () => void) {
      const entry = { callback, active: true };
      entries.push(entry);
      return () => {
        entry.active = false;
      };
    },
    fire(index: number) {
      // Invoke even cancelled callbacks to model already-dispatched work.
      entries[index]!.active = false;
      entries[index]!.callback();
    },
    active: () => entries.filter((entry) => entry.active).length,
  };
}

describe('agent activity timer ownership', () => {
  it.each(operations)(
    'releases actual Node timeouts after observe, foreground refresh and %s',
    async (operation) => {
      const timers = new Set<ReturnType<typeof setTimeout>>();
      const registry = new AgentActivityRegistry(() => {}, {
        now: () => at,
        schedule: (callback, delayMs) => {
          const timer = setTimeout(callback, delayMs);
          timers.add(timer);
          return () => {
            clearTimeout(timer);
            timers.delete(timer);
          };
        },
        reconcile: async () => {
          // Production reconciliation can publish a replacement observation.
          registry.observe({ sessionId: 's', occurredAt: at, kind: 'turnCompleted' });
          return true;
        },
      });
      try {
        registry.observe({ sessionId: 's', occurredAt: at, kind: 'turnCompleted' });
        expect(timers.size).toBe(1);
        await registry.refresh('s');
        expect(timers.size).toBe(1);
        expect([...timers][0]!.hasRef()).toBe(true);
        retire(registry, operation);
        expect(timers.size).toBe(0);
      } finally {
        registry.dispose('s');
        // A red regression must not leak its deliberately referenced timers.
        for (const timer of timers) clearTimeout(timer);
      }
    },
  );

  it('cancels the old timeout before coalesced foreground reads and fences its dispatched callback', async () => {
    const scheduled = scheduler();
    const result = Promise.withResolvers<boolean>();
    const reconcile = vi.fn(() => result.promise);
    const registry = new AgentActivityRegistry(() => {}, { ...scheduled, reconcile });
    registry.observe({ sessionId: 's', occurredAt: at, kind: 'turnCompleted' });
    const first = registry.refresh('s');
    expect(registry.refresh('s')).toBe(first);
    expect(scheduled.active()).toBe(0);
    registry.observe({ sessionId: 's', occurredAt: at, kind: 'turnStarted' });
    scheduled.fire(0);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(scheduled.active()).toBe(1);
    result.resolve(true);
    await first;
    expect(registry.snapshot('s', at).root.state).toBe('working');
    registry.dispose('s');
    expect(scheduled.active()).toBe(0);
  });

  it('consumes a fired retry without settling the shared refresh until its read finishes', async () => {
    const scheduled = scheduler();
    const result = Promise.withResolvers<boolean>();
    const reconcile = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockImplementationOnce(() => result.promise);
    const registry = new AgentActivityRegistry(() => {}, {
      ...scheduled,
      retryDelaysMs: [1],
      reconcile,
    });
    let settled = false;
    const refresh = registry.refresh('s');
    void refresh.then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(scheduled.entries).toHaveLength(1));
    scheduled.fire(0);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(registry.refresh('s')).toBe(refresh);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(scheduled.active()).toBe(0);
    result.resolve(true);
    await refresh;
    expect(registry.snapshot('s', at).confidence).toBe('fresh');
    registry.dispose('s');
  });

  it.each(operations)(
    'settles a pending retry on %s and ignores its dispatched callback',
    async (operation) => {
      const scheduled = scheduler();
      const reconcile = vi.fn(async () => false);
      const diagnostic = vi.fn();
      const registry = new AgentActivityRegistry(() => {}, {
        ...scheduled,
        retryDelaysMs: [1],
        reconcile,
        diagnostic,
      });
      const refresh = registry.refresh('s');
      await vi.waitFor(() => expect(scheduled.active()).toBe(1));
      retire(registry, operation);
      await refresh;
      scheduled.fire(0);
      await Promise.resolve();
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(diagnostic).not.toHaveBeenCalled();
      expect(scheduled.active()).toBe(0);
      registry.dispose('s');
    },
  );

  it('keeps a replacement timer when an obsolete retry callback arrives after restart', async () => {
    const scheduled = scheduler();
    const reconcile = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const registry = new AgentActivityRegistry(() => {}, { ...scheduled, reconcile });
    const first = registry.refresh('s');
    await vi.waitFor(() => expect(scheduled.active()).toBe(1));
    registry.suspend('s');
    await first;
    await registry.refresh('s');
    registry.observe({ sessionId: 's', occurredAt: at, kind: 'turnStarted' });
    scheduled.fire(0);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(scheduled.active()).toBe(1);
    registry.dispose('s');
    expect(scheduled.active()).toBe(0);
  });

  it('fences late failed reads without cancelling the next generation timer', async () => {
    const scheduled = scheduler();
    const old = Promise.withResolvers<boolean>();
    const reconcile = vi
      .fn()
      .mockImplementationOnce(() => old.promise)
      .mockResolvedValueOnce(true);
    const diagnostic = vi.fn();
    const registry = new AgentActivityRegistry(() => {}, { ...scheduled, reconcile, diagnostic });
    registry.observe({ sessionId: 's', occurredAt: at, kind: 'turnCompleted' });
    const first = registry.refresh('s');
    registry.suspend('s');
    await registry.refresh('s');
    registry.observe({ sessionId: 's', occurredAt: at, kind: 'turnStarted' });
    old.reject(new Error('obsolete read'));
    await first;
    expect(scheduled.active()).toBe(1);
    expect(diagnostic).not.toHaveBeenCalled();
    expect(registry.snapshot('s', at).root.state).toBe('working');
    registry.dispose('s');
  });

  it.each(operations)('lets a synchronous observation subscriber %s its timer', (operation) => {
    const scheduled = scheduler();
    let retired = false;
    const registry = new AgentActivityRegistry(
      () => {
        if (retired) return;
        retired = true;
        retire(registry, operation);
      },
      { ...scheduled, reconcile: async () => true },
    );
    registry.observe({ sessionId: 's', occurredAt: at, kind: 'turnCompleted' });
    expect(scheduled.active()).toBe(0);
    registry.dispose('s');
  });

  it.each(operations)(
    'does not start a read retired by a synchronous reconciling %s subscriber',
    async (operation) => {
      const reconcile = vi.fn(async () => true);
      let retired = false;
      const registry = new AgentActivityRegistry(
        (snapshot) => {
          if (retired || snapshot.confidence !== 'reconciling') return;
          retired = true;
          retire(registry, operation);
        },
        { reconcile },
      );
      await registry.refresh('s');
      expect(reconcile).not.toHaveBeenCalled();
      registry.dispose('s');
    },
  );
});
