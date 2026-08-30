/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { summarizeChangedFiles } from './file-change-summary.js';

describe('summarizeChangedFiles', () => {
  it('lists each path once with cumulative counts and its latest touch time', () => {
    expect(
      summarizeChangedFiles([
        {
          id: 'first',
          label: 'File change · completed',
          detail: 'src/app.ts\nsrc/other.ts',
          occurredAt: 1_000,
          changes: [
            { path: 'src/app.ts', additions: 4, deletions: 1 },
            { path: 'src/other.ts', additions: 1, deletions: 0 },
          ],
        },
        {
          id: 'second',
          label: 'File change · completed',
          detail: 'src/app.ts',
          occurredAt: 4_000,
          changes: [{ path: 'src/app.ts', additions: 2, deletions: 3 }],
        },
      ]),
    ).toEqual([
      { path: 'src/app.ts', additions: 6, deletions: 4, touchedAt: 4_000 },
      { path: 'src/other.ts', additions: 1, deletions: 0, touchedAt: 1_000 },
    ]);
  });

  it('deduplicates legacy paths without fabricating line counts', () => {
    expect(
      summarizeChangedFiles([
        { id: 'one', label: 'File change', detail: 'old.ts', occurredAt: 1_000 },
        { id: 'two', label: 'File change', detail: 'old.ts', occurredAt: 2_000 },
      ]),
    ).toEqual([{ path: 'old.ts', additions: null, deletions: null, touchedAt: 2_000 }]);
  });
});
