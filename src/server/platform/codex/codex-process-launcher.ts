/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { JsonRpcClient } from './json-rpc-client.js';
import { profileAppServerCommand } from '../catalog/profile-command.js';
import { withoutSessionScratch } from '../scratch/child-environment.js';
import { stopOwnedProcessGroup } from '../scratch/owned-process-group.js';

export type CodexProcess = {
  child: ChildProcessWithoutNullStreams;
  rpc: JsonRpcClient;
  close(): void;
  closeAndWait(): Promise<void>;
  onExit(listener: () => void): () => void;
};

export function launchCodexAppServer(input: {
  profile: string;
  cwd: string;
  environment?: Readonly<Record<string, string>>;
}): CodexProcess {
  const launch = profileAppServerCommand();
  const child = spawn(launch.command, launch.args, {
    cwd: input.cwd,
    env: codexChildEnvironment(input.environment),
    shell: false,
    stdio: 'pipe',
    detached: true,
  });
  const rpc = new JsonRpcClient(child.stdout, child.stdin);
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
  });
  child.once('error', (error) => rpc.fail(error));
  child.stdin.on('error', (error) => rpc.fail(error));
  // App-server diagnostics are not protocol output. Drain them without retaining
  // potentially sensitive contents or letting a full stderr pipe block shutdown.
  child.stderr.resume();
  let closing = false;
  let confirmation: Promise<void> | undefined;
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  child.once('exit', () => {
    clearTimeout(shutdownTimer);
    child.stdin.destroy();
  });
  // close follows stdout drainage; exit alone can precede a final RPC response.
  child.once('close', () => rpc.fail(new Error('CODEX_APP_SERVER_EXITED')));
  const result: CodexProcess = {
    child,
    rpc,
    close: () => {
      if (closing) return;
      closing = true;
      rpc.fail(new Error('CODEX_APP_SERVER_CLOSED'));
      // EOF also releases older managed proxies blocked in a filesystem read.
      child.stdin.end();
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      shutdownTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 3_000);
      shutdownTimer.unref();
    },
    closeAndWait: () => {
      if (confirmation) return confirmation;
      result.close();
      confirmation = (async () => {
        if (!(await stopOwnedProcessGroup(child, 4000, 2000)))
          throw new Error('SESSION_RELEASE_UNCONFIRMED');
        await exited;
      })().catch((error) => {
        confirmation = undefined;
        throw error;
      });
      return confirmation;
    },
    onExit: (listener) => {
      child.once('exit', listener);
      return () => child.off('exit', listener);
    },
  };
  return result;
}

/** Prevents a relay's own ambient status path from reaching discovery-only children. */
export function codexChildEnvironment(
  environment?: Readonly<Record<string, string>>,
  launchEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const inherited = withoutSessionScratch(launchEnvironment);
  delete inherited.GESTALT_MOBILE_ORG_PLAN_CAPABILITIES;
  delete inherited.GESTALT_MOBILE_ORG_PLAN_STATUS_FILE;
  delete inherited.GESTALT_MOBILE_ORG_PLAN_STATUS_DIRECTORY;
  delete inherited.GESTALT_MOBILE_ORG_PLAN_MEASUREMENT_URL;
  delete inherited.GESTALT_MOBILE_ORG_PLAN_MEASUREMENT_TOKEN;
  return { ...inherited, ...environment };
}
