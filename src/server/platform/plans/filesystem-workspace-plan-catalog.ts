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
import type { WorkspaceOrgPlanValidator } from './org-plan-command-validator.js';

const maximumBytes = 1_048_576;

type Filesystem = Pick<
  typeof import('node:fs/promises'),
  'lstat' | 'readdir' | 'readFile' | 'realpath' | 'stat'
>;

/**
 * Passive access to every regular `.org` file below a workspace. Symlinks are
 * never followed, and every candidate must pass the installed Org Plan helper
 * before it is projected for the browser.
 */
export class FilesystemWorkspacePlanCatalog implements WorkspacePlanCatalogSource {
  constructor(
    private readonly validator: WorkspaceOrgPlanValidator,
    private readonly filesystem: Filesystem = { lstat, readdir, readFile, realpath, stat },
  ) {}

  async list(workspacePath: string): Promise<readonly WorkspacePlanEntry[]> {
    const workspace = await this.workspace(workspacePath);
    if (!workspace) return [];
    const planNames = await this.discover(workspace);
    const entries: WorkspacePlanEntry[] = [];
    for (const planName of planNames) {
      const result = await this.readFromWorkspace(workspace, planName);
      if (result.kind !== 'available') continue;
      entries.push(toEntry(planName, result.plan));
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
      if (!(await this.validator.validate(workspace, canonical))) return { kind: 'unavailable' };
      const after = await this.filesystem.stat(canonical);
      if (
        !after.isFile() ||
        after.size !== before.size ||
        after.ino !== before.ino ||
        after.dev !== before.dev ||
        after.mtimeMs !== before.mtimeMs
      )
        return { kind: 'unavailable' };
      const parsed = parseSupervisedPlan({ source, planPath: canonical, workspacePath: workspace });
      return parsed.kind === 'available' ? parsed : { kind: 'unavailable' };
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
    totalSteps: plan.totalSteps,
    doneSteps: plan.doneSteps,
    allDone: plan.allDone,
  };
}
