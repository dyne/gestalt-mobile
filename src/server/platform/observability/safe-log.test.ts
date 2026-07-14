import { describe, expect, it } from 'vitest';
import { safeLogFields } from './safe-log.js';
describe('safeLogFields', () => {
  it('redacts model and secret-bearing fields', () =>
    expect(
      safeLogFields({ sessionId: 's', prompt: 'private', output: 'private', secret: 'private' }),
    ).toEqual({ sessionId: 's' }));
});
