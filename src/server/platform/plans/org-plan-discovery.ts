/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withoutSessionScratch } from '../scratch/child-environment.js';

const execute = promisify(execFile);
type Run = (command: string, args: readonly string[], cwd: string) => Promise<string>;

async function run(command: string, args: readonly string[], cwd: string): Promise<string> {
  try {
    const result = await execute(command, [...args], {
      cwd,
      env: withoutSessionScratch(),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30_000,
    });
    return result.stdout;
  } catch (error) {
    const failure = error as { code?: string | number; stdout?: string; killed?: boolean };
    // Permission errors in one branch must not hide readable plans elsewhere.
    if (failure.code === 1 && !failure.killed && typeof failure.stdout === 'string')
      return failure.stdout;
    throw error;
  }
}

/** Native, NUL-delimited discovery; never invokes a shell or follows symlinks. */
export class OrgPlanDiscovery {
  private command: 'bfs' | 'find' = 'bfs';

  constructor(private readonly execute: Run = run) {}

  async list(workspace: string): Promise<string[]> {
    // Mark checkout roots without walking their Git metadata. A repository under
    // a .gestalt directory is an internal checkout, not another project to list.
    const args = [
      '.',
      '-name',
      '.git',
      '-print0',
      '-prune',
      '-o',
      '-type',
      'd',
      '(',
      '-path',
      '*/tmp/sessions',
      '-o',
      '-path',
      '*/.gestalt/evidence',
      ')',
      '-prune',
      '-o',
      '-type',
      'f',
      '-name',
      '*.org',
      '-path',
      '*/.gestalt/*',
      '-print0',
    ];
    let output: string;
    try {
      output = await this.execute(this.command, args, workspace);
    } catch (error) {
      if (this.command !== 'bfs' || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.command = 'find';
      output = await this.execute('find', args, workspace);
    }
    const paths = [
      ...new Set(
        output
          .split('\0')
          .filter(Boolean)
          .map((path) => path.replace(/^\.\//, '')),
      ),
    ];
    const internalCheckouts = new Set(
      paths
        .filter(
          (path) => path.endsWith('/.git') && path.split('/').slice(0, -2).includes('.gestalt'),
        )
        .map((path) => path.slice(0, -'/.git'.length)),
    );
    return paths.filter((path) => {
      if (!path.endsWith('.org')) return false;
      for (let end = path.lastIndexOf('/'); end > 0; end = path.lastIndexOf('/', end - 1)) {
        if (internalCheckouts.has(path.slice(0, end))) return false;
      }
      return true;
    });
  }
}
