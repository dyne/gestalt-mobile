import { describe, expect, it } from 'vitest';
import { reconnectDelay, turnReadiness } from './session-state.js';
describe('reconnectDelay', () => {
  it('caps flaky-connection retry delay', () => expect(reconnectDelay(99, () => 0.5)).toBe(10000));
});

describe('turnReadiness', () => {
  it('tells the user when Codex is working or ready for the next instruction', () => {
    expect(turnReadiness('turn-1')).toBe('Codex is working…');
    expect(turnReadiness(null)).toBe('Ready for your next instruction.');
  });
});
