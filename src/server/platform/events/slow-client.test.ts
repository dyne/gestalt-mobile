import { describe, expect, it } from 'vitest';
import { isSlowClient, slowClientLimitBytes } from './slow-client.js';
describe('isSlowClient', () => {
  it('cuts off clients over the one-megabyte queue limit', () =>
    expect(isSlowClient(slowClientLimitBytes + 1)).toBe(true));
});
