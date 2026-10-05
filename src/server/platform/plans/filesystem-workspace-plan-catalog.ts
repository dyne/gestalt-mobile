/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import type { WorkspacePlanCatalogSource } from '../../features/plans/application/ports.js';
import { parseSupervisedPlan } from '../../features/plans/application/parse-supervised-plan.js';
import type { SupervisedPlan } from '../../features/plans/domain/supervised-plan.js';
import type {
  WorkspacePlanEntry,
  WorkspacePlanReadResult,
} from '../../features/plans/domain/workspace-plan-catalog.js';

import { OrgPlanDiscovery } from './org-plan-discovery.js';
import { isArchivedOrgPlan } from './org-plan-archive-tag.js';

const maximumBytes = 1_048_576;

type Filesystem = Pick<typeof import('node:fs/promises'), 'lstat' | 'realpath' | 'stat'> & {
  readFile(path: string, encoding: 'utf8'): Promise<string>;
};

type ReadCandidateResult =
  | Readonly<{ kind: 'readable'; source: string; canonicalPath: string }>
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'unavailable' }>;

type CatalogCache = {
  entries: readonly WorkspacePlanEntry[] | null;
  files: Map<string, { signature: string; entry: WorkspacePlanEntry }>;
  refreshedAt: number;
  request: Promise<readonly WorkspacePlanEntry[]> | null;
};

/** Cached `.gestalt` Org discovery, with bounded parallel metadata checks. */
export class FilesystemWorkspacePlanCatalog implements WorkspacePlanCatalogSource {
  private readonly caches = new Map<string, CatalogCache>();

  constructor(
    private readonly filesystem: Filesystem = { lstat, readFile, realpath, stat },
    private readonly discovery: Pick<OrgPlanDiscovery, 'list'> = new OrgPlanDiscovery(),
    private readonly now: () => number = Date.now,
  ) {}

  async list(workspacePath: string, refresh = false): Promise<readonly WorkspacePlanEntry[]> {
    const workspace = await this.workspace(workspacePath);
    if (!workspace) return [];
    let cache = this.caches.get(workspace);
    if (!cache) {
      cache = { entries: null, files: new Map(), refreshedAt: 0, request: null };
      this.caches.set(workspace, cache);
    }
    if (cache.request) return cache.request;
    if (!refresh && cache.entries && this.now() - cache.refreshedAt < 1_000) return cache.entries;
    const current = cache;
    current.request = this.refresh(workspace, current).finally(() => {
      current.request = null;
    });
    return current.request;
  }

