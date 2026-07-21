/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createToastQueue, toastTimeouts } from './toast-queue.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('toast queue', () => {
  it('enqueues and dismisses notifications', () => {
    const queue = createToastQueue();
    const id = queue.enqueue({ kind: 'info', message: 'Connected.' });

    expect(queue.snapshot()).toEqual([{ id, kind: 'info', message: 'Connected.', occurrences: 1 }]);
    queue.dismiss(id);
    expect(queue.snapshot()).toEqual([]);
  });

  it('deduplicates repeated failures by stable code', () => {
    const queue = createToastQueue();
    const first = queue.enqueue({ kind: 'error', code: 'RELAY_UNAVAILABLE', message: 'Offline.' });
    const repeated = queue.enqueue({
      kind: 'error',
      code: 'RELAY_UNAVAILABLE',
      message: 'Different unsafe detail.',
    });

    expect(repeated).toBe(first);
    expect(queue.snapshot()).toEqual([
      {
        id: first,
        kind: 'error',
        code: 'RELAY_UNAVAILABLE',
        message: 'Offline.',
        occurrences: 2,
      },
    ]);
  });

  it('keeps errors until dismissed', () => {
    const queue = createToastQueue();
    queue.enqueue({ kind: 'error', message: 'Persistent.' });

    vi.advanceTimersByTime(60_000);
    expect(queue.snapshot()).toHaveLength(1);
  });

  it.each([
    ['success', toastTimeouts.success],
    ['info', toastTimeouts.info],
  ] as const)('dismisses %s notifications after %dms', (kind, timeout) => {
    const queue = createToastQueue();
    queue.enqueue({ kind, message: 'Temporary.' });

    vi.advanceTimersByTime(timeout - 1);
    expect(queue.snapshot()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(queue.snapshot()).toEqual([]);
  });

  it('pauses independently for hover and focus', () => {
    const queue = createToastQueue();
    const id = queue.enqueue({ kind: 'success', message: 'Saved.' });
    vi.advanceTimersByTime(2_000);
    queue.pause(id, 'hover');
    queue.pause(id, 'focus');
    vi.advanceTimersByTime(10_000);
    queue.resume(id, 'hover');
    vi.advanceTimersByTime(10_000);
    expect(queue.snapshot()).toHaveLength(1);
    queue.resume(id, 'focus');
    vi.advanceTimersByTime(2_999);
    expect(queue.snapshot()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(queue.snapshot()).toEqual([]);
  });

  it('notifies subscribers with immutable snapshots', () => {
    const queue = createToastQueue();
    const listener = vi.fn();
    const unsubscribe = queue.subscribe(listener);
    queue.enqueue({ kind: 'info', message: 'Ready.' });
    unsubscribe();
    queue.enqueue({ kind: 'success', message: 'Saved.' });

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls[1]?.[0]).toHaveLength(1);
  });
});
