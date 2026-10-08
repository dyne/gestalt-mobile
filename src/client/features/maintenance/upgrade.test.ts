/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it, vi } from 'vitest';
import { waitForUpgrade } from './upgrade.js';

describe('upgrade reconnection', () => {
  it('tolerates downtime and waits for a new instance rather than an old healthy server', async () => {
    const status = vi
      .fn()
      .mockResolvedValueOnce({ instanceId: 'old', phase: 'updating' })
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce({ instanceId: 'new', phase: 'idle' });
    await waitForUpgrade('old', status, new AbortController().signal, 1);
    expect(status).toHaveBeenCalledTimes(3);
  });

  it('reports worker failure and bounded reconnection expiry', async () => {
    await expect(
      waitForUpgrade(
        'old',
        async () => ({ instanceId: 'old', phase: 'failed', message: 'Update stopped' }),
        new AbortController().signal,
        1,
      ),
    ).rejects.toThrow('Update stopped');
    await expect(
      waitForUpgrade('old', vi.fn(), new AbortController().signal, 1, 0),
    ).rejects.toThrow('not reconnected');
  });

  it('stops polling when the view is destroyed', async () => {
    const controller = new AbortController();
    controller.abort();
    const status = vi.fn();
    await expect(waitForUpgrade('old', status, controller.signal, 1)).rejects.toThrow();
    expect(status).not.toHaveBeenCalled();
  });
});
