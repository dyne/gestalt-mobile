/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import {
  canUseDestination,
  idleTransfer,
  pickDestination,
  startTransfer,
  submitTransfer,
  transferConflict,
  transferFailed,
} from './transfer-state.js';

describe('transfer state', () => {
  it('moves through picking, submission, conflict, and retryable failure', () => {
    const picking = startTransfer('copy', 'folder/photo.jpg');
    const selected = pickDestination(picking, 'archive');
    const submitting = submitTransfer(selected);
    expect(transferConflict(submitting, true)).toMatchObject({
      phase: 'conflict',
      replaceAllowed: true,
    });
    expect(transferFailed(submitting)).toMatchObject({
      phase: 'failed',
      source: 'folder/photo.jpg',
    });
    expect(submitTransfer(idleTransfer)).toBe(idleTransfer);
  });

  it('guides users away from same-parent moves and descendant destinations', () => {
    const move = startTransfer('move', 'folder/nested');
    expect(canUseDestination(move, 'folder')).toBe(false);
    expect(canUseDestination(move, 'folder/nested/child')).toBe(false);
    expect(canUseDestination(move, 'elsewhere')).toBe(true);
    expect(canUseDestination(startTransfer('copy', 'folder/nested'), 'folder')).toBe(true);
  });
});
