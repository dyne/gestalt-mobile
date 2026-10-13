/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  constants,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, sep } from 'node:path';
import { Duplex } from 'node:stream';
import { once } from 'node:events';
import type { ManagedProjectSandboxState } from './caddy-admin-boundary.js';
import { LIVE_CODEX_SHA256, LIVE_CODEX_BWRAP_SHA256 } from './native-contract.js';
import { observeLiveProcess, type LiveProcessIdentity } from './process-identity.js';
import { observeLoopbackListener } from './registered-dev-servers.js';
import { isolatedProjectSocketFilter } from './project-network-filter.js';
import { LIVE_HELPER_BINARY_SHA256 } from './helper-process.js';
import { observeNativeDeniedPath as masked } from './project-native-mask.js';
import { ProjectControllerPipes } from './project-controller-pipes.js';

type Pin = Readonly<{ path: string; sha256: string }>;
export type IsolatedProjectSpecification = Readonly<{
  role: 'helper' | 'devserver';
  sessionId: string;
  generation: number;
  appRoot: string;
  privateDirectory: string;
  native: Pin;
  bwrap: Pin;
  node: Pin;
  worker: Pin;
  executable: Pin;
  /** Complete fixed launch surfaces, supplied by trusted composition, never request parameters. */
  argv: readonly string[];
  environment: Readonly<Record<string, string>>;
  launchInputs: readonly Pin[];
  filesystem: ManagedProjectSandboxState['permissionProfile']['file_system'];
  protectedPaths: readonly string[];
  port: number;
}>;
export type IsolatedProjectReceipt = Readonly<{
  schemaVersion: 1;
  kind: 'mobile-isolated-project-process';
  role: 'helper' | 'devserver';
  sessionId: string;
  generation: number;
  specificationDigest: string;
  network: 'private-loopback-only';
  owner: LiveProcessIdentity;
  relay: LiveProcessIdentity;
  target: LiveProcessIdentity;
  signature: string;
}>;
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function failure(stage = 'unspecified'): Error {
  return Object.assign(new Error('LIVE_PROJECT_PROCESS_UNAVAILABLE'), {
    code: 'LIVE_PROJECT_PROCESS_UNAVAILABLE',
    stage,
  });
}
function fifo(path: string): { read: number; write: number } {
  const bootstrap = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    return {
      read: openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW),
      write: openSync(path, constants.O_WRONLY | constants.O_NOFOLLOW),
    };
  } finally {
    closeSync(bootstrap);
  }
}
function verifyPin(pin: Pin, label: string): void {
  try {
    const info = lstatSync(pin.path);
    if (!info.isFile() || info.isSymbolicLink()) throw failure(`pin-${label}-file`);
    if (info.mode & 0o022) throw failure(`pin-${label}-permissions`);
    if (realpathSync(pin.path) !== pin.path) throw failure(`pin-${label}-canonical`);
    if (hash(readFileSync(pin.path)) !== pin.sha256) throw failure(`pin-${label}-digest`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'LIVE_PROJECT_PROCESS_UNAVAILABLE') throw error;
    throw failure(`pin-${label}-read`);
  }
}
function inside(parent: string, path: string): boolean {
  const suffix = relative(parent, path);
  return !suffix || (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !suffix.startsWith(sep));
}
function descendant(pid: number, owner: number): boolean {
  for (let count = 0; count < 64 && pid > 1; count++) {
    if (pid === owner) return true;
    const fields = readFileSync(`/proc/${pid}/stat`, 'utf8');
    pid = Number(fields.slice(fields.lastIndexOf(')') + 2).split(' ')[1]);
  }
  return false;
}
function status(pid: number): { capabilities: string; noNewPrivileges: string; seccomp: string } {
  const text = readFileSync(`/proc/${pid}/status`, 'utf8');
  return {
    capabilities: text.match(/^CapEff:\s+(\w+)/m)?.[1] ?? '',
    noNewPrivileges: text.match(/^NoNewPrivs:\s+(\d+)/m)?.[1] ?? '',
    seccomp: text.match(/^Seccomp:\s+(\d+)/m)?.[1] ?? '',
  };
}
function confined(pid: number): boolean {
  const s = status(pid);
  return /^0+$/.test(s.capabilities) && s.noNewPrivileges === '1' && s.seccomp === '2';
}
class ProjectPipeSocket extends Duplex {
  private idleMs = 0;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private resetIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.idleMs > 0 && !this.destroyed)
      this.idleTimer = setTimeout(() => this.emit('timeout'), this.idleMs);
  }
  constructor(
    private readonly send: (message: unknown) => void,
    readonly channel: number,
    private readonly finish: () => void,
  ) {
    super();
  }
  override _read(): void {
    this.send({ op: 'resume', id: this.channel });
  }
  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: (error?: Error | null) => void,
  ): void {
    try {
      this.resetIdle();
      for (let offset = 0; offset < chunk.length; offset += 65536)
        this.send({
          op: 'data',
          id: this.channel,
          data: chunk.subarray(offset, offset + 65536).toString('base64'),
        });
      done();
    } catch {
      done(failure());
    }
  }
  override _final(done: (error?: Error | null) => void): void {
    try {
      this.send({ op: 'end', id: this.channel });
      done();
    } catch {
      done(failure());
    }
  }
  override _destroy(error: Error | null, done: (error: Error | null) => void): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    try {
      this.send({ op: 'close', id: this.channel });
    } catch {
      /* A lost relay is already a closed stream. */
    } finally {
      this.finish();
      done(error);
    }
  }
  setTimeout(milliseconds = 0, listener?: () => void): this {
    this.idleMs = milliseconds;
    if (listener) this.once('timeout', listener);
    this.resetIdle();
    return this;
  }
  setNoDelay(): this {
    return this;
  }
  setKeepAlive(): this {
    return this;
  }
  deliver(bytes: Buffer): void {
    this.resetIdle();
    if (!this.push(bytes)) this.send({ op: 'pause', id: this.channel });
  }
}

