/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  readFileSync,
  realpathSync,
  lstatSync,
  openSync,
  closeSync,
  fstatSync,
  readlinkSync,
  type BigIntStats,
} from 'node:fs';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { LIVE_MANAGER_OBSERVATION_MS } from '../live-design/installed-launch-contract.js';
import { JsonRpcClient } from './json-rpc-client.js';
import { profileAppServerCommand } from '../catalog/profile-command.js';
import {
  observeLiveProcess,
  observeOwnedDescendants,
  observedBirthExited,
  observeControllerIsolation,
  observeLiveKernel,
  type LiveKernelIdentity,
  type OwnedProcessBirth,
  type LiveProcessIdentity,
} from '../live-design/process-identity.js';
import { LIVE_CODEX_SHA256 } from '../live-design/native-contract.js';

export type CodexProcess = {
  child: ChildProcessWithoutNullStreams;
  rpc: JsonRpcClient;
  close(): void;
  onExit(listener: () => void): () => void;
  waitForExit(): Promise<void>;
  waitForLiveImage?(signal: AbortSignal, deadline?: number): Promise<NativeImageTransition>;
  observeLiveLaunch(): LiveProcessIdentity;
  observeLiveEnvironment(): Readonly<{ tmpdir: string; home: string; codexHome: string }>;
  observeLiveDescendants(): void;
};

export function launchCodexAppServer(
  input: {
    profile: string;
    cwd: string;
    environment?: Readonly<Record<string, string>>;
    liveCaptureId?: string;
  },
  trusted?: {
    /** Controller-only installed native input; never a session/browser command parameter. */
    executable: string;
    sha256: string;
    environment: Readonly<Record<string, string>>;
    /** Controller-authenticated Manager handoff; Native remains the verified
     * original image, and the managed CLI exec preserves the child handle. */
    managedLaunch?: Readonly<{
      command: string;
      args: readonly string[];
      cwdTransition?: Readonly<{ intermediate: string; final: string }>;
    }>;
  },
): CodexProcess {
  const launch = profileAppServerCommand();
  if (trusted) {
    try {
      if (
        trusted.sha256 !== LIVE_CODEX_SHA256 ||
        realpathSync(trusted.executable) !== trusted.executable ||
        createHash('sha256').update(readFileSync(trusted.executable)).digest('hex') !==
          trusted.sha256
      )
        throw new Error();
    } catch {
      throw new Error('LIVE_RUNTIME_BINARY_UNVERIFIED');
    }
  }
  const environment = codexChildEnvironment(input.environment, trusted?.environment);
  const spawnedAt = performance.now();
  const child = spawn(
    trusted?.managedLaunch?.command ?? trusted?.executable ?? launch.command,
    trusted?.managedLaunch ? [...trusted.managedLaunch.args] : launch.args,
    {
      cwd: input.cwd,
      env: environment,
      shell: false,
      stdio: 'pipe',
    },
  );
  const waitForLiveImage =
    input.liveCaptureId && trusted?.managedLaunch
      ? capturedNativeImageFence(
          child,
          {
            executable: trusted.executable,
            sha256: trusted.sha256,
            args: launch.args,
            cwd: input.cwd,
            cwdTransition: trusted.managedLaunch.cwdTransition ?? { intermediate: '', final: '' },
          },
          spawnedAt,
        )
      : undefined;
  const rpc = new JsonRpcClient(child.stdout, child.stdin);
  child.once('error', (error) => rpc.fail(error));
  // Positive lifetime evidence from this exact ChildProcess; a missing PID is not an exit receipt.
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
  let birth: LiveProcessIdentity | undefined;
  const descendants = new Map<string, OwnedProcessBirth>();
  let treeObserved = false,
    treeFailed = false;
  const observeTree = () => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null)
      throw new Error('LIVE_PROCESS_TREE_UNVERIFIED');
    const owner = observeLiveProcess(child.pid);
    birth ??= owner;
    if (JSON.stringify(owner) !== JSON.stringify(birth))
      throw new Error('LIVE_PROCESS_TREE_UNVERIFIED');
    for (const identity of observeOwnedDescendants(owner))
      descendants.set(`${identity.pid}:${identity.birth}`, identity);
    treeObserved = true;
  };
  return {
    child,
    rpc,
    ...(waitForLiveImage ? { waitForLiveImage } : {}),
    waitForExit: async () => {
      await exited;
      if (!treeObserved || treeFailed) throw new Error('LIVE_PROCESS_TREE_UNVERIFIED');
      const deadline = Date.now() + 5000;
      while ([...descendants.values()].some((identity) => !observedBirthExited(identity))) {
        if (Date.now() >= deadline) throw new Error('LIVE_PROCESS_TREE_UNVERIFIED');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
    observeLiveDescendants: observeTree,
    observeLiveEnvironment: () => {
      if (!trusted || !child.pid || child.exitCode !== null || child.signalCode !== null)
        throw new Error('LIVE_RUNTIME_ENVIRONMENT_UNVERIFIED');
      return readLiveProcessEnvironment(child.pid);
    },
    observeLiveLaunch: () => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null)
        throw new Error('LIVE_RUNTIME_UNAVAILABLE');
      const current = observeLiveProcess(child.pid);
      birth ??= current;
      if (JSON.stringify(current) !== JSON.stringify(birth))
        throw new Error('LIVE_RUNTIME_IDENTITY_CHANGED');
      return current;
    },
    close: () => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          observeTree();
        } catch {
          if (!treeObserved || !birth || !observedBirthExited(birth)) treeFailed = true;
        }
        child.kill('SIGTERM');
      }
    },
    onExit: (listener) => {
      child.once('exit', listener);
      return () => child.off('exit', listener);
    },
  };
}

