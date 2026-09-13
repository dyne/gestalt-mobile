/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it, vi } from 'vitest';

import { GestaltUpdateRestartScheduler } from './gestalt-update-restart.js';

describe('GestaltUpdateRestartScheduler', () => {
  it('runs the manager live-update command without a shell', async () => {
    const run = vi.fn(async () => undefined);
    const scheduler = new GestaltUpdateRestartScheduler(run);

    await scheduler.schedule();

    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(
      'gestalt',
      ['update-restart'],
      expect.objectContaining({ env: process.env, timeout: 15_000, maxBuffer: 64 * 1024 }),
    );
  });

  it('replaces command failures with a safe error', async () => {
    const scheduler = new GestaltUpdateRestartScheduler(async () => {
      throw new Error('secret command output');
    });

    await expect(scheduler.schedule()).rejects.toThrow(
      'Gestalt update and restart could not be scheduled',
    );
  });
});