  private async refresh(
    workspace: string,
    cache: CatalogCache,
  ): Promise<readonly WorkspacePlanEntry[]> {
    const planNames = [...new Set(await this.discovery.list(workspace))]
      .filter((name) => isPlanPath(name) && name.split('/').slice(0, -1).includes('.gestalt'))
      .sort((left, right) => left.localeCompare(right));
    const entries = new Array<WorkspacePlanEntry | null>(planNames.length).fill(null);
    const files: CatalogCache['files'] = new Map();
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(8, planNames.length) }, async () => {
        while (next < planNames.length) {
          const index = next++;
          const name = planNames[index]!;
          let signature: string;
          try {
            const metadata = await this.filesystem.lstat(resolve(workspace, ...name.split('/')));
            if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
            signature = [
              metadata.dev,
              metadata.ino,
              metadata.size,
              metadata.mtimeMs,
              metadata.ctimeMs,
            ].join(':');
          } catch {
            continue;
          }
          const previous = cache.files.get(name);
          if (previous?.signature === signature) {
            try {
              const canonical = await this.filesystem.realpath(
                resolve(workspace, ...name.split('/')),
              );
              if (
                !isWithin(workspace, canonical) ||
                toPlanName(relative(workspace, canonical)) !== name
              )
                continue;
            } catch {
              continue;
            }
            entries[index] = previous.entry;
            files.set(name, previous);
            continue;
          }
          const candidate = await this.readCandidate(workspace, name);
          if (candidate.kind === 'missing') continue;
          let entry: WorkspacePlanEntry;
          if (candidate.kind === 'unavailable') {
            entry = toFallbackEntry(name);
          } else {
            const parsed = parseSupervisedPlan({
              source: candidate.source,
              planPath: candidate.canonicalPath,
              workspacePath: workspace,
            });
            entry =
              parsed.kind === 'available'
                ? toEntry(name, parsed.plan)
                : toFallbackEntry(name, candidate.source);
            if (isArchivedOrgPlan(candidate.source)) entry = { ...entry, archived: true };
            files.set(name, { signature, entry });
          }
          entries[index] = entry;
        }
      }),
    );
    cache.files = files;
    cache.entries = entries.filter((entry): entry is WorkspacePlanEntry => entry !== null);
    cache.refreshedAt = this.now();
    return cache.entries;
  }

  async read(workspacePath: string, planName: string): Promise<WorkspacePlanReadResult> {
    if (!isPlanPath(planName)) return { kind: 'missing' };
    const workspace = await this.workspace(workspacePath);
    if (!workspace) return { kind: 'missing' };
    return this.readFromWorkspace(workspace, planName);
  }

  private async workspace(workspacePath: string): Promise<string | null> {
    if (!isAbsolute(workspacePath)) return null;
    try {
      const canonical = await this.filesystem.realpath(resolve(workspacePath));
      const metadata = await this.filesystem.stat(canonical);
      return metadata.isDirectory() ? canonical : null;
    } catch {
      return null;
    }
  }

  private async readFromWorkspace(
    workspace: string,
    planName: string,
  ): Promise<WorkspacePlanReadResult> {
    const candidate = await this.readCandidate(workspace, planName);
    if (candidate.kind !== 'readable') return candidate;
    const parsed = parseSupervisedPlan({
      source: candidate.source,
      planPath: candidate.canonicalPath,
      workspacePath: workspace,
    });
    return parsed.kind === 'available'
      ? parsed
      : {
          kind: 'source',
          title: fallbackTitle(planName, candidate.source),
          source: candidate.source,
        };
  }

  private async readCandidate(workspace: string, planName: string): Promise<ReadCandidateResult> {
    if (!isPlanPath(planName)) return { kind: 'missing' };
    const path = resolve(workspace, ...planName.split('/'));
    if (!isWithin(workspace, path)) return { kind: 'missing' };
    try {
      const before = await this.filesystem.lstat(path);
      if (!before.isFile() || before.isSymbolicLink() || before.size > maximumBytes)
        return { kind: 'unavailable' };
      const canonical = await this.filesystem.realpath(path);
      if (
        !isWithin(workspace, canonical) ||
        toPlanName(relative(workspace, canonical)) !== planName
      )
        return { kind: 'unavailable' };
      const source = await this.filesystem.readFile(canonical, 'utf8');
      const after = await this.filesystem.stat(canonical);
      if (
        !after.isFile() ||
        after.size !== before.size ||
        after.ino !== before.ino ||
        after.dev !== before.dev ||
        after.mtimeMs !== before.mtimeMs
      )
        return { kind: 'unavailable' };
      return { kind: 'readable', source, canonicalPath: canonical };
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? { kind: 'missing' }
        : { kind: 'unavailable' };
    }
  }
}

function isPlanFilename(value: string): boolean {
  return value.endsWith('.org') && value !== '.org';
}

function isPlanPath(value: string): boolean {
  return (
    isPlanFilename(value) &&
    !isAbsolute(value) &&
    !value.includes('\\') &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

function toPlanName(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

function isWithin(workspace: string, candidate: string): boolean {
  const pathWithinWorkspace = relative(workspace, candidate);
  return (
    pathWithinWorkspace === '' ||
    (!pathWithinWorkspace.startsWith(`..${sep}`) &&
      pathWithinWorkspace !== '..' &&
      !isAbsolute(pathWithinWorkspace))
  );
}

function toEntry(planName: string, plan: SupervisedPlan): WorkspacePlanEntry {
  return {
    planName,
    title: plan.title,
    ...(plan.subtitle === undefined ? {} : { subtitle: plan.subtitle }),
    ...(plan.date === undefined ? {} : { date: plan.date }),
    ...(plan.keywords === undefined ? {} : { keywords: plan.keywords }),
    previewAvailable: true,
    totalSteps: plan.totalSteps,
    doneSteps: plan.doneSteps,
    allDone: plan.allDone,
  };
}

function toFallbackEntry(planName: string, source?: string): WorkspacePlanEntry {
  return {
    planName,
    title: fallbackTitle(planName, source),
    previewAvailable: false,
  };
}

function fallbackTitle(planName: string, source?: string): string {
  const declaredTitle = source
    ?.replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => /^#\+TITLE:(?:[ \t](.*))?$/i.exec(line)?.[1]?.trim())
    .find((title) => title);
  const filename = planName.split('/').at(-1) ?? planName;
  return declaredTitle ?? filename.slice(0, -'.org'.length);
}
