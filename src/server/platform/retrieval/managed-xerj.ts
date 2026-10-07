/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type {
  RetrievalCapability,
  RetrievalCapabilityPort,
} from '../../features/skills/application/ports.js';

/** The manager alone owns backend identity, authentication and shared lifetime. */
export class ManagedXerj implements RetrievalCapabilityPort {
  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  async check(input: {
    cwd: string;
    deadline: number;
    start: boolean;
  }): Promise<RetrievalCapability> {
    const manager = await this.manager();
    if (!manager) return { status: 'absent' };
    const remaining = input.deadline - Date.now();
    if (remaining <= 0) return { status: 'unavailable', reason: 'readiness-timeout' };
    return new Promise((resolve) => {
      const child = spawn(manager, ['xerj', input.start ? 'ensure-ready' : 'probe'], {
        cwd: input.cwd,
        env: { ...this.environment, XERJ_READY_TIMEOUT_MS: String(remaining) },
        shell: false,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let output = '';
      let finished = false;
      const settle = (result: RetrievalCapability) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve(result);
      };
      const unavailable = (reason: string): RetrievalCapability => ({
        status: 'unavailable',
        reason,
      });
      const timer = setTimeout(() => {
        // Reap the owned probe; never signal the manager's shared backend.
        child.kill('SIGTERM');
        const kill = setTimeout(() => child.kill('SIGKILL'), 100).unref();
        child.once('close', () => clearTimeout(kill));
        settle(unavailable('readiness-timeout'));
      }, remaining);
      child.on('error', () => settle(unavailable('manager-unavailable')));
      child.stdout.on('data', (data: Buffer) => {
        output += data.toString();
        if (output.length > 16_384) {
          child.kill('SIGKILL');
          settle(unavailable('invalid-manager-response'));
        }
      });
      child.once('close', (code) => {
        try {
          const value = JSON.parse(output);
          if (code !== 0 || value.schemaVersion !== 1) throw new Error();
          if (value.status === 'absent') return settle({ status: 'absent' });
          if (value.status === 'unavailable')
            return settle(unavailable('managed-backend-unavailable'));
          if (
            value.status !== 'ready' ||
            value.version !== '1.0.0-rc.87' ||
            typeof value.endpoint !== 'string' ||
            !/^http:\/\/(127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/.test(value.endpoint)
          )
            throw new Error();
          const url = new URL(value.endpoint);
          if (Number(url.port || 80) < 1 || Number(url.port || 80) > 65535) throw new Error();
          settle({ status: 'ready', manager, endpoint: value.endpoint });
        } catch {
          settle(unavailable('invalid-manager-response'));
        }
      });
    });
  }

  private async manager(): Promise<string | undefined> {
    const explicit = this.environment.GESTALT_MANAGER_BIN;
    const paths = explicit
      ? [explicit]
      : (this.environment.PATH ?? '')
          .split(':')
          .filter(Boolean)
          .map((path) => join(path, 'gestalt'));
    for (const path of paths) {
      if (!isAbsolute(path)) continue;
      try {
        await access(path, constants.X_OK);
        return path;
      } catch {
        /* Try next established executable path. */
      }
    }
    return undefined;
  }
}

export function xerjDeadline(environment: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(environment.XERJ_READY_TIMEOUT_MS);
  return (
    Date.now() +
    (Number.isInteger(configured) && configured > 0 && configured <= 300_000 ? configured : 5_000)
  );
}
