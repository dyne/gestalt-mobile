/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it, vi } from 'vitest';

import type { RelaySessionSnapshot } from '../model/relay-session.js';
import { promoteRecentThread } from './use-case.js';

const now = '2026-07-17T12:00:00.000Z';

describe('promoteRecentThread', () => {
  it('validates a recent thread before persisting a detached readable session', async () => {
    const save = vi.fn();
    const read = vi.fn(async () => undefined);

    const promoted = await promoteRecentThread(
      { id: 'thread-1', cwd: '/work/project', profile: 'work', recencyAt: 100 },
      {
        createId: () => 'session-1',
        now: () => now,
        list: () => [],
        save,
        read,
      },
    );

    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'session-1',
        threadId: 'thread-1',
        workspacePath: '/work/project',
        profile: 'work',
        state: 'stopped',
      }),
    );
    expect(save).toHaveBeenCalledTimes(1);
    expect(promoted.state).toBe('stopped');
  });

  it('reuses a managed running session for the same Codex thread', async () => {
    const existing = {
      id: 'session-1',
      threadId: 'thread-1',
      state: 'ready',
    } as RelaySessionSnapshot;
    const read = vi.fn(async () => undefined);

    const promoted = await promoteRecentThread(
      { id: 'thread-1', cwd: '/work/project', profile: 'work', recencyAt: 100 },
      {
        createId: () => 'unused',
        now: () => now,
        list: () => [existing],
        save: vi.fn(),
        read,
      },
    );

    expect(promoted).toBe(existing);
    expect(read).toHaveBeenCalledWith(existing);
  });

  it('does not persist an unreadable recent thread', async () => {
    const save = vi.fn();
    await expect(
      promoteRecentThread(
        { id: 'thread-1', cwd: '/work/project', profile: 'work', recencyAt: 100 },
        {
          createId: () => 'session-1',
          now: () => now,
          list: () => [],
          save,
          read: async () => {
            throw new Error('unavailable');
          },
        },
      ),
    ).rejects.toThrow('RECENT_THREAD_HISTORY_UNAVAILABLE');
    expect(save).not.toHaveBeenCalled();
  });

  it('coalesces concurrent promotion and permits retry after a failed read', async () => {
    const save = vi.fn();
    let attempts = 0;
    const deps = {
      createId: () => 'session-1',
      now: () => now,
      list: () => [],
      save,
      read: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('offline');
      },
    };
    const thread = { id: 'thread-1', cwd: '/work/project', profile: 'work', recencyAt: 100 };
    await expect(
      Promise.all([promoteRecentThread(thread, deps), promoteRecentThread(thread, deps)]),
    ).rejects.toThrow('RECENT_THREAD_HISTORY_UNAVAILABLE');
    await expect(promoteRecentThread(thread, deps)).resolves.toMatchObject({ state: 'stopped' });
    expect(save).toHaveBeenCalledOnce();
  });

  it('leaves no orphan when persistence fails and retries cleanly', async () => {
    const persisted: RelaySessionSnapshot[] = [];
    let fail = true;
    const deps = {
      createId: () => 'session-1',
      now: () => now,
      list: () => persisted,
      read: async () => undefined,
      save: (session: RelaySessionSnapshot) => {
        if (fail) throw new Error('sqlite write failed');
        persisted.push(session);
      },
    };
    const thread = { id: 'thread-1', cwd: '/work/project', profile: 'work', recencyAt: 100 };
    await expect(promoteRecentThread(thread, deps)).rejects.toThrow('sqlite write failed');
    expect(persisted).toEqual([]);
    fail = false;
    await expect(promoteRecentThread(thread, deps)).resolves.toMatchObject({
      id: 'session-1',
      state: 'stopped',
    });
    expect(persisted).toHaveLength(1);
  });
});
