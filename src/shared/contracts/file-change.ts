/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type FileChangeSummary = {
  path: string;
  additions: number;
  deletions: number;
};

/** Counts changed content lines in a unified diff without counting file headers. */
export function countDiffLines(diff: string): Pick<FileChangeSummary, 'additions' | 'deletions'> {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;
    if (line.startsWith('+')) additions += 1;
    else if (line.startsWith('-')) deletions += 1;
  }
  return { additions, deletions };
}
