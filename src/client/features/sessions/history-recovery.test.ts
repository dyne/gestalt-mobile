/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { getHistoryWithRecovery } from './history-recovery.js';

describe('getHistoryWithRecovery', () => {
  it('restores a session once when its active Codex process is absent', async () => {
    let historyReads = 0;
    const restored = { id: 'session-1', state: 'ready' };
    const result = await getHistoryWithRecovery(
      {
        getHistory: async () => {
          historyReads += 1;
          if (historyReads === 1)
            throw Object.assign(new Error('history unavailable'), {
              code: 'SESSION_HISTORY_UNAVAILABLE',
            });
          return { items: [{ id: 'message-1', kind: 'agent' }] };
        },
        restoreSession: async () => restored,
      },
      'session-1',
    );
    expect(result).toEqual({
      history: { items: [{ id: 'message-1', kind: 'agent' }] },
      restored,
    });
    expect(historyReads).toBe(2);
  });

  it('does not restore after an unrelated history failure', async () => {
    let restored = false;
    await expect(
      getHistoryWithRecovery(
        {
          getHistory: async () => {
            throw new Error('network failure');
          },
          restoreSession: async () => {
            restored = true;
            return { id: 'session-1', state: 'ready' };
          },
        },
        'session-1',
      ),
    ).rejects.toThrow('network failure');
    expect(restored).toBe(false);
  });
});
