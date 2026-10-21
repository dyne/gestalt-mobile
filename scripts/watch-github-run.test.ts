/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import { watchGithubRun } from './watch-github-run.mjs';

const candidate = 'a'.repeat(40);
const identity = { repository: 'dyne/gestalt-mobile', runId: '123', attempt: 2, candidate };
const observation = (status = 'in_progress', conclusion: string | null = null) => ({
  databaseId: 123,
  attempt: 2,
  headSha: candidate,
  status,
  conclusion,
  updatedAt: '2026-10-21T08:00:00Z',
  jobs: [],
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gestalt-watcher-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const evidenceDirectory = join(root, 'evidence');
  const write = vi.fn();
  const wait = vi.fn(async () => {});
  const options = {
    ...identity,
    evidenceDirectory,
    write,
    wait,
    now: () => '2026-10-21T09:00:00Z',
  };
  return {
    root,
    evidenceDirectory,
    write,
    wait,
    options,
    summary: async () =>
      JSON.parse(await readFile(join(evidenceDirectory, 'summary.json'), 'utf8')),
    events: async () =>
      (await readFile(join(evidenceDirectory, 'events.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
  };
}

it('reproduces one meaningful state sequence from many timestamp-only polls', async () => {
  const f = await fixture();
  const read = vi.fn();
  read.mockResolvedValueOnce(observation('queued'));
  for (let index = 0; index < 100; index += 1)
    read.mockResolvedValueOnce({
      ...observation(),
      updatedAt: new Date(Date.parse('2026-10-21T08:00:00Z') + index * 1000).toISOString(),
      stdout: 'private canary',
    });
  read.mockResolvedValueOnce(observation('completed', 'success'));
  expect(await watchGithubRun({ ...f.options, read })).toBe(0);
  expect(read).toHaveBeenCalledTimes(102);
  expect(f.wait).toHaveBeenCalledTimes(101);
  const records = f.write.mock.calls.map(([record]) => record);
  expect(records.map((record) => record.event)).toEqual([
    'githubRunObserved',
    'githubRunObserved',
    'githubRunObserved',
    'githubRunFinished',
  ]);
  expect(records[0]).toMatchObject({
    ...identity,
    observedAt: '2026-10-21T09:00:00.000Z',
    upstreamUpdatedAt: '2026-10-21T08:00:00.000Z',
    status: 'queued',
  });
  expect(JSON.stringify(records)).not.toContain('private canary');
  const summary = await f.summary();
  expect(summary).toMatchObject({
    reason: 'completed',
    exitCode: 0,
    completeness: 'complete',
    counts: { polls: 102, changes: 3, readFailures: 0, failures: 0, jobs: 0 },
    processExitedAt: null,
  });
  const journal = await readFile(join(f.evidenceDirectory, 'events.jsonl'));
  expect(summary.evidence).toMatchObject({
    bytes: journal.byteLength,
    sha256: createHash('sha256').update(journal).digest('hex'),
  });
  for (const record of records)
    expect(Buffer.byteLength(JSON.stringify(record))).toBeLessThanOrEqual(2048);
});

it.each(['failure', 'cancelled', 'timed_out', 'action_required', 'neutral', 'skipped', 'unknown'])(
  'retains a non-success conclusion %s',
  async (conclusion) => {
    const f = await fixture();
    expect(
      await watchGithubRun({
        ...f.options,
        read: async () => observation('completed', conclusion),
      }),
    ).toBe(1);
    expect(await f.summary()).toMatchObject({
      exitCode: 1,
      completeness: conclusion === 'unknown' ? 'partial' : 'complete',
    });
  },
);

it('keeps every failing job/step retrievable while its routine summary stays bounded', async () => {
  const f = await fixture();
  const jobs = Array.from({ length: 100 }, (_, index) => ({
    databaseId: 1000 + index,
    name: 'private job name',
    status: 'completed',
    conclusion: 'failure',
    steps: [
      { number: 2, conclusion: 'failure', name: 'private step' },
      { number: 5, conclusion: 'failure' },
    ],
  }));
  expect(
    await watchGithubRun({
      ...f.options,
      read: async () => ({ ...observation('completed', 'failure'), jobs }),
    }),
  ).toBe(1);
  const events = await f.events();
  const failures = events.filter((event) => event.event === 'githubJobFailed');
  expect(failures).toHaveLength(200);
  expect(failures.at(-1)).toMatchObject({ jobId: '1099', stepNumber: 5, conclusion: 'failure' });
  expect(JSON.stringify(events)).not.toContain('private');
  const summary = await f.summary();
  expect(summary).toMatchObject({
    counts: { failures: 200, jobs: 100 },
    firstFailure: { jobId: '1000', stepNumber: 2 },
  });
  expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThanOrEqual(2048);
  expect(f.write).toHaveBeenCalledTimes(2);
});

it.each([
  { jobs: undefined },
  { jobs: [{ status: 'completed', conclusion: 'failure' }] },
  { conclusion: 'new-conclusion' },
])('preserves incomplete terminal evidence as partial', async (change) => {
  const f = await fixture();
  expect(
    await watchGithubRun({
      ...f.options,
      read: async () => ({ ...observation('completed', 'success'), ...change }),
    }),
  ).toBe(1);
  expect(await f.summary()).toMatchObject({ completeness: 'partial' });
});

it.each([{ databaseId: 124 }, { attempt: 3 }, { headSha: 'b'.repeat(40) }, { attempt: undefined }])(
  'never accepts another run, replaced attempt, candidate or absent identity %j',
  async (change) => {
    const f = await fixture();
    expect(
      await watchGithubRun({
        ...f.options,
        read: async () => ({ ...observation('completed', 'success'), ...change }),
      }),
    ).toBe(1);
    expect(await f.summary()).toMatchObject({
      reason: 'identityMismatch',
      completeness: 'partial',
    });
    expect(f.wait).not.toHaveBeenCalled();
  },
);

it('returns an explicit unknown status instead of polling indefinitely', async () => {
  const f = await fixture();
  expect(await watchGithubRun({ ...f.options, read: async () => observation('new_status') })).toBe(
    1,
  );
  expect(await f.summary()).toMatchObject({ reason: 'unknownStatus', completeness: 'partial' });
});

it.each(['ECONNRESET', 'HTTP 429 rate limit exceeded'])(
  'retries %s in the same watcher without exposing diagnostics',
  async (diagnostic) => {
    const f = await fixture();
    const read = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('private token'), { stderr: diagnostic + ' private token' }),
      )
      .mockResolvedValueOnce(observation('completed', 'success'));
    expect(await watchGithubRun({ ...f.options, read })).toBe(0);
    expect(read).toHaveBeenCalledTimes(2);
    expect(f.wait).toHaveBeenCalledWith(30_000);
    expect(await f.summary()).toMatchObject({ counts: { readFailures: 1 } });
    expect(JSON.stringify(await f.events())).not.toContain('private token');
  },
);

it('exhausts bounded retries and retains every failed read', async () => {
  const f = await fixture();
  const read = vi.fn().mockRejectedValue({ code: 'ETIMEDOUT' });
  expect(await watchGithubRun({ ...f.options, read, maxRetries: 2 })).toBe(1);
  expect(read).toHaveBeenCalledTimes(3);
  expect(f.wait.mock.calls).toEqual([[30_000], [60_000]]);
  expect(
    (await f.events()).filter((event) => event.event === 'githubRunObservationFailed'),
  ).toHaveLength(3);
  expect(await f.summary()).toMatchObject({ reason: 'observationFailed', completeness: 'partial' });
});

it('does not retry authentication failures', async () => {
  const f = await fixture();
  expect(
    await watchGithubRun({
      ...f.options,
      read: async () => {
        throw Object.assign(new Error('private'), { stderr: 'HTTP 401 unauthorized private' });
      },
    }),
  ).toBe(1);
  expect(f.wait).not.toHaveBeenCalled();
  expect(JSON.stringify(await f.events())).not.toContain('private');
});

it('discards a late successful read after cancellation', async () => {
  const f = await fixture();
  const controller = new AbortController();
  const read = async () => {
    controller.abort();
    return observation('completed', 'success');
  };
  expect(await watchGithubRun({ ...f.options, signal: controller.signal, read })).toBe(130);
  expect(await f.summary()).toMatchObject({
    reason: 'cancelled',
    exitCode: 130,
    completeness: 'partial',
  });
  expect(f.write).toHaveBeenCalledTimes(1);
});

it('does not launch a second poller or overwrite the same evidence directory', async () => {
  const f = await fixture();
  const read = vi.fn().mockResolvedValue(observation('completed', 'success'));
  expect(await watchGithubRun({ ...f.options, read })).toBe(0);
  const first = await readFile(join(f.evidenceDirectory, 'summary.json'));
  expect(await watchGithubRun({ ...f.options, read })).toBe(1);
  expect(read).toHaveBeenCalledOnce();
  expect(await readFile(join(f.evidenceDirectory, 'summary.json'))).toEqual(first);
});

it('reports evidence storage failure without certifying success', async () => {
  const f = await fixture();
  await writeFile(f.evidenceDirectory, 'occupied');
  const read = vi.fn();
  expect(await watchGithubRun({ ...f.options, read })).toBe(1);
  expect(read).not.toHaveBeenCalled();
  expect(f.write).toHaveBeenCalledWith(
    expect.objectContaining({ event: 'githubRunEvidenceFailed' }),
  );
});

it('cannot report complete success when terminal evidence storage disappears', async () => {
  const f = await fixture();
  expect(
    await watchGithubRun({
      ...f.options,
      read: async () => {
        await rm(f.evidenceDirectory, { recursive: true });
        return observation('completed', 'success');
      },
    }),
  ).toBe(1);
  expect(f.write).toHaveBeenLastCalledWith(
    expect.objectContaining({ event: 'githubRunEvidenceFailed', reason: 'evidenceIncomplete' }),
  );
});

it.each([
  { attempt: 0 },
  { candidate: 'abbreviated' },
  { runId: 'not-a-run' },
  { evidenceDirectory: undefined },
])('rejects incomplete process identity before polling %j', async (change) => {
  const f = await fixture();
  const read = vi.fn();
  await expect(watchGithubRun({ ...f.options, ...change, read })).rejects.toThrow(
    'Expected OWNER/REPO',
  );
  expect(read).not.toHaveBeenCalled();
});

it('runs the production gh adapter against fake gh with explicit identity fields', async () => {
  const f = await fixture();
  const gh = join(f.root, 'gh');
  const calls = join(f.root, 'calls.json');
  await writeFile(
    gh,
    `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2)));console.log(${JSON.stringify(JSON.stringify(observation('completed', 'success')))});`,
    { mode: 0o700 },
  );
  expect(await watchGithubRun({ ...f.options, gh })).toBe(0);
  expect(JSON.parse(await readFile(calls, 'utf8'))).toEqual([
    'run',
    'view',
    '123',
    '--repo',
    identity.repository,
    '--json',
    'databaseId,attempt,headSha,status,conclusion,updatedAt,jobs',
  ]);
});

it.each(['HTTP 429 rate limit exceeded', 'HTTP 503 service unavailable'])(
  'retries fake gh %s without starting another watcher',
  async (diagnostic) => {
    const f = await fixture();
    const gh = join(f.root, 'gh');
    const attempts = join(f.root, 'attempts');
    await writeFile(
      gh,
      `#!${process.execPath}\nconst fs=require('fs');if(!fs.existsSync(${JSON.stringify(attempts)})){fs.writeFileSync(${JSON.stringify(attempts)},'1');process.stderr.write(${JSON.stringify(diagnostic + ' private-token')});process.exit(1)}fs.writeFileSync(${JSON.stringify(attempts)},'2');console.log(${JSON.stringify(JSON.stringify(observation('completed', 'success')))});`,
      { mode: 0o700 },
    );
    expect(await watchGithubRun({ ...f.options, gh })).toBe(0);
    expect(await readFile(attempts, 'utf8')).toBe('2');
    expect(await f.summary()).toMatchObject({ counts: { polls: 2, readFailures: 1 } });
    expect(JSON.stringify(await f.events())).not.toContain('private-token');
  },
);

it('cancels a pending polling delay without another read', async () => {
  const f = await fixture();
  const controller = new AbortController();
  const read = vi.fn().mockResolvedValue(observation());
  const running = watchGithubRun({
    ...f.options,
    read,
    wait: undefined,
    signal: controller.signal,
  });
  await vi.waitFor(() => expect(f.write).toHaveBeenCalledOnce());
  controller.abort();
  expect(await running).toBe(130);
  expect(read).toHaveBeenCalledOnce();
  expect(await f.summary()).toMatchObject({ reason: 'cancelled', exitCode: 130 });
});

it('cancels the owned gh child and leaves durable evidence using the same process handle', async () => {
  const f = await fixture();
  const gh = join(f.root, 'gh');
  const ready = join(f.root, 'ready');
  const stopped = join(f.root, 'stopped');
  await writeFile(
    gh,
    `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));process.on('SIGTERM',()=>{require('fs').writeFileSync(${JSON.stringify(stopped)},'stopped');process.exit(0)});setInterval(()=>{},1000);`,
    { mode: 0o700 },
  );
  const controller = new AbortController();
  const running = watchGithubRun({ ...f.options, gh, signal: controller.signal });
  await vi.waitFor(async () => expect(await readFile(ready, 'utf8')).toMatch(/^\d+$/));
  controller.abort();
  expect(await running).toBe(130);
  await vi.waitFor(async () => expect(await readFile(stopped, 'utf8')).toBe('stopped'));
  expect(await f.summary()).toMatchObject({ reason: 'cancelled', exitCode: 130 });
});

it('handles SIGTERM in the actual CLI process and cleans up its fake gh child', async () => {
  const f = await fixture();
  const gh = join(f.root, 'gh');
  const ready = join(f.root, 'ready');
  const stopped = join(f.root, 'stopped');
  await writeFile(
    gh,
    `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(ready)},'ready');process.on('SIGTERM',()=>{require('fs').writeFileSync(${JSON.stringify(stopped)},'stopped');process.exit(0)});setInterval(()=>{},1000);`,
    { mode: 0o700 },
  );
  const child = spawn(
    process.execPath,
    [
      resolve('scripts/watch-github-run.mjs'),
      identity.repository,
      identity.runId,
      String(identity.attempt),
      candidate,
      f.evidenceDirectory,
    ],
    { env: { ...process.env, PATH: `${f.root}:${process.env.PATH}` }, stdio: 'ignore' },
  );
  onTestFinished(() => {
    child.kill('SIGTERM');
  });
  const closed = new Promise((resolve) => child.once('close', (code) => resolve(code)));
  await vi.waitFor(async () => expect(await readFile(ready, 'utf8')).toBe('ready'));
  child.kill('SIGTERM');
  expect(await closed).toBe(130);
  expect(await readFile(stopped, 'utf8')).toBe('stopped');
  expect(await f.summary()).toMatchObject({ reason: 'cancelled', exitCode: 130 });
});

it('reaps a fake gh child that ignores cancellation before resolving the owned watcher', async () => {
  const f = await fixture();
  const gh = join(f.root, 'gh');
  const ready = join(f.root, 'ready');
  await writeFile(
    gh,
    `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`,
    { mode: 0o700 },
  );
  const controller = new AbortController();
  const running = watchGithubRun({ ...f.options, gh, signal: controller.signal });
  await vi.waitFor(async () => expect(await readFile(ready, 'utf8')).toMatch(/^\d+$/));
  const pid = Number(await readFile(ready, 'utf8'));
  controller.abort();
  expect(await running).toBe(130);
  expect(() => process.kill(pid, 0)).toThrow();
  expect(await f.summary()).toMatchObject({ reason: 'cancelled', exitCode: 130 });
});
