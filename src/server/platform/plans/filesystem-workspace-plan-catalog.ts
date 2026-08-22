/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { WorkspacePlanCatalogSource } from '../../features/plans/application/ports.js';
import { parseSupervisedPlan } from '../../features/plans/application/parse-supervised-plan.js';
import type { SupervisedPlan } from '../../features/plans/domain/supervised-plan.js';
import type {
  WorkspacePlanEntry,
  WorkspacePlanReadResult,
} from '../../features/plans/domain/workspace-plan-catalog.js';

const maximumBytes = 1_048_576;

type Filesystem = Pick<
  typeof import('node:fs/promises'),
  'lstat' | 'readdir' | 'readFile' | 'realpath' | 'stat'
>;

type ReadCandidateResult =
  | Readonly<{ kind: 'readable'; source: string; canonicalPath: string }>
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'unavailable' }>;

/**
 * Passive access to every regular `.org` file below a workspace. Symlinks are
 * never followed. Supported supervised plans include a browser preview; other
 * Org files remain visible in the catalog without one.
 */
export class FilesystemWorkspacePlanCatalog implements WorkspacePlanCatalogSource {
  constructor(
    private readonly filesystem: Filesystem = { lstat, readdir, readFile, realpath, stat },
  ) {}

  async list(workspacePath: string): Promise<readonly WorkspacePlanEntry[]> {
    const workspace = await this.workspace(workspacePath);
    if (!workspace) return [];
    const planNames = await this.discover(workspace);
    const entries: WorkspacePlanEntry[] = [];
    for (const planName of planNames) {
      const candidate = await this.readCandidate(workspace, planName);
      if (candidate.kind === 'missing') continue;
      if (candidate.kind === 'unavailable') {
        entries.push(toFallbackEntry(planName));
        continue;
      }
      const parsed = parseSupervisedPlan({
        source: candidate.source,
        planPath: candidate.canonicalPath,
        workspacePath: workspace,
      });
      entries.push(
        parsed.kind === 'available'
          ? toEntry(planName, parsed.plan)
          : toFallbackEntry(planName, candidate.source),
      );
    }
    return entries;
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

  private async discover(workspace: string): Promise<string[]> {
    const pending = [workspace];
    const visited = new Set<string>();
    const plans: string[] = [];

    while (pending.length > 0) {
      const directory = pending.pop()!;
      try {
        const before = await this.filesystem.lstat(directory);
        if (!before.isDirectory() || before.isSymbolicLink()) continue;
        const canonical = await this.filesystem.realpath(directory);
        if (!isWithin(workspace, canonical)) continue;
        const metadata = await this.filesystem.stat(canonical);
        if (!metadata.isDirectory() || visited.has(canonical)) continue;
        visited.add(canonical);

        const children = await this.filesystem.readdir(canonical, {
          encoding: 'utf8',
          withFileTypes: true,
        });
        for (const child of children) {
          if (child.isSymbolicLink()) continue;
          const childPath = join(canonical, child.name);
          if (child.isDirectory()) pending.push(childPath);
          else if (child.isFile() && isPlanFilename(child.name)) {
            const planName = toPlanName(relative(workspace, childPath));
            if (isPlanPath(planName)) plans.push(planName);
          }
        }
      } catch {
        // A disappearing or unreadable branch does not hide plans elsewhere.
      }
    }

    return plans.sort((left, right) => left.localeCompare(right));
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
