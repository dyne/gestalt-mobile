/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { describe, expect, it } from 'vitest';

import { consumeEnrollmentFragment } from './enrollment-fragment.js';

describe('enrollment fragment', () => {
  it('returns the raw ticket and synchronously removes it without changing query or path', () => {
    const replaced: string[] = [];
    const location = { hash: '#enroll=opaque%2Dticket', pathname: '/relay', search: '?view=auth' } as Location;
    const history = { state: { preserved: true }, replaceState: (_state: unknown, _title: string, url: string) => replaced.push(url) } as unknown as History;
    expect(consumeEnrollmentFragment(location, history)).toBe('opaque-ticket');
    expect(replaced).toEqual(['/relay?view=auth']);
  });

  it.each(['#enroll=', '#enroll=%E0%A4%A', '#enroll=one&other=two'])('scrubs malformed enrollment fragment %s without parsing it', (hash) => {
    const replacements: string[] = [];
    const history = { state: null, replaceState: (_state: unknown, _title: string, url: string) => replacements.push(url) } as unknown as History;
    expect(consumeEnrollmentFragment({ hash, pathname: '/relay', search: '?safe=1' } as Location, history)).toBeUndefined();
    expect(replacements).toEqual(['/relay?safe=1']);
  });
});
