/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type ScratchCleanupReason =
  'protected' | 'busy' | 'lease' | 'unrecognized' | 'unsafe' | 'unavailable' | 'io';

export type ScratchFolderCounts = {
  removed: number;
  skipped: number;
  failed: number;
  reasons: Record<ScratchCleanupReason, number>;
};

export function emptyScratchCounts(): ScratchFolderCounts {
  return {
    removed: 0,
    skipped: 0,
    failed: 0,
    reasons: { protected: 0, busy: 0, lease: 0, unrecognized: 0, unsafe: 0, unavailable: 0, io: 0 },
  };
}

export interface ScratchCleanupStorage {
  canonicalWorkspace(path: string): Promise<string>;
  cleanWorkspace(
    path: string,
    protectedSessions: () => readonly ScratchSessionOwner[],
  ): Promise<ScratchFolderCounts>;
}

export type ScratchSessionOwner = Readonly<{ id: string; workspacePath: string }>;

export type ScratchCleanupResult = {
  status: 'complete' | 'partial';
  workspaces: {
    cleaned: number;
    removed: number;
    skipped: number;
    failed: number;
    unavailable: number;
  };
  folders: ScratchFolderCounts;
};

/** Read the authoritative roster again inside each storage fence, never a UI snapshot. */
export class CleanSessionScratch {
  constructor(
    private readonly deps: {
      knownWorkspacePaths(): Promise<readonly string[]>;
      additionalWorkspacePaths?(): Promise<readonly string[]>;
      sessions(): readonly { id: string; workspacePath: string }[];
      storage: ScratchCleanupStorage;
    },
  ) {}

  async execute(): Promise<ScratchCleanupResult> {
    const result: ScratchCleanupResult = {
      status: 'complete',
      workspaces: { cleaned: 0, removed: 0, skipped: 0, failed: 0, unavailable: 0 },
      folders: emptyScratchCounts(),
    };
    const paths = new Set(this.deps.sessions().map((session) => session.workspacePath));
    const sources = [() => this.deps.knownWorkspacePaths()];
    if (this.deps.additionalWorkspacePaths)
      sources.push(() => this.deps.additionalWorkspacePaths!());
    for (const source of sources) {
      try {
        for (const path of await source()) paths.add(path);
      } catch {
        // A failed catalog is an unknown discovery scope, not an invented folder
        // or workspace count. Other durable/catalog sources remain usable.
        result.status = 'partial';
        result.folders.reasons.unavailable++;
      }
    }
    const seen = new Set<string>();
    for (const path of paths) {
      let canonical: string;
      try {
        canonical = await this.deps.storage.canonicalWorkspace(path);
      } catch (error) {
        const unsafe = error instanceof Error && error.message.startsWith('SESSION_SCRATCH_');
        result.workspaces[unsafe ? 'skipped' : 'unavailable']++;
        result.folders.reasons[unsafe ? 'unsafe' : 'unavailable']++;
        continue;
      }
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      try {
        const counts = await this.deps.storage.cleanWorkspace(canonical, () =>
          this.deps.sessions(),
        );
        result.folders.removed += counts.removed;
        if (counts.removed) result.workspaces.removed++;
        result.folders.skipped += counts.skipped;
        result.folders.failed += counts.failed;
        for (const reason of Object.keys(counts.reasons) as ScratchCleanupReason[])
          result.folders.reasons[reason] += counts.reasons[reason];
        result.workspaces[counts.failed ? 'failed' : counts.skipped ? 'skipped' : 'cleaned']++;
      } catch (error) {
        const unsafe = error instanceof Error && error.message.startsWith('SESSION_SCRATCH_');
        const unavailable = ['ENOENT', 'EACCES', 'EPERM'].includes(
          (error as { code?: string }).code ?? '',
        );
        result.workspaces[unsafe ? 'skipped' : unavailable ? 'unavailable' : 'failed']++;
        result.folders.reasons[unsafe ? 'unsafe' : unavailable ? 'unavailable' : 'io']++;
      }
    }
    if (
      result.workspaces.failed ||
      result.workspaces.unavailable ||
      result.folders.reasons.unsafe ||
      result.folders.reasons.io
    )
      result.status = 'partial';
    return result;
  }
}
