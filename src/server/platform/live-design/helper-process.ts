/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { ManagedProjectSandboxState } from './caddy-admin-boundary.js';
import { observeLoopbackListener } from './registered-dev-servers.js';
import { loopbackPort } from './preview-targets.js';

export const LIVE_HELPER_BINARY_SHA256 =
  '81fe24a7430571de1003f34fecf787bdc0acefa1be80525ccea9d4b74b5441a0';

const identitySchema = z.object({
  pid: z.number().int().positive(),
  startTicks: z.string().regex(/^\d+$/),
  bootId: z.string(),
  executableDigest: z.string(),
});
const recordSchema = z.object({
  version: z.literal(1),
  appRoot: z.string(),
  binary: z.string(),
  port: z.number().int().positive(),
  publicBaseUrl: z.string(),
  policyDigest: z.string(),
  generation: z.number().int().positive(),
  phase: z.enum(['starting', 'ready', 'recoveryRequired', 'stopped']),
  launcher: identitySchema.optional(),
  helper: identitySchema.optional(),
  pendingCommand: z
    .object({
      name: z.enum(['live-inject', 'live-status', 'live-resume', 'live-complete']),
      ambiguous: z.boolean(),
    })
    .optional(),
});
type Record = z.infer<typeof recordSchema>;
type Identity = z.infer<typeof identitySchema>;

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
function identity(pid: number): Identity {
  const root = `/proc/${pid}`;
  const stat = readFileSync(`${root}/stat`, 'utf8');
  const startTicks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]!;
  const result = {
    pid,
    startTicks,
    bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    executableDigest: digest(readFileSync(`${root}/exe`)),
  };
  const after = readFileSync(`${root}/stat`, 'utf8');
  if (after.slice(after.lastIndexOf(')') + 2).split(' ')[19] !== startTicks)
    throw new Error('LIVE_HELPER_IDENTITY_CHANGED');
  return identitySchema.parse(result);
}
function sameProcess(expected: Identity, matchExecutable = true): boolean {
  try {
    const current = identity(expected.pid);
    return (
      current.pid === expected.pid &&
      current.startTicks === expected.startTicks &&
      current.bootId === expected.bootId &&
      (!matchExecutable || current.executableDigest === expected.executableDigest)
    );
  } catch {
    return false;
  }
}
function descendant(pid: number, parent: number): boolean {
  for (let count = 0; count < 64 && pid > 1; count++) {
    if (pid === parent) return true;
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    pid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
  }
  return false;
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Narrow launch port. The elected controller must provide the exact admitted effective policy. */
export interface HelperLauncher {
  launch(
    binary: string,
    args: readonly string[],
    environment: NodeJS.ProcessEnv,
    policy: ManagedProjectSandboxState,
  ): ChildProcess;
}

/** Uses native sandbox execution only, never app-server/chat or an authenticated copy agent. */
export class ManagedHelperLauncher implements HelperLauncher {
  constructor(
    private readonly options: {
      codexExecutable: string;
      appRoot: string;
      effectivePolicy: ManagedProjectSandboxState;
    },
  ) {
    this.options = { ...options, effectivePolicy: structuredClone(options.effectivePolicy) };
  }
  launch(
    binary: string,
    args: readonly string[],
    environment: NodeJS.ProcessEnv,
    admittedPolicy: ManagedProjectSandboxState,
  ): ChildProcess {
    const { effectivePolicy: policy, appRoot, codexExecutable } = this.options;
    if (
      policy.permissionProfile.type !== 'managed' ||
      policy.permissionProfile.file_system.type !== 'restricted' ||
      policy.useLegacyLandlock !== false ||
      JSON.stringify(policy) !== JSON.stringify(admittedPolicy) ||
      realpathSync(fileURLToPath(policy.sandboxCwd)) !== realpathSync(appRoot)
    )
      throw new Error('LIVE_HELPER_PERMISSION_UNAVAILABLE');
    return spawn(
      codexExecutable,
      ['sandbox', '--sandbox-state-json', JSON.stringify(policy), '--', binary, ...args],
      { cwd: appRoot, env: environment, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  }
}

/** Adapter construction grants no public Start readiness or external dev-server kill authority. */
export class OwnedLiveHelper {
  private readonly appRoot: string;
  private readonly binary: string;
  private readonly metadata: string;
  private readonly serverMetadata: string;
  private readonly policyDigest: string;
  private readonly environment: NodeJS.ProcessEnv;
  private busy = false;
  private commandPending = false;
  private readonly diagnostics: { command: string; outcome: string; bytes: number }[] = [];

  constructor(
    private readonly options: {
      appRoot: string;
      binary: string;
      /** Controller-private directory, already protected from every project/agent process. */
      stateDirectory: string;
      port: number;
      publicBaseUrl: string;
      generation: number;
      effectivePolicy: ManagedProjectSandboxState;
      launcher: HelperLauncher;
      /** Existing admitted runtime environment; no project-controlled overrides. */
      environment: NodeJS.ProcessEnv;
      configPath?: string;
      startupTimeoutMs?: number;
    },
  ) {
    this.options = { ...options, effectivePolicy: structuredClone(options.effectivePolicy) };
    this.appRoot = realpathSync(options.appRoot);
    this.binary = realpathSync(options.binary);
    loopbackPort(options.port);
    const url = new URL(options.publicBaseUrl);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/__gestalt_live/' ||
      !Number.isSafeInteger(options.generation) ||
      options.generation < 1 ||
      realpathSync(fileURLToPath(options.effectivePolicy.sandboxCwd)) !== this.appRoot
    )
      throw new Error('LIVE_HELPER_CONFIG_INVALID');
    this.policyDigest = digest(JSON.stringify(options.effectivePolicy));
    mkdirSync(options.stateDirectory, { recursive: true, mode: 0o700 });
    this.metadata = join(options.stateDirectory, 'helper.json');
    this.serverMetadata = join(this.appRoot, '.impeccable/live/server.json');
    this.environment = {
      ...options.environment,
      IMPECCABLE_LIVE_PUBLIC_BASE_URL: options.publicBaseUrl.replace(/\/$/, ''),
      IMPECCABLE_LIVE_COPY_AGENT: 'chat',
      IMPECCABLE_LIVE_DEBUG_EVENTS: '0',
      IMPECCABLE_SELF: this.binary,
      ...(options.configPath ? { IMPECCABLE_LIVE_CONFIG: options.configPath } : {}),
    };
  }

  /** No helper stdout/stderr, tokens, project content or environment values enter logs. */
  logs(): readonly { command: string; outcome: string; bytes: number }[] {
    return this.diagnostics.map((entry) => ({ ...entry }));
  }
  private log(command: string, outcome: string, bytes: number): void {
    this.diagnostics.push({ command, outcome, bytes });
    if (this.diagnostics.length > 32) this.diagnostics.shift();
  }
  private verifyBinary(): void {
    if (digest(readFileSync(this.binary)) !== LIVE_HELPER_BINARY_SHA256)
      throw new Error('LIVE_HELPER_BINARY_UNVERIFIED');
  }
  private read(): Record | undefined {
    if (!existsSync(this.metadata)) return undefined;
    try {
      const record = recordSchema.parse(JSON.parse(readFileSync(this.metadata, 'utf8')));
      if (
        record.appRoot !== this.appRoot ||
        record.binary !== this.binary ||
        record.port !== this.options.port ||
        record.publicBaseUrl !== this.options.publicBaseUrl ||
        record.policyDigest !== this.policyDigest ||
        record.generation !== this.options.generation
      )
        throw new Error();
      return record;
    } catch {
      throw new Error('LIVE_HELPER_RECOVERY_REQUIRED');
    }
  }
  private save(record: Record): void {
    const temporary = `${this.metadata}.next`;
    writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
    renameSync(temporary, this.metadata);
  }
  private server(): { pid: number; port: number; token: string; publicBaseUrl: string } {
    return z
      .object({
        pid: z.number().int().positive(),
        port: z.number().int().positive(),
        token: z.string().min(16),
        publicBaseUrl: z.string(),
      })
      .parse(JSON.parse(readFileSync(this.serverMetadata, 'utf8')));
  }
  private verifyOwned(record: Record): ReturnType<OwnedLiveHelper['server']> {
    this.verifyBinary();
    if (!record.helper || !sameProcess(record.helper))
      throw new Error('LIVE_HELPER_RECOVERY_REQUIRED');
    const server = this.server();
    if (
      server.pid !== record.helper.pid ||
      server.port !== record.port ||
      server.publicBaseUrl !== record.publicBaseUrl.replace(/\/$/, '') ||
      record.helper.executableDigest !== LIVE_HELPER_BINARY_SHA256 ||
      realpathSync(`/proc/${server.pid}/cwd`) !== this.appRoot ||
      observeLoopbackListener(server.pid, server.port).startTicks !== record.helper.startTicks
    )
      throw new Error('LIVE_HELPER_RECOVERY_REQUIRED');
    return server;
  }
  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('LIVE_HELPER_BUSY');
    this.busy = true;
    try {
      return await action();
    } finally {
      this.busy = false;
    }
  }
  private async vacant(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const probe = createServer();
      probe.once('error', () => reject(new Error('LIVE_HELPER_PORT_OCCUPIED')));
      probe.listen(this.options.port, '127.0.0.1', () => probe.close(() => resolve()));
    });
  }
  private async command(args: string[]): Promise<unknown> {
    if (this.commandPending) throw new Error('LIVE_HELPER_RECOVERY_REQUIRED');
    this.verifyBinary();
    const record = this.read();
    if (record?.pendingCommand) throw new Error('LIVE_HELPER_RECOVERY_REQUIRED');
    if (record) {
      record.pendingCommand = {
        name: recordSchema.shape.pendingCommand.unwrap().shape.name.parse(args[0]),
        ambiguous: false,
      };
      this.save(record);
    }
    const child = this.options.launcher.launch(
      this.binary,
      args,
      this.environment,
      this.options.effectivePolicy,
    );
    this.commandPending = true;
    return await new Promise((resolve, reject) => {
      let output = '';
      let bytes = 0;
      let failed = false;
      const ambiguous = () => {
        if (record) {
          record.phase = 'recoveryRequired';
          record.pendingCommand!.ambiguous = true;
          this.save(record);
        }
      };
      const settled = () => {
        if (record && !record.pendingCommand?.ambiguous) {
          record.pendingCommand = undefined;
          this.save(record);
        }
      };
      // Only bounded structured stdout is kept in memory; stderr is counted and dropped.
      child.stdout!.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes <= 1024 * 1024) output += chunk.toString();
        else {
          failed = true;
          ambiguous();
        }
      });
      child.stderr!.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
      });
      const timer = setTimeout(() => {
        failed = true;
        ambiguous();
        reject(new Error('LIVE_HELPER_COMMAND_TIMEOUT'));
      }, 20000);
      child.once('error', () => {
        this.commandPending = false;
        clearTimeout(timer);
        if (record) {
          record.pendingCommand = undefined;
          this.save(record);
        }
        reject(new Error('LIVE_HELPER_LAUNCH_FAILED'));
      });
      child.once('exit', (code) => {
        this.commandPending = false;
        clearTimeout(timer);
        this.log(args[0]!, code === 0 && !failed ? 'ok' : 'failed', bytes);
        if (code !== 0 || failed) {
          settled();
          reject(new Error('LIVE_HELPER_COMMAND_FAILED'));
          return;
        }
        try {
          const value: unknown = JSON.parse(output);
          settled();
          resolve(value);
        } catch {
          ambiguous();
          reject(new Error('LIVE_HELPER_PROTOCOL_INVALID'));
        }
      });
    });
  }
  private async verifiedStatus(record: Record): Promise<unknown> {
    this.verifyOwned(record);
    const status = await this.command(['live-status']);
    if (
      !status ||
      typeof status !== 'object' ||
      !('liveServer' in status) ||
      !status.liveServer ||
      typeof status.liveServer !== 'object' ||
      !('port' in status.liveServer) ||
      status.liveServer.port !== record.port
    )
      throw new Error('LIVE_HELPER_NOT_READY');
    this.verifyOwned(record);
    return status;
  }
  async start(): Promise<void> {
    return this.exclusive(async () => {
      this.verifyBinary();
      const prior = this.read();
      if (prior?.phase === 'ready') {
        await this.verifiedStatus(prior);
        return;
      }
      if (prior && prior.phase !== 'stopped') throw new Error('LIVE_HELPER_RECOVERY_REQUIRED');
      // Never let upstream's PID-only existing-server check claim or stop another process.
      if (
        existsSync(this.serverMetadata) ||
        existsSync(join(this.appRoot, '.impeccable-live.json'))
      )
        throw new Error('LIVE_HELPER_RECOVERY_REQUIRED');
      await this.vacant();
      const record: Record = {
        version: 1,
        appRoot: this.appRoot,
        binary: this.binary,
        port: this.options.port,
        publicBaseUrl: this.options.publicBaseUrl,
        policyDigest: this.policyDigest,
        generation: this.options.generation,
        phase: 'starting',
      };
      this.save(record);
      let child: ChildProcess | undefined;
      try {
        child = this.options.launcher.launch(
          this.binary,
          ['live-server', `--port=${record.port}`],
          this.environment,
          this.options.effectivePolicy,
        );
        let bytes = 0;
        let exited = false;
        child.stdout!.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
        });
        child.stderr!.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
        });
        child.once('error', () => {
          exited = true;
        });
        child.once('exit', () => {
          exited = true;
          this.log('live-server', 'exited', bytes);
        });
        if (!child.pid) throw new Error('LIVE_HELPER_LAUNCH_FAILED');
        record.launcher = identity(child.pid);
        this.save(record);
        const deadline = Date.now() + (this.options.startupTimeoutMs ?? 15000);
        let probeFailure = 'notObserved';
        while (Date.now() < deadline && !exited) {
          try {
            const info = this.server();
            if (!sameProcess(record.launcher, false))
              throw new Error('LIVE_HELPER_LAUNCHER_CHANGED');
            if (!descendant(info.pid, child.pid!)) throw new Error('LIVE_HELPER_NOT_DESCENDANT');
            record.helper = identity(info.pid);
            this.verifyOwned(record);
            const health = await fetch(`http://127.0.0.1:${record.port}/health`, {
              signal: AbortSignal.timeout(500),
            });
            if (!health.ok || ((await health.json()) as { status?: string }).status !== 'ok')
              throw new Error();
            break;
          } catch (error) {
            const failure = error as NodeJS.ErrnoException;
            probeFailure =
              failure.code && ['EACCES', 'EPERM', 'ENOENT'].includes(failure.code)
                ? failure.code
                : /^LIVE_(HELPER|TARGET)_[A-Z_]+$/.test(failure.message)
                  ? failure.message
                  : 'protocolMismatch';
            record.helper = undefined;
            await sleep(25);
          }
        }
        if (!record.helper || exited) {
          this.log('readiness', probeFailure, 0);
          throw new Error('LIVE_HELPER_NOT_READY');
        }
        // Durable identity precedes any injection; crash recovery can still stop only this helper.
        this.save(record);
        const injected = await this.command(['live-inject', '--port', String(record.port)]);
        if (
          !injected ||
          typeof injected !== 'object' ||
          !('ok' in injected) ||
          injected.ok !== true
        )
          throw new Error('LIVE_HELPER_INJECTION_FAILED');
        this.verifyOwned(record);
        await this.verifiedStatus(record);
        record.phase = 'ready';
        this.save(record);
        this.log('start', 'ready', 0);
      } catch {
        record.phase = 'recoveryRequired';
        record.pendingCommand = this.read()?.pendingCommand;
        this.save(record);
        // Upstream journal rollback only after identity proves this attempt owns the helper.
        if (record.helper) {
          try {
            await this.stopOwned(record);
          } catch {
            /* Keep recovery record and journal. */
          }
        }
        throw new Error('LIVE_HELPER_START_FAILED');
      }
    });
  }
  private async stopOwned(record: Record): Promise<void> {
    if (this.commandPending) throw new Error('LIVE_HELPER_RECOVERY_REQUIRED');
    const server = this.verifyOwned(record);
    const response = await fetch(
      `http://127.0.0.1:${server.port}/stop?token=${encodeURIComponent(server.token)}`,
      {
        signal: AbortSignal.timeout(2000),
      },
    );
    if (!response.ok) throw new Error('LIVE_HELPER_RECOVERY_REQUIRED');
    const deadline = Date.now() + 5000;
    while (sameProcess(record.helper!) && Date.now() < deadline) await sleep(25);
    if (sameProcess(record.helper!)) throw new Error('LIVE_HELPER_RECOVERY_REQUIRED');
    // Explicit remove reports failure; upstream `live-server stop` masks injection-removal errors.
    const removed = await this.command(['live-inject', '--remove']);
    if (!removed || typeof removed !== 'object' || !('ok' in removed) || removed.ok !== true)
      throw new Error('LIVE_HELPER_RECOVERY_REQUIRED');
    record.phase = 'stopped';
    this.save(record);
  }
  async stop(): Promise<void> {
    return this.exclusive(async () => {
      const record = this.read();
      if (!record || record.phase === 'stopped') return;
      try {
        await this.stopOwned(record);
      } catch {
        record.phase = 'recoveryRequired';
        record.pendingCommand = this.read()?.pendingCommand;
        this.save(record);
        throw new Error('LIVE_HELPER_RECOVERY_REQUIRED');
      }
    });
  }
  /** Explicit controller reconciliation after helper death, never a PID-based termination. */
  async recoverStopped(): Promise<void> {
    return this.exclusive(async () => {
      const record = this.read();
      if (!record || record.phase === 'stopped') return;
      if (this.commandPending || !record.helper || sameProcess(record.helper))
        throw new Error('LIVE_HELPER_RECOVERY_REQUIRED');
      await this.vacant();
      if (existsSync(this.serverMetadata)) {
        const server = this.server();
        if (
          server.pid !== record.helper.pid ||
          server.port !== record.port ||
          server.publicBaseUrl !== record.publicBaseUrl.replace(/\/$/, '')
        )
          throw new Error('LIVE_HELPER_RECOVERY_REQUIRED');
        // Preserve stale upstream evidence privately, including its token; never overwrite a new helper.
        renameSync(
          this.serverMetadata,
          join(this.options.stateDirectory, `server-${record.generation}.json`),
        );
      }
      const removed = await this.command(['live-inject', '--remove']);
      if (!removed || typeof removed !== 'object' || !('ok' in removed) || removed.ok !== true)
        throw new Error('LIVE_HELPER_RECOVERY_REQUIRED');
      await this.command(['live-status']);
      record.phase = 'stopped';
      this.save(record);
    });
  }
  async status(): Promise<unknown> {
    const record = this.read();
    if (record?.phase === 'ready') return this.verifiedStatus(record);
    else if (existsSync(this.serverMetadata)) throw new Error('LIVE_HELPER_RECOVERY_REQUIRED');
    return this.command(['live-status']);
  }
  async resume(id?: string): Promise<unknown> {
    const record = this.read();
    if (!record) throw new Error('LIVE_HELPER_RECOVERY_REQUIRED');
    this.verifyOwned(record);
    if (id && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id))
      throw new Error('LIVE_HELPER_SESSION_INVALID');
    return this.command(['live-resume', ...(id ? ['--id', id] : [])]);
  }
  async complete(id: string, discarded = false): Promise<unknown> {
    const record = this.read();
    if (!record) throw new Error('LIVE_HELPER_RECOVERY_REQUIRED');
    this.verifyOwned(record);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id))
      throw new Error('LIVE_HELPER_SESSION_INVALID');
    return this.command(['live-complete', '--id', id, ...(discarded ? ['--discarded'] : [])]);
  }
}
