/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { readFileSync } from 'node:fs';

import { repositorySourceFiles, validateSourceHeader } from './license-headers.mjs';

const failures = repositorySourceFiles().flatMap((path) =>
  validateSourceHeader(path, readFileSync(path, 'utf8')).map((error) => `${path}: ${error}`),
);

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
}
