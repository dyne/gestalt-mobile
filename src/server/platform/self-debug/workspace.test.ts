/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { SelfDebugWorkspace, executorSettings } from './workspace.js';
import type { DebugContext } from '../../../shared/contracts/self-debug.js';
import { RelaySession } from '../../features/sessions/model/relay-session.js';

const exec = promisify(execFile);
const directories: string[] = [];
afterEach(async () =>
  Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
);
const context: DebugContext = {
  handoffTrace: 'handoff-1',
  control: 'control-1',
  mobileSession: 'source',
  codexThread: 'source-thread',
  versions: [],
  capturedAt: '2026-10-06T12:00:00.000Z',
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'self-debug-'));
  directories.push(directory);
  const root = join(directory, 'debug');
  await mkdir(root);
  for (const name of ['gestalt', 'gestalt-mobile', 'gestalt-agents']) {
    const path = join(root, name);
    await exec('git', ['init', path]);
    await exec('git', [
      '-C',
      path,
      'remote',
      'add',
      'origin',
      `https://github.com/dyne/${name}.git`,
    ]);
    await writeFile(join(path, 'existing-work'), 'preserve me');
  }
  const profile = join(directory, 'executor.toml');
  await writeFile(profile, 'model = "configured-model"\nmodel_reasoning_effort = "high"\n');
  const databasePath = join(directory, 'relay.sqlite');
  const db = new DatabaseSync(databasePath);
  db.exec(
    'CREATE TABLE session_events (session_id TEXT, sequence INTEGER, occurred_at TEXT, type TEXT, payload_json TEXT)',
  );
  db.prepare('INSERT INTO session_events VALUES (?,?,?,?,?)').run(
    'source',
    1,
    context.capturedAt,
    'autopilot.turn-failed',
    JSON.stringify({
      controlId: 'control-1',
      code: 'RPC_FAILED',
      prompt: 'secret prompt',
      environment: { KEY: 'secret' },
    }),
  );
  db.close();
  return { root, directory, workspace: new SelfDebugWorkspace(root, profile, databasePath) };
}

describe('Self DEBUG workspace', () => {
  it('uses configured executor execution settings without inheriting its child role instructions', () => {
    expect(
      executorSettings(
        'model = "custom-model"\nmodel_reasoning_effort = "high"\ndeveloper_instructions = "child only"',
      ),
    ).toEqual({ name: 'org-plan-executor', model: 'custom-model', reasoningEffort: 'high' });
    expect(() => executorSettings('developer_instructions = "missing model"')).toThrow(
      'DEBUG_EXECUTOR_CONFIGURATION_INVALID',
    );
  });

  it('preserves existing clones and saves a private, redacted JSON packet with source observations', async () => {
    const { root, workspace, directory } = await fixture();
    await workspace.prepare();
    const agent = await workspace.settings();
    const { debug } = await workspace.capture('debug-1', context, agent);
    const source = RelaySession.create({
      id: 'source',
      workspaceId: 'w',
      workspacePath: directory,
      provider: 'codex',
      profile: 'default',
      effectiveSkillSelection: { skills: [] },
      now: context.capturedAt,
    }).bindThread('source-thread', context.capturedAt).snapshot;
    await workspace.askSource('debug-1', source, debug, async (prompt) => {
      expect(prompt).toContain('redacted relay trace has already been captured');
      await mkdir(join(directory, '.gestalt', 'self-debug'), { recursive: true });
      await writeFile(
        join(directory, '.gestalt', 'self-debug', 'debug-1.json'),
        JSON.stringify({
          candidateBoundary: 'codex',
          reproducible: true,
          observedEventTypes: ['autopilot.turn-failed'],
          errorCodes: ['RPC_FAILED'],
        }),
      );
    });
    const packet = await workspace.readTrace(debug);
    expect(JSON.parse(packet)).toMatchObject({
      context,
      sourceAgent: { status: 'received', observations: { candidateBoundary: 'codex' } },
    });
    expect(packet).not.toContain('secret');
    expect((await stat(join(root, debug.tracePath))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(root, 'gestalt-mobile', 'existing-work'), 'utf8')).toBe(
      'preserve me',
    );
    await expect(workspace.capture('debug-1', context, agent)).rejects.toThrow();
  });

  it('rejects unrelated existing repositories and symlink trace paths', async () => {
    const { root, workspace, directory } = await fixture();
    await exec('git', [
      '-C',
      join(root, 'gestalt'),
      'remote',
      'set-url',
      'origin',
      'https://github.com/other/repo.git',
    ]);
    await expect(workspace.prepare()).rejects.toThrow('DEBUG_REPOSITORY_ORIGIN_INVALID');
    await mkdir(join(root, 'traces'));
    await symlink(join(directory, 'executor.toml'), join(root, 'traces', 'debug.json'));
    const debug = { context, tracePath: 'traces/debug.json', agent: await workspace.settings() };
    await expect(workspace.readTrace(debug)).rejects.toThrow('DEBUG_TRACE_INVALID');
    await expect(
      workspace.readTrace({ ...debug, tracePath: '../../executor.toml' }),
    ).rejects.toThrow('DEBUG_TRACE_INVALID');
  });
});
