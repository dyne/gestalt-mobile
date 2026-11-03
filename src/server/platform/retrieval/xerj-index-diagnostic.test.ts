/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { xerjErrorSummary, xerjIndexDiagnostic } from './xerj-index-diagnostic.js';

describe('concise XERJ error causes', () => {
  it.each([
    ['[storage_error] corrupt segment', '[storage_error] corrupt segment'],
    [
      'Error: indexing failed\nCaused by:\n  unsupported compression format',
      'unsupported compression format',
    ],
    ['2026-11-03T07:00:00+00:00 decoder failed; latency 2s', 'decoder failed; latency'],
    [
      'watch: pass 702 FAILED after 0.1s: schema conflict: unsupported field type. Still watching for source changes.',
      'schema conflict: unsupported field type',
    ],
    [
      'Error: indexing failed\nCaused by: unsupported compression format\n    at worker (/private/job.ts:12)',
      'unsupported compression format',
    ],
    [
      {
        error: {
          reason: 'failed to parse field',
          caused_by: { reason: 'numeric value out of range' },
        },
        payload: 'private document',
      },
      'numeric value out of range',
    ],
    [
      JSON.stringify({
        error: { reason: 'segment checksum mismatch' },
        request: 'private document',
      }),
      'segment checksum mismatch',
    ],
    [
      'request failed: HTTP 401 https://user:password@private.example:9000/index?token=canary Authorization: Bearer canary',
      'request failed: HTTP 401 [endpoint]',
    ],
    [
      'cannot read /private/source.ts: permission denied after 3.1s traceId=abc',
      'cannot read [path]: permission denied',
    ],
    ['schema conflict; payload: private document contents', 'schema conflict'],
    ['decoder rejected "private document contents"', 'decoder rejected [redacted]'],
    ['2026-11-03T07:00:00Z worker failed in 21ms', 'worker failed'],
    [undefined, undefined],
    [{ payload: 'private document' }, undefined],
    ['{"error":"incomplete private payload', undefined],
  ])('reduces a native error to its useful cause', (input, expected) => {
    expect(xerjErrorSummary(input)).toBe(expected);
  });

  it.each([
    'api_key=canary-key',
    'password="canary password"',
    'token=canary-token',
    'Authorization: Bearer canary-token',
    'Cookie: session=canary-cookie',
    'SECRET_VALUE=canary-env',
    'Bearer canary-token',
    'github_pat_canarytoken',
    'sk-canarytoken',
    'https://user:canary-password@private.example?secret=canary-token',
    '"canary document"',
    '-----BEGIN PRIVATE KEY-----\ncanary-key\n-----END PRIVATE KEY-----',
  ])('redacts credential or content material: %s', (sensitive) => {
    const diagnostic = xerjIndexDiagnostic(`decoder failed; ${sensitive}`);
    expect(diagnostic.summary).toContain('decoder failed');
    expect(JSON.stringify(diagnostic)).not.toContain('canary');
  });

  it('bounds the cause and never copies arbitrary structured fields', () => {
    const diagnostic = xerjIndexDiagnostic({
      message: 'unsupported format '.repeat(1000),
      token: 'canary',
    });
    expect(diagnostic.summary?.length).toBeLessThanOrEqual(200);
    expect(JSON.stringify(diagnostic)).not.toContain('canary');
  });
});

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
    [{ message: 'timeout' }, 'timeout'],
  ])('classifies %j while retaining only its redacted summary', (message, code) => {
    const diagnostic = xerjIndexDiagnostic(message);
    expect(diagnostic.code).toBe(code);
    expect(Object.keys(diagnostic).sort()).toEqual([
      'code',
      'id',
      'messageDigest',
      'occurredAt',
      ...(diagnostic.summary ? ['summary'] : []),
      ...(diagnostic.watchPass ? ['watchPass'] : []),
    ]);
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
