/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { marked } from 'marked';
import DOMPurify from 'dompurify';

export type FilePreview = Readonly<
  | { kind: 'directory'; path: string }
  | { kind: 'file'; path: string; content: string; size: number }
>;
export type FileViewerTarget = Readonly<{
  workspaceId: string;
  path: string;
  sessionId?: string;
  line?: number;
}>;

export function formatFile(preview: FilePreview): {
  format: 'markdown' | 'json' | 'text';
  text: string;
} {
  if (preview.kind !== 'file') return { format: 'text', text: '' };
  if (/\.(md|markdown)$/i.test(preview.path)) return { format: 'markdown', text: preview.content };
  if (/\.json$/i.test(preview.path)) {
    try {
      return { format: 'json', text: JSON.stringify(JSON.parse(preview.content), null, 2) };
    } catch {
      /* Malformed JSON remains readable as source. */
    }
  }
  return { format: 'text', text: preview.content };
}

export function markdownPreview(source: string): string {
  return DOMPurify.sanitize(marked.parse(source, { async: false, gfm: true }), {
    ALLOWED_TAGS: [
      'p',
      'br',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'strong',
      'em',
      'del',
      'blockquote',
      'ul',
      'ol',
      'li',
      'pre',
      'code',
      'hr',
      'table',
      'thead',
      'tbody',
      'tr',
      'th',
      'td',
      'a',
    ],
    ALLOWED_ATTR: ['href', 'title', 'start'],
  });
}

/** Org paths are relative to the project containing its .gestalt directory. */
export function planFileReference(planName: string, reference: string): string {
  const path = reference.trim();
  if (path.startsWith('/')) return path;
  const segments = planName.split('/');
  const index = segments.indexOf('.gestalt');
  const base = index < 0 ? [] : segments.slice(0, index);
  return [...base, path].filter(Boolean).join('/');
}

export function relativeFileReference(currentPath: string, reference: string): string {
  if (reference.startsWith('/')) return reference;
  return [...currentPath.split('/').slice(0, -1), reference].join('/');
}
