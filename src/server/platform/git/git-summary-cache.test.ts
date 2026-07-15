import { describe, expect, it } from 'vitest';

import { GitSummaryCache } from './git-summary-cache.js';

describe('GitSummaryCache', () => {
  it('reuses a successful summary until invalidated', async () => {
    let reads = 0;
    const cache = new GitSummaryCache(async () => ({ value: ++reads }));

    await expect(cache.inspect('/workspace')).resolves.toEqual({ value: 1 });
    await expect(cache.inspect('/workspace')).resolves.toEqual({ value: 1 });
    cache.invalidate('/workspace');
    await expect(cache.inspect('/workspace')).resolves.toEqual({ value: 2 });
  });

  it('does not cache a failed inspection', async () => {
    let reads = 0;
    const cache = new GitSummaryCache(async () => {
      reads += 1;
      if (reads === 1) throw new Error('git unavailable');
      return { value: reads };
    });

    await expect(cache.inspect('/workspace')).rejects.toThrow('git unavailable');
    await expect(cache.inspect('/workspace')).resolves.toEqual({ value: 2 });
  });
});
