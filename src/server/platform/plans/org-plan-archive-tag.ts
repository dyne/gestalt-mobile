/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export function isArchivedOrgPlan(source: string): boolean {
  return [...source.matchAll(/^#\+FILETAGS:[ \t]*(.*)$/gim)].some((match) =>
    match[1]!.split(/[:\s]+/).some((tag) => tag.toUpperCase() === 'ARCHIVE'),
  );
}

export function archiveOrgPlan(source: string): string {
  if (isArchivedOrgPlan(source)) return source;
  const existing = /^(#\+FILETAGS:[ \t]*)([^\r\n]*)(\r?)$/im;
  if (existing.test(source))
    return source.replace(
      existing,
      (_line, prefix: string, tags: string, carriage: string) =>
        `${prefix}${tags.trimEnd()}${tags.trimEnd().endsWith(':') ? '' : ':'}ARCHIVE:${carriage}`,
    );
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  return `#+FILETAGS: :ARCHIVE:${newline}${source}`;
}
