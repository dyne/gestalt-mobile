/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** Shared recognition for rendered chat links and session-scoped file access. */
export const markdownLinkPattern = /\[([^\]]+)\]\((?:<([^>\n]+)>|([^\s)]+))\)/g;

export type FileLineReference = Readonly<{ path: string; line?: number }>;

/** Line numbers always refer to the original file, rather than reformatted content. */
export function fileLineReference(path: string): FileLineReference {
  const match = /(?::(\d+)(?::\d+)?|#L(\d+)(?:C\d+)?)$/.exec(path);
  if (!match) return { path };
  const line = Number(match[1] ?? match[2]);
  return {
    path: path.slice(0, match.index),
    ...(Number.isSafeInteger(line) && line > 0 ? { line } : {}),
  };
}

export function localFileReferenceFromHref(href: string, decode = true): FileLineReference | null {
  let path: string;
  try {
    path = decode ? decodeURIComponent(href) : href;
  } catch {
    return null;
  }
  if (path.startsWith('file://')) {
    try {
      const url = new URL(path);
      if (url.hostname && url.hostname !== 'localhost') return null;
      path = decodeURIComponent(url.pathname + url.hash);
    } catch {
      return null;
    }
  }
  const reference = fileLineReference(path);
  path = reference.path;
  if (/^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith('//') || /[\u0000-\u001f\\]/.test(path))
    return null;
  if (!path || path.startsWith('#') || path.includes('?') || path.includes('#')) return null;
  if (
    !path.startsWith('/') &&
    !path.startsWith('./') &&
    !path.startsWith('../') &&
    !/\.[a-z\d]+$/i.test(path)
  )
    return null;
  return reference;
}

export function localFilePathFromHref(href: string, decode = true): string | null {
  return localFileReferenceFromHref(href, decode)?.path ?? null;
}

export function linkedLocalFiles(text: string): string[] {
  return [...text.matchAll(markdownLinkPattern)].flatMap((match) => {
    const path = localFilePathFromHref(match[2] ?? match[3] ?? '');
    return path ? [path] : [];
  });
}