/** Host-only ownership adapter. Construction and namespace messages never grant readiness.
 * Separate from the accepted manager/MCP receipt contract; never changes their network policy.
 */
export class IsolatedProjectProcess {
  private readonly spec: IsolatedProjectSpecification;
  private readonly key: Buffer;
  private readonly specificationDigest: string;
  private child?: ChildProcess;
  private owner?: LiveProcessIdentity;
  private network?: string;
  private receipt?: IsolatedProjectReceipt;
  private revoked = false;
  private pipes?: ProjectControllerPipes;
  private descriptors: number[] = [];
  private channels = new Map<number, ProjectPipeSocket>();
  private nextChannel = 0;
  private exited?: Promise<void>;
  private diagnostic = {
    stage: 'constructed',
    namespaceObserved: false,
    relayObserved: false,
    targetObserved: false,
    nativeMasksObserved: false,
    workerFailure: 'none',
    originalFailureStage: 'none',
    pipeFailureCode: 'none',
  };

  diagnostics(): Readonly<typeof this.diagnostic> {
    return { ...this.diagnostic };
  }

  constructor(specification: IsolatedProjectSpecification) {
    this.spec = structuredClone(specification);
    const spec = this.spec;
    if (!['helper', 'devserver'].includes(spec.role)) throw failure('role');
    if (
      spec.role === 'helper' &&
      (spec.executable.sha256 !== LIVE_HELPER_BINARY_SHA256 ||
        JSON.stringify(spec.argv) !==
          JSON.stringify(['live-server', `--port=${spec.port}`, '--target', spec.appRoot]))
    )
      throw failure('helper-fixed-launch');
    if (
      process.platform !== 'linux' ||
      process.arch !== 'x64' ||
      !spec.sessionId ||
      !Number.isSafeInteger(spec.generation) ||
      spec.generation < 1 ||
      !Number.isSafeInteger(spec.port) ||
      spec.port < 1 ||
      spec.port > 65535 ||
      spec.native.sha256 !== LIVE_CODEX_SHA256 ||
      spec.bwrap.sha256 !== LIVE_CODEX_BWRAP_SHA256 ||
      spec.argv.length > 64 ||
      spec.launchInputs.length > 64
    )
      throw failure('authority-shape');
    if (
      realpathSync(spec.appRoot) !== spec.appRoot ||
      realpathSync(spec.privateDirectory) !== spec.privateDirectory ||
      inside(spec.appRoot, spec.privateDirectory)
    )
      throw failure('canonical-root');
    for (const pin of [spec.native, spec.bwrap, spec.node, spec.worker])
      if (inside(spec.appRoot, pin.path)) throw failure('mutable-runtime-location');
    const info = lstatSync(spec.privateDirectory);
    if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700)
      throw failure('private-directory');
    for (const value of [...spec.argv, ...Object.values(spec.environment)])
      if (typeof value !== 'string' || value.includes('\0') || value.length > 8192)
        throw failure('fixed-launch-value');
    // Inherited credentials, native config and Node injection never enter project processes.
    for (const name of Object.keys(spec.environment))
      if (
        ![
          'PATH',
          'HOME',
          'TMPDIR',
          'LANG',
          'NODE_ENV',
          'IMPECCABLE_LIVE_CONFIG',
          'IMPECCABLE_LIVE_PUBLIC_BASE_URL',
        ].includes(name)
      )
        throw failure('unapproved-environment');
    if (
      spec.environment.PATH !== '/usr/bin:/bin' ||
      !spec.environment.HOME ||
      spec.environment.TMPDIR !== '/tmp'
    )
      throw failure('fixed-environment');
    if (spec.filesystem.type !== 'restricted') throw failure('filesystem-profile');
    for (const entry of spec.filesystem.entries) {
      if (entry.access !== 'write') continue;
      if (
        entry.path.type === 'path' &&
        (inside(spec.appRoot, entry.path.path) || entry.path.path === '/tmp')
      )
        continue;
      if (entry.path.type === 'special' && ['slash_tmp', 'tmpdir'].includes(entry.path.value.kind))
        continue;
      throw failure('filesystem-write-scope');
    }
    for (const path of [spec.privateDirectory, ...spec.protectedPaths, '/proc']) {
      if (
        !spec.filesystem.entries.some(
          (entry) =>
            entry.access === 'deny' && entry.path.type === 'path' && entry.path.path === path,
        )
      )
        throw failure('private-denial-missing');
      for (const entry of spec.filesystem.entries)
        if (entry.access !== 'deny' && entry.path.type === 'path' && inside(path, entry.path.path))
          throw failure('private-denial-overridden');
    }
    this.verifyInputs();
    this.specificationDigest = hash(JSON.stringify(spec));
    const keyPath = join(spec.privateDirectory, 'project-process-signing-key');
    try {
      writeFileSync(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw failure('signing-key-create');
    }
    const keyStat = lstatSync(keyPath);
    if (
      !keyStat.isFile() ||
      keyStat.isSymbolicLink() ||
      keyStat.uid !== process.getuid?.() ||
      (keyStat.mode & 0o777) !== 0o600 ||
      keyStat.size !== 32
    )
      throw failure('signing-key-metadata');
    this.key = readFileSync(keyPath);
  }

