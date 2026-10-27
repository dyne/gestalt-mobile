/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, openSync, writeSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HostTestRequest, HostTestResult } from '../../../shared/contracts/host-tests.js';
import type { HostTestOwner, HostTestRunner } from '../../features/host-tests/application/ports.js';
import { candidate } from './candidate.js';
import { loadWorkspaceHostTestConfig, within, type HostTestSuite } from './config.js';

// The host owns a lifetime pipe; even a host crash closes it. Tests cannot inherit
// that pipe or the IPC channel. The guardian reaps its own group, never a stored PID.
const guardian = `
const {spawn}=require('node:child_process');
const [command,args,cwd]=process.argv.slice(1);
let stopping=false;
function stop(){if(stopping)return;stopping=true;try{process.kill(-process.pid,'SIGTERM')}catch{}
setTimeout(()=>{try{process.kill(-process.pid,'SIGKILL')}catch{}process.exit(1)},250)}
process.on('SIGTERM',stop);process.on('SIGINT',stop);process.on('disconnect',stop);
process.stdin.resume();process.stdin.on('end',stop);
const child=spawn(command,JSON.parse(args),{cwd,env:process.env,stdio:['ignore','inherit','inherit'],shell:false});
child.once('error',()=>{if(process.connected)process.send({exitCode:127,signal:null});stop()});
child.once('exit',(exitCode,signal)=>{if(process.connected)process.send({exitCode,signal});stop()});
`;

type Active = {
  result: HostTestResult;
  repository: string;
  stop(reason: HostTestResult['state']): void;
  done: Promise<void>;
};
type Completed = (sessionId: string, runId: string, observedAt: string) => void;

/** One host-owned runner per relay. Each run retains its resolved configuration. */
export class LocalHostTestRunner implements HostTestRunner {
  private readonly results = new Map<string, HostTestResult>();
  private readonly active = new Map<string, Active>();
  private readonly reservations = new Set<string>();
  private readonly requests = new Map<string, Promise<unknown>>();
  private readonly sessionGenerations = new Map<string, number>();
  private closing = false;

  constructor(
    private readonly evidenceRoot: string,
    private readonly completed: Completed = () => {},
    private readonly workspaceSuites: (
      workspace: string,
    ) => Promise<HostTestSuite[]> = loadWorkspaceHostTestConfig,
  ) {}

