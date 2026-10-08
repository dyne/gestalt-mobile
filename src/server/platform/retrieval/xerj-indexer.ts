/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  checkXerjIndexConfig,
  saveXerjIndexConfig,
  xerjContentArguments,
  xerjIndexConfig,
} from './xerj-index-config.js';
import type { XerjStatus } from '../../../shared/contracts/xerj-status.js';
import type { RetrievalCapabilityPort } from '../../features/skills/application/ports.js';
import { xerjDeadline } from './managed-xerj.js';

// Native gitignore syntax, editable by the host operator. Hidden directories and
// symlinks are already skipped by XERJ. Never replace an existing root policy.
export const xerjDefaultIgnores = `# Gestalt source discovery. Edit these native XERJ rules to change scope.
# Keep useful vendored source; XERJ otherwise excludes vendor by default.
!vendor/
node_modules/
target/
build/
dist/
coverage/
__pycache__/
.cache/
.next/
.astro/
*.o
*.obj
*.a
*.so
*.dll
*.exe
*.class
*.pyc
*.wasm
*.map
*.min.js
*.lock
*.tmp
*.swp
*.log
*.zip
*.tar
*.gz
*.sqlite*
*.db
*.pem
*.key
id_rsa*
id_ed25519*
credentials*
secrets/
package-cache/
`;

/** One host-owned child; backend supervision and watcher locking stay in the manager. */
export class XerjIndexer {
  private value: XerjStatus;
  private child?: ChildProcess;
  private task?: Promise<void>;
  private closed = false;
  private saveConfiguration?: () => Promise<void>;
  private configurationSaved?: Promise<void>;

  constructor(
    root: string,
    mode: XerjStatus['mode'],
    private readonly capability: RetrievalCapabilityPort,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly report: (message: string) => void = console.warn,
  ) {
    this.value = { root, mode, state: mode === 'off' ? 'disabled' : 'starting' };
  }

  status(): XerjStatus {
    return { ...this.value };
  }

  start(): void {
    if (this.task || this.closed || this.value.mode === 'off') return;
    this.task = this.launch().catch(() => {
      if (!this.closed)
        this.fail('Could not start XERJ indexing. Check root access and run gestalt doctor.');
    });
  }

  private fail(message: string): void {
    this.value = { ...this.value, state: 'error', message };
    this.report(message);
  }

  private async launch(): Promise<void> {
    const root = await realpath(this.value.root);
    const namespace = `ax-${createHash('sha256').update(root).digest('hex').slice(0, 16)}`;
    this.value = { ...this.value, root, namespace };
    const ready = await this.capability.check({
      cwd: root,
      deadline: xerjDeadline(this.environment),
      start: true,
    });
    if (this.closed) return;
    if (ready.status === 'absent') {
      this.value = {
        ...this.value,
        state: 'absent',
      };
      return;
    }
    if (ready.status !== 'ready') {
      this.fail(
        'XERJ backend unavailable. Run gestalt doctor; check the managed data directory and local port.',
      );
      return;
    }
    if (this.value.mode === 'manual') {
      this.value = { ...this.value, state: 'ready', message: 'Automatic indexing is disabled.' };
      return;
    }
    const directory = join(
      this.environment.CODEX_HOME ?? join(homedir(), '.codex-gestalt'),
      'xerj-data',
      'autoindex',
      namespace,
    );
    const config = xerjIndexConfig(root, namespace, ready.endpoint);
    const compatibility = await checkXerjIndexConfig(directory, config);
    if (this.closed) return;
    if (compatibility === 'incompatible') {
      this.fail(
        'XERJ index settings differ from the saved fingerprint. Restore the previous settings or explicitly rebuild this root index; indexing was not started.',
      );
      return;
    }
    if (compatibility === 'missing')
      this.saveConfiguration = () => saveXerjIndexConfig(directory, config);
    try {
      await writeFile(join(root, '.xerjignore'), xerjDefaultIgnores, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (this.closed) return;
    const child = spawn(
      ready.manager,
      [
        'xerj',
        'autoindex',
        root,
        '--url',
        ready.endpoint,
        '--prefix',
        namespace,
        '--watch',
        ...xerjContentArguments,
        '--yes',
        '--workers',
        '2',
        '--pdf-workers',
        '1',
        '--bulk-mb',
        '4',
        '--debounce',
        '2000',
        '--progress',
        'json',
      ],
      { cwd: root, env: this.environment, shell: false, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    this.child = child;
    this.value = { ...this.value, state: 'indexing' };
    // Never retain raw tool output or filenames. The status contains only an
    // allowlist of counters/phases; bound even a malformed unterminated line.
    let pending = '';
    child.stderr?.on('data', (data: Buffer) => {
      pending += data.toString();
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      if (pending.length > 16_384) pending = '';
      for (const line of lines) this.progress(line);
    });
    child.once('error', () => {
      if (!this.closed)
        this.fail(
          'Could not launch XERJ. Check the Gestalt manager and flock/setpriv installation.',
        );
    });
    child.once('close', (code) => {
      this.child = undefined;
      if (this.closed) return;
      if (code === 75) {
        this.value = {
          ...this.value,
          state: 'shared',
          message: 'Another watcher owns this root. Progress is available in its Mobile instance.',
        };
      } else {
        this.fail(
          `XERJ watcher stopped (exit ${code ?? 'signal'}). Run gestalt doctor; verify flock and setpriv are installed, then restart Mobile.`,
        );
      }
    });
  }

  private progress(line: string): void {
    if (this.closed) return;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.event === 'progress') {
        const phase =
          typeof event.phase === 'string' && /^[a-z-]{1,32}$/.test(event.phase)
            ? event.phase
            : undefined;
        const percent =
          typeof event.pct === 'number' && event.pct >= 0 && event.pct <= 100
            ? event.pct
            : undefined;
        this.value = { ...this.value, state: 'indexing', phase, percent, message: undefined };
      } else if (event.event === 'done') {
        if (event.ok !== true) {
          this.fail(
            'XERJ indexing failed. Check the index with gestalt xerj autoindex status; the next source change retries it.',
          );
          return;
        }
        if (this.saveConfiguration && !this.configurationSaved) {
          this.configurationSaved = this.saveConfiguration().catch(() => {
            this.fail(
              'XERJ indexed successfully but could not save its configuration fingerprint. Check write access to the managed index directory.',
            );
          });
        }
        this.value = {
          ...this.value,
          state: 'watching',
          phase: undefined,
          percent: undefined,
          lastUpdate: new Date().toISOString(),
          message: undefined,
          ...(count(event.files) !== undefined ? { files: count(event.files) } : {}),
          ...(count(event.records) !== undefined ? { records: count(event.records) } : {}),
        };
      } else if (event.event === 'warning') {
        if (
          typeof event.message === 'string' &&
          event.message.includes('refusing ambiguous assignment')
        ) {
          this.fail(
            'XERJ incremental dataset assignment failed; the index is stale. See the XERJ recovery guide for this upstream limitation.',
          );
          return;
        }
        this.fail(
          'XERJ reported an indexing warning. Inspect the index with gestalt xerj autoindex status; source changes trigger another pass.',
        );
      }
    } catch {
      /* Native diagnostics are not public status or application logs. */
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.task;
    await this.configurationSaved;
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        child.once('close', resolve);
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
        child.once('close', () => clearTimeout(timer));
      });
    }
    this.value = { ...this.value, state: this.value.mode === 'off' ? 'disabled' : 'stopped' };
  }
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
