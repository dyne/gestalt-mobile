/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash } from 'node:crypto';
import { readdir, realpath, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

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
    const children = await readdir(root, { withFileTypes: true });
    const rootIsRepository = await this.isGitRepository(root);
    const output = await Promise.all(
      children.map(async (child) => {
        if (!child.isDirectory() && !child.isSymbolicLink()) return null;
        try {
          const path = await realpath(join(root, child.name));
          const info = await stat(path);
          if (!info.isDirectory() || relative(root, path).startsWith('..')) return null;
          return {
            option: {
              id: this.id(path),
              name: child.name,
              relativePath: child.name,
              isGitRepository: await this.isGitRepository(path),
              children: [],
            },
            realPath: path,
            children: [],
          };
        } catch {
          return null;
        }
      }),
    );
    const visibleChildren = output
      .filter((value): value is NonNullable<typeof value> => value !== null)
      .sort((a, b) =>
        a.option.name.localeCompare(b.option.name, undefined, { sensitivity: 'base' }),
      );
    const childOptions = rootIsRepository
      ? []
      : visibleChildren.map((entry) => entry.option);
    return {
      option: {
        id: this.id(root),
        name: '/',
        relativePath: '.',
        isGitRepository: rootIsRepository,
        children: childOptions,
      },
      realPath: root,
      children: rootIsRepository ? [] : visibleChildren,
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
