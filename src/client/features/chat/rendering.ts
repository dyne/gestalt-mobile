/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export function renderPlainText(text: string): string {
  return text;
}

export type CommentaryPart =
  | { kind: 'text'; text: string }
  | { kind: 'link'; text: string; href: string }
  | { kind: 'code'; text: string };
export type CommentaryBlock =
  | { kind: 'text'; parts: CommentaryPart[] }
  | { kind: 'code'; text: string }
  | { kind: 'table'; headers: CommentaryPart[][]; rows: CommentaryPart[][][] };

export function renderCommentary(text: string): CommentaryBlock[] {
  const blocks: CommentaryBlock[] = [];
  const pattern = /```[^\n]*\n([\s\S]*?)```/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const before = text.slice(cursor, match.index);
    if (before) blocks.push(...textBlocks(before));
    blocks.push({ kind: 'code', text: match[1] ?? '' });
    cursor = (match.index ?? 0) + match[0].length;
  }
  const after = text.slice(cursor);
  if (after || !blocks.length) blocks.push(...textBlocks(after));
  return blocks;
}

function textBlocks(text: string): CommentaryBlock[] {
  const blocks: CommentaryBlock[] = [];
  const lines = text.split('\n');
  let textStart = 0;

  const addText = (end: number) => {
    const value = lines.slice(textStart, end).join('\n');
    if (value) blocks.push({ kind: 'text', parts: linkParts(value) });
  };

  for (let index = 0; index < lines.length - 1; index += 1) {
    const headers = tableRow(lines[index] ?? '');
    const divider = tableRow(lines[index + 1] ?? '');
    if (!headers || !divider || headers.length !== divider.length || !divider.every(isTableDivider))
      continue;
    addText(index);
    index += 2;
    const rows: string[][] = [];
    while (index < lines.length) {
      const row = tableRow(lines[index] ?? '');
      if (!row || row.length !== headers.length) break;
      rows.push(row);
      index += 1;
    }
    blocks.push({
      kind: 'table',
      headers: headers.map(linkParts),
      rows: rows.map((row) => row.map(linkParts)),
    });
    textStart = index;
    index -= 1;
  }
  addText(lines.length);
  return blocks.length ? blocks : [{ kind: 'text', parts: linkParts(text) }];
}

function tableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return null;
  const cells = trimmed
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
  return cells.length > 1 && cells.every(Boolean) ? cells : null;
}

function isTableDivider(cell: string): boolean {
  return /^:?-{3,}:?$/.test(cell);
}

function linkParts(text: string): CommentaryPart[] {
  const parts: CommentaryPart[] = [];
  const pattern = /\[([^\]]+)\]\((https?:\/\/[^\s)]+|codex:\/\/[^\s)]+|\/[^\s)]+)\)|`([^`]+)`/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const before = text.slice(cursor, match.index);
    if (before) parts.push({ kind: 'text', text: before });
    parts.push(
      match[3]
        ? { kind: 'code', text: match[3] }
        : { kind: 'link', text: match[1] ?? '', href: match[2] ?? '' },
    );
    cursor = (match.index ?? 0) + match[0].length;
  }
  const after = text.slice(cursor);
  if (after) parts.push({ kind: 'text', text: after });
  return parts;
}
