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
    return (await this.entries()).map(({ id, name, git }) => ({ id, name, isGitRepository: git }));
  }
  async resolve(id: string): Promise<{ id: string; name: string; realPath: string }> {
    const found = (await this.entries()).find((entry) => entry.id === id);
    if (!found) throw new Error('WORKSPACE_NOT_FOUND');
    return { id: found.id, name: found.name, realPath: found.path };
  }
  private async entries(): Promise<
    Array<{ id: string; name: string; path: string; git: boolean }>
  > {
    const root = await this.root;
    const children = await readdir(root, { withFileTypes: true });
    const output = await Promise.all(
      children.map(async (child) => {
        if (!child.isDirectory() && !child.isSymbolicLink()) return null;
        try {
          const path = await realpath(join(root, child.name));
          const info = await stat(path);
          if (!info.isDirectory() || relative(root, path).startsWith('..')) return null;
          const git = await stat(join(path, '.git'))
            .then(() => true)
            .catch(() => false);
          return {
            id: createHash('sha256').update(path).digest('base64url'),
            name: child.name,
            path,
            git,
          };
        } catch {
          return null;
        }
      }),
    );
    return output
      .filter((value): value is NonNullable<typeof value> => value !== null)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }
}
