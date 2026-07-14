import { describe, expect, it } from 'vitest';
import { isInteractionKind } from './kind.js';
describe('isInteractionKind', () => {
  it('recognizes every mobile-interactive Codex request class', () =>
    expect(isInteractionKind('userInput')).toBe(true));
});
