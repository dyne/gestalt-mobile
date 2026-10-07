/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import {
  fileLineReference,
  linkedLocalFiles,
  localFilePathFromHref,
  localFileReferenceFromHref,
} from './local-file-link.js';
describe('local file links', () => {
  it.each([
    ['/tmp/trace.json', '/tmp/trace.json'],
    ['/home/me/app.ts:12:3', '/home/me/app.ts'],
    ['/home/me/app.ts#L12C3', '/home/me/app.ts'],
    ['/home/me/My%20Report.md:3', '/home/me/My Report.md'],
    ['./docs/README.md', './docs/README.md'],
    ['README.md:12', 'README.md'],
    ['file:///tmp/trace.json', '/tmp/trace.json'],
    ['https://example.com/a.json', null],
    ['//example.com/a.json', null],
    ['javascript:alert(1)', null],
    ['file://remote/tmp/a.json', null],
    ['#heading', null],
    ['/tmp/%00.json', null],
    ['/tmp/%ZZ.json', null],
  ])('recognizes %s', (href, expected) => expect(localFilePathFromHref(href)).toBe(expected));
  it.each([
    ['/tmp/a.ts:12', { path: '/tmp/a.ts', line: 12 }],
    ['/tmp/a.ts:12:3', { path: '/tmp/a.ts', line: 12 }],
    ['/tmp/a.ts#L12C3', { path: '/tmp/a.ts', line: 12 }],
    ['/tmp/a.ts:0', { path: '/tmp/a.ts' }],
    ['/tmp/a.ts:999999999999999999999', { path: '/tmp/a.ts' }],
  ])('retains source locations in %s', (path, expected) => {
    expect(fileLineReference(path)).toEqual(expected);
    expect(localFileReferenceFromHref(path)).toEqual(expected);
  });
  it('retains a line fragment on a file URL', () => {
    expect(localFileReferenceFromHref('file:///tmp/a.ts#L12')).toEqual({
      path: '/tmp/a.ts',
      line: 12,
    });
  });
  it('preserves decoded paths containing a literal percent', () => {
    expect(localFilePathFromHref('/tmp/100%.md', false)).toBe('/tmp/100%.md');
  });
  it('finds links with spaces and line references', () => {
    expect(
      linkedLocalFiles(
        '[Report](</tmp/My Report.md:3>) [Trace](/tmp/trace.json) [Web](https://example.com)',
      ),
    ).toEqual(['/tmp/My Report.md', '/tmp/trace.json']);
  });
});
