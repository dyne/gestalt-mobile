import { describe, expect, it } from 'vitest';
import { systemClock } from './clock.js';
describe('systemClock', () => {
  it('provides a numeric current time', () =>
    expect(systemClock.now()).toEqual(expect.any(Number)));
});
