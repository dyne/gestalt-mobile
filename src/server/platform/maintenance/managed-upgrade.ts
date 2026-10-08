/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { execFile, type ExecFileOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { UpgradePort } from '../../features/maintenance/upgrade/endpoint.js';
import type { UpgradeStatus } from '../../../shared/contracts/upgrade.js';

const runFile = promisify(execFile);

export class ManagedUpgrade implements UpgradePort {
  private current: UpgradeStatus = { instanceId: randomUUID(), phase: 'idle' };
  private starting: Promise<UpgradeStatus> | undefined;

  constructor(
    private readonly cwd: string,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly run: (
      command: string,
      args: string[],
      options: ExecFileOptions,
    ) => Promise<unknown> = runFile,
    private readonly exists: (path: string) => Promise<boolean> = (path) =>
      access(path).then(
        () => true,
        () => false,
      ),
  ) {}

  async status(): Promise<UpgradeStatus> {
    if (this.current.phase === 'updating' && !this.starting) {
      const state = this.environment.GESTALT_MOBILE_RESTART_STATE;
      if (!state || !(await this.exists(join(dirname(state), 'update-restart.lock')))) {
        this.current = {
          ...this.current,
          phase: 'failed',
          message:
            'The upgrade stopped before Mobile restarted. Check the Gestalt update-restart.log, then retry.',
        };
      }
    }
    return { ...this.current };
  }

  async start(): Promise<UpgradeStatus> {
    if (this.starting) return this.starting;
    if ((await this.status()).phase === 'updating') return { ...this.current };
    // Check again after the asynchronous status read so concurrent requests share one launch.
    if (this.starting) return this.starting;
    if (
      this.environment.GESTALT_MOBILE_PID !== String(process.pid) ||
      !this.environment.GESTALT_MOBILE_RESTART_STATE
    ) {
      throw new Error('A managed Mobile restart descriptor is required');
    }
    this.current = { instanceId: this.current.instanceId, phase: 'updating' };
    this.starting = this.run('gestalt', ['update-restart'], {
      cwd: this.cwd,
      env: this.environment,
      timeout: 15_000,
      maxBuffer: 64 * 1024,
    })
      .then(() => ({ ...this.current }))
      .catch(() => {
        this.current = { ...this.current, phase: 'failed' };
        throw new Error('Could not schedule the managed upgrade');
      })
      .finally(() => {
        this.starting = undefined;
      });
    return this.starting;
  }
}
