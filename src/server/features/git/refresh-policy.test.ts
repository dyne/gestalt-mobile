import { describe, expect, it } from 'vitest';
import { mayFetch } from './refresh-policy.js';
describe('mayFetch', () => {
  it('throttles repeated fetches', () => {
    expect(mayFetch(1000, 2000)).toBe(false);
    expect(mayFetch(1000, 61000)).toBe(true);
  });
});
