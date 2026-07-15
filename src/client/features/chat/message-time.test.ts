import { describe, expect, it } from 'vitest';

import { formatElapsedAfter } from './message-time.js';

describe('formatElapsedAfter', () => {
  it('formats a compact elapsed time after the preceding message', () => {
    const start = Date.UTC(2026, 6, 15, 12, 0, 0);
    expect(formatElapsedAfter(start, start + 2 * 60 * 1000)).toBe('2 minutes later');
    expect(formatElapsedAfter(start, start + 30 * 60 * 1000)).toBe('30 minutes later');
    expect(formatElapsedAfter(start, start + 2 * 60 * 60 * 1000)).toBe('2 hours later');
  });
});