  private verifyInputs(): void {
    for (const label of ['native', 'bwrap', 'node', 'worker', 'executable'] as const)
      verifyPin(this.spec[label], label);
    for (const pin of this.spec.launchInputs) verifyPin(pin, 'launch-input');
  }
  private send(message: unknown): void {
    if (this.revoked || !this.pipes || this.pipes.input.destroyed) throw failure();
    const line = JSON.stringify(message) + '\n';
    if (line.length > 256 * 1024 || this.pipes.input.writableLength > 1024 * 1024) throw failure();
    this.pipes.input.write(line);
  }
  private revokeChannels(): void {
    this.revoked = true;
    this.receipt = undefined;
    for (const stream of this.channels.values()) {
      stream.on('error', () => {});
      stream.destroy(failure());
    }
    this.channels.clear();
  }
  async start(): Promise<IsolatedProjectReceipt> {
    if (this.child || this.revoked) throw failure();
    this.verifyInputs();
    this.diagnostic.stage = 'outer-namespace-launch';
    const spec = this.spec;
    if (
      spec.role === 'helper' &&
      [
        join(spec.appRoot, '.impeccable/live/server.json'),
        join(spec.appRoot, '.impeccable-live.json'),
      ].some((path) => existsSync(path))
    )
      throw new Error('LIVE_PROJECT_RECOVERY_REQUIRED');
    const work = join(
      spec.privateDirectory,
      `project-${spec.role}-${spec.generation}-${randomBytes(8).toString('hex')}`,
    );
    mkdirSync(work, { mode: 0o700 });
    const fifoIn = join(work, 'input');
    const fifoOut = join(work, 'output');
    execFileSync('/usr/bin/mkfifo', ['--mode=600', fifoIn, fifoOut], { env: {}, stdio: 'ignore' });
    const inputPair = fifo(fifoIn);
    const outputPair = fifo(fifoOut);
    const input = inputPair.write;
    const output = outputPair.read;
    const filterPath = join(work, 'network-filter');
    writeFileSync(filterPath, isolatedProjectSocketFilter(), { mode: 0o600 });
    const filter = openSync(filterPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    this.descriptors = [input, output];
    try {
      this.child = spawn(
        spec.bwrap.path,
        [
          '--unshare-user',
          '--unshare-pid',
          '--unshare-net',
          '--unshare-ipc',
          '--new-session',
          '--die-with-parent',
          '--ro-bind',
          '/',
          '/',
          '--bind',
          spec.appRoot,
          spec.appRoot,
          '--dev',
          '/dev',
          '--proc',
          '/proc',
          '--tmpfs',
          '/tmp',
          '--cap-drop',
          'ALL',
          '--seccomp',
          '3',
          '--chdir',
          spec.appRoot,
          '--',
          spec.node.path,
          spec.worker.path,
        ],
        {
          cwd: spec.appRoot,
          env: {
            PATH: '/usr/bin:/bin',
            HOME: spec.environment.HOME!,
            TMPDIR: '/tmp',
            LANG: 'C.UTF-8',
          },
          stdio: [inputPair.read, outputPair.write, 'ignore', filter],
        },
      );
    } finally {
      closeSync(filter);
      closeSync(inputPair.read);
      closeSync(outputPair.write);
      rmSync(work, { recursive: true, force: true });
    }
    this.exited = new Promise<void>((resolve) =>
      this.child!.once('close', () => {
        this.revokeChannels();
        resolve();
      }),
    );
    this.child.once('error', () => this.revokeChannels());
    this.pipes = new ProjectControllerPipes(input, output, (code) => {
      this.diagnostic.pipeFailureCode = code;
      this.revokeChannels();
      this.child?.kill('SIGTERM');
    });
    this.descriptors = []; // Ownership transferred; only fs streams close these descriptors.
    const lines = this.pipes.lines;
    let buffered = 0;
    this.pipes.output.on('data', (bytes: Buffer | string) => {
      buffered += bytes.length;
      if (buffered > 512 * 1024) this.revokeChannels();
    });
    lines.on('line', (line) => {
      buffered = 0;
      try {
        if (line.length > 256 * 1024) throw failure();
        const message = JSON.parse(line) as Record<string, unknown>;
        if (message.type === 'namespace') {
          if (
            this.network ||
            typeof message.network !== 'string' ||
            !/^net:\[\d+\]$/.test(message.network)
          )
            throw failure();
          this.network = message.network;
          this.diagnostic.namespaceObserved = true;
          this.diagnostic.stage = 'await-native-listener';
          return;
        }
        if (message.type === 'failed') {
          this.diagnostic.workerFailure = [
            'native-launch',
            'native-exited',
            'controller-protocol',
          ].includes(String(message.reason))
            ? String(message.reason)
            : 'invalid-worker-response';
          throw failure();
        }
        const stream = this.channels.get(Number(message.id));
        if (!stream) return;
        if (message.type === 'connected') stream.emit('connect');
        else if (message.type === 'data') {
          if (typeof message.data !== 'string' || message.data.length > 87384) throw failure();
          stream.deliver(Buffer.from(message.data, 'base64'));
        } else if (message.type === 'end') stream.push(null);
        else if (message.type === 'closed') stream.destroy();
        else if (message.type === 'channel-error') stream.destroy(failure());
        else throw failure();
      } catch {
        this.revokeChannels();
        this.child?.kill('SIGTERM');
      }
    });
    try {
      await once(this.child, 'spawn');
      this.owner = observeLiveProcess(this.child.pid!);
      if (this.owner.executableDigest !== spec.bwrap.sha256) {
        await this.stop();
        throw failure();
      }
      this.send({
        op: 'launch',
        specification: {
          native: spec.native.path,
          executable: spec.executable.path,
          argv: spec.argv,
          environment: spec.environment,
          appRoot: spec.appRoot,
          port: spec.port,
          permissionProfile: { type: 'managed', file_system: spec.filesystem, network: 'enabled' },
        },
      });
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && !this.revoked) {
        if (this.child.pid && !this.owner) this.owner = observeLiveProcess(this.child.pid);
        if (this.owner && this.network) {
          const observed = this.observeTarget();
          if (observed) {
            this.verifyInputs();
            const unsigned = {
              schemaVersion: 1 as const,
              kind: 'mobile-isolated-project-process' as const,
              role: spec.role,
              sessionId: spec.sessionId,
              generation: spec.generation,
              specificationDigest: this.specificationDigest,
              network: 'private-loopback-only' as const,
              owner: this.owner,
              relay: observed.relay,
              target: observed.target,
            };
            const receipt = {
              ...unsigned,
              signature: createHmac('sha256', this.key)
                .update(JSON.stringify(unsigned))
                .digest('hex'),
            };
            const path = join(
              spec.privateDirectory,
              `project-${spec.role}-${spec.generation}.json`,
            );
            writeFileSync(path + '.tmp', JSON.stringify(receipt) + '\n', { mode: 0o600 });
            renameSync(path + '.tmp', path);
            this.receipt = receipt;
            this.diagnostic.stage = 'receipt-signed';
            return structuredClone(receipt);
          }
        }
        await sleep(25);
      }
      throw failure();
    } catch (error) {
      const stage = (error as { stage?: string }).stage ?? 'unspecified';
      this.diagnostic.originalFailureStage = stage;
      try {
        await this.stop();
      } catch {
        throw Object.assign(new Error('LIVE_PROJECT_RECOVERY_REQUIRED'), {
          code: 'LIVE_PROJECT_RECOVERY_REQUIRED',
          stage,
        });
      }
      throw error;
    }
  }