  async initialize(): Promise<void> {
    if (process.platform !== 'linux' && process.platform !== 'darwin')
      throw new Error('Host tests require POSIX process groups');
    await mkdir(this.evidenceRoot, { recursive: true, mode: 0o700 });
    const info = await lstat(this.evidenceRoot);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.mode & 0o077 ||
      info.uid !== process.getuid?.()
    )
      throw new Error('Private host test evidence directory required');
    const entries = await readdir(this.evidenceRoot);
    if (entries.length > 1000)
      throw new Error('Archive host test evidence before starting more runs');
    for (const id of entries) {
      if (!/^[a-f0-9-]{36}$/.test(id)) continue;
      try {
        const path = join(this.evidenceRoot, id, 'result.json');
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) continue;
        const result = JSON.parse(await readFile(path, 'utf8')) as HostTestResult;
        if (
          result.version !== 1 ||
          result.runId !== id ||
          typeof result.sessionId !== 'string' ||
          typeof result.requestId !== 'string'
        )
          continue;
        result.resultPath = path;
        result.logPath = join(this.evidenceRoot, id, 'output.log');
        if (result.state === 'running') {
          result.state = 'interrupted';
          result.observedAt = new Date().toISOString();
          result.counts = null;
          await this.persist(result);
        }
        this.results.set(id, result);
      } catch {
        /* Incomplete crash artifacts never become a passing result. */
      }
    }
  }

  async request(owner: HostTestOwner, input: HostTestRequest): Promise<unknown> {
    const generation = this.sessionGenerations.get(owner.sessionId) ?? 0;
    if (input.operation !== 'start') return this.dispatch(owner, input, generation);
    const key = owner.sessionId + ':' + input.requestId;
    const pending = this.requests.get(key);
    if (pending) {
      await pending;
      return this.request(owner, input);
    }
    const operation = this.dispatch(owner, input, generation);
    this.requests.set(key, operation);
    try {
      return await operation;
    } finally {
      this.requests.delete(key);
    }
  }

  private async dispatch(
    owner: HostTestOwner,
    input: HostTestRequest,
    generation: number,
  ): Promise<unknown> {
    if (input.operation === 'status' || input.operation === 'cancel') {
      const result = this.results.get(input.runId);
      if (!result || result.sessionId !== owner.sessionId) return { error: 'runNotFound' };
      if (input.operation === 'cancel') this.active.get(result.runId)?.stop('cancelled');
      return structuredClone(result);
    }
    if (input.operation === 'start') {
      const previous = [...this.results.values()].find(
        (result) => result.sessionId === owner.sessionId && result.requestId === input.requestId,
      );
      if (previous) {
        return previous.suite === input.suite
          ? structuredClone(previous)
          : { error: 'requestIdConflict' };
      }
    }
    const workspace = await realpath(owner.workspace);
    if (within(workspace, await realpath(this.evidenceRoot)))
      return { error: 'evidenceInsideWorkspace' };
    const suites = await this.workspaceSuites(workspace);
    const available = suites.filter((suite) => within(workspace, suite.repository));
    if (input.operation === 'list')
      return {
        suites: available.map((suite) => ({
          id: suite.id,
          repository: suite.repository,
          timeoutMs: suite.timeoutMs,
        })),
      };
    const suite = available.find((suite) => suite.id === input.suite);
    if (!suite) return { error: 'suiteUnavailable' };
    if ((await realpath(suite.repository)) !== suite.repository)
      return { error: 'repositoryChanged' };
    if (input.operation === 'inspect') {
      const current = await candidate(suite.repository);
      return {
        suite: suite.id,
        repository: suite.repository,
        candidate: current,
        fingerprintScope:
          'Git-visible files, modes, index, HEAD and branch; excludes ignored dependencies and host toolchains',
      };
    }
    return this.start(owner, suite, input.requestId, generation);
  }

  private async start(
    owner: HostTestOwner,
    suite: HostTestSuite,
    requestId: string,
    generation: number,
  ): Promise<unknown> {
    if (this.closing) return { error: 'hostShuttingDown' };
    if (this.results.size >= 1000) return { error: 'evidenceCapacityReached' };
    if (this.reservations.has(suite.repository)) return { error: 'repositoryBusy' };
    if (this.reservations.size >= 2) return { error: 'hostRunnerBusy' };
    this.reservations.add(suite.repository);
    try {
      const current = await candidate(suite.repository);
      if (this.closing) return { error: 'hostShuttingDown' };
      const runId = randomUUID();
      const directory = join(this.evidenceRoot, runId);
      await mkdir(directory, { mode: 0o700 });
      const now = new Date().toISOString();
      const result: HostTestResult = {
        version: 1,
        runId,
        requestId,
        sessionId: owner.sessionId,
        suite: suite.id,
        candidate: current,
        finalCandidate: null,
        state: 'running',
        startedAt: now,
        processExitedAt: null,
        observedAt: now,
        exitCode: null,
        signal: null,
        counts: null,
        outputBytes: 0,
        outputSha256: null,
        logPath: join(directory, 'output.log'),
        resultPath: join(directory, 'result.json'),
      };
      await this.persist(result);
      await writeFile(
        join(directory, 'invocation.json'),
        JSON.stringify({
          repository: suite.repository,
          command: suite.command,
          args: suite.args,
          timeoutMs: suite.timeoutMs,
          maxOutputBytes: suite.maxOutputBytes,
          fingerprintVersion: 1,
          candidate: current,
          nodeVersion: process.version,
          platform: process.platform,
          arch: process.arch,
          limitations:
            'Ignored dependencies and host toolchains are not fingerprinted. Live checkout checked before and after, not an immutable snapshot.',
        }) + '\n',
        { mode: 0o600 },
      );
      this.results.set(runId, result);
      if (this.closing || generation !== (this.sessionGenerations.get(owner.sessionId) ?? 0)) {
        result.state = this.closing ? 'interrupted' : 'cancelled';
        await this.persist(result);
        return structuredClone(result);
      }
      try {
        this.launch(suite, result);
      } catch {
        result.state = 'interrupted';
        await this.persist(result);
      }
      return structuredClone(result);
    } finally {
      if (![...this.active.values()].some((run) => run.repository === suite.repository))
        this.reservations.delete(suite.repository);
    }
  }

  private launch(suite: HostTestSuite, result: HostTestResult): void {
    const fd = openSync(result.logPath, 'wx', 0o600);
    const hash = createHash('sha256');
    // No provider keys, relay tokens, hooks, NODE_OPTIONS or shell startup variables.
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR']) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    env.CI = '1';
    env.NO_COLOR = '1';
    let child;
    try {
      child = spawn(
        process.execPath,
        ['-e', guardian, suite.command, JSON.stringify(suite.args), suite.repository],
        {
          cwd: suite.repository,
          env,
          detached: true,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        },
      );
    } catch (error) {
      closeSync(fd);
      throw error;
    }
    let reason: HostTestResult['state'] | undefined;
    let finished!: () => void;
    const done = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const stop = (state: HostTestResult['state']) => {
      reason ??= state;
      child.stdin?.end();
    };
    this.active.set(result.runId, { result, repository: suite.repository, stop, done });
    const timeout = setTimeout(() => stop('timedOut'), suite.timeoutMs);
    let summary = '';
    child.stdin?.on('error', () => {});
    const output = (data: Buffer) => {
      const room = suite.maxOutputBytes - result.outputBytes;
      const kept = data.subarray(0, Math.max(0, room));
      if (kept.length) {
        try {
          writeSync(fd, kept);
          hash.update(kept);
          result.outputBytes += kept.length;
        } catch {
          stop('interrupted');
        }
      }
      summary = (summary + kept.toString('utf8')).slice(-8192);
      if (data.length > room) stop('outputLimit');
    };
    child.stdout?.on('data', output);
    child.stderr?.on('data', output);
    child.on('message', (message) => {
      const value = message as { exitCode?: unknown; signal?: unknown };
      if (Number.isInteger(value?.exitCode) || value?.exitCode === null) {
        result.exitCode = typeof value.exitCode === 'number' ? value.exitCode : null;
        result.signal = typeof value.signal === 'string' ? value.signal.slice(0, 32) : null;
        result.processExitedAt = new Date().toISOString();
      }
    });
    child.once('error', () => {
      reason ??= 'interrupted';
    });
    child.once('close', () => {
      clearTimeout(timeout);
      closeSync(fd);
      void (async () => {
        const terminal = structuredClone(result);
        terminal.outputSha256 = hash.digest('hex');
        try {
          terminal.finalCandidate = await candidate(suite.repository);
        } catch {
          /* Unknown candidate cannot support acceptance. */
        }
        terminal.state =
          reason ??
          (terminal.finalCandidate !== terminal.candidate
            ? 'invalidated'
            : terminal.exitCode === 0
              ? 'passed'
              : 'failed');
        terminal.observedAt = new Date().toISOString();
        terminal.counts = reason || result.outputBytes > 8192 ? null : parseTapCounts(summary);
        try {
          await this.persist(terminal);
        } catch {
          terminal.state = 'interrupted';
        }
        this.results.set(result.runId, terminal);
        this.active.delete(result.runId);
        this.reservations.delete(suite.repository);
        try {
          this.completed(terminal.sessionId, terminal.runId, terminal.observedAt);
        } catch {
          /* Durable result remains available even if the notification consumer is closing. */
        } finally {
          finished();
        }
      })();
    });
  }

  private async persist(result: HostTestResult): Promise<void> {
    const temporary = result.resultPath + '.tmp';
    await writeFile(temporary, JSON.stringify(result) + '\n', { mode: 0o600 });
    await rename(temporary, result.resultPath);
  }

  async cancelSession(sessionId: string): Promise<void> {
    this.sessionGenerations.set(sessionId, (this.sessionGenerations.get(sessionId) ?? 0) + 1);
    await Promise.allSettled(
      [...this.requests.entries()]
        .filter(([key]) => key.startsWith(sessionId + ':'))
        .map(([, pending]) => pending),
    );
    const runs = [...this.active.values()].filter((run) => run.result.sessionId === sessionId);
    for (const run of runs) run.stop('cancelled');
    await Promise.all(runs.map((run) => run.done));
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.requests.values()]);
    const runs = [...this.active.values()];
    for (const run of runs) run.stop('interrupted');
    await Promise.all(runs.map((run) => run.done));
  }
}

/** Unknown/mixed/truncated reporter output is not invented evidence. Exit status is independent. */
export function parseTapCounts(text: string): HostTestResult['counts'] {
  const names = ['tests', 'pass', 'fail', 'skipped'] as const;
  const values = names.map((name) => [
    ...text.matchAll(new RegExp('^# ' + name + ' (\\d+)\\r?$', 'gm')),
  ]);
  if (values.some((matches) => matches.length !== 1)) return null;
  const [total, passed, failed, skipped] = values.map((matches) => Number(matches[0][1]));
  if (
    ![total, passed, failed, skipped].every(Number.isSafeInteger) ||
    passed + failed + skipped !== total
  )
    return null;
  return { total, passed, failed, skipped };
}
