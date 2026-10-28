/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { candidate } from './candidate.js';
import { loadWorkspaceHostTestConfig, type HostTestSuite } from './config.js';
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
  const suite: HostTestSuite = {
    id: 'full',
    repository,
    command: process.execPath,
    args: ['test.cjs'],
    timeoutMs: 5000,
    maxOutputBytes: 65536,
  };
  const config = join(repository, '.gestalt/host-tests.json');
  await mkdir(join(repository, '.gestalt'));
  const configure = async (suites = [suite]) =>
    writeFile(config, JSON.stringify({ version: 1, suites }));
  await configure();
  const digest = await candidate(repository);
  const completed = vi.fn();
  const evidence = join(root, 'evidence');
  const runner = new LocalHostTestRunner(evidence, completed);
  await runner.initialize();
  cleanups.push(() => runner.close());
  const owner = { sessionId: 'session-one', workspace: repository };
  const start = (requestId = randomUUID()) =>
    runner.request(owner, { operation: 'start', suite: 'full', requestId });
  const result = async (id: string) =>
    runner.request(owner, { operation: 'status', runId: id }) as Promise<HostTestResult>;
  const finish = async (id: string) => {
    await vi.waitFor(async () => expect((await result(id)).state).not.toBe('running'), {
      timeout: 8000,
      interval: 25,
    });
    return result(id);
  };
  return {
    root,
    repository,
    suite,
    config,
    configure,
    digest,
    evidence,
    runner,
    owner,
    start,
    finish,
    completed,
  };
}

