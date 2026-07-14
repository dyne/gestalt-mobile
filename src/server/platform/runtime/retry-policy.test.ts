import { describe, expect, it } from 'vitest';
import { recoveryDelay } from './retry-policy.js';
describe('recoveryDelay', () => {
  it('bounds recovery retries', () => {
    expect([recoveryDelay(0), recoveryDelay(1), recoveryDelay(2), recoveryDelay(3)]).toEqual([
      500,
      2000,
      5000,
      null,
    ]);
  });
});