/** The Manager handoff replaces its environment when it execs Native. Observe
 * the actual owning image, rather than reporting its wrapper's launch input. */
export function readLiveProcessEnvironment(pid: number): Readonly<{
  tmpdir: string;
  home: string;
  codexHome: string;
}> {
  try {
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error();
    const values = new Map<string, string>();
    for (const item of readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
      const split = item.indexOf('=');
      const key = item.slice(0, split);
      if (!['HOME', 'CODEX_HOME', 'TMPDIR'].includes(key)) continue;
      if (split < 1 || values.has(key)) throw new Error();
      const value = item.slice(split + 1);
      if (!value.startsWith('/')) throw new Error();
      values.set(key, value);
    }
    const home = values.get('HOME'),
      codexHome = values.get('CODEX_HOME'),
      tmpdir = values.get('TMPDIR');
    if (!home || !codexHome || !tmpdir) throw new Error();
    return Object.freeze({ tmpdir, home, codexHome });
  } catch {
    throw new Error('LIVE_RUNTIME_ENVIRONMENT_UNVERIFIED');
  }
}

/** Prevents a relay's own ambient status path from reaching discovery-only children. */
export function codexChildEnvironment(
  environment?: Readonly<Record<string, string>>,
  launchEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const inherited = { ...launchEnvironment };
  delete inherited.GESTALT_MOBILE_ORG_PLAN_CAPABILITIES;
  delete inherited.GESTALT_MOBILE_ORG_PLAN_STATUS_FILE;
  delete inherited.GESTALT_MOBILE_ORG_PLAN_STATUS_DIRECTORY;
  delete inherited.GESTALT_MOBILE_ORG_PLAN_MEASUREMENT_URL;
  delete inherited.GESTALT_MOBILE_ORG_PLAN_MEASUREMENT_TOKEN;
  return { ...inherited, ...environment };
}

export type NativeImageTransition = Readonly<{ elapsedMs: number; budgetMs: number }>;
/** Exact owned-child exec observation only. No config/tool/model readiness or authority.
 * One original spawn deadline; retries cannot restart the managed handoff clock. */
