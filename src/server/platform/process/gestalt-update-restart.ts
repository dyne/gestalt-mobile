/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { UpdateRestartScheduler } from '../../features/maintenance/application/ports.js';

const runFile = promisify(execFile);
type CommandRunner = (
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number },
) => Promise<unknown>;

export class GestaltUpdateRestartScheduler implements UpdateRestartScheduler {
  constructor(
    private readonly run: CommandRunner = (command, args, options) =>
      runFile(command, [...args], options),
  ) {}

  async schedule(): Promise<void> {
    try {
      await this.run('gestalt', ['update-restart'], {
        env: process.env,
        timeout: 15_000,
        maxBuffer: 64 * 1024,
      });
    } catch {
      throw new Error('Gestalt update and restart could not be scheduled');
    }
  }
}
