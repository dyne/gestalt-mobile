/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FilesystemSessionScratch,
  mobileScratchOwnerId,
  scratchMarkerName,
} from './filesystem-session-scratch.js';

const execute = promisify(execFile);
const fixtures: string[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const base = join(process.cwd(), 'tmp', 'mobile-scratch-tests');
  await mkdir(base, { recursive: true, mode: 0o700 });
  await writeFile(join(base, '.gitignore'), '*\n', { flag: 'wx' }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    },
  );
  const root = await mkdtemp(join(base, 'gestalt-scratch-'));
  fixtures.push(root);
  const workspacePath = join(root, 'workspace with spaces');
  await mkdir(workspacePath);
  return { root, workspacePath, id: 'relay-session-1' };
}

describe('FilesystemSessionScratch', () => {
  it('allocates private workspace scratch and runs a generated executable from a nested repository cwd', async () => {
    const session = await fixture();
    const nested = join(session.workspacePath, 'nested repository');
    await mkdir(nested);
    const context = await new FilesystemSessionScratch().allocate(session);
    expect(context.directory).toBe(
      join(session.workspacePath, 'tmp', 'sessions', mobileScratchOwnerId(session.id)),
    );
    expect((await lstat(context.directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(context.directory, scratchMarkerName))).mode & 0o777).toBe(0o600);
    const executable = join(context.directory, 'generated-command');
    await writeFile(executable, '#!/bin/sh\nprintf "workspace-executable-ok"\n', { mode: 0o700 });
    const result = await execute(executable, [], {
      cwd: nested,
      env: { ...process.env, ...context.environment },
    });
    expect(result.stdout).toBe('workspace-executable-ok');
    expect(result.stderr).toBe('');
    expect(context.environment).toMatchObject({
      TMPDIR: context.directory,
      TMP: context.directory,
      TEMP: context.directory,
    });
    expect(JSON.parse(context.environment.GESTALT_SESSION_TMP_CONTEXT)).toEqual({
      schemaVersion: 1,
      workspacePath: session.workspacePath,
      ownerId: context.ownerId,
      directory: context.directory,
      markerPath: join(context.directory, scratchMarkerName),
    });
  });

  it('isolates two sessions and overlapping session IDs in two workspaces', async () => {
    const first = await fixture();
    const second = await fixture();
    const scratch = new FilesystemSessionScratch();
    const contexts = await Promise.all([
      scratch.allocate(first),
      scratch.allocate({ ...first, id: 'relay-session-2' }),
      scratch.allocate(second),
    ]);
    expect(new Set(contexts.map((context) => context.directory)).size).toBe(3);
    await writeFile(join(contexts[0].directory, 'private'), 'one');
    expect(await readdir(contexts[1].directory)).toEqual([scratchMarkerName]);
    expect(await readdir(contexts[2].directory)).toEqual([scratchMarkerName]);
  });

  it('reopens the same owner after restart without losing scratch or creation time', async () => {
    const session = await fixture();
    const first = await new FilesystemSessionScratch().allocate(session);
    const marker = await readFile(join(first.directory, scratchMarkerName), 'utf8');
    await writeFile(join(first.directory, 'retained'), 'keep');
    expect(await new FilesystemSessionScratch().allocate(session)).toEqual(first);
    expect(await readFile(join(first.directory, scratchMarkerName), 'utf8')).toBe(marker);
    expect(await readFile(join(first.directory, 'retained'), 'utf8')).toBe('keep');
  });

  it('serializes concurrent allocation and records explicit provider associations idempotently', async () => {
    const session = await fixture();
    const scratch = new FilesystemSessionScratch();
    const contexts = await Promise.all([scratch.allocate(session), scratch.allocate(session)]);
    expect(contexts[0]).toEqual(contexts[1]);
    await Promise.all([
      scratch.associateProviderThread(session, 'codex', 'provider-thread-1'),
      scratch.associateProviderThread(session, 'codex', 'provider-thread-1'),
    ]);
    await scratch.associateProviderThread(session, 'kimi', 'provider-thread-2');
    expect(
      JSON.parse(await readFile(join(contexts[0].directory, scratchMarkerName), 'utf8')),
    ).toMatchObject({
      sessionId: session.id,
      authority: { kind: 'mobile-roster', sessionId: session.id },
      providerThreads: [
        { provider: 'codex', threadId: 'provider-thread-1' },
        { provider: 'kimi', threadId: 'provider-thread-2' },
      ],
    });
    expect(await readdir(contexts[0].directory)).toEqual([scratchMarkerName]);
  });

  it.each(['../escape', 'a/b', '', '.', 'a\0b', 'a'.repeat(257)])(
    'rejects invalid identity %j before creating directories',
    async (id) => {
      const session = await fixture();
      await expect(new FilesystemSessionScratch().allocate({ ...session, id })).rejects.toThrow(
        'SESSION_SCRATCH_INVALID_ID',
      );
      expect(await readdir(session.workspacePath)).toEqual([]);
    },
  );

  it.each(['{', JSON.stringify({ schemaVersion: 99 }), 'null'])(
    'preserves corrupt or mismatched markers: %s',
    async (contents) => {
      const session = await fixture();
      const context = await new FilesystemSessionScratch().allocate(session);
      const path = join(context.directory, scratchMarkerName);
      await writeFile(path, contents);
      await expect(new FilesystemSessionScratch().allocate(session)).rejects.toThrow();
      expect(await readFile(path, 'utf8')).toBe(contents);
    },
  );

  it('rejects a valid marker copied from another workspace', async () => {
    const session = await fixture();
    const other = await fixture();
    const scratch = new FilesystemSessionScratch();
    const first = await scratch.allocate(session);
    const second = await scratch.allocate(other);
    await writeFile(
      join(second.directory, scratchMarkerName),
      await readFile(join(first.directory, scratchMarkerName)),
    );
    await expect(scratch.allocate(other)).rejects.toThrow('SESSION_SCRATCH_MARKER_MISMATCH');
  });

  it.each(['tmp', 'sessions', 'owner'])(
    'rejects symlinked %s without writing outside the workspace',
    async (target) => {
      const session = await fixture();
      const outside = join(session.root, 'outside');
      await mkdir(outside);
      let path = join(session.workspacePath, 'tmp');
      if (target !== 'tmp') {
        await mkdir(path, { mode: 0o700 });
        path = join(path, 'sessions');
        if (target === 'owner') {
          await mkdir(path, { mode: 0o700 });
          path = join(path, mobileScratchOwnerId(session.id));
        }
      }
      await symlink(outside, path);
      await expect(new FilesystemSessionScratch().allocate(session)).rejects.toThrow(
        'SESSION_SCRATCH_UNSAFE_PATH',
      );
      expect(await readdir(outside)).toEqual([]);
    },
  );

  it('rejects symlinked markers and unmarked owner collisions', async () => {
    const session = await fixture();
    const scratch = new FilesystemSessionScratch();
    const context = await scratch.allocate(session);
    const path = join(context.directory, scratchMarkerName);
    const outside = join(session.root, 'foreign-marker');
    await writeFile(outside, await readFile(path));
    await rm(path);
    await symlink(outside, path);
    await expect(scratch.allocate(session)).rejects.toThrow();
    await rm(path);
    await expect(scratch.allocate(session)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(context.directory)).toEqual([]);
  });

  it('surfaces permission failures without fallback or an owner directory', async () => {
    const session = await fixture();
    await chmod(session.workspacePath, 0o500);
    try {
      await expect(new FilesystemSessionScratch().allocate(session)).rejects.toMatchObject({
        code: 'EACCES',
      });
      expect(await readdir(session.workspacePath)).toEqual([]);
    } finally {
      await chmod(session.workspacePath, 0o700);
    }
  });

  it('preserves user tmp siblings and ignore rules while ignoring generated contents in Git', async () => {
    const session = await fixture();
    await execute('git', ['init', '--quiet', session.workspacePath]);
    await writeFile(join(session.workspacePath, '.gitignore'), 'user-rule\n');
    await mkdir(join(session.workspacePath, 'tmp'));
    await writeFile(join(session.workspacePath, 'tmp', 'user-file'), 'preserve');
    await new FilesystemSessionScratch().allocate(session);
    expect(await readFile(join(session.workspacePath, '.gitignore'), 'utf8')).toBe('user-rule\n');
    expect(await readFile(join(session.workspacePath, 'tmp', 'user-file'), 'utf8')).toBe(
      'preserve',
    );
    const result = await execute('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: session.workspacePath,
    });
    expect(result.stdout).toContain('tmp/user-file');
    expect(result.stdout).not.toContain('tmp/sessions');
  });
});
