/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import type {
  LiveEventReply,
  CanonicalLivePoll,
} from '../../features/live-design/application/poll-events.js';
import type {
  LiveOwnershipStore,
  LiveRun,
} from '../../features/live-design/application/ownership.js';
import type { IsolatedProjectProcess, IsolatedProjectReceipt } from './isolated-project-process.js';
import { readLiveConfigFile, type LiveConfigFile } from './effective-config.js';
import { helperCheckpointDigest } from './helper-checkpoint.js';

const id = (value: string) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
type CommandRecord = {
  version: 1;
  liveId: string;
  generation: number;
  controllerEpoch: number;
  receiptSignature: string;
  pending: null | { name: string; digest: string; ambiguous: boolean; checkpointDigest?: string };
  cancelled?: {
    name: string;
    digest: string;
    ambiguous: true;
    foregroundClosed: true;
    checkpointDigest?: string;
  };
};

/** Canonical foreground helper CLI inside its verified owned namespace. Browser
 * and model callers receive neither this port nor raw helper management access.
 */
export class IsolatedLiveHelper implements CanonicalLivePoll {
  private readonly receipt: IsolatedProjectReceipt;
  private readonly run: LiveRun;
  private readonly metadata: string;
  private inFlight = false;
  private finished?: Promise<void>;
  private serverRecord?: LiveConfigFile;
  constructor(
    private readonly input: {
      owners: LiveOwnershipStore;
      run: LiveRun;
      process: IsolatedProjectProcess;
      receipt: IsolatedProjectReceipt;
      privateDirectory: string;
      port: number;
      publicBaseUrl: string;
    },
  ) {
    this.input = {
      ...input,
      run: structuredClone(input.run),
      receipt: structuredClone(input.receipt),
    };
    this.receipt = structuredClone(input.receipt);
    this.run = structuredClone(input.run);
    const root = realpathSync(input.privateDirectory),
      stat = lstatSync(root);
    const tail = relative(this.run.app.canonicalAppRoot, root);
    if (
      !id(this.run.liveId) ||
      root !== input.privateDirectory ||
      !stat.isDirectory() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o700 ||
      (!isAbsolute(tail) && tail !== '..' && !tail.startsWith(`..${sep}`)) ||
      this.receipt.role !== 'helper' ||
      this.receipt.sessionId !== this.run.relayId ||
      this.receipt.generation !== this.run.generation ||
      this.receipt.target.cwd !== this.run.app.canonicalAppRoot
    )
      throw new Error('LIVE_HELPER_RECOVERY_REQUIRED');
    this.metadata = join(root, `helper-${this.run.liveId}-${this.run.generation}.json`);
    this.assertGeneration();
    this.input.process.verify(this.receipt);
    if (!existsSync(this.metadata))
      this.save({
        version: 1,
        liveId: this.run.liveId,
        generation: this.run.generation,
        controllerEpoch: this.run.controllerEpoch,
        receiptSignature: this.receipt.signature,
        pending: null,
      });
    this.record();
  }
  private assertGeneration(): LiveRun {
    const current = this.input.owners.current(this.run.liveId);
    if (
      !current ||
      current.controllerEpoch !== this.run.controllerEpoch ||
      current.generation !== this.run.generation ||
      current.relayId !== this.run.relayId ||
      current.rootThreadId !== this.run.rootThreadId ||
      !['starting', 'active', 'stopping'].includes(current.state)
    )
      throw new Error('LIVE_HELPER_GENERATION_STALE');
    this.input.owners.assert(current);
    return current;
  }
  /** Newer recovery ownership may only drain/reconcile this exact old helper.
   * This fence never authorizes poll, reply, completion or model dispatch. */
  private assertCleanup(run: LiveRun): void {
    const current = this.input.owners.assert(run);
    if (
      current.liveId !== this.run.liveId ||
      current.controllerEpoch !== this.run.controllerEpoch ||
      current.generation < this.run.generation ||
      current.relayId !== this.run.relayId ||
      current.rootThreadId !== this.run.rootThreadId ||
      current.app.device !== this.run.app.device ||
      current.app.inode !== this.run.app.inode ||
      current.authSessionHash !== this.run.authSessionHash ||
      current.deviceId !== this.run.deviceId ||
      !['stopping', 'recoveryRequired'].includes(current.state)
    )
      throw new Error('LIVE_HELPER_GENERATION_STALE');
  }
  private record(cleanup = false, pending = false): CommandRecord {
    const stat = lstatSync(this.metadata);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > 4096
    )
      throw new Error('LIVE_HELPER_RECOVERY_REQUIRED');
    const record = JSON.parse(readFileSync(this.metadata, 'utf8')) as CommandRecord;
    if (
      record.version !== 1 ||
      record.liveId !== this.run.liveId ||
      record.generation !== this.run.generation ||
      record.controllerEpoch !== this.run.controllerEpoch ||
      record.receiptSignature !== this.receipt.signature ||
      (!pending && record.pending !== null) ||
      (!cleanup && record.cancelled !== undefined)
    )
      throw new Error('LIVE_HELPER_RECOVERY_REQUIRED');
    return record;
  }
  private save(record: CommandRecord) {
    const next = this.metadata + '.next';
    writeFileSync(next, JSON.stringify(record) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(next, this.metadata);
  }
  private async command(args: readonly string[], deadlineMs = 20000): Promise<unknown> {
    const run = this.assertGeneration();
    if (this.inFlight || (args[0] === 'live-poll' && run.state !== 'active'))
      throw new Error('LIVE_HELPER_COMMAND_UNAVAILABLE');
    const removal = args[0] === 'live-inject' && args[1] === '--remove' && run.state === 'stopping';
    const record = this.record(removal);
    record.pending = {
      name: args[0]!,
      digest: createHash('sha256').update(JSON.stringify(args)).digest('hex'),
      ambiguous: false,
      ...(args[0] === 'live-poll' && !args.includes('--reply')
        ? { checkpointDigest: helperCheckpointDigest(this.run.app.canonicalAppRoot) }
        : {}),
    };
    this.save(record); // Durable intent precedes any helper/source/journal IO.
    this.inFlight = true;
    let finish!: () => void;
    this.finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    try {
      const result = await this.input.process.helperCommand(this.receipt, args, deadlineMs);
      this.assertGeneration();
      record.pending = null;
      this.save(record);
      return result;
    } catch (error) {
      if (record.pending) record.pending.ambiguous = true;
      this.save(record); // Never replay a command whose effects/response are unknown.
      throw Object.assign(new Error('LIVE_HELPER_COMMAND_AMBIGUOUS'), {
        stage:
          error instanceof Error &&
          'stage' in error &&
          typeof error.stage === 'string' &&
          /^[a-z][a-z0-9-]{0,63}$/.test(error.stage)
            ? error.stage
            : 'helper-command-unverified',
      });
    } finally {
      this.inFlight = false;
      finish();
    }
  }
  async settle(fence?: LiveRun): Promise<void> {
    const run = fence ?? this.assertGeneration();
    this.assertCleanup(run);
    if (this.inFlight) {
      const finished = this.finished;
      await this.input.process.cancelHelperCommand(this.receipt);
      await finished;
    }
    this.assertCleanup(run);
    const record = this.record(true, true);
    if (record.pending) {
      // Closing a poll does not prove that an upstream lease/source effect did
      // not occur. Retain its ambiguity and permit only injection removal.
      if (record.pending.name !== 'live-poll') throw new Error('LIVE_HELPER_RECOVERY_REQUIRED');
      record.cancelled = { ...record.pending, ambiguous: true, foregroundClosed: true };
      record.pending = null;
      this.save(record);
    }
  }
  async reconcile(run: LiveRun, acknowledgedSteers: readonly string[] = []): Promise<string> {
    await this.settle(run);
    this.assertCleanup(run);
    const record = this.record(true);
    if (
      record.cancelled &&
      (!record.cancelled.checkpointDigest ||
        record.cancelled.checkpointDigest !== helperCheckpointDigest(this.run.app.canonicalAppRoot))
    )
      throw new Error('LIVE_HELPER_RECOVERY_REQUIRED');
    const invoke = async (args: readonly string[]) => {
      this.assertCleanup(run);
      const result = await this.input.process.helperCommand(this.receipt, args, 20000);
      this.assertCleanup(run);
      return result;
    };
    let status = (await this.input.process.helperCommand(this.receipt, ['live-status'], 20000)) as {
      activeSessions?: { id?: unknown; phase?: unknown }[];
      liveServer?: { pendingEvents?: unknown[] };
    };
    this.assertCleanup(run);
    let resume = (await this.input.process.helperCommand(this.receipt, ['live-resume'], 20000)) as {
      active?: boolean;
    };
    this.assertCleanup(run);
    // Canonical steer_done acknowledges source work but deliberately leaves its
    // durable session active. Only the controller's already-acknowledged steer
    // IDs can close that metadata, after actual pending/source checks. No model,
    // poll, accept, discard, force or replay is authorized here.
    if (Array.isArray(status?.activeSessions) && status.activeSessions.length) {
      const active = status.activeSessions;
      const ids = new Set<string>();
      if (
        active.length > 64 ||
        active.some((item) => {
          if (
            !item ||
            typeof item.id !== 'string' ||
            !/^[a-f0-9]{8}$/.test(item.id) ||
            item.phase !== 'steer_done' ||
            !acknowledgedSteers.includes(item.id) ||
            ids.has(item.id)
          )
            return true;
          ids.add(item.id);
          return false;
        }) ||
        !Array.isArray(status.liveServer?.pendingEvents) ||
        status.liveServer.pendingEvents.length
      )
        throw Object.assign(new Error('LIVE_HELPER_RECOVERY_REQUIRED'), {
          stage: 'helper-active-journal-unverified',
        });
      for (const sessionId of ids) {
        const observed = (await invoke(['live-resume', '--id', sessionId])) as {
          active?: boolean;
          pendingEvent?: unknown;
          snapshot?: {
            id?: unknown;
            phase?: unknown;
            pendingEvent?: unknown;
            sourceFile?: unknown;
          };
        };
        const snapshot = observed?.snapshot;
        if (
          observed?.active !== true ||
          observed.pendingEvent !== null ||
          snapshot?.id !== sessionId ||
          snapshot.phase !== 'steer_done' ||
          snapshot.pendingEvent !== null ||
          typeof snapshot.sourceFile !== 'string' ||
          !snapshot.sourceFile ||
          snapshot.sourceFile.length > 4096
        )
          throw new Error('LIVE_HELPER_RECOVERY_REQUIRED');
        const path = isAbsolute(snapshot.sourceFile)
          ? snapshot.sourceFile
          : join(this.run.app.canonicalAppRoot, snapshot.sourceFile);
        const tail = relative(this.run.app.canonicalAppRoot, path);
        const sourceDigest = () => {
          if (!tail || tail === '..' || tail.startsWith(`..${sep}`) || isAbsolute(tail))
            throw new Error('LIVE_HELPER_RECOVERY_REQUIRED');
          const stat = lstatSync(path);
          if (
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            stat.nlink !== 1 ||
            stat.size > 8 * 1024 * 1024 ||
            realpathSync(path) !== path
          )
            throw new Error('LIVE_HELPER_RECOVERY_REQUIRED');
          return createHash('sha256').update(readFileSync(path)).digest('hex');
        };
        const before = sourceDigest();
        const args = ['live-complete', '--id', sessionId];
        record.pending = {
          name: 'live-complete',
          digest: createHash('sha256').update(JSON.stringify(args)).digest('hex'),
          ambiguous: true,
        };
        delete record.cancelled; // Its unchanged checkpoint was proved above.
        this.save(record); // Lost completion remains locked, never blindly replayed.
        const completed = (await invoke(args)) as { ok?: boolean };
        const confirmed = (await invoke(['live-resume', '--id', sessionId])) as {
          active?: boolean;
        };
        if (completed?.ok !== true || confirmed?.active !== false || sourceDigest() !== before)
          throw new Error('LIVE_HELPER_RECOVERY_REQUIRED');
        record.pending = null;
        this.save(record);
      }
      status = (await invoke(['live-status'])) as typeof status;
      resume = (await invoke(['live-resume'])) as typeof resume;
    }
    // A pending accept/apply or unknown response requires explicit reconciliation.
    // Never replay or discard source work just to make Resume succeed.
    if (
      !Array.isArray(status?.activeSessions) ||
      status.activeSessions.length ||
      !Array.isArray(status.liveServer?.pendingEvents) ||
      status.liveServer.pendingEvents.length ||
      resume?.active !== false
    )
      throw new Error('LIVE_HELPER_RECOVERY_REQUIRED');
    return createHash('sha256').update(JSON.stringify({ status, resume })).digest('hex');
  }
  async removeInjection(run: LiveRun): Promise<void> {
    await this.settle(run);
    this.assertCleanup(run);
    const record = this.record(true);
    record.pending = {
      name: 'live-inject',
      digest: createHash('sha256').update('["live-inject","--remove"]').digest('hex'),
      ambiguous: false,
    };
    this.save(record);
    try {
      const result = (await this.input.process.helperCommand(
        this.receipt,
        ['live-inject', '--remove'],
        20000,
      )) as { ok?: boolean };
      this.assertCleanup(run);
      if (result?.ok !== true) throw new Error('LIVE_HELPER_RECOVERY_REQUIRED');
      record.pending = null;
      this.save(record);
    } catch {
      if (record.pending) record.pending.ambiguous = true;
      this.save(record);
      throw new Error('LIVE_HELPER_RECOVERY_REQUIRED');
    }
  }
  async inject(remove = false): Promise<unknown> {
    return this.command([
      'live-inject',
      ...(remove ? ['--remove'] : ['--port', String(this.input.port)]),
    ]);
  }
  async status(): Promise<unknown> {
    const value = await this.command(['live-status']);
    const server = (value as { liveServer?: { port?: unknown } })?.liveServer;
    if (!server || server.port !== this.input.port) throw new Error('LIVE_HELPER_NOT_READY');
    // Actual helper namespace PID and public endpoint, not merely a successful CLI callback.
    const path = join(this.run.app.canonicalAppRoot, '.impeccable/live/server.json');
    const stat = lstatSync(path);
    if (realpathSync(path) !== path || !stat.isFile() || stat.nlink !== 1 || stat.size > 65536)
      throw new Error('LIVE_HELPER_NOT_READY');
    const state = JSON.parse(readFileSync(path, 'utf8')) as {
      pid?: number;
      port?: number;
      publicBaseUrl?: string;
    };
    const pids = /^NSpid:\s+(.+)$/m
      .exec(readFileSync(`/proc/${this.receipt.target.pid}/status`, 'utf8'))?.[1]
      ?.trim()
      .split(/\s+/);
    if (
      !pids?.length ||
      state.pid !== Number(pids[pids.length - 1]) ||
      state.port !== this.input.port ||
      state.publicBaseUrl !== this.input.publicBaseUrl.replace(/\/$/, '')
    )
      throw new Error('LIVE_HELPER_NOT_READY');
    this.assertGeneration();
    this.serverRecord = readLiveConfigFile(path);
    return value;
  }
  /** Remove only the record verified against this exact owned server, after
   * positive namespace/descriptor closure. Never inspect/adopt an external PID.
   */
  forgetExitedServerRecord(): void {
    const proof = this.input.process.diagnostics();
    if (!proof.namespaceExited || !proof.pipeDescriptorsClosed)
      throw new Error('LIVE_HELPER_RECOVERY_REQUIRED');
    const path = join(this.run.app.canonicalAppRoot, '.impeccable/live/server.json');
    if (!existsSync(path)) return;
    if (!this.serverRecord || readLiveConfigFile(path).sha256 !== this.serverRecord.sha256)
      throw new Error('LIVE_HELPER_RECOVERY_REQUIRED');
    unlinkSync(path);
  }
  poll(): Promise<unknown> {
    return this.command(['live-poll', '--timeout=600000'], 660000);
  }
  reply(reply: LiveEventReply): Promise<unknown> {
    if (
      !id(reply.id) ||
      !['done', 'steer_done', 'error'].includes(reply.status) ||
      reply.message?.startsWith('-')
    )
      throw new Error('LIVE_HELPER_REPLY_INVALID');
    let file: string | undefined;
    if (reply.file) {
      file = relative(
        this.run.app.canonicalAppRoot,
        realpathSync(join(this.run.app.canonicalAppRoot, reply.file)),
      );
      if (
        !file ||
        isAbsolute(file) ||
        file === '..' ||
        file.startsWith(`..${sep}`) ||
        file.startsWith('-')
      )
        throw new Error('LIVE_HELPER_REPLY_INVALID');
    }
    return this.command(
      [
        'live-poll',
        '--reply',
        reply.id,
        reply.status,
        ...(file ? ['--file', file] : []),
        ...(reply.data ? ['--data', JSON.stringify(reply.data)] : []),
        ...(reply.message ? [reply.message] : []),
      ],
      330000,
    );
  }
  complete(value: string, discarded = false): Promise<unknown> {
    if (!id(value)) throw new Error('LIVE_HELPER_SESSION_INVALID');
    return this.command(['live-complete', '--id', value, ...(discarded ? ['--discarded'] : [])]);
  }
  resume(value?: string): Promise<unknown> {
    if (value && !id(value)) throw new Error('LIVE_HELPER_SESSION_INVALID');
    return this.command(['live-resume', ...(value ? ['--id', value] : [])]);
  }
}
