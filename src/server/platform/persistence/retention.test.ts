import { describe, expect, it } from 'vitest';
import { eventRetention, retainedSequences } from './retention.js';
describe('retainedSequences', () => {
  it('keeps the newest 2,000 events', () =>
    expect(
      retainedSequences(Array.from({ length: eventRetention + 1 }, (_, index) => index)).length,
    ).toBe(eventRetention));
});
