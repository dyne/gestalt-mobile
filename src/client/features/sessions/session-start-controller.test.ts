/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it, vi } from 'vitest';
import { SessionStartController } from './session-start-controller.js';

describe('SessionStartController', () => {
  it('uses one key for a request and suppresses duplicate starts', async () => {
    let resolve!: (value: { id: string; state: string }) => void;
    const start = vi.fn(() => new Promise<{ id: string; state: string }>((done) => { resolve = done; }));
    const controller = new SessionStartController({ start }, () => 'start-key', vi.fn());
    const first = controller.start('workspace', {}); const duplicate = controller.start('workspace', {});
    resolve({ id: 'session', state: 'ready' });
    expect(await first).toMatchObject({ id: 'session' }); expect(await duplicate).toBeNull();
    expect(start).toHaveBeenCalledExactlyOnceWith('workspace', {}, 'start-key');
  });

  it('reuses a failed request key for a retry', async () => {
    const start = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ id: 'session', state: 'ready' });
    const key = vi.fn(() => 'retry-key');
    const controller = new SessionStartController({ start }, key, vi.fn());
    await controller.start('workspace', {});
    await controller.start('workspace', {});
    expect(key).toHaveBeenCalledOnce();
    expect(start).toHaveBeenNthCalledWith(1, 'workspace', {}, 'retry-key');
    expect(start).toHaveBeenNthCalledWith(2, 'workspace', {}, 'retry-key');
  });
});
