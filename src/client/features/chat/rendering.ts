export function renderPlainText(text: string): string {
  return text;
}

export type CommentaryPart =
  | { kind: 'text'; text: string }
  | { kind: 'link'; text: string; href: string }
  | { kind: 'code'; text: string };
export type CommentaryBlock =
  { kind: 'text'; parts: CommentaryPart[] } | { kind: 'code'; text: string };

export function renderCommentary(text: string): CommentaryBlock[] {
  const blocks: CommentaryBlock[] = [];
  const pattern = /```[^\n]*\n([\s\S]*?)```/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const before = text.slice(cursor, match.index);
    if (before) blocks.push({ kind: 'text', parts: linkParts(before) });
    blocks.push({ kind: 'code', text: match[1] ?? '' });
    cursor = (match.index ?? 0) + match[0].length;
  }
  const after = text.slice(cursor);
  if (after || !blocks.length) blocks.push({ kind: 'text', parts: linkParts(after) });
  return blocks;
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
