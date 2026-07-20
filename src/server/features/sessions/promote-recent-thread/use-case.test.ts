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
  it('persists a recent thread, resumes it, and persists its active state', async () => {
    const save = vi.fn();
    const restore = vi.fn(async (session: RelaySessionSnapshot) => ({
      ...session,
      state: 'ready' as const,
      desiredState: 'active' as const,
    }));

    const promoted = await promoteRecentThread(
      { id: 'thread-1', cwd: '/work/project', profile: 'work', recencyAt: 100 },
      {
        createId: () => 'session-1',
        now: () => now,
        list: () => [],
        save,
        restore,
      },
    );

    expect(restore).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'session-1',
        threadId: 'thread-1',
        workspacePath: '/work/project',
        profile: 'work',
        state: 'stopped',
      }),
    );
    expect(save).toHaveBeenCalledTimes(2);
    expect(promoted.state).toBe('ready');
  });

  it('reuses a managed running session for the same Codex thread', async () => {
    const existing = {
      id: 'session-1',
      threadId: 'thread-1',
      state: 'ready',
    } as RelaySessionSnapshot;
    const restore = vi.fn();

    const promoted = await promoteRecentThread(
      { id: 'thread-1', cwd: '/work/project', profile: 'work', recencyAt: 100 },
      {
        createId: () => 'unused',
        now: () => now,
        list: () => [existing],
        save: vi.fn(),
        restore,
      },
    );

    expect(promoted).toBe(existing);
    expect(restore).not.toHaveBeenCalled();
  });
});
