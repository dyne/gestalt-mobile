/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readRolloutExecutionPolicy } from './rollout-execution-policy.js';

describe('rollout execution policy', () => {
  const directories: string[] = [];
  afterEach(async () =>
    Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true }))),
  );

  it('keeps the original policy for a Gestalt thread after a contaminated resume', async () => {
    const path = await rollout([
      { type: 'session_meta', payload: { originator: 'gestalt-mobile' } },
      context('danger-full-access', 'never'),
      { type: 'event_msg', payload: { message: 'ignored' } },
      context('workspace-write', 'never'),
    ]);

    await expect(readRolloutExecutionPolicy(path)).resolves.toEqual({
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
    });
  });

  it('uses the latest valid policy for a thread created by another client', async () => {
    const path = await rollout([
      { type: 'session_meta', payload: { originator: 'codex-cli' } },
      context('read-only', 'untrusted'),
      context('workspace-write', 'on-request'),
    ]);

    await expect(readRolloutExecutionPolicy(path)).resolves.toEqual({
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
    });
  });

  async function rollout(records: unknown[]): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'gestalt-rollout-policy-'));
    directories.push(directory);
    const path = join(directory, 'rollout.jsonl');
    await writeFile(path, records.map((record) => JSON.stringify(record)).join('\n'));
    return path;
  }
});

function context(sandbox: string, approvalPolicy: string) {
  return {
    type: 'turn_context',
    payload: { sandbox_policy: { type: sandbox }, approval_policy: approvalPolicy },
  };
}
