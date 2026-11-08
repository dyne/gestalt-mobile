/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash } from 'node:crypto';
import { lstat, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type {
  OrgPlanReference,
  OrgPlanWorkspace,
} from '../../../shared/contracts/org-plan-execution.js';
import type { WorkspaceCatalog } from '../../features/catalog/application/ports.js';

type WorkspaceIdentity = Awaited<ReturnType<WorkspaceCatalog['resolve']>>;
type WorkspaceSnapshotReader = Pick<WorkspaceCatalog, 'resolve'> & {
  snapshot(): Promise<readonly WorkspaceIdentity[]>;
};

type SessionContext = {
  workspaceId: string;
  workspacePath: string;
  lastOrgPlan?: { path?: string };
};

/** Resolves only identities already permitted by the normal workspace catalog. */
export class FilesystemOrgPlanContext {
  constructor(
    private readonly workspaces: WorkspaceSnapshotReader,
    private readonly session: (id: string) => SessionContext | null,
  ) {}

  async resolveReference(
    reference: OrgPlanReference,
  ): Promise<{ workspacePath: string; planName: string } | null> {
    if (reference.kind === 'workspace') {
      const workspace = await this.workspaces.resolve(reference.workspaceId);
      return { workspacePath: workspace.realPath, planName: reference.planName };
    }
    const session = this.session(reference.sessionId);
    if (!session) return null;
    const workspace = await this.workspaces.resolve(session.workspaceId);
    if (workspace.realPath !== session.workspacePath) return null;
    if (reference.kind === 'session')
      return { workspacePath: workspace.realPath, planName: reference.planName };
    // Absolute file identity comes from durable server state, never a client path.
    const retained = session.lastOrgPlan?.path;
    const root = await this.root();
    if (!retained || !root || !isAbsolute(retained) || !within(root.realPath, retained))
      return null;
    return {
      workspacePath: root.realPath,
      planName: relative(root.realPath, retained).split(sep).join('/'),
    };
  }

  async workspace(
    canonicalPath: string,
    fileRevision: string,
  ): Promise<{ workspace: OrgPlanWorkspace; revision: string } | null> {
    const permitted = await this.workspaces.snapshot();
    const containing = permitted.filter((workspace) => within(workspace.realPath, canonicalPath));
    if (!containing.length) return null;
    containing.sort((a, b) => b.realPath.length - a.realPath.length);
    const root = containing.reduce((a, b) => (a.realPath.length < b.realPath.length ? a : b));
    if ((await realpath(canonicalPath)) !== canonicalPath) return null;
    let selected: typeof root | undefined;
    let owner: string | undefined;
    let marker: Awaited<ReturnType<typeof lstat>> | undefined;
    for (
      let directory = dirname(canonicalPath);
      within(root.realPath, directory);
      directory = dirname(directory)
    ) {
      if (basename(directory) === '.gestalt' && !owner) owner = dirname(directory);
      try {
        const git = await lstat(resolve(directory, '.git'));
        if (git.isSymbolicLink() || (!git.isDirectory() && !git.isFile())) return null;
        // Do not silently select an outer project for an unselectable nested repository.
        selected = containing.find((workspace) => workspace.realPath === directory);
        if (!selected) return null;
        marker = git;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
      }
      if (directory === root.realPath) break;
    }
    selected ??= containing.find((workspace) => workspace.realPath === owner) ?? containing[0];
    if (!selected || basename(selected.realPath) === '.gestalt') return null;
    const canonical = await realpath(selected.realPath);
    const metadata = await stat(canonical);
    if (canonical !== selected.realPath || !metadata.isDirectory()) return null;
    const revision = createHash('sha256')
      .update(
        JSON.stringify([
          fileRevision,
          selected.id,
          canonical,
          metadata.dev,
          metadata.ino,
          marker ? [marker.dev, marker.ino, marker.isFile()] : null,
        ]),
      )
      .digest('hex');
    return { workspace: { id: selected.id, name: selected.name, path: canonical }, revision };
  }

  private async root() {
    return (await this.workspaces.snapshot())[0] ?? null;
  }
}

function within(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`));
}
