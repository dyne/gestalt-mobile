/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, lstatSync } from 'node:fs';
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
  assertObservedProcessMetadata,
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
    managedLaunch?: Readonly<{ command: string; args: readonly string[] }>;
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
  input: Readonly<{ executable: string; sha256: string; args: readonly string[]; cwd: string }>,
  spawnedAt: number,
): (signal: AbortSignal, deadline?: number) => Promise<NativeImageTransition> {
  const expected = structuredClone(input);
  let controller: ReturnType<typeof observeControllerIsolation> | undefined;
  const sourcePin = () => {
    const info = lstatSync(expected.executable, { bigint: true });
    if (!info.isFile() || realpathSync(expected.executable) !== expected.executable)
      throw new Error('LIVE_NATIVE_HANDOFF_UNVERIFIED');
    return ['dev', 'ino', 'uid', 'gid', 'mode', 'size', 'nlink', 'mtimeNs', 'ctimeNs'].map((key) =>
      String(info[key as keyof typeof info]),
    );
  };
  let source: readonly string[] | undefined;
  let original: LiveProcessIdentity | undefined,
    used = false;
  let wrappers = new Set<string>();
  // Observation failure remains attached to this owned ChildProcess; never throw
  // after spawning and lose the caller's physical cleanup handle.
  try {
    controller = observeControllerIsolation();
    source = sourcePin();
    wrappers = new Set(
      ['/usr/bin/bash', '/usr/bin/env', process.execPath].map((path) => realpathSync(path)),
    );
    if (child.pid) original = observeLiveProcess(child.pid);
  } catch {
    /* refused by the asynchronous fence below */
  }
  return async (signal, deadline) => {
    if (
      used ||
      !controller ||
      !source ||
      !Number.isFinite(spawnedAt) ||
      spawnedAt > performance.now() ||
      (deadline !== undefined && !Number.isFinite(deadline))
    )
      throw new Error('LIVE_NATIVE_HANDOFF_UNVERIFIED');
    used = true;
    const end = Math.min(
      spawnedAt + LIVE_MANAGER_OBSERVATION_MS,
      deadline === undefined ? Infinity : performance.now() + Math.max(0, deadline - Date.now()),
    );
    const expired = () =>
      performance.now() >= end || (deadline !== undefined && Date.now() >= deadline);
    for (;;) {
      signal.throwIfAborted();
      if (expired()) throw new Error('LIVE_NATIVE_HANDOFF_TIMEOUT');
      if (
        !original ||
        !child.pid ||
        child.pid !== original.pid ||
        child.exitCode !== null ||
        child.signalCode !== null
      )
        throw new Error('LIVE_NATIVE_HANDOFF_UNVERIFIED');
      try {
        const executable = realpathSync(`/proc/${child.pid}/exe`);
        assertObservedProcessMetadata({ ...original, executable });
        if (
          original.uid !== controller.uid ||
          !isDeepStrictEqual(original.namespaces, controller.namespaces) ||
          original.cwd !== expected.cwd ||
          !isDeepStrictEqual(sourcePin(), source) ||
          Number(
            readFileSync(`/proc/${child.pid}/status`, 'utf8').match(/^PPid:\s+(\d+)/m)?.[1],
          ) !== process.pid
        )
          throw new Error();
        if (executable === expected.executable) {
          const current = observeLiveProcess(child.pid);
          const argv = readFileSync(`/proc/${child.pid}/cmdline`, 'utf8').split('\0').slice(0, -1);
          if (
            current.executableDigest !== expected.sha256 ||
            !isDeepStrictEqual(argv, [expected.executable, ...expected.args])
          )
            throw new Error();
          assertObservedProcessMetadata({ ...original, executable: expected.executable });
          assertObservedProcessMetadata(current);
          signal.throwIfAborted();
          if (expired() || !isDeepStrictEqual(sourcePin(), source)) throw new Error();
          return {
            elapsedMs: Math.round(performance.now() - spawnedAt),
            budgetMs: LIVE_MANAGER_OBSERVATION_MS,
          };
        }
        if (!wrappers.has(executable)) throw new Error();
      } catch {
        signal.throwIfAborted();
        if (expired()) throw new Error('LIVE_NATIVE_HANDOFF_TIMEOUT');
        throw new Error('LIVE_NATIVE_HANDOFF_UNVERIFIED');
      }
      await delay(Math.min(25, Math.max(1, end - performance.now())), undefined, { signal });
    }
  };
}
