/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { xerjIndexDiagnostic } from './xerj-index-diagnostic.js';

describe('redacted XERJ indexing diagnostics', () => {
  it.each([
    ['new file: refusing ambiguous assignment', 'ambiguous-assignment'],
    ['bulk timed out', 'timeout'],
    ['request timeout', 'timeout'],
    ['unauthorized request', 'authentication'],
    ['connection refused', 'connection'],
    ['no space left on device', 'capacity'],
    ['arbitrary private provider prose', 'unknown-warning'],
    [undefined, 'unknown-warning'],
    [{ message: 'timeout' }, 'unknown-warning'],
  ])('classifies %j without retaining native prose', (message, code) => {
    const diagnostic = xerjIndexDiagnostic(message);
    expect(diagnostic.code).toBe(code);
    expect(Object.keys(diagnostic).sort()).toEqual(['code', 'id', 'messageDigest', 'occurredAt']);
    expect(JSON.stringify(diagnostic)).not.toContain('private provider prose');
  });

  it('correlates repeated warning content while giving each occurrence a unique identity', () => {
    const first = xerjIndexDiagnostic('timeout private-token');
    const second = xerjIndexDiagnostic('timeout private-token');
    expect(first.id).not.toBe(second.id);
    expect(first.messageDigest).toBe(second.messageDigest);
    expect(xerjIndexDiagnostic('x'.repeat(100_000)).messageDigest).toBe(
      xerjIndexDiagnostic('x'.repeat(16_384)).messageDigest,
    );
  });
});
