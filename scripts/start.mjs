/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runWithGestaltEnvironment } from './gestalt-environment.mjs';

/** Adds non-conflicting, repository-local defaults without overriding explicit CLI options. */
export function localStartArgs(args) {
  return [
    'node',
    'dist/server/server/main.js',
    ...args,
    ...(args.includes('--port') ? [] : ['--port', '3001']),
    ...(args.includes('--data-dir') ? [] : ['--data-dir', '.gestalt/start-state']),
  ];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runWithGestaltEnvironment(localStartArgs(process.argv.slice(2)));
}
