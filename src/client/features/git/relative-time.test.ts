import { describe, expect, it } from 'vitest';
import { ageLabel } from './relative-time.js';
describe('ageLabel', () => {
  it('labels cached Git state age', () => expect(ageLabel(120_000)).toBe('2m ago'));
});
