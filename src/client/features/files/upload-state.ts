/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { MAX_UPLOAD_BYTES } from '../../../shared/contracts/file-upload.js';
export { MAX_UPLOAD_BYTES };

export type UploadOutcome = Readonly<{
  file: File;
  status: 'queued' | 'uploading' | 'completed' | 'failed' | 'too-large' | 'cancelled';
  path?: string;
}>;

export function initialiseUploads(files: Iterable<File>): UploadOutcome[] {
  return [...files].map((file) => ({
    file,
    status: file.size > MAX_UPLOAD_BYTES ? 'too-large' : 'queued',
  }));
}

export function nextUpload(outcomes: readonly UploadOutcome[]): number {
  return outcomes.findIndex((outcome) => outcome.status === 'queued');
}
