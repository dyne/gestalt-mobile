import { describe, expect, it } from 'vitest';
import { interruptTurn } from './use-case.js';
describe('interruptTurn', () => {
  it('only interrupts the active turn', () => {
    expect(interruptTurn({ activeTurnId: 't' } as never, 'other')).toEqual({
      accepted: false,
      code: 'TURN_NOT_ACTIVE',
    });
  });
});
