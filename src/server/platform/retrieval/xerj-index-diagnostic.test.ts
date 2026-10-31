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
    [
      'watch: pass 12 FAILED after 0.4s: private provider error. Still watching',
      'watch-pass-failed',
    ],
    [
      'watch: pass 0 FAILED after 0.2s: autoindex execution configuration changed since the committed generation; rebuild with a new --state-dir and a new --prefix',
      'rebuild-required',
    ],
    [
      'watch: the platform reported dropped events (watch queue overflow); re-hashing the whole tree for this pass',
      'watch-rescan',
    ],
    ['watch: pass 12 FAILED after 0.4s: connection refused', 'connection'],
    ['arbitrary private provider prose', 'unknown-warning'],
    [undefined, 'unknown-warning'],
    [{ message: 'timeout' }, 'unknown-warning'],
  ])('classifies %j without retaining native prose', (message, code) => {
    const diagnostic = xerjIndexDiagnostic(message);
    expect(diagnostic.code).toBe(code);
    expect(Object.keys(diagnostic).sort()).toEqual([
      'code',
      'id',
      'messageDigest',
      'occurredAt',
      ...(diagnostic.watchPass ? ['watchPass'] : []),
    ]);
    expect(JSON.stringify(diagnostic)).not.toContain('private provider prose');
  });

  it('retains pass number and duration independently of the classified cause', () => {
    expect(
      xerjIndexDiagnostic('watch: pass 12 FAILED after 0.4s: connection refused private-path'),
    ).toMatchObject({ code: 'connection', watchPass: { number: 12, durationSeconds: 0.4 } });
    expect(
      xerjIndexDiagnostic('watch: pass 999999999999999999999 FAILED after 0.4s: private'),
    ).not.toHaveProperty('watchPass');
    expect(xerjIndexDiagnostic('watch: pass 1 FAILED after 0..4s: private')).not.toHaveProperty(
      'watchPass',
    );
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
