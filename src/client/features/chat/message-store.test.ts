/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { appendUserMessage, applyDelta, completeMessage } from './message-store.js';
describe('applyDelta', () => {
  it('accumulates a streamed assistant message', () => {
    expect(applyDelta(applyDelta([], 'm', 'hello'), 'm', ' world')[0]).toEqual({
      id: 'm',
      role: 'assistant',
      phase: 'commentary',
      text: 'hello world',
      complete: false,
    });
  });
});

it('marks a streamed assistant message complete without changing its text', () => {
  expect(
    completeMessage(
      [{ id: 'assistant-session', role: 'assistant', text: 'Done', complete: false }],
      'assistant-session',
    ),
  ).toEqual([{ id: 'assistant-session', role: 'assistant', text: 'Done', complete: true }]);
});

it('adds each accepted user prompt to the local transcript', () => {
  expect(
    appendUserMessage(
      [{ id: 'user-1', role: 'user', text: 'First prompt', complete: true }],
      'user-2',
      'Second prompt',
    ),
  ).toEqual([
    { id: 'user-1', role: 'user', text: 'First prompt', complete: true },
    { id: 'user-2', role: 'user', text: 'Second prompt', complete: true },
  ]);
});