export function capturedNativeImageFence(
  child: ChildProcessWithoutNullStreams,
  input: Readonly<{
    executable: string;
    sha256: string;
    args: readonly string[];
    cwd: string;
    cwdTransition?: Readonly<{ intermediate: string; final: string }>;
  }>,
  spawnedAt: number,
): (signal: AbortSignal, deadline?: number) => Promise<NativeImageTransition> {
  const expected = structuredClone(input);
  const finalCwd = expected.cwdTransition?.final ?? expected.cwd;
  const intermediate = expected.cwdTransition?.intermediate ?? expected.cwd;
  let phase = 'construction',
    used = false;
  const refuse = (code = 'LIVE_NATIVE_HANDOFF_UNVERIFIED') =>
    Object.assign(new Error(code), { handoffPhase: phase });
  const pin = (info: BigIntStats) => {
    if (!info.isFile()) throw refuse();
    return ['dev', 'ino', 'uid', 'gid', 'mode', 'size', 'nlink', 'mtimeNs', 'ctimeNs'].map((key) =>
      String(info[key as keyof typeof info]),
    );
  };
  type Role = 'shell' | 'environment' | 'native';
  type Image = { fd: number; path: string; role: Role; identity: readonly string[] };
  const sources = new Map<string, { role: Role; identity: readonly string[] }>();
  let original: LiveKernelIdentity | undefined;
  let controller: ReturnType<typeof observeControllerIsolation> | undefined;
  let constructionValid = false;
  // Ordered states of the pinned Manager bridge. Components are observed in
  // time order, never combined into a fictitious simultaneous identity tuple.
  const states: readonly { role: Role; cwd: string }[] = [
    { role: 'environment', cwd: expected.cwd },
    { role: 'shell', cwd: expected.cwd },
    { role: 'shell', cwd: intermediate },
    { role: 'environment', cwd: intermediate },
    { role: 'environment', cwd: finalCwd },
    { role: 'native', cwd: finalCwd },
  ];
  let stage = 0;
  const advance = (field: 'role' | 'cwd', value: string) => {
    const next = states.findIndex((state, index) => index >= stage && state[field] === value);
    if (next < 0) throw refuse();
    stage = next;
  };
  try {
    for (const cwd of [expected.cwd, intermediate, finalCwd])
      if (!cwd.startsWith('/') || realpathSync(cwd) !== cwd || !lstatSync(cwd).isDirectory())
        throw refuse();
    controller = observeControllerIsolation();
    for (const [path, role] of [
      [realpathSync('/usr/bin/bash'), 'shell'],
      [realpathSync('/usr/bin/env'), 'environment'],
      [expected.executable, 'native'],
    ] as const) {
      if (realpathSync(path) !== path) throw refuse();
      sources.set(path, { role, identity: pin(lstatSync(path, { bigint: true })) });
    }
    if (child.pid) original = observeLiveKernel(child.pid);
    constructionValid = true;
  } catch {
    /* The exact ChildProcess remains retained for physical cleanup. */
  }
  return async (signal, deadline) => {
    if (
      used ||
      !constructionValid ||
      !original ||
      !controller ||
      !Number.isFinite(spawnedAt) ||
      spawnedAt > performance.now() ||
      (deadline !== undefined && !Number.isFinite(deadline))
    )
      throw refuse();
    used = true;
    const end = Math.min(
      spawnedAt + LIVE_MANAGER_OBSERVATION_MS,
      deadline === undefined ? Infinity : performance.now() + Math.max(0, deadline - Date.now()),
    );
    const checkClock = () => {
      signal.throwIfAborted();
      if (performance.now() >= end || (deadline !== undefined && Date.now() >= deadline)) {
        phase = 'deadline';
        throw refuse('LIVE_NATIVE_HANDOFF_TIMEOUT');
      }
    };
    const kernel = () => {
      phase = 'identity';
      checkClock();
      if (
        !child.pid ||
        child.pid !== original.pid ||
        child.exitCode !== null ||
        child.signalCode !== null ||
        original.parentPid !== process.pid ||
        original.uid !== controller.uid ||
        !isDeepStrictEqual(original.namespaces, controller.namespaces) ||
        !isDeepStrictEqual(observeLiveKernel(child.pid), original)
      )
        throw refuse();
    };
    const guardSources = () => {
      phase = 'source';
      for (const [path, source] of sources)
        if (
          realpathSync(path) !== path ||
          !isDeepStrictEqual(pin(lstatSync(path, { bigint: true })), source.identity)
        )
          throw refuse();
    };
    const image = (): Image => {
      phase = 'image';
      const fd = openSync(`/proc/${original.pid}/exe`, 'r');
      try {
        const path = readlinkSync(`/proc/self/fd/${fd}`),
          source = sources.get(path);
        const identity = pin(fstatSync(fd, { bigint: true }));
        if (!source || !isDeepStrictEqual(identity, source.identity)) throw refuse();
        advance('role', source.role);
        return { fd, path, role: source.role, identity };
      } catch (error) {
        closeSync(fd);
        throw error;
      }
    };
    const cwd = () => {
      phase = 'cwd';
      const value = realpathSync(`/proc/${original.pid}/cwd`);
      advance('cwd', value);
      return value;
    };
    for (;;) {
      const opened: number[] = [];
      try {
        kernel();
        guardSources();
        const priorStage = stage;
        const first = image();
        opened.push(first.fd);
        const firstCwd = cwd();
        const second = image();
        opened.push(second.fd);
        const secondCwd = cwd();
        kernel();
        guardSources();
        checkClock();
        // Only positive observations of admitted forward components can yield
        // a transition. Kernel/source/read errors are never caught and retried.
        if (first.role === 'native') {
          phase = 'image';
          if (
            second.role !== 'native' ||
            first.path !== expected.executable ||
            second.path !== first.path ||
            !isDeepStrictEqual(first.identity, second.identity) ||
            firstCwd !== finalCwd ||
            secondCwd !== finalCwd
          )
            throw refuse();
          const argv = () =>
            readFileSync(`/proc/${original.pid}/cmdline`, 'utf8').split('\0').slice(0, -1);
          const expectedArgv = [expected.executable, ...expected.args];
          if (!isDeepStrictEqual(argv(), expectedArgv)) throw refuse();
          // The bytes belong to this retained executable FD, not a later open
          // of /proc/pid/exe which might already designate another image.
          if (
            createHash('sha256').update(readFileSync(first.fd)).digest('hex') !== expected.sha256 ||
            !isDeepStrictEqual(pin(fstatSync(first.fd, { bigint: true })), first.identity)
          )
            throw refuse();
          checkClock();
          kernel();
          guardSources();
          const current = image();
          opened.push(current.fd);
          if (
            current.role !== 'native' ||
            current.path !== expected.executable ||
            !isDeepStrictEqual(current.identity, first.identity)
          )
            throw refuse();
          if (cwd() !== finalCwd) throw refuse();
          phase = 'image';
          if (!isDeepStrictEqual(argv(), expectedArgv)) throw refuse();
          kernel();
          guardSources();
          checkClock();
          return {
            elapsedMs: Math.round(performance.now() - spawnedAt),
            budgetMs: LIVE_MANAGER_OBSERVATION_MS,
          };
        }
        const outcome: 'transition' | 'wrapper-pending' =
          first.role !== second.role || firstCwd !== secondCwd ? 'transition' : 'wrapper-pending';
        if (outcome === 'transition' && stage <= priorStage) throw refuse();
        // This explicit nonauthorizing outcome comes only after unchanged
        // kernel/source checks and admitted forward graph observations.
      } catch (error) {
        signal.throwIfAborted();
        checkClock();
        if (error instanceof Error && error.message === 'LIVE_NATIVE_HANDOFF_TIMEOUT') throw error;
        throw refuse();
      } finally {
        for (const fd of opened) closeSync(fd);
      }
      await delay(Math.min(25, Math.max(1, end - performance.now())), undefined, { signal });
    }
  };
}
