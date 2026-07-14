import { describe, expect, it } from 'vitest';

import { fetchAge } from './fetch-age.js';

describe('fetch age', () => {
  it('uses a clear unavailable state and compact relative age', () => {
    expect(fetchAge(null, 120_000)).toBe('Not fetched yet');
    expect(fetchAge('1970-01-01T00:01:00.000Z', 120_000)).toBe('Fetched 1m ago');
  });
});
