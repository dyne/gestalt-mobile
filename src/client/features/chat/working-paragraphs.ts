/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Lexer } from 'marked';

export type WorkingParagraph = { offset: number; text: string };

/** Reverse top-level paragraphs while keeping lists, tables and streamed fences intact. */
export function newestFirstWorkingParagraphs(text: string): WorkingParagraph[] {
  const paragraphs: WorkingParagraph[] = [];
  let offset = 0;
  let heading: WorkingParagraph | null = null;
  for (const token of Lexer.lex(text)) {
    const start = offset;
    offset += token.raw.length;
    if (token.type === 'space') {
      if (heading) heading.text += token.raw;
      continue;
    }
    if (token.type === 'heading') {
      if (heading) heading.text += token.raw;
      else heading = { offset: start, text: token.raw };
      continue;
    }
    paragraphs.push(
      heading
        ? { offset: heading.offset, text: heading.text + token.raw }
        : { offset: start, text: token.raw },
    );
    heading = null;
  }
  if (heading) paragraphs.push(heading);
  return paragraphs.toReversed();
}
