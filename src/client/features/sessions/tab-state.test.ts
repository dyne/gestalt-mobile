import { describe, expect, it } from 'vitest';
import { nextTab } from './tab-state.js';
describe('nextTab', () => {
  it('wraps keyboard tab navigation', () => expect(nextTab('chat', -1)).toBe('sessions'));
});
