/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import type { WorkspacePlanCatalogSource } from '../../features/plans/application/ports.js';
import type { ExecutionPlanRead } from '../../features/plans/application/prepare-org-plan-supervision.js';
import { parseSupervisedPlan } from '../../features/plans/application/parse-supervised-plan.js';
import type { SupervisedPlan } from '../../features/plans/domain/supervised-plan.js';
import type {
  WorkspacePlanEntry,
  WorkspacePlanReadResult,
} from '../../features/plans/domain/workspace-plan-catalog.js';

import { OrgPlanDiscovery } from './org-plan-discovery.js';
import { archiveOrgPlan, isArchivedOrgPlan } from './org-plan-archive-tag.js';

const maximumBytes = 1_048_576;

type Filesystem = Pick<typeof import('node:fs/promises'), 'lstat' | 'realpath' | 'stat'> & {
  readFile(path: string, encoding: 'utf8'): Promise<string>;
};

type ReadCandidateResult =
  | Readonly<{ kind: 'readable'; source: string; canonicalPath: string; revision: string }>
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'unavailable' }>;

type CatalogFile = {
  signature: string;
  entry: WorkspacePlanEntry;
  sortDate: number;
  copyKey?: string;
};

type CatalogCache = {
  entries: readonly WorkspacePlanEntry[] | null;
  files: Map<string, CatalogFile>;
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
    const entries = new Array<CatalogFile | null>(planNames.length).fill(null);
    const files: CatalogCache['files'] = new Map();
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(8, planNames.length) }, async () => {
        while (next < planNames.length) {
          const index = next++;
          const name = planNames[index]!;
          let metadata: Awaited<ReturnType<Filesystem['lstat']>>;
          try {
            metadata = await this.filesystem.lstat(resolve(workspace, ...name.split('/')));
            if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
          } catch {
            continue;
          }
          const signature = [
            metadata.dev,
            metadata.ino,
            metadata.size,
            metadata.mtimeMs,
            metadata.ctimeMs,
          ].join(':');
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
            entries[index] = previous;
            files.set(name, previous);
            continue;
          }
          const candidate = await this.readCandidate(workspace, name);
          if (candidate.kind === 'missing') continue;
          let entry: WorkspacePlanEntry;
          let copyKey: string | undefined;
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
            copyKey = catalogCopyKey(name, candidate.source);
          }
          const file = {
            signature,
            entry,
            sortDate: catalogDate(entry.date, metadata.mtimeMs),
            copyKey,
          };
          if (candidate.kind === 'readable') files.set(name, file);
          entries[index] = file;
        }
      }),
    );
    cache.files = files;
    cache.entries = orderCatalog(entries);
    cache.refreshedAt = this.now();
    return cache.entries;
  }

  async read(workspacePath: string, planName: string): Promise<WorkspacePlanReadResult> {
    if (!isPlanPath(planName)) return { kind: 'missing' };
    const workspace = await this.workspace(workspacePath);
    if (!workspace) return { kind: 'missing' };
    return this.readFromWorkspace(workspace, planName);
  }

  /** Downloads the original Org text through the same bounded, confined reader as the viewer. */
  async readSource(
    workspacePath: string,
    planName: string,
  ): Promise<{ kind: 'available'; source: string } | { kind: 'missing' | 'unavailable' }> {
    if (!isPlanPath(planName)) return { kind: 'missing' };
    const workspace = await this.workspace(workspacePath);
    if (!workspace) return { kind: 'missing' };
    const candidate = await this.readCandidate(workspace, planName);
    return candidate.kind === 'readable'
      ? { kind: 'available', source: candidate.source }
      : candidate;
  }

  /** Reuses the exact viewer reader without trusting its cached preview or sourcePath. */
  async readExecution(workspacePath: string, planName: string): Promise<ExecutionPlanRead> {
    if (!isPlanPath(planName)) return { kind: 'missing' };
    const workspace = await this.workspace(workspacePath);
    if (!workspace) return { kind: 'missing' };
    const candidate = await this.readCandidate(workspace, planName);
    if (candidate.kind !== 'readable') return candidate;
    const parsed = parseSupervisedPlan({
      source: candidate.source,
      planPath: candidate.canonicalPath,
      workspacePath: workspace,
    });
    return parsed.kind === 'available'
      ? { ...parsed, canonicalPath: candidate.canonicalPath, revision: candidate.revision }
      : { kind: 'invalid', reason: parsed.reason };
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
      ? { ...parsed, sourcePath: candidate.canonicalPath }
      : {
          kind: 'source',
          title: fallbackTitle(planName, candidate.source),
          source: candidate.source,
          sourcePath: candidate.canonicalPath,
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
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs
      )
        return { kind: 'unavailable' };
      const revision = createHash('sha256')
        .update(
          JSON.stringify([
            canonical,
            after.dev,
            after.ino,
            after.size,
            after.mtimeMs,
            after.ctimeMs,
            source,
          ]),
        )
        .digest('hex');
      return { kind: 'readable', source, canonicalPath: canonical, revision };
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
  const date = orgHeader('DATE', source);
  return {
    planName,
    title: fallbackTitle(planName, source),
    ...(date === undefined ? {} : { date }),
    previewAvailable: false,
  };
}

function orgHeader(key: 'TITLE' | 'DATE', source?: string): string | undefined {
  const pattern = new RegExp(`^#\\+${key}:(?:[ \\t](.*))?$`, 'i');
  return source
    ?.replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => pattern.exec(line)?.[1]?.trim())
    .find((value) => value);
}

function fallbackTitle(planName: string, source?: string): string {
  const filename = planName.split('/').at(-1) ?? planName;
  return orgHeader('TITLE', source) ?? filename.slice(0, -'.org'.length);
}

function catalogCopyKey(planName: string, source: string): string {
  const parts = planName.split('/');
  const owner = parts.slice(0, parts.indexOf('.gestalt')).join('/');
  // A copied plan stays collapsed after archiving the selected original.
  const digest = createHash('sha256').update(archiveOrgPlan(source)).digest('hex');
  return JSON.stringify([owner, parts.at(-1), digest]);
}

function catalogDate(date: string | undefined, modifiedAt: number): number {
  const day = /^(?:<|\[)?(\d{4}-\d{2}-\d{2})(?=$|[T \t>\]])/.exec(date ?? '')?.[1];
  if (!day) return modifiedAt;
  const parsed = new Date(`${day}T00:00:00Z`);
  return parsed.toJSON()?.startsWith(day) ? parsed.getTime() : modifiedAt;
}

function orderCatalog(entries: readonly (CatalogFile | null)[]): WorkspacePlanEntry[] {
  const unique = new Map<string, CatalogFile>();
  for (const file of entries) {
    if (!file) continue;
    const key = file.copyKey ?? file.entry.planName;
    const previous = unique.get(key);
    if (
      !previous ||
      file.entry.planName.split('/').length < previous.entry.planName.split('/').length
    )
      unique.set(key, file);
  }
  const completed = (entry: WorkspacePlanEntry) => Boolean(entry.allDone || entry.archived);
  return [...unique.values()]
    .sort((left, right) => {
      const leftDone = completed(left.entry);
      const rightDone = completed(right.entry);
      return (
        Number(leftDone) - Number(rightDone) ||
        (leftDone ? 0 : right.sortDate - left.sortDate) ||
        left.entry.planName.localeCompare(right.entry.planName)
      );
    })
    .map(({ entry }) => entry);
}
