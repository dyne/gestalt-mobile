/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { constants } from 'node:fs';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { spawn } from 'node:child_process';
import { withoutSessionScratch } from '../scratch/child-environment.js';
import { stopOwnedProcessGroup } from '../scratch/owned-process-group.js';

export const playwrightServerName = 'gestalt-playwright';
export const playwrightTools = [
  'browser_navigate',
  'browser_snapshot',
  'browser_fill_form',
  'browser_take_screenshot',
  'browser_close',
];
export type PlaywrightInstallation =
  { status: 'absent' | 'unavailable' } | { status: 'installed'; manager: string; version: string };
export type PlaywrightReadiness = Readonly<{
  ready: boolean;
  package: 'ready' | 'unavailable' | 'unknown';
  chrome: 'ready' | 'unavailable' | 'unknown';
  node: 'ready' | 'unavailable' | 'unknown';
  chromeVersion: string | null;
  browserTest?: 'passed' | 'failed' | 'not-run';
  playwrightVersion?: string | null;
}>;
const unknownReadiness = (): PlaywrightReadiness => ({
  ready: false,
  package: 'unknown',
  chrome: 'unknown',
  node: 'unknown',
  chromeVersion: null,
});

/** Bounded reads only. Installation and Chrome ownership remain with the operator. */
export class ManagedPlaywright {
  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  async check(): Promise<PlaywrightInstallation> {
    const home =
      this.environment.GESTALT_HOME ?? join(this.environment.HOME ?? homedir(), '.gestalt');
    try {
      const root = await realpath(join(home, 'playwright'));
      const path = join(root, 'active.json');
      if ((await stat(path)).size > 262_144) return { status: 'unavailable' };
      const install = JSON.parse(await readFile(path, 'utf8'));
      if (
        install.schemaVersion !== 1 ||
        install.contractVersion !== 1 ||
        typeof install.version !== 'string' ||
        install.version.length > 32 ||
        !/^\d+\.\d+\.\d+$/.test(install.version) ||
        typeof install.release !== 'string' ||
        !isAbsolute(install.release)
      )
        return { status: 'unavailable' };
      const release = await realpath(install.release);
      if (dirname(release) !== root || !basename(release).startsWith(`release-${install.version}-`))
        return { status: 'unavailable' };
      const candidates = this.environment.GESTALT_MANAGER_BIN
        ? [this.environment.GESTALT_MANAGER_BIN]
        : (this.environment.PATH ?? '')
            .split(':')
            .filter(Boolean)
            .map((path) => join(path, 'gestalt'));
      for (const manager of candidates) {
        if (!isAbsolute(manager)) continue;
        try {
          await access(manager, constants.X_OK);
          return { status: 'installed', manager, version: install.version };
        } catch {
          /* Try the next operator-owned executable. */
        }
      }
      return { status: 'unavailable' };
    } catch (error) {
      return {
        status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unavailable',
      };
    }
  }

  /** Doctor never repairs or installs. --launch explicitly opts into an isolated browser test. */
  async ready(
    manager: string,
    cwd: string,
    deadline: number,
    options: readonly string[] = [],
    scratchEnvironment?: Readonly<Record<string, string>>,
  ): Promise<PlaywrightReadiness> {
    if (Date.now() >= deadline) return unknownReadiness();
    const independent = withoutSessionScratch(this.environment);
    const env = Object.fromEntries(
      ['PATH', 'HOME', 'GESTALT_HOME', 'TMPDIR', 'TMP', 'TEMP']
        .filter((key) => independent[key] !== undefined)
        .map((key) => [key, independent[key]]),
    );
    Object.assign(env, scratchEnvironment);
    return new Promise((resolve, reject) => {
      const child = spawn(manager, ['playwright', 'doctor', '--json', '--cwd', cwd, ...options], {
        cwd,
        env,
        shell: false,
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let output = '',
        overflow = false;
      const kill = () => {
        if (child.pid && child.exitCode === null && child.signalCode === null)
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            /* Only this owned group. */
          }
      };
      const timer = setTimeout(kill, Math.max(1, deadline - Date.now()));
      child.stdout.on('data', (data) => {
        if (output.length + data.length > 32768) {
          overflow = true;
          kill();
        } else output += data;
      });
      child.once('error', () => {
        clearTimeout(timer);
        if (!child.pid) resolve(unknownReadiness());
        else {
          overflow = true;
          kill();
        }
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        void (async () => {
          if (!(await stopOwnedProcessGroup(child, 0, 1000)))
            throw new Error('SESSION_RELEASE_UNCONFIRMED');
          try {
            const value = JSON.parse(output);
            if (overflow || value.schemaVersion !== 1 || value.contractVersion !== 1) {
              resolve(unknownReadiness());
              return;
            }
            const status = (ready: unknown) =>
              ready === true
                ? ('ready' as const)
                : ready === false
                  ? ('unavailable' as const)
                  : ('unknown' as const);
            resolve({
              ready:
                code === 0 &&
                value.ready === true &&
                value.package?.ready === true &&
                value.chrome?.ready === true &&
                value.node?.ready === true,
              package: status(value.package?.ready),
              chrome: status(value.chrome?.ready),
              node: status(value.node?.ready),
              playwrightVersion:
                typeof value.package?.playwrightVersion === 'string' &&
                value.package.playwrightVersion.length <= 100 &&
                /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(value.package.playwrightVersion)
                  ? value.package.playwrightVersion
                  : null,
              browserTest: ['passed', 'failed', 'not-run'].includes(value.browserTest)
                ? value.browserTest
                : 'not-run',
              chromeVersion:
                typeof value.chrome?.version === 'string' &&
                value.chrome.version.length <= 64 &&
                /^\d+(?:\.\d+){1,3}$/.test(value.chrome.version)
                  ? value.chrome.version
                  : null,
            });
          } catch {
            resolve(unknownReadiness());
          }
        })().catch(reject);
      });
    });
  }
}
