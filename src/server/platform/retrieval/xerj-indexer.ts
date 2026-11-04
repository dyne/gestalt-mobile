/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { ServiceScratchLease } from '../../features/sessions/application/session-scratch.js';
import { withoutSessionScratch } from '../scratch/child-environment.js';
import { stopOwnedProcessGroup } from '../scratch/owned-process-group.js';
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
import type { XerjIndexDiagnostic, XerjStatus } from '../../../shared/contracts/xerj-status.js';
import type { RetrievalCapabilityPort } from '../../features/skills/application/ports.js';
import { xerjStartupTimeout } from './managed-xerj.js';
import { ReadinessEvidence } from './readiness-evidence.js';
import { saveXerjIndexDiagnostic, xerjIndexDiagnostic } from './xerj-index-diagnostic.js';
import {
  parseXerjStartupReason,
  xerjStartupMessage,
} from '../../../shared/contracts/xerj-startup.js';

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
  private readonly evidence = new ReadinessEvidence();
  private child?: ChildProcess;
  private scratch?: ServiceScratchLease;
  private task?: Promise<void>;
  private closed = false;
  private saveConfiguration?: () => Promise<void>;
  private configurationSaved?: Promise<void>;
  private diagnosticDirectory?: string;
  private pendingDiagnostic?: XerjIndexDiagnostic;
  private diagnosticSaved?: Promise<void>;
  private diskBudgetRefused = false;
  private currentFailure?: XerjIndexDiagnostic;

  constructor(
    root: string,
    mode: XerjStatus['mode'],
    private readonly capability: RetrievalCapabilityPort,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly report: (message: string) => void = console.warn,
    private readonly serviceScratch?: () => Promise<ServiceScratchLease>,
  ) {
    this.value = { root, mode, state: mode === 'off' ? 'disabled' : 'starting' };
  }

  status(): XerjStatus {
    return { ...this.value, readiness: this.evidence.snapshot() };
  }

  start(): void {
    if (this.task || this.closed || this.value.mode === 'off') return;
    this.task = this.launch().catch((error) => {
      if (!this.closed) this.reportFailure(error);
    });
  }

  private fail(message: string): void {
    this.evidence.coverage(this.value.lastUpdate ? 'stale' : 'unavailable');
    this.value = { ...this.value, state: 'error', phase: undefined, percent: undefined, message };
    this.report(message);
  }

  private rememberDiagnostic(diagnostic: XerjIndexDiagnostic): void {
    this.currentFailure = diagnostic;
    this.value = { ...this.value, diagnostic };
    this.pendingDiagnostic = diagnostic;
    this.diagnosticSaved ??= this.saveDiagnostics();
  }

  private reportFailure(message: unknown): void {
    const diagnostic = xerjIndexDiagnostic(message);
    if (this.currentFailure?.summary && this.genericFailure(diagnostic)) return;
    this.rememberDiagnostic(diagnostic);
    this.fail(
      `XERJ indexing failed: ${diagnostic.summary ?? 'No error cause was supplied'}. Index freshness is unverified.`,
    );
  }

  private genericFailure(diagnostic: XerjIndexDiagnostic): boolean {
    return (
      !diagnostic.summary ||
      /^(?:needs-decision|unknown (?:error|cause)|(?:indexing|autoindex|operation|pass) failed)$/i.test(
        diagnostic.summary,
      )
    );
  }

  private async launch(): Promise<void> {
    const root = await realpath(this.value.root);
    const namespace = `ax-${createHash('sha256').update(root).digest('hex').slice(0, 16)}`;
    this.value = { ...this.value, root, namespace };
    const ready = await this.capability.check({
      cwd: root,
      // This background task waits for backend startup, not the chat allowance.
      // Leave room for the owned manager client's bounded shutdown.
      deadline: Date.now() + xerjStartupTimeout(this.environment) + 1_000,
      start: true,
    });
    if (this.closed) return;
    if (ready.status === 'absent') {
      this.evidence.connection('unavailable');
      this.evidence.coverage('unavailable');
      this.value = {
        ...this.value,
        state: 'absent',
      };
      return;
    }
    if (ready.status !== 'ready') {
      this.evidence.connection('unavailable');
      this.fail(
        `${xerjStartupMessage(parseXerjStartupReason(ready.status === 'unavailable' ? ready.reason : 'unknown'))} Inspect gestalt xerj status.`,
      );
      return;
    }
    this.evidence.connection('ready');
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
    this.diagnosticDirectory = directory;
    const compatibility = await checkXerjIndexConfig(directory, config);
    if (this.closed) return;
    if (compatibility === 'incompatible') {
      this.fail(
        'XERJ index settings differ from the saved fingerprint. Restore the previous settings or explicitly rebuild this root index; indexing was not started.',
      );
      this.evidence.coverage('stale');
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
    this.scratch = await this.serviceScratch?.();
    if (this.closed) {
      await this.scratch?.release();
      return;
    }
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
      {
        cwd: root,
        env: { ...withoutSessionScratch(this.environment), ...this.scratch?.environment },
        shell: false,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    this.child = child;
    this.value = { ...this.value, state: 'indexing' };
    // Retain only redacted error summaries and allowlisted counters/phases;
    // bound even a malformed unterminated line.
    // Native budget decisions use stdout; progress and watch failures use stderr.
    // Keep separate line buffers so interleaved streams cannot corrupt JSON.
    for (const stream of [child.stdout, child.stderr]) {
      let pending = '';
      stream?.on('data', (data: Buffer) => {
        pending += data.toString();
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        if (pending.length > 16_384) pending = '';
        for (const line of lines) if (line.length <= 16_384) this.progress(line);
      });
    }
    child.once('error', (error) => {
      if (!this.closed) this.reportFailure(error);
    });
    child.once('close', (code) => {
      // Retain the live-owned group handle: leader exit does not prove descendants stopped.
      if (this.closed) return;
      if (code === 75) {
        this.evidence.coverage('unknown');
        this.value = {
          ...this.value,
          state: 'shared',
          message: 'Another watcher owns this root. Progress is available in its Mobile instance.',
        };
      } else {
        this.fail(
          `XERJ watcher stopped${this.currentFailure?.summary ? `: ${this.currentFailure.summary}` : ` (exit ${code ?? 'signal'})`}. Run gestalt doctor before restarting Mobile.`,
        );
      }
    });
  }

  private progress(line: string): void {
    if (this.closed) return;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.xerj === 'autoindex-budget' && event.decision_required === true) {
        const disk = event.disk as Record<string, unknown> | undefined;
        if (
          disk?.threshold_enabled === true &&
          typeof disk.used_percent === 'number' &&
          typeof disk.flood_stage === 'number' &&
          disk.flood_stage > 0 &&
          disk.used_percent <= 100 &&
          disk.used_percent >= disk.flood_stage
        ) {
          this.diskBudgetRefused = true;
          const diagnostic = xerjIndexDiagnostic('no space left: disk flood-stage budget');
          this.rememberDiagnostic(diagnostic);
          this.fail(
            'XERJ indexing refused: disk flood-stage threshold reached. Free space or move the index to a larger volume. Index freshness is unverified.',
          );
        } else {
          this.reportFailure(
            event.error ?? event.refused ?? 'Indexing requires an operator decision',
          );
        }
      } else if (event.event === 'progress') {
        this.diskBudgetRefused = false;
        this.currentFailure = undefined;
        this.evidence.invalidate();
        this.evidence.connection('ready');
        this.evidence.coverage(this.value.lastUpdate ? 'stale' : 'unknown');
        const phase =
          typeof event.phase === 'string' && /^[a-z-]{1,32}$/.test(event.phase)
            ? event.phase
            : undefined;
        const percent =
          typeof event.pct === 'number' && event.pct >= 0 && event.pct <= 100
            ? event.pct
            : undefined;
        this.value = {
          ...this.value,
          state: 'indexing',
          phase,
          percent,
          message:
            'XERJ indexing is in progress. Index coverage is unverified until this pass succeeds.',
        };
      } else if (event.event === 'done') {
        if (event.ok !== true) {
          if (this.diskBudgetRefused) return;
          const detail = event.error ?? event.message;
          if (detail || !this.currentFailure) this.reportFailure(detail ?? event.reason);
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
        this.diskBudgetRefused = false;
        this.currentFailure = undefined;
        const records = count(event.records);
        this.evidence.coverage(
          records === undefined ? 'unknown' : records === 0 ? 'unavailable' : 'ready',
          {
            files: count(event.files),
            records,
          },
        );
      } else if (event.event === 'warning' || event.event === 'error') {
        const diagnostic = xerjIndexDiagnostic(event.error ?? event.message ?? event.reason);
        if (
          (this.currentFailure?.summary && this.genericFailure(diagnostic)) ||
          (this.diskBudgetRefused &&
            ['watch-pass-failed', 'unknown-warning'].includes(diagnostic.code))
        )
          return;
        this.rememberDiagnostic(diagnostic);
        if (diagnostic.code === 'watch-rescan') {
          this.currentFailure = undefined;
          // Native XERJ already schedules a full pass after dropped watch events.
          // This invalidates coverage, but is not a failed pass or lost connection.
          this.evidence.coverage(this.value.lastUpdate ? 'stale' : 'unknown');
          this.value = {
            ...this.value,
            state: 'indexing',
            phase: undefined,
            percent: undefined,
            message: 'XERJ is rescanning the workspace after filesystem events were dropped.',
          };
          return;
        }
        if (diagnostic.code === 'rebuild-required') {
          this.fail(
            `XERJ indexing failed: ${diagnostic.summary ?? 'Saved index configuration changed'}. A new index generation is required; source changes alone cannot repair it.`,
          );
          return;
        }
        if (diagnostic.code === 'ambiguous-assignment') {
          this.fail(
            `XERJ indexing failed: ${diagnostic.summary ?? 'Ambiguous dataset assignment'}. The index is stale; see the XERJ recovery guide.`,
          );
          return;
        }
        const cause = {
          timeout: 'An indexing operation timed out.',
          authentication: 'The indexing backend rejected authentication or access.',
          connection: 'The indexing backend connection failed.',
          capacity: 'Indexing ran out of memory or disk space.',
          'watch-pass-failed': 'The underlying cause could not be classified.',
          'unknown-warning': 'The warning could not be classified.',
        }[diagnostic.code];
        this.fail(
          `XERJ indexing failed: ${diagnostic.summary ?? cause.replace(/\.$/, '')}. The watcher is still running; index freshness is unverified.`,
        );
      }
    } catch {
      // Ignore ordinary stdout and partial payloads. Only explicit error lines
      // are eligible for redaction and display.
      if (/^\s*(?:error|fatal|caused by):/i.test(line)) this.reportFailure(line);
    }
  }

  private async saveDiagnostics(): Promise<void> {
    try {
      // Coalesce bursts to the latest warning instead of queuing unbounded writes.
      while (this.pendingDiagnostic && this.diagnosticDirectory) {
        const diagnostic = this.pendingDiagnostic;
        this.pendingDiagnostic = undefined;
        try {
          await saveXerjIndexDiagnostic(this.diagnosticDirectory, diagnostic);
        } catch {
          this.report('XERJ could not save its redacted indexing diagnostic.');
        }
      }
    } finally {
      this.diagnosticSaved = undefined;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.task;
    await this.configurationSaved;
    await this.diagnosticSaved;
    const child = this.child;
    if (child && (await stopOwnedProcessGroup(child))) await this.scratch?.release();
    this.value = { ...this.value, state: this.value.mode === 'off' ? 'disabled' : 'stopped' };
    this.evidence.connection('unavailable');
  }
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
