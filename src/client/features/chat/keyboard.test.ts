import { describe, expect, it } from 'vitest';
import { submitsOnEnter } from './keyboard.js';
describe('submitsOnEnter', () => {
  it('allows Shift+Enter and Ctrl+Enter for multiline compose', () => {
    expect(submitsOnEnter({ key: 'Enter', shiftKey: false })).toBe(true);
    expect(submitsOnEnter({ key: 'Enter', shiftKey: true })).toBe(false);
    expect(submitsOnEnter({ key: 'Enter', shiftKey: false, ctrlKey: true })).toBe(false);
  });
});
