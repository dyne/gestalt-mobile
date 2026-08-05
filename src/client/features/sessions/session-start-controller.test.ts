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
});
