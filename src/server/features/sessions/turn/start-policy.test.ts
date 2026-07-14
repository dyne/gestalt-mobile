import { describe, expect, it } from 'vitest';
import { mayStartTurn } from './start-policy.js';
describe('mayStartTurn', () => {
  it('prevents blank or concurrent turns', () => {
    expect(mayStartTurn('ready', ' ')).toBe(false);
    expect(mayStartTurn('turnActive', 'hello')).toBe(false);
  });
});
