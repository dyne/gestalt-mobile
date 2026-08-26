/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { initialiseUploads, MAX_UPLOAD_BYTES, nextUpload } from './upload-state.js';

describe('upload queue state', () => {
  it('preserves picker order and rejects only individually oversized files', () => {
    const files = [
      new File([''], 'empty.bin'),
      new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], 'large.bin'),
    ];
    const outcomes = initialiseUploads(files);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['queued', 'too-large']);
    expect(nextUpload(outcomes)).toBe(0);
  });
});
