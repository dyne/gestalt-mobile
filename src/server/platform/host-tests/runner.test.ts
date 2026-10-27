/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { candidate } from './candidate.js';
import { loadHostTestConfig, type HostTestSuite } from './config.js';
import { LocalHostTestRunner, parseTapCounts } from './runner.js';
import type { HostTestResult } from '../../../shared/contracts/host-tests.js';
const exec = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
  vi.unstubAllEnvs();
});

async function fixture(source = "console.log('# tests 1\\n# pass 1\\n# fail 0\\n# skipped 0')") {
  const root = await mkdtemp(join(tmpdir(), 'host-tests-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, 'repo');
  await mkdir(repository);
  await writeFile(join(repository, 'test.cjs'), source);
  await exec('git', ['init', '-q', repository]);
  await exec('git', ['add', '.'], { cwd: repository });
  await exec(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'fixture',
    ],
    { cwd: repository },
  );
  const digest = await candidate(repository);
  const suite: HostTestSuite = {
    id: 'full',
    repository,
    command: process.execPath,
    args: ['test.cjs'],
    candidate: digest,
    timeoutMs: 5000,
    maxOutputBytes: 65536,
  };
  const completed = vi.fn();
  const evidence = join(root, 'evidence');
  const runner = new LocalHostTestRunner([suite], evidence, completed);
  await runner.initialize();
  cleanups.push(() => runner.close());
  const owner = { sessionId: 'session-one', workspace: repository };
  const start = (requestId = randomUUID()) =>
    runner.request(owner, { operation: 'start', suite: 'full', candidate: digest, requestId });
  const result = async (id: string) =>
    runner.request(owner, { operation: 'status', runId: id }) as Promise<HostTestResult>;
  const finish = async (id: string) => {
    await vi.waitFor(async () => expect((await result(id)).state).not.toBe('running'), {
      timeout: 8000,
      interval: 25,
    });
    return result(id);
  };
  return { root, repository, suite, digest, evidence, runner, owner, start, finish, completed };
}

describe('host-owned tests', () => {
  it('settles a session shutdown racing a start and rejects all new work during host shutdown', async () => {
    const f = await fixture('setInterval(()=>{},1000)');
    const starting = f.start();
    await f.runner.cancelSession(f.owner.sessionId);
    const run = (await starting) as HostTestResult;
    if (run.runId) expect((await f.finish(run.runId)).state).toBe('cancelled');
    await f.runner.close();
    expect(await f.start()).toEqual({ error: 'hostShuttingDown' });
  });
  it('runs the exact configured argv, saves private evidence and reports UTC exit observation', async () => {
    const f = await fixture();
    const run = (await f.start()) as HostTestResult;
    const result = await f.finish(run.runId);
    expect(result).toMatchObject({
      state: 'passed',
      exitCode: 0,
      candidate: f.digest,
      finalCandidate: f.digest,
      counts: { total: 1, passed: 1, failed: 0, skipped: 0 },
    });
    expect(result.startedAt).toMatch(/Z$/);
    expect(result.processExitedAt).toMatch(/Z$/);
    expect(Date.parse(result.observedAt)).toBeGreaterThanOrEqual(
      Date.parse(result.processExitedAt!),
    );
    expect(result.outputSha256).toMatch(/^[a-f0-9]{64}$/);
    expect((await stat(result.logPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(result.resultPath, 'utf8'))).toEqual(result);
    expect(f.completed).toHaveBeenCalledWith(f.owner.sessionId, run.runId, result.observedAt);
  });

  it('fails closed on unauthorized and changed candidates without starting a process', async () => {
    const f = await fixture();
    f.suite.candidate = null;
    expect(await f.start()).toEqual({ error: 'candidateNotAuthorized' });
    f.suite.candidate = f.digest;
    await writeFile(join(f.repository, 'untracked'), 'new input');
    expect(await f.start()).toEqual({ error: 'candidateChanged' });
    expect(f.completed).not.toHaveBeenCalled();
    expect(await f.runner.request(f.owner, { operation: 'inspect', suite: 'full' })).toMatchObject({
      authorized: false,
    });
  });

  it('deduplicates concurrent starts and rejects request ID reuse for another candidate', async () => {
    const f = await fixture('setTimeout(()=>{},150)');
    const id = randomUUID();
    const [a, b] = (await Promise.all([f.start(id), f.start(id)])) as HostTestResult[];
    expect(a.runId).toBe(b.runId);
    await f.finish(a.runId);
    expect(f.completed).toHaveBeenCalledTimes(1);
    expect(
      await f.runner.request(f.owner, {
        operation: 'start',
        suite: 'full',
        candidate: '0'.repeat(64),
        requestId: id,
      }),
    ).toEqual({ error: 'requestIdConflict' });
  });

  it('denies cross-session reads, cancellation and outside-workspace suites', async () => {
    const f = await fixture('setInterval(()=>{},1000)');
    const run = (await f.start()) as HostTestResult;
    for (const operation of ['status', 'cancel'] as const)
      expect(
        await f.runner.request({ ...f.owner, sessionId: 'other' }, { operation, runId: run.runId }),
      ).toEqual({ error: 'runNotFound' });
    const other = join(f.root, 'other');
    await mkdir(other);
    expect(await f.runner.request({ ...f.owner, workspace: other }, { operation: 'list' })).toEqual(
      { suites: [] },
    );
    expect(await f.start()).toEqual({ error: 'repositoryBusy' });
    await f.runner.request(f.owner, { operation: 'cancel', runId: run.runId });
    expect((await f.finish(run.runId)).state).toBe('cancelled');
  });

  it('bounds runtime and output, and preserves nonzero exit', async () => {
    const slow = await fixture('setInterval(()=>{},1000)');
    slow.suite.timeoutMs = 100;
    expect((await slow.finish(((await slow.start()) as HostTestResult).runId)).state).toBe(
      'timedOut',
    );
    const loud = await fixture("process.stdout.write('x'.repeat(100000));setInterval(()=>{},1000)");
    loud.suite.maxOutputBytes = 1024;
    const result = await loud.finish(((await loud.start()) as HostTestResult).runId);
    expect(result.state).toBe('outputLimit');
    expect(result.outputBytes).toBe(1024);
    expect(result.counts).toBeNull();
    const failure = await fixture('process.exit(7)');
    expect(await failure.finish(((await failure.start()) as HostTestResult).runId)).toMatchObject({
      state: 'failed',
      exitCode: 7,
    });
  });

  it('invalidates success when the test changes Git-visible inputs', async () => {
    const f = await fixture("require('node:fs').writeFileSync('changed','input')");
    expect(await f.finish(((await f.start()) as HostTestResult).runId)).toMatchObject({
      state: 'invalidated',
      exitCode: 0,
    });
  });

  it('does not forward provider credentials or NODE_OPTIONS', async () => {
    const f = await fixture(
      'if(process.env.OPENAI_API_KEY||process.env.NODE_OPTIONS)process.exit(9)',
    );
    vi.stubEnv('OPENAI_API_KEY', 'fixture-secret');
    vi.stubEnv('NODE_OPTIONS', '--trace-warnings');
    expect((await f.finish(((await f.start()) as HostTestResult).runId)).state).toBe('passed');
  });

  it('retains results and idempotency after restart, without rerunning tests', async () => {
    const f = await fixture();
    const id = randomUUID();
    const run = (await f.start(id)) as HostTestResult;
    await f.finish(run.runId);
    await f.runner.close();
    const next = new LocalHostTestRunner([f.suite], f.evidence);
    await next.initialize();
    cleanups.push(() => next.close());
    expect(
      await next.request(f.owner, {
        operation: 'start',
        suite: 'full',
        candidate: f.digest,
        requestId: id,
      }),
    ).toMatchObject({ runId: run.runId, state: 'passed' });
  });

  it('cancels owned descendants on shutdown even after the test leader exits', async () => {
    const f = await fixture(
      "const p=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(p.pid);p.unref()",
    );
    const run = (await f.start()) as HostTestResult;
    const result = await f.finish(run.runId);
    const pid = Number((await readFile(result.logPath, 'utf8')).trim());
    expect(pid).toBeGreaterThan(1);
    await vi.waitFor(async () => {
      const info = await readFile('/proc/' + pid + '/stat', 'utf8').catch(() => 'gone');
      expect(info === 'gone' || info.split(') ')[1]?.startsWith('Z ')).toBe(true);
    });
  });

  it('marks abandoned running records interrupted on restart without signaling stale PIDs', async () => {
    const f = await fixture();
    const run = (await f.start()) as HostTestResult;
    const result = await f.finish(run.runId);
    await f.runner.close();
    await writeFile(result.resultPath, JSON.stringify({ ...result, state: 'running' }));
    const next = new LocalHostTestRunner([f.suite], f.evidence);
    await next.initialize();
    cleanups.push(() => next.close());
    expect(await next.request(f.owner, { operation: 'status', runId: run.runId })).toMatchObject({
      state: 'interrupted',
      counts: null,
    });
  });
});

it('requires private operator configuration outside the workspace', async () => {
  const f = await fixture();
  const config = join(f.root, 'config.json');
  const body = JSON.stringify({ version: 1, suites: [f.suite] });
  await writeFile(config, body, { mode: 0o600 });
  expect(await loadHostTestConfig(config, f.repository)).toHaveLength(1);
  await chmod(config, 0o644);
  await expect(loadHostTestConfig(config, f.repository)).rejects.toThrow('private');
  const inside = join(f.repository, 'runner.json');
  await writeFile(inside, body, { mode: 0o600 });
  await expect(loadHostTestConfig(inside, f.repository)).rejects.toThrow('outside');
});

it('fingerprints untracked inputs, rejects symlink ancestor escapes, and keeps unknown reporters unknown', async () => {
  const f = await fixture();
  await mkdir(join(f.repository, 'dir'));
  await writeFile(join(f.repository, 'dir', 'input'), 'x');
  await exec('git', ['add', '.'], { cwd: f.repository });
  await rm(join(f.repository, 'dir'), { recursive: true });
  await symlink(f.root, join(f.repository, 'dir'));
  await expect(candidate(f.repository)).rejects.toThrow('escapes');
  expect(parseTapCounts('# tests 2\n# pass 1\n# fail 0\n# skipped 0')).toBeNull();
  expect(parseTapCounts('Tests 4 passed')).toBeNull();
});
