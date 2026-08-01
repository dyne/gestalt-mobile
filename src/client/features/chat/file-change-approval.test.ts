/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { readFileChangeApproval } from './file-change-approval.js';

describe('file change approval', () => {
  it('preserves every supplied file path as plain text', () => {
    expect(readFileChangeApproval({ changes: [{ path: 'src/a.ts' }, { path: '<script>.ts' }] })).toEqual([
      'src/a.ts',
      '<script>.ts',
    ]);
  });

  it('rejects missing or malformed details', () => {
    expect(readFileChangeApproval({})).toBeNull();
    expect(readFileChangeApproval({ changes: [] })).toBeNull();
    expect(readFileChangeApproval({ changes: [{ path: 'a.ts' }, { path: 4 }] })).toBeNull();
  });
});
