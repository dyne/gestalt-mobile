import { describe, expect, it } from 'vitest';
import { reconnectDelay } from './session-state.js';
describe('reconnectDelay', () => {
  it('caps flaky-connection retry delay', () => expect(reconnectDelay(99, () => 0.5)).toBe(10000));
});
