/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it, vi } from 'vitest';
import { ManagedUpgrade } from './managed-upgrade.js';

const environment = {
  GESTALT_MOBILE_PID: String(process.pid),
  GESTALT_MOBILE_RESTART_STATE: '/managed/run/mobile.restart',
};

describe('managed upgrade', () => {
  it('schedules one detached manager update across concurrent requests and detects worker failure', async () => {
    let complete!: () => void;
    const run = vi.fn(
      () =>
        new Promise<{ stdout: string; stderr: string }>((resolve) => {
          complete = () => resolve({ stdout: '', stderr: '' });
        }),
    );
    const exists = vi.fn(async () => true);
    const upgrade = new ManagedUpgrade('/workspace', environment, run, exists);
    const first = upgrade.start();
    const second = upgrade.start();
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    complete();
    const [one, two] = await Promise.all([first, second]);
    expect(one).toEqual(two);
    expect(one.phase).toBe('updating');
    expect(run).toHaveBeenCalledWith(
      'gestalt',
      ['update-restart'],
      expect.objectContaining({ cwd: '/workspace', env: environment }),
    );
    await upgrade.start();
    expect(run).toHaveBeenCalledOnce();
    exists.mockResolvedValue(false);
    expect((await upgrade.status()).phase).toBe('failed');
    expect(exists).toHaveBeenCalledWith('/managed/run/update-restart.lock');
  });

  it('rejects unmanaged launches and permits retry after a scheduling failure', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('failed'))
      .mockResolvedValue({ stdout: '', stderr: '' });
    await expect(new ManagedUpgrade('/workspace', {}, run).start()).rejects.toThrow('managed');
    expect(run).not.toHaveBeenCalled();
    const upgrade = new ManagedUpgrade('/workspace', environment, run, async () => true);
    await expect(upgrade.start()).rejects.toThrow('schedule');
    expect((await upgrade.status()).phase).toBe('failed');
    expect((await upgrade.start()).phase).toBe('updating');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('assigns a new identity after process composition restarts', async () => {
    expect((await new ManagedUpgrade('/workspace').status()).instanceId).not.toBe(
      (await new ManagedUpgrade('/workspace').status()).instanceId,
    );
  });
});
