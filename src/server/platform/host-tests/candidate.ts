/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { within } from './config.js';
import { promisify } from 'node:util';
const exec = promisify(execFile);

/** Git-visible inputs only; ignored dependencies and host toolchains are explicitly outside this digest. */
export async function candidate(repository: string): Promise<string> {
  const git = async (...args: string[]) =>
    (
      await exec('/usr/bin/git', args, {
        cwd: repository,
        timeout: 10_000,
        maxBuffer: 16 * 1024 * 1024,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_OPTIONAL_LOCKS: '0',
        },
        encoding: 'buffer',
      })
    ).stdout;
  const top = (await git('rev-parse', '--show-toplevel')).toString().trim();
  if ((await realpath(top)) !== repository) throw new Error('Suite repository must be a Git root');
  const hash = createHash('sha256');
  const add = (value: Buffer | string) => {
    const b = Buffer.from(value);
    hash.update(String(b.length) + ':');
    hash.update(b);
  };
  add('gestalt-host-test-candidate-v1');
  add(await git('rev-parse', 'HEAD'));
  add(await git('symbolic-ref', '-q', 'HEAD').catch(() => Buffer.from('detached')));
  // Reject submodules: their separate working trees are not represented by a gitlink alone.
  const index = await git('ls-files', '--stage', '-z');
  if (
    index
      .toString()
      .split('\0')
      .some((line) => line.startsWith('160000 '))
  )
    throw new Error('Submodule candidates are unsupported');
  add(index);
  const paths = (await git('ls-files', '--cached', '--others', '--exclude-standard', '-z'))
    .toString()
    .split('\0')
    .filter(Boolean);
  let bytes = 0;
  for (const path of [...new Set(paths)].sort()) {
    add(path);
    const file = join(repository, path);
    const parent = await realpath(dirname(file)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (parent !== null && !within(repository, parent))
      throw new Error('Candidate path escapes repository');
    const info = await lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!info) {
      add('deleted');
      continue;
    }
    add(String(info.mode));
    if (info.isSymbolicLink()) {
      const target = await realpath(file);
      if (!within(repository, target)) throw new Error('Candidate symlink escapes repository');
      add('symlink');
      add(await readlink(file));
      continue;
    }
    if (!info.isFile()) throw new Error('Unsupported candidate entry');
    bytes += info.size;
    if (bytes > 128 * 1024 * 1024) throw new Error('Candidate exceeds fingerprint budget');
    add(await readFile(file));
  }
  return hash.digest('hex');
}
