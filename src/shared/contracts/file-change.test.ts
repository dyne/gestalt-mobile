/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { countDiffLines } from './file-change.js';

describe('countDiffLines', () => {
  it('counts changed content without counting unified-diff headers', () => {
    expect(
      countDiffLines(
        '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,3 @@\n-old\n+new\n+another\n context\n',
      ),
    ).toEqual({ additions: 2, deletions: 1 });
  });
});
