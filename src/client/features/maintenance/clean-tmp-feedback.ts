/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { CleanTmpResult } from '../../../shared/contracts/tmp-cleanup.js';
import type { ToastInput } from '../feedback/toast-queue.js';

const count = (value: number, noun: string): string => `${value} ${noun}${value === 1 ? '' : 's'}`;

/** Workspace categories overlap; protected folders are already part of skipped. */
export function cleanTmpFeedback(result: CleanTmpResult): ToastInput {
  const { folders, workspaces, reasons } = result;
  const partial = result.status === 'partial';
  const parts: string[] = [];
  if (partial) parts.push('Cleanup incomplete.');
  if (folders.removed) {
    parts.push(
      `Removed ${count(folders.removed, 'temporary folder')} in ${count(workspaces.removed, 'workspace')}.`,
    );
  } else {
    parts.push(
      !partial && !folders.skipped
        ? 'No temporary folders to remove.'
        : 'No temporary folders removed.',
    );
  }
  if (reasons.protected) parts.push(`Kept ${count(reasons.protected, 'protected folder')}.`);
  const otherSkipped = Math.max(0, folders.skipped - reasons.protected);
  if (otherSkipped) parts.push(`Skipped ${count(otherSkipped, 'other folder')}.`);
  if (folders.failed) parts.push(`Could not remove ${count(folders.failed, 'folder')}.`);
  if (workspaces.unavailable) {
    parts.push(`Could not check ${count(workspaces.unavailable, 'workspace')}.`);
  }
  if (reasons.unavailable > workspaces.unavailable) {
    // Discovery failures do not establish a workspace or folder count.
    parts.push('Some locations could not be checked.');
  }
  if (partial) parts.push('Try Clean TMP again.');
  // Do not deduplicate by a fixed code: a later run can have different counts.
  return { kind: partial ? 'error' : 'success', message: parts.join(' ') };
}
