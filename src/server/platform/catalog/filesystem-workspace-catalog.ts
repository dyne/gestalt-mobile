/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

import type {
  WorkspaceCatalog,
  WorkspaceOption,
} from '../../features/catalog/application/ports.js';

export class FilesystemWorkspaceCatalog implements WorkspaceCatalog {
  private readonly root: Promise<string>;
  constructor(root: string) {
    this.root = realpath(root);
  }
  async list(): Promise<WorkspaceOption[]> {
    return [(await this.tree()).option];
  }
  async resolve(id: string): Promise<{ id: string; name: string; realPath: string }> {
    const found = this.find(await this.tree(), id);
    if (!found) throw new Error('WORKSPACE_NOT_FOUND');
    return { id: found.option.id, name: found.option.name, realPath: found.realPath };
  }
  private async tree(): Promise<CatalogEntry> {
    const root = await this.root;
    return (
      (await this.visit({
        root,
        realPath: root,
        name: '/',
        relativePath: '.',
        visited: new Set<string>(),
        isRoot: true,
      })) ?? this.entry(root, '/', '.', false, [])
    );
  }
  private async visit(input: {
    root: string;
    realPath: string;
    name: string;
    relativePath: string;
    visited: Set<string>;
    isRoot?: boolean;
  }): Promise<CatalogEntry | null> {
    if (input.visited.has(input.realPath)) return null;
    input.visited.add(input.realPath);

    const isGitRepository = await this.isGitRepository(input.realPath);
    if (isGitRepository) {
      return this.entry(input.realPath, input.name, input.relativePath, true, []);
    }

    let directoryEntries: Dirent[];
    try {
      directoryEntries = await readdir(input.realPath, { withFileTypes: true });
    } catch {
      return input.isRoot
        ? this.entry(input.realPath, input.name, input.relativePath, false, [])
        : null;
    }

    const children: CatalogEntry[] = [];
    for (const child of directoryEntries
      .filter((entry) => !entry.name.startsWith('.'))
      .sort((left, right) => this.compareNames(left.name, right.name))) {
      if (!child.isDirectory() && !child.isSymbolicLink()) continue;
      try {
        const childRealPath = await realpath(join(input.realPath, child.name));
        const info = await stat(childRealPath);
        if (!info.isDirectory() || !this.isWithin(input.root, childRealPath)) continue;
        const childRelativePath =
          input.relativePath === '.' ? child.name : `${input.relativePath}/${child.name}`;
        const visitedChild = await this.visit({
          root: input.root,
          realPath: childRealPath,
          name: child.name,
          relativePath: childRelativePath,
          visited: input.visited,
        });
        if (visitedChild) children.push(visitedChild);
      } catch {
        // Entries may vanish or become unreadable while the tree is being discovered.
      }
    }
    return this.entry(
      input.realPath,
      input.name,
      input.relativePath,
      false,
      children,
    );
  }
  private entry(
    realPath: string,
    name: string,
    relativePath: string,
    isGitRepository: boolean,
    children: CatalogEntry[],
  ): CatalogEntry {
    return {
      option: {
        id: this.id(realPath),
        name,
        relativePath,
        isGitRepository,
        children: children.map((child) => child.option),
      },
      realPath,
      children,
    };
  }
  private find(entry: CatalogEntry, id: string): CatalogEntry | undefined {
    if (entry.option.id === id) return entry;
    for (const child of entry.children) {
      const found = this.find(child, id);
      if (found) return found;
    }
    return undefined;
  }
  private id(path: string): string {
    return createHash('sha256').update(path).digest('base64url');
  }
  private compareNames(left: string, right: string): number {
    const foldedLeft = left.toLowerCase();
    const foldedRight = right.toLowerCase();
    if (foldedLeft < foldedRight) return -1;
    if (foldedLeft > foldedRight) return 1;
    return left < right ? -1 : left > right ? 1 : 0;
  }
  private isWithin(root: string, path: string): boolean {
    const fromRoot = relative(root, path);
    return (
      fromRoot === '' ||
      (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`))
    );
  }
  private async isGitRepository(path: string): Promise<boolean> {
    return stat(join(path, '.git'))
      .then(() => true)
      .catch(() => false);
  }
}

type CatalogEntry = {
  option: WorkspaceOption;
  realPath: string;
  children: CatalogEntry[];
};