  private observeTarget(): { relay: LiveProcessIdentity; target: LiveProcessIdentity } | undefined {
    if (!this.owner || !this.child?.pid || this.revoked) throw failure();
    if (JSON.stringify(observeLiveProcess(this.child.pid)) !== JSON.stringify(this.owner))
      throw failure();
    const host = observeLiveProcess(process.pid);
    if (!this.network || this.network === host.namespaces.net) throw failure();
    let relay: LiveProcessIdentity | undefined;
    let target: LiveProcessIdentity | undefined;
    let targets = 0;
    const pids = readdirSync('/proc').filter((name) => /^\d+$/.test(name));
    if (pids.length > 8192) throw failure();
    for (const name of pids) {
      const pid = Number(name);
      try {
        if (!descendant(pid, this.child.pid)) continue;
        const identity = observeLiveProcess(pid);
        if (identity.namespaces.net !== this.network) continue;
        const command = readFileSync(`/proc/${pid}/cmdline`);
        if (
          identity.executableDigest === this.spec.node.sha256 &&
          command.toString().split('\0').includes(this.spec.worker.path)
        )
          relay = identity;
        if (
          identity.executableDigest === this.spec.executable.sha256 &&
          identity.cwd === this.spec.appRoot
        ) {
          try {
            observeLoopbackListener(pid, this.spec.port);
            targets++;
            target = identity;
          } catch {
            /* Not a listening process yet. */
          }
        }
      } catch {
        /* Unrelated process may exit during bounded observation. */
      }
    }
    if (!relay || !target) return undefined;
    this.diagnostic.relayObserved = true;
    this.diagnostic.targetObserved = true;
    if (targets !== 1) throw failure('native-listener-ambiguity');
    const attestations = {
      'relay-privileges': confined(relay.pid),
      'target-privileges': confined(target.pid),
      'relay-pid-isolation': relay.namespaces.pid !== host.namespaces.pid,
      'relay-mount-isolation': relay.namespaces.mnt !== host.namespaces.mnt,
      'target-pid-isolation': target.namespaces.pid !== relay.namespaces.pid,
      'target-mount-isolation': target.namespaces.mnt !== relay.namespaces.mnt,
      'target-user-isolation': target.namespaces.user !== relay.namespaces.user,
      'target-host-uid': target.uid === host.uid,
      'native-private-mask': masked(target.pid, this.spec.privateDirectory),
      'native-protected-mask': this.spec.protectedPaths.every((path) => masked(target!.pid, path)),
      'native-proc-mask': masked(target.pid, '/proc'),
    };
    for (const [stage, passed] of Object.entries(attestations)) if (!passed) throw failure(stage);
    this.diagnostic.nativeMasksObserved = true;
    return { relay, target };
  }
  verify(receipt: IsolatedProjectReceipt): void {
    if (this.revoked || !this.receipt || JSON.stringify(receipt) !== JSON.stringify(this.receipt))
      throw failure();
    const { signature, ...unsigned } = receipt;
    const expected = createHmac('sha256', this.key).update(JSON.stringify(unsigned)).digest();
    const supplied = Buffer.from(signature, 'hex');
    if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied))
      throw failure();
    this.verifyInputs();
    if (
      !timingSafeEqual(
        readFileSync(join(this.spec.privateDirectory, 'project-process-signing-key')),
        this.key,
      )
    )
      throw failure();
    const current = this.observeTarget();
    if (
      !current ||
      JSON.stringify(current.relay) !== JSON.stringify(receipt.relay) ||
      JSON.stringify(current.target) !== JSON.stringify(receipt.target)
    )
      throw failure();
  }
  /** Fixed target only. The preview/helper controller may use this Duplex as createConnection. */
  open(receipt: IsolatedProjectReceipt): Duplex {
    this.verify(receipt);
    if (this.channels.size >= 32) throw failure();
    const id = ++this.nextChannel;
    const stream = new ProjectPipeSocket(
      (message) => {
        if (!this.revoked) this.send(message);
      },
      id,
      () => this.channels.delete(id),
    );
    this.channels.set(id, stream);
    this.send({ op: 'open', id });
    return stream;
  }
  async stop(): Promise<void> {
    this.revokeChannels();
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    if (this.exited) {
      await Promise.race([this.exited, sleep(5000)]);
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await Promise.race([this.exited, sleep(5000)]);
      }
      if (child && child.exitCode === null && child.signalCode === null)
        throw new Error('LIVE_PROJECT_RECOVERY_REQUIRED');
    }
    await this.pipes?.close();
    for (const fd of this.descriptors) {
      try {
        closeSync(fd);
      } catch {
        /* Already closed. */
      }
    }
    this.descriptors = [];
    if (this.network) {
      for (const name of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
        try {
          if (observeLiveProcess(Number(name)).namespaces.net === this.network)
            throw new Error('LIVE_PROJECT_RECOVERY_REQUIRED');
        } catch (error) {
          if ((error as Error).message === 'LIVE_PROJECT_RECOVERY_REQUIRED') throw error;
        }
      }
    }
    this.diagnostic.stage = 'revoked-and-exited';
  }
}
