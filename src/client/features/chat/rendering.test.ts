import { describe, expect, it } from 'vitest';
import { renderPlainText } from './rendering.js';
describe('renderPlainText', () => {
  it('does not interpret model text as HTML', () =>
    expect(renderPlainText('<script>alert(1)</script>')).toBe('<script>alert(1)</script>'));

  it('preserves newlines for the plain-text renderer', () =>
    expect(renderPlainText('one\ntwo')).toBe('one\ntwo'));
});
