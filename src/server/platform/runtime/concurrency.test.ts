import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from './concurrency.js';
describe('mapWithConcurrency', () => {
  it('runs every restoration task', async () => {
    const seen: number[] = [];
    await mapWithConcurrency([1, 2, 3], 2, async (value) => {
      seen.push(value);
    });
    expect(seen.sort()).toEqual([1, 2, 3]);
  });
});
