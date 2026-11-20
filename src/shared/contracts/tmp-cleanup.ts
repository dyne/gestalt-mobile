/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export const CLEAN_TMP_FAILED_FOLDER_LIMIT = 3;

export type CleanTmpFailedFolder = Readonly<{
  workspaceName: string;
  relativePath: string;
}>;

export type CleanTmpResult = Readonly<{
  status: 'complete' | 'partial';
  folders: Readonly<{ removed: number; skipped: number; failed: number }>;
  workspaces: Readonly<{
    /** Complete workspace scans without skipped/failed candidates. */
    cleaned: number;
    /** Workspaces with at least one removal; can overlap skipped/failed counts. */
    removed: number;
    skipped: number;
    failed: number;
    unavailable: number;
  }>;
  /** Includes workspace-discovery failures; these are not fabricated folder counts. */
  reasons: Readonly<
    Record<
      'protected' | 'busy' | 'lease' | 'unrecognized' | 'unsafe' | 'unavailable' | 'io',
      number
    >
  >;
  /** Sample of failed managed folders. The folder counters still describe the full scan. */
  failedFolders?: readonly CleanTmpFailedFolder[];
}>;
