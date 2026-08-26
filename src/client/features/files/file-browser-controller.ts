/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { RelayWorkspaceDirectory, RelayWorkspaceFile } from '../sessions/relay-client.js';

export type DirectoryState = Readonly<{
  entries: readonly RelayWorkspaceFile[];
  cursor?: string;
  loading: boolean;
  error: boolean;
}>;
export type DirectoryReader = (
  workspaceId: string,
  input?: { directory?: string; cursor?: string; limit?: number },
  signal?: AbortSignal,
) => Promise<RelayWorkspaceDirectory>;

export class FileBrowserController {
  readonly expanded = new Set<string>(['']);
  selectedPath = '';
  private readonly pages = new Map<string, DirectoryState>();
  private readonly generations = new Map<string, number>();
  private readonly requests = new Map<string, AbortController>();
  private version = 0;

  constructor(
    readonly workspaceId: string,
    private readonly read: DirectoryReader,
    private readonly changed: () => void,
    private readonly failed: (error: unknown) => void = () => {},
  ) {}

  state(path: string): DirectoryState {
    return this.pages.get(path) ?? { entries: [], loading: false, error: false };
  }

  async load(path = '', more = false): Promise<void> {
    const prior = this.state(path);
    if (prior.loading || (more && !prior.cursor)) return;
    const generation = (this.generations.get(path) ?? 0) + 1;
    this.generations.set(path, generation);
    this.requests.get(path)?.abort();
    const request = new AbortController();
    this.requests.set(path, request);
    this.pages.set(path, { ...prior, loading: true, error: false });
    this.publish();
    try {
      const page = await this.read(
        this.workspaceId,
        { directory: path, ...(more ? { cursor: prior.cursor } : {}) },
        request.signal,
      );
      if (request.signal.aborted || this.generations.get(path) !== generation) return;
      const entries = more ? deduplicate(prior.entries, page.entries) : page.entries;
      this.pages.set(path, { entries, cursor: page.nextCursor, loading: false, error: false });
    } catch (error) {
      if (request.signal.aborted || this.generations.get(path) !== generation) return;
      this.pages.set(path, { ...prior, loading: false, error: true });
      this.failed(error);
    } finally {
      if (this.requests.get(path) === request) this.requests.delete(path);
      this.publish();
    }
  }

  async expand(path: string): Promise<void> {
    this.expanded.add(path);
    this.publish();
    if (!this.pages.has(path)) await this.load(path);
  }
  collapse(path: string): void {
    this.expanded.delete(path);
    this.generations.set(path, (this.generations.get(path) ?? 0) + 1);
    this.requests.get(path)?.abort();
    this.publish();
  }
  async refresh(path = ''): Promise<void> {
    this.invalidateBranch(path);
    await this.load(path);
  }
  select(path: string): void {
    this.selectedPath = path;
    this.publish();
  }
  close(): void {
    this.requests.forEach((request) => request.abort());
    this.requests.clear();
  }
  private invalidateBranch(path: string): void {
    for (const key of [...this.pages.keys()]) {
      if (key === path || key.startsWith(path ? `${path}/` : '')) {
        this.pages.delete(key);
        this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
        this.requests.get(key)?.abort();
      }
    }
  }
  private publish(): void {
    this.version += 1;
    this.changed();
  }
}

function deduplicate(
  existing: readonly RelayWorkspaceFile[],
  appended: readonly RelayWorkspaceFile[],
) {
  const paths = new Set(existing.map((entry) => entry.path));
  return [...existing, ...appended.filter((entry) => !paths.has(entry.path))];
}
