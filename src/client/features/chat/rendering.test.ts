import { describe, expect, it } from 'vitest';
import { renderCommentary, renderPlainText } from './rendering.js';
describe('renderPlainText', () => {
  it('does not interpret model text as HTML', () =>
    expect(renderPlainText('<script>alert(1)</script>')).toBe('<script>alert(1)</script>'));

  it('preserves newlines for the plain-text renderer', () =>
    expect(renderPlainText('one\ntwo')).toBe('one\ntwo'));
});

describe('renderCommentary', () => {
  it('recognizes safe links and fenced code without interpreting HTML', () => {
    expect(
      renderCommentary('Read [the docs](https://example.com).\n```ts\nconst x = 1;\n```'),
    ).toEqual([
      {
        kind: 'text',
        parts: [
          { kind: 'text', text: 'Read ' },
          { kind: 'link', text: 'the docs', href: 'https://example.com' },
          { kind: 'text', text: '.\n' },
        ],
      },
      { kind: 'code', text: 'const x = 1;\n' },
    ]);
  });
});
