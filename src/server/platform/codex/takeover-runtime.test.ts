/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { CodexSessionRuntime } from './session-runtime.js';
import { RelaySession } from '../../features/sessions/model/relay-session.js';

describe('takeover writer quiescence', () => {
  async function fixture(
    options: {
      refusesInterrupt?: boolean;
      refusesTermination?: boolean;
      unloaded?: boolean;
      unrelated?: boolean;
      holdTermination?: boolean;
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
                id: p.threadId,
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
          if (method === 'thread/backgroundTerminals/list')
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
