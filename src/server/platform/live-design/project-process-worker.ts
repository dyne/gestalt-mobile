/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// Private executable entry point. No listening management endpoint or project-selected target.
import { spawn, type ChildProcess } from 'node:child_process';
import { readlinkSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

export const projectStdioExecutables = ['/usr/bin/bash', '/usr/bin/cat'] as const;
/** Build real FIFO stdio before entering Native; data stays literal argv. */
export function projectNativeStdioCommand(native: string, args: readonly string[]) {
  return {
    executable: projectStdioExecutables[0],
    args: [
      '--noprofile',
      '--norc',
      '-c',
      'exec -a codex-linux-sandbox "$@" < <(exec /usr/bin/cat) > >(exec /usr/bin/cat) 2> >(exec /usr/bin/cat >&2)',
      'gestalt-live-project-stdio',
      native,
      ...args,
    ],
  };
}

type Specification = {
  role: 'helper' | 'devserver';
  native: string;
  executable: string;
  argv: string[];
  environment: Record<string, string>;
  appRoot: string;
  permissionProfile: unknown;
  port: number;
};
function runProjectWorker(): void {
  let spec: Specification | undefined;
  let target: ChildProcess | undefined;
  let command: ChildProcess | undefined;
  let commandRequest: number | undefined;
  let commandCancelled = false;
  let stopping = false;
  const channels = new Map<number, Socket>();
  const send = (message: unknown) => {
    if (!stopping) {
      if (process.stdout.writableLength > 1024 * 1024) {
        stop();
        return;
      }
      process.stdout.write(JSON.stringify(message) + '\n');
    }
  };
  const stop = () => {
    if (stopping) return;
    stopping = true;
    for (const socket of channels.values()) socket.destroy();
    channels.clear();
    target?.kill('SIGTERM');
    command?.kill('SIGTERM');
    process.exit(1); // Outer PID namespace lifetime kills all descendants.
  };
  process.stdin.on('end', stop);
  process.stdout.on('error', stop);
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let inputBytes = 0;
  process.stdin.on('data', (data: Buffer) => {
    inputBytes += data.length;
    if (inputBytes > 512 * 1024) stop();
  });
  lines.on('line', (line) => {
    inputBytes = 0;
    try {
      if (line.length > 256 * 1024) throw new Error();
      const message = JSON.parse(line) as Record<string, unknown>;
      if (!spec) {
        if (message.op !== 'launch') throw new Error();
        spec = message.specification as Specification;
        if (!spec || !Array.isArray(spec.argv) || !Number.isSafeInteger(spec.port))
          throw new Error();
        target = spawn(
          spec.native,
          [
            '--sandbox-policy-cwd',
            spec.appRoot,
            '--permission-profile',
            JSON.stringify(spec.permissionProfile),
            // The native default mounts fresh procfs AFTER deny masks. Preserve the explicit
            // /proc denial while retaining its fresh PID namespace; never inherit host procfs.
            '--no-proc',
            '--',
            spec.executable,
            ...spec.argv,
          ],
          {
            argv0: 'codex-linux-sandbox',
            cwd: spec.appRoot,
            env: spec.environment,
            // Never inherit the controller relay's pipe/socket/control descriptors.
            stdio: ['ignore', 'ignore', 'ignore'],
          },
        );
        target.once('error', () => {
          send({ type: 'failed', reason: 'native-launch' });
          stop();
        });
        target.once('exit', () => {
          send({ type: 'failed', reason: 'native-exited' });
          stop();
        });
        send({ type: 'namespace', network: readlinkSync('/proc/self/ns/net') });
        return;
      }
      if (message.op === 'helper-command-cancel') {
        if (command && message.requestId === commandRequest) {
          commandCancelled = true;
          command.kill('SIGTERM');
        }
        return;
      }
      if (message.op === 'helper-command') {
        const requestId = message.requestId;
        const args = message.args;
        const deadline = message.deadlineMs;
        if (
          spec.role !== 'helper' ||
          command ||
          !Number.isSafeInteger(requestId) ||
          !Array.isArray(args) ||
          args.length > 12 ||
          args.some((arg) => typeof arg !== 'string' || arg.length > 65536 || arg.includes('\0')) ||
          !Number.isInteger(deadline) ||
          Number(deadline) < 1000 ||
          Number(deadline) > 660000 ||
          !helperArgs(args as string[])
        )
          throw new Error();
        const id = Number(requestId);
        const bridged = projectNativeStdioCommand(spec.native, [
          '--sandbox-policy-cwd',
          spec.appRoot,
          '--permission-profile',
          JSON.stringify(spec.permissionProfile),
          '--no-proc',
          '--',
          spec.executable,
          ...(args as string[]),
          '--target',
          spec.appRoot,
        ]);
        const child = spawn(bridged.executable, bridged.args, {
          cwd: spec.appRoot,
          env: spec.environment,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        command = child;
        commandRequest = id;
        commandCancelled = false;
        let output = '',
          bytes = 0,
          stderr = '',
          failed = false,
          failureReason = 'native-command-exit';
        const fail = (reason = 'native-command-launch') => {
          failed = true;
          failureReason = reason;
          child.kill('SIGTERM');
        };
        const timer = setTimeout(() => fail('native-command-deadline'), Number(deadline));
        child.stdout!.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 128 * 1024) fail('native-command-oversized');
          else output += chunk.toString('utf8');
        });
        child.stderr!.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 128 * 1024) fail('native-command-oversized');
          else stderr += chunk.toString('utf8');
        });
        child.once('error', () => fail());
        child.once('close', (code) => {
          clearTimeout(timer);
          command = undefined;
          commandRequest = undefined;
          if (commandCancelled) {
            send({ type: 'helper-command-cancelled', requestId: id });
            commandCancelled = false;
            return;
          }
          if (code !== 0 || failed) {
            send({
              type: 'helper-command-failed',
              requestId: id,
              reason: failureReason,
              diagnostic: {
                exitCode: code,
                stdoutBytes: Buffer.byteLength(output),
                stderrBytes: Buffer.byteLength(stderr),
                markers: [
                  'permission denied',
                  'operation not permitted',
                  'read-only file system',
                  'no such file',
                  'unknown option',
                  'unexpected argument',
                  'connection refused',
                  'bwrap',
                  'timeout',
                ].filter((value) => stderr.toLowerCase().includes(value)),
              },
            });
            return;
          }
          try {
            send({ type: 'helper-command-result', requestId: id, result: JSON.parse(output) });
          } catch {
            send({
              type: 'helper-command-failed',
              requestId: id,
              reason: 'native-command-protocol',
              diagnostic: {
                exitCode: code,
                stdoutBytes: Buffer.byteLength(output),
                stderrBytes: Buffer.byteLength(stderr),
                markers: [],
              },
            });
          }
        });
        return;
      }
      const id = message.id;
      if (!Number.isSafeInteger(id) || Number(id) < 1) throw new Error();
      if (message.op === 'open') {
        if (channels.has(Number(id)) || channels.size >= 32) throw new Error();
        const socket = createConnection({ host: '127.0.0.1', port: spec.port });
        channels.set(Number(id), socket);
        socket.once('connect', () => send({ type: 'connected', id }));
        socket.on('data', (chunk: Buffer) => {
          for (let offset = 0; offset < chunk.length; offset += 65536)
            send({
              type: 'data',
              id,
              data: chunk.subarray(offset, offset + 65536).toString('base64'),
            });
        });
        socket.once('error', () => send({ type: 'channel-error', id }));
        socket.once('end', () => send({ type: 'end', id }));
        socket.once('close', () => {
          channels.delete(Number(id));
          send({ type: 'closed', id });
        });
        return;
      }
      const socket = channels.get(Number(id));
      if (!socket) return;
      if (message.op === 'data') {
        if (typeof message.data !== 'string' || message.data.length > 87384) throw new Error();
        if (socket.writableLength > 1024 * 1024) throw new Error();
        socket.write(Buffer.from(message.data, 'base64'));
      } else if (message.op === 'end') socket.end();
      else if (message.op === 'close') socket.destroy();
      else if (message.op === 'pause') socket.pause();
      else if (message.op === 'resume') socket.resume();
      else throw new Error();
    } catch {
      send({ type: 'failed', reason: 'controller-protocol' });
      stop();
    }
  });
}