describe('host-owned tests', () => {
  it('retains an unread completion across restart until its owner reads the result', async () => {
    const f = await fixture();
    const run = (await f.start()) as HostTestResult;
    await vi.waitFor(() => expect(f.completed).toHaveBeenCalledOnce());
    expect(f.runner.hasUnreadResult(f.owner.sessionId)).toBe(true);
    expect(f.runner.hasUnreadResult('another-session')).toBe(false);
    await f.runner.close();
    const restarted = new LocalHostTestRunner(f.evidence);
    await restarted.initialize();
    cleanups.push(() => restarted.close());
    expect(restarted.hasUnreadResult(f.owner.sessionId)).toBe(true);
    await restarted.request(
      { ...f.owner, sessionId: 'another-session' },
      {
        operation: 'status',
        runId: run.runId,
      },
    );
    expect(restarted.hasUnreadResult(f.owner.sessionId)).toBe(true);
    await Promise.all(
      [1, 2].map(() =>
        restarted.request(f.owner, {
          operation: 'status',
          runId: run.runId,
        }),
      ),
    );
    expect(restarted.hasUnreadResult(f.owner.sessionId)).toBe(false);
    const recovered = new LocalHostTestRunner(f.evidence);
    await recovered.initialize();
    cleanups.push(() => recovered.close());
    expect(recovered.hasUnreadResult(f.owner.sessionId)).toBe(false);
  });
  it('preserves active-run ownership and cancellation while runtime suites change', async () => {
    const f = await fixture('setInterval(()=>{},1000)');
    const run = (await f.start()) as HostTestResult;
    await f.configure([{ ...f.suite, id: 'renamed' }]);
    expect(
      await f.runner.request(f.owner, {
        operation: 'start',
        suite: 'renamed',
        requestId: randomUUID(),
      }),
    ).toEqual({ error: 'repositoryBusy' });
    await writeFile(f.config, '{');
    expect(
      await f.runner.request(f.owner, { operation: 'status', runId: run.runId }),
    ).toMatchObject({ state: 'running' });
    await f.runner.request(f.owner, { operation: 'cancel', runId: run.runId });
    expect((await f.finish(run.runId)).state).toBe('cancelled');
    await f.configure([{ ...f.suite, args: ['-e', 'process.exit(0)'] }]);
    const next = (await f.start()) as HostTestResult;
    expect((await f.finish(next.runId)).state).toBe('passed');
  });
  it('loads runtime workspace suites without digest approval and retains evidence across reload and restart', async () => {
    const f = await fixture();
    await rm(f.config);
    expect(await f.runner.request(f.owner, { operation: 'list' })).toEqual({ suites: [] });
    const path = join(f.repository, '.gestalt/host-tests.json');
    const suite = f.suite;
    await writeFile(path, JSON.stringify({ version: 1, suites: [suite] }));
    expect(await f.runner.request(f.owner, { operation: 'inspect', suite: 'full' })).toMatchObject({
      repository: f.repository,
    });
    const request = { operation: 'start' as const, suite: 'full', requestId: randomUUID() };
    const [run, duplicate] = (await Promise.all([
      f.runner.request(f.owner, request),
      f.runner.request(f.owner, request),
    ])) as HostTestResult[];
    expect(duplicate.runId).toBe(run.runId);
    const result = await f.finish(run.runId);
    expect(result).toMatchObject({ state: 'passed', candidate: await candidate(f.repository) });
    expect(result.finalCandidate).toBe(result.candidate);
    expect(
      JSON.parse(await readFile(join(f.evidence, run.runId, 'invocation.json'), 'utf8')),
    ).toMatchObject({ repository: f.repository, args: ['test.cjs'] });
    await writeFile(
      path,
      JSON.stringify({ version: 1, suites: [{ ...suite, args: ['-e', 'process.exit(7)'] }] }),
    );
    expect(await f.runner.request(f.owner, request)).toMatchObject({ runId: run.runId });
    const second = (await f.runner.request(f.owner, {
      ...request,
      requestId: randomUUID(),
    })) as HostTestResult;
    expect(await f.finish(second.runId)).toMatchObject({ state: 'failed', exitCode: 7 });
    await rm(path);
    expect(await f.runner.request(f.owner, { operation: 'list' })).toEqual({ suites: [] });
    await f.runner.close();
    const next = new LocalHostTestRunner(f.evidence);
    await next.initialize();
    cleanups.push(() => next.close());
    expect(await next.request(f.owner, request)).toMatchObject({
      runId: run.runId,
      state: 'passed',
    });
    expect(await next.request(f.owner, { ...request, suite: 'other' })).toEqual({
      error: 'requestIdConflict',
    });
  });

  it('fails closed on malformed runtime configuration, outside repositories and escaping config links', async () => {
    const f = await fixture();
    const path = join(f.repository, '.gestalt/host-tests.json');
    await writeFile(path, '{');
    await expect(loadWorkspaceHostTestConfig(f.repository)).rejects.toThrow();
    await writeFile(
      path,
      JSON.stringify({ version: 1, suites: [{ ...f.suite, repository: f.root }] }),
    );
    await expect(loadWorkspaceHostTestConfig(f.repository)).rejects.toThrow('outside');
    await rm(path);
    const outside = join(f.root, 'outside.json');
    await writeFile(outside, JSON.stringify({ version: 1, suites: [] }));
    await symlink(outside, path);
    await expect(loadWorkspaceHostTestConfig(f.repository)).rejects.toThrow('within');
  });
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

  it('runs changed candidates without reauthorization and rejects unconfigured suites', async () => {
    const f = await fixture();
    await writeFile(join(f.repository, 'untracked'), 'new input');
    const run = (await f.start()) as HostTestResult;
    expect(run.candidate).not.toBe(f.digest);
    expect((await f.finish(run.runId)).state).toBe('passed');
    await f.configure([]);
    expect(await f.start()).toEqual({ error: 'suiteUnavailable' });
  });

  it('deduplicates concurrent starts and rejects request ID reuse for another suite', async () => {
    const f = await fixture('setTimeout(()=>{},150)');
    const id = randomUUID();
    const [a, b] = (await Promise.all([f.start(id), f.start(id)])) as HostTestResult[];
    expect(a.runId).toBe(b.runId);
    await f.finish(a.runId);
    expect(f.completed).toHaveBeenCalledTimes(1);
    expect(
      await f.runner.request(f.owner, {
        operation: 'start',
        suite: 'other',
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
    await slow.configure();
    expect((await slow.finish(((await slow.start()) as HostTestResult).runId)).state).toBe(
      'timedOut',
    );
    const loud = await fixture("process.stdout.write('x'.repeat(100000));setInterval(()=>{},1000)");
    loud.suite.maxOutputBytes = 1024;
    await loud.configure();
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
    const next = new LocalHostTestRunner(f.evidence);
    await next.initialize();
    cleanups.push(() => next.close());
    expect(
      await next.request(f.owner, {
        operation: 'start',
        suite: 'full',
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
    const next = new LocalHostTestRunner(f.evidence);
    await next.initialize();
    cleanups.push(() => next.close());
    expect(await next.request(f.owner, { operation: 'status', runId: run.runId })).toMatchObject({
      state: 'interrupted',
      counts: null,
    });
  });
});

it('keeps evidence outside the session workspace even when the browsing root contains it', async () => {
  const f = await fixture();
  expect(await f.runner.request({ ...f.owner, workspace: f.root }, { operation: 'list' })).toEqual({
    error: 'evidenceInsideWorkspace',
  });
  expect(await f.runner.request(f.owner, { operation: 'list' })).toMatchObject({
    suites: [{ id: 'full' }],
  });
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
