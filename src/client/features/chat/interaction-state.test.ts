import { describe, expect, it } from 'vitest';
import { canSubmitInteraction } from './interaction-state.js';
describe('canSubmitInteraction', () => {
  it('prevents duplicate approval submissions', () => {
    expect(canSubmitInteraction('pending')).toBe(true);
    expect(canSubmitInteraction('submitting')).toBe(false);
    expect(canSubmitInteraction('resolved')).toBe(false);
  });
});
