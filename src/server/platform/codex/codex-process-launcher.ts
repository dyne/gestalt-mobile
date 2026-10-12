/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { JsonRpcClient } from './json-rpc-client.js';
import { profileAppServerCommand } from '../catalog/profile-command.js';
import { observeLiveProcess, type LiveProcessIdentity } from '../live-design/process-identity.js';
import { LIVE_CODEX_SHA256 } from '../live-design/native-contract.js';

export type CodexProcess = {
  child: ChildProcessWithoutNullStreams;
  rpc: JsonRpcClient;
  close(): void;
  onExit(listener: () => void): () => void;
  observeLiveLaunch(): LiveProcessIdentity;
};

export function launchCodexAppServer(
  input: {
    profile: string;
    cwd: string;
    environment?: Readonly<Record<string, string>>;
  },
  trusted?: {
    /** Controller-only installed native input; never a session/browser command parameter. */
    executable: string;
    sha256: string;
    environment: Readonly<Record<string, string>>;
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
  const child = spawn(trusted?.executable ?? launch.command, launch.args, {
    cwd: input.cwd,
    env: trusted
      ? { ...trusted.environment, ...input.environment }
      : codexChildEnvironment(input.environment),
    shell: false,
    stdio: 'pipe',
  });
  const rpc = new JsonRpcClient(child.stdout, child.stdin);
  child.once('error', (error) => rpc.fail(error));
  let birth: LiveProcessIdentity | undefined;
  return {
    child,
    rpc,
    observeLiveLaunch: () => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null)
        throw new Error('LIVE_RUNTIME_UNAVAILABLE');
      const current = observeLiveProcess(child.pid);
      birth ??= current;
      if (JSON.stringify(current) !== JSON.stringify(birth))
        throw new Error('LIVE_RUNTIME_IDENTITY_CHANGED');
      return current;
    },
    close: () => child.kill('SIGTERM'),
    onExit: (listener) => {
      child.once('exit', listener);
      return () => child.off('exit', listener);
    },
  };
}

/** Prevents a relay's own ambient status path from reaching discovery-only children. */
export function codexChildEnvironment(
  environment?: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const inherited = { ...process.env };
  delete inherited.GESTALT_MOBILE_ORG_PLAN_STATUS_FILE;
  delete inherited.GESTALT_MOBILE_ORG_PLAN_STATUS_DIRECTORY;
  delete inherited.GESTALT_MOBILE_ORG_PLAN_MEASUREMENT_URL;
  delete inherited.GESTALT_MOBILE_ORG_PLAN_MEASUREMENT_TOKEN;
  return { ...inherited, ...environment };
}
