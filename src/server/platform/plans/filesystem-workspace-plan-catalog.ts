/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import type { WorkspacePlanCatalogSource } from '../../features/plans/application/ports.js';
import { parseSupervisedPlan } from '../../features/plans/application/parse-supervised-plan.js';
import type { SupervisedPlan } from '../../features/plans/domain/supervised-plan.js';
import type { WorkspacePlanEntry, WorkspacePlanReadResult } from '../../features/plans/domain/workspace-plan-catalog.js';

const maximumPlans = 100;
const maximumBytes = 1_048_576;

type Filesystem = Pick<typeof import('node:fs/promises'), 'lstat' | 'readdir' | 'readFile' | 'realpath' | 'stat'>;

/**
 * Bounded, passive access to direct `.gestalt/*.org` children. Every path is
 * revalidated after discovery so a workspace cannot escape through symlinks or
 * replacement races.
 */
export class FilesystemWorkspacePlanCatalog implements WorkspacePlanCatalogSource {
  constructor(private readonly filesystem: Filesystem = { lstat, readdir, readFile, realpath, stat }) {}

  async list(workspacePath: string): Promise<readonly WorkspacePlanEntry[]> {
    const directory = await this.directory(workspacePath);
    if (!directory) return [];
    let names: string[];
    try {
      names = (await this.filesystem.readdir(directory, { encoding: 'utf8' }))
        .filter((name) => isPlanName(name))
        .sort((left, right) => left.localeCompare(right));
    } catch {
      return [];
    }

    const entries: WorkspacePlanEntry[] = [];
    for (const name of names.slice(0, maximumPlans)) {
      const result = await this.readFromDirectory(workspacePath, directory, name);
      if (result.kind !== 'available') continue;
      entries.push(toEntry(name, result.plan));
    }
    return entries;
  }

  async read(workspacePath: string, planName: string): Promise<WorkspacePlanReadResult> {
    if (!isPlanName(planName)) return { kind: 'missing' };
    const directory = await this.directory(workspacePath);
    if (!directory) return { kind: 'missing' };
    return this.readFromDirectory(workspacePath, directory, planName);
  }

  private async directory(workspacePath: string): Promise<string | null> {
    if (!isAbsolute(workspacePath)) return null;
    const workspace = resolve(workspacePath);
    const directory = join(workspace, '.gestalt');
    try {
      const metadata = await this.filesystem.lstat(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) return null;
      const [canonicalWorkspace, canonicalDirectory] = await Promise.all([
        this.filesystem.realpath(workspace),
        this.filesystem.realpath(directory),
      ]);
      return dirname(canonicalDirectory) === canonicalWorkspace ? canonicalDirectory : null;
    } catch {
      return null;
    }
  }

  private async readFromDirectory(
    workspacePath: string,
    directory: string,
    planName: string,
  ): Promise<WorkspacePlanReadResult> {
    const path = join(directory, planName);
    try {
      const before = await this.filesystem.lstat(path);
      if (!before.isFile() || before.isSymbolicLink() || before.size > maximumBytes)
        return { kind: 'unavailable' };
      const canonical = await this.filesystem.realpath(path);
      if (dirname(canonical) !== directory || basename(canonical) !== planName)
        return { kind: 'unavailable' };
      const source = await this.filesystem.readFile(canonical, 'utf8');
      const after = await this.filesystem.stat(canonical);
      if (!after.isFile() || after.size !== before.size || after.ino !== before.ino || after.dev !== before.dev)
        return { kind: 'unavailable' };
      const parsed = parseSupervisedPlan({ source, planPath: canonical, workspacePath });
      return parsed.kind === 'available' ? parsed : { kind: 'unavailable' };
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? { kind: 'missing' }
        : { kind: 'unavailable' };
    }
  }
}

function isPlanName(value: string): boolean {
  return (
    value.endsWith('.org') &&
    value !== '.org' &&
    !isAbsolute(value) &&
    basename(value) === value &&
    !value.includes('\\') &&
    value !== '.' &&
    value !== '..'
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
