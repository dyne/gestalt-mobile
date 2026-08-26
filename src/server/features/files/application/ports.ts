/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type {
  ListWorkspaceDirectory,
  WorkspaceDirectoryResult,
} from '../domain/workspace-directory.js';

export type FileConflict = 'reject' | 'replace' | 'keep-both';
export type FileMutationResult =
  | {
      kind: 'available';
      path: string;
      source: string;
      entryKind: 'file' | 'directory';
      conflict: FileConflict;
    }
  | { kind: 'conflict'; replaceAllowed: boolean }
  | {
      kind:
        | 'missing'
        | 'protected'
        | 'symlink'
        | 'invalid-destination'
        | 'source-inside-destination'
        | 'same-parent'
        | 'replace-unsupported'
        | 'unreadable';
    };
export type CopyMoveInput = Readonly<{
  source: string;
  destinationDirectory: string;
  conflict: FileConflict;
}>;
export type UploadInput = Readonly<{
  directory: string;
  filename: string;
  conflict: FileConflict;
  content: Buffer;
}>;
export type DeleteInput = Readonly<{ path: string; recursive: true }>;

/** Boundary for listing one already-authorized workspace directory. */
export interface WorkspaceFileSource {
  list(workspaceRoot: string, input: ListWorkspaceDirectory): Promise<WorkspaceDirectoryResult>;
  copy?(workspaceRoot: string, input: CopyMoveInput): Promise<FileMutationResult>;
  move?(workspaceRoot: string, input: CopyMoveInput): Promise<FileMutationResult>;
  upload?(workspaceRoot: string, input: UploadInput): Promise<FileMutationResult>;
  delete?(workspaceRoot: string, input: DeleteInput): Promise<FileMutationResult>;
}
