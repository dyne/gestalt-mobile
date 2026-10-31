/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { newestFirstWorkingParagraphs } from './working-paragraphs.js';

describe('newest working paragraphs first', () => {
  it('puts new paragraphs above older ones and keeps their original offsets stable', () => {
    const initial = newestFirstWorkingParagraphs('First paragraph.\n\nSecond');
    const updated = newestFirstWorkingParagraphs(
      'First paragraph.\n\nSecond paragraph.\n\nNewest paragraph.',
    );
    expect(updated.map(({ text }) => text)).toEqual([
      'Newest paragraph.',
      'Second paragraph.',
      'First paragraph.',
    ]);
    expect(updated[2]!.offset).toBe(initial[1]!.offset);
    expect(updated[1]!.offset).toBe(initial[0]!.offset);
  });

  it.each([
    '```ts\nconst first = 1;\n\nconst second = 2;\n```',
    '```ts\nconst first = 1;\n\nconst second = 2;',
    '- First item\n\n- Second item',
    '| Name | Value |\n| --- | --- |\n| First | 1 |\n| Second | 2 |',
  ])('keeps a Markdown block intact: %s', (block) => {
    const result = newestFirstWorkingParagraphs(`Older paragraph.\n\n${block}`);
    expect(result).toHaveLength(2);
    expect(result[0]!.text.trimEnd()).toBe(block);
    expect(result[1]!.text).toBe('Older paragraph.');
  });

  it('keeps headings above their associated text', () => {
    expect(
      newestFirstWorkingParagraphs('Older.\n\n## Status\n\nTests pass.\n\nNewest.').map(
        ({ text }) => text,
      ),
    ).toEqual(['Newest.', '## Status\n\nTests pass.', 'Older.']);
  });

  it('does not create paragraphs for empty input', () => {
    expect(newestFirstWorkingParagraphs('')).toEqual([]);
  });
});
