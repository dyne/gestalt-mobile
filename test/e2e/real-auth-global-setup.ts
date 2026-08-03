/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, '../..');
const serverPath = join(root, 'test/e2e/real-auth-server.mjs');

export default async function setup(): Promise<() => Promise<void>> {
  await execute('npm', ['run', 'build'], { cwd: root });
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'gestalt-mobile-real-auth-'));
  const child = spawn(process.execPath, [serverPath], {
    cwd: root,
    env: {
      ...process.env,
      GESTALT_REAL_AUTH_HOME: join(temporaryRoot, 'home'),
      GESTALT_REAL_AUTH_DATA: join(temporaryRoot, 'data'),
      GESTALT_REAL_AUTH_STATIC: join(root, 'dist/client'),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  await new Promise<void>((resolveReady, reject) => {
    const timer = setTimeout(
      () => reject(new Error('real auth server did not become ready')),
      20_000,
    );
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('REAL_AUTH_READY')) {
        clearTimeout(timer);
        resolveReady();
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`real auth server exited (${code})`));
    });
  });
  return async () => {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  };
}
