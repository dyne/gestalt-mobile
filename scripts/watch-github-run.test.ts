/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, it, vi } from 'vitest';
import { watchGithubRun } from './watch-github-run.mjs';

it('timestamps every poll and terminal result separately from upstream completion', async () => {
  const write = vi.fn();
  const wait = vi.fn(async () => {});
  const read = vi
    .fn()
    .mockResolvedValueOnce({
      status: 'in_progress',
      conclusion: '',
      updatedAt: '2026-10-18T10:07:00Z',
    })
    .mockResolvedValueOnce({
      status: 'completed',
      conclusion: 'success',
      updatedAt: '2026-10-18T10:52:31Z',
      stdout: 'private output',
    });
  const now = vi
    .fn()
    .mockReturnValueOnce('2026-10-18T10:07:02Z')
    .mockReturnValueOnce('2026-10-18T10:52:45Z');
  expect(
    await watchGithubRun({
      repository: 'dyne/gestalt-mobile',
      runId: '39117261369',
      read,
      wait,
      now,
      write,
    }),
  ).toBe(0);
  expect(wait).toHaveBeenCalledOnce();
  expect(write.mock.calls.map(([record]) => record)).toEqual([
    {
      event: 'githubRunObserved',
      observedAt: '2026-10-18T10:07:02Z',
      runId: '39117261369',
      status: 'in_progress',
      conclusion: null,
      upstreamUpdatedAt: '2026-10-18T10:07:00.000Z',
    },
    {
      event: 'githubRunObserved',
      observedAt: '2026-10-18T10:52:45Z',
      runId: '39117261369',
      status: 'completed',
      conclusion: 'success',
      upstreamUpdatedAt: '2026-10-18T10:52:31.000Z',
    },
  ]);
});

it.each(['failure', 'cancelled', 'timed_out'])(
  'exits unsuccessfully for %s',
  async (conclusion) => {
    expect(
      await watchGithubRun({
        repository: 'dyne/gestalt-mobile',
        runId: '1',
        read: async () => ({ status: 'completed', conclusion }),
        write: vi.fn(),
      }),
    ).toBe(1);
  },
);

it('records a timestamped observation failure without leaking command diagnostics', async () => {
  const write = vi.fn();
  expect(
    await watchGithubRun({
      repository: 'dyne/gestalt-mobile',
      runId: '1',
      read: async () => {
        throw new Error('private token');
      },
      now: () => '2026-10-18T10:07:00Z',
      write,
    }),
  ).toBe(1);
  expect(write).toHaveBeenCalledWith({
    event: 'githubRunObservationFailed',
    observedAt: '2026-10-18T10:07:00Z',
    runId: '1',
  });
});
