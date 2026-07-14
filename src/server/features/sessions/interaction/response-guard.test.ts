import { describe, expect, it } from 'vitest';
import { mayResolveInteraction } from './response-guard.js';
describe('mayResolveInteraction', () => {
  it('prevents duplicate approval and question answers', () => {
    expect(mayResolveInteraction(null)).toBe(true);
    expect(mayResolveInteraction('t')).toBe(false);
  });
});
