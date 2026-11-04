/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import type { CleanTmpResult } from '../../../shared/contracts/tmp-cleanup.js';
import { cleanTmpFeedback } from './clean-tmp-feedback.js';

const empty = (): CleanTmpResult => ({
  status: 'complete',
  folders: { removed: 0, skipped: 0, failed: 0 },
  workspaces: { cleaned: 2, removed: 0, skipped: 0, failed: 0, unavailable: 0 },
  reasons: { protected: 0, busy: 0, lease: 0, unrecognized: 0, unsafe: 0, unavailable: 0, io: 0 },
});

describe('Clean TMP feedback', () => {
  it('reports a complete empty scan', () => {
    expect(cleanTmpFeedback(empty())).toEqual({
      kind: 'success',
      message: 'No temporary folders to remove.',
    });
  });
  it('reports one removed folder in one workspace', () => {
    const value = empty();
    expect(
      cleanTmpFeedback({
        ...value,
        folders: { ...value.folders, removed: 1 },
        workspaces: { ...value.workspaces, removed: 1 },
      }),
    ).toEqual({ kind: 'success', message: 'Removed 1 temporary folder in 1 workspace.' });
  });
  it('does not sum overlapping workspace categories or count protected folders twice', () => {
    const value = empty();
    expect(
      cleanTmpFeedback({
        ...value,
        folders: { removed: 2, skipped: 4, failed: 0 },
        workspaces: { cleaned: 0, removed: 2, skipped: 2, failed: 0, unavailable: 0 },
        reasons: { ...value.reasons, protected: 3, busy: 1 },
      }).message,
    ).toBe(
      'Removed 2 temporary folders in 2 workspaces. Kept 3 protected folders. Skipped 1 other folder.',
    );
  });
  it('explains protected-only cleanup without claiming deletion', () => {
    const value = empty();
    expect(
      cleanTmpFeedback({
        ...value,
        folders: { ...value.folders, skipped: 1 },
        reasons: { ...value.reasons, protected: 1 },
      }).message,
    ).toBe('No temporary folders removed. Kept 1 protected folder.');
  });
  it('keeps ambiguous legacy candidates in the skipped count', () => {
    const value = empty();
    expect(
      cleanTmpFeedback({
        ...value,
        folders: { ...value.folders, skipped: 2 },
        reasons: { ...value.reasons, unrecognized: 2 },
      }).message,
    ).toBe('No temporary folders removed. Skipped 2 other folders.');
  });
  it('reports removals alongside partial failures through the error channel', () => {
    const value = empty();
    expect(
      cleanTmpFeedback({
        ...value,
        status: 'partial',
        folders: { removed: 2, skipped: 0, failed: 1 },
        workspaces: { ...value.workspaces, removed: 1, failed: 1 },
        reasons: { ...value.reasons, io: 1 },
      }),
    ).toEqual({
      kind: 'error',
      message:
        'Cleanup incomplete. Removed 2 temporary folders in 1 workspace. Could not remove 1 folder. Try Clean TMP again.',
    });
  });
  it('reports an unavailable workspace without inventing a failed folder', () => {
    const value = empty();
    expect(
      cleanTmpFeedback({
        ...value,
        status: 'partial',
        workspaces: { ...value.workspaces, unavailable: 1 },
        reasons: { ...value.reasons, unavailable: 1 },
      }).message,
    ).toBe(
      'Cleanup incomplete. No temporary folders removed. Could not check 1 workspace. Try Clean TMP again.',
    );
  });
  it('explains discovery-only partial results without fabricating counts', () => {
    const value = empty();
    expect(
      cleanTmpFeedback({
        ...value,
        status: 'partial',
        reasons: { ...value.reasons, unavailable: 1 },
      }).message,
    ).toBe(
      'Cleanup incomplete. No temporary folders removed. Some locations could not be checked. Try Clean TMP again.',
    );
  });
  it('keeps unknown discovery scope distinct from a counted unavailable workspace', () => {
    const value = empty();
    expect(
      cleanTmpFeedback({
        ...value,
        status: 'partial',
        workspaces: { ...value.workspaces, unavailable: 1 },
        reasons: { ...value.reasons, unavailable: 2 },
      }).message,
    ).toBe(
      'Cleanup incomplete. No temporary folders removed. Could not check 1 workspace. Some locations could not be checked. Try Clean TMP again.',
    );
  });
});