// Defense in depth at the pinned private worker: no arbitrary executable, target,
// force flag, shell syntax, environment or management operation is admitted.
function helperArgs(args: string[]): boolean {
  const id = (value: string | undefined) =>
    !!value && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
  const [name, ...rest] = args;
  if (name === 'live-status') return !rest.length;
  if (name === 'live-inject') return !rest.length || (rest.length === 1 && rest[0] === '--remove');
  if (name === 'live-resume')
    return !rest.length || (rest.length === 2 && rest[0] === '--id' && id(rest[1]));
  if (name === 'live-complete' || name === 'live-accept')
    return (
      rest[0] === '--id' &&
      id(rest[1]) &&
      (rest.length === 2 ||
        (rest.length === 3 && rest[2] === (name === 'live-complete' ? '--discarded' : '--discard')))
    );
  if (name !== 'live-poll') return false;
  if (rest.length === 1 && /^--timeout=\d+$/.test(rest[0]!)) {
    const n = Number(rest[0]!.slice(10));
    return n >= 1 && n <= 600000;
  }
  if (rest[0] !== '--reply' || !id(rest[1]) || !['done', 'steer_done', 'error'].includes(rest[2]!))
    return false;
  let message = false;
  const seen = new Set<string>();
  for (let i = 3; i < rest.length; i++) {
    const flag = rest[i]!;
    if (flag === '--file' || flag === '--data') {
      if (seen.has(flag) || !rest[i + 1]) return false;
      seen.add(flag);
      const value = rest[++i]!;
      if (
        flag === '--file' &&
        (value.startsWith('/') || value.split('/').includes('..') || value.startsWith('-'))
      )
        return false;
      if (flag === '--data') {
        try {
          const data = JSON.parse(value);
          if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
        } catch {
          return false;
        }
      }
    } else if (message || flag.startsWith('-')) return false;
    else message = true;
  }
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runProjectWorker();
