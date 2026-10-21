/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const execute = promisify(execFile);
const statuses = ['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending'];
const conclusions = [
  'success',
  'failure',
  'cancelled',
  'timed_out',
  'action_required',
  'neutral',
  'skipped',
  'stale',
  'startup_failure',
];
const passing = ['success', 'neutral', 'skipped'];
const iso = (value) =>
  typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
const positive = (value) => Number.isSafeInteger(value) && value > 0;

/** One owner, one expected attempt. Only structural facts reach stdout or evidence. */
export async function watchGithubRun({
  repository,
  runId,
  attempt,
  candidate,
  evidenceDirectory,
  signal,
  gh = 'gh',
  pollIntervalMs = 30_000,
  maxRetries = 3,
  read = async () => {
    const timeout = AbortSignal.timeout(60_000);
    const commandSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const command = execute(
      gh,
      [
        'run',
        'view',
        runId,
        '--repo',
        repository,
        '--json',
        'databaseId,attempt,headSha,status,conclusion,updatedAt,jobs',
      ],
      { maxBuffer: 4 * 1024 * 1024, signal: commandSignal },
    );
    const closed = new Promise((resolve) => command.child.once('close', resolve));
    try {
      const { stdout } = await command;
      return JSON.parse(stdout);
    } catch (error) {
      if (commandSignal.aborted) {
        // Abort rejects before the child necessarily exits. Reap the same
        // owned child, escalating only if it ignores the initial SIGTERM.
        const force = setTimeout(() => command.child.kill('SIGKILL'), 1_000);
        try {
          await closed;
        } finally {
          clearTimeout(force);
        }
        if (timeout.aborted && !signal?.aborted) error.code = 'ETIMEDOUT';
      }
      throw error;
    }
  },
  wait = (ms) => sleep(ms, undefined, { signal }),
  now = () => new Date().toISOString(),
  write = (record) => process.stdout.write(`${JSON.stringify(record)}\n`),
}) {
  if (
    typeof repository !== 'string' ||
    repository.length > 200 ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    typeof runId !== 'string' ||
    !/^[1-9]\d{0,19}$/.test(runId) ||
    !positive(attempt) ||
    typeof candidate !== 'string' ||
    !/^[a-f0-9]{40}$/i.test(candidate) ||
    typeof evidenceDirectory !== 'string' ||
    !evidenceDirectory ||
    Buffer.byteLength(evidenceDirectory) > 512 ||
    Buffer.byteLength(JSON.stringify(evidenceDirectory)) > 600 ||
    !positive(pollIntervalMs) ||
    pollIntervalMs > 300_000 ||
    !Number.isInteger(maxRetries) ||
    maxRetries < 0 ||
    maxRetries > 5
  ) {
    throw new Error('Expected OWNER/REPO RUN_ID ATTEMPT COMMIT_SHA NEW_EVIDENCE_DIRECTORY');
  }
  const identity = { repository, runId, attempt, candidate: candidate.toLowerCase() };
  let journal;
  let bytes = 0;
  const hash = createHash('sha256');
  const counts = { polls: 0, changes: 0, readFailures: 0, failures: 0, jobs: null };
  let firstFailure = null;
  let lastObservation = null;
  let completeness = 'partial';
  const emit = async (event, fields = {}, visible = true) => {
    const record = { event, observedAt: iso(now()), ...identity, ...fields };
    const line = `${JSON.stringify(record)}\n`;
    await journal.writeFile(line);
    hash.update(line);
    bytes += Buffer.byteLength(line);
    if (visible) write(record);
  };
  const finish = async (reason, exitCode) => {
    if (signal?.aborted) {
      reason = 'cancelled';
      exitCode = 130;
      completeness = 'partial';
    }
    const summary = {
      event: 'githubRunFinished',
      observedAt: iso(now()),
      ...identity,
      reason,
      exitCode,
      // This observation precedes process exit; it is not the exit timestamp.
      processExitedAt: null,
      completeness,
      coverage: 'workflow-status-and-failure-identities',
      testCounts: null,
      counts,
      firstFailure,
      upstreamUpdatedAt: lastObservation?.upstreamUpdatedAt ?? null,
      status: lastObservation?.status ?? null,
      conclusion: lastObservation?.conclusion ?? null,
      evidence: {
        directory: evidenceDirectory,
        file: 'events.jsonl',
        bytes,
        sha256: hash.copy().digest('hex'),
      },
    };
    await journal.sync();
    await writeFile(join(evidenceDirectory, 'summary.json'), `${JSON.stringify(summary)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    write(summary);
    return exitCode;
  };
  try {
    await mkdir(dirname(evidenceDirectory), { recursive: true });
    // An existing evidence directory belongs to an earlier/active owner. Never
    // overwrite it or launch another poller on the same process evidence handle.
    await mkdir(evidenceDirectory, { mode: 0o700 });
    journal = await open(join(evidenceDirectory, 'events.jsonl'), 'wx', 0o600);
  } catch {
    write({
      event: 'githubRunEvidenceFailed',
      observedAt: iso(now()),
      ...identity,
      reason: 'evidenceUnavailable',
    });
    return 1;
  }
  try {
    let previous = null;
    let retries = 0;
    for (;;) {
      if (signal?.aborted) return await finish('cancelled', 130);
      let run;
      try {
        counts.polls += 1;
        run = await read();
      } catch (error) {
        if (signal?.aborted) return await finish('cancelled', 130);
        // Classify only; command diagnostics may contain credentials or output.
        const diagnostic = String(error?.stderr ?? error?.code ?? '');
        const rateLimited = /rate limit|HTTP 429/i.test(diagnostic);
        const transient =
          rateLimited ||
          /HTTP 5\d\d|ECONN|ETIMEDOUT|ENET|EAI_AGAIN|TLS handshake|could not resolve|connection|timeout/i.test(
            diagnostic,
          ) ||
          error?.killed === true;
        counts.readFailures += 1;
        await emit('githubRunObservationFailed', {
          reason: rateLimited ? 'rateLimited' : transient ? 'network' : 'readFailed',
          retry: transient && retries < maxRetries,
        });
        if (!transient || retries >= maxRetries) return await finish('observationFailed', 1);
        await wait(Math.min(120_000, pollIntervalMs * 2 ** retries++));
        continue;
      }
      // A response after cancellation must not certify late success.
      if (signal?.aborted) return await finish('cancelled', 130);
      retries = 0;
      if (
        !run ||
        String(run.databaseId) !== runId ||
        run.attempt !== attempt ||
        typeof run.headSha !== 'string' ||
        run.headSha.toLowerCase() !== identity.candidate
      ) {
        await emit('githubRunIdentityChanged', { reason: 'identityMismatch' });
        return await finish('identityMismatch', 1);
      }
      if (!statuses.includes(run.status)) {
        await emit('githubRunObservationFailed', { reason: 'unknownStatus', retry: false });
        return await finish('unknownStatus', 1);
      }
      const conclusion = conclusions.includes(run.conclusion) ? run.conclusion : null;
      lastObservation = { status: run.status, conclusion, upstreamUpdatedAt: iso(run.updatedAt) };
      const semantic = JSON.stringify([run.status, conclusion]);
      if (semantic !== previous) {
        counts.changes += 1;
        await emit('githubRunObserved', lastObservation);
        previous = semantic;
      }
      if (run.status === 'completed') {
        completeness = Array.isArray(run.jobs) ? 'complete' : 'partial';
        counts.jobs = Array.isArray(run.jobs) ? run.jobs.length : null;
        for (const job of Array.isArray(run.jobs) ? run.jobs : []) {
          const jobId = positive(job?.databaseId) ? String(job.databaseId) : null;
          if (!jobId || !conclusions.includes(job?.conclusion) || job?.status !== 'completed')
            completeness = 'partial';
          if (passing.includes(job?.conclusion)) continue;
          const steps = Array.isArray(job?.steps)
            ? job.steps.filter((step) => step?.conclusion && !passing.includes(step.conclusion))
            : [];
          if (
            !Array.isArray(job?.steps) ||
            job.steps.some(
              (step) => !positive(step?.number) || !conclusions.includes(step?.conclusion),
            )
          )
            completeness = 'partial';
          for (const step of steps.length ? steps : [null]) {
            const failure = {
              jobId,
              stepNumber: positive(step?.number) ? step.number : null,
              conclusion: conclusions.includes(step?.conclusion ?? job?.conclusion)
                ? (step?.conclusion ?? job?.conclusion)
                : null,
            };
            if (step && (!positive(step.number) || !conclusions.includes(step.conclusion)))
              completeness = 'partial';
            counts.failures += 1;
            firstFailure ??= failure;
            await emit('githubJobFailed', failure, false);
          }
        }
        if (conclusion && !passing.includes(conclusion) && !firstFailure) {
          firstFailure = { jobId: null, stepNumber: null, conclusion };
          counts.failures += 1;
          await emit('githubRunFailed', firstFailure, false);
        }
        if (!conclusion) completeness = 'partial';
        return await finish(
          'completed',
          conclusion === 'success' && completeness === 'complete' && counts.failures === 0 ? 0 : 1,
        );
      }
      await wait(pollIntervalMs);
    }
  } catch {
    if (signal?.aborted) {
      try {
        return await finish('cancelled', 130);
      } catch {
        /* Preserve incomplete evidence below. */
      }
    }
    write({
      event: 'githubRunEvidenceFailed',
      observedAt: iso(now()),
      ...identity,
      reason: 'evidenceIncomplete',
    });
    return 1;
  } finally {
    await journal.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [repository, runId, attempt, candidate, evidenceDirectory] = process.argv.slice(2);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    process.exitCode = await watchGithubRun({
      repository,
      runId,
      attempt: Number(attempt),
      candidate,
      evidenceDirectory,
      signal: controller.signal,
    });
  } catch {
    process.stderr.write(
      'Usage: node watch-github-run.mjs OWNER/REPO RUN_ID ATTEMPT COMMIT_SHA NEW_EVIDENCE_DIRECTORY\n',
    );
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}
