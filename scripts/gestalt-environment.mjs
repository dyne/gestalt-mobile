/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Builds the same managed homes as the Gestalt launcher while preserving explicit overrides. */
export function gestaltEnvironment(environment = process.env, homeDirectory = homedir()) {
  const existingPath = (environment.PATH ?? '').split(delimiter).filter(Boolean);
  const userBins = [
    join(homeDirectory, '.local', 'bin'),
    join(homeDirectory, 'bin'),
    join(homeDirectory, '.kimi-code', 'bin'),
  ];
  return {
    ...environment,
    CODEX_HOME: environment.CODEX_HOME || join(homeDirectory, '.codex-gestalt'),
    GESTALT_HOME: environment.GESTALT_HOME || join(homeDirectory, '.gestalt'),
    PATH: [...new Set([...userBins, ...existingPath])].join(delimiter),
  };
}

/** Runs a repository command inside the managed Gestalt environment. */
export function runWithGestaltEnvironment([command, ...args], environment = gestaltEnvironment()) {
  if (!command) throw new Error('A command is required.');
  const child = spawn(command, args, { env: environment, stdio: 'inherit' });
  const forward = (signal) => child.kill(signal);
  process.once('SIGINT', forward);
  process.once('SIGTERM', forward);
  child.once('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    process.removeListener('SIGINT', forward);
    process.removeListener('SIGTERM', forward);
    process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1);
  });
  return child;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runWithGestaltEnvironment(process.argv.slice(2));
}
