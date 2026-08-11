/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { expect, it, vi } from 'vitest';
import { ChatFollowTail } from './chat-follow-tail.js';

it('coalesces follow-tail work, respects reading state, and cancels stale frames', () => {
  let frame: FrameRequestCallback | undefined;
  const scrollTail = vi.fn();
  const coordinator = new ChatFollowTail({
    requestFrame: vi.fn((callback) => ((frame = callback), 1)),
    cancelFrame: vi.fn(),
    reducedMotion: () => false,
    scrollTail,
  });
  coordinator.request('content');
  coordinator.request('content');
  expect(frame).toBeTypeOf('function');
  frame?.(0);
  expect(scrollTail).toHaveBeenCalledOnce();
  coordinator.observeTail(false);
  coordinator.request('content');
  expect(scrollTail).toHaveBeenCalledOnce();
  coordinator.request('explicit');
  coordinator.cancel();
  expect(scrollTail).toHaveBeenCalledOnce();
});

it('uses non-animated scrolling for reduced motion and initial positioning', () => {
  let frame: FrameRequestCallback | undefined;
  const scrollTail = vi.fn();
  const coordinator = new ChatFollowTail({
    requestFrame: (callback) => ((frame = callback), 1),
    cancelFrame: () => {},
    reducedMotion: () => true,
    scrollTail,
  });
  coordinator.request('initial');
  frame?.(0);
  expect(scrollTail).toHaveBeenCalledWith('auto');
});
