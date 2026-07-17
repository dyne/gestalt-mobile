/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { GitFetchCoordinator } from './git-fetch-coordinator.js';

describe('GitFetchCoordinator', () => {
  it('throttles a successful fetch for the same workspace', async () => {
    let now = 1_000;
    let calls = 0;
    const coordinator = new GitFetchCoordinator(
      async () => {
        calls += 1;
      },
      () => now,
    );

    await coordinator.refresh('/workspace');
    expect(coordinator.lastSuccessfulAt('/workspace')).toBe(1_000);
    now = 2_000;
    await coordinator.refresh('/workspace');
    now = 61_000;
    await coordinator.refresh('/workspace');

    expect(calls).toBe(2);
  });

  it('coalesces concurrent refreshes for the same workspace', async () => {
    let release: (() => void) | undefined;
    let calls = 0;
    const coordinator = new GitFetchCoordinator(
      () =>
        new Promise<void>((resolve) => {
          calls += 1;
          release = resolve;
        }),
      () => 1_000,
    );

    const first = coordinator.refresh('/workspace');
    const second = coordinator.refresh('/workspace');
    expect(calls).toBe(1);
    release?.();
    await Promise.all([first, second]);
  });

  it('allows a retry after a failed fetch', async () => {
    let calls = 0;
    const coordinator = new GitFetchCoordinator(async () => {
      calls += 1;
      if (calls === 1) throw new Error('fetch failed');
    });

    await expect(coordinator.refresh('/workspace')).rejects.toThrow('fetch failed');
    await coordinator.refresh('/workspace');

    expect(calls).toBe(2);
  });

  it('retains the last successful fetch timestamp when a later fetch fails', async () => {
    let now = 1_000;
    let shouldFail = false;
    const coordinator = new GitFetchCoordinator(
      async () => {
        if (shouldFail) throw new Error('fetch failed');
      },
      () => now,
    );

    await coordinator.refresh('/workspace');
    now = 61_000;
    shouldFail = true;
    await expect(coordinator.refresh('/workspace')).rejects.toThrow('fetch failed');

    expect(coordinator.lastSuccessfulAt('/workspace')).toBe(1_000);
  });
});
