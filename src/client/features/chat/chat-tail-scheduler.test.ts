/* Copyright (C) 2026 Dyne.org foundation SPDX-License-Identifier: AGPL-3.0-or-later */
import { expect, it, vi } from 'vitest';
import { ChatTailScheduler } from './chat-tail-scheduler.js';
it('drops A commits after invalidation and accepts B initial work once', () => {
  const commits: Array<() => void> = [];
  const request = vi.fn();
  const scheduler = new ChatTailScheduler((fn) => commits.push(fn), request);
  scheduler.schedule('content');
  scheduler.invalidate();
  scheduler.schedule('initial');
  commits.forEach((fn) => fn());
  expect(request).toHaveBeenCalledExactlyOnceWith('initial');
  scheduler.schedule('explicit');
  scheduler.invalidate();
  commits.at(-1)?.();
  expect(request).toHaveBeenCalledOnce();
});
