/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const execute = promisify(execFile);

/** Emits structural observations only; timestamps distinguish polling from upstream updates. */
export async function watchGithubRun({
  repository,
  runId,
  read = async () => {
    const { stdout } = await execute(
      'gh',
      ['run', 'view', runId, '--repo', repository, '--json', 'status,conclusion,updatedAt'],
      { timeout: 60_000 },
    );
    return JSON.parse(stdout);
  },
  wait = () => sleep(30_000),
  now = () => new Date().toISOString(),
  write = (record) => process.stdout.write(`${JSON.stringify(record)}\n`),
}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !/^\d+$/.test(runId))
    throw new Error('Expected repository owner/name and numeric run ID');
  for (;;) {
    let run;
    try {
      run = await read();
    } catch {
      write({ event: 'githubRunObservationFailed', observedAt: now(), runId });
      return 1;
    }
    if (
      !run ||
      !['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending'].includes(
        run.status,
      )
    ) {
      write({ event: 'githubRunObservationFailed', observedAt: now(), runId });
      return 1;
    }
    const conclusion = [
      'success',
      'failure',
      'cancelled',
      'timed_out',
      'action_required',
      'neutral',
      'skipped',
      'stale',
      'startup_failure',
    ].includes(run.conclusion)
      ? run.conclusion
      : null;
    write({
      event: 'githubRunObserved',
      observedAt: now(),
      runId,
      status: run.status,
      conclusion,
      upstreamUpdatedAt:
        typeof run.updatedAt === 'string' && Number.isFinite(Date.parse(run.updatedAt))
          ? new Date(run.updatedAt).toISOString()
          : null,
    });
    if (run.status === 'completed') return conclusion === 'success' ? 0 : 1;
    await wait();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [repository, runId] = process.argv.slice(2);
  try {
    process.exitCode = await watchGithubRun({ repository, runId });
  } catch {
    process.stderr.write('Usage: node watch-github-run.mjs OWNER/REPO RUN_ID\n');
    process.exitCode = 1;
  }
}
